// Управление доступом: только главный администратор. Приглашения, запросы доступа, /users (уровни, движки, модели), /active.
// Экраны администратора — на языке администратора; сообщения сотрудникам — на языке каждого сотрудника.
import { randomBytes } from 'node:crypto';
import { allowAllModels, allowedCount, allowedModels, getCatalog, grantedEngines, modelRestriction, setEngineGrant, toggleModel } from './access.mjs';
import { ADMIN_ID, LEVEL_KEYS, MAX_AGENTS, botInfo, db, isLevel, langOf, levelHint, levelName, log, say, who } from './ctx.mjs';
import { DEFAULT_ENGINE, ENGINES } from './engines.mjs';
import { t } from './i18n.mjs';
import { activeSessions, closeSession, saveEngine, statesOf, stopUser } from './state.mjs';
import { showPath } from './projects.mjs';
import { activeSessionsView, engineGrants, modelGrantsOverview, modelGrantsView, sessionStatus } from './ui.mjs';
import { tg } from './telegram.mjs';

const INVITE_TTL_MS = 24 * 3600_000;
const REQUEST_COOLDOWN_MS = 3600_000; // повторный запрос доступа от одного человека — не чаще раза в час
const NOTICE_COOLDOWN_MS = 10 * 60_000; // напоминание «запрос уже отправлен» — не чаще раза в 10 минут
const lastNotice = new Map();

/** Язык администратора: все его экраны и уведомления ему. */
const adminLang = () => langOf(ADMIN_ID);
const userName = (u) => (u.username ? `@${u.username}` : u.first_name || `id ${u.user_id}`);
const levelButtons = (prefix, current, lang) => [
  LEVEL_KEYS.map((key) => ({ text: `${key === current ? '✓ ' : ''}${levelName(key, lang)}`, callback_data: `${prefix}:${key}` })),
];

/** Приветствие-примечание для сотрудника: запросы журналируются. */
export const welcomeNote = (lang) => t('welcome.note', lang);

/** Текст о выданном доступе: при подключении по приглашению или по запросу. */
const grantedText = (level, lang, byAdmin) => t(byAdmin ? 'access.grantedByAdmin' : 'access.granted', lang, { level: levelName(level, lang), hint: levelHint(level, lang), note: welcomeNote(lang) });

// ---------- незнакомые пользователи ----------

/** Сообщение от человека без доступа: подключение по приглашению или запрос доступа администратору. */
export async function handleUnknownUser(from, chatId, text) {
  const lang = langOf(from.id);
  const m = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text || '');
  if (m) {
    const level = db.consumeInvite(m[1], from.id);
    if (!level) return say(chatId, t('access.inviteBad', lang));
    db.upsertUser({ user_id: from.id, username: from.username, first_name: from.first_name, level, added_by: ADMIN_ID });
    db.setRequestStatus(from.id, 'approved');
    log('подключён по приглашению', from.id, from.username, level);
    await say(chatId, grantedText(level, lang, false));
    return say(ADMIN_ID, t('adm.joinedByInvite', adminLang(), { who: who(from), level: levelName(level, adminLang()) }));
  }

  const req = db.getRequest(from.id);
  if (req?.status === 'rejected') return; // отклонённого молча игнорируем
  if (req?.status === 'pending' && Date.now() - Date.parse(req.requested_at) < REQUEST_COOLDOWN_MS) {
    if (Date.now() - (lastNotice.get(from.id) ?? 0) > NOTICE_COOLDOWN_MS) {
      lastNotice.set(from.id, Date.now());
      await say(chatId, t('access.pending', lang));
    }
    return;
  }

  db.saveRequest(from);
  const prev = db.getUser(from.id);
  const al = adminLang();
  await say(chatId, t('access.requestSent', lang));
  return say(ADMIN_ID, t('adm.reqNew', al, { who: who(from), id: from.id, note: prev?.status === 'revoked' ? t('adm.reqRevokedBefore', al) : '', msg: (text || '').slice(0, 200) }), {
    reply_markup: {
      inline_keyboard: [
        ...LEVEL_KEYS.map((key) => [{ text: t('adm.reqGrant', al, { level: levelName(key, al), hint: levelHint(key, al) }), callback_data: `adm:g:${from.id}:${key}` }]),
        [{ text: t('btn.reject', al), callback_data: `adm:d:${from.id}` }],
      ],
    },
  });
}

// ---------- команды администратора ----------

export async function adminCommand(chatId, command) {
  const al = adminLang();
  if (command === '/invite') {
    return say(chatId, t('adm.inviteAsk', al), {
      reply_markup: { inline_keyboard: LEVEL_KEYS.map((key) => [{ text: `${levelName(key, al)} — ${levelHint(key, al)}`, callback_data: `adm:i:${key}` }]) },
    });
  }
  if (command === '/active') return say(chatId, activeView().text, { reply_markup: activeView().markup });
  if (command === '/users') return say(chatId, usersView().text, { reply_markup: usersView().markup });
}

function usersView() {
  const al = adminLang();
  const users = db.listUsers();
  const active = users.filter((u) => u.status === 'active');
  const revoked = users.length - active.length;
  const text = active.length
    ? [t('adm.usersHeader', al, { n: active.length }), ...active.map((u) => `• ${userName(u)} — ${levelName(u.level, al)}`), ...(revoked ? ['', t('adm.usersRevoked', al, { n: revoked })] : [])].join('\n')
    : t('adm.usersEmpty', al);
  return { text, markup: { inline_keyboard: active.map((u) => [{ text: `${userName(u)} · ${levelName(u.level, al)}`, callback_data: `adm:u:${u.user_id}` }]) } };
}

/** Как назвать владельца сессии в списке активных. */
const ownerName = (id) => (id === ADMIN_ID ? t('active.owner', adminLang()) : db.getUser(id) ? userName(db.getUser(id)) : `id ${id}`);

/** Активные сессии: кто занимает слоты, с кнопками точечного завершения (для сотрудников). */
const activeView = () => activeSessionsView({ sessions: activeSessions(), adminId: ADMIN_ID, maxAgents: MAX_AGENTS, nameOf: ownerName, projectOf: (p) => showPath(p, adminLang()), lang: adminLang() });

/** Движки сотрудника для карточки: все движки реестра, отметка выданных. */
const engineList = (userId) => {
  const granted = grantedEngines(userId);
  return Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, granted: granted.includes(e.id), isDefault: e.id === DEFAULT_ENGINE }));
};

function userCard(u) {
  const al = adminLang();
  const s = activeSessions().find((x) => x.userId === u.user_id);
  const eg = engineGrants({ userId: u.user_id, engines: engineList(u.user_id), lang: al });
  return {
    text: t('adm.userLine', al, {
      name: userName(u),
      id: u.user_id,
      level: levelName(u.level, al),
      hint: isLevel(u.level) ? levelHint(u.level, al) : '',
      engines: eg.line,
      date: u.added_at.slice(0, 10),
      status: sessionStatus(s, (p) => showPath(p, al), Date.now(), al),
    }),
    markup: {
      inline_keyboard: [
        ...levelButtons(`adm:l:${u.user_id}`, u.level, al),
        ...eg.rows,
        ...(s ? [[{ text: t('adm.killUserBtn', al), callback_data: `adm:k:${u.user_id}` }]] : []),
        [{ text: t('adm.revokeBtn', al), callback_data: `adm:r:${u.user_id}` }],
        [{ text: t('adm.toList', al), callback_data: 'adm:list' }],
      ],
    },
  };
}

/** Все кнопки adm:* — только от главного администратора (проверяется в bot.mjs). */
export async function onAdminCallback(cb) {
  const [, action, a, b] = cb.data.split(':');
  const al = adminLang();
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const edit = (text, markup) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: markup ?? { inline_keyboard: [] } }).catch((e) => log('adm edit:', e.message));
  const id = Number(a);

  // ссылка-приглашение
  if (action === 'i') {
    if (!isLevel(a)) return ack();
    const code = randomBytes(9).toString('base64url');
    db.createInvite(code, a, ADMIN_ID, new Date(Date.now() + INVITE_TTL_MS).toISOString());
    await ack();
    return edit(t('adm.inviteMade', al, { level: levelName(a, al), bot: botInfo.username, code }));
  }

  // решение по запросу доступа от незнакомого пользователя
  if (action === 'g' || action === 'd') {
    const req = db.getRequest(id);
    if (!req) return (await ack(t('adm.ackNotFound', al)), edit(t('adm.reqNotFound', al)));
    if (req.status !== 'pending') return (await ack(), edit(t('adm.reqHandled', al, { status: req.status })));
    const name = userName({ user_id: id, username: req.username, first_name: req.first_name });
    if (action === 'd') {
      db.setRequestStatus(id, 'rejected');
      await ack();
      await say(id, t('access.rejectedByAdmin', langOf(id)));
      return edit(t('adm.reqRejected', al, { name }));
    }
    if (!isLevel(b)) return ack(t('adm.ackNoLevel', al));
    db.upsertUser({ user_id: id, username: req.username, first_name: req.first_name, level: b, added_by: ADMIN_ID });
    db.setRequestStatus(id, 'approved');
    log('доступ выдан по запросу', id, b);
    await ack();
    await say(id, grantedText(b, langOf(id), true));
    return edit(t('adm.reqGranted', al, { name, level: levelName(b, al) }));
  }

  // список и карточка сотрудника
  if (action === 'list') {
    await ack();
    const v = usersView();
    return edit(v.text, v.markup);
  }
  if (action === 'act') {
    await ack();
    const v = activeView();
    return edit(v.text, v.markup);
  }
  const user = db.getUser(id);
  if (!user || user.status !== 'active') {
    await ack(t('adm.ackNoUser', al));
    const v = usersView();
    return edit(v.text, v.markup);
  }
  if (action === 'u') {
    await ack();
    const c = userCard(user);
    return edit(c.text, c.markup);
  }
  if (action === 'k') {
    // все диалоги сотрудника (в режиме «диалоги» их может быть несколько)
    const closed = statesOf(id).map((s) => closeSession(s, 'admin_close')).some(Boolean);
    if (closed) {
      log('сессия завершена администратором', id);
      await say(id, t('adm.killedByAdmin', langOf(id)));
    }
    await ack(closed ? t('adm.ackKilled', al) : t('adm.ackNotActive', al));
    if (b === 'a') {
      const v = activeView();
      return edit(v.text, v.markup);
    }
    const c = userCard(user);
    return edit(c.text, c.markup);
  }
  // ---- права на движки и модели ----
  if (action === 'et') {
    if (!Object.hasOwn(ENGINES, b) || b === DEFAULT_ENGINE) return ack();
    const on = !grantedEngines(id).includes(b);
    setEngineGrant(id, b, on);
    const e = ENGINES[b];
    log(on ? 'движок выдан' : 'движок отозван', id, b);
    const ul = langOf(id);
    if (on) await say(id, t('access.engineGranted', ul, { engine: e.label }));
    else {
      // забрали движок, в котором сотрудник работает: закрываем сессию, дальше — движок по умолчанию
      for (const st of statesOf(id)) {
        if (st.agent && !st.agent.closed && st.agent.engine.id === b) stopUser(st, 'engine-revoked');
        if (st.engine === b) saveEngine(st, null);
      }
      await say(id, t('access.engineRevoked', ul, { engine: e.label, default: ENGINES[DEFAULT_ENGINE].label }));
    }
    await ack(on ? t('adm.ackEngineOn', al, { engine: e.label }) : t('adm.ackEngineOff', al, { engine: e.label }));
    const card = userCard(db.getUser(id));
    return edit(card.text, card.markup);
  }
  const overview = () =>
    modelGrantsOverview({
      userId: id,
      name: userName(user),
      lang: al,
      // разрешено — только модели, которые есть в каталоге (исчезнувшие после обновления агента не считаются)
      engines: grantedEngines(id).map((eid) => ({ id: eid, label: ENGINES[eid].label, total: getCatalog(eid)?.models.length ?? 0, allowed: allowedCount(id, eid) })),
    });
  const engineModels = (eid) =>
    modelGrantsView({
      userId: id,
      name: userName(user),
      lang: al,
      engine: ENGINES[eid],
      models: getCatalog(eid)?.models ?? [],
      allowed: modelRestriction(id, eid) ? allowedModels(id, eid).map((m) => m.id) : null,
    });
  if (action === 'mm') {
    await ack();
    const v = overview();
    return edit(v.text, v.markup);
  }
  if (action === 'me' || action === 'mt' || action === 'ma') {
    if (!grantedEngines(id).includes(b)) return ack(t('adm.ackNoEngine', al));
    const models = getCatalog(b)?.models ?? [];
    if (!models.length) return ack(t('adm.ackNoCatalog', al));
    if (action === 'mt') {
      // id модели (или #номер для длинных id); модели нет в текущем каталоге — список изменился, показываем заново
      const key = cb.data.split(':').slice(4).join(':');
      const m = key.startsWith('#') ? models[Number(key.slice(1))] : models.find((x) => x.id === key);
      if (!m) {
        await ack(t('adm.ackListChanged', al));
        const v = engineModels(b);
        return edit(v.text, v.markup);
      }
      const r = toggleModel(id, b, m.id);
      if (!r.ok) return ack(t('adm.ackKeepOne', al));
      log('модели сотрудника изменены', id, b, r.restriction ? r.restriction.join(',') : 'все');
      await ack();
    } else if (action === 'ma') {
      allowAllModels(id, b);
      log('модели сотрудника: разрешены все', id, b);
      await ack(t('adm.ackModelsAll', al));
    } else await ack();
    // выбор сотрудника, ставший недоступным, сам заменится разрешённой моделью перед следующим запросом
    const v = engineModels(b);
    return edit(v.text, v.markup);
  }
  if (action === 'l') {
    if (!isLevel(b) || b === user.level) return ack();
    db.setUserLevel(id, b);
    for (const st of statesOf(id)) stopUser(st, 'level'); // режим агента задаётся при создании сессии — перезапускаем
    log('уровень изменён', id, b);
    await ack(t('adm.ackLevelChanged', al));
    await say(id, t('access.levelChanged', langOf(id), { level: levelName(b, langOf(id)), hint: levelHint(b, langOf(id)) }));
    const c = userCard({ ...user, level: b });
    return edit(c.text, c.markup);
  }
  if (action === 'r') {
    await ack();
    return edit(t('adm.revokeAsk', al, { name: userName(user) }), {
      inline_keyboard: [[{ text: t('adm.revokeYes', al), callback_data: `adm:ro:${id}` }, { text: t('btn.cancel', al), callback_data: `adm:u:${id}` }]],
    });
  }
  if (action === 'ro') {
    db.revokeUser(id);
    for (const st of statesOf(id)) stopUser(st, 'revoked');
    log('доступ отозван', id);
    await ack(t('adm.ackRevoked', al));
    await say(id, t('access.revoked', langOf(id)));
    const v = usersView();
    return edit(t('adm.revokedMsg', al, { name: userName(user), list: v.text }), v.markup);
  }
}

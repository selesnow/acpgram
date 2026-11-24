// Управление доступом: только главный администратор. Приглашения, запросы доступа, /users (уровни, движки, модели), /active.
// Экраны администратора — на языке администратора; сообщения сотрудникам — на языке каждого сотрудника.
import { randomBytes } from 'node:crypto';
import { allowAllModels, allowedCount, allowedModels, getCatalog, grantedEngines, modelRestriction, setEngineGrant, toggleModel } from './access.mjs';
import { ADMIN_ID, LEVEL_KEYS, MAX_AGENTS, botInfo, db, isLevel, langOf, levelHint, levelName, log, say, who } from './ctx.mjs';
import { DEFAULT_ENGINE, ENGINES } from './engines.mjs';
import { t } from './i18n.mjs';
import { activeSessions, closeSession, saveEngine, statesOf, stopUser } from './state.mjs';
import { USER_WORKSPACES, showPath, userRoot } from './projects.mjs';
import { activeSessionsView, engineGrants, modelGrantsOverview, modelGrantsView, sessionStatus, usageView } from './ui.mjs';
import { cbCtx } from './uiActions.mjs';

const INVITE_TTL_MS = 24 * 3600_000;
const REQUEST_COOLDOWN_MS = 3600_000; // повторный запрос доступа от одного человека — не чаще раза в час
const NOTICE_COOLDOWN_MS = 10 * 60_000; // напоминание «запрос уже отправлен» — не чаще раза в 10 минут
const STRANGER_REPLY_COOLDOWN_MS = 5 * 60_000; // незнакомцу — не больше одного ответа за любое число попыток, кроме входа по валидной ссылке
const lastNotice = new Map();
const lastStrangerReply = new Map();

/** Чистит кэши времени ответов и уведомлений, чтобы они не росли вместе с числом обращений. */
export function sweepUnknownUsers(maxAgeMs = 24 * 3600_000) {
  const until = Date.now() - maxAgeMs;
  let n = 0;
  for (const map of [lastNotice, lastStrangerReply]) {
    for (const [id, at] of map) {
      if (at > until) continue;
      map.delete(id);
      n++;
    }
  }
  return n;
}

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
  const now = Date.now();
  const cooling = now - (lastStrangerReply.get(from.id) ?? 0) < STRANGER_REPLY_COOLDOWN_MS;
  const lang = langOf(from.id);
  const m = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text || '');
  if (m) {
    const level = db.consumeInvite(m[1], from.id);
    if (!level) {
      if (cooling) return;
      lastStrangerReply.set(from.id, now);
      return say(chatId, t('access.inviteBad', lang));
    }
    lastStrangerReply.set(from.id, now);
    if (!db.upsertUser({ user_id: from.id, username: from.username, first_name: from.first_name, level, added_by: ADMIN_ID })) {
      log('доступ по приглашению не сохранён (ошибка базы)', from.id);
      return say(chatId, t('access.saveFail', lang));
    }
    db.setRequestStatus(from.id, 'approved');
    log('подключён по приглашению', from.id, from.username, level);
    await say(chatId, grantedText(level, lang, false));
    return say(ADMIN_ID, t('adm.joinedByInvite', adminLang(), { who: who(from), level: levelName(level, adminLang()) }));
  }
  if (cooling) return;
  lastStrangerReply.set(from.id, now);

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
  if (command === '/active' || command === '/users' || command === '/usage') {
    const v = command === '/active' ? activeView() : command === '/usage' ? usageScreen(1) : usersView();
    return say(chatId, v.text, { reply_markup: v.markup });
  }
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

/** Расход по пользователям за days суток (экран /usage, кнопки периода adm:us:<дни>). */
const usageScreen = (days, now = Date.now()) =>
  usageView({ rows: db.usageSummary(new Date(now - days * 24 * 3600_000).toISOString()), days, nameOf: ownerName, lang: adminLang() });

/** Движки сотрудника для карточки: все движки реестра, отметка выданных. */
const engineList = (userId) => {
  const granted = grantedEngines(userId);
  return Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, granted: granted.includes(e.id), isDefault: e.id === DEFAULT_ENGINE }));
};

function userCard(u) {
  const al = adminLang();
  const s = activeSessions().find((x) => x.userId === u.user_id);
  const eg = engineGrants({ userId: u.user_id, engines: engineList(u.user_id), lang: al });
  // личные пространства: папка сотрудника в корне проектов (имя — его Telegram ID), путь — как видит администратор
  const folder = USER_WORKSPACES ? `\n${t('adm.userFolder', al, { p: showPath(userRoot(u.user_id), al) })}` : '';
  return {
    text:
      t('adm.userLine', al, {
        name: userName(u),
        id: u.user_id,
        level: levelName(u.level, al),
        hint: isLevel(u.level) ? levelHint(u.level, al) : '',
        engines: eg.line,
        date: u.added_at.slice(0, 10),
        status: sessionStatus(s, (p) => showPath(p, al), Date.now(), al),
      }) + folder,
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

/** Открытая администратором группа и страница моделей сотрудника в движке (`${userId}:${движок}` → {group, page}). */
const grantsPage = new Map();

/** Все кнопки adm:* — только от главного администратора (проверяется в bot.mjs). */
export async function onAdminCallback(cb) {
  const [, action, a, b] = cb.data.split(':');
  const al = adminLang();
  const { ack, edit } = cbCtx({ chatId: cb.message?.chat?.id }, cb, { notModified: true, label: 'adm edit:' });
  const ctx = { action, al, ack, edit, id: Number(a), a, b, cb };
  if (!NO_USER_ACTIONS.has(action) && !(await requireUser(ctx))) return undefined;
  const handler = ADMIN_ACTIONS.get(action) ?? noopAction;
  return handler(ctx);
}

const noopAction = async () => undefined;
const NO_USER_ACTIONS = new Set(['i', 'g', 'd', 'list', 'act', 'us']);

async function requireUser(ctx) {
  ctx.user = db.getUser(ctx.id);
  if (ctx.user?.status === 'active') return true;
  await ctx.ack(t('adm.ackNoUser', ctx.al));
  await ctx.edit(usersView());
  return false;
}

async function inviteAction({ al, a, ack, edit }) {
  if (!isLevel(a)) return ack();
  const code = randomBytes(9).toString('base64url');
  db.createInvite(code, a, ADMIN_ID, new Date(Date.now() + INVITE_TTL_MS).toISOString());
  log('приглашение создано: уровень', a, '| администратор', ADMIN_ID);
  await ack();
  return edit(t('adm.inviteMade', al, { level: levelName(a, al), bot: botInfo.username, code }));
}

async function requestAction({ action, al, id, b, ack, edit }) {
  const req = db.getRequest(id);
  if (!req) return (await ack(t('adm.ackNotFound', al)), edit(t('adm.reqNotFound', al)));
  if (req.status !== 'pending') return (await ack(), edit(t('adm.reqHandled', al, { status: req.status })));
  const name = userName({ user_id: id, username: req.username, first_name: req.first_name });
  if (action === 'd') {
    db.setRequestStatus(id, 'rejected');
    log('доступ отклонён:', id, '| администратор', ADMIN_ID);
    await ack();
    await say(id, t('access.rejectedByAdmin', langOf(id)));
    return edit(t('adm.reqRejected', al, { name }));
  }
  if (!isLevel(b)) return ack(t('adm.ackNoLevel', al));
  if (!db.upsertUser({ user_id: id, username: req.username, first_name: req.first_name, level: b, added_by: ADMIN_ID })) {
    log('доступ по запросу не сохранён (ошибка базы)', id);
    return ack(t('access.saveFail', al));
  }
  db.setRequestStatus(id, 'approved');
  log('доступ выдан по запросу', id, b);
  await ack();
  await say(id, grantedText(b, langOf(id), true));
  return edit(t('adm.reqGranted', al, { name, level: levelName(b, al) }));
}

async function screenAction({ action, id, ack, edit }) {
  await ack();
  const v = action === 'list' ? usersView() : action === 'act' ? activeView() : usageScreen([1, 7, 30].includes(id) ? id : 1);
  return edit(v);
}

async function userAction({ ack, edit, user }) {
  await ack();
  return edit(userCard(user));
}

async function killAction({ al, id, b, ack, edit, user }) {
  // все диалоги сотрудника (в режиме «диалоги» их может быть несколько)
  const closed = statesOf(id).map((s) => closeSession(s, 'admin_close')).some(Boolean);
  if (closed) {
    log('сессия завершена администратором', id);
    await say(id, t('adm.killedByAdmin', langOf(id)));
  }
  await ack(closed ? t('adm.ackKilled', al) : t('adm.ackNotActive', al));
  return edit(b === 'a' ? activeView() : userCard(user));
}

async function engineAction({ al, id, b, ack, edit }) {
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
  return edit(userCard(db.getUser(id)));
}

const modelsOverview = ({ id, user, al }) =>
  modelGrantsOverview({
    userId: id,
    name: userName(user),
    lang: al,
    // разрешено — только модели, которые есть в каталоге (исчезнувшие после обновления агента не считаются)
    engines: grantedEngines(id).map((eid) => ({ id: eid, label: ENGINES[eid].label, total: getCatalog(eid)?.models.length ?? 0, allowed: allowedCount(id, eid) })),
  });

const engineModels = ({ id, user, al }, eid) =>
  modelGrantsView({
    userId: id,
    name: userName(user),
    lang: al,
    engine: ENGINES[eid],
    models: getCatalog(eid)?.models ?? [],
    allowed: modelRestriction(id, eid) ? allowedModels(id, eid).map((m) => m.id) : null,
    // открытая группа моделей (OpenCode): после переключения модели остаёмся на той же странице
    ...(grantsPage.get(`${id}:${eid}`) ?? {}),
  });

async function modelsOverviewAction(ctx) {
  await ctx.ack();
  return ctx.edit(modelsOverview(ctx));
}

async function modelAction({ action, al, id, b, cb, user, ack, edit }) {
  if (!grantedEngines(id).includes(b)) return ack(t('adm.ackNoEngine', al));
  const models = getCatalog(b)?.models ?? [];
  if (!models.length) return ack(t('adm.ackNoCatalog', al));
  const ctx = { id, al, user, cb };
  if (action === 'me') grantsPage.delete(`${id}:${b}`); // к списку групп
  // группа (adm:mg:<id>:<движок>:<группа>:<стр>) или вендор в ней (adm:ms:<id>:<движок>:<группа>:<вендор>:<стр>)
  if (action === 'mg' || action === 'ms') {
    const parts = cb.data.split(':');
    const [group, sub, page] = action === 'mg' ? [parts[4], null, parts[5]] : [parts[4], parts[5], parts[6]];
    grantsPage.set(`${id}:${b}`, { group, sub, page: Number(page) || 0 });
    await ack();
    return edit(engineModels(ctx, b));
  }
  if (action === 'mt') {
    // id модели (или #номер для длинных id); модели нет в текущем каталоге — список изменился, показываем заново
    const key = cb.data.split(':').slice(4).join(':');
    const m = key.startsWith('#') ? models[Number(key.slice(1))] : models.find((x) => x.id === key);
    if (!m) {
      await ack(t('adm.ackListChanged', al));
      return edit(engineModels(ctx, b));
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
  return edit(engineModels(ctx, b));
}

async function levelAction({ al, id, b, ack, edit, user }) {
  if (!isLevel(b) || b === user.level) return ack();
  if (db.setUserLevel(id, b)?.changes !== 1) {
    log('⚠️ уровень не изменён (ошибка базы)', id, b);
    return ack(t('access.saveFail', al));
  }
  for (const st of statesOf(id)) stopUser(st, 'level'); // режим агента задаётся при создании сессии — перезапускаем
  log('уровень изменён', id, b);
  await ack(t('adm.ackLevelChanged', al));
  await say(id, t('access.levelChanged', langOf(id), { level: levelName(b, langOf(id)), hint: levelHint(b, langOf(id)) }));
  return edit(userCard({ ...user, level: b }));
}

async function revokeAskAction({ al, id, ack, edit, user }) {
  await ack();
  return edit({
    text: t('adm.revokeAsk', al, { name: userName(user) }),
    markup: { inline_keyboard: [[{ text: t('adm.revokeYes', al), callback_data: `adm:ro:${id}` }, { text: t('btn.cancel', al), callback_data: `adm:u:${id}` }]] },
  });
}

async function revokeAction({ al, id, ack, edit, user }) {
  // запись не прошла (ошибка базы) — доступ остался: «отозван» сообщать нельзя
  if (db.revokeUser(id)?.changes !== 1) {
    log('⚠️ доступ не отозван (ошибка базы)', id);
    return ack(t('access.saveFail', al));
  }
  for (const st of statesOf(id)) stopUser(st, 'revoked');
  log('доступ отозван', id);
  await ack(t('adm.ackRevoked', al));
  await say(id, t('access.revoked', langOf(id)));
  const v = usersView();
  return edit({ text: t('adm.revokedMsg', al, { name: userName(user), list: v.text }), markup: v.markup });
}

const ADMIN_ACTIONS = new Map([
  ['i', inviteAction],
  ['g', requestAction],
  ['d', requestAction],
  ['list', screenAction],
  ['act', screenAction],
  ['us', screenAction],
  ['u', userAction],
  ['k', killAction],
  ['et', engineAction],
  ['mm', modelsOverviewAction],
  ['me', modelAction],
  ['mt', modelAction],
  ['ma', modelAction],
  ['mg', modelAction],
  ['ms', modelAction],
  ['l', levelAction],
  ['r', revokeAskAction],
  ['ro', revokeAction],
]);

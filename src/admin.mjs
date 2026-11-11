// Управление доступом: только главный администратор. Приглашения, запросы доступа, /users (уровни, движки, модели), /active.
import { randomBytes } from 'node:crypto';
import { allowAllModels, allowedCount, allowedModels, getCatalog, grantedEngines, modelRestriction, setEngineGrant, toggleModel } from './access.mjs';
import { ADMIN_ID, LEVELS, MAX_AGENTS, botInfo, db, log, say, who } from './ctx.mjs';
import { DEFAULT_ENGINE, ENGINES } from './engines.mjs';
import { activeSessions, closeSession, findState, saveEngine, stopUser } from './state.mjs';
import { display } from './projects.mjs';
import { activeSessionsView, engineGrants, modelGrantsOverview, modelGrantsView, sessionStatus } from './ui.mjs';
import { tg } from './telegram.mjs';

const INVITE_TTL_MS = 24 * 3600_000;
const REQUEST_COOLDOWN_MS = 3600_000; // повторный запрос доступа от одного человека — не чаще раза в час
const NOTICE_COOLDOWN_MS = 10 * 60_000; // напоминание «запрос уже отправлен» — не чаще раза в 10 минут
const lastNotice = new Map();

const levelLabel = (l) => LEVELS[l]?.label ?? l;
const userName = (u) => (u.username ? `@${u.username}` : u.first_name || `id ${u.user_id}`);
const levelButtons = (prefix, current) => [
  Object.entries(LEVELS).map(([key, v]) => ({ text: `${key === current ? '✓ ' : ''}${v.label}`, callback_data: `${prefix}:${key}` })),
];

export const WELCOME_NOTE = 'ℹ️ Запросы к боту журналируются администратором.';

// ---------- незнакомые пользователи ----------

/** Сообщение от человека без доступа: подключение по приглашению или запрос доступа администратору. */
export async function handleUnknownUser(from, chatId, text) {
  const m = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text || '');
  if (m) {
    const level = db.consumeInvite(m[1], from.id);
    if (!level) return say(chatId, 'Приглашение недействительно, просрочено или уже использовано. Попросите администратора создать новое.');
    db.upsertUser({ user_id: from.id, username: from.username, first_name: from.first_name, level, added_by: ADMIN_ID });
    db.setRequestStatus(from.id, 'approved');
    log('подключён по приглашению', from.id, from.username, level);
    await say(chatId, `✅ Доступ открыт. Уровень: ${levelLabel(level)} — ${LEVELS[level].hint}.\n\nПишите запрос, я передам его AI-агенту на сервере (движок можно выбрать: /engine). Нажмите /start, чтобы увидеть команды.\n\n${WELCOME_NOTE}`);
    return say(ADMIN_ID, `✅ ${who(from)} подключился по приглашению. Уровень: ${levelLabel(level)}.`);
  }

  const req = db.getRequest(from.id);
  if (req?.status === 'rejected') return; // отклонённого молча игнорируем
  if (req?.status === 'pending' && Date.now() - Date.parse(req.requested_at) < REQUEST_COOLDOWN_MS) {
    if (Date.now() - (lastNotice.get(from.id) ?? 0) > NOTICE_COOLDOWN_MS) {
      lastNotice.set(from.id, Date.now());
      await say(chatId, 'Запрос уже отправлен администратору, ожидайте решения.');
    }
    return;
  }

  db.saveRequest(from);
  const prev = db.getUser(from.id);
  const note = prev?.status === 'revoked' ? '\n(доступ ранее был отозван)' : '';
  await say(chatId, '🔒 У вас нет доступа к этому боту. Запрос отправлен администратору.');
  return say(ADMIN_ID, `🔔 Запрос доступа к боту\n${who(from)}, id ${from.id}${note}\nСообщение: ${(text || '').slice(0, 200)}\n\nВыберите уровень доступа:`, {
    reply_markup: {
      inline_keyboard: [
        ...Object.entries(LEVELS).map(([key, v]) => [{ text: `✅ ${v.label} — ${v.hint}`, callback_data: `adm:g:${from.id}:${key}` }]),
        [{ text: '⛔ Отклонить', callback_data: `adm:d:${from.id}` }],
      ],
    },
  });
}

// ---------- команды администратора ----------

export async function adminCommand(chatId, command) {
  if (command === '/invite') {
    return say(chatId, 'Выберите уровень доступа для приглашения. Ссылка одноразовая и действует 24 часа.', {
      reply_markup: { inline_keyboard: Object.entries(LEVELS).map(([key, v]) => [{ text: `${v.label} — ${v.hint}`, callback_data: `adm:i:${key}` }]) },
    });
  }
  if (command === '/active') return say(chatId, activeView().text, { reply_markup: activeView().markup });
  if (command === '/users') return say(chatId, usersView().text, { reply_markup: usersView().markup });
}

function usersView() {
  const users = db.listUsers();
  const active = users.filter((u) => u.status === 'active');
  const revoked = users.length - active.length;
  const text = active.length
    ? `Сотрудники с доступом (${active.length}):\n` + active.map((u) => `• ${userName(u)} — ${levelLabel(u.level)}`).join('\n') + (revoked ? `\n\nДоступ отозван у: ${revoked}` : '')
    : 'Сотрудников с доступом пока нет. /invite — создать приглашение.';
  return { text, markup: { inline_keyboard: active.map((u) => [{ text: `${userName(u)} · ${levelLabel(u.level)}`, callback_data: `adm:u:${u.user_id}` }]) } };
}

/** Как назвать владельца сессии в списке активных. */
const ownerName = (id) => (id === ADMIN_ID ? 'Администратор (вы)' : db.getUser(id) ? userName(db.getUser(id)) : `id ${id}`);

/** Активные сессии: кто занимает слоты, с кнопками точечного завершения (для сотрудников). */
const activeView = () => activeSessionsView({ sessions: activeSessions(), adminId: ADMIN_ID, maxAgents: MAX_AGENTS, nameOf: ownerName, projectOf: display });

/** Движки сотрудника для карточки: все движки реестра, отметка выданных. */
const engineList = (userId) => {
  const granted = grantedEngines(userId);
  return Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, granted: granted.includes(e.id), isDefault: e.id === DEFAULT_ENGINE }));
};

function userCard(u) {
  const s = activeSessions().find((x) => x.userId === u.user_id);
  const eg = engineGrants({ userId: u.user_id, engines: engineList(u.user_id) });
  return {
    text: `${userName(u)} (id ${u.user_id})\nУровень: ${levelLabel(u.level)} — ${LEVELS[u.level]?.hint ?? ''}\n${eg.line}\nДобавлен: ${u.added_at.slice(0, 10)}\nСтатус: ${sessionStatus(s, display)}`,
    markup: {
      inline_keyboard: [
        ...levelButtons(`adm:l:${u.user_id}`, u.level),
        ...eg.rows,
        ...(s ? [[{ text: '🛑 Завершить сессию сотрудника', callback_data: `adm:k:${u.user_id}` }]] : []),
        [{ text: '🚫 Отозвать доступ', callback_data: `adm:r:${u.user_id}` }],
        [{ text: '← К списку', callback_data: 'adm:list' }],
      ],
    },
  };
}

/** Все кнопки adm:* — только от главного администратора (проверяется в bot.mjs). */
export async function onAdminCallback(cb) {
  const [, action, a, b, c] = cb.data.split(':');
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const edit = (text, markup) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: markup ?? { inline_keyboard: [] } }).catch((e) => log('adm edit:', e.message));
  const id = Number(a);

  // ссылка-приглашение
  if (action === 'i') {
    if (!LEVELS[a]) return ack();
    const code = randomBytes(9).toString('base64url');
    db.createInvite(code, a, ADMIN_ID, new Date(Date.now() + INVITE_TTL_MS).toISOString());
    await ack();
    return edit(`🔗 Приглашение (уровень: ${levelLabel(a)})\n\nhttps://t.me/${botInfo.username}?start=${code}\n\nОдноразовая ссылка, действует 24 часа. Перешлите её сотруднику.`);
  }

  // решение по запросу доступа от незнакомого пользователя
  if (action === 'g' || action === 'd') {
    const req = db.getRequest(id);
    if (!req) return (await ack('Запрос не найден'), edit('Запрос не найден или уже обработан.'));
    if (req.status !== 'pending') return (await ack(), edit(`Запрос уже обработан (${req.status}).`));
    if (action === 'd') {
      db.setRequestStatus(id, 'rejected');
      await ack();
      await say(id, '⛔ Администратор отклонил запрос доступа.');
      return edit(`⛔ Запрос отклонён: ${userName({ user_id: id, username: req.username, first_name: req.first_name })}`);
    }
    if (!LEVELS[b]) return ack();
    db.upsertUser({ user_id: id, username: req.username, first_name: req.first_name, level: b, added_by: ADMIN_ID });
    db.setRequestStatus(id, 'approved');
    log('доступ выдан по запросу', id, b);
    await ack();
    await say(id, `✅ Вам выдан доступ. Уровень: ${levelLabel(b)} — ${LEVELS[b].hint}.\n\nПишите запрос, я передам его AI-агенту на сервере (движок можно выбрать: /engine). Нажмите /start, чтобы увидеть команды.\n\n${WELCOME_NOTE}`);
    return edit(`✅ Доступ выдан: ${userName({ user_id: id, username: req.username, first_name: req.first_name })} — ${levelLabel(b)}`);
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
    await ack('Сотрудник не найден или доступ уже отозван');
    const v = usersView();
    return edit(v.text, v.markup);
  }
  if (action === 'u') {
    await ack();
    const c = userCard(user);
    return edit(c.text, c.markup);
  }
  if (action === 'k') {
    const st = findState(id);
    const closed = st ? closeSession(st, 'admin_close') : false;
    if (closed) {
      log('сессия завершена администратором', id);
      await say(id, 'ℹ️ Администратор завершил вашу текущую сессию на сервере. Следующий запрос начнёт новую.');
    }
    await ack(closed ? 'Сессия завершена, слот освобождён' : 'Сессия уже не активна');
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
    if (on) await say(id, `✅ Администратор открыл вам движок ${e.label}. Выбрать: /engine`);
    else {
      // забрали движок, в котором сотрудник работает: закрываем сессию, дальше — движок по умолчанию
      const st = findState(id);
      if (st?.agent && !st.agent.closed && st.agent.engine.id === b) stopUser(st, 'engine-revoked');
      if (st?.engine === b) saveEngine(st, null);
      await say(id, `ℹ️ Администратор закрыл вам движок ${e.label}. Дальше вы работаете в ${ENGINES[DEFAULT_ENGINE].label}.`);
    }
    await ack(on ? `${e.label}: выдан` : `${e.label}: отозван`);
    const card = userCard(db.getUser(id));
    return edit(card.text, card.markup);
  }
  const overview = () =>
    modelGrantsOverview({
      userId: id,
      name: userName(user),
      // разрешено — только модели, которые есть в каталоге (исчезнувшие после обновления агента не считаются)
      engines: grantedEngines(id).map((eid) => ({ id: eid, label: ENGINES[eid].label, total: getCatalog(eid)?.models.length ?? 0, allowed: allowedCount(id, eid) })),
    });
  const engineModels = (eid) =>
    modelGrantsView({
      userId: id,
      name: userName(user),
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
    if (!grantedEngines(id).includes(b)) return ack('Движок сотруднику не выдан');
    const models = getCatalog(b)?.models ?? [];
    if (!models.length) return ack('Список моделей движка ещё не получен');
    if (action === 'mt') {
      // id модели (или #номер для длинных id); модели нет в текущем каталоге — список изменился, показываем заново
      const key = cb.data.split(':').slice(4).join(':');
      const m = key.startsWith('#') ? models[Number(key.slice(1))] : models.find((x) => x.id === key);
      if (!m) {
        await ack('Список моделей изменился — проверьте ещё раз');
        const v = engineModels(b);
        return edit(v.text, v.markup);
      }
      const r = toggleModel(id, b, m.id);
      if (!r.ok) return ack('Должна остаться хотя бы одна модель');
      log('модели сотрудника изменены', id, b, r.restriction ? r.restriction.join(',') : 'все');
      await ack();
    } else if (action === 'ma') {
      allowAllModels(id, b);
      log('модели сотрудника: разрешены все', id, b);
      await ack('Разрешены все модели');
    } else await ack();
    // выбор сотрудника, ставший недоступным, сам заменится разрешённой моделью перед следующим запросом
    const v = engineModels(b);
    return edit(v.text, v.markup);
  }
  if (action === 'l') {
    if (!LEVELS[b] || b === user.level) return ack();
    db.setUserLevel(id, b);
    const st = findState(id);
    if (st) stopUser(st, 'level'); // режим агента задаётся при создании сессии — перезапускаем
    log('уровень изменён', id, b);
    await ack('Уровень изменён');
    await say(id, `ℹ️ Администратор изменил ваш уровень доступа: ${levelLabel(b)} — ${LEVELS[b].hint}. Новая сессия начнётся со следующего запроса.`);
    const c = userCard({ ...user, level: b });
    return edit(c.text, c.markup);
  }
  if (action === 'r') {
    await ack();
    return edit(`Отозвать доступ у ${userName(user)}?\nТекущий запрос будет остановлен, сессия закрыта.`, {
      inline_keyboard: [[{ text: '🚫 Да, отозвать', callback_data: `adm:ro:${id}` }, { text: 'Отмена', callback_data: `adm:u:${id}` }]],
    });
  }
  if (action === 'ro') {
    db.revokeUser(id);
    const st = findState(id);
    if (st) stopUser(st, 'revoked');
    log('доступ отозван', id);
    await ack('Доступ отозван');
    await say(id, '⛔ Администратор отозвал ваш доступ к боту.');
    const v = usersView();
    return edit(`🚫 Доступ отозван: ${userName(user)}\n\n${v.text}`, v.markup);
  }
}

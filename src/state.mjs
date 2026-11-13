// Состояние по пользователям: у каждого свой процесс агента, движок, проект, флаг «занят» и разрешения.
import { ADMIN_ID, IDLE_MINUTES, IDLE_MS, LEVEL_KEYS, MAX_AGENTS, db, langOf, levelName, log, say } from './ctx.mjs';
import { t } from './i18n.mjs';
import { canUseEngine } from './access.mjs';
import { DEFAULT_ENGINE, ENGINES, createAgent, engineMode, getEngine, modeAllowed, resolveEngine } from './engines.mjs';
import { DEFAULT_DIR, insideRoot, pushRecent, samePath } from './projects.mjs';

const states = new Map(); // userId -> состояние

/**
 * Сколько ждать запуска агента (initialize, создание или загрузка сессии), AGENT_START_TIMEOUT секунд, по умолчанию 120.
 * Без ограничения зависший агент (например, ждёт входа в аккаунт) держал бы пользователя в «агент занят» до /close.
 */
export const START_TIMEOUT_MS = (Number(process.env.AGENT_START_TIMEOUT) > 0 ? Number(process.env.AGENT_START_TIMEOUT) : 120) * 1000;

export const isAdmin = (id) => id === ADMIN_ID;

export class LimitError extends Error {
  code = 'LIMIT';
}

/** Сессию закрыли (/close, администратор, отзыв доступа), пока агент запускался или запрос готовился. */
export class ClosedError extends Error {
  code = 'CLOSED';
  constructor(message = 'Session closed.') {
    super(message);
  }
}

/** Обработчик запросов разрешений подключает turn.mjs (так нет циклического импорта). */
let permissionHandler = null;
export const setPermissionHandler = (fn) => {
  permissionHandler = fn;
};

/**
 * Движок, в котором сейчас работает пользователь: его выбор (/engine), если движок ему выдан и доступен на сервере,
 * иначе движок по умолчанию. Работающая сессия всегда в движке своего процесса, даже если выбор с тех пор изменился.
 */
export const engineOf = (st) =>
  st.agent && !st.agent.closed ? st.agent.engine : canUseEngine(st.userId, st.engine) ? ENGINES[st.engine] : resolveEngine(null);

/** Режим сессии для пользователя в его движке; для неизвестного уровня — самый безопасный (чтение). */
export function modeFor(userId, engine = getEngine(DEFAULT_ENGINE)) {
  return engineMode(engine, { admin: isAdmin(userId), level: db.getUser(userId)?.level });
}

/** Название уровня доступа пользователя на его языке (администратор — свой уровень). */
export function levelLabel(userId) {
  const lang = langOf(userId);
  if (isAdmin(userId)) return t('level.admin', lang);
  const level = db.getUser(userId)?.level;
  return LEVEL_KEYS.includes(level) ? levelName(level, lang) : '—';
}

// ---- темы в личном чате (Bot API 9.3): режим «диалоги» ----

/** Включены ли у бота темы в личном чате (getMe: has_topics_enabled) и могут ли пользователи сами их создавать. Заполняется при старте. */
export const topicsSupport = { enabled: false, usersCreate: false };

/**
 * Режим «диалоги» у пользователя: каждая тема чата с ботом — отдельный диалог со своей сессией агента, проектом и движком.
 * Только если у бота включены темы; пользователь может выключить (/topics) — тогда один диалог, как без тем. По умолчанию включён.
 */
export const topicsOn = (userId) => topicsSupport.enabled && db.getSetting(`topics:${userId}`) !== 'off';
export const setTopicsMode = (userId, on) => db.setSetting(`topics:${userId}`, on ? 'on' : 'off');

/** Номер диалога для сообщения из темы threadId: в режиме «диалоги» — сама тема, иначе 0 (один диалог на пользователя). */
export const topicOf = (userId, threadId) => (threadId && topicsOn(userId) ? threadId : 0);
const keyOf = (userId, topic) => `${userId}:${topic}`;

/**
 * Состояние диалога пользователя. threadId — тема, откуда пришло сообщение (null — общий чат). В режиме «диалоги» у каждой
 * темы своё состояние (st.topic = threadId), общий чат (General) — обычный диалог, как без тем (st.topic = 0); вне режима —
 * одно состояние на пользователя, а ответы уходят в тему последнего сообщения. Куда отвечать — st.to.
 */
export function getState(userId, chatId, threadId = null) {
  const topic = topicOf(userId, threadId);
  const key = keyOf(userId, topic);
  let st = states.get(key);
  if (!st) {
    // проект запоминается отдельно для каждого пользователя; у администратора подхватываем ранее сохранённый общий
    const saved = db.getSetting(`project:${userId}`) || (isAdmin(userId) ? db.getSetting('project') : null);
    // у темы свои проект, движок и сессия агента; новая тема начинает с последнего выбора пользователя
    const row = topic ? db.getTopic(userId, topic) : null;
    st = {
      userId,
      chatId,
      topic,
      threadId: topic || threadId || null,
      agent: null,
      engine: row?.engine ?? db.getSetting(`engine:${userId}`), // выбор пользователя; null — движок по умолчанию (DEFAULT_ENGINE)
      busy: false,
      requestId: null,
      onUpdate: null, // обработчик событий текущего запроса
      perms: new Map(), // ожидающие запросы разрешений
      suppress: false, // администратор прервал запрос — итоговый ответ не отправляем
      lastActive: Date.now(),
      // сохранённый проект, если он ещё существует (и лежит в корне, если корень задан), иначе корень или домашняя папка
      project: insideRoot(row?.project || saved || DEFAULT_DIR) || DEFAULT_DIR,
      // сессия агента темы: возобновится при первом запросе (после простоя или перезапуска бота)
      resumeId: row?.acp_session_id || null,
      /** Куда отвечать: id чата или {chat_id, message_thread_id} для темы. */
      get to() {
        return this.threadId ? { chat_id: this.chatId, message_thread_id: this.threadId } : this.chatId;
      },
    };
    states.set(key, st);
  }
  if (chatId) st.chatId = chatId;
  if (!topic) st.threadId = threadId || null;
  return st;
}

/** Состояние диалога, если оно уже есть (не создаёт новое). */
export const findState = (userId, threadId = null) => states.get(keyOf(userId, topicOf(userId, threadId)));

/** Все диалоги пользователя (в режиме «диалоги» их может быть несколько). */
export const statesOf = (userId) => [...states.values()].filter((s) => s.userId === userId);

export const RECENT_LIMIT = 6;

const readRecent = (userId) => {
  try {
    const list = JSON.parse(db.getSetting(`recent:${userId}`) || '[]');
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
};

/** Недавние проекты пользователя (свежие первыми): только существующие и допустимые папки, без текущего проекта. */
export const recentProjects = (st) =>
  readRecent(st.userId)
    .map((p) => insideRoot(p))
    .filter((p) => p && !samePath(p, st.project));

export function saveProject(st, path) {
  db.setSetting(`recent:${st.userId}`, JSON.stringify(pushRecent(readRecent(st.userId), st.project, path, RECENT_LIMIT)));
  st.project = path;
  db.setSetting(`project:${st.userId}`, path); // и проект по умолчанию для новых тем
  if (st.topic) db.saveTopic(st.userId, st.topic, { project: path });
  st.resumeId = null; // в другом проекте — новая сессия
}

/** Запоминает выбор движка пользователя. Текущую сессию закрывает вызывающий (endAgent), если движок другой. */
export function saveEngine(st, id) {
  if (id !== st.engine) st.resumeId = null; // в другом движке — новая сессия
  st.engine = id;
  db.setSetting(`engine:${st.userId}`, id); // и движок по умолчанию для новых тем
  if (st.topic && id) db.saveTopic(st.userId, st.topic, { engine: id });
}

export function dropPermissions(st, outcome = { outcome: 'cancelled' }) {
  for (const [seq, p] of st.perms) {
    db.permissionAnswered(p.dbId, null, outcome.outcome);
    p.resolve(outcome);
    st.perms.delete(seq);
    p.onDrop?.(); // сообщение с кнопками — в итог «Отменено» (turn.mjs)
  }
}

// После каких закрытий сессия диалога продолжится при следующем запросе: в теме — после простоя, /close, выгрузки
// и перезапуска бота; в обычном диалоге — только после выгрузки ради места (раньше там всегда начиналась новая).
// После смены проекта, движка, уровня доступа, нарушения режима и /new — всегда новая сессия.
const KEEP_IN_TOPIC = new Set(['idle', 'close', 'evicted', 'shutdown']);

export function endAgent(st, reason) {
  if (!st.agent) return;
  const keep = st.topic ? KEEP_IN_TOPIC.has(reason) : reason === 'evicted';
  st.resumeId = keep ? (st.agent.sessionId ?? st.resumeId) : null;
  if (st.topic && !keep) db.saveTopic(st.userId, st.topic, { acpSessionId: '' }); // '' — сессии нет (null не затирает)
  db.endSession(st.agent.dbSessionId, reason);
  st.agent.close();
  st.agent = null;
}

/** Прерывает запрос пользователя и закрывает его сессию (отзыв доступа, смена уровня). */
export function stopUser(st, reason) {
  if (st.busy) {
    st.suppress = true;
    st.agent?.cancel();
  }
  dropPermissions(st);
  endAgent(st, reason);
}

/**
 * Явное закрытие сессии: прерывает запрос (если идёт), снимает ожидающие разрешения, убивает процесс агента.
 * Сессию можно возобновить позже через /sessions. Возвращает false, если закрывать было нечего.
 */
export function closeSession(st, reason) {
  if (!st.busy && !(st.agent && !st.agent.closed)) return false;
  stopUser(st, reason);
  return true;
}

/** Работающие сейчас сессии всех пользователей (включая администратора). */
export function activeSessions() {
  return [...states.values()]
    .filter((s) => s.agent && !s.agent.closed)
    .map((s) => ({
      userId: s.userId,
      engine: s.agent.engine?.short,
      project: s.agent.cwd ?? s.project,
      topic: s.topic ? db.getTopic(s.userId, s.topic)?.name ?? null : null, // название темы (режим «диалоги»)
      startedAt: s.agent.startedAt ?? s.lastActive,
      busy: s.busy,
    }));
}

/** Сколько процессов агентов сейчас у сотрудников: все движки под общим лимитом, администратор в лимит не входит. */
const activeUserAgents = () => [...states.values()].filter((s) => !isAdmin(s.userId) && s.agent).length;

/** Сколько агентов одного пользователя работает одновременно (в режиме «диалоги» — в разных темах). */
export const MAX_AGENTS_PER_USER = Number(process.env.MAX_AGENTS_PER_USER) > 0 ? Number(process.env.MAX_AGENTS_PER_USER) : 2;
export const ADMIN_MAX_AGENTS = Number(process.env.ADMIN_MAX_AGENTS) > 0 ? Number(process.env.ADMIN_MAX_AGENTS) : 4;
const capOf = (userId) => (isAdmin(userId) ? ADMIN_MAX_AGENTS : MAX_AGENTS_PER_USER);

/**
 * Освобождает место под агента диалога st. Если упёрлись в лимит пользователя или общий лимит сотрудников —
 * выгружается самый давний простаивающий агент этого же пользователя (из другой темы): его сессия продолжится,
 * когда пользователь туда вернётся. Чужие агенты не трогаем; если свободных нет — LimitError.
 */
export function reserveSlot(st) {
  const lang = langOf(st.userId);
  const mine = () => statesOf(st.userId).filter((s) => s !== st && s.agent);
  const globalFull = () => !isAdmin(st.userId) && activeUserAgents() >= MAX_AGENTS;
  while (mine().length >= capOf(st.userId) || globalFull()) {
    const idle = mine()
      .filter((s) => !s.busy)
      .sort((x, y) => x.lastActive - y.lastActive)[0];
    if (!idle) break;
    log('агент простаивающего диалога выгружен, чтобы освободить место | пользователь', st.userId, '| тема', idle.topic);
    endAgent(idle, 'evicted');
  }
  if (mine().length >= capOf(st.userId)) throw new LimitError(t('limit.user', lang, { max: capOf(st.userId) }));
  if (globalFull()) throw new LimitError(t('limit.slots', lang, { max: MAX_AGENTS }));
}

/**
 * Возвращает работающий процесс агента диалога или запускает новый (в его движке). Если у диалога есть сохранённая
 * сессия (st.resumeId: тема, к которой вернулись, или выгруженный агент), она возобновляется; не вышло — новая.
 * @param {{resume?: string}} [opts] resume — id сессии ACP, которую нужно возобновить вместо новой (/sessions)
 */
export async function ensureAgent(st, { resume } = {}) {
  if (st.agent && !st.agent.closed) return st.agent;
  const auto = resume ? null : st.resumeId;
  try {
    return await startAgent(st, { resume: resume ?? auto ?? undefined });
  } catch (e) {
    if (!auto || e instanceof ClosedError || e instanceof LimitError) throw e;
    log(`сессию ${auto} не удалось возобновить (${e.message}) — начинаю новую | пользователь`, st.userId);
    st.resumeId = null;
    return startAgent(st, {});
  }
}

async function startAgent(st, { resume } = {}) {
  reserveSlot(st);
  const engine = engineOf(st);
  const allowed = modeFor(st.userId, engine);
  const a = createAgent(engine, {
    cwd: st.project,
    onUpdate: (u) => {
      // пока агент запускается, он может «проигрывать» историю возобновлённой сессии — в текущий ответ она не идёт
      if (!a.ready) return;
      // Агент сменил режим сам (например, выход из плана у Claude Code). Основная защита — фильтр вариантов в askPermission;
      // это последний рубеж: вернуть режим нельзя (текущий ход агент доделывает уже в новом режиме), поэтому сразу
      // прерываем запрос и гасим процесс.
      if (u.sessionUpdate === 'current_mode_update' && u.currentModeId) {
        if (a.sessionId && st.agent === a && !modeAllowed(engine, u.currentModeId, allowed)) {
          log(`⛔ ${engine.label} перешёл в режим ${u.currentModeId} выше разрешённого (${allowed}) — сессия закрыта | пользователь`, st.userId);
          stopUser(st, 'mode-violation');
          say(st.to, t('state.modeViolation', langOf(st.userId), { mode: u.currentModeId }));
          return;
        }
        a.mode = u.currentModeId;
      }
      // стоимость (Claude Code) — нарастающим итогом за процесс; запоминаем при любом событии, даже вне запроса
      if (u.sessionUpdate === 'usage_update') {
        if (Number.isFinite(u.cost?.amount)) a.lastCostTotal = u.cost.amount;
        if (u._meta?.['_claude/model']) a.lastModel = u._meta['_claude/model'];
      }
      st.onUpdate?.(u);
    },
    onPermission: (p) => permissionHandler(st, p),
    onExit: (code) => {
      log(`${engine.label} завершился, код`, code, 'пользователь', st.userId);
      db.endSession(a.dbSessionId, `exit ${code}`);
      if (st.agent === a) st.agent = null;
    },
  });
  st.agent = a; // занимаем слот сразу, пока идёт запуск (~10 с), иначе лимит можно обойти параллельными запросами
  try {
    await a.init(allowed, { resume, timeoutMs: START_TIMEOUT_MS });
  } catch (e) {
    // процесс убили закрытием сессии во время запуска (endAgent уже снял st.agent) — это не ошибка агента
    const closedByUser = st.agent !== a;
    a.close();
    if (st.agent === a) st.agent = null;
    if (closedByUser) throw new ClosedError();
    if (e.code === 'START_TIMEOUT') {
      log(`⚠️ ${engine.label} не запустился за ${START_TIMEOUT_MS / 1000} с — процесс завершён | пользователь`, st.userId);
      throw new Error(t('state.startTimeout', langOf(st.userId), { engine: engine.label, sec: START_TIMEOUT_MS / 1000 }));
    }
    throw e;
  }
  // сессию закрыли, пока шёл запуск, а init успел завершиться: не регистрируем её и гасим процесс
  if (st.agent !== a || a.closed) {
    a.close();
    throw new ClosedError();
  }
  a.startedAt = Date.now();
  a.ready = true;
  // сессия диалога: в теме — запоминается в базе (вернётся пользователь через неделю — продолжит её же)
  st.resumeId = a.sessionId;
  if (st.topic) db.saveTopic(st.userId, st.topic, { acpSessionId: a.sessionId, engine: engine.id, project: st.project });
  // Каталог моделей здесь не обновляем: у сессии пользователя могут быть свои настройки (а у Claude Code набор уровней
  // рассуждений зависит от модели) — каталог берётся только из чистого запуска (access.probeCatalog).
  if (resume) {
    // возобновлённая сессия могла восстановить прежнюю модель — перед запросом модель и рассуждения выставляются заново
    a.applied = { model: '?', effort: '?' };
    // стоимость у Claude Code — нарастающим итогом; после загрузки истории базы нет, первый запрос не оцениваем
    a.costBaseUnknown = true;
  }
  a.dbSessionId = db.startSession(a.sessionId, st.userId, st.chatId, a.mode, a.cwd, engine.id);
  log(resume ? 'ACP-сессия возобновлена' : 'ACP-сессия', a.sessionId, '| пользователь', st.userId, '| движок', engine.id, '| режим', a.mode, '| проект', a.cwd, '| db-id', a.dbSessionId);
  return a;
}

/** Закрывает сессии, простаивающие дольше IDLE_MINUTES, чтобы не копить процессы агентов. */
export function startIdleReaper() {
  setInterval(() => {
    for (const st of states.values()) {
      if (st.agent && !st.busy && Date.now() - st.lastActive > IDLE_MS) {
        endAgent(st, 'idle');
        log('сессия закрыта по неактивности, пользователь', st.userId, '| тема', st.topic);
        // в теме разговор продолжится с того же места (сессия темы возобновится), в обычном диалоге — начнётся новый
        say(st.to, t(st.topic ? 'state.idleTopic' : 'state.idle', langOf(st.userId), { min: IDLE_MINUTES }));
      }
    }
  }, 60_000).unref();
}

export function shutdownAll(reason = 'shutdown') {
  for (const st of states.values()) {
    dropPermissions(st);
    endAgent(st, reason);
  }
}

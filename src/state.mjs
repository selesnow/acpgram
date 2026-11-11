// Состояние по пользователям: у каждого свой процесс агента, движок, проект, флаг «занят» и разрешения.
import { ADMIN_ID, IDLE_MINUTES, IDLE_MS, LEVELS, MAX_AGENTS, db, log, say } from './ctx.mjs';
import { canUseEngine } from './access.mjs';
import { DEFAULT_ENGINE, ENGINES, createAgent, engineMode, getEngine, modeAllowed, resolveEngine } from './engines.mjs';
import { DEFAULT_DIR, insideRoot, pushRecent, samePath } from './projects.mjs';

const states = new Map(); // userId -> состояние

export const isAdmin = (id) => id === ADMIN_ID;

export class LimitError extends Error {
  code = 'LIMIT';
}

/** Сессию закрыли (/close, администратор, отзыв доступа), пока агент запускался или запрос готовился. */
export class ClosedError extends Error {
  code = 'CLOSED';
  constructor(message = 'Сессия закрыта.') {
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

export function levelLabel(userId) {
  if (isAdmin(userId)) return 'Администратор';
  return LEVELS[db.getUser(userId)?.level]?.label ?? '—';
}

export function getState(userId, chatId) {
  let st = states.get(userId);
  if (!st) {
    // проект запоминается отдельно для каждого пользователя; у администратора подхватываем ранее сохранённый общий
    const saved = db.getSetting(`project:${userId}`) || (isAdmin(userId) ? db.getSetting('project') : null);
    st = {
      userId,
      chatId,
      agent: null,
      engine: db.getSetting(`engine:${userId}`), // выбор пользователя; null — движок по умолчанию (DEFAULT_ENGINE)
      busy: false,
      requestId: null,
      onUpdate: null, // обработчик событий текущего запроса
      perms: new Map(), // ожидающие запросы разрешений
      suppress: false, // администратор прервал запрос — итоговый ответ не отправляем
      lastActive: Date.now(),
      // сохранённый проект, если он ещё существует (и лежит в корне, если корень задан), иначе корень или домашняя папка
      project: insideRoot(saved || DEFAULT_DIR) || DEFAULT_DIR,
    };
    states.set(userId, st);
  }
  if (chatId) st.chatId = chatId;
  return st;
}

export const findState = (userId) => states.get(userId);

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
  db.setSetting(`project:${st.userId}`, path);
}

/** Запоминает выбор движка пользователя. Текущую сессию закрывает вызывающий (endAgent), если движок другой. */
export function saveEngine(st, id) {
  st.engine = id;
  db.setSetting(`engine:${st.userId}`, id);
}

export function dropPermissions(st, outcome = { outcome: 'cancelled' }) {
  for (const [seq, p] of st.perms) {
    db.permissionAnswered(p.dbId, null, outcome.outcome);
    p.resolve(outcome);
    st.perms.delete(seq);
  }
}

export function endAgent(st, reason) {
  if (!st.agent) return;
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
    .map((s) => ({ userId: s.userId, engine: s.agent.engine?.short, project: s.agent.cwd ?? s.project, startedAt: s.agent.startedAt ?? s.lastActive, busy: s.busy }));
}

/** Сколько процессов агентов сейчас у сотрудников: все движки под общим лимитом, администратор в лимит не входит. */
const activeUserAgents = () => [...states.values()].filter((s) => !isAdmin(s.userId) && s.agent).length;

/**
 * Возвращает работающий процесс агента пользователя или запускает новый (в его движке).
 * @param {{resume?: string}} [opts] resume — id сессии ACP, которую нужно возобновить вместо новой
 */
export async function ensureAgent(st, { resume } = {}) {
  if (st.agent && !st.agent.closed) return st.agent;
  if (!isAdmin(st.userId) && activeUserAgents() >= MAX_AGENTS) {
    throw new LimitError(`⏳ Сейчас заняты все ${MAX_AGENTS} слота агентов сотрудников. Попробуйте через минуту.`);
  }
  const engine = engineOf(st);
  const allowed = modeFor(st.userId, engine);
  const a = createAgent(engine, {
    cwd: st.project,
    onUpdate: (u) => {
      // Агент сменил режим сам (например, выход из плана у Claude Code). Основная защита — фильтр вариантов в askPermission;
      // это последний рубеж: вернуть режим нельзя (текущий ход агент доделывает уже в новом режиме), поэтому сразу
      // прерываем запрос и гасим процесс.
      if (u.sessionUpdate === 'current_mode_update' && u.currentModeId) {
        if (a.sessionId && st.agent === a && !modeAllowed(engine, u.currentModeId, allowed)) {
          log(`⛔ ${engine.label} перешёл в режим ${u.currentModeId} выше разрешённого (${allowed}) — сессия закрыта | пользователь`, st.userId);
          stopUser(st, 'mode-violation');
          say(st.chatId, `⛔ Агент попытался перейти в режим «${u.currentModeId}», недоступный на вашем уровне доступа. Запрос остановлен, сессия закрыта.`);
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
    await a.init(allowed, { resume });
  } catch (e) {
    // процесс убили закрытием сессии во время запуска (endAgent уже снял st.agent) — это не ошибка агента
    const closedByUser = st.agent !== a;
    a.close();
    if (st.agent === a) st.agent = null;
    throw closedByUser ? new ClosedError() : e;
  }
  // сессию закрыли, пока шёл запуск, а init успел завершиться: не регистрируем её и гасим процесс
  if (st.agent !== a || a.closed) {
    a.close();
    throw new ClosedError();
  }
  a.startedAt = Date.now();
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
        log('сессия закрыта по неактивности, пользователь', st.userId);
        say(st.chatId, `💤 Сессия закрыта из-за неактивности (${IDLE_MINUTES} мин). Следующий запрос начнёт новую.`);
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

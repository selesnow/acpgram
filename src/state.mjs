// Состояние по пользователям: у каждого свой процесс агента, движок, проект, флаг «занят» и разрешения.
import { ADMIN_ID, IDLE_MINUTES, IDLE_MS, LEVEL_KEYS, MAX_AGENTS, db, langOf, levelName, log, pending, say } from './ctx.mjs';
import { positiveEnv } from './app.mjs';
import { t } from './i18n.mjs';
import { canUseEngine, modelAllowed, parseJson } from './access.mjs';
import { actualModelFromUpdate, DEFAULT_ENGINE, ENGINES, createAgent, engineCommand, engineMode, getEngine, modeAllowed, resolveEngine } from './engines.mjs';
import { HOME, ROOT, insideRoot, isPersonalRoot, isWithin, pushRecent, samePath, showPath, userRoot } from './projects.mjs';
import { SANDBOX, agentSandbox } from './sandbox.mjs';
import { GIT_AGENT_AUTH, agentGitEnv, refreshAccounts } from './gitAccess.mjs';

const states = new Map(); // userId -> состояние

/**
 * Сколько ждать запуска агента (initialize, создание или загрузка сессии), AGENT_START_TIMEOUT секунд, по умолчанию 120.
 * Без ограничения зависший агент (например, ждёт входа в аккаунт) держал бы пользователя в «агент занят» до /close.
 */
export const START_TIMEOUT_MS = positiveEnv('AGENT_START_TIMEOUT', 120) * 1000;

export const ADMIN_SANDBOX = process.env.ADMIN_SANDBOX === '1';

export const isAdmin = (id) => id === ADMIN_ID;

/**
 * Корень пользователя: проекты он выбирает только внутри него. Сотруднику при личных пространствах (USER_WORKSPACES) —
 * его папка в корне проектов, администратору и без них — общий корень; null — режим без корня.
 */
export const rootOf = (userId) => userRoot(userId, { admin: isAdmin(userId) });

/** Папка, с которой начинает пользователь: его корень, а без корня — домашняя папка. */
export const defaultDirOf = (userId) => rootOf(userId) ?? HOME;

/** Путь для показа пользователю: относительно его корня, на его языке (личное пространство — без пути на сервере). */
export const userPath = (userId, p, lang = langOf(userId)) => showPath(p, lang, rootOf(userId));

/** Проект для названия темы: личное пространство целиком называется «Моё пространство», а не числом — именем папки. */
export const topicProject = (userId, project, lang = langOf(userId)) => {
  const root = rootOf(userId);
  return isPersonalRoot(root) && samePath(project, root) ? t('proj.myRoot', lang) : project;
};

export class LimitError extends Error {
  code = 'LIMIT';
}

/** Папка проекта недоступна или лежит вне корня пользователя: агент не запускается, нужно выбрать проект заново. */
export class ProjectError extends Error {
  code = 'PROJECT';
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
    const root = rootOf(userId);
    // сохранённый проект, если он ещё существует и лежит в корне пользователя, иначе его корень или домашняя папка
    const wanted = row?.project || saved;
    const project = (wanted && insideRoot(wanted, root)) || defaultDirOf(userId);
    // проект темы стал недоступен (удалён или оказался вне корня — включили личные пространства): её сессия в другой
    // папке не продолжается
    const moved = Boolean(row?.project) && !samePath(project, row.project);
    st = {
      userId,
      chatId,
      topic,
      threadId: topic || threadId || null,
      agent: null,
      engine: row?.engine ?? db.getSetting(`engine:${userId}`), // выбор пользователя; null — движок по умолчанию (DEFAULT_ENGINE)
      busy: false,
      gitBusy: false,
      requestId: null,
      onUpdate: null, // обработчик событий текущего запроса
      perms: new Map(), // ожидающие запросы разрешений
      suppress: false, // администратор прервал запрос — итоговый ответ не отправляем
      queued: null, // сообщение, пришедшее во время запроса: уйдёт агенту следующим (turn.mjs)
      lastActive: Date.now(),
      get pendingInput() {
        return pending.get(this.userId, `topic:${this.topic}`);
      },
      set pendingInput(value) {
        if (value == null) pending.clear(this.userId, `topic:${this.topic}`);
        else pending.set(this.userId, `topic:${this.topic}`, value);
      },
      project,
      // сессия агента темы: возобновится при первом запросе (после простоя или перезапуска бота)
      resumeId: moved ? null : row?.acp_session_id || null,
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
  const list = parseJson(db.getSetting(`recent:${userId}`), []);
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
};

/** Недавние проекты пользователя (свежие первыми): только существующие и допустимые папки, без текущего проекта. */
export const recentProjects = (st) =>
  readRecent(st.userId)
    .map((p) => insideRoot(p, rootOf(st.userId)))
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
  st.queued = null; // сообщение, ждавшее своей очереди, в закрытую сессию не отправляем
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
export const MAX_AGENTS_PER_USER = positiveEnv('MAX_AGENTS_PER_USER', 2);
export const ADMIN_MAX_AGENTS = positiveEnv('ADMIN_MAX_AGENTS', 4);
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
    if (!auto || e instanceof ClosedError || e instanceof LimitError || e instanceof ProjectError) throw e;
    log(`сессию ${auto} не удалось возобновить (${e.message}) — начинаю новую | пользователь`, st.userId);
    st.resumeId = null;
    return startAgent(st, {});
  }
}

/**
 * Одна сессия агента — в одном диалоге. Перед возобновлением сессии sessionId в диалоге st она закрывается во всех
 * других диалогах пользователя (General, другие темы): иначе два процесса агента писали бы в одну историю.
 * Там, где сессия работала, — короткое сообщение; там, где она только ждала возобновления, — тихо забываем.
 * Занятый запросом диалог не трогаем: LimitError — пусть сначала закончит или будет остановлен.
 */
export function releaseSessionElsewhere(st, sessionId) {
  if (!sessionId) return;
  const lang = langOf(st.userId);
  for (const other of statesOf(st.userId)) {
    if (other === st) continue;
    const live = other.agent && !other.agent.closed && other.agent.sessionId === sessionId;
    if (live) {
      if (other.busy) throw new LimitError(t('ses.busyElsewhere', lang));
      dropPermissions(other);
      endAgent(other, 'moved');
      log('сессия', sessionId, 'перенесена в другой диалог и закрыта здесь | пользователь', st.userId, '| тема', other.topic);
      say(other.to, t('ses.movedAway', lang));
    } else if (other.resumeId === sessionId) {
      other.resumeId = null;
      if (other.topic) db.saveTopic(other.userId, other.topic, { acpSessionId: '' });
    }
  }
}

export const sandboxed = (userId, cwd = null) => {
  if (!SANDBOX) return false;
  if (!isAdmin(userId)) return true;
  return Boolean(ADMIN_SANDBOX && ROOT && cwd && isWithin(cwd, ROOT));
};

/**
 * Песочница для агента диалога (sandbox.agentSandbox) или null. На запись — корень пользователя (без корня — только
 * папка проекта). У сотрудника с личным пространством общий корень проектов целиком открыть нельзя: там чужие папки.
 */
function sandboxFor(st, cwd, engine) {
  if (!sandboxed(st.userId, cwd)) return null;
  const root = rootOf(st.userId);
  try {
    return agentSandbox({ userId: st.userId, cwd, root, command: engineCommand(engine), protect: isPersonalRoot(root) ? [ROOT] : [] });
  } catch (e) {
    log('⚠️ песочница не собрана — агент не запущен:', e.message, '| пользователь', st.userId);
    throw new ProjectError(t('state.sandboxFail', langOf(st.userId)), { cause: e });
  }
}

async function startAgent(st, { resume } = {}) {
  // папка проекта проверяется перед каждым запуском: её могли удалить или подменить ссылкой после выбора,
  // а агент не должен стартовать вне корня пользователя
  const cwd = insideRoot(st.project, rootOf(st.userId));
  if (!cwd) {
    log('⚠️ папка проекта недоступна или вне корня пользователя — агент не запущен | пользователь', st.userId, '| проект', st.project);
    throw new ProjectError(t('state.projectGone', langOf(st.userId)));
  }
  // в режиме «вход у агента» токен должен быть свежим на старте сессии (вход по коду у GitLab живёт 2 часа)
  if (GIT_AGENT_AUTH) await refreshAccounts(st.userId).catch((e) => log('git: обновление входа перед запуском агента:', e.message));
  releaseSessionElsewhere(st, resume);
  reserveSlot(st);
  const engine = engineOf(st);
  const allowed = modeFor(st.userId, engine);
  const a = createAgent(engine, {
    cwd,
    wrap: sandboxFor(st, cwd, engine),
    extraEnv: agentGitEnv(st.userId),
    // уровень доступа — и в окружение процесса (у OpenCode права задаются конфигом, а не режимом сессии)
    who: { admin: isAdmin(st.userId), level: db.getUser(st.userId)?.level },
    onUpdate: (u) => {
      // собственные команды агента («/compact» у Claude Code) — приходят и во время запуска; по ним бот отличает
      // команду агента от опечатки в команде бота
      if (u.sessionUpdate === 'available_commands_update' && Array.isArray(u.availableCommands)) {
        a.commands = new Set(u.availableCommands.map((c) => String(c?.name ?? '').replace(/^\//, '').toLowerCase()).filter(Boolean));
      }
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
        const model = actualModelFromUpdate(u);
        if (model) a.lastModel = model;
        if (a.sessionId && st.agent === a && model && !modelAllowed(st.userId, engine.id, model)) {
          log(`⛔ ${engine.label} использовал модель ${model} вне разрешённого списка — сессия закрыта | пользователь`, st.userId);
          stopUser(st, 'model-violation');
          say(st.to, t('state.modelViolation', langOf(st.userId), { model }));
          return;
        }
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
      throw new Error(t('state.startTimeout', langOf(st.userId), { engine: engine.label, sec: START_TIMEOUT_MS / 1000 }), { cause: e });
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
        const lang = langOf(st.userId);
        // в обычном диалоге — кнопка «Сессии»: вернуться к закрытой сессии одним нажатием, без набора /sessions
        const extra = st.topic ? {} : { reply_markup: { inline_keyboard: [[{ text: t('btn.sessions', lang), callback_data: 'ui:sessions' }]] } };
        say(st.to, t(st.topic ? 'state.idleTopic' : 'state.idle', lang, { min: IDLE_MINUTES }), extra);
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

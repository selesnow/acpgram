// База работы бота (SQLite): сессии, запросы пользователя, вызовы инструментов, разрешения, ответы модели.
// Используется встроенный в Node модуль node:sqlite — без внешних зависимостей.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logError } from './log.mjs';

const now = () => new Date().toISOString();
const cut = (s, n) => (s == null ? null : String(s).slice(0, n));

export const SCHEMA_VERSION = 30;

const SCHEMA_COLUMNS = {
  sessions: ['id', 'acp_session_id', 'user_id', 'chat_id', 'mode', 'cwd', 'engine', 'started_at', 'ended_at', 'end_reason'],
  settings: ['key', 'value'],
  requests: [
    'id', 'session_id', 'user_text', 'started_at', 'finished_at', 'duration_ms', 'stop_reason', 'answer', 'error',
    'model', 'effort', 'input_tokens', 'output_tokens', 'cached_tokens', 'thought_tokens', 'total_tokens', 'cost_usd',
  ],
  tool_calls: [
    'id', 'request_id', 'tool_call_id', 'tool', 'kind', 'title', 'description', 'status', 'output', 'started_at', 'finished_at',
  ],
  permissions: [
    'id', 'request_id', 'tool_call_id', 'title', 'options', 'chosen_option', 'outcome', 'asked_at', 'answered_at',
  ],
  users: ['user_id', 'username', 'first_name', 'level', 'added_by', 'added_at', 'status', 'revoked_at', 'engines', 'models'],
  invites: ['code', 'level', 'created_by', 'created_at', 'expires_at', 'used_by', 'used_at'],
  access_requests: ['user_id', 'username', 'first_name', 'requested_at', 'status', 'decided_at'],
  topics: ['user_id', 'thread_id', 'name', 'named', 'project', 'engine', 'acp_session_id', 'hidden', 'created_at', 'updated_at'],
  git_accounts: ['user_id', 'host', 'login', 'name', 'email', 'token', 'expires_at', 'added_at', 'refresh_token', 'access_until'],
};

const verifySchema = (db) => {
  for (const [table, columns] of Object.entries(SCHEMA_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    const missing = columns.filter((name) => !have.has(name));
    if (missing.length) throw new Error(`[db] ${table}: ${missing.join(', ')}`);
  }
};

const securePath = (path, mode) => {
  if (process.platform === 'win32' || !existsSync(path)) return;
  try {
    chmodSync(path, mode);
  } catch (e) {
    logError('не удалось ограничить права:', path, e.message);
  }
};

export function openDb(path = 'data/bot.db') {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  securePath(dir, 0o700);
  securePath(path, 0o600);
  for (const suffix of ['-wal', '-shm']) securePath(path + suffix, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- при WAL безопасно: база не повреждается, после сбоя питания теряются лишь последние записи журнала;
    -- без этого каждая запись (шаги агента, запросы разрешений) ждала сброса на диск
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    -- базу на секунды может занять другой процесс (копирование, отчёт): ждём, а не теряем запись
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      acp_session_id TEXT,
      user_id        INTEGER NOT NULL,
      chat_id        INTEGER NOT NULL,
      mode           TEXT,
      cwd            TEXT,
      engine         TEXT,
      started_at     TEXT NOT NULL,
      ended_at       TEXT,
      end_reason     TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER REFERENCES sessions(id),
      user_text   TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      stop_reason TEXT,
      answer      TEXT,
      error       TEXT,
      model       TEXT,
      effort      TEXT,
      input_tokens   INTEGER,
      output_tokens  INTEGER,
      cached_tokens  INTEGER,
      thought_tokens INTEGER,
      total_tokens   INTEGER,
      cost_usd       REAL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id   INTEGER NOT NULL REFERENCES requests(id),
      tool_call_id TEXT NOT NULL,
      tool         TEXT,
      kind         TEXT,
      title        TEXT,
      description  TEXT,
      status       TEXT,
      output       TEXT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      UNIQUE (request_id, tool_call_id)
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id    INTEGER REFERENCES requests(id),
      tool_call_id  TEXT,
      title         TEXT,
      options       TEXT,
      chosen_option TEXT,
      outcome       TEXT,
      asked_at      TEXT NOT NULL,
      answered_at   TEXT
    );

    -- сотрудники, которым администратор выдал доступ (администратор задаётся в .env и здесь не хранится)
    CREATE TABLE IF NOT EXISTS users (
      user_id    INTEGER PRIMARY KEY,
      username   TEXT,
      first_name TEXT,
      level      TEXT NOT NULL,
      added_by   INTEGER,
      added_at   TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      revoked_at TEXT,
      engines    TEXT,
      models     TEXT
    );

    -- одноразовые ссылки-приглашения
    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      level      TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_by    INTEGER,
      used_at    TEXT
    );

    -- запросы доступа от незнакомых пользователей
    CREATE TABLE IF NOT EXISTS access_requests (
      user_id      INTEGER PRIMARY KEY,
      username     TEXT,
      first_name   TEXT,
      requested_at TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      decided_at   TEXT
    );

    -- темы в личном чате с ботом (режим «диалоги»): у каждой темы свой проект, движок и сессия агента
    CREATE TABLE IF NOT EXISTS topics (
      user_id        INTEGER NOT NULL,
      thread_id      INTEGER NOT NULL,
      name           TEXT,
      named          INTEGER NOT NULL DEFAULT 0, -- 1: название окончательное (задал пользователь или агент)
      project        TEXT,
      engine         TEXT,
      acp_session_id TEXT,                       -- сессия агента темы: возобновляется, когда пользователь возвращается
      hidden         INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (user_id, thread_id)
    );

    -- аккаунты Git пользователей (GitHub, GitLab): токен доступа и профиль; токен хранится только здесь
    CREATE TABLE IF NOT EXISTS git_accounts (
      user_id    INTEGER NOT NULL,
      host       TEXT NOT NULL,            -- id сервиса (gitHosts.mjs): github, gitlab, corp
      login      TEXT,
      name       TEXT,
      email      TEXT,
      token      TEXT NOT NULL,
      expires_at TEXT,                     -- когда истекает токен (если сервис сообщил)
      added_at   TEXT NOT NULL,
      refresh_token TEXT,
      access_until  TEXT,
      PRIMARY KEY (user_id, host)
    );

    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_request ON tool_calls(request_id);
    -- /sessions: сессии пользователя и поиск всех запусков одной ACP-сессии
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_acp ON sessions(acp_session_id);
  `);

  // миграция для баз, созданных до появления колонки cwd
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'cwd')) {
    db.exec('ALTER TABLE sessions ADD COLUMN cwd TEXT');
  }
  // миграция для баз, созданных до выбора движка: все прежние сессии — Gemini CLI
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'engine')) {
    db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT; UPDATE sessions SET engine = 'gemini' WHERE engine IS NULL;");
  }
  // миграции v1.7: расход по запросам, права сотрудников на движки и модели
  const addColumns = (table, cols) => {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  addColumns('requests', [
    ['model', 'TEXT'],
    ['effort', 'TEXT'],
    ['input_tokens', 'INTEGER'],
    ['output_tokens', 'INTEGER'],
    ['cached_tokens', 'INTEGER'],
    ['thought_tokens', 'INTEGER'],
    ['total_tokens', 'INTEGER'],
    ['cost_usd', 'REAL'],
  ]);
  // engines — JSON-список движков сверх движка по умолчанию; models — JSON {движок: [разрешённые модели]}, нет ключа — все
  addColumns('users', [
    ['engines', 'TEXT'],
    ['models', 'TEXT'],
  ]);
  // v1.19: тему можно убрать из списка тем проекта (Telegram не сообщает боту об удалении темы)
  addColumns('topics', [['hidden', 'INTEGER NOT NULL DEFAULT 0']]);
  // v1.30: вход по ссылке и коду — у GitLab такой токен живёт 2 часа и обновляется токеном обновления
  addColumns('git_accounts', [
    ['refresh_token', 'TEXT'], // токен обновления (есть только у входа по коду)
    ['access_until', 'TEXT'], // до какого времени действует текущий токен (у бессрочного — пусто)
  ]);

  verifySchema(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const q = {
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    listUsers: db.prepare("SELECT * FROM users ORDER BY (status = 'active') DESC, added_at"),
    upsertUser: db.prepare(
      `INSERT INTO users (user_id, username, first_name, level, added_by, added_at, status) VALUES (?,?,?,?,?,?, 'active')
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, level = excluded.level,
       added_by = excluded.added_by, status = 'active', revoked_at = NULL`,
    ),
    setUserLevel: db.prepare('UPDATE users SET level = ? WHERE user_id = ?'),
    touchUser: db.prepare('UPDATE users SET username = ?, first_name = ? WHERE user_id = ?'),
    revokeUser: db.prepare("UPDATE users SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'"),
    createInvite: db.prepare('INSERT INTO invites (code, level, created_by, created_at, expires_at) VALUES (?,?,?,?,?)'),
    useInvite: db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?'),
    getInvite: db.prepare('SELECT * FROM invites WHERE code = ?'),
    getRequest: db.prepare('SELECT * FROM access_requests WHERE user_id = ?'),
    saveRequest: db.prepare(
      `INSERT INTO access_requests (user_id, username, first_name, requested_at, status) VALUES (?,?,?,?, 'pending')
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
       requested_at = excluded.requested_at, status = 'pending', decided_at = NULL`,
    ),
    setRequestStatus: db.prepare('UPDATE access_requests SET status = ?, decided_at = ? WHERE user_id = ?'),
    // сессии пользователя в проекте (одна строка на сессию ACP, даже если её возобновляли несколько раз)
    listSessions: db.prepare(
      `SELECT s.acp_session_id AS acp_id, MAX(COALESCE(s.engine, 'gemini')) AS engine, MAX(r.started_at) AS last_at, COUNT(r.id) AS n,
              (SELECT r2.user_text FROM requests r2 JOIN sessions s2 ON s2.id = r2.session_id
                WHERE s2.acp_session_id = s.acp_session_id ORDER BY r2.id LIMIT 1) AS first_text
         FROM sessions s JOIN requests r ON r.session_id = s.id
        WHERE s.user_id = ? AND lower(s.cwd) = lower(?) AND s.acp_session_id IS NOT NULL
        GROUP BY s.acp_session_id ORDER BY last_at DESC LIMIT ?`,
    ),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    allSettings: db.prepare('SELECT key, value FROM settings'),
    deleteGitAccounts: db.prepare('DELETE FROM git_accounts WHERE user_id = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    startSession: db.prepare('INSERT INTO sessions (acp_session_id, user_id, chat_id, mode, cwd, started_at, engine) VALUES (?,?,?,?,?,?,?)'),
    endSession: db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL'),
    startRequest: db.prepare('INSERT INTO requests (session_id, user_text, started_at) VALUES (?,?,?)'),
    finishRequest: db.prepare(
      `UPDATE requests SET finished_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
       stop_reason = ?, answer = ?, error = ?, model = ?, effort = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
       thought_tokens = ?, total_tokens = ?, cost_usd = ? WHERE id = ?`,
    ),
    unfinishedRequests: db.prepare(
      `SELECT r.id, s.user_id, s.chat_id, r.user_text FROM requests r JOIN sessions s ON s.id = r.session_id
        WHERE r.finished_at IS NULL ORDER BY r.id`,
    ),
    interruptRequests: db.prepare(
      `UPDATE requests SET finished_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
       stop_reason = 'interrupted', error = ? WHERE finished_at IS NULL`,
    ),
    setUserEngines: db.prepare('UPDATE users SET engines = ? WHERE user_id = ?'),
    setUserModels: db.prepare('UPDATE users SET models = ? WHERE user_id = ?'),
    insertTool: db.prepare(
      `INSERT OR IGNORE INTO tool_calls (request_id, tool_call_id, tool, kind, title, description, status, started_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ),
    updateTool: db.prepare(
      `UPDATE tool_calls SET status = COALESCE(?, status), output = COALESCE(?, output),
       title = COALESCE(?, title), description = COALESCE(?, description), finished_at = ?
       WHERE request_id = ? AND tool_call_id = ?`,
    ),
    addPermission: db.prepare('INSERT INTO permissions (request_id, tool_call_id, title, options, asked_at) VALUES (?,?,?,?,?)'),
    answerPermission: db.prepare('UPDATE permissions SET chosen_option = ?, outcome = ?, answered_at = ? WHERE id = ?'),
    cleanupPermissions: db.prepare('DELETE FROM permissions WHERE asked_at < ?'),
    cleanupTools: db.prepare('DELETE FROM tool_calls WHERE started_at < ?'),
    cleanupRequests: db.prepare('DELETE FROM requests WHERE started_at < ?'),
    cleanupSessions: db.prepare('DELETE FROM sessions WHERE started_at < ? AND ended_at IS NOT NULL'),
    // расход по пользователям с момента since: запросы, токены, стоимость (что прислали агенты)
    usageSummary: db.prepare(
      `SELECT s.user_id AS user_id, COUNT(r.id) AS requests, COALESCE(SUM(r.total_tokens), 0) AS tokens, SUM(r.cost_usd) AS cost
         FROM requests r JOIN sessions s ON s.id = r.session_id
        WHERE r.started_at >= ? GROUP BY s.user_id ORDER BY tokens DESC, requests DESC`,
    ),
    getTopic: db.prepare('SELECT * FROM topics WHERE user_id = ? AND thread_id = ?'),
    insertTopic: db.prepare('INSERT OR IGNORE INTO topics (user_id, thread_id, created_at, updated_at) VALUES (?,?,?,?)'),
    updateTopic: db.prepare(
      `UPDATE topics SET name = COALESCE(?, name), named = COALESCE(?, named), project = COALESCE(?, project), engine = COALESCE(?, engine),
       acp_session_id = COALESCE(?, acp_session_id), hidden = COALESCE(?, hidden), updated_at = ? WHERE user_id = ? AND thread_id = ?`,
    ),
    // темы проекта для списка в General: свежие первыми, без убранных из списка
    listTopics: db.prepare(
      'SELECT * FROM topics WHERE user_id = ? AND lower(project) = lower(?) AND hidden = 0 ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    ),
    countTopics: db.prepare('SELECT COUNT(*) AS n FROM topics WHERE user_id = ? AND lower(project) = lower(?) AND hidden = 0'),
    deleteTopic: db.prepare('DELETE FROM topics WHERE user_id = ? AND thread_id = ?'),
    getGitAccount: db.prepare('SELECT * FROM git_accounts WHERE user_id = ? AND host = ?'),
    listGitAccounts: db.prepare('SELECT * FROM git_accounts WHERE user_id = ? ORDER BY added_at'),
    allGitAccounts: db.prepare('SELECT * FROM git_accounts'),
    saveGitAccount: db.prepare(
      `INSERT INTO git_accounts (user_id, host, login, name, email, token, expires_at, added_at, refresh_token, access_until) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, host) DO UPDATE SET login = excluded.login, name = excluded.name, email = excluded.email,
       token = excluded.token, expires_at = excluded.expires_at, added_at = excluded.added_at,
       refresh_token = excluded.refresh_token, access_until = excluded.access_until`,
    ),
    setGitTokens: db.prepare('UPDATE git_accounts SET token = ?, refresh_token = ?, access_until = ? WHERE user_id = ? AND host = ?'),
    deleteGitAccount: db.prepare('DELETE FROM git_accounts WHERE user_id = ? AND host = ?'),
    deleteGitAccountsByHost: db.prepare('DELETE FROM git_accounts WHERE host = ?'),
  };

  // Любая ошибка БД не должна ронять бота — журнал вторичен по отношению к работе. Имя операции добавляет
  // обёртка named: по одному сообщению без имени невозможно понять, какой именно запрос упал.
  const safe = (fn) => fn;
  const named = (methods) =>
    Object.fromEntries(
      Object.entries(methods).map(([name, fn]) => [
        name,
        (...a) => {
          try {
            return fn(...a);
          } catch (e) {
            logError('[db]', name, e.message);
            return null;
          }
        },
      ]),
    );

  return named({
    // --- доступ сотрудников ---
    getUser: safe((id) => q.getUser.get(id) ?? null),
    listUsers: () => safe(() => q.listUsers.all())() ?? [],
    upsertUser: safe((u) => q.upsertUser.run(u.user_id, u.username ?? null, u.first_name ?? null, u.level, u.added_by ?? null, now())),
    setUserLevel: safe((id, level) => q.setUserLevel.run(level, id)),
    touchUser: safe((id, username, firstName) => q.touchUser.run(username ?? null, firstName ?? null, id)),
    revokeUser: safe((id) => {
      const result = q.revokeUser.run(now(), id);
      if (result.changes) q.deleteGitAccounts.run(id);
      return result;
    }),
    createInvite: safe((code, level, createdBy, expiresAt) => q.createInvite.run(code, level, createdBy, now(), expiresAt)),
    /** Гасит приглашение и возвращает его уровень; null — если код неверный, уже использован или просрочен. */
    consumeInvite: safe((code, userId) => {
      const r = q.useInvite.run(userId, now(), code, now());
      return r.changes === 1 ? q.getInvite.get(code).level : null;
    }),
    getRequest: safe((id) => q.getRequest.get(id) ?? null),
    saveRequest: safe((u) => q.saveRequest.run(u.id, u.username ?? null, u.first_name ?? null, now())),
    setRequestStatus: safe((id, status) => q.setRequestStatus.run(status, now(), id)),
    // --- сессии ---
    listSessions: (userId, cwd, limit = 10) => safe(() => q.listSessions.all(userId, cwd, limit))() ?? [],
    /** Расход по пользователям с момента since (ISO): [{user_id, requests, tokens, cost}], cost — null, если агент её не присылал. */
    usageSummary: (since) => safe(() => q.usageSummary.all(since))() ?? [],
    // --- прочее ---
    getSetting: safe((key) => q.getSetting.get(key)?.value ?? null),
    allSettings: safe(() => q.allSettings.all() ?? []),
    setSetting: safe((key, value) => q.setSetting.run(key, value)),
    startSession: safe((acpSessionId, userId, chatId, mode, cwd, engine) =>
      Number(q.startSession.run(acpSessionId, userId, chatId, mode ?? null, cwd ?? null, now(), engine ?? null).lastInsertRowid)),
    endSession: safe((id, reason) => id && q.endSession.run(now(), reason, id)),
    startRequest: safe((sessionId, text) => Number(q.startRequest.run(sessionId, text, now()).lastInsertRowid)),
    /** usage — расход запроса: {model, effort, input, output, cachedRead, thought, total, cost} (что прислал агент). */
    finishRequest: safe((id, { stopReason, answer, error, usage = {} }) => {
      const t = now();
      const n = (v) => (Number.isFinite(v) ? v : null);
      return id && q.finishRequest.run(t, t, stopReason ?? null, answer ?? null, error ?? null, usage.model ?? null, usage.effort ?? null,
        n(usage.input), n(usage.output), n(usage.cachedRead), n(usage.thought), n(usage.total), n(usage.cost), id);
    }),
    /** Запросы, оборванные перезапуском службы: их надо пометить и сообщить пользователям. */
    unfinishedRequests: safe(() => q.unfinishedRequests.all() ?? []),
    interruptRequests: safe((error) => {
      const t = now();
      return q.interruptRequests.run(t, t, error ?? 'bot restarted').changes;
    }),
    setUserEngines: safe((id, list) => q.setUserEngines.run(list?.length ? JSON.stringify(list) : null, id)),
    setUserModels: safe((id, map) => q.setUserModels.run(map && Object.keys(map).length ? JSON.stringify(map) : null, id)),
    toolStarted: safe((requestId, t) =>
      requestId && q.insertTool.run(requestId, t.toolCallId, t.tool, t.kind ?? null, cut(t.title, 2000), cut(t.description, 1000), t.status ?? null, now())),
    toolUpdated: safe((requestId, t) =>
      requestId && q.updateTool.run(t.status ?? null, cut(t.output || null, 4000), cut(t.title || null, 2000), cut(t.description || null, 1000), now(), requestId, t.toolCallId)),
    permissionAsked: safe((requestId, toolCallId, title, options) =>
      Number(q.addPermission.run(requestId, toolCallId ?? null, cut(title, 2000), JSON.stringify(options), now()).lastInsertRowid)),
    permissionAnswered: safe((id, chosen, outcome) => id && q.answerPermission.run(chosen ?? null, outcome, now(), id)),
    cleanupHistory: safe((days) => {
      if (!(Number(days) > 0)) return 0;
      const before = new Date(Date.now() - Number(days) * 86400_000).toISOString();
      db.exec('BEGIN');
      try {
        const removed = q.cleanupPermissions.run(before).changes + q.cleanupTools.run(before).changes +
          q.cleanupRequests.run(before).changes + q.cleanupSessions.run(before).changes;
        db.exec('COMMIT');
        return removed;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }),
    // --- темы ---
    getTopic: safe((userId, threadId) => q.getTopic.get(userId, threadId) ?? null),
    /** Создаёт тему, если её нет, и обновляет переданные поля (name, named, project, engine, acpSessionId); остальные не трогает. */
    saveTopic: safe((userId, threadId, { name, named, project, engine, acpSessionId, hidden } = {}) => {
      const t = now(); // updated_at — последняя активность темы (порядок в списке тем проекта)
      q.insertTopic.run(userId, threadId, t, t);
      const flag = (v) => (v == null ? null : Number(Boolean(v)));
      q.updateTopic.run(name ?? null, flag(named), project ?? null, engine ?? null, acpSessionId ?? null, flag(hidden), t, userId, threadId);
      return q.getTopic.get(userId, threadId);
    }),
    /** Темы пользователя в проекте (кроме убранных из списка), свежие первыми; total — сколько всего. */
    listTopics: (userId, project, limit = 10, offset = 0) =>
      safe(() => ({ items: q.listTopics.all(userId, project, limit, offset), total: q.countTopics.get(userId, project).n }))() ?? { items: [], total: 0 },
    /** Забывает тему (удалённую в Telegram). */
    deleteTopic: safe((userId, threadId) => q.deleteTopic.run(userId, threadId)),
    // --- аккаунты Git ---
    getGitAccount: safe((userId, host) => q.getGitAccount.get(userId, host) ?? null),
    listGitAccounts: (userId) => safe(() => q.listGitAccounts.all(userId))() ?? [],
    /** Аккаунты всех пользователей (для напоминаний об истекающих токенах). */
    allGitAccounts: () => safe(() => q.allGitAccounts.all())() ?? [],
    /**
     * Сохраняет аккаунт сервиса: {host, login, name, email, token, expiresAt, refreshToken, accessUntil}.
     * refreshToken и accessUntil — только у входа по коду с обновляемым токеном. Возвращает true, если записано.
     */
    saveGitAccount: (userId, a) =>
      safe(() => q.saveGitAccount.run(userId, a.host, a.login ?? null, a.name ?? null, a.email ?? null, a.token, a.expiresAt ?? null, now(), a.refreshToken ?? null, a.accessUntil ?? null).changes === 1)() ?? false,
    /** Записывает обновлённую пару токенов аккаунта. */
    setGitTokens: safe((userId, host, { token, refreshToken, accessUntil }) => q.setGitTokens.run(token, refreshToken ?? null, accessUntil ?? null, userId, host)),
    deleteGitAccount: safe((userId, host) => q.deleteGitAccount.run(userId, host)),
    /** Удаляет аккаунты всех пользователей на сервисе (сервис убран администратором). Возвращает число удалённых. */
    deleteGitAccountsByHost: (host) => safe(() => Number(q.deleteGitAccountsByHost.run(host).changes))() ?? 0,
    close: () => db.close(),
  });
}

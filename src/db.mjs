// База работы бота (SQLite): сессии, запросы пользователя, вызовы инструментов, разрешения, ответы модели.
// Используется встроенный в Node модуль node:sqlite — без внешних зависимостей.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const now = () => new Date().toISOString();
const cut = (s, n) => (s == null ? null : String(s).slice(0, n));

export function openDb(path = 'data/bot.db') {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- при WAL безопасно: база не повреждается, после сбоя питания теряются лишь последние записи журнала;
    -- без этого каждая запись (шаги агента, запросы разрешений) ждала сброса на диск
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      acp_session_id TEXT,
      user_id        INTEGER NOT NULL,
      chat_id        INTEGER NOT NULL,
      mode           TEXT,
      cwd            TEXT,
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
      error       TEXT
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
      revoked_at TEXT
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
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (user_id, thread_id)
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
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    startSession: db.prepare('INSERT INTO sessions (acp_session_id, user_id, chat_id, mode, cwd, started_at, engine) VALUES (?,?,?,?,?,?,?)'),
    endSession: db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL'),
    startRequest: db.prepare('INSERT INTO requests (session_id, user_text, started_at) VALUES (?,?,?)'),
    finishRequest: db.prepare(
      `UPDATE requests SET finished_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
       stop_reason = ?, answer = ?, error = ?, model = ?, effort = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
       thought_tokens = ?, total_tokens = ?, cost_usd = ? WHERE id = ?`,
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
  };

  // Любая ошибка БД не должна ронять бота — журнал вторичен по отношению к работе.
  const safe = (fn) => (...a) => {
    try {
      return fn(...a);
    } catch (e) {
      console.error('[db]', e.message);
      return null;
    }
  };

  return {
    // --- доступ сотрудников ---
    getUser: safe((id) => q.getUser.get(id) ?? null),
    listUsers: () => safe(() => q.listUsers.all())() ?? [],
    upsertUser: safe((u) => q.upsertUser.run(u.user_id, u.username ?? null, u.first_name ?? null, u.level, u.added_by ?? null, now())),
    setUserLevel: safe((id, level) => q.setUserLevel.run(level, id)),
    touchUser: safe((id, username, firstName) => q.touchUser.run(username ?? null, firstName ?? null, id)),
    revokeUser: safe((id) => q.revokeUser.run(now(), id)),
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
    // --- прочее ---
    getSetting: safe((key) => q.getSetting.get(key)?.value ?? null),
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
    setUserEngines: safe((id, list) => q.setUserEngines.run(list?.length ? JSON.stringify(list) : null, id)),
    setUserModels: safe((id, map) => q.setUserModels.run(map && Object.keys(map).length ? JSON.stringify(map) : null, id)),
    toolStarted: safe((requestId, t) =>
      requestId && q.insertTool.run(requestId, t.toolCallId, t.tool, t.kind ?? null, cut(t.title, 2000), cut(t.description, 1000), t.status ?? null, now())),
    toolUpdated: safe((requestId, t) =>
      requestId && q.updateTool.run(t.status ?? null, cut(t.output || null, 4000), cut(t.title || null, 2000), cut(t.description || null, 1000), now(), requestId, t.toolCallId)),
    permissionAsked: safe((requestId, toolCallId, title, options) =>
      Number(q.addPermission.run(requestId, toolCallId ?? null, cut(title, 2000), JSON.stringify(options), now()).lastInsertRowid)),
    permissionAnswered: safe((id, chosen, outcome) => id && q.answerPermission.run(chosen ?? null, outcome, now(), id)),
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
    close: () => db.close(),
  };
}

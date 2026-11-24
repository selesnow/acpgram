import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb, SCHEMA_VERSION } from '../src/db.mjs';

const EXPECTED_COLUMNS = {
  sessions: ['id', 'acp_session_id', 'user_id', 'chat_id', 'mode', 'cwd', 'engine', 'started_at', 'ended_at', 'end_reason'],
  settings: ['key', 'value'],
  requests: [
    'id', 'session_id', 'user_text', 'started_at', 'finished_at', 'duration_ms', 'stop_reason', 'answer', 'error',
    'model', 'effort', 'input_tokens', 'output_tokens', 'cached_tokens', 'thought_tokens', 'total_tokens', 'cost_usd',
  ],
  tool_calls: ['id', 'request_id', 'tool_call_id', 'tool', 'kind', 'title', 'description', 'status', 'output', 'started_at', 'finished_at'],
  permissions: ['id', 'request_id', 'tool_call_id', 'title', 'options', 'chosen_option', 'outcome', 'asked_at', 'answered_at'],
  users: ['user_id', 'username', 'first_name', 'level', 'added_by', 'added_at', 'status', 'revoked_at', 'engines', 'models'],
  invites: ['code', 'level', 'created_by', 'created_at', 'expires_at', 'used_by', 'used_at'],
  access_requests: ['user_id', 'username', 'first_name', 'requested_at', 'status', 'decided_at'],
  topics: ['user_id', 'thread_id', 'name', 'named', 'project', 'engine', 'acp_session_id', 'hidden', 'created_at', 'updated_at'],
  git_accounts: ['user_id', 'host', 'login', 'name', 'email', 'token', 'expires_at', 'added_at', 'refresh_token', 'access_until'],
};

const columnNames = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

test('свежая база: все колонки сразу в CREATE TABLE и версия схемы', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-db-new-'));
  const path = join(dir, 'bot.db');
  try {
    const db = openDb(path);
    const raw = new DatabaseSync(path);
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      assert.deepEqual(columnNames(raw, table), columns, table);
    }
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    raw.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('старая база: все недостающие колонки добавляются, данные и версия схемы сохраняются', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-db-old-'));
  const path = join(dir, 'bot.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, acp_session_id TEXT, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
        mode TEXT, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT);
      CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER REFERENCES sessions(id), user_text TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, stop_reason TEXT, answer TEXT, error TEXT);
      CREATE TABLE users (user_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT, level TEXT NOT NULL, added_by INTEGER,
        added_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', revoked_at TEXT);
      CREATE TABLE topics (user_id INTEGER NOT NULL, thread_id INTEGER NOT NULL, name TEXT, named INTEGER NOT NULL DEFAULT 0,
        project TEXT, engine TEXT, acp_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, thread_id));
      CREATE TABLE git_accounts (user_id INTEGER NOT NULL, host TEXT NOT NULL, login TEXT, name TEXT, email TEXT, token TEXT NOT NULL,
        expires_at TEXT, added_at TEXT NOT NULL, PRIMARY KEY (user_id, host));
      INSERT INTO sessions (acp_session_id, user_id, chat_id, started_at) VALUES ('old-1', 7, 7, '2026-11-01T10:00:00Z');
      INSERT INTO requests (session_id, user_text, started_at) VALUES (1, 'старый запрос', '2026-11-01T10:00:00Z');
      INSERT INTO users (user_id, username, level, added_at) VALUES (7, 'tester', 'admin', '2026-11-01T10:00:00Z');
      INSERT INTO topics (user_id, thread_id, name, created_at, updated_at) VALUES (7, 1, 'тема', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z');
      INSERT INTO git_accounts (user_id, host, token, added_at) VALUES (7, 'github', 'old-token', '2026-11-01T10:00:00Z');
      PRAGMA user_version = 7;
    `);
    old.close();

    const db = openDb(path);
    const raw = new DatabaseSync(path);
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      for (const name of columns) assert.ok(columnNames(raw, table).includes(name), `${table}.${name}`);
    }
    assert.equal(raw.prepare('SELECT engine FROM sessions WHERE id = 1').get().engine, 'gemini');
    assert.equal(raw.prepare('SELECT user_text FROM requests WHERE id = 1').get().user_text, 'старый запрос');
    assert.equal(raw.prepare('SELECT level FROM users WHERE user_id = 7').get().level, 'admin');
    assert.equal(raw.prepare('SELECT hidden FROM topics WHERE user_id = 7 AND thread_id = 1').get().hidden, 0);
    assert.equal(raw.prepare("SELECT token FROM git_accounts WHERE user_id = 7 AND host = 'github'").get().token, 'old-token');
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    raw.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('повторное открытие базы идемпотентно: схема и данные не меняются', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-db-repeat-'));
  const path = join(dir, 'bot.db');
  try {
    const first = openDb(path);
    const id = first.startSession('s-1', 1, 1, 'plan', '/p', 'claude');
    first.startRequest(id, 'запрос');
    first.close();

    const second = openDb(path);
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    raw.close();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('миграция: старые сессии без колонки engine становятся сессиями Gemini, новые хранят свой движок', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-db-'));
  const path = join(dir, 'bot.db');
  try {
    // база в формате до выбора движка
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, acp_session_id TEXT, user_id INTEGER NOT NULL, chat_id INTEGER NOT NULL,
                mode TEXT, cwd TEXT, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT);
              INSERT INTO sessions (acp_session_id, user_id, chat_id, cwd, started_at) VALUES ('old-1', 7, 7, '/p', '2026-11-01T10:00:00Z');`);
    old.close();

    const db = openDb(path);
    const sNew = db.startSession('new-1', 7, 7, 'plan', '/p', 'claude');
    db.startRequest(1, 'старый запрос');
    db.startRequest(sNew, 'новый запрос');
    const list = db.listSessions(7, '/p');
    assert.deepEqual(Object.fromEntries(list.map((s) => [s.acp_id, s.engine])), { 'old-1': 'gemini', 'new-1': 'claude' });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupHistory: HISTORY_KEEP_DAYS удаляет старую историю, при 0 не трогает ничего', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-history-'));
  const path = join(dir, 'bot.db');
  const db = openDb(path);
  const old = new Date(Date.now() - 10 * 86400_000).toISOString();
  const raw = new DatabaseSync(path);
  raw.prepare(`INSERT INTO sessions (acp_session_id, user_id, chat_id, mode, cwd, started_at, ended_at)
               VALUES ('old', 1, 1, 'plan', '/p', ?, ?)`).run(old, old);
  raw.prepare("INSERT INTO requests (session_id, user_text, started_at) VALUES (1, 'old', ?)").run(old);
  raw.close();
  try {
    assert.equal(db.cleanupHistory(0), 0);
    assert.ok(db.cleanupHistory(7) >= 2);
    const left = new DatabaseSync(path);
    assert.equal(left.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(left.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
    left.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unfinishedRequests/interruptRequests: запросы после перезапуска помечаются один раз', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-interrupted-'));
  const path = join(dir, 'bot.db');
  const db = openDb(path);
  try {
    const s = db.startSession('restarted', 2, 2, 'plan', '/p', 'gemini');
    const first = db.startRequest(s, 'прерванный');
    const second = db.startRequest(s, 'завершённый');
    db.finishRequest(second, { stopReason: 'done', answer: 'ok', error: null, usage: {} });
    const rows = db.unfinishedRequests();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 2);
    assert.equal(rows[0].chat_id, 2);
    assert.equal(db.interruptRequests('interrupted by bot restart'), 1);
    assert.equal(db.unfinishedRequests().length, 0);
    assert.equal(db.interruptRequests('again'), 0);
    const raw = new DatabaseSync(path);
    const saved = raw.prepare('SELECT stop_reason, error FROM requests WHERE id = ?').get(first);
    raw.close();
    assert.equal(saved.stop_reason, 'interrupted');
    assert.equal(saved.error, 'interrupted by bot restart');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

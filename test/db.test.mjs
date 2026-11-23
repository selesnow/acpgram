import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';

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

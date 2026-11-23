import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'bot-model-allowed-'));
process.env.ACPGRAM_HOME = home;
process.env.ALLOWED_USER_ID = '42';
const { db } = await import('../src/ctx.mjs');
const { modelAllowed } = await import('../src/access.mjs');

test('modelAllowed: фактическая модель проверяется против списка администратора', () => {
  db.upsertUser({ user_id: 5, username: 'u', first_name: 'U', level: 'read', added_by: 42 });
  db.setUserModels(5, { gemini: ['gemini-3.8-flash'] });
  assert.equal(modelAllowed(5, 'gemini', 'gemini-3.8-flash'), true);
  assert.equal(modelAllowed(5, 'gemini', 'gemini-2.5-pro'), false);
  assert.equal(modelAllowed(5, 'claude', 'claude-opus-5-5'), true, 'без ограничения — любая модель');
  assert.equal(modelAllowed(42, 'gemini', 'gemini-2.5-pro'), true, 'администратор не ограничен');
  db.close();
  rmSync(home, { recursive: true, force: true });
});

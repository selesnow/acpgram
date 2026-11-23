import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'bot-warnings-'));
process.env.ACPGRAM_HOME = home;
const { maybeNotifySafety } = await import('../src/warnings.mjs');
const { db } = await import('../src/ctx.mjs');

test('maybeNotifySafety: новые предупреждения уходят один раз и запоминаются', () => {
  const settings = new Map();
  const sent = [];
  const database = {
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => settings.set(key, value),
  };
  const opts = {
    database,
    sandbox: false,
    activeUsers: true,
    adminSandbox: false,
    personalWorkspaces: false,
    aclRisk: true,
    lang: 'ru',
    send: (text) => sent.push(text),
  };
  assert.deepEqual(maybeNotifySafety(opts), ['noSandbox', 'adminNoSandbox', 'broadAcl']);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes('Замечания по безопасности'));
  assert.deepEqual(JSON.parse(settings.get('safetyWarnings')), ['noSandbox', 'adminNoSandbox', 'broadAcl']);
  assert.deepEqual(maybeNotifySafety(opts), []);
  assert.equal(sent.length, 1);
  db.close();
  rmSync(home, { recursive: true, force: true });
});

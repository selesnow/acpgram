import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'bot-admin-sandbox-'));
process.env.ACPGRAM_HOME = home;
process.env.ALLOWED_USER_ID = '42';
process.env.PROJECTS_ROOT = join(home, 'projects');
mkdirSync(process.env.PROJECTS_ROOT, { recursive: true });
process.env.AGENT_SANDBOX = 'bwrap';
delete process.env.ADMIN_SANDBOX;
const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

test('sandboxed: ADMIN_SANDBOX=1 песочнит администратора только в папках внутри корня', async () => {
  const plain = await import('../src/state.mjs?admin=0');
  assert.equal(plain.sandboxed(1), true, 'сотрудник песочнится всегда');
  assert.equal(plain.sandboxed(42, process.env.PROJECTS_ROOT), false, 'администратор по умолчанию без песочницы');

  process.env.ADMIN_SANDBOX = '1';
  const withAdmin = await import('../src/state.mjs?admin=1');
  assert.equal(withAdmin.sandboxed(42, process.env.PROJECTS_ROOT), true);
  assert.equal(withAdmin.sandboxed(42, join(process.env.PROJECTS_ROOT, 'teammate')), true);
  assert.equal(withAdmin.sandboxed(42, join(home, 'outside')), false);
  const { db } = await import('../src/ctx.mjs');
  db.close();
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  rmSync(home, { recursive: true, force: true });
});

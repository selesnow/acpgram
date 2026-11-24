import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'acpgram-gitui-exports-'));
process.env.ACPGRAM_HOME = home;
const ctx = await import('../src/ctx.mjs');
const gitUi = await import('../src/gitUi.mjs');

const EXPECTED = [
  'GIT_WAIT_MS',
  'cleanFailedClone',
  'handleGit',
  'offerGitActions',
  'onGitCallback',
  'onGitInput',
];

after(() => {
  ctx.db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    assert.ok(true);
  }
});

test('gitUi.mjs: все публичные экспорты доступны под прежними именами', () => {
  assert.deepEqual(Object.keys(gitUi).sort(), EXPECTED);
  for (const name of EXPECTED) assert.ok(name in gitUi, name);
});

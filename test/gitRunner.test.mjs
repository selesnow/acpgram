import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-git-runner-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
delete process.env.GIT_COMMAND;
delete process.env.GIT_AGENT_AUTH;
delete process.env.AGENT_SANDBOX;
delete process.env.FAKE_GIT_MODE;

const { db } = await import('../src/ctx.mjs');
const G = await import('../src/git.mjs');
const { setSyncKill } = await import('../src/acp.mjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPid(file, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (pid > 0) return pid;
    }
    await delay(10);
  }
  throw new Error('pid file not created');
}

async function waitDead(pid, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await delay(50);
  }
  return false;
}

after(() => {
  setSyncKill(false);
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('runGit: синхронный сбой spawn превращается в GitError', async () => {
  const saved = process.env.GIT_COMMAND;
  process.env.GIT_COMMAND = join(home, 'bad\0git');
  try {
    await assert.rejects(() => G.runGit(['status'], { cwd: home }), (e) => e instanceof G.GitError && e.message.length > 0);
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMAND;
    else process.env.GIT_COMMAND = saved;
  }
});

test('runGit: ошибка процесса превращается в GitError', async () => {
  const saved = process.env.GIT_COMMAND;
  process.env.GIT_COMMAND = join(home, 'no-such-git-command');
  try {
    await assert.rejects(() => G.runGit(['status'], { cwd: home }), (e) => e instanceof G.GitError && /ENOENT|no such|не найден/i.test(e.message));
  } finally {
    if (saved === undefined) delete process.env.GIT_COMMAND;
    else process.env.GIT_COMMAND = saved;
  }
});

test('runGit: тайм-аут убивает дерево процессов и возвращает ошибку с i18n', async () => {
  const pidFile = join(home, 'runner.pid');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const wrap = { command: process.execPath, args: ['-e', script], env: (e) => e };
  setSyncKill(true);
  try {
    const running = G.runGit(['status'], { cwd: home, wrap, timeoutMs: 1000 });
    const pid = await waitPid(pidFile);
    const error = await running.then(() => null, (e) => e);
    assert.ok(error instanceof G.GitError);
    assert.equal(error.timeout, true);
    assert.deepEqual(error.i18n, { key: 'err.gitTimeout', vars: { cmd: 'status', sec: 1 } });
    assert.equal(await waitDead(pid), true);
  } finally {
    setSyncKill(false);
  }
});

const fakeGit = join(home, 'fake-git.mjs');
writeFileSync(fakeGit, [
  "const args = process.argv.slice(2);",
  "const mode = process.env.FAKE_GIT_MODE || '';",
  "if (args[0] === 'status') {",
  "  if (mode === 'status-fail') { process.stderr.write('status failed\\n'); process.exit(5); }",
  "  process.stdout.write('# branch.head main\\n# branch.upstream origin/main\\n');",
  "} else if (args[0] === 'diff') { process.stderr.write('diff failed\\n'); process.exit(7); }",
  "else if (args[0] === 'ls-tree') { process.stderr.write('list failed\\n'); process.exit(128); }",
  "else if (args[0] === 'rev-parse') { process.exit(mode === 'head' ? 0 : 1); }",
  'else process.exit(1);',
].join('\n'));
const opts = { wrap: { command: process.execPath, args: [fakeGit], env: (e) => e } };

test('unpushedSecrets: сбой status не превращается в «секретов нет»', async () => {
  process.env.FAKE_GIT_MODE = 'status-fail';
  try {
    await assert.rejects(() => G.unpushedSecrets(home, opts), (e) => e instanceof G.GitError && e.code === 5 && /status failed/.test(e.message));
  } finally {
    delete process.env.FAKE_GIT_MODE;
  }
});

test('unpushedSecrets: сбой списка файлов при существующем HEAD перебрасывает ошибку', async () => {
  process.env.FAKE_GIT_MODE = 'head';
  try {
    await assert.rejects(() => G.unpushedSecrets(home, opts), (e) => e instanceof G.GitError && e.code === 128 && /list failed/.test(e.message));
  } finally {
    delete process.env.FAKE_GIT_MODE;
  }
});

test('unpushedSecrets: в репозитории без коммитов секретов нет', async () => {
  assert.deepEqual(await G.unpushedSecrets(home, opts), []);
});

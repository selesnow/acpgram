import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const hasGit = spawnSync('git', ['--version']).status === 0;
const needGit = { skip: hasGit ? false : 'git не установлен' };

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-gitsec-')));
mkdirSync(join(home, 'projects'));
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = join(home, 'projects');
process.env.USER_WORKSPACES = '1';
delete process.env.GITLAB_URL;
delete process.env.GIT_AGENT_AUTH;
delete process.env.AGENT_SANDBOX;
delete process.env.GIT_COMMAND;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.file.allow',
  GIT_CONFIG_VALUE_0: 'always',
});

const ctx = await import('../src/ctx.mjs');
const G = await import('../src/git.mjs');
const Ctx = await import('../src/gitCtx.mjs');
const I = await import('../src/gitInspect.mjs');
const U = await import('../src/gitUi.mjs');
G.setGitAvailable(hasGit);

const env = G.gitEnv({ identity: { name: 'Ann', email: 'a@x.io' } });
const git = (cwd, ...args) => G.runGit(args, { cwd, env });
const account = { login: 'ann', name: 'Ann', email: 'a@x.io', token: 'SECRET-TOKEN-123' };
const configOf = (e) => Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]));

after(() => {
  ctx.db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    assert.ok(true);
  }
});

test('окружение git: без запроса пароля, только https и без секретов агента; вход отдельно для сетевых команд', () => {
  const e = G.gitEnv({ base: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: 'bot-token', OPENROUTER_API_KEY: 'api-key' } });
  assert.equal(e.GIT_ASKPASS, '');
  assert.equal(e.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(e.OPENROUTER_API_KEY, undefined);
  const cfg = configOf(e);
  assert.equal(cfg['protocol.allow'], 'never');
  assert.equal(cfg['protocol.https.allow'], 'always');
  assert.equal(cfg['safe.bareRepository'], 'explicit');
  assert.equal(cfg['credential.helper'], '');

  const st = { userId: 7101, gitBusy: false };
  const local = Ctx.gitOpts(st, home, account);
  const net = Ctx.gitNetOpts(st, home, { host: { id: 'github', web: 'https://github.com', user: 'x', label: 'GitHub' }, account });
  const basic = Buffer.from(`x:${account.token}`).toString('base64');
  assert.deepEqual(local.hide, []);
  assert.equal(Object.values(local.env).some((v) => String(v).includes(account.token)), false);
  assert.ok(Object.values(net.env).some((v) => String(v).includes(basic)));
  assert.equal(Object.values(net.env).some((v) => String(v).includes(account.token)), false);
  assert.ok(net.hide.some((v) => String(v).includes(account.token)));
});

test('assertPlainConfig: отклоняет команды, фильтры, include и отключённую проверку TLS, не показывая значения', needGit, async () => {
  const repo = join(home, 'config-repo');
  mkdirSync(repo);
  await git(repo, 'init', '-q');
  const bad = [
    ['core.sshCommand', 'C:\\secret\\evil.exe'],
    ['filter.evil.clean', 'secret-filter'],
    ['include.path', 'C:\\secret\\evil.conf'],
    ['remote.origin.uploadpack', 'secret-uploadpack'],
    ['http.https://h/.sslVerify', 'false'],
  ];
  for (const [key, value] of bad) {
    await git(repo, 'config', '--local', key, value);
    await assert.rejects(
      () => G.assertPlainConfig(repo, { env }),
      (e) => e instanceof G.GitConfigError && e.keys.includes(key.toLowerCase()) && !e.message.includes(value),
    );
    await git(repo, 'config', '--local', '--unset', key);
  }
  await git(repo, 'config', '--local', 'filter.lfs.process', 'git-lfs filter-process');
  await G.assertPlainConfig(repo, { env });
});

test('сетевые команды и коммит не выполняются с опасной локальной конфигурацией', needGit, async () => {
  const bare = join(home, 'remote.git');
  const repo = join(home, 'work');
  await git(home, 'init', '-q', '--bare', '-b', 'main', bare);
  await G.cloneRepo(bare, 'work', { cwd: home, env });
  await git(repo, 'config', '--local', 'core.sshCommand', 'evil-command');
  await assert.rejects(() => G.fetchRepo(repo, { env }), G.GitConfigError);
  await assert.rejects(() => G.pullRepo(repo, { env }), G.GitConfigError);
  await assert.rejects(() => G.pushRepo(repo, { env }), G.GitConfigError);
  await assert.rejects(() => G.commitAll(repo, 'message', { env }), G.GitConfigError);
  await assert.rejects(() => I.switchBranch(repo, { name: 'main', local: true }, { env }), G.GitConfigError);
  await assert.rejects(() => I.createBranch(repo, 'feature', { env }), G.GitConfigError);
});

test('одна блокировка git на репозиторий между разными диалогами', () => {
  const a = { userId: 7201, gitBusy: false };
  const b = { userId: 7202, gitBusy: false };
  const lock = Ctx.acquireGitLock(a, join(home, 'work'));
  assert.ok(lock);
  assert.equal(a.gitBusy, true);
  assert.equal(Ctx.acquireGitLock(b, join(home, 'work')), null);
  assert.equal(b.gitBusy, false);
  Ctx.releaseGitLock(a, lock);
  assert.equal(a.gitBusy, false);
  const again = Ctx.acquireGitLock(b, join(home, 'work'));
  assert.ok(again);
  Ctx.releaseGitLock(b, again);
  assert.equal(b.gitBusy, false);
});

test('withGitLock: сериализует операции и возвращает GIT_BUSY без вызова функции', async () => {
  const a = { userId: 7401, gitBusy: false };
  const b = { userId: 7402, gitBusy: false };
  const dir = join(home, 'with-lock');
  let allowFirst;
  const gate = new Promise((resolve) => { allowFirst = resolve; });
  let secondCalls = 0;
  const first = Ctx.withGitLock(a, async () => {
    await gate;
    return 'first';
  }, dir);
  const second = Ctx.withGitLock(b, async () => {
    secondCalls += 1;
    return 'second';
  }, dir);
  assert.equal(await second, Ctx.GIT_BUSY);
  assert.equal(secondCalls, 0);
  assert.equal(b.gitBusy, false);
  allowFirst();
  assert.equal(await first, 'first');
  assert.equal(a.gitBusy, false);
  assert.equal(await Ctx.withGitLock(b, async () => 'ok', dir), 'ok');
  assert.equal(b.gitBusy, false);
});

test('withGitLock: освобождает блокировку при ошибке и сохраняет результат', async () => {
  const st = { userId: 7403, gitBusy: false };
  const dir = join(home, 'with-lock-error');
  const error = new Error('сбой операции');
  await assert.rejects(Ctx.withGitLock(st, async () => { throw error; }, dir), error);
  assert.equal(st.gitBusy, false);
  assert.equal(await Ctx.withGitLock(st, async () => 42, dir), 42);
  assert.equal(st.gitBusy, false);
  assert.equal(await Ctx.withGitLock(st, async () => undefined, dir), undefined);
  assert.equal(st.gitBusy, false);
});

test('после неудачного клона удаляется только созданная папка внутри разрешённого корня', () => {
  const base = join(home, 'clone-base');
  const target = join(base, 'partial');
  const outside = join(home, 'outside');
  mkdirSync(target, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(target, 'file.txt'), 'x');
  U.cleanFailedClone({ userId: 7301 }, outside, base);
  assert.ok(existsSync(outside));
  U.cleanFailedClone({ userId: 7301 }, target, base);
  assert.equal(existsSync(target), false);
});

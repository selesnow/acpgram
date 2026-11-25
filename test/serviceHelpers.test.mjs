import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setCliLang, tc } from '../src/cli-i18n.mjs';
import { LOGON_FAILURE, applyNssmCommands, chooseWindowsAccount, fail, prepareWindowsInstall, startInstalledService, winPrecheck } from '../src/service.mjs';

setCliLang('ru');

const SERVICE = fileURLToPath(new URL('../src/service.mjs', import.meta.url));

const fakeService = ({ queryStatus = 0, nssmStatus = 0, state = 'RUNNING', queryOutput = '', nssmOutput = '', deleteFlag = false } = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-service-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const exe of ['nssm.exe', 'sc.exe', 'net.exe', 'reg.exe']) {
    try {
      linkSync(process.execPath, join(bin, exe));
    } catch {
      copyFileSync(process.execPath, join(bin, exe));
    }
  }
  const log = join(tmp, 'calls.log');
  const scripts = {
    status: String.raw`
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_LOG, 'nssm status ' + process.argv.slice(2).join(' ') + '\n');
process.stdout.write(process.env.FAKE_NSSM_OUTPUT || 'STATUS OK');
process.exitCode = Number(process.env.FAKE_NSSM_STATUS || 0);
`,
    query: String.raw`
const { appendFileSync, existsSync } = require('node:fs');
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, 'query ' + a.join(' ') + '\n');
if (a.some((x) => x.startsWith('HKLM\\'))) {
  if (a.includes('DeleteFlag') && process.env.FAKE_DELETE_FLAG === '1') {
    process.stdout.write('DeleteFlag REG_DWORD 0x1');
    process.exitCode = 0;
  } else if (a.some((x) => x.includes('CodePage'))) {
    process.stdout.write('OEMCP REG_SZ 866');
    process.exitCode = 0;
  } else process.exitCode = 1;
} else if (existsSync(process.env.FAKE_REMOVED)) {
  process.exitCode = 1060;
} else if (existsSync(process.env.FAKE_STOPPED) || process.env.FAKE_STATE === 'STOPPED') {
  process.stdout.write('STATE : 1 STOPPED');
  process.exitCode = Number(process.env.FAKE_QUERY_STATUS === '1060' ? 1060 : 0);
} else {
  process.stdout.write(process.env.FAKE_QUERY_OUTPUT || 'STATE : 4 RUNNING');
  process.exitCode = Number(process.env.FAKE_QUERY_STATUS || 0);
}
`,
    stop: String.raw`
const { appendFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_LOG, 'nssm stop ' + process.argv.slice(2).join(' ') + '\n');
writeFileSync(process.env.FAKE_STOPPED, '1');
`,
    remove: String.raw`
const { appendFileSync, writeFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_LOG, 'nssm remove ' + process.argv.slice(2).join(' ') + '\n');
writeFileSync(process.env.FAKE_REMOVED, '1');
`,
    session: String.raw`
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.FAKE_LOG, 'net session\n');
`,
  };
  for (const [name, code] of Object.entries(scripts)) writeFileSync(join(tmp, name), code);
  const env = {
    ...process.env,
    PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    ACPGRAM_HOME: tmp,
    ACPGRAM_LANG: 'ru',
    NSSM_PATH: join(bin, 'nssm.exe'),
    FAKE_LOG: log,
    FAKE_STOPPED: join(tmp, 'stopped.flag'),
    FAKE_REMOVED: join(tmp, 'removed.flag'),
    FAKE_QUERY_STATUS: String(queryStatus),
    FAKE_NSSM_STATUS: String(nssmStatus),
    FAKE_STATE: state,
    FAKE_QUERY_OUTPUT: queryOutput,
    FAKE_NSSM_OUTPUT: nssmOutput,
    FAKE_DELETE_FLAG: deleteFlag ? '1' : '0',
  };
  return {
    tmp,
    env,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    run: (...args) => spawnSync(process.execPath, [SERVICE, ...args], { cwd: tmp, encoding: 'utf8', timeout: 20_000, env }),
  };
};

test('fail: печатает сообщение и возвращает ok=false', () => {
  const lines = [];
  assert.deepEqual(fail('ошибка', (s) => lines.push(s)), { ok: false });
  assert.deepEqual(lines, ['ошибка']);
});

test('winPrecheck: общие проверки Windows без изменения текстов и порядка', () => {
  let lines = [];
  assert.deepEqual(winPrecheck({ findNssm: () => null, log: (s) => lines.push(s) }), { ok: false });
  assert.deepEqual(lines, [tc('svc.noNssm')]);

  lines = [];
  assert.deepEqual(winPrecheck({ install: true, findNssm: () => null, log: (s) => lines.push(s) }), { ok: false });
  assert.deepEqual(lines, [tc('svc.noNssmFull')]);

  lines = [];
  assert.deepEqual(winPrecheck({ findNssm: () => 'nssm', isAdmin: () => false, log: (s) => lines.push(s) }), { ok: false });
  assert.deepEqual(lines, [tc('svc.needAdmin')]);

  lines = [];
  assert.deepEqual(winPrecheck({ install: true, findNssm: () => 'nssm', isAdmin: () => false, log: (s) => lines.push(s) }), { ok: false });
  assert.deepEqual(lines, [tc('svc.needAdminInstall')]);

  const pre = winPrecheck({ dry: true, findNssm: () => 'nssm', isAdmin: () => { throw new Error('admin не нужен'); } });
  assert.deepEqual(pre, { ok: true, nssm: 'nssm' });
});

test('prepareWindowsInstall: dry-run не трогает службу, существующую перезапускает по вопросу', async () => {
  const dry = await prepareWindowsInstall({
    nssm: 'nssm', name: 'svc', dry: true,
    probe: () => { throw new Error('probe не нужен'); },
  });
  assert.deepEqual(dry, { done: false });

  const lines = [];
  const result = await prepareWindowsInstall({
    nssm: 'nssm', name: 'svc', dry: false,
    prompt: { yes: async () => true },
    probe: () => ({ exists: true, state: 'RUNNING' }),
    marked: () => false,
    remove: async () => { throw new Error('удаление не нужно'); },
    restart: async () => ({ ok: true }),
    log: (s) => lines.push(s),
  });
  assert.deepEqual(result, { done: true, result: { ok: true, installed: true } });
  assert.deepEqual(lines, []);
});

test('prepareWindowsInstall: отказ от переустановки сохраняет installed=true', async () => {
  const lines = [];
  const result = await prepareWindowsInstall({
    nssm: 'nssm', name: 'svc', dry: false,
    prompt: { yes: async () => false },
    probe: () => ({ exists: true, state: 'STOPPED' }),
    marked: () => false,
    remove: async () => { throw new Error('удаление не нужно'); },
    restart: async () => { throw new Error('перезапуск не нужен'); },
    log: (s) => lines.push(s),
  });
  assert.deepEqual(result, { done: true, result: { ok: false, installed: true } });
  assert.deepEqual(lines, [tc('svc.leaveAsIs')]);
});

test('chooseWindowsAccount: LocalSystem только с allowSystem, пароль спрашивается до установки', async () => {
  let lines = [];
  assert.deepEqual(await chooseWindowsAccount({ prompt: null, allowSystem: false, user: '.\\u', log: (s) => lines.push(s) }), {
    done: true, result: { ok: false },
  });
  assert.deepEqual(lines, [tc('svc.needTty')]);

  lines = [];
  assert.deepEqual(await chooseWindowsAccount({ prompt: null, allowSystem: true, user: '.\\u', log: (s) => lines.push(s) }), {
    done: false, account: null,
  });
  assert.deepEqual(lines, [tc('svc.localSystem')]);

  lines = [];
  const account = await chooseWindowsAccount({
    prompt: { yes: async () => true, secret: async () => 'p@ss' },
    allowSystem: false,
    user: '.\\u',
    log: (s) => lines.push(s),
  });
  assert.deepEqual(account, { done: false, account: { user: '.\\u', password: 'p@ss' } });
  assert.equal(lines[0], tc('svc.passwordNote'));
});

test('applyNssmCommands: неудачная запись учётной записи откатывает установку', () => {
  const calls = [];
  const lines = [];
  const result = applyNssmCommands({
    nssm: 'nssm', name: 'svc', node: 'node', account: { user: '.\\u', password: 'p' }, dry: false,
    commands: () => [['install', 'svc', 'node'], ['set', 'svc', 'ObjectName', '.\\u', 'p']],
    run: (exe, args) => (calls.push([exe, args]), { status: args[0] === 'install' ? 0 : 1, stderr: 'bad', stdout: '' }),
    log: (s) => lines.push(s),
  });
  assert.deepEqual(result, { done: true, result: { ok: false } });
  assert.ok(calls.some(([, args]) => args[0] === 'remove'));
  assert.ok(lines.includes(tc('svc.checkPassword')));
});

test('startInstalledService: dry-run, успешный запуск и повтор пароля после 1069', async () => {
  const dryCalls = [];
  assert.deepEqual(await startInstalledService({
    nssm: 'nssm', name: 'svc', dry: true,
    run: (...args) => (dryCalls.push(args), { status: 0 }),
  }), { ok: true });
  assert.deepEqual(dryCalls, [['nssm', ['start', 'svc'], { dry: true }]]);

  const started = await startInstalledService({
    nssm: 'nssm', name: 'svc', dry: false, account: null, prompt: null,
    start: async () => ({ running: true, state: 'RUNNING', code: 0 }),
  });
  assert.deepEqual(started, { ok: true, installed: true });

  let attempts = 0;
  const retried = await startInstalledService({
    nssm: 'nssm', name: 'svc', dry: false,
    account: { user: '.\\u', password: 'old' },
    prompt: { secret: async () => 'new' },
    run: () => ({ status: 0 }),
    start: async () => (++attempts === 1 ? { running: false, state: 'STOPPED', code: LOGON_FAILURE } : { running: true, state: 'RUNNING', code: 0 }),
  });
  assert.deepEqual(retried, { ok: true, installed: true });
  assert.equal(attempts, 2);
});

test('service.mjs CLI: stop --dry-run не запускает команды и учитывает --name', { skip: process.platform !== 'win32' && 'Windows-only: проверяется nssm/sc через поддельные exe' }, () => {
  const fake = fakeService();
  try {
    const r = fake.run('stop', '--name', 'dry-svc', '--dry-run');
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /nssm\.exe stop dry-svc/);
    assert.ok(!r.stdout.includes(tc('svc.stopDone', { name: 'dry-svc' })));
    assert.equal(fake.calls(), '');
  } finally {
    rmSync(fake.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('service.mjs CLI: stop останавливает службу и не трогает уже остановленную', { skip: process.platform !== 'win32' && 'Windows-only: проверяется nssm/sc через поддельные exe' }, () => {
  const running = fakeService();
  const stopped = fakeService({ state: 'STOPPED' });
  try {
    const a = running.run('stop', '--name', 'run-svc');
    assert.equal(a.status, 0, `${a.stderr}\n${a.stdout}`);
    assert.ok(a.stdout.includes(tc('svc.stopping', { name: 'run-svc' })));
    assert.ok(a.stdout.includes(tc('svc.stopDone', { name: 'run-svc' })));
    assert.match(running.calls(), /nssm stop run-svc/);

    const b = stopped.run('stop', '--name', 'idle-svc');
    assert.equal(b.status, 0, `${b.stderr}\n${b.stdout}`);
    assert.ok(b.stdout.includes(tc('svc.alreadyStopped', { name: 'idle-svc' })));
    assert.doesNotMatch(stopped.calls(), /nssm stop/);
  } finally {
    rmSync(running.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(stopped.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('service.mjs CLI: stop неизвестной службы возвращает ok=false', { skip: process.platform !== 'win32' && 'Windows-only: проверяется nssm/sc через поддельные exe' }, () => {
  const fake = fakeService({ queryStatus: 1060 });
  try {
    const r = fake.run('stop', '--name', 'ghost-svc');
    assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
    assert.ok(r.stdout.includes(tc('svc.notInstalled', { name: 'ghost-svc' })));
    assert.doesNotMatch(fake.calls(), /nssm stop/);
  } finally {
    rmSync(fake.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('service.mjs CLI: uninstall удаляет службу и пропускает отсутствующую', { skip: process.platform !== 'win32' && 'Windows-only: проверяется nssm/sc через поддельные exe' }, () => {
  const installed = fakeService({ state: 'STOPPED' });
  const absent = fakeService({ queryStatus: 1060 });
  try {
    const a = installed.run('uninstall', '--name', 'del-svc');
    assert.equal(a.status, 0, `${a.stderr}\n${a.stdout}`);
    assert.match(a.stdout, /nssm\.exe remove del-svc confirm/);
    assert.ok(a.stdout.includes(tc('svc.removed', { name: 'del-svc' })));
    assert.match(installed.calls(), /nssm remove del-svc confirm/);

    const b = absent.run('uninstall', '--name', 'ghost-svc');
    assert.equal(b.status, 0, `${b.stderr}\n${b.stdout}`);
    assert.doesNotMatch(absent.calls(), /nssm remove/);
  } finally {
    rmSync(installed.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(absent.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('service.mjs CLI: status передаёт код nssm в код выхода и предупреждает об удалении', { skip: process.platform !== 'win32' && 'Windows-only: проверяется nssm/sc через поддельные exe' }, () => {
  const marked = fakeService({ nssmOutput: 'SERVICE_RUNNING', deleteFlag: true });
  const failed = fakeService({ nssmStatus: 7, nssmOutput: 'SERVICE_STOPPED' });
  try {
    const a = marked.run('status', '--name', 'marked-svc');
    assert.equal(a.status, 0, `${a.stderr}\n${a.stdout}`);
    assert.match(a.stdout, /SERVICE_RUNNING/);
    assert.ok(a.stdout.includes(tc('svc.marked', { name: 'marked-svc' })));
    assert.match(marked.calls(), /nssm status marked-svc/);

    const b = failed.run('status', '--name', 'bad-svc');
    assert.equal(b.status, 1, `${b.stderr}\n${b.stdout}`);
    assert.match(b.stdout, /SERVICE_STOPPED/);
    assert.match(failed.calls(), /nssm status bad-svc/);
  } finally {
    rmSync(marked.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(failed.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('service.mjs CLI: неизвестная команда печатает usage и возвращает ok=false', () => {
  const r = spawnSync(process.execPath, [SERVICE, 'bogus'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ACPGRAM_LANG: 'ru' } });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.ok(r.stdout.includes(tc('svc.usage')));
});

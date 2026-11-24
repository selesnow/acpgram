import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setCliLang, tc } from '../src/cli-i18n.mjs';
import { LOGON_FAILURE, applyNssmCommands, chooseWindowsAccount, fail, prepareWindowsInstall, startInstalledService, winPrecheck } from '../src/service.mjs';

setCliLang('ru');

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

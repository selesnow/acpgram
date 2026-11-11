import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { envValue, pickAdmin, readEnvFile, serializeEnv, writeEnvFile } from '../src/setup.mjs';
import { launchdPlist, nssmCommands, systemdUnit, windowsAccount } from '../src/service.mjs';

test('serializeEnv: порядок, комментарии, прочие ранее заданные, пустые не пишутся; Node читает обратно то же', () => {
  const values = {
    ANIMATED_ICONS: '0',
    TELEGRAM_BOT_TOKEN: '123:ABC',
    ALLOWED_USER_ID: '42',
    PROJECTS_ROOT: 'C:\\Program Files\\my projects',
    DEFAULT_ENGINE: 'claude',
    CLAUDE_COMMAND: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude-agent-acp.cmd',
    GEMINI_API_KEY: '',
    ANTHROPIC_API_KEY: 'sk-ant-x#y',
  };
  const text = serializeEnv(values, { date: '2026-11-11' });
  const lines = text.split('\n');
  assert.ok(lines[0].includes('мастером настройки'));
  // основные — по порядку, затем «прочие»
  const keys = lines.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0]);
  assert.deepEqual(keys, ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_ID', 'PROJECTS_ROOT', 'DEFAULT_ENGINE', 'CLAUDE_COMMAND', 'ANTHROPIC_API_KEY', 'ANIMATED_ICONS']);
  assert.ok(!text.includes('GEMINI_API_KEY='), 'пустое значение не пишется');
  // главное: Node прочитает ровно те же значения (пути с пробелами и обратными слешами, # в ключе)
  const back = parseEnv(text);
  for (const k of keys) assert.equal(back[k], values[k], k);
});

test('envValue: кавычки только когда нужны, двойные — никогда (в них Node раскрывает \\n), перенос строки запрещён', () => {
  assert.equal(envValue('abc'), 'abc');
  assert.equal(envValue('C:\\a b\\c'), 'C:\\a b\\c');
  assert.equal(envValue('a#b'), "'a#b'");
  assert.equal(envValue(' lead'), "' lead'");
  assert.equal(envValue("it's#"), "`it's#`");
  assert.throws(() => envValue('a\nb'));
  assert.throws(() => envValue("#'`"), /нельзя записать/);
  // путь пользователя с апострофом: раньше становился "…" и Node превращал \npm в перенос строки
  const oneil = "C:\\Users\\O'Neil\\AppData\\Roaming\\npm\\claude-agent-acp.cmd";
  assert.equal(envValue(oneil), oneil, 'апостроф в середине — без кавычек');
  for (const v of ['a#b', ' lead', "it's#", 'x"y', oneil, "C:\\new'dir", "'quoted'", '"dq"', '`bt`', 'C:\\x\\n#y', 'a=b=c', 'tab\there']) {
    assert.equal(parseEnv(`K=${envValue(v)}`).K, v, v);
  }
});

test('writeEnvFile / readEnvFile: прежний .env — в data/.env.bak, права 0600 у обоих', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  const path = join(dir, '.env');
  try {
    writeFileSync(path, 'TELEGRAM_BOT_TOKEN=old\nCUSTOM=1\n', { mode: 0o644 }); // как после cp .env.example .env
    const env = readEnvFile(path);
    assert.deepEqual(env, { TELEGRAM_BOT_TOKEN: 'old', CUSTOM: '1' });
    const backup = join(dir, 'data', '.env.bak');
    writeEnvFile({ ...env, TELEGRAM_BOT_TOKEN: 'new', ALLOWED_USER_ID: '7' }, path, backup);
    assert.deepEqual(readEnvFile(path), { TELEGRAM_BOT_TOKEN: 'new', ALLOWED_USER_ID: '7', CUSTOM: '1' }, 'ручная настройка не потерялась');
    assert.equal(readFileSync(backup, 'utf8'), 'TELEGRAM_BOT_TOKEN=old\nCUSTOM=1\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600, '.env только для владельца, даже если был 0644');
      assert.equal(statSync(backup).mode & 0o777, 0o600, 'копия тоже');
    }
    assert.deepEqual(readEnvFile(join(dir, 'нет')), {});
    // значение, которое нельзя записать, — ошибка до изменения файлов
    const before = readFileSync(path, 'utf8');
    assert.throws(() => writeEnvFile({ ...env, X: "#'`" }, path, backup));
    assert.equal(readFileSync(path, 'utf8'), before, '.env не тронут');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pickAdmin: автор первого личного сообщения, не бот и не группа', () => {
  const upd = (chatType, from) => ({ update_id: 1, message: { chat: { type: chatType }, from } });
  assert.equal(pickAdmin([]), null);
  assert.equal(pickAdmin([upd('group', { id: 1 })]), null);
  assert.equal(pickAdmin([upd('private', { id: 2, is_bot: true })]), null);
  assert.deepEqual(pickAdmin([upd('group', { id: 1 }), upd('private', { id: 3, username: 'me' })]), { id: 3, username: 'me' });
  assert.equal(pickAdmin([{ update_id: 1, callback_query: {} }]), null);
});

test('main.mjs: process.loadEnvFile не перезаписывает переменные окружения (служба, Docker важнее .env)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loadenv-'));
  try {
    const f = join(dir, '.env');
    writeFileSync(f, 'A=from-file\nB=from-file\n');
    const r = spawnSync(process.execPath, ['-e', `process.loadEnvFile(${JSON.stringify(f)}); console.log(process.env.A + ',' + process.env.B)`], {
      env: { ...process.env, A: 'from-env', B: undefined },
      encoding: 'utf8',
    });
    assert.equal(r.stdout.trim(), 'from-env,from-file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('systemdUnit: ExecStart с кавычками для путей с пробелами, перезапуск, PATH пользователя', () => {
  const u = systemdUnit({ node: '/usr/bin/node', main: '/opt/my bot/src/main.mjs', dir: '/opt/my bot', path: '/home/u/.npm/bin:/usr/bin', description: 'D' });
  assert.ok(u.includes('ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning "/opt/my bot/src/main.mjs"'), u);
  assert.ok(u.includes('WorkingDirectory=/opt/my bot'));
  assert.ok(u.includes('Environment=PATH=/home/u/.npm/bin:/usr/bin'));
  assert.ok(u.includes('Restart=on-failure') && u.includes('KillMode=mixed') && u.includes('WantedBy=default.target'));
});

test('launchdPlist: аргументы и пути экранированы, KeepAlive при сбое, лог в data/service.log', () => {
  const p = launchdPlist({ node: '/usr/local/bin/node', main: '/Users/u/a&b/src/main.mjs', dir: '/Users/u/a&b', path: '/usr/bin', label: 'io.test' });
  assert.ok(p.includes('<string>/Users/u/a&amp;b/src/main.mjs</string>'));
  assert.ok(p.includes('<key>Label</key><string>io.test</string>'));
  assert.ok(p.includes('<key>SuccessfulExit</key><false/>'));
  assert.ok(p.includes('/Users/u/a&amp;b/data/service.log'));
  assert.ok(!p.includes('a&b'), 'сырой & не попал в XML');
});

test('nssmCommands: программа отдельно, аргументы в кавычках, перезапуск, ротация лога, учётная запись', () => {
  const cmds = nssmCommands({ name: 'svc', node: 'C:\\node\\node.exe', main: 'C:\\my bot (dev)\\src\\main.mjs', dir: 'C:\\my bot (dev)', account: { user: '.\\u', password: 'p@ss' } });
  assert.deepEqual(cmds[0], ['install', 'svc', 'C:\\node\\node.exe']);
  assert.deepEqual(cmds[1], ['set', 'svc', 'AppParameters', '--disable-warning=ExperimentalWarning "C:\\my bot (dev)\\src\\main.mjs"']);
  const byKey = Object.fromEntries(cmds.filter((c) => c[0] === 'set').map((c) => [c[2], c.slice(3)]));
  assert.deepEqual(byKey.AppDirectory, ['C:\\my bot (dev)']);
  assert.deepEqual(byKey.AppExit, ['Default', 'Restart']);
  assert.deepEqual(byKey.Start, ['SERVICE_AUTO_START']);
  assert.ok(byKey.AppStdout[0].endsWith('service.log') && byKey.AppRotateFiles[0] === '1');
  assert.deepEqual(byKey.ObjectName, ['.\\u', 'p@ss']);
  assert.ok(!nssmCommands({ name: 'svc', node: 'n' }).some((c) => c[2] === 'ObjectName'), 'без учётной записи — LocalSystem');
});

test('systemdUnit: «%» и «$» в путях экранируются (спецификаторы и подстановка systemd)', () => {
  const u = systemdUnit({ node: '/usr/bin/node', main: '/home/u/100%/$HOME/src/main.mjs', dir: '/home/u/100%', path: '/a%b:/usr/bin', description: 'D' });
  assert.ok(u.includes('WorkingDirectory=/home/u/100%%'), u);
  assert.ok(u.includes('/home/u/100%%/$$HOME/src/main.mjs'), u);
  assert.ok(u.includes('Environment=PATH=/a%%b:/usr/bin'), u);
});

test('windowsAccount: локальная учётная запись — «.\\user», доменная — «DOMAIN\\user»', () => {
  assert.equal(windowsAccount({ USERDOMAIN: 'SRV1', COMPUTERNAME: 'SRV1' }, 'jdoe'), String.raw`.\jdoe`);
  assert.equal(windowsAccount({ USERDOMAIN: 'srv1', COMPUTERNAME: 'SRV1' }, 'jdoe'), String.raw`.\jdoe`, 'регистр не важен');
  assert.equal(windowsAccount({ USERDOMAIN: 'CORP', COMPUTERNAME: 'SRV1' }, 'jdoe'), String.raw`CORP\jdoe`);
  assert.equal(windowsAccount({}, 'jdoe'), String.raw`.\jdoe`);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { ENV_PATH, resolveHomeDir } from '../src/app.mjs';
import { homedir } from 'node:os';
import { applySetupDefaults, copyLegacyDb, envValue, findLegacyHome, legacyHomeDirs, pickAdmin, readEnvFile, globalBinDir, npmCommand, opencodeKeysToAsk, sendTestMessage, serializeEnv, setupAdmin, setupApiKeys, setupToken, setupWorkspaces, startSetupService, suggestDefaultEngine, writeEnvFile } from '../src/setup.mjs';
import { LOGON_FAILURE, applyNssmCommands, chooseWindowsAccount, findNssm, launchdPlist, nssmCommands, prepareWindowsInstall, startInstalledService, systemdUnit, winMessage, windowsAccount } from '../src/service.mjs';
import { serviceErrorCode, serviceState } from '../src/winsvc.mjs';
import { parseVersion, versionAtLeast } from '../src/engines.mjs';
import { setCliLang, tc } from '../src/cli-i18n.mjs';

const captureConsole = async (fn) => {
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join('\n');
};

const quiet = async (fn) => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
};

setCliLang('ru'); // тесты проверяют русские тексты; язык определения — в cli-i18n.test.mjs

test('serializeEnv: порядок, комментарии, прочие ранее заданные, пустые не пишутся; Node читает обратно то же', () => {
  const values = {
    ANIMATED_ICONS: '0',
    TELEGRAM_BOT_TOKEN: '123:ABC',
    ALLOWED_USER_ID: '42',
    PROJECTS_ROOT: 'C:\\Program Files\\my projects',
    GIT_AGENT_AUTH: '1',
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
  assert.deepEqual(keys, ['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_ID', 'PROJECTS_ROOT', 'GIT_AGENT_AUTH', 'DEFAULT_ENGINE', 'CLAUDE_COMMAND', 'ANTHROPIC_API_KEY', 'ANIMATED_ICONS']);
  assert.ok(!text.includes('GEMINI_API_KEY='), 'пустое значение не пишется');
  // главное: Node прочитает ровно те же значения (пути с пробелами и обратными слешами, # в ключе)
  const back = parseEnv(text);
  for (const k of keys) assert.equal(back[k], values[k], k);
});

test('applySetupDefaults: GIT_AGENT_AUTH=1 для новых установок, явный 0 сохраняется', () => {
  assert.equal(applySetupDefaults({}).GIT_AGENT_AUTH, '1');
  assert.equal(applySetupDefaults({ GIT_AGENT_AUTH: '' }).GIT_AGENT_AUTH, '1');
  assert.equal(applySetupDefaults({ GIT_AGENT_AUTH: '0' }).GIT_AGENT_AUTH, '0');
  assert.equal(applySetupDefaults({ GIT_AGENT_AUTH: '1' }).GIT_AGENT_AUTH, '1');
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
  assert.deepEqual(byKey.AppRotateOnline, ['0'], 'онлайн-ротация (чтение вывода через pipe) подвешивает nssm.exe при остановке');
  assert.deepEqual(byKey.ObjectName, ['.\\u', 'p@ss']);
  assert.ok(!nssmCommands({ name: 'svc', node: 'n' }).some((c) => c[2] === 'ObjectName'), 'без учётной записи — LocalSystem');
});

test('findNssm: NSSM_PATH, затем bin каталога установки, потом PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acpgram-nssm-'));
  try {
    const home = join(dir, 'home');
    const own = join(home, 'bin', 'nssm.exe');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(own, '');
    const pathDir = join(dir, 'path');
    mkdirSync(pathDir);
    const fromPath = join(pathDir, 'nssm.exe');
    writeFileSync(fromPath, '');
    const custom = join(dir, 'custom.exe');
    writeFileSync(custom, '');
    const env = { PATH: pathDir };

    assert.equal(findNssm({ env, homeDir: home, extra: [] }), own, 'приватный nssm из каталога установки важнее PATH');
    assert.equal(findNssm({ env: { ...env, NSSM_PATH: custom }, homeDir: home, extra: [] }), custom, 'явный путь важнее всего');
    rmSync(own);
    assert.equal(findNssm({ env, homeDir: home, extra: [] }), fromPath, 'без приватной копии — поиск по PATH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('serviceErrorCode: код ошибки запуска службы из вывода sc.exe на любом языке Windows', () => {
  assert.equal(serviceErrorCode('[SC] StartService FAILED 1069:\r\n\r\nThe service did not start due to a logon failure.'), LOGON_FAILURE);
  assert.equal(serviceErrorCode('[SC] StartService: ОШИБКА 1069:\r\n\r\nСлужба не запущена из-за ошибки входа в систему.'), 1069);
  assert.equal(serviceErrorCode('[SC] StartService FAILED 1056:\r\n\r\nAn instance of the service is already running.'), 1056);
  assert.equal(serviceErrorCode('        STATE              : 1  STOPPED\r\n        WIN32_EXIT_CODE    : 1077  (0x435)'), 1077);
  assert.equal(serviceErrorCode('        WIN32_EXIT_CODE    : 0  (0x0)'), null, 'ноль — не ошибка');
  assert.equal(serviceErrorCode(''), null);
});

test('версии движков: Antigravity младше 1.5 не подходит (нет agy acp)', () => {
  assert.deepEqual(parseVersion('1.0.13'), [1, 0, 13]);
  assert.deepEqual(parseVersion('agy version 1.5.5 (abc)'), [1, 5, 5]);
  assert.deepEqual(parseVersion('v24.1'), [24, 1, 0]);
  assert.equal(parseVersion('нет версии'), null);
  assert.equal(versionAtLeast('1.0.13', '1.5.0'), false);
  assert.equal(versionAtLeast('1.5.0', '1.5.0'), true);
  assert.equal(versionAtLeast('1.10.2', '1.5.0'), true, 'сравнение чисел, а не строк');
  assert.equal(versionAtLeast('что-то', '1.5.0'), true, 'неизвестная версия не мешает запуску');
});

test('serviceState / servicePid / winMessage: разбор sc.exe и нечитаемых сообщений nssm', () => {
  assert.equal(serviceState('SERVICE_NAME: acpgram\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 3  STOP_PENDING\r\n'), 'STOP_PENDING');
  assert.equal(serviceState('        STATE              : 4  RUNNING \r\n'), 'RUNNING');
  assert.equal(serviceState('[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\r\n\r\nThe specified service does not exist as an installed service.'), null, 'службы нет');
  assert.match(winMessage('Error creating service!\r\nCreateService(): ????????? ?????? ???? ???????? ??? ????????.'), /не отображается в этой кодировке/);
  assert.equal(winMessage('Access is denied.'), 'Access is denied.');
});

test('nssmCommands: остановка не зависает — тайм-ауты и завершение всего дерева процессов', () => {
  const byKey = Object.fromEntries(nssmCommands({ name: 'svc', node: 'n' }).filter((c) => c[0] === 'set').map((c) => [c[2], c.slice(3)]));
  assert.deepEqual(byKey.AppStopMethodConsole, ['3000']);
  assert.deepEqual(byKey.AppStopMethodWindow, ['2000']);
  assert.deepEqual(byKey.AppStopMethodThreads, ['2000']);
  assert.deepEqual(byKey.AppKillProcessTree, ['1']);
});
test('resolveHomeDir: папка данных для npm vs локальной установки', () => {
  assert.equal(resolveHomeDir({ ACPGRAM_HOME: '/custom/dir' }, '/any'), '/custom/dir');
  assert.equal(resolveHomeDir({}, '/usr/local/lib/node_modules/acpgram'), join(homedir(), '.acpgram'));
  assert.equal(resolveHomeDir({}, String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\acpgram`), join(homedir(), '.acpgram'));
  assert.equal(resolveHomeDir({}, '/home/u/projects/acpgram'), '/home/u/projects/acpgram');
});

test('writeEnvFile: создаёт каталог, которого ещё нет (первая установка через npm: ~/.acpgram)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const path = join(dir, 'новый', '.acpgram', '.env');
    writeEnvFile({ TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1' }, path, join(dir, 'новый', '.acpgram', 'data', '.env.bak'));
    assert.deepEqual(readEnvFile(path), { TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacyHomeDirs / findLegacyHome: прежняя установка install.ps1 / install.sh', () => {
  const local = String.raw`C:\Users\u\AppData\Local`;
  assert.deepEqual(legacyHomeDirs({ LOCALAPPDATA: local }, 'win32', '/h'), [join(local, 'acpgram')]);
  assert.deepEqual(legacyHomeDirs({}, 'win32', '/h'), []);
  assert.deepEqual(legacyHomeDirs({}, 'linux', '/home/u'), [join('/home/u', '.local', 'share', 'acpgram')]);
  const old = join('/x', 'old');
  const has = (d) => d === join(old, '.env');
  assert.equal(findLegacyHome({ current: '/x/new', dirs: [old], exists: has }), old);
  assert.equal(findLegacyHome({ current: old, dirs: [old], exists: has }), undefined, 'текущий каталог — не «прежний»');
  assert.equal(findLegacyHome({ current: '/x/new', dirs: [old], exists: () => false }), undefined, 'нет .env — нечего переносить');
});

test('copyLegacyDb: копирует базу с WAL-файлами и не перезаписывает существующую', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-'));
  try {
    const legacy = join(dir, 'old');
    const dataDir = join(dir, 'new', 'data');
    mkdirSync(join(legacy, 'data'), { recursive: true });
    assert.equal(copyLegacyDb(legacy, dataDir), false, 'в прежней установке базы нет');
    writeFileSync(join(legacy, 'data', 'bot.db'), 'db');
    writeFileSync(join(legacy, 'data', 'bot.db-wal'), 'wal');
    assert.equal(copyLegacyDb(legacy, dataDir), true);
    assert.equal(readFileSync(join(dataDir, 'bot.db'), 'utf8'), 'db');
    assert.equal(readFileSync(join(dataDir, 'bot.db-wal'), 'utf8'), 'wal');
    assert.equal(existsSync(join(dataDir, 'bot.db-shm')), false);
    writeFileSync(join(dataDir, 'bot.db'), 'mine');
    assert.equal(copyLegacyDb(legacy, dataDir), false, 'уже есть своя база — не трогаем');
    assert.equal(readFileSync(join(dataDir, 'bot.db'), 'utf8'), 'mine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('suggestDefaultEngine: OpenCode первым, уже выбранный движок не меняется', () => {
  assert.equal(suggestDefaultEngine(['gemini', 'claude', 'opencode']), 'opencode');
  assert.equal(suggestDefaultEngine(['gemini', 'claude', 'opencode'], 'claude'), 'claude', 'повторный запуск мастера');
  assert.equal(suggestDefaultEngine(['gemini', 'opencode'], 'codex'), 'opencode', 'выбранный раньше движок больше не установлен');
  assert.equal(suggestDefaultEngine(['claude', 'gemini']), 'gemini');
  assert.equal(suggestDefaultEngine(['agy']), 'agy');
  assert.equal(suggestDefaultEngine([]), null);
});

test('npmCommand / globalBinDir: npm той же установки Node, куда npm -g кладёт команды', () => {
  const win = 'C:/node/node.exe';
  assert.deepEqual(npmCommand(win, 'win32', () => true), [win, [join('C:/node', 'node_modules', 'npm', 'bin', 'npm-cli.js')]]);
  assert.deepEqual(npmCommand(win, 'win32', () => false), ['npm.cmd', []], 'npm-cli.js рядом нет — npm из PATH');
  const nix = '/opt/acpgram/node/bin/node';
  assert.deepEqual(npmCommand(nix, 'linux', () => true), [nix, [join('/opt/acpgram/node/bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]]);
  assert.deepEqual(npmCommand(nix, 'linux', () => false), ['npm', []]);
  assert.equal(globalBinDir('C:/Users/u/AppData/Roaming/npm', 'win32'), 'C:/Users/u/AppData/Roaming/npm');
  assert.equal(globalBinDir('/usr/local', 'linux'), join('/usr/local', 'bin'));
});

test('opencodeKeysToAsk: ключи провайдеров для OpenCode без уже спрошенных для других движков', () => {
  const names = (list) => list.map(([n]) => n);
  assert.deepEqual(names(opencodeKeysToAsk(['opencode'])), ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY']);
  assert.deepEqual(names(opencodeKeysToAsk(['gemini', 'claude', 'codex', 'opencode'])), ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY']);
  assert.deepEqual(names(opencodeKeysToAsk(['claude', 'opencode'])), ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY']);
  // ключи провайдеров идут в .env сразу после основных, а не в конец
  const text = serializeEnv({ TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1', OPENROUTER_API_KEY: 'or', MISTRAL_API_KEY: 'm', ZZZ: 'z' }, { lang: 'en' });
  assert.ok(text.indexOf('OPENROUTER_API_KEY=or') < text.indexOf('MISTRAL_API_KEY=m') && text.indexOf('MISTRAL_API_KEY=m') < text.indexOf('ZZZ=z'));
});

test('positiveEnv: мусор, ноль и отрицательное в переменной окружения — значение по умолчанию, а не снятый лимит', async () => {
  const { positiveEnv } = await import('../src/app.mjs');
  assert.equal(positiveEnv('X', 3, { X: '5' }), 5);
  assert.equal(positiveEnv('X', 30, { X: '0.5' }), 0.5);
  for (const bad of ['abc', '', '0', '-2', 'NaN', 'Infinity', undefined]) assert.equal(positiveEnv('X', 3, { X: bad }), 3, String(bad));
  assert.equal(positiveEnv('X', 3, {}), 3);
});

test('setupWorkspaces: личные пространства только внутри корня проектов', async () => {
  const yes = (v) => ({ yes: async () => v });
  const withRoot = { PROJECTS_ROOT: '/projects' };
  await setupWorkspaces(yes(true), withRoot);
  assert.equal(withRoot.USER_WORKSPACES, '1');
  const withoutRoot = { USER_WORKSPACES: '1' };
  await setupWorkspaces(yes(true), withoutRoot);
  assert.equal(Object.hasOwn(withoutRoot, 'USER_WORKSPACES'), false);
});

test('setupApiKeys: ключ запрошенного движка сохраняется в env', async () => {
  const env = {};
  let asked = 0;
  await setupApiKeys({ secret: async () => (asked++, 'secret') }, env, ['gemini']);
  assert.equal(env.GEMINI_API_KEY, 'secret');
  assert.equal(asked, 1);
});

test('startSetupService: отказ, успешная и неудачная регистрация службы сохраняют результат мастера', async () => {
  const no = { yes: async () => false };
  assert.deepEqual(await startSetupService(no, false), { ok: true, service: false });

  const yes = { yes: async () => true };
  assert.deepEqual(await startSetupService(yes, false, async () => ({ ok: true })), { ok: true, service: true });
  assert.deepEqual(await startSetupService(yes, false, async () => ({ ok: false, installed: true })), { ok: true, service: false });
});

test('prepareWindowsInstall: не спрашивает пароль до проверок и предлагает рестарт существующей службы', async () => {
  let probed = 0;
  const probe = () => (probed++, { exists: null });
  const log = [];
  const first = await prepareWindowsInstall({ nssm: 'nssm', name: 'svc', dry: true, probe, log: (s) => log.push(s) });
  assert.equal(first.done, false);
  assert.equal(probed, 0);
  const unknown = await prepareWindowsInstall({ nssm: 'nssm', name: 'svc', probe, log: (s) => log.push(s) });
  assert.equal(unknown.done, true);
  assert.equal(unknown.result.ok, false);
  assert.equal(probed, 1);
  let removed = 0;
  const marked = await prepareWindowsInstall({ nssm: 'nssm', name: 'svc', probe: () => ({ exists: true }), marked: () => true, remove: async () => (removed++, true), log: (s) => log.push(s) });
  assert.equal(marked.done, false, 'после успешного добивания помеченной службы установка продолжается');
  assert.equal(removed, 1);
  const restarted = await prepareWindowsInstall({
    nssm: 'nssm', name: 'svc', probe: () => ({ exists: true }), prompt: { yes: async () => true },
    restart: async () => ({ ok: true }), log: (s) => log.push(s),
  });
  assert.deepEqual(restarted, { done: true, result: { ok: true, installed: true } });
  const answers = [false, true];
  const reinstall = await prepareWindowsInstall({
    nssm: 'nssm', name: 'svc', probe: () => ({ exists: true }), prompt: { yes: async () => answers.shift() },
    remove: async () => true, log: (s) => log.push(s),
  });
  assert.equal(reinstall.done, false);
  assert.equal(answers.length, 0);
});

test('chooseWindowsAccount: пароль, отказ и LocalSystem без терминала', async () => {
  const account = await chooseWindowsAccount({ prompt: { yes: async () => true, secret: async () => 'pw' }, user: '.\\u', log: () => {} });
  assert.deepEqual(account, { done: false, account: { user: '.\\u', password: 'pw' } });
  const rejected = await chooseWindowsAccount({ prompt: { yes: async () => true, secret: async () => '' }, user: '.\\u', log: () => {} });
  assert.equal(rejected.done, true);
  assert.equal(rejected.result.ok, false);
  const system = await chooseWindowsAccount({ prompt: null, allowSystem: true, user: '.\\u', log: () => {} });
  assert.deepEqual(system, { done: false, account: null });
  const noTty = await chooseWindowsAccount({ prompt: null, allowSystem: false, user: '.\\u', log: () => {} });
  assert.equal(noTty.done, true);
  assert.equal(noTty.result.ok, false);
});

test('applyNssmCommands: пароль не попадает в лог, ошибка ObjectName откатывает установку', () => {
  const calls = [];
  const log = [];
  const commands = () => [['install', 'svc', 'n'], ['set', 'svc', 'ObjectName', '.\\u', 'p@ss']];
  const ok = applyNssmCommands({ nssm: 'nssm', name: 'svc', node: 'n', commands, run: (_cmd, args, opts) => (calls.push({ args, opts }), { status: 0 }), log: (s) => log.push(s) });
  assert.equal(ok.done, false);
  assert.deepEqual(calls[1].args, ['set', 'svc', 'ObjectName', '.\\u', 'p@ss']);
  assert.equal(calls[1].opts.secretAt, 4);
  assert.ok(!log.join('\n').includes('p@ss'));
  const failed = applyNssmCommands({
    nssm: 'nssm', name: 'svc', node: 'n', commands: () => [['set', 'svc', 'ObjectName', '.\\u', 'p@ss']],
    run: (_cmd, args, opts) => (calls.push({ args, opts }), { status: 5, stderr: 'denied' }), log: (s) => log.push(s),
  });
  assert.equal(failed.done, true);
  assert.equal(failed.result.ok, false);
  assert.deepEqual(calls.at(-1).args, ['remove', 'svc', 'confirm']);
});

test('startInstalledService: dry-run, успех и повтор пароля после LOGON_FAILURE', async () => {
  const calls = [];
  const log = [];
  const dry = await startInstalledService({ nssm: 'nssm', name: 'svc', dry: true, run: (_cmd, args, opts) => (calls.push({ args, opts }), { status: 0 }), log: (s) => log.push(s) });
  assert.equal(dry.ok, true);
  assert.deepEqual(calls.at(-1).args, ['start', 'svc']);
  const ok = await startInstalledService({ nssm: 'nssm', name: 'svc', start: async () => ({ running: true, code: 0, state: 'RUNNING' }), log: (s) => log.push(s) });
  assert.deepEqual(ok, { ok: true, installed: true });
  const starts = [{ running: false, code: LOGON_FAILURE, state: 'STOPPED' }, { running: true, code: 0, state: 'RUNNING' }];
  const setCalls = [];
  const retried = await startInstalledService({
    nssm: 'nssm', name: 'svc', account: { user: '.\\u', password: 'old' }, prompt: { secret: async () => 'new' },
    start: async () => starts.shift(),
    run: (_cmd, args, opts) => (setCalls.push({ args, opts }), { status: 0 }), log: (s) => log.push(s),
  });
  assert.equal(retried.ok, true);
  assert.deepEqual(setCalls[0].args, ['set', 'svc', 'ObjectName', '.\\u', 'new']);
  assert.equal(setCalls[0].opts.secretAt, 4);
  const failed = await startInstalledService({
    nssm: 'nssm', name: 'svc', account: { user: '.\\u' },
    start: async () => ({ running: false, code: 5, state: 'STOPPED' }), log: (s) => log.push(s),
  });
  assert.deepEqual(failed, { ok: false, installed: true });
});

test('setupApiKeys: ключ есть только в окружении — сохраняется по согласию и не печатается', async () => {
  const secret = 'env-only-secret-123';
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = secret;
  try {
    const declined = {};
    const prompts = [];
    const output = await captureConsole(() => setupApiKeys({
      secret: async (prompt) => (prompts.push(prompt), ''),
      yes: async (prompt) => (prompts.push(prompt), false),
    }, declined, ['gemini']));
    assert.equal(declined.GEMINI_API_KEY, undefined);
    assert.ok(prompts.some((s) => s.includes(tc('setup.keyEnv'))));
    assert.ok(prompts.includes(tc('setup.keySave', { name: 'GEMINI_API_KEY' })));
    const accepted = {};
    await captureConsole(() => setupApiKeys({ secret: async () => '', yes: async () => true }, accepted, ['gemini']));
    assert.equal(accepted.GEMINI_API_KEY, secret);
    assert.ok(!output.includes(secret));
    assert.ok(!prompts.join('\n').includes(secret));
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prev;
  }
});

test('setupApiKeys: OpenCode без ключей печатает путь .env и не запрашивает ключи', async () => {
  const asked = [];
  const answered = [];
  const output = await captureConsole(() => setupApiKeys({
    secret: async (prompt) => (asked.push(prompt), ''),
    yes: async (prompt) => (answered.push(prompt), false),
  }, {}, ['opencode']));
  const keys = opencodeKeysToAsk(['opencode']).map(([name]) => name).join(', ');
  assert.ok(answered.includes(tc('setup.opencodeKeysAsk')));
  assert.deepEqual(asked, []);
  assert.ok(output.includes(tc('setup.opencodeNote')));
  assert.ok(output.includes(tc('setup.opencodeKeysLater', { path: ENV_PATH, list: keys })));
});

test('startSetupService: предупреждения о службе и ручной запуск', async () => {
  const notStarted = await captureConsole(() => startSetupService({ yes: async () => true }, false, async () => ({ ok: false, installed: true })));
  assert.ok(notStarted.includes(tc('setup.serviceStartFail')));
  const notInstalled = await captureConsole(() => startSetupService({ yes: async () => true }, false, async () => ({ ok: false, installed: false })));
  assert.ok(notInstalled.includes(tc('setup.serviceFail')));
  const manual = await captureConsole(() => startSetupService({ yes: async () => false }, false, async () => ({ ok: true })));
  assert.ok(manual.includes(tc('setup.manual')));
});

test('sendTestMessage: сетевая ошибка не прерывает настройку и не показывает токен', async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const output = await captureConsole(() => sendTestMessage({ TELEGRAM_BOT_TOKEN: 'SECRET_BOT_TOKEN' }, '42'));
    assert.ok(output.includes(tc('setup.testFail', { msg: 'network down' })));
    assert.ok(!output.includes('SECRET_BOT_TOKEN'));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('saveEnvAndDb: успех пишет .env и базу, ошибка записи возвращает false', () => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-save-'));
  const setupUrl = new URL('../src/setup.mjs', import.meta.url).href;
  const script = `
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.ACPGRAM_TEST_HOME;
mkdirSync(home, { recursive: true });
if (process.env.ACPGRAM_TEST_MODE === 'fail') mkdirSync(join(home, '.env'), { recursive: true });
const { saveEnvAndDb } = await import(process.env.ACPGRAM_SETUP_URL);
const value = 'E2E_SECRET_VALUE';
const result = await saveEnvAndDb({ GEMINI_API_KEY: value, ALLOWED_USER_ID: '42' });
const path = join(home, '.env');
const text = existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : '';
writeFileSync(join(home, 'result.json'), JSON.stringify({ result, saved: text.includes(value), db: existsSync(join(home, 'data', 'bot.db')) }));
`;
  try {
    const run = (mode) => {
      const home = join(dir, mode);
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ACPGRAM_HOME: home, ACPGRAM_LANG: 'ru', ACPGRAM_TEST_HOME: home, ACPGRAM_TEST_MODE: mode, ACPGRAM_SETUP_URL: setupUrl },
      });
      assert.equal(r.status, 0, r.stderr);
      return { output: r.stdout, ...JSON.parse(readFileSync(join(home, 'result.json'), 'utf8')) };
    };
    const ok = run('ok');
    assert.equal(ok.result, true);
    assert.ok(ok.saved);
    assert.ok(ok.db);
    const bad = run('fail');
    assert.equal(bad.result, false);
    assert.ok(!bad.saved);
    assert.ok(bad.output.includes(tc('setup.saveFail', { msg: '' }).trimEnd()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setupToken: неверный токен спрашивается заново, верный сохраняется', async () => {
  const fetch = globalThis.fetch;
  const urls = [];
  const secrets = ['bad-token', 'good-token'];
  globalThis.fetch = async (url) => {
    urls.push(url);
    const ok = url.includes('/botgood-token/getMe');
    return { status: ok ? 200 : 401, json: async () => ok ? { ok: true, result: { username: 'test_bot', first_name: 'Bot' } } : { ok: false, description: 'wrong token' } };
  };
  try {
    const env = {};
    let asked = 0;
    const me = await quiet(() => setupToken({ secret: async () => {
      if (asked >= secrets.length) throw new Error('answer exhausted');
      return secrets[asked++];
    } }, env));
    assert.equal(asked, 2);
    assert.equal(env.TELEGRAM_BOT_TOKEN, 'good-token');
    assert.equal(me.username, 'test_bot');
    assert.deepEqual(urls.map((u) => u.split('/bot')[1]), ['bad-token/getMe', 'good-token/getMe']);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('setupAdmin: ожидание автора сообщения и подтверждение ID; конфликт и ручной ввод', async () => {
  const fetch = globalThis.fetch;
  const updates = [
    { update_id: 1, message: { chat: { type: 'private' }, from: { id: 42, username: 'alice' } } },
  ];
  let getUpdates = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/deleteWebhook')) throw new Error('Conflict: webhook');
    if (url.includes('/getUpdates')) {
      const n = getUpdates++;
      if (n === 0) return { status: 200, json: async () => ({ ok: true, result: [] }) };
      if (n === 1) return { status: 200, json: async () => ({ ok: true, result: updates }) };
      return { status: 200, json: async () => ({ ok: true, result: [] }) };
    }
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const confirmed = {};
    let confirmedYes = 0;
    const id = await quiet(() => setupAdmin({ yes: async () => (confirmedYes++, true), ask: async () => { throw new Error('ask не нужен'); } }, confirmed, { username: 'test_bot' }));
    assert.equal(id, '42');
    assert.equal(confirmed.ALLOWED_USER_ID, '42');
    assert.equal(confirmedYes, 1);
    assert.equal(getUpdates, 3);

    getUpdates = 0;
    globalThis.fetch = async (url) => {
      if (url.includes('/deleteWebhook')) throw new Error('Conflict: webhook');
      if (url.includes('/getUpdates')) throw new Error('Conflict: another bot is running');
      return { status: 200, json: async () => ({ ok: true, result: {} }) };
    };
    const manual = {};
    const answers = ['abc', '777'];
    let asked = 0;
    const output = await captureConsole(() => setupAdmin({ yes: async () => false, ask: async () => answers[asked++] }, manual, { username: 'test_bot' }));
    assert.equal(output.includes(tc('setup.conflictHint')), true, output);
    assert.equal(asked, 2);
    assert.equal(manual.ALLOWED_USER_ID, '777');
  } finally {
    globalThis.fetch = fetch;
  }
});

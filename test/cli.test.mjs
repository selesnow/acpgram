import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setCliLang, tc } from '../src/cli-i18n.mjs';
import { help, isNpm, route, updateCommand, updateEnv } from '../src/cli.mjs';

setCliLang('ru'); // тесты проверяют русские тексты; язык определения — в cli-i18n.test.mjs

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('route: команды acpgram', () => {
  assert.deepEqual(route([]), { run: 'main.mjs', args: [] }, 'без команды — запуск бота');
  assert.deepEqual(route(['start']), { run: 'main.mjs', args: [] });
  assert.deepEqual(route(['setup']), { run: 'setup.mjs', args: [] });
  assert.deepEqual(route(['service', 'restart']), { run: 'service.mjs', args: ['restart'] });
  assert.deepEqual(route(['service', 'stop']), { run: 'service.mjs', args: ['stop'] });
  assert.deepEqual(route(['service', 'install', '--name', 'x', '--dry-run']), { run: 'service.mjs', args: ['install', '--name', 'x', '--dry-run'] });
  assert.ok(route(['service']).error && route(['service', 'bogus']).error, 'service без действия — ошибка');
  assert.deepEqual(route(['update']), { update: true });
  for (const v of ['version', '--version', '-v']) assert.equal(route([v]).print, VERSION);
  for (const h of ['help', '--help', '-h']) assert.equal(route([h]).print, help());
  assert.match(route(['nope']).error, /Неизвестная команда/);
});

test('updateCommand / updateEnv: тот же установщик, эта же установка, ошибка загрузки не маскируется', () => {
  // Windows PowerShell по полному пути: папки WindowsPowerShell может не быть в PATH
  const [win, winArgs] = updateCommand('win32', { SystemRoot: process.env.SystemRoot || String.raw`C:\Windows` });
  assert.ok(/powershell(\.exe)?$/i.test(win), win);
  if (process.platform === 'win32') assert.ok(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(win), win);
  assert.ok(winArgs.at(-1).includes('releases/latest/download/install.ps1 | iex'));
  assert.ok(!winArgs.at(-1).includes('/main/install.ps1'));
  const [sh, shArgs] = updateCommand('linux');
  assert.equal(sh, 'sh');
  // сначала скачать целиком, и только при успехе выполнить — без `curl | bash`, где код curl теряется
  assert.ok(shArgs.at(-1).includes('curl -fsSL https://github.com/selesnow/acpgram/releases/latest/download/install.sh -o "$f" && bash "$f"'), shArgs.at(-1));
  assert.ok(!shArgs.at(-1).includes('/main/install.sh'));
  assert.ok(!shArgs.at(-1).includes('| bash'));

  assert.equal(updateEnv({}, '/opt/acpgram').ACPGRAM_HOME, '/opt/acpgram', 'обновляется установка, откуда запущена команда');
  assert.equal(updateEnv({ ACPGRAM_HOME: '/x' }, '/opt/acpgram').ACPGRAM_HOME, '/x', 'явно заданный путь важнее');
});

test('install.ps1: acpgram.cmd обновляет сам, без node.exe (защита Windows может запрещать node → PowerShell)', () => {
  const ps = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  // eslint-disable-next-line no-control-regex -- проверка на любые не-ASCII символы
  assert.ok(!/[^\x00-\x7f]/.test(ps), 'установщик — только ASCII (PowerShell 5.1 читает его в кодировке консоли)');
  const update = ps.indexOf(`'if /i "%~1"=="update" ('`);
  const node = ps.indexOf('--disable-warning=ExperimentalWarning `"%~dp0..\\src\\cli.mjs`" %*');
  assert.ok(update > 0 && node > update, 'ветка update — до запуска node');
  const block = ps.slice(update, node);
  assert.ok(block.includes(String.raw`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"`), 'PowerShell по полному пути');
  assert.ok(block.includes('releases/latest/download/install.ps1 | iex'));
  assert.ok(block.includes(`'  exit /b'`), 'блок завершается exit /b: cmd.exe разобрал его целиком до перезаписи файла');
  assert.ok(ps.includes('acpgram service install | restart | stop | status | uninstall'), 'итог установщика перечисляет все команды службы');
});

test('install.ps1: приватный nssm ставится до мастера с проверкой SHA-256', () => {
  const ps = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
  assert.ok(ps.includes('ACPGRAM_NO_NSSM'), 'установку можно отключить');
  assert.ok(ps.includes("$NssmVersion = '2.24-101-g897c7ad'"));
  assert.ok(ps.includes('99f5045fffbffb745d67fe3a065a953c4a3d9c253b868892d9b685b0ee7d07b8'), 'архив проверяется контрольной суммой');
  assert.ok(ps.includes(String.raw`win64\nssm.exe`), 'ставится 64-разрядный nssm');
  assert.ok(ps.indexOf('---------- nssm (Windows service manager) ----------') < ps.indexOf('---------- release ----------'), 'nssm ставится до релиза и мастера');
  assert.ok(ps.includes("'^v\\d+\\.\\d+\\.\\d+$'"), 'перед загрузкой релиза проверяется формат тега');
});

test('install.sh: обновление из релиза и строгая проверка тега', () => {
  const sh = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.ok(sh.includes('releases/latest/download/install.sh'), 'установщик берётся из последнего релиза');
  assert.ok(!sh.includes('raw.githubusercontent.com/selesnow/acpgram/main'));
  assert.ok(sh.includes('^v[0-9]+\\.[0-9]+\\.[0-9]+$'), 'тег релиза проверяется полностью');
  assert.ok(sh.includes('acpgram service install | restart | stop | status | uninstall'), 'итог установщика перечисляет все команды службы');
});

test('release.yml: установщики публикуются в assets релиза, попадают в SHA256SUMS и проверяются оттуда', () => {
  const yml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.ok(yml.includes('cp install.ps1 install.sh dist/'), 'установщики копируются в dist для загрузки в релиз');
  assert.ok(yml.includes('sha256sum acpgram-* install.ps1 install.sh > SHA256SUMS'), 'установщики включены в SHA256SUMS');
  assert.ok(yml.includes('/releases/download/${GITHUB_REF_NAME}/install.sh'), 'Linux/macOS CI проверяет install.sh из assets релиза');
  assert.ok(yml.includes('/releases/download/$($env:GITHUB_REF_NAME)/install.ps1'), 'Windows CI проверяет install.ps1 из assets релиза');
  assert.ok(!yml.includes('raw.githubusercontent.com'), 'CI не должен маскировать отсутствие установщиков в assets');
});

test('cli.mjs как команда: version и код выхода при ошибке', () => {
  const ok = spawnSync(process.execPath, [CLI, 'version'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), VERSION);
  const bad = spawnSync(process.execPath, [CLI, 'service', 'bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
test('isNpm: определяет установку из node_modules', () => {
  assert.equal(isNpm('/usr/local/lib/node_modules/acpgram'), true);
  assert.equal(isNpm(String.raw`C:\Users\tester\AppData\Roaming\npm\node_modules\acpgram`), true);
  assert.equal(isNpm('/home/user/.local/share/acpgram'), false);
  assert.equal(isNpm(String.raw`C:\dev\acpgram`), false);
});
test('acpgram update при установке через npm: подсказка обновления и код 0 без запуска скриптов', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-cli-'));
  const modDir = join(tmp, 'node_modules', 'acpgram');
  try {
    mkdirSync(join(modDir, 'src'), { recursive: true });
    copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(modDir, 'package.json'));
    copyFileSync(CLI, join(modDir, 'src', 'cli.mjs'));
    copyFileSync(fileURLToPath(new URL('../src/cli-i18n.mjs', import.meta.url)), join(modDir, 'src', 'cli-i18n.mjs'));
    copyFileSync(fileURLToPath(new URL('../src/winReg.mjs', import.meta.url)), join(modDir, 'src', 'winReg.mjs'));
    for (const [lang, installed] of [['ru', 'AcpGram установлен через npm'], ['en', 'AcpGram is installed via npm'], ['uk', 'AcpGram встановлено через npm']]) {
      const res = spawnSync(process.execPath, [join(modDir, 'src', 'cli.mjs'), 'update'], { encoding: 'utf8', env: { ...process.env, ACPGRAM_LANG: lang } });
      assert.equal(res.status, 0, lang);
      assert.ok(res.stdout.includes('npm install -g acpgram@latest'), lang);
      assert.ok(res.stdout.includes(installed), `${lang}: текст на языке терминала`);
      assert.ok(!/Обновляю AcpGram|Updating AcpGram|Оновлюю AcpGram/.test(res.stdout), lang);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli.mjs как команда: запуск service и передача кода выхода', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-cli-service-'));
  const src = join(tmp, 'src');
  try {
    mkdirSync(src, { recursive: true });
    copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(tmp, 'package.json'));
    copyFileSync(CLI, join(src, 'cli.mjs'));
    copyFileSync(fileURLToPath(new URL('../src/cli-i18n.mjs', import.meta.url)), join(src, 'cli-i18n.mjs'));
    copyFileSync(fileURLToPath(new URL('../src/winReg.mjs', import.meta.url)), join(src, 'winReg.mjs'));
    writeFileSync(join(src, 'service.mjs'), "console.log('SERVICE_OK')\n");
    const ok = spawnSync(process.execPath, [join(src, 'cli.mjs'), 'service', 'status'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /SERVICE_OK/);
    writeFileSync(join(src, 'service.mjs'), 'process.exit(3)\n');
    const bad = spawnSync(process.execPath, [join(src, 'cli.mjs'), 'service', 'status'], { encoding: 'utf8' });
    assert.equal(bad.status, 3, bad.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

const copyCli = (tmp) => {
  const src = join(tmp, 'src');
  mkdirSync(src, { recursive: true });
  copyFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(tmp, 'package.json'));
  copyFileSync(CLI, join(src, 'cli.mjs'));
  copyFileSync(fileURLToPath(new URL('../src/cli-i18n.mjs', import.meta.url)), join(src, 'cli-i18n.mjs'));
  copyFileSync(fileURLToPath(new URL('../src/winReg.mjs', import.meta.url)), join(src, 'winReg.mjs'));
  return join(src, 'cli.mjs');
};

const SPAWN_MOCK = String.raw`
const rules = JSON.parse(process.env.FAKE_CLI_CMDS || '[]');
let index = 0;
export function spawnSync(cmd, args, opts) {
  const rule = rules[index++];
  console.log('CALL ' + JSON.stringify({
    cmd, args,
    opts: { stdio: opts?.stdio, env: Boolean(opts?.env), windowsVerbatimArguments: opts?.windowsVerbatimArguments },
  }));
  if (!rule) return { status: 0 };
  if (rule.error) {
    const e = new Error(rule.error);
    e.code = rule.code;
    return { error: e };
  }
  return { status: rule.status ?? 0 };
}
`;

const cliUpdate = ({ rules = [], platform = 'win32', argv = ['update'] } = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-cli-update-'));
  try {
    const cli = copyCli(tmp);
    const spawnPath = join(tmp, 'spawn.mjs');
    writeFileSync(spawnPath, SPAWN_MOCK);
    const loader = join(tmp, 'loader.mjs');
    writeFileSync(loader, String.raw`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') return { url: ${JSON.stringify(new URL(`file:///${spawnPath.replace(/\\/g, '/')}`).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`);
    const prelude = join(tmp, 'prelude.mjs');
    writeFileSync(prelude, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });`);
    const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', new URL(`file:///${loader.replace(/\\/g, '/')}`).href, '--import', new URL(`file:///${prelude.replace(/\\/g, '/')}`).href, cli, ...argv], {
      encoding: 'utf8',
      env: { ...process.env, ACPGRAM_LANG: 'ru', FAKE_CLI_CMDS: JSON.stringify(rules) },
      timeout: 30_000,
    });
    const lines = (r.stdout ?? '').split(/\r?\n/);
    return {
      status: r.status,
      stderr: r.stderr,
      text: lines.filter((s) => !s.startsWith('CALL ')).join('\n') + '\n' + (r.stderr ?? ''),
      calls: lines.filter((s) => s.startsWith('CALL ')).map((s) => JSON.parse(s.slice(5))),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

test('cli.mjs update: успех установщика и тот же код версии', () => {
  const r = cliUpdate({ rules: [{ status: 0 }] });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.calls.length, 1);
  assert.ok(r.text.includes(tc('cli.updating', { before: VERSION })), r.text);
  assert.ok(r.text.includes(tc('cli.updated', { before: VERSION, after: VERSION, same: tc('cli.alreadyLatest') })), r.text);
});

test('cli.mjs update: EPERM на Windows запускает установщик через cmd.exe', () => {
  const r = cliUpdate({ rules: [{ error: 'blocked', code: 'EPERM' }, { status: 0 }], platform: 'win32' });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[1].cmd, /cmd\.exe$/i);
  assert.equal(r.calls[1].opts.windowsVerbatimArguments, true);
  assert.ok(r.text.includes(tc('cli.psBlocked', { code: 'EPERM' })), r.text);
  assert.ok(!r.text.includes('Обновите вручную'), r.text);
});

test('cli.mjs update: повторный отказ запуска печатает Manual и код 1', () => {
  const r = cliUpdate({ rules: [{ error: 'denied', code: 'EACCES' }, { error: 'denied', code: 'EACCES' }], platform: 'win32' });
  assert.equal(r.status, 1, r.text);
  assert.equal(r.calls.length, 2);
  assert.match(r.text, /Не удалось запустить/);
  assert.ok(r.text.includes(tc('cli.blocked')), r.text);
  assert.ok(r.text.includes('install.ps1'), r.text);
});

test('cli.mjs update: вне Windows нет cmd.exe-fallback, ошибка запуска честно сообщается', () => {
  const r = cliUpdate({ rules: [{ error: 'no such file', code: 'ENOENT' }], platform: 'linux' });
  assert.equal(r.status, 1, r.text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].cmd, 'sh');
  assert.match(r.text, /Не удалось запустить sh:/);
  assert.ok(r.text.includes('install.sh'), r.text);
  assert.ok(!r.text.includes(tc('cli.psBlocked', { code: 'ENOENT' })), r.text);
});

test('cli.mjs update: ненулевой код установщика не прячется за сообщением об успехе', () => {
  const r = cliUpdate({ rules: [{ status: 3 }], platform: 'linux' });
  assert.equal(r.status, 3, r.text);
  assert.ok(r.text.includes(tc('cli.updateFailed', { code: 3, after: VERSION })), r.text);
  assert.ok(!r.text.includes('AcpGram: '), r.text);
});

test('cli.mjs как модуль: import не выполняет команду (realpath process.argv[1] недоступен)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-cli-import-'));
  try {
    const cli = copyCli(tmp);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(' + JSON.stringify(new URL(`file:///${cli.replace(/\\/g, '/')}`).href) + ')'], { encoding: 'utf8', env: { ...process.env, ACPGRAM_LANG: 'ru' }, timeout: 30_000 });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

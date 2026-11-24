import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setCliLang } from '../src/cli-i18n.mjs';
import { help, isNpm, route, updateCommand, updateEnv } from '../src/cli.mjs';
import { checkText } from '../scripts/publish-public.mjs';

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
});

test('publish-public: проверка текста на внутренние маркеры и секреты', () => {
  assert.ok(checkText('notes', 'C:' + '\\scripts\\' + 'al' + 'sey').length, 'внутренний путь');
  assert.ok(checkText('notes', 'AKIA' + 'IOSFODNN7EXAMPLE').length, 'AWS-ключ');
  assert.ok(checkText('notes', 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789').length, 'npm-токен');
  assert.equal(checkText('notes', 'AcpGram release notes').length, 0);
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

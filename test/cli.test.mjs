import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HELP, route, updateCommand, updateEnv } from '../src/cli.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('route: команды acpgram', () => {
  assert.deepEqual(route([]), { run: 'main.mjs', args: [] }, 'без команды — запуск бота');
  assert.deepEqual(route(['start']), { run: 'main.mjs', args: [] });
  assert.deepEqual(route(['setup']), { run: 'setup.mjs', args: [] });
  assert.deepEqual(route(['service', 'install', '--name', 'x', '--dry-run']), { run: 'service.mjs', args: ['install', '--name', 'x', '--dry-run'] });
  assert.ok(route(['service']).error && route(['service', 'bogus']).error, 'service без действия — ошибка');
  assert.deepEqual(route(['update']), { update: true });
  for (const v of ['version', '--version', '-v']) assert.equal(route([v]).print, VERSION);
  for (const h of ['help', '--help', '-h']) assert.equal(route([h]).print, HELP);
  assert.match(route(['nope']).error, /Неизвестная команда/);
});

test('updateCommand / updateEnv: тот же установщик, эта же установка, ошибка загрузки не маскируется', () => {
  // Windows PowerShell по полному пути: папки WindowsPowerShell может не быть в PATH
  const [win, winArgs] = updateCommand('win32', { SystemRoot: process.env.SystemRoot || String.raw`C:\Windows` });
  assert.ok(/powershell(\.exe)?$/i.test(win), win);
  if (process.platform === 'win32') assert.ok(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(win), win);
  assert.ok(winArgs.at(-1).includes('raw.githubusercontent.com/selesnow/acpgram/main/install.ps1 | iex'));
  const [sh, shArgs] = updateCommand('linux');
  assert.equal(sh, 'sh');
  // сначала скачать целиком, и только при успехе выполнить — без `curl | bash`, где код curl теряется
  assert.ok(shArgs.at(-1).includes('curl -fsSL https://raw.githubusercontent.com/selesnow/acpgram/main/install.sh -o "$f" && bash "$f"'), shArgs.at(-1));
  assert.ok(!shArgs.at(-1).includes('| bash'));

  assert.equal(updateEnv({}, '/opt/acpgram').ACPGRAM_HOME, '/opt/acpgram', 'обновляется установка, откуда запущена команда');
  assert.equal(updateEnv({ ACPGRAM_HOME: '/x' }, '/opt/acpgram').ACPGRAM_HOME, '/x', 'явно заданный путь важнее');
});

test('cli.mjs как команда: version и код выхода при ошибке', () => {
  const ok = spawnSync(process.execPath, [CLI, 'version'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), VERSION);
  const bad = spawnSync(process.execPath, [CLI, 'service', 'bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

// Регистрация бота как службы: автозапуск с системой и перезапуск при сбое.
//   Windows — служба через nssm (нужны права администратора), Linux — systemd --user, macOS — launchd (LaunchAgent).
// npm run service:install | service:uninstall | service:status   (флаги: --name <имя>, --dry-run)
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { APP, APP_DIR, MAIN_PATH } from './app.mjs';

const PLATFORM = process.platform;
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

// ---------- описания служб (чистые функции, проверяются тестами) ----------

/** «%» в unit-файле — спецификатор systemd (%h, %u…): буквальный пишется как «%%». */
const sdPct = (s) => s.replace(/%/g, '%%');

/** Аргумент ExecStart: «%» → «%%», «$» → «$$» (подстановка переменных), в кавычках при пробелах и спецсимволах. */
const sdQuote = (s) => {
  const v = sdPct(s).replace(/\$/g, '$$$$');
  return /[\s"'\\;]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
};

/** Значение Environment=: «%» → «%%» ($ здесь не подставляется), в кавычках при пробелах. */
const sdEnv = (s) => {
  const v = sdPct(s);
  return /[\s"'\\]/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
};

/** Unit-файл systemd --user. path — PATH, с которым бот найдёт агентов (как у пользователя, установившего службу). */
export function systemdUnit({ node, main = MAIN_PATH, dir = APP_DIR, path = process.env.PATH ?? '', description = APP.description } = {}) {
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `WorkingDirectory=${sdPct(dir)}`,
    `ExecStart=${[node, ...NODE_ARGS, main].map(sdQuote).join(' ')}`,
    `Environment=${sdEnv(`PATH=${path}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    '# агенты запускаются в своих группах процессов: при остановке бот завершает их сам',
    'KillMode=mixed',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** plist LaunchAgent (macOS). */
export function launchdPlist({ node, main = MAIN_PATH, dir = APP_DIR, path = process.env.PATH ?? '', label = APP.launchdLabel } = {}) {
  const log = posix.join(dir, 'data', 'service.log'); // только macOS — пути POSIX

  const args = [node, ...NODE_ARGS, main].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/**
 * Команды nssm (Windows): установка службы с перезапуском при сбое и ротацией лога.
 * account — {user, password} учётной записи, от которой работает служба (там авторизованы агенты); без него — LocalSystem.
 * @returns {string[][]} аргументы для nssm
 */
export function nssmCommands({ name = APP.id, node, main = MAIN_PATH, dir = APP_DIR, account = null, label = APP.label, description = APP.description } = {}) {
  const log = join(dir, 'data', 'service.log');
  return [
    // аргументы — отдельно и в кавычках: путь к боту может содержать пробелы, а nssm install склеивает их без кавычек
    ['install', name, node],
    ['set', name, 'AppParameters', [...NODE_ARGS, `"${main}"`].join(' ')],
    ['set', name, 'AppDirectory', dir],
    ['set', name, 'DisplayName', label],
    ['set', name, 'Description', description],
    ['set', name, 'Start', 'SERVICE_AUTO_START'],
    ['set', name, 'AppExit', 'Default', 'Restart'],
    ['set', name, 'AppRestartDelay', '5000'],
    ['set', name, 'AppStdout', log],
    ['set', name, 'AppStderr', log],
    ['set', name, 'AppRotateFiles', '1'],
    ['set', name, 'AppRotateOnline', '1'],
    ['set', name, 'AppRotateBytes', '10485760'],
    ...(account ? [['set', name, 'ObjectName', account.user, account.password]] : []),
  ];
}

// ---------- выполнение ----------

const run = (cmd, args, { dry = false, secretAt = -1 } = {}) => {
  const shown = args.map((a, i) => (i === secretAt ? '********' : /\s/.test(a) ? `"${a}"` : a)).join(' ');
  console.log(`  $ ${cmd} ${shown}`);
  if (dry) return { status: 0, stdout: '', stderr: '' };
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  // nssm пишет в UTF-16
  const clean = (s) => (s || '').replace(/\0/g, '').trim();
  return { status: r.status, stdout: clean(r.stdout), stderr: clean(r.stderr) || r.error?.message || '' };
};

function findNssm() {
  if (process.env.NSSM_PATH && existsSync(process.env.NSSM_PATH)) return process.env.NSSM_PATH;
  const r = spawnSync('where', ['nssm'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

const isWinAdmin = () => spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;

/** Учётная запись Windows текущего пользователя в формате для служб: «.\user» (локальная) или «DOMAIN\user». */
export function windowsAccount(env = process.env, username = userInfo().username) {
  const domain = env.USERDOMAIN;
  return domain && env.COMPUTERNAME && domain.toLowerCase() !== env.COMPUTERNAME.toLowerCase() ? `${domain}\\${username}` : `.\\${username}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Регистрирует и запускает службу. prompt — диалог (prompt.mjs): учётная запись Windows, переустановка существующей службы.
 * Без диалога на Windows служба ставится от LocalSystem только с allowSystem, иначе — ошибка с подсказкой.
 * @returns {Promise<{ok: boolean}>}
 */
export async function installService({ name = APP.id, dry = false, prompt = null, allowSystem = false } = {}) {
  const node = process.execPath;
  if (!dry) mkdirSync(join(APP_DIR, 'data'), { recursive: true });

  if (PLATFORM === 'win32') {
    const nssm = findNssm();
    if (!nssm) {
      console.log('  ❌ Не найден nssm (менеджер служб Windows). Установите: winget install --id NSSM.NSSM -e  (или choco install nssm, или https://nssm.cc) и повторите.');
      return { ok: false };
    }
    if (!dry && !isWinAdmin()) {
      console.log('  ❌ Нужны права администратора: запустите терминал «от имени администратора» и выполните npm run service:install.');
      return { ok: false };
    }
    // служба уже есть — переустанавливаем только с подтверждения
    if (!dry && run(nssm, ['status', name]).status === 0) {
      if (!prompt || !(await prompt.yes(`  Служба ${name} уже установлена. Переустановить (она будет остановлена и создана заново)?`, false))) {
        console.log(`  Оставляю как есть. Перезапуск: nssm restart ${name}; удалить: npm run service:uninstall`);
        return { ok: false };
      }
      run(nssm, ['stop', name]);
      run(nssm, ['remove', name, 'confirm']);
    }
    // служба должна работать от пользователя, у которого авторизованы агенты (Gemini, Claude Code, Antigravity)
    let account = null;
    const user = windowsAccount();
    if (prompt) {
      if (await prompt.yes(`  Запускать службу от вашей учётной записи ${user} (рекомендуется: там авторизованы агенты)?`)) {
        const password = await prompt.secret(`  Пароль Windows для ${user} (ввод скрыт)`);
        if (!password) {
          console.log('  ❌ Пароль не введён — служба не установлена.');
          return { ok: false };
        }
        account = { user, password };
      }
    } else if (!allowSystem) {
      console.log(`  ❌ Запустите в терминале (спросит учётную запись) или добавьте --system, чтобы служба работала от LocalSystem.`);
      return { ok: false };
    }
    if (!account) console.log('  ⚠️ Служба будет работать от LocalSystem: агенты должны быть авторизованы для этой учётной записи (ключи API в .env).');
    for (const args of nssmCommands({ name, node, account })) {
      // Пароль учётной записи (['set', name, 'ObjectName', user, password]) в вывод не попадает. nssm получает его
      // аргументом — других способов выдать право «вход в качестве службы» без сторонних утилит нет; виден он только
      // администраторам и этому пользователю, пока работает nssm (доли секунды).
      const isAccount = args[2] === 'ObjectName';
      const r = run(nssm, args, { dry, secretAt: isAccount ? 4 : -1 });
      if (r.status === 0) continue;
      console.log(`  ❌ ${r.stderr || r.stdout}`);
      // без нужной учётной записи (неверный пароль) служба не будет видеть авторизацию агентов — откатываем
      if (args[0] === 'install' || isAccount) {
        if (isAccount) {
          run(nssm, ['remove', name, 'confirm']);
          console.log('  Служба не установлена: проверьте пароль (для доменной учётной записи — DOMAIN\\user).');
        }
        return { ok: false };
      }
    }
    if (dry) {
      run(nssm, ['start', name], { dry });
      console.log('  (пробный прогон: команды показаны, но не выполнены)');
      return { ok: true };
    }
    const s = run(nssm, ['start', name]);
    // убеждаемся, что служба действительно работает (бот мог сразу упасть: нет .env, движок не запускается)
    let state = '';
    for (let i = 0; i < 10 && !/RUNNING/.test(state); i++) {
      await sleep(1000);
      state = run(nssm, ['status', name]).stdout;
    }
    if (!/RUNNING/.test(state)) {
      console.log(`  ❌ Служба ${name} установлена, но не запущена (${state || s.stderr || s.stdout}). Лог: ${join(APP_DIR, 'data', 'service.log')}`);
      return { ok: false };
    }
    console.log(`  ✅ Служба ${name} работает. Лог: ${join(APP_DIR, 'data', 'service.log')}. Управление: nssm restart|stop ${name}`);
    return { ok: true };
  }

  if (PLATFORM === 'linux') {
    const dirUnit = join(homedir(), '.config', 'systemd', 'user');
    const file = join(dirUnit, `${name}.service`);
    console.log(`  → ${file}`);
    if (!dry) {
      mkdirSync(dirUnit, { recursive: true });
      writeFileSync(file, systemdUnit({ node }));
    }
    // restart — чтобы при повторной установке подхватился обновлённый unit
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', name], ['--user', 'restart', name]]) {
      const r = run('systemctl', args, { dry });
      if (r.status !== 0) {
        console.log(`  ❌ ${r.stderr || r.stdout}`);
        return { ok: false };
      }
    }
    console.log(`  ✅ Служба ${name} запущена. Лог: journalctl --user -u ${name} -f`);
    console.log(`  Чтобы бот работал без входа в систему: sudo loginctl enable-linger ${userInfo().username}`);
    return { ok: true };
  }

  if (PLATFORM === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', `${APP.launchdLabel}.plist`);
    console.log(`  → ${file}`);
    if (!dry) {
      mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
      writeFileSync(file, launchdPlist({ node }));
    }
    const domain = `gui/${process.getuid?.() ?? ''}`;
    run('launchctl', ['bootout', `${domain}/${APP.launchdLabel}`], { dry }); // если уже был загружен
    // сразу после bootout launchd ещё выгружает агента — bootstrap может вернуть «Input/output error»; повторяем
    let r;
    for (let i = 0; i < 5; i++) {
      r = run('launchctl', ['bootstrap', domain, file], { dry });
      if (r.status === 0) break;
      await sleep(1000);
    }
    if (r.status !== 0) {
      console.log(`  ❌ ${r.stderr || r.stdout}`);
      return { ok: false };
    }
    console.log(`  ✅ LaunchAgent ${APP.launchdLabel} запущен. Лог: ${join(APP_DIR, 'data', 'service.log')}`);
    return { ok: true };
  }

  console.log(`  ❌ ОС ${PLATFORM} не поддерживается: запускайте бота вручную (npm start).`);
  return { ok: false };
}

export function uninstallService({ name = APP.id, dry = false } = {}) {
  if (PLATFORM === 'win32') {
    const nssm = findNssm();
    if (!nssm) return console.log('  ❌ Не найден nssm.'), { ok: false };
    run(nssm, ['stop', name], { dry });
    const r = run(nssm, ['remove', name, 'confirm'], { dry });
    return { ok: r.status === 0 };
  }
  if (PLATFORM === 'linux') {
    run('systemctl', ['--user', 'disable', '--now', name], { dry });
    const file = join(homedir(), '.config', 'systemd', 'user', `${name}.service`);
    if (!dry) rmSync(file, { force: true });
    run('systemctl', ['--user', 'daemon-reload'], { dry });
    return { ok: true };
  }
  if (PLATFORM === 'darwin') {
    run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}/${APP.launchdLabel}`], { dry });
    if (!dry) rmSync(join(homedir(), 'Library', 'LaunchAgents', `${APP.launchdLabel}.plist`), { force: true });
    return { ok: true };
  }
  return { ok: false };
}

export function serviceStatus({ name = APP.id } = {}) {
  if (PLATFORM === 'win32') {
    const nssm = findNssm();
    return nssm ? run(nssm, ['status', name]) : { status: 1, stdout: '', stderr: 'nssm не найден' };
  }
  if (PLATFORM === 'linux') return run('systemctl', ['--user', 'status', name, '--no-pager']);
  if (PLATFORM === 'darwin') return run('launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${APP.launchdLabel}`]);
  return { status: 1, stdout: '', stderr: 'не поддерживается' };
}

// node src/service.mjs install|uninstall|status [--name <имя>] [--dry-run] [--system]
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const i = rest.indexOf('--name');
  const name = i >= 0 ? rest[i + 1] : APP.id;
  const dry = rest.includes('--dry-run');
  let r;
  if (cmd === 'install') {
    // в терминале — с вопросами (учётная запись Windows, переустановка); без терминала — только с --system
    const { prompter } = await import('./prompt.mjs');
    const prompt = process.stdin.isTTY && !dry ? prompter() : null;
    try {
      r = await installService({ name, dry, prompt, allowSystem: rest.includes('--system') || dry });
    } finally {
      prompt?.close();
    }
  } else if (cmd === 'uninstall') r = uninstallService({ name, dry });
  else if (cmd === 'status') {
    r = serviceStatus({ name });
    console.log(r.stdout || r.stderr);
    r = { ok: r.status === 0 };
  } else {
    console.log('Использование: node src/service.mjs install|uninstall|status [--name <имя>] [--dry-run] [--system]');
    r = { ok: false };
  }
  // без process.exit(): на Windows выход сразу после закрытия readline роняет Node — процесс завершится сам
  process.exitCode = r.ok ? 0 : 1;
}

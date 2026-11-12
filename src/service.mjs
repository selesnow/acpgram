// Регистрация бота как службы: автозапуск с системой и перезапуск при сбое.
//   Windows — служба через nssm (нужны права администратора), Linux — systemd --user, macOS — launchd (LaunchAgent).
// acpgram service install | uninstall | status  (или npm run service:…; флаги: --name <имя>, --dry-run, --system)
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { APP, APP_DIR, DATA_DIR, HOME_DIR, MAIN_PATH } from './app.mjs';
import { decodeOutput, deleteFlagArgs, diagnoseCreate, findOnPath, isGarbled, parseDeleteFlag, parseOemCp, parseTasklistPid, serviceErrorCode, serviceExists, serviceState } from './winsvc.mjs';

// разбор вывода sc.exe — в winsvc.mjs (не зависит от языка Windows); отсюда экспортируется для совместимости
export { serviceErrorCode, serviceState } from './winsvc.mjs';

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
export function systemdUnit({ node, main = MAIN_PATH, dir = HOME_DIR, path = process.env.PATH ?? '', description = APP.description } = {}) {
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
export function launchdPlist({ node, main = MAIN_PATH, dir = HOME_DIR, path = process.env.PATH ?? '', label = APP.launchdLabel } = {}) {
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
export function nssmCommands({ name = APP.id, node, main = MAIN_PATH, dir = HOME_DIR, account = null, label = APP.label, description = APP.description } = {}) {
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
    // Ротация лога только при запуске службы. AppRotateOnline=1 заставляет nssm читать вывод бота через pipe своими потоками,
    // и при остановке nssm.exe зависает в STOP_PENDING (воспроизведено на ноутбуке: служба не останавливается ни штатно,
    // ни через nssm stop; с 0 — 0,8 с). От AppKillProcessTree и учётной записи это не зависит.
    ['set', name, 'AppRotateOnline', '0'],
    ['set', name, 'AppRotateBytes', '10485760'],
    // остановка не должна зависать: Ctrl+C боту (он сам завершает агентов), затем окну и потокам — по 2–3 с,
    // после этого nssm завершает процесс вместе со всеми дочерними (зависший движок не держит службу)
    ['set', name, 'AppStopMethodConsole', '3000'],
    ['set', name, 'AppStopMethodWindow', '2000'],
    ['set', name, 'AppStopMethodThreads', '2000'],
    ['set', name, 'AppKillProcessTree', '1'],
    ...(account ? [['set', name, 'ObjectName', account.user, account.password]] : []),
  ];
}

// ---------- выполнение ----------

/** Кодовая страница OEM (cp866 на русской Windows): в ней консольные программы пишут в канал. Читается из реестра один раз. */
let oemCp = null;
const oemCodePage = () => {
  if (oemCp == null) {
    const r = PLATFORM === 'win32' ? spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'], { encoding: 'latin1', windowsHide: true }) : null;
    oemCp = parseOemCp(r?.stdout);
  }
  return oemCp;
};

// Вывод читается как байты и декодируется по кодовой странице консоли — только для показа пользователю:
// логика (есть ли служба, состояние, причина отказа) от текста не зависит, см. winsvc.mjs
// timeout: ни одна команда не должна подвешивать acpgram навсегда (nssm stop ждёт остановки службы сколько придётся)
const run = (cmd, args, { dry = false, secretAt = -1, quiet = false, timeout = 30_000 } = {}) => {
  const shown = args.map((a, i) => (i === secretAt ? '********' : /\s/.test(a) ? `"${a}"` : a)).join(' ');
  if (!quiet) console.log(`  $ ${cmd} ${shown}`);
  if (dry) return { status: 0, stdout: '', stderr: '' };
  const r = spawnSync(cmd, args, { windowsHide: true, timeout });
  const text = (b) => decodeOutput(b, PLATFORM === 'win32' ? oemCodePage() : 0).trim();
  return { status: r.status, error: r.error?.code, stdout: text(r.stdout), stderr: text(r.stderr) || r.error?.message || '' };
};

const WINGET_LINKS = process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')] : [];

/** nssm: NSSM_PATH, затем PATH (поиск средствами Node — `where` портит пути с кириллицей), затем ссылки WinGet. */
function findNssm() {
  if (process.env.NSSM_PATH && existsSync(process.env.NSSM_PATH)) return process.env.NSSM_PATH;
  return findOnPath('nssm', { exists: existsSync, exts: ['.exe'], extra: WINGET_LINKS });
}

const isWinAdmin = () => spawnSync('net', ['session'], { windowsHide: true, stdio: 'ignore' }).status === 0;

/** Учётная запись Windows текущего пользователя в формате для служб: «.\user» (локальная) или «DOMAIN\user». */
export function windowsAccount(env = process.env, username = userInfo().username) {
  const domain = env.USERDOMAIN;
  return domain && env.COMPUTERNAME && domain.toLowerCase() !== env.COMPUTERNAME.toLowerCase() ? `${domain}\\${username}` : `.\\${username}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Код Windows «служба не запущена из-за ошибки входа» (неверный пароль, PIN вместо пароля, вход без пароля запрещён). */
export const LOGON_FAILURE = 1069;

/** Запускает службу (sc.exe — ради кода ошибки) и ждёт до 10 с, пока nssm не покажет RUNNING. */
async function startAndWait(nssm, name) {
  const s = run('sc.exe', ['start', name]);
  // код выхода sc.exe — это код ошибки Windows (1069 вход, 1056 уже запущена, 1072 помечена для удаления), от языка не зависит;
  // разбор текста — запасной вариант
  const startCode = s.status > 0 ? s.status : serviceErrorCode(`${s.stdout}\n${s.stderr}`);
  let state = '';
  // при ошибке запуска (кроме «уже запущена» — 1056) ждать нечего
  for (let i = 0; i < 10 && !/RUNNING/.test(state) && (!startCode || startCode === 1056); i++) {
    await sleep(1000);
    state = run(nssm, ['status', name], { quiet: true }).stdout;
  }
  const running = /RUNNING/.test(state);
  const code = running ? 0 : startCode ?? serviceErrorCode(run('sc.exe', ['query', name], { quiet: true }).stdout);
  return { running, state: state || 'SERVICE_STOPPED', code };
}

/**
 * Что известно о службе: exists — true / false / null (не удалось спросить: sc.exe запрещён, нет прав), state — по значению
 * из закрытого списка (RUNNING, STOP_PENDING…). Решения «службы нет» и «остановлена» принимаются только по этим данным.
 */
const probe = (name) => {
  const r = run('sc.exe', ['query', name], { quiet: true });
  const exists = serviceExists(r);
  return { exists, state: exists ? serviceState(r.stdout) : null, error: r.error ?? (exists === null ? r.status : null) };
};

/** Помечена ли служба для удаления (DeleteFlag в реестре): Windows удалит её, когда закроются все дескрипторы или после перезагрузки. */
const isMarkedForDelete = (name) => parseDeleteFlag(run('reg', deleteFlagArgs(name), { quiet: true }));

/** PID процесса службы (tasklist: столбцы CSV одинаковы на любом языке); null — процесса нет. */
const servicePid = (name) => parseTasklistPid(run('tasklist', ['/svc', '/fi', `SERVICES eq ${name}`, '/fo', 'csv', '/nh'], { quiet: true }).stdout);

const unknownHint = (p) => `  ❌ Не удалось узнать, есть ли служба (sc.exe: ${p.error ?? 'нет ответа'}). Запустите терминал «от имени администратора»; если защита Windows блокирует sc.exe — проверьте службу в «Службах» (services.msc).`;

/** Сообщение Windows, которое не прочитать в этой кодировке (nssm выводит «?», OEM-текст в UTF-8 даёт U+FFFD), — честно говорим об этом. */
export const winMessage = (text) => (isGarbled(text) ? `${String(text).replace(/[?�\s.]{6,}$/, '').trim()} (текст ошибки Windows не отображается в этой кодировке консоли)`.trim() : text ?? '');

/**
 * Останавливает службу и ждёт остановки. Зависшую (STOP_PENDING: процесс бота или агента не завершается) —
 * добивает: завершает процесс службы вместе со всеми дочерними. Служба, о которой ничего не известно, остановленной не считается.
 */
async function stopService(nssm, name) {
  const stopped = () => {
    const p = probe(name);
    return p.exists === false || p.state === 'STOPPED';
  };
  const t0 = Date.now();
  const secs = () => Math.round((Date.now() - t0) / 1000);
  if (stopped()) return true;
  console.log(`  Останавливаю службу ${name}…`);
  // у зависшей службы nssm ответит «не может принимать команды» — это нормально; ждать его дольше 20 с не будем
  const s = run(nssm, ['stop', name], { quiet: true, timeout: 20_000 });
  if (s.error === 'ETIMEDOUT') console.log(`  nssm не вернул управление за 20 с (${secs()} с с начала) — продолжаю сам`);
  for (let i = 0; i < 15; i++) {
    if (stopped()) {
      console.log(`  Служба остановлена за ${secs()} с.`);
      return true;
    }
    if (i === 5 || i === 10) console.log(`  …жду остановки (${secs()} с, состояние: ${probe(name).state ?? 'неизвестно'})`);
    await sleep(1000);
  }
  const pid = servicePid(name);
  if (pid) {
    console.log(`  Служба ${name} не останавливается — завершаю её процесс (PID ${pid}) вместе с дочерними`);
    run('taskkill', ['/PID', String(pid), '/T', '/F'], { quiet: true });
  } else {
    run('taskkill', ['/F', '/T', '/FI', `SERVICES eq ${name}`], { quiet: true });
  }
  for (let i = 0; i < 10; i++) {
    if (stopped()) return true;
    await sleep(1000);
  }
  return false;
}

/** Удаляет службу и ждёт, пока Windows её действительно удалит (sc.exe: 1060): иначе создать её заново нельзя (ошибка 1072). */
async function removeService(nssm, name) {
  await stopService(nssm, name);
  run(nssm, ['remove', name, 'confirm']);
  for (let i = 0; i < 15; i++) {
    if (probe(name).exists === false) return true;
    await sleep(1000);
  }
  return false;
}

const markedForDeleteHint = (name) =>
  `  ❌ Windows ещё не удалил прежнюю службу ${name} (ошибка 1072 «служба помечена для удаления»).\n` +
  '     Закройте «Службы» (services.msc) и вкладку «Службы» Диспетчера задач и повторите: acpgram service install\n' +
  '     Если не поможет — перезагрузите компьютер: после перезагрузки Windows удалит её окончательно.';

const logHint = () => `Лог: ${join(DATA_DIR, 'service.log')}${PLATFORM === 'win32' ? ` (в PowerShell: Get-Content "${join(DATA_DIR, 'service.log')}" -Tail 30 -Encoding UTF8)` : ''}`;

/** Перезапуск службы: после обновления или смены настроек. Зависшую службу добивает. */
export async function restartService({ name = APP.id } = {}) {
  if (PLATFORM === 'win32') {
    const nssm = findNssm();
    if (!nssm) return console.log('  ❌ Не найден nssm.'), { ok: false };
    if (!isWinAdmin()) return console.log('  ❌ Нужны права администратора: запустите терминал «от имени администратора».'), { ok: false };
    const p = probe(name);
    if (p.exists === null) return console.log(unknownHint(p)), { ok: false };
    if (p.exists === false) return console.log(`  ❌ Служба ${name} не установлена: acpgram service install`), { ok: false };
    // службы, установленные до 1.10.9, созданы с AppRotateOnline=1 (из-за него остановка зависает): чиним без переустановки,
    // новое значение nssm прочитает при запуске
    run(nssm, ['set', name, 'AppRotateOnline', '0'], { quiet: true });
    if (!(await stopService(nssm, name))) console.log(`  ⚠️ Служба ${name} не остановилась (завис процесс или сама служба). Если запуск не получится — перезагрузите компьютер.`);
    const r = await startAndWait(nssm, name);
    if (r.running) console.log(`  ✅ Служба ${name} перезапущена. ${logHint()}`);
    else if (r.code === 1072) console.log(markedForDeleteHint(name));
    else if (r.code === LOGON_FAILURE) console.log(`  ❌ Windows не пустил службу под её учётной записью (неверный пароль; при входе через учётную запись Microsoft нужен её пароль, а не PIN). Переустановите службу: acpgram service install`);
    else console.log(`  ❌ Служба ${name} не запустилась (${r.state}${r.code ? `, код Windows ${r.code}` : ''}). ${logHint()}`);
    return { ok: r.running };
  }
  if (PLATFORM === 'linux') return { ok: run('systemctl', ['--user', 'restart', name]).status === 0 };
  if (PLATFORM === 'darwin') return { ok: run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/${APP.launchdLabel}`]).status === 0 };
  return { ok: false };
}

/**
 * Регистрирует и запускает службу. prompt — диалог (prompt.mjs): учётная запись Windows, переустановка существующей службы.
 * Без диалога на Windows служба ставится от LocalSystem только с allowSystem, иначе — ошибка с подсказкой.
 * @returns {Promise<{ok: boolean}>}
 */
export async function installService({ name = APP.id, dry = false, prompt = null, allowSystem = false } = {}) {
  const node = process.execPath;
  if (!dry) mkdirSync(DATA_DIR, { recursive: true });

  if (PLATFORM === 'win32') {
    const nssm = findNssm();
    if (!nssm) {
      console.log('  ❌ Не найден nssm (менеджер служб Windows). Установите: winget install --id NSSM.NSSM -e  (или choco install nssm, или https://nssm.cc) и повторите.');
      return { ok: false };
    }
    if (!dry && !isWinAdmin()) {
      console.log('  ❌ Нужны права администратора: запустите терминал «от имени администратора» и выполните acpgram service install.');
      return { ok: false };
    }
    // служба уже есть: обычно её достаточно перезапустить (новые настройки и код подхватятся); переустановка —
    // только если нужно сменить учётную запись или что-то сломалось
    // Всё проверяется ДО вопроса о пароле: нельзя спрашивать пароль, если службу всё равно не создать.
    if (!dry) {
      const p = probe(name);
      if (p.exists === null) {
        console.log(unknownHint(p));
        return { ok: false };
      }
      if (p.exists && isMarkedForDelete(name)) {
        // прежняя служба уже удалена, но завис её процесс — завершаем его, и Windows дорабатывает удаление
        console.log(`  Служба ${name} помечена для удаления (ошибка Windows 1072) — завершаю её процесс, чтобы Windows закончил удаление…`);
        if (!(await removeService(nssm, name))) {
          console.log(markedForDeleteHint(name));
          return { ok: false };
        }
      } else if (p.exists) {
        if (prompt && (await prompt.yes(`  Служба ${name} уже установлена. Перезапустить её с новыми настройками?`))) {
          const r = await restartService({ name });
          return { ok: r.ok, installed: true };
        }
        if (!prompt || !(await prompt.yes(`  Переустановить службу ${name} заново (например, чтобы сменить учётную запись)?`, false))) {
          console.log(`  Оставляю как есть. Перезапуск: acpgram service restart; удалить: acpgram service uninstall`);
          return { ok: false, installed: true };
        }
        if (!(await removeService(nssm, name))) {
          console.log(markedForDeleteHint(name));
          return { ok: false };
        }
      }
    }
    // служба должна работать от пользователя, у которого авторизованы агенты (Gemini, Claude Code, Antigravity)
    let account = null;
    const user = windowsAccount();
    if (prompt) {
      if (await prompt.yes(`  Запускать службу от вашей учётной записи ${user} (рекомендуется: там авторизованы агенты)?`)) {
        console.log('  Нужен пароль учётной записи Windows. Если вы входите через учётную запись Microsoft — пароль от неё (от почты Microsoft), а не PIN-код.');
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
      console.log(`  ❌ ${winMessage(r.stderr || r.stdout)}`);
      // nssm не называет причину (номера нет, текст на русской Windows нечитаем) — определяем её сами по состоянию службы
      if (args[0] === 'install') {
        const p = probe(name);
        const marked = p.exists === true && isMarkedForDelete(name);
        const keyNameTaken = p.exists === false && run('sc.exe', ['GetKeyName', APP.label], { quiet: true }).status === 0;
        const d = diagnoseCreate({ exists: p.exists, marked, keyNameTaken, nssmStatus: r.status, name });
        console.log(`  ❌ Не удалось создать службу: ${d.text}.`);
        if (d.code === 1072) console.log(markedForDeleteHint(name));
        return { ok: false };
      }
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
    // убеждаемся, что служба действительно работает (бот мог сразу упасть, Windows мог не пустить учётную запись)
    let r = await startAndWait(nssm, name);
    // Ошибка входа: чаще всего это PIN вместо пароля учётной записи Microsoft. Пароль можно ввести заново —
    // служба уже установлена, меняем только учётную запись.
    for (let attempt = 1; !r.running && r.code === LOGON_FAILURE && account && prompt && attempt <= 3; attempt++) {
      console.log(`  ❌ Windows не пустил службу под ${account.user}: неверное имя пользователя или пароль.`);
      // определять тип учётной записи не нужно (это требовало PowerShell, а защита Windows может не пускать его из Node) — даём обе подсказки
      console.log('     Если вы входите через учётную запись Microsoft: нужен пароль от неё (от почты Microsoft), а не PIN-код для входа в Windows.');
      console.log('     Если учётная запись локальная: нужен её пароль; без пароля служба под ней работать не может — задайте пароль.');
      const password = await prompt.secret(`  Пароль для ${account.user} (Enter — не повторять)`);
      if (!password) break;
      const set = run(nssm, ['set', name, 'ObjectName', account.user, password], { secretAt: 4 });
      if (set.status !== 0) {
        console.log(`  ❌ ${winMessage(set.stderr || set.stdout)}`);
        continue;
      }
      r = await startAndWait(nssm, name);
    }
    if (!r.running) {
      console.log(`  ❌ Служба ${name} установлена, но не запущена (${r.state}${r.code ? `, код Windows ${r.code}` : ''}).`);
      if (r.code === LOGON_FAILURE) {
        console.log(`     Задайте верный пароль и запустите (терминал от имени администратора):\n       nssm set ${name} ObjectName ${account?.user ?? windowsAccount()} "<пароль>"\n       acpgram service restart`);
      } else console.log(`     Подробности — ${logHint()}`);
      return { ok: false, installed: true };
    }
    console.log(`  ✅ Служба ${name} работает. ${logHint()}\n     Перезапуск: acpgram service restart · состояние: acpgram service status`);
    return { ok: true, installed: true };
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
    console.log(`  ✅ LaunchAgent ${APP.launchdLabel} запущен. Лог: ${join(DATA_DIR, 'service.log')}`);
    return { ok: true };
  }

  console.log(`  ❌ ОС ${PLATFORM} не поддерживается: запускайте бота вручную (npm start).`);
  return { ok: false };
}

export async function uninstallService({ name = APP.id, dry = false } = {}) {
  if (PLATFORM === 'win32') {
    const nssm = findNssm();
    if (!nssm) return console.log('  ❌ Не найден nssm.'), { ok: false };
    if (dry) {
      run(nssm, ['stop', name], { dry });
      run(nssm, ['remove', name, 'confirm'], { dry });
      return { ok: true };
    }
    if (!isWinAdmin()) return console.log('  ❌ Нужны права администратора: запустите терминал «от имени администратора».'), { ok: false };
    const p = probe(name);
    if (p.exists === null) return console.log(unknownHint(p)), { ok: false };
    if (p.exists === false) return console.log(`  Служба ${name} не установлена.`), { ok: true };
    // зависшую службу (и помеченную для удаления) добиваем и ждём, пока Windows её действительно удалит
    const ok = await removeService(nssm, name);
    console.log(ok ? `  ✅ Служба ${name} удалена.` : markedForDeleteHint(name));
    return { ok };
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
    if (!nssm) return { status: 1, stdout: '', stderr: 'nssm не найден' };
    const r = run(nssm, ['status', name]);
    // служба помечена для удаления: nssm покажет обычное состояние — предупреждаем отдельно
    if (probe(name).exists && isMarkedForDelete(name)) return { ...r, stdout: `${r.stdout}\n${markedForDeleteHint(name)}`.trim() };
    return r;
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
  } else if (cmd === 'uninstall') r = await uninstallService({ name, dry });
  else if (cmd === 'restart') r = await restartService({ name });
  else if (cmd === 'status') {
    r = serviceStatus({ name });
    console.log(r.stdout || r.stderr);
    r = { ok: r.status === 0 };
  } else {
    console.log('Использование: node src/service.mjs install|restart|status|uninstall [--name <имя>] [--dry-run] [--system]');
    r = { ok: false };
  }
  // без process.exit(): на Windows выход сразу после закрытия readline роняет Node — процесс завершится сам
  process.exitCode = r.ok ? 0 : 1;
}

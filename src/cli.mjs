// Команда acpgram (устанавливается install.ps1 / install.sh):
//   acpgram [start]            запустить бота (первый запуск без .env — мастер настройки)
//   acpgram setup              мастер настройки
//   acpgram service <install|restart|status|uninstall> [--name <имя>] [--dry-run] [--system]
//   acpgram update             обновить до последнего релиза (повторный запуск установщика)
//   acpgram version | help
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = () => JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const REPO = 'selesnow/acpgram';
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

export const HELP = `AcpGram — Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex)

  acpgram [start]          запустить бота (первый запуск без настроек откроет мастер)
  acpgram setup            мастер настройки
  acpgram service install  зарегистрировать службу (автозапуск, перезапуск при сбое)
  acpgram service restart  перезапустить службу (после обновления; зависшую — добивает)
  acpgram service status | uninstall
  acpgram update           обновить до последней версии
  acpgram version          версия

Параметры службы: --name <имя>, --dry-run, --system (Windows: от LocalSystem без терминала).
https://github.com/${REPO}`;

/** Разбор аргументов: что запускать. */
export function route(argv) {
  const [cmd = 'start', ...rest] = argv;
  switch (cmd) {
    case 'start':
      return { run: 'main.mjs', args: rest };
    case 'setup':
      return { run: 'setup.mjs', args: rest };
    case 'service':
      if (!['install', 'restart', 'uninstall', 'status'].includes(rest[0])) return { error: 'acpgram service install | restart | status | uninstall' };
      return { run: 'service.mjs', args: rest };
    case 'update':
      return { update: true };
    case 'version':
    case '--version':
    case '-v':
      return { print: version() };
    case 'help':
    case '--help':
    case '-h':
      return { print: HELP };
    default:
      return { error: `Неизвестная команда: ${cmd}\n\n${HELP}` };
  }
}

/**
 * Команда обновления: тот же установщик, что и для установки (настройки и данные сохраняются).
 * На Linux / macOS установщик сначала скачивается целиком: при ошибке загрузки обновление завершается с ошибкой,
 * а не «успешно» (в `curl | bash` код выхода curl теряется).
 */
export function updateCommand(platform = process.platform, env = process.env) {
  const base = `https://raw.githubusercontent.com/${REPO}/main`;
  if (platform !== 'win32') return ['sh', ['-c', `f="$(mktemp)" && curl -fsSL ${base}/install.sh -o "$f" && bash "$f"; r=$?; rm -f "$f"; exit $r`]];
  // Windows PowerShell — по полному пути: папки WindowsPowerShell может не быть в PATH, а терминал при этом открыт
  // из меню «Пуск» и работает (так было на ноутбуке: `acpgram update` молча завершался с кодом 1)
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const ps = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [existsSync(ps) ? ps : 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${base}/install.ps1 | iex`]];
}

/** Окружение для обновления: установщик обновляет именно эту установку (ACPGRAM_HOME), а не папку по умолчанию. */
export const updateEnv = (env = process.env, appDir = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')) => ({
  ...env,
  ACPGRAM_HOME: env.ACPGRAM_HOME || appDir,
});

/** Запущен ли модуль как команда (сравниваем реальные пути: команда может вести сюда через симлинк или junction). */
const isMain = () => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
};

if (isMain()) {
  const r = route(process.argv.slice(2));
  if (r.print) console.log(r.print);
  else if (r.error) {
    console.error(r.error);
    process.exitCode = 2;
  } else {
    // отдельный процесс: так у мастера и службы честный терминал и свой код выхода
    const before = version();
    if (r.update) console.log(`Обновляю AcpGram (сейчас ${before}) до последней версии…`);
    const [cmd, args] = r.update ? updateCommand() : [process.execPath, [...NODE_FLAGS, fileURLToPath(new URL(`./${r.run}`, import.meta.url)), ...r.args]];
    const env = r.update ? updateEnv() : process.env;
    let res = spawnSync(cmd, args, { stdio: 'inherit', env });
    // Защита Windows (правила ASR Защитника, антивирус) может запрещать node.exe запускать PowerShell — EPERM / EACCES.
    // Тогда — через cmd.exe: родителем PowerShell будет cmd.exe, а не node.exe. (Новый acpgram.cmd вообще обновляет
    // сам, без Node — этот путь для старых копий команды и прямого запуска cli.mjs.)
    if (r.update && res.error && process.platform === 'win32') {
      console.log(`Не удалось запустить PowerShell из Node (${res.error.code}) — пробую через cmd.exe…`);
      res = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map((a) => (/[\s|]/.test(a) ? `"${a}"` : a)).join(' ')}"`], {
        stdio: 'inherit',
        env,
        windowsVerbatimArguments: true,
      });
    }
    // никогда не молчим: если процесс не удалось запустить — говорим почему и что делать
    if (res.error) {
      console.error(`Не удалось запустить ${cmd}: ${res.error.message}`);
      if (/EPERM|EACCES/.test(res.error.code ?? '')) console.error('Запуск, похоже, блокирует защита Windows или антивирус.');
      if (r.update) console.error(`Обновите вручную:\n  ${process.platform === 'win32' ? `irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex` : `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`}`);
    } else if (r.update) {
      const after = version();
      console.log(res.status === 0 ? `\nAcpGram: ${before} → ${after}${before === after ? ' (уже последняя версия)' : ''}` : `\nОбновление не завершилось (код ${res.status}), версия ${after}`);
    }
    process.exitCode = res.status ?? 1;
  }
}

// Команда acpgram (устанавливается install.ps1 / install.sh):
//   acpgram [start]            запустить бота (первый запуск без .env — мастер настройки)
//   acpgram setup              мастер настройки
//   acpgram service <install|uninstall|status> [--name <имя>] [--dry-run] [--system]
//   acpgram update             обновить до последнего релиза (повторный запуск установщика)
//   acpgram version | help
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = () => JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
const REPO = 'selesnow/acpgram';
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

export const HELP = `AcpGram — Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI)

  acpgram [start]          запустить бота (первый запуск без настроек откроет мастер)
  acpgram setup            мастер настройки
  acpgram service install  зарегистрировать службу (автозапуск, перезапуск при сбое)
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
      if (!['install', 'uninstall', 'status'].includes(rest[0])) return { error: 'acpgram service install | uninstall | status' };
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
export function updateCommand(platform = process.platform) {
  const base = `https://raw.githubusercontent.com/${REPO}/main`;
  return platform === 'win32'
    ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${base}/install.ps1 | iex`]]
    : ['sh', ['-c', `f="$(mktemp)" && curl -fsSL ${base}/install.sh -o "$f" && bash "$f"; r=$?; rm -f "$f"; exit $r`]];
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
    const [cmd, args] = r.update ? updateCommand() : [process.execPath, [...NODE_FLAGS, fileURLToPath(new URL(`./${r.run}`, import.meta.url)), ...r.args]];
    const res = spawnSync(cmd, args, { stdio: 'inherit', env: r.update ? updateEnv() : process.env });
    process.exitCode = res.status ?? 1;
  }
}

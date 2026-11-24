// Имя приложения и пути установки — в одном месте.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = {
  /** Идентификатор: имя службы (nssm, systemd), каталог установки. */
  id: 'acpgram',
  /** Название для людей. */
  label: 'AcpGram',
  /** Описание службы. */
  description: 'Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex, OpenCode) по Agent Client Protocol',
  /** Метка launchd (macOS). */
  launchdLabel: 'io.github.acpgram',
};

/** Папка пакета приложения (где лежат src/, package.json) — не зависит от текущей папки запуска. */
const APP_DIR = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
export const MAIN_PATH = fileURLToPath(new URL('./main.mjs', import.meta.url));

/**
 * Каталог пользовательских данных (.env, data/bot.db, data/service.log).
 * 1. ACPGRAM_HOME (если явно задан в окружении)
 * 2. Если APP_DIR внутри node_modules (установка через npm) -> ~/.acpgram, чтобы npm update не стирал данные
 * 3. Иначе (локальный клон, dev, install.ps1/sh, Docker) -> APP_DIR
 */
export function resolveHomeDir(env = process.env, appDir = APP_DIR) {
  if (env.ACPGRAM_HOME) return env.ACPGRAM_HOME;
  if (/[\\/]node_modules[\\/]/.test(appDir)) {
    return join(homedir(), '.acpgram');
  }
  return appDir;
}

/**
 * Положительное число из переменной окружения; пусто, не число, ноль или отрицательное — значение по умолчанию.
 * Без этой проверки «MAX_AGENTS=abc» давало NaN: сравнение с ним всегда ложно, и лимит молча отключался.
 */
export function positiveEnv(name, fallback, env = process.env) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const HOME_DIR = resolveHomeDir();
export const ENV_PATH = join(HOME_DIR, '.env');
export const DATA_DIR = join(HOME_DIR, 'data');

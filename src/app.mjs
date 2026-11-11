// Имя приложения и пути установки — в одном месте.
import { fileURLToPath } from 'node:url';

export const APP = {
  /** Идентификатор: имя службы (nssm, systemd), каталог установки. */
  id: 'acpgram',
  /** Название для людей. */
  label: 'AcpGram',
  /** Описание службы. */
  description: 'Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI) по Agent Client Protocol',
  /** Метка launchd (macOS). */
  launchdLabel: 'io.github.acpgram',
};

/** Папка приложения (где лежат src/, .env, data/) — не зависит от текущей папки запуска. */
export const APP_DIR = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
export const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
export const MAIN_PATH = fileURLToPath(new URL('./main.mjs', import.meta.url));

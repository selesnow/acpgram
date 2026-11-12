// Точка входа (npm start, служба): загружает .env из папки бота (из какой бы папки ни запускали) и запускает бот.
// Если бот ещё не настроен и запуск из терминала — сначала мастер настройки (npm run setup).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ENV_PATH } from './app.mjs';

const configured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.ALLOWED_USER_ID);
const baseEnv = { ...process.env }; // окружение без .env — для перезапуска после мастера

// переменные, уже заданные в окружении (служба, Docker), важнее .env — loadEnvFile их не перезаписывает
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

if (configured()) await import('./bot.mjs');
else if (process.stdin.isTTY && process.stdout.isTTY) {
  const { runSetup } = await import('./setup.mjs');
  const r = await runSetup({ fromStart: true }).catch((e) => (console.error(`\nНастройка не завершена: ${e.message}`), { ok: false }));
  if (!r.ok) process.exitCode = 1;
  else if (!r.service) {
    // Бот — отдельным процессом: модули настроек (движок по умолчанию, корень проектов, токен) читают окружение
    // при загрузке, а мастер уже загрузил часть из них со старыми значениями. Новый процесс прочтёт свежий .env.
    console.log('\nЗапускаю бота…\n');
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename ?? new URL(import.meta.url).pathname], { stdio: 'inherit', env: baseEnv });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    child.on('exit', (code) => (process.exitCode = code ?? 0));
  }
  // зарегистрирован как служба — бот уже работает там; второй экземпляр с тем же токеном конфликтовал бы.
  // Без process.exit(): на Windows выход сразу после закрытия readline роняет Node — процесс завершится сам.
} else {
  console.error(`Бот не настроен: нет ${ENV_PATH} с TELEGRAM_BOT_TOKEN и ALLOWED_USER_ID. Запустите в терминале: acpgram setup`);
  process.exitCode = 1;
}

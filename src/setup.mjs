// Мастер настройки: npm run setup (и автоматически при первом npm start без .env).
// Токен (проверка getMe) → администратор (определяется по сообщению боту) → корень проектов → движки и ключи API →
// .env → база → тестовое сообщение администратору → по желанию регистрация службы.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { APP, APP_DIR, ENV_PATH } from './app.mjs';
import { ENGINES, checkEngines } from './engines.mjs';
import { prompter } from './prompt.mjs';
import { findOnPath } from './winsvc.mjs';

const IS_WIN = process.platform === 'win32';

// ---------- .env: чтение и запись ----------

/** Значения .env (как их прочтёт Node). */
export const readEnvFile = (path = ENV_PATH) => (existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {});

/**
 * Значение для .env так, чтобы Node (parseEnv, --env-file, loadEnvFile) прочитал его без изменений.
 * Без кавычек — если нет «#», пробелов по краям и кавычки в начале (апостроф в середине, как в C:\Users\O'Neil, можно).
 * Иначе — в одинарных или обратных кавычках (содержимое буквальное). Двойные не используем: в них Node превращает \n
 * в перенос строки, а в путях Windows «\n» встречается постоянно (…\npm\…).
 */
export function envValue(v) {
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error('значение в .env не может содержать перенос строки');
  if (!/#|^\s|\s$|^['"`]/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('`')) return `\`${s}\``;
  throw new Error('значение нельзя записать в .env: в нём одновременно «#»/пробел по краям, апостроф и обратная кавычка');
}

/** Порядок и комментарии основных переменных в .env, созданном мастером. */
const LAYOUT = [
  ['TELEGRAM_BOT_TOKEN', 'Токен бота от @BotFather (секрет: файл не публикуйте и не коммитьте)'],
  ['ALLOWED_USER_ID', 'Telegram ID главного администратора'],
  ['PROJECTS_ROOT', 'Корень проектов (необязательно): без него проектом может быть любая папка, по умолчанию домашняя'],
  ['DEFAULT_ENGINE', 'Движок по умолчанию: gemini | claude | agy | codex'],
  ['GEMINI_COMMAND', null],
  ['CLAUDE_COMMAND', null],
  ['AGY_COMMAND', null],
  ['CODEX_COMMAND', null],
  ['GEMINI_API_KEY', 'Ключи API передаются агентам через окружение бота'],
  ['ANTHROPIC_API_KEY', null],
  ['OPENAI_API_KEY', null],
];

/**
 * Текст .env: основные переменные по порядку с комментариями, затем остальные ранее заданные (не теряем ручные настройки).
 * Пустые значения не пишутся.
 */
export function serializeEnv(values, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [`# Создано мастером настройки ${APP.label} (npm run setup), ${date}. Все переменные — в .env.example`, ''];
  const known = new Set(LAYOUT.map(([k]) => k));
  const has = (k) => values[k] != null && String(values[k]) !== '';
  for (const [key, comment] of LAYOUT) {
    if (!has(key)) continue;
    if (comment) lines.push(`# ${comment}`);
    lines.push(`${key}=${envValue(values[key])}`);
  }
  const rest = Object.keys(values).filter((k) => !known.has(k) && has(k));
  if (rest.length) {
    lines.push('', '# Прочие настройки');
    for (const k of rest) lines.push(`${k}=${envValue(values[k])}`);
  }
  return lines.join('\n') + '\n';
}

/** Где лежит копия прежнего .env: в data/ (не попадает в git и в образ Docker). */
export const envBackupPath = (dataDir = join(APP_DIR, 'data')) => join(dataDir, '.env.bak');

/**
 * Пишет .env; прежний сохраняется в data/.env.bak. Оба файла — только для владельца (0600): mode в writeFileSync
 * действует лишь при создании файла, поэтому права выставляются явно (на Windows chmod ничего не меняет).
 */
export function writeEnvFile(values, path = ENV_PATH, backup = envBackupPath()) {
  const text = serializeEnv(values); // сначала проверяем, что всё записывается, — до изменения файлов
  if (existsSync(path)) {
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------- Telegram ----------

async function api(token, method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
  return data.result;
}

/** Автор первого личного сообщения боту (не бота) из списка обновлений, или null. */
export function pickAdmin(updates) {
  for (const u of updates ?? []) {
    const m = u?.message;
    if (m?.chat?.type === 'private' && m.from && !m.from.is_bot) return m.from;
  }
  return null;
}

/** Ждёт личное сообщение боту и возвращает его автора. */
async function waitForAdmin(token, timeoutMs = 180_000) {
  await api(token, 'deleteWebhook').catch(() => {});
  const old = await api(token, 'getUpdates', { offset: -1, timeout: 0 });
  let offset = old.length ? old[old.length - 1].update_id + 1 : 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const updates = await api(token, 'getUpdates', { offset, timeout: 20, allowed_updates: ['message'] });
    if (updates.length) offset = updates[updates.length - 1].update_id + 1;
    const from = pickAdmin(updates);
    if (from) {
      await api(token, 'getUpdates', { offset, timeout: 0 }).catch(() => {}); // подтверждаем полученное
      return from;
    }
  }
  return null;
}

// ---------- движки ----------

/** Полный путь к команде через PATH (where / command -v), или null. */
export function resolveCommandPath(cmd) {
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : null;
  // Windows: поиск по PATH средствами Node — `where` печатает пути в OEM-кодировке (cp866), и в профиле с кириллицей они портятся.
  // Для npm-пакетов нужен .cmd, а не одноимённый скрипт без расширения.
  if (IS_WIN) return findOnPath(cmd, { exists: existsSync });
  const r = spawnSync('sh', ['-c', `command -v "${cmd.replace(/"/g, '')}"`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

// ---------- диалог (prompt.mjs) ----------

const ok = (s) => console.log(`  ✅ ${s}`);
const warn = (s) => console.log(`  ⚠️  ${s}`);
const step = (n, s) => console.log(`\n[${n}] ${s}`);

/**
 * Интерактивная настройка. Возвращает {ok, service}: ok — .env создан; service — бот зарегистрирован и запущен как служба.
 * @param {{fromStart?: boolean}} [o] fromStart — вызвана из npm start (после настройки бот запустится в этом окне)
 */
export async function runSetup({ fromStart = false } = {}) {
  const p = prompter();
  const env = { ...readEnvFile() };
  try {
    console.log(`\n${APP.label} — настройка${existsSync(ENV_PATH) ? ' (текущие значения — в скобках, Enter оставляет их)' : ''}`);
    if (fromStart) console.log('Бот ещё не настроен — ответьте на несколько вопросов.');

    // 1. токен
    step(1, 'Токен бота: создайте бота у @BotFather (/newbot) и вставьте токен');
    let me;
    for (;;) {
      const token = (await p.secret(env.TELEGRAM_BOT_TOKEN ? 'Токен (Enter — оставить текущий)' : 'Токен')) || env.TELEGRAM_BOT_TOKEN;
      if (!token) continue;
      try {
        me = await api(token, 'getMe');
        env.TELEGRAM_BOT_TOKEN = token;
        ok(`бот @${me.username} (${me.first_name})`);
        break;
      } catch (e) {
        warn(`токен не подошёл: ${e.message}`);
      }
    }

    // 2. администратор
    step(2, 'Главный администратор');
    let adminId = env.ALLOWED_USER_ID;
    if (adminId && (await p.yes(`Оставить администратора с ID ${adminId}?`))) ok(`администратор ${adminId}`);
    else {
      adminId = null;
      console.log(`  Напишите боту @${me.username} в Telegram любое сообщение (например /start) с вашего аккаунта — жду до 3 минут…`);
      try {
        const from = await waitForAdmin(env.TELEGRAM_BOT_TOKEN);
        if (from && (await p.yes(`  Это вы: ${from.username ? '@' + from.username : from.first_name} (ID ${from.id})?`))) adminId = String(from.id);
      } catch (e) {
        warn(`не удалось получить сообщения бота: ${e.message}${/conflict/i.test(e.message) ? ' — похоже, бот уже где-то запущен; остановите его' : ''}`);
      }
      while (!/^\d+$/.test(adminId ?? '')) adminId = await p.ask('  Введите ваш числовой Telegram ID (его покажет @userinfobot)');
      env.ALLOWED_USER_ID = adminId;
      ok(`администратор ${adminId}`);
    }

    // 3. корень проектов
    step(3, 'Корень проектов (необязательно)');
    console.log('  Задайте для общего сервера, где бот работает у нескольких сотрудников: проектом можно будет выбрать только папку внутри корня.');
    console.log('  Для личной установки оставьте пустым — проектом сможет быть любая папка, по умолчанию домашняя.');
    for (;;) {
      const v = await p.ask('  Папка (Enter — без корня; «-» — убрать)', env.PROJECTS_ROOT);
      if (!v || v === '-') {
        delete env.PROJECTS_ROOT;
        ok('без корня: любая папка, по умолчанию домашняя');
        break;
      }
      const { resolveRoot } = await import('./projects.mjs');
      try {
        env.PROJECTS_ROOT = resolveRoot(v);
        ok(`корень ${env.PROJECTS_ROOT}`);
        break;
      } catch (e) {
        warn(e.message);
      }
    }

    // 4. движки
    step(4, 'AI-движки (проверяю установленные)');
    const engines = Object.values(ENGINES);
    const found = {};
    for (const e of engines) {
      const cmd = env[e.envVar] || e.defaultCommand;
      const full = resolveCommandPath(cmd);
      if (full) found[e.id] = full;
    }
    const checks = await checkEngines(engines.filter((e) => found[e.id]).map((e) => ({ ...e, defaultCommand: found[e.id], envVar: '__SETUP_NONE__' })), 60_000);
    const available = [];
    for (const e of engines) {
      const c = checks.find((r) => r.engine.id === e.id);
      if (c?.ok || c?.timeout) {
        available.push(e.id);
        // полный путь: под службой PATH пользователя может быть недоступен
        env[e.envVar] = found[e.id];
        ok(`${e.label} ${c.version ?? ''} — ${found[e.id]}`);
      } else if (c?.tooOld) {
        // запускается, но слишком старый (у Antigravity до 1.5 нет `agy acp`) — бот его не предложит
        env[e.envVar] = found[e.id];
        warn(`${e.label}: ${c.error}. Пока не обновите, бот этот движок не предложит`);
      } else console.log(`  ❌ ${e.label} не найден. Установка: ${e.install}`);
    }
    if (!available.length) warn('ни один движок не найден — установите хотя бы один и запустите npm run setup ещё раз');
    else {
      const def = available.includes(env.DEFAULT_ENGINE) ? env.DEFAULT_ENGINE : available.includes('gemini') ? 'gemini' : available[0];
      let choice = available.length === 1 ? available[0] : await p.ask(`  Движок по умолчанию (${available.join(' / ')})`, def);
      if (!available.includes(choice)) choice = def;
      env.DEFAULT_ENGINE = choice;
      ok(`движок по умолчанию: ${ENGINES[choice].label}`);
    }

    // 5. ключи API
    step(5, 'Ключи API (необязательно: Enter — пропустить или оставить текущий)');
    const askKey = async (name, hint) => {
      const v = await p.secret(`  ${name}${hint}${env[name] ? ' (задан)' : process.env[name] ? ' (есть в окружении)' : ''}`);
      if (v) env[name] = v;
      // Ключ есть только в переменных окружения пользователя: служба (Windows) их не видит, даже работая от этого
      // пользователя, — предлагаем сохранить в .env.
      else if (!env[name] && process.env[name] && (await p.yes(`    Сохранить ${name} из окружения в .env (служба не видит переменные окружения пользователя)?`))) env[name] = process.env[name];
    };
    if (available.includes('gemini')) await askKey('GEMINI_API_KEY', '');
    if (available.includes('claude')) await askKey('ANTHROPIC_API_KEY', ' — Claude Code по API, без него по подписке');
    if (available.includes('codex')) await askKey('OPENAI_API_KEY', ' — Codex по API, без него по входу ChatGPT (codex login)');
    if (available.includes('agy')) console.log('  Antigravity CLI: ключа API нет — войдите один раз: agy acp --login');

    // 6. запись
    step(6, 'Сохраняю настройки');
    const hadEnv = existsSync(ENV_PATH);
    try {
      writeEnvFile(env);
    } catch (e) {
      warn(`настройки не сохранены: ${e.message}`);
      return { ok: false, service: false };
    }
    ok(`${ENV_PATH}${hadEnv ? ` (прежний — ${envBackupPath()})` : ''}`);
    mkdirSync(join(APP_DIR, 'data'), { recursive: true });
    const { openDb } = await import('./db.mjs');
    openDb(join(APP_DIR, 'data', 'bot.db')).close();
    ok('база data/bot.db');
    try {
      await api(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: adminId, text: `✅ ${APP.label} настроен. Вы — главный администратор. После запуска бота нажмите /start.` });
      ok('тестовое сообщение отправлено вам в Telegram');
    } catch (e) {
      warn(`тестовое сообщение не отправлено: ${e.message} (напишите боту /start и проверьте ID)`);
    }

    // 7. служба
    step(7, 'Запуск');
    if (await p.yes('  Зарегистрировать бота как службу (автозапуск с системой, перезапуск при сбое)?', !fromStart)) {
      const { installService } = await import('./service.mjs');
      const r = await installService({ prompt: p });
      if (r.ok) return { ok: true, service: true };
      warn(r.installed ? 'служба зарегистрирована, но не запустилась (см. выше) — бот можно запустить вручную: acpgram' : 'служба не зарегистрирована — бот можно запустить вручную: acpgram');
    } else console.log('  Запуск вручную: acpgram   ·   служба позже: acpgram service install');
    return { ok: true, service: false };
  } finally {
    p.close();
  }
}

// запуск напрямую: node src/setup.mjs
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // понятная ошибка вместо трассировки (например, ввод закрылся раньше времени)
  const r = await runSetup().catch((e) => (console.error(`\nНастройка не завершена: ${e.message}`), { ok: false }));
  // без process.exit(): на Windows выход сразу после закрытия readline роняет Node (UV_HANDLE_CLOSING) — даём завершиться самому
  process.exitCode = r.ok ? 0 : 1;
}

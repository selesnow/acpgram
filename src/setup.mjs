// Мастер настройки: npm run setup (и автоматически при первом npm start без .env).
// Токен (проверка getMe) → администратор (определяется по сообщению боту) → корень проектов → движки и ключи API →
// .env → база → тестовое сообщение администратору → по желанию регистрация службы.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { APP, APP_DIR, DATA_DIR, ENV_PATH, HOME_DIR } from './app.mjs';
import { getCliLang, tc } from './cli-i18n.mjs';
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
  if (/[\r\n]/.test(s)) throw new Error(tc('env.noNewline'));
  if (!/#|^\s|\s$|^['"`]/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('`')) return `\`${s}\``;
  throw new Error(tc('env.cannotQuote'));
}

/** Порядок и комментарии (ключи словаря) основных переменных в .env, созданном мастером. */
const LAYOUT = [
  ['TELEGRAM_BOT_TOKEN', 'env.c.token'],
  ['ALLOWED_USER_ID', 'env.c.admin'],
  ['PROJECTS_ROOT', 'env.c.root'],
  ['DEFAULT_ENGINE', 'env.c.engine'],
  ['GEMINI_COMMAND', null],
  ['CLAUDE_COMMAND', null],
  ['AGY_COMMAND', null],
  ['CODEX_COMMAND', null],
  ['GEMINI_API_KEY', 'env.c.keys'],
  ['ANTHROPIC_API_KEY', null],
  ['OPENAI_API_KEY', null],
];

/**
 * Текст .env: основные переменные по порядку с комментариями, затем остальные ранее заданные (не теряем ручные настройки).
 * Пустые значения не пишутся.
 */
export function serializeEnv(values, { date = new Date().toISOString().slice(0, 10), lang = getCliLang() } = {}) {
  const lines = [tc('env.header', { label: APP.label, date }, lang), ''];
  const known = new Set(LAYOUT.map(([k]) => k));
  const has = (k) => values[k] != null && String(values[k]) !== '';
  for (const [key, comment] of LAYOUT) {
    if (!has(key)) continue;
    if (comment) lines.push(`# ${tc(comment, {}, lang)}`);
    lines.push(`${key}=${envValue(values[key])}`);
  }
  const rest = Object.keys(values).filter((k) => !known.has(k) && has(k));
  if (rest.length) {
    lines.push('', `# ${tc('env.rest', {}, lang)}`);
    for (const k of rest) lines.push(`${k}=${envValue(values[k])}`);
  }
  return lines.join('\n') + '\n';
}

/** Где лежит копия прежнего .env: в data/ (не попадает в git и в образ Docker). */
export const envBackupPath = (dataDir = DATA_DIR) => join(dataDir, '.env.bak');

/**
 * Пишет .env; прежний сохраняется в data/.env.bak. Оба файла — только для владельца (0600): mode в writeFileSync
 * действует лишь при создании файла, поэтому права выставляются явно (на Windows chmod ничего не меняет).
 */
export function writeEnvFile(values, path = ENV_PATH, backup = envBackupPath()) {
  const text = serializeEnv(values); // сначала проверяем, что всё записывается, — до изменения файлов
  mkdirSync(dirname(path), { recursive: true }); // при установке через npm каталога (~/.acpgram) ещё нет
  if (existsSync(path)) {
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------- перенос из прежней установки (install.ps1 / install.sh) ----------

/** Где установщики с GitHub (install.ps1 / install.sh) хранят .env и data/ по умолчанию. */
export function legacyHomeDirs(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32') return env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'acpgram')] : [];
  return [join(home, '.local', 'share', 'acpgram')];
}

/** Каталог прежней установки с .env (не текущий), или undefined. */
export function findLegacyHome({ current = HOME_DIR, dirs = legacyHomeDirs(), exists = existsSync } = {}) {
  return dirs.find((d) => resolve(d) !== resolve(current) && exists(join(d, '.env')));
}

/** Копирует базу бота (с WAL-файлами) из прежней установки, если в новом каталоге её ещё нет. Возвращает true, если скопировано. */
export function copyLegacyDb(legacyDir, dataDir = DATA_DIR) {
  const from = join(legacyDir, 'data', 'bot.db');
  if (!existsSync(from) || existsSync(join(dataDir, 'bot.db'))) return false;
  mkdirSync(dataDir, { recursive: true });
  for (const f of ['bot.db', 'bot.db-wal', 'bot.db-shm']) {
    if (existsSync(join(legacyDir, 'data', f))) copyFileSync(join(legacyDir, 'data', f), join(dataDir, f));
  }
  return true;
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
    console.log(tc('setup.title', { label: APP.label, hint: existsSync(ENV_PATH) ? tc('setup.titleHint') : '' }));
    if (fromStart) console.log(tc('setup.fromStart'));

    // Прежняя установка через install.ps1 / install.sh хранит данные в другом каталоге — предлагаем перенести
    const legacy = existsSync(ENV_PATH) ? undefined : findLegacyHome();
    if (legacy) {
      console.log(tc('setup.legacyFound', { dir: legacy }));
      console.log(tc('setup.legacyNote'));
      if (await p.yes(tc('setup.legacyAsk'))) {
        Object.assign(env, readEnvFile(join(legacy, '.env')));
        ok(tc('setup.legacyRead', { path: join(legacy, '.env') }));
        try {
          if (copyLegacyDb(legacy)) ok(tc('setup.legacyDb', { dir: DATA_DIR }));
        } catch (e) {
          warn(tc('setup.legacyDbFail', { msg: e.message }));
        }
      }
    }

    // 1. токен
    step(1, tc('setup.s1'));
    let me;
    for (;;) {
      const token = (await p.secret(env.TELEGRAM_BOT_TOKEN ? tc('setup.tokenKeep') : tc('setup.token'))) || env.TELEGRAM_BOT_TOKEN;
      if (!token) continue;
      try {
        me = await api(token, 'getMe');
        env.TELEGRAM_BOT_TOKEN = token;
        ok(tc('setup.botOk', { username: me.username, name: me.first_name }));
        break;
      } catch (e) {
        warn(tc('setup.tokenBad', { msg: e.message }));
      }
    }

    // 2. администратор
    step(2, tc('setup.s2'));
    let adminId = env.ALLOWED_USER_ID;
    if (adminId && (await p.yes(tc('setup.adminKeep', { id: adminId })))) ok(tc('setup.adminOk', { id: adminId }));
    else {
      adminId = null;
      console.log(tc('setup.adminWait', { username: me.username }));
      try {
        const from = await waitForAdmin(env.TELEGRAM_BOT_TOKEN);
        if (from && (await p.yes(tc('setup.adminIsYou', { who: from.username ? '@' + from.username : from.first_name, id: from.id })))) adminId = String(from.id);
      } catch (e) {
        warn(tc('setup.adminFetchFail', { msg: e.message, hint: /conflict/i.test(e.message) ? tc('setup.conflictHint') : '' }));
      }
      while (!/^\d+$/.test(adminId ?? '')) adminId = await p.ask(tc('setup.adminAskId'));
      env.ALLOWED_USER_ID = adminId;
      ok(tc('setup.adminOk', { id: adminId }));
    }

    // 3. корень проектов
    step(3, tc('setup.s3'));
    console.log(tc('setup.rootNote1'));
    console.log(tc('setup.rootNote2'));
    for (;;) {
      const v = await p.ask(tc('setup.rootAsk'), env.PROJECTS_ROOT);
      if (!v || v === '-') {
        delete env.PROJECTS_ROOT;
        ok(tc('setup.rootNone'));
        break;
      }
      const { resolveRoot } = await import('./projects.mjs');
      try {
        env.PROJECTS_ROOT = resolveRoot(v);
        ok(tc('setup.rootOk', { root: env.PROJECTS_ROOT }));
        break;
      } catch (e) {
        warn(e.message);
      }
    }

    // 4. движки
    step(4, tc('setup.s4'));
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
        ok(tc('setup.engineOk', { label: e.label, version: c.version ?? '', path: found[e.id] }));
      } else if (c?.tooOld) {
        // запускается, но слишком старый (у Antigravity до 1.5 нет `agy acp`) — бот его не предложит
        env[e.envVar] = found[e.id];
        warn(tc('setup.engineOld', { label: e.label, error: c.error }));
      } else console.log(tc('setup.engineMissing', { label: e.label, install: e.install }));
    }
    if (!available.length) warn(tc('setup.noEngine'));
    else {
      const def = available.includes(env.DEFAULT_ENGINE) ? env.DEFAULT_ENGINE : available.includes('gemini') ? 'gemini' : available[0];
      let choice = available.length === 1 ? available[0] : await p.ask(tc('setup.engineAsk', { list: available.join(' / ') }), def);
      if (!available.includes(choice)) choice = def;
      env.DEFAULT_ENGINE = choice;
      ok(tc('setup.engineDefault', { label: ENGINES[choice].label }));
    }

    // 5. ключи API
    step(5, tc('setup.s5'));
    const askKey = async (name, hint) => {
      const v = await p.secret(`  ${name}${hint}${env[name] ? tc('setup.keySet') : process.env[name] ? tc('setup.keyEnv') : ''}`);
      if (v) env[name] = v;
      // Ключ есть только в переменных окружения пользователя: служба (Windows) их не видит, даже работая от этого
      // пользователя, — предлагаем сохранить в .env.
      else if (!env[name] && process.env[name] && (await p.yes(tc('setup.keySave', { name })))) env[name] = process.env[name];
    };
    if (available.includes('gemini')) await askKey('GEMINI_API_KEY', '');
    if (available.includes('claude')) await askKey('ANTHROPIC_API_KEY', tc('setup.keyClaude'));
    if (available.includes('codex')) await askKey('OPENAI_API_KEY', tc('setup.keyCodex'));
    if (available.includes('agy')) console.log(tc('setup.agyNote'));

    // 6. запись
    step(6, tc('setup.s6'));
    const hadEnv = existsSync(ENV_PATH);
    try {
      writeEnvFile(env);
    } catch (e) {
      warn(tc('setup.saveFail', { msg: e.message }));
      return { ok: false, service: false };
    }
    ok(tc('setup.envOk', { path: ENV_PATH, prev: hadEnv ? tc('setup.envPrev', { backup: envBackupPath() }) : '' }));
    mkdirSync(DATA_DIR, { recursive: true });
    const { openDb } = await import('./db.mjs');
    openDb(join(DATA_DIR, 'bot.db')).close();
    ok(tc('setup.dbOk'));
    try {
      await api(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: adminId, text: tc('setup.testText', { label: APP.label }) });
      ok(tc('setup.testOk'));
    } catch (e) {
      warn(tc('setup.testFail', { msg: e.message }));
    }

    // 7. служба
    step(7, tc('setup.s7'));
    if (await p.yes(tc('setup.serviceAsk'), !fromStart)) {
      const { installService } = await import('./service.mjs');
      const r = await installService({ prompt: p });
      if (r.ok) return { ok: true, service: true };
      warn(r.installed ? tc('setup.serviceStartFail') : tc('setup.serviceFail'));
    } else console.log(tc('setup.manual'));
    return { ok: true, service: false };
  } finally {
    p.close();
  }
}

// запуск напрямую: node src/setup.mjs
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // понятная ошибка вместо трассировки (например, ввод закрылся раньше времени)
  const r = await runSetup().catch((e) => (console.error(tc('main.setupFailed', { msg: e.message })), { ok: false }));
  // без process.exit(): на Windows выход сразу после закрытия readline роняет Node (UV_HANDLE_CLOSING) — даём завершиться самому
  process.exitCode = r.ok ? 0 : 1;
}

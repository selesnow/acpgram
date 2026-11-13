// Общие настройки, база, логирование и отправка сообщений — используются всеми модулями бота.
import { mkdirSync } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './app.mjs';
import { openDb } from './db.mjs';
import { normLang, pickLang, t } from './i18n.mjs';

export { DATA_DIR };
import { dest, tg } from './telegram.mjs';

/** Главный администратор: ID задан в .env, отозвать доступ у него из бота нельзя. */
export const ADMIN_ID = Number(process.env.ALLOWED_USER_ID);
/** Максимум одновременно работающих агентов сотрудников. Администратор вне лимита. */
export const MAX_AGENTS = Number(process.env.MAX_AGENTS || 3);
/** Через сколько минут простоя сессия закрывается. */
export const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 30);
export const IDLE_MS = IDLE_MINUTES * 60_000;

/** Уровни доступа сотрудников по порядку. Названия и описания — в i18n.mjs. Режим сессии для уровня у каждого движка свой (engines.mjs). */
export const LEVEL_KEYS = ['read', 'normal', 'full'];
export const isLevel = (key) => LEVEL_KEYS.includes(key);
export const levelName = (key, lang) => t(`level.${key}.label`, lang);
export const levelHint = (key, lang) => t(`level.${key}.hint`, lang);

// Язык из настроек Telegram пользователя (language_code): userId -> en | ru | uk | null (язык не поддерживается).
// В памяти — для всех, кто пишет боту (в том числе без доступа); в базу (tglang:<id>) — для пользователей с доступом,
// чтобы бот знал язык и до первого сообщения после перезапуска (например, при уведомлении от администратора).
const tgLangCache = new Map();
const tgLangSaved = new Map(); // что уже записано в базу в этом запуске: userId -> язык ('' — не поддерживается)
const tgLang = (userId) => (tgLangCache.has(userId) ? tgLangCache.get(userId) : normLang(db.getSetting(`tglang:${userId}`)));

/** Запоминает язык из Telegram (from.language_code). persist — писать в базу (только для пользователей с доступом). */
export function noteTgLang(userId, code, persist = false) {
  const lang = normLang(code);
  tgLangCache.set(userId, lang);
  if (persist && tgLangSaved.get(userId) !== (lang ?? '')) {
    tgLangSaved.set(userId, lang ?? '');
    db.setSetting(`tglang:${userId}`, lang ?? '');
  }
}

/**
 * Язык интерфейса пользователя: выбранный в боте (/language), иначе язык его Telegram (ru, uk, en),
 * иначе язык по умолчанию (DEFAULT_LANG, английский).
 */
export const langOf = (userId) => pickLang(db.getSetting(`lang:${userId}`), tgLang(userId));
export const setLang = (userId, lang) => db.setSetting(`lang:${userId}`, lang);

export const botInfo = { username: null }; // заполняется при старте

export const log = (...a) => console.log(new Date().toISOString(), ...a);

// Подробный журнал того, что бот отправляет в Telegram (для разбора проблем с отображением) — только при
// ACPGRAM_DEBUG=1: черновик пишется каждую секунду, без выключателя и ротации файл рос бесконечно.
// Запись асинхронная, по очереди; больше DEBUG_MAX_BYTES — файл переименовывается в debug.log.1 (хранится один прошлый).
mkdirSync(DATA_DIR, { recursive: true });
export const DEBUG = process.env.ACPGRAM_DEBUG === '1';
export const DEBUG_MAX_BYTES = 5 * 1024 * 1024;
export const createDebugLog = (path, maxBytes = DEBUG_MAX_BYTES) => {
  let queue = Promise.resolve();
  let size = null;
  const write = (kind, text) => {
    const entry = `=== ${new Date().toISOString()} ${kind} (${text.length} симв.)\n${text.slice(0, 1500)}\n`;
    queue = queue
      .then(async () => {
        size ??= await stat(path).then((s) => s.size, () => 0);
        if (size >= maxBytes) {
          await rename(path, `${path}.1`).catch(() => {});
          size = 0;
        }
        await appendFile(path, entry);
        size += Buffer.byteLength(entry);
      })
      .catch(() => {});
    return queue;
  };
  return write;
};
const debugLog = DEBUG ? createDebugLog(join(DATA_DIR, 'debug.log')) : null;
export const dbg = (kind, text) => debugLog?.(kind, text);

// база работы бота: сессии, запросы, вызовы инструментов, разрешения, ответы, сотрудники
export const db = openDb(join(DATA_DIR, 'bot.db'));

/** Сообщение пользователю: to — id чата или {chat_id, message_thread_id} (тема), обычно st.to. */
export const say = (to, text, extra = {}) => tg('sendMessage', { ...dest(to), text, ...extra }).catch((e) => log('sendMessage:', e.message));

/** Как показывать человека в сообщениях администратору. */
export const who = (u) => (u.username ? `@${u.username}` : u.first_name || `id ${u.id ?? u.user_id}`);

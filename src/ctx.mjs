// Общие настройки, база, логирование и отправка сообщений — используются всеми модулями бота.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './app.mjs';
import { openDb } from './db.mjs';
import { normLang, pickLang, t } from './i18n.mjs';

export { DATA_DIR };
import { tg } from './telegram.mjs';

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

// подробный журнал того, что бот отправляет в Telegram (для разбора проблем с отображением)
mkdirSync(DATA_DIR, { recursive: true });
export const dbg = (kind, text) => {
  try {
    appendFileSync(join(DATA_DIR, 'debug.log'), `=== ${new Date().toISOString()} ${kind} (${text.length} симв.)\n${text.slice(0, 1500)}\n`);
  } catch {}
};

// база работы бота: сессии, запросы, вызовы инструментов, разрешения, ответы, сотрудники
export const db = openDb(join(DATA_DIR, 'bot.db'));

export const say = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, ...extra }).catch((e) => log('sendMessage:', e.message));

/** Как показывать человека в сообщениях администратору. */
export const who = (u) => (u.username ? `@${u.username}` : u.first_name || `id ${u.id ?? u.user_id}`);

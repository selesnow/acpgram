// Общие настройки, база, логирование и отправка сообщений — используются всеми модулями бота.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';

/** Папка data/ рядом с ботом, а не в текущей папке: бот может запускаться из любого места (служба, systemd). */
export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
import { tg } from './telegram.mjs';

/** Главный администратор: ID задан в .env, отозвать доступ у него из бота нельзя. */
export const ADMIN_ID = Number(process.env.ALLOWED_USER_ID);
/** Максимум одновременно работающих агентов сотрудников. Администратор вне лимита. */
export const MAX_AGENTS = Number(process.env.MAX_AGENTS || 3);
/** Через сколько минут простоя сессия закрывается. */
export const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 30);
export const IDLE_MS = IDLE_MINUTES * 60_000;

/** Уровни доступа сотрудников. Режим сессии для уровня у каждого движка свой (engines.mjs). */
export const LEVELS = {
  read: { label: 'Чтение', hint: 'агент только читает и анализирует, ничего не меняет' },
  normal: { label: 'Обычный', hint: 'агент спрашивает разрешение на изменения' },
  full: { label: 'Полный', hint: 'агент правит файлы без подтверждений' },
};

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

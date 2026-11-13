// Тонкая обёртка над Telegram Bot API через fetch (новые методы 10.x не требуют библиотек).
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const FILE_BASE = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function tg(method, body = {}, { signal } = {}) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

/** Скачивает файл, присланный боту (до 20 МБ — лимит Bot API). Возвращает Buffer. */
export async function downloadFile(file_id) {
  const info = await tg('getFile', { file_id });
  if (!info.file_path) throw new Error('Telegram getFile: нет file_path');
  const res = await fetch(`${FILE_BASE}/${info.file_path}`);
  if (!res.ok) throw new Error(`Telegram file: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Отправка файла пользователю (multipart). */
async function uploadFile(method, field, chat_id, path, caption) {
  const form = new FormData();
  form.append('chat_id', String(chat_id));
  if (caption) form.append('caption', caption);
  form.append(field, new Blob([await readFile(path)]), basename(path));
  const res = await fetch(`${BASE}/${method}`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

/** Файл как документ; картинку (до 10 МБ) — как фото, а если Telegram отверг фото, то документом. */
export async function sendFile(chat_id, path, { photo = false, size = 0 } = {}) {
  if (photo && size <= 10 * 1024 * 1024) {
    try {
      return await uploadFile('sendPhoto', 'photo', chat_id, path);
    } catch (e) {
      console.error('sendPhoto не прошёл, отправляю документом:', e.message);
    }
  }
  return uploadFile('sendDocument', 'document', chat_id, path);
}

/** Экранирует текст для вставки в HTML-теги rich-разметки. */
export const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Делает частично пришедший Markdown безопасным для показа в черновике:
 * закрывает незавершённый блок кода, одиночную обратную кавычку и жирный/зачёркнутый маркер,
 * иначе весь последующий текст отображается моноширинным или жирным.
 */
export function balanceMarkdown(md) {
  const FENCE = '`'.repeat(3);
  const fenceRe = new RegExp('^' + FENCE, 'gm');
  const fencedRe = new RegExp(FENCE + '[\\s\\S]*?' + FENCE, 'g');

  let s = md;
  if ((s.match(fenceRe) || []).length % 2 === 1) return s.replace(/\n?$/, '\n') + FENCE;

  const outside = s.replace(fencedRe, '');
  if ((outside.match(/`/g) || []).length % 2 === 1) s += '`';
  const noCode = outside.replace(/`[^`]*`/g, '');
  if ((noCode.match(/\*\*/g) || []).length % 2 === 1) s += '**';
  if ((noCode.match(/~~/g) || []).length % 2 === 1) s += '~~';
  return s;
}

// Лимит rich-сообщения 32768 символов, оставляем запас
export const RICH_LIMIT = 30000;

/**
 * Rich-разметку в читаемый обычный текст — на случай, если Telegram отверг rich-сообщение:
 * кнопки убираем, служебные теги (details, footer и т.п.) снимаем, кастомные эмодзи заменяем запасными.
 */
export function richToPlain(md) {
  return md
    .replace(/<tg-button-row[^>]*>[\s\S]*?<\/tg-button-row>\n*/g, '')
    .replace(/!\[([^\]]*)\]\(tg:\/\/emoji\?id=\d+\)/g, '$1')
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1')
    .replace(/<\/?(details|summary|footer|tg-thinking)[^>]*>/g, '')
    .replace(/<\/?code>/g, '`')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Итоговое сообщение: rich Markdown (GFM: заголовки, списки, таблицы, код).
 * Если Telegram отверг разметку — отправляем обычным текстом.
 */
export async function sendRich(chat_id, markdown) {
  for (const part of splitText(markdown, RICH_LIMIT)) {
    try {
      await tg('sendRichMessage', { chat_id, rich_message: { markdown: part } });
    } catch (e) {
      console.error('sendRichMessage не прошёл, отправляю обычным текстом:', e.message);
      for (const plain of splitText(richToPlain(part), 4000)) await tg('sendMessage', { chat_id, text: plain });
    }
  }
}

/** Черновик (стриминг) в rich-разметке. */
export function sendRichDraft(chat_id, draft_id, markdown, extra = {}) {
  return tg('sendRichMessageDraft', { chat_id, draft_id, rich_message: { markdown }, ...extra });
}

/** Простой пустой черновик: Telegram показывает свой анимированный индикатор «Thinking…». */
export function sendThinkingDraft(chat_id, draft_id, extra = {}) {
  return tg('sendMessageDraft', { chat_id, draft_id, text: '', ...extra });
}

/** Разбивает длинный текст на части не длиннее лимита. */
export function splitText(text, limit = 4000) {
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

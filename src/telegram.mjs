// Тонкая обёртка над Telegram Bot API через fetch (новые методы 10.x не требуют библиотек).
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { i18nError } from './i18n.mjs';
import { logError } from './log.mjs';

const BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const FILE_BASE = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Куда отправлять: id чата (число) или {chat_id, message_thread_id} — тема в личном чате с ботом (Bot API 9.3).
 * Возвращает параметры для метода отправки.
 */
export const dest = (to) => (to && typeof to === 'object' ? (to.message_thread_id ? { chat_id: to.chat_id, message_thread_id: to.message_thread_id } : { chat_id: to.chat_id }) : { chat_id: to });

/** Ожидание ответа Telegram по умолчанию: без него оборванное соединение держит запрос до ~5 минут (таймауты Node). */
export const TIMEOUT_MS = 30_000;
/** Загрузка файлов (до 45 МБ за запрос) — дольше. */
const UPLOAD_TIMEOUT_MS = 120_000;
/** После «слишком много запросов» (429) ждём retry_after и повторяем, если ждать не дольше этого (секунды). */
const MAX_RETRY_AFTER_S = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ошибка Bot API: code — error_code (429, 400...), retryAfter — сколько секунд ждать перед повтором. */
export class TelegramError extends Error {
  constructor(method, data) {
    super(`Telegram ${method}: ${data.error_code} ${data.description}`);
    this.code = data.error_code;
    this.retryAfter = data.parameters?.retry_after;
  }
}

/**
 * Вызов метода Bot API: тайм-аут на запрос и повтор после 429 (не больше retries раз).
 * С retryTransient — ещё и повтор при сетевой ошибке и 5xx (только для итоговой отправки: черновики и команды
 * повторять бессмысленно). После тайм-аута не повторяем: сообщение могло уже дойти, повтор продублировал бы его.
 * @param {() => Promise<RequestInit>|RequestInit} makeInit тело запроса (для повтора собирается заново)
 * @param {{timeoutMs?: number, retries?: number, retryTransient?: boolean, signal?: AbortSignal, fetchImpl?: typeof fetch}} [o]
 */
export async function callApi(method, makeInit, { timeoutMs = TIMEOUT_MS, retries = 2, retryTransient = false, signal, fetchImpl = fetch } = {}) {
  const backoff = (attempt) => sleep(200 * 2 ** attempt);
  for (let attempt = 0; ; attempt++) {
    const limit = AbortSignal.timeout(timeoutMs);
    const init = await makeInit();
    let data;
    try {
      const res = await fetchImpl(`${BASE}/${method}`, { method: 'POST', ...init, signal: signal ? AbortSignal.any([signal, limit]) : limit });
      data = await res.json();
    } catch (e) {
      if (limit.aborted && !signal?.aborted) throw i18nError(`Telegram ${method}: нет ответа за ${Math.round(timeoutMs / 1000)} с`, 'err.tgTimeout', { method, sec: Math.round(timeoutMs / 1000) }, {}, { cause: e });
      if (retryTransient && attempt < retries) {
        logError(`Telegram ${method}: сеть, повтор ${attempt + 1}/${retries}:`, e.message);
        await backoff(attempt);
        continue;
      }
      throw e;
    }
    if (data.ok) return data.result;
    const err = new TelegramError(method, data);
    if (err.code === 429 && attempt < retries && Number.isFinite(err.retryAfter) && err.retryAfter <= MAX_RETRY_AFTER_S) {
      await sleep(err.retryAfter * 1000 + 250);
      continue;
    }
    if (retryTransient && err.code >= 500 && attempt < retries) {
      logError(`Telegram ${method}: HTTP ${err.code}, повтор ${attempt + 1}/${retries}`);
      await backoff(attempt);
      continue;
    }
    throw err;
  }
}

/** Telegram отказался править сообщение, потому что новое содержимое совпадает с текущим, — это не ошибка. */
export const isNotModified = (err) => /message is not modified/i.test(String(err?.message ?? err ?? ''));

/** Метод Bot API с JSON-телом. opts — см. callApi (timeoutMs, retries, signal). */
export const tg = (method, body = {}, opts = {}) =>
  callApi(method, () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), opts);

/** Скачивает файл, присланный боту (до 20 МБ — лимит Bot API). Возвращает Buffer. */
export async function downloadFile(file_id) {
  const info = await tg('getFile', { file_id });
  if (!info.file_path) throw i18nError('Telegram getFile: нет file_path', 'err.tgNoFilePath');
  const res = await fetch(`${FILE_BASE}/${info.file_path}`, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Telegram file: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Запрос с загрузкой файлов (multipart/form-data). fields — параметры метода (объекты передаются JSON),
 * files — {имя поля: {path, name?} | {buffer, name}}; файл с диска читается потоком, buffer — из памяти.
 */
function tgForm(method, fields, files = {}, opts = {}) {
  const makeInit = async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v != null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (const [k, f] of Object.entries(files)) {
      const blob = f.buffer ? new Blob([f.buffer]) : await openAsBlob(f.path);
      form.append(k, blob, f.name ?? (f.buffer ? 'file' : basename(f.path)));
    }
    return { body: form };
  };
  return callApi(method, makeInit, { timeoutMs: UPLOAD_TIMEOUT_MS, ...opts });
}

/** Отправка файла пользователю отдельным сообщением. */
const uploadFile = (method, field, to, file, opts = {}) => tgForm(method, dest(to), { [field]: typeof file === 'string' ? { path: file } : file }, opts);

/** Telegram принимает фото до 10 МБ; больше — только документом. */
export const PHOTO_MAX = 10 * 1024 * 1024;

/** Файл как документ; картинку (до 10 МБ) — как фото, а если Telegram отверг фото, то документом. */
export async function sendFile(to, source, { photo = false, size = 0, ...opts } = {}) {
  const file = typeof source === 'string' ? { path: source } : source;
  if (photo && size <= PHOTO_MAX) {
    try {
      return await uploadFile('sendPhoto', 'photo', to, file, opts);
    } catch (e) {
      logError('sendPhoto не прошёл, отправляю документом:', e.message);
    }
  }
  return uploadFile('sendDocument', 'document', to, file, opts);
}

/** Отправляет уже проверенный буфер без обращения к диску. */
export const sendBuffer = (to, buffer, name, opts = {}) => sendFile(to, { buffer, name, size: buffer.length }, { ...opts, size: buffer.length });

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

// строка-разделитель таблицы GFM: |---|:--:|---: (хотя бы одна вертикальная черта)
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const isDelimRow = (line) => line?.includes('|') && TABLE_DELIM.test(line);
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Пустая строка перед таблицей. Telegram (в отличие от GitHub) не начинает таблицу сразу после абзаца
 * или пункта списка: «Текст:\n| A | B |\n|---|---|» он склеивает в одну строку текста. Блоки кода не трогаем.
 */
export function fixTables(md) {
  const lines = String(md).split('\n');
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
    } else if (f) {
      fence = f[1];
    } else if (line.includes('|') && isDelimRow(lines[i + 1]) && !isDelimRow(line) && i > 0 && lines[i - 1].trim() && !/^\s*>/.test(line)) {
      out.push('');
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Шапка таблицы (строка заголовков и разделитель), которой заканчивается часть сообщения, иначе null. */
function openTableHeader(part) {
  const lines = part.replace(/\n+$/, '').split('\n');
  let j = lines.length;
  while (j > 0 && lines[j - 1].includes('|') && lines[j - 1].trim()) j--;
  for (let k = j; k < lines.length - 1; k++) if (isDelimRow(lines[k + 1]) && !isDelimRow(lines[k])) return `${lines[k]}\n${lines[k + 1]}`;
  return null;
}

/** Длинный rich-текст по частям; если разрез пришёлся на таблицу, продолжение получает её шапку (иначе это просто текст). */
export function splitRich(md, limit = RICH_LIMIT) {
  const parts = splitText(fixTables(md), limit);
  for (let k = 1; k < parts.length; k++) {
    const head = openTableHeader(parts[k - 1]);
    if (head && /^\s*\|/.test(parts[k])) parts[k] = `${head}\n${parts[k]}`;
  }
  return parts;
}

// Лимит rich-сообщения 32768 символов, оставляем запас
export const RICH_LIMIT = 30000;

/**
 * Rich-разметку в читаемый обычный текст — на случай, если Telegram отверг rich-сообщение:
 * кнопки убираем, служебные теги (details, footer и т.п.) снимаем, кастомные эмодзи заменяем запасными.
 */
export function richToPlain(md) {
  return stripMedia(md)
    .replace(/<tg-button-row[^>]*>[\s\S]*?<\/tg-button-row>\n*/g, '')
    .replace(/!\[([^\]]*)\]\(tg:\/\/emoji\?id=\d+\)/g, '$1')
    .replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1')
    .replace(/<\/?(details|summary|footer|tg-thinking)[^>]*>/g, '')
    .replace(/<\/?code>/g, '`')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- файлы внутри rich-сообщения (Bot API 10.3): блок ![](tg://photo?id=f0) или ![](tg://document?id=f0) ----
// сам файл загружается тем же запросом sendRichMessage (поле media + multipart), id связывает ссылку с файлом

const MEDIA_LINE = /^!\[\]\(tg:\/\/(photo|document)\?id=([A-Za-z0-9_-]{1,64})\)[ \t]*$/gm;

/** Блок файла: отдельной строкой с пустыми строками вокруг (медиа в rich-сообщении — только отдельный блок). */
export const mediaBlock = (kind, id) => `\n\n![](tg://${kind}?id=${id})\n\n`;

/** id файлов, на которые ссылается разметка (без повторов, по порядку). */
export const mediaIdsOf = (md) => [...new Set([...md.matchAll(MEDIA_LINE)].map((m) => m[2]))];

/** Разметка без блоков файлов (запасной путь: файлы уйдут отдельными сообщениями). */
export const stripMedia = (md) => md.replace(MEDIA_LINE, '').replace(/\n{3,}/g, '\n\n').trim();

/** Тип файла в разметке — так, как он указан в ссылке (photo или document). */
const kindIn = (md, id) => new RegExp(`tg://(photo|document)\\?id=${id}\\)`).exec(md)?.[1] ?? 'document';

/** Одно rich-сообщение с файлами; если Telegram отверг фото — повтор, где все фото идут документами. */
async function sendRichMedia(to, md, ids, media, opts = {}) {
  const send = (text) =>
    tgForm(
      'sendRichMessage',
      { ...dest(to), rich_message: { markdown: text, media: ids.map((id) => ({ id, media: { type: kindIn(text, id), media: `attach://${id}` } })) } },
      Object.fromEntries(ids.map((id) => [id, media[id]])),
      opts,
    );
  try {
    return await send(md);
  } catch (e) {
    // повтор документами — только если Telegram отверг сам запрос (400: не подошло фото), а не при сбое сети или лимите
    if (e.code !== 400 || !md.includes('tg://photo?id=')) throw e;
    logError('rich-сообщение с фото не прошло, повторяю с файлами-документами:', e.message);
    return send(md.replace(/tg:\/\/photo\?id=/g, 'tg://document?id='));
  }
}

/**
 * Итоговое сообщение: rich Markdown (GFM: заголовки, списки, таблицы, код).
 * media — файлы, на которые ссылаются блоки разметки: {id: {path, name}}; они загружаются вместе с сообщением.
 * Если Telegram отверг сообщение с файлами — текст уходит без них, а файлы возвращаются вызывающему (отправить отдельно).
 * Если Telegram отверг разметку — отправляем обычным текстом.
 * @returns {Promise<object[]>} файлы из media, которые не удалось вставить в сообщение
 */
export async function sendRich(to, markdown, { media = {}, ...opts } = {}) {
  const finalOpts = { retryTransient: true, ...opts }; // итоговый ответ повторяем при 5xx/сети; черновики — нет
  const leftover = [];
  for (let part of splitRich(markdown, RICH_LIMIT)) {
    const ids = mediaIdsOf(part).filter((id) => media[id]);
    if (ids.length) {
      try {
        await sendRichMedia(to, part, ids, media, finalOpts);
        continue;
      } catch (e) {
        logError('rich-сообщение с файлами не прошло, файлы уйдут отдельно:', e.message);
        leftover.push(...ids.map((id) => media[id]));
        part = stripMedia(part);
        if (!part) continue;
      }
    }
    try {
      await tg('sendRichMessage', { ...dest(to), rich_message: { markdown: part } }, finalOpts);
    } catch (e) {
      // обычным текстом отправляем только когда Telegram отверг именно разметку (400): при 5xx/сети сообщение
      // могло дойти, и повтор в другом виде продублировал бы его в чате
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      logError('sendRichMessage не прошёл, отправляю обычным текстом:', e.message);
      for (const plain of splitText(richToPlain(part), 4000)) await tg('sendMessage', { ...dest(to), text: plain }, finalOpts);
    }
  }
  return leftover;
}

// Черновик обновляется раз в секунду: повтор после 429 или долгое ожидание бессмысленны — следующий тик пришлёт свежий.
const DRAFT_OPTS = { retries: 0, timeoutMs: 10_000 };

/** Черновик (стриминг) в rich-разметке. Файлы в черновик не загружаются (Bot API) — они появятся в итоговом ответе. */
export function sendRichDraft(to, draft_id, markdown, extra = {}) {
  return tg('sendRichMessageDraft', { ...dest(to), draft_id, rich_message: { markdown: fixTables(markdown) }, ...extra }, DRAFT_OPTS);
}

/** Простой пустой черновик: Telegram показывает свой анимированный индикатор «Thinking…». */
export function sendThinkingDraft(to, draft_id, extra = {}) {
  return tg('sendMessageDraft', { ...dest(to), draft_id, text: '', ...extra }, DRAFT_OPTS);
}

/** Разбивает длинный текст на части не длиннее лимита. */
function splitText(text, limit = 4000) {
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

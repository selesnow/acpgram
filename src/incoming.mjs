// Разбор входящих сообщений: цитата, на которую отвечает пользователь, неподдерживаемые виды сообщений, опечатки в командах.

/** Сколько символов цитаты передаём агенту. */
const QUOTE_MAX = 1500;

/** Текст RichText (строка, объект с вложенным text или массив таких) без оформления. */
const plainRich = (x) => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(plainRich).join('') : x && typeof x === 'object' ? plainRich(x.text ?? '') : '');

/**
 * Фрагмент, который пользователь выделил, отвечая на сообщение (Telegram: «ответить с цитатой»): из обычного сообщения —
 * quote.text, из rich-сообщения (ответы агента) — quote.rich_texts (Bot API 10.4). null — цитаты нет.
 */
export function quoteOf(msg) {
  const q = msg?.quote;
  if (!q) return null;
  const rich = Array.isArray(q.rich_texts) ? q.rich_texts.map(plainRich).join('\n') : '';
  const text = String(q.text || rich).trim();
  return text ? text.slice(0, QUOTE_MAX) : null;
}

/** Виды сообщений, с которыми бот не работает: на них отвечаем подсказкой, а не молчим. */
const UNSUPPORTED = ['voice', 'audio', 'video', 'video_note', 'sticker', 'animation', 'location', 'venue', 'contact', 'poll', 'dice'];

/** Неподдерживаемый вид сообщения ('voice', 'sticker'…) или null. */
export const unsupportedKind = (msg) => UNSUPPORTED.find((k) => msg?.[k]) ?? null;

/** Строки отличаются одной правкой: заменой, вставкой, удалением символа или перестановкой двух соседних. */
export function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Команда бота, которую пользователь, скорее всего, имел в виду («/modle» → model). Короткие имена (до 3 символов)
 * не проверяем: слишком много случайных совпадений. null — похожей команды нет.
 * @param {string} name имя неизвестной команды без «/»
 * @param {string[]} commands имена команд бота
 */
export const nearCommand = (name, commands) => (name.length >= 4 ? commands.find((c) => oneEditApart(c, name)) ?? null : null);

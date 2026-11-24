import { log, say } from './ctx.mjs';
import { DEFAULT_LANG, LOCALES, t } from './i18n.mjs';
import { isNotModified, tg } from './telegram.mjs';

export function cbCtx(st = {}, cb = {}, options = {}) {
  const { html = false, alert = false, notModified = false, label = '', fallback = null, api = tg, send = say, logger = log } = options;
  const chatId = cb.message?.chat?.id ?? st.chatId;
  const messageId = cb.message?.message_id;
  const ack = (text) =>
    api('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, ...(alert ? { show_alert: true } : {}) } : {}) }).catch(() => {});
  const edit = (view, markup) => {
    const text = typeof view === 'string' ? view : view?.text;
    const replyMarkup = markup ?? (typeof view === 'string' ? undefined : view?.markup) ?? { inline_keyboard: [] };
    return api('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(html ? { parse_mode: 'HTML' } : {}), reply_markup: replyMarkup }).catch((e) => {
      const message = String(e?.message ?? e ?? '');
      if (notModified && (notModified === 'loose' ? /not modified/i.test(message) : isNotModified(e))) return;
      if (fallback) return typeof fallback === 'function' ? fallback(text, replyMarkup, view) : send(st.to, text, fallback);
      if (label) logger(label, e.message);
    });
  };
  return { ack, edit, chatId, messageId };
}

export const btnText = (s, limit = 60) => [...String(s ?? '')].slice(0, limit).join('');

export const cancelRow = (prefix, lang = DEFAULT_LANG) => ({ inline_keyboard: [[{ text: t('btn.cancel', lang), callback_data: `${prefix}:x` }]] });

export function fmtDate(value, lang = DEFAULT_LANG, { time = false, year = true, empty = '—' } = {}) {
  if (!value) return empty;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return empty;
  const locale = LOCALES[lang] ?? LOCALES.en;
  const opts = { day: '2-digit', month: '2-digit' };
  if (year) opts.year = 'numeric';
  if (time) {
    opts.hour = '2-digit';
    opts.minute = '2-digit';
  }
  return time ? date.toLocaleString(locale, opts) : date.toLocaleDateString(locale, opts);
}

export function dropMessage(st, messageId, options = {}) {
  if (!messageId) return null;
  const { label = '', api = tg, logger = log } = typeof options === 'string' ? { label: options } : options;
  return api('deleteMessage', { chat_id: st.chatId, message_id: messageId }).catch((e) => {
    if (label) logger(label, e.message);
  });
}

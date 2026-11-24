// Отправка виджетов и память о них: какому диалогу (теме) и экрану принадлежит сообщение с виджетом.
// Запрос виджета (widget_query) приносит только чат и номер сообщения — тему и вид экрана бот берёт отсюда.
import { langOf, log } from './ctx.mjs';
import { t } from './i18n.mjs';
import { dest, tg } from './telegram.mjs';
import { widgetFits } from './widgets.mjs';
import { createKeyRegistry } from './keyRegistry.mjs';

/**
 * Виджеты включаются явно: WIDGETS=1 в .env. По умолчанию — обычные меню с кнопками: с 13.11.2026 Telegram не даёт
 * обычным ботам отправлять виджеты, и вживую они не проверены — код не должен сам включиться у всех в день, когда
 * запрет снимут.
 */
export const WIDGETS = process.env.WIDGETS === '1';

/**
 * Пока Telegram не разрешает боту виджеты (с 13.11.2026 — никаким обычным ботам), sendWidget отвечает
 * INPUT_MEDIA_WIDGET_NOT_ALLOWED. После такого отказа час не пробуем — иначе каждый /model начинался бы с лишнего запроса.
 */
export const NOT_ALLOWED_PAUSE_MS = 3600_000;
let pausedUntil = 0;

/** Отказ «виджеты этому боту не разрешены» (а не ошибка конкретного виджета). */
export const isNotAllowed = (err) => /WIDGET_NOT_ALLOWED/i.test(String(err?.message ?? err ?? ''));

const sent = createKeyRegistry({ scope: 'global', limit: 500, eviction: 'oldest' });
const widgetKey = (chatId, messageId) => `${chatId}:${messageId}`;

/** Что известно о сообщении с виджетом, или null (бот перезапускался — тему уже не узнать). */
export const widgetInfo = (chatId, messageId) => sent.get(widgetKey(chatId, messageId)) ?? null;

/**
 * Отправляет виджет в диалог. Возвращает false, если виджеты выключены, не разрешены боту, виджет не помещается
 * в лимиты Telegram или Telegram его не принял — тогда вызывающий показывает обычное меню. Под виджетом — кнопка
 * «Обычное меню» (wid:<kind>): на случай приложения без поддержки виджетов.
 * @param {object} st состояние диалога
 * @param {{html: string, caption: string, kind: 'model'|'sessions', engine?: string}} o
 * @param {{send?: typeof tg, now?: number}} [deps] для тестов
 */
export async function sendWidgetMessage(st, { html, caption, kind, engine = null }, { send = tg, now = Date.now() } = {}) {
  if (!WIDGETS || now < pausedUntil || !widgetFits(html)) return false;
  try {
    const msg = await send('sendWidget', {
      ...dest(st.to),
      html,
      caption,
      show_caption_above_media: true,
      allow_queries: true,
      reply_markup: { inline_keyboard: [[{ text: t('wid.classic', langOf(st.userId)), callback_data: `wid:${kind}` }]] },
    });
    sent.put(widgetKey(st.chatId, msg.message_id), { threadId: st.threadId ?? null, kind, engine });
    return true;
  } catch (e) {
    if (isNotAllowed(e)) {
      pausedUntil = now + NOT_ALLOWED_PAUSE_MS;
      log('Telegram не разрешает боту отправлять виджеты (INPUT_MEDIA_WIDGET_NOT_ALLOWED) — час показываю обычные меню');
    } else log(`виджет (${kind}) не отправлен, показано обычное меню:`, e.message, '| пользователь', st.userId);
    return false;
  }
}

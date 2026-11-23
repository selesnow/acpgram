// Запросы от виджетов (widget_query): выбор модели и уровня рассуждений, возобновление сессии.
// Виджет присылает до 64 байт данных; ответить нужно за 15 секунд — долгая работа (загрузка сессии) идёт после ответа.
import { effectiveSelection } from './access.mjs';
import { db, langOf, log, say } from './ctx.mjs';
import { t } from './i18n.mjs';
import { applyChoice } from './modelUi.mjs';
import { checkResumable, resumeSession } from './sessionsUi.mjs';
import { engineOf, getState } from './state.mjs';
import { tg } from './telegram.mjs';
import { widgetInfo } from './widgetHost.mjs';
import { findByRef, parseWidgetQuery, widgetAnswer } from './widgets.mjs';

/** Запрос от виджета. Доступ пользователя уже проверен (bot.mjs). */
export async function onWidgetQuery(q) {
  const chatId = q.chat?.id ?? q.from.id;
  const info = widgetInfo(chatId, q.message_id);
  const st = getState(q.from.id, chatId, info?.threadId ?? null);
  const lang = langOf(st.userId);
  const answer = (text, state = null) => tg('answerWidgetQuery', { widget_query_id: q.id, data: widgetAnswer(text, state) }).catch((e) => log('answerWidgetQuery:', e.message));
  const query = parseWidgetQuery(q.data);
  if (!query) return answer(t('wid.stale', lang));

  if (query.kind === 'session') {
    if (st.busy) return answer(t('busy.stop', lang));
    const item = findByRef(db.listSessions(st.userId, st.project, 50), query.ref, (s) => s.acp_id);
    const check = checkResumable(st, item);
    if (check.error) return answer(check.error);
    st.busy = true; // синхронно, до ответа Telegram (см. resumeSession)
    await answer(t('wid.resuming', lang));
    // загрузка сессии занимает секунды — ход и итог приходят обычными сообщениями в диалог
    return resumeSession(st, item, check.engine, (text) => say(st.to, text));
  }

  const engine = engineOf(st);
  // виджет открывали для другого движка (после этого сменили /engine): его модели к текущему не подходят
  if (info?.engine && info.engine !== engine.id) return answer(t('model.engineChanged', lang));
  const r = applyChoice(st, engine, query.kind, query.ref);
  if (!r.ok) return answer(r.error);
  const sel = effectiveSelection(st.userId, engine);
  const state = { m: sel.model, e: sel.effort };
  await answer(t(query.kind === 'model' ? 'model.set' : 'effort.set', lang), state);
  // отметка выбора должна пережить перерисовку виджета (другое устройство, возврат к сообщению)
  if (q.message_id) tg('editMessageWidgetData', { chat_id: chatId, message_id: q.message_id, chat_data: JSON.stringify(state) }).catch((e) => log('editMessageWidgetData:', e.message));
}

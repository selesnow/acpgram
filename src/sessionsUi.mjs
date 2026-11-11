// Команда /sessions: возврат к прошлой сессии в текущем проекте (сессия возобновляется в том движке, где была создана).
import { db, log, say } from './ctx.mjs';
import { display } from './projects.mjs';
import { canUseEngine } from './access.mjs';
import { ENGINES, getEngine, isAvailable } from './engines.mjs';
import { ClosedError, LimitError, endAgent, engineOf, ensureAgent, saveEngine } from './state.mjs';
import { tg } from './telegram.mjs';

const LIST_LIMIT = 10;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const when = (iso) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

export async function handleSessions(st) {
  const list = db.listSessions(st.userId, st.project, LIST_LIMIT);
  if (!list.length) {
    return say(st.chatId, `В проекте ${display(st.project)} пока нет сохранённых сессий. Они появятся после первого запроса.`);
  }
  const current = st.agent?.sessionId;
  return say(st.chatId, `Сессии проекта ${display(st.project)}.\nВыберите, к какой вернуться:`, {
    reply_markup: {
      inline_keyboard: list.map((s) => [
        { text: trunc(`${s.acp_id === current ? '▶ ' : ''}${getEngine(s.engine).short} · ${when(s.last_at)} · ${s.n} запр. · ${oneLine(s.first_text)}`, 60), callback_data: `ses:${s.acp_id}` },
      ]),
    },
  });
}

/** Возобновляет выбранную сессию: закрывает текущий процесс и поднимает новый с загрузкой истории. */
export async function onSessionCallback(st, cb) {
  const id = (cb.data || '').slice('ses:'.length);
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
  const edit = (text) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }).catch((e) => log('sessions edit:', e.message));

  if (st.busy) return ack('Сначала остановите текущий запрос: /stop');
  // сессия должна принадлежать этому пользователю и проекту — id из кнопки не берём на веру
  const item = db.listSessions(st.userId, st.project, 50).find((s) => s.acp_id === id);
  if (!item) return ack('Сессия не найдена или относится к другому проекту. Вызовите /sessions заново.');
  if (st.agent?.sessionId === id) return ack('Эта сессия уже активна');
  const engine = ENGINES[item.engine] ?? getEngine(null);
  if (!isAvailable(engine.id)) return ack(`${engine.label} сейчас недоступен на сервере — сессию не возобновить.`);
  if (!canUseEngine(st.userId, engine.id)) return ack(`Движок ${engine.label} вам сейчас не выдан — сессию не возобновить. Обратитесь к администратору.`);

  await ack();
  const label = trunc(oneLine(item.first_text), 80);
  await edit(`↩️ Возвращаюсь к сессии от ${when(item.last_at)}: «${label}»\nЗагрузка занимает около 15 секунд…`);
  st.busy = true; // пока идёт загрузка, новые запросы не принимаем
  const prevEngine = st.engine; // выбор пользователя до возобновления — вернём, если не получится
  let switched = false;
  try {
    endAgent(st, 'resume');
    // сессия живёт в своём движке: при необходимости переключаем выбор пользователя на него
    switched = engineOf(st).id !== engine.id;
    if (switched) saveEngine(st, engine.id);
    await ensureAgent(st, { resume: id });
    st.lastActive = Date.now();
    await edit(`✅ Сессия возобновлена: «${label}»\nПишите продолжение — ${engine.label} помнит этот диалог.${switched ? `\n🤖 Движок переключён на ${engine.label}.` : ''}`);
  } catch (e) {
    log('ошибка возобновления сессии:', e.message);
    if (switched) saveEngine(st, prevEngine); // не удалось — движок пользователя не меняем
    await edit(
      e instanceof LimitError ? e.message
      : e instanceof ClosedError ? '🛑 Возобновление отменено: сессия закрыта. Вернуться к ней можно через /sessions.'
      : `⚠️ Не удалось возобновить сессию: ${e.message}\nМожно начать новую обычным запросом.`,
    );
  } finally {
    st.busy = false;
  }
}

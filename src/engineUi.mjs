// Команда /engine: выбор движка (Gemini CLI, Claude Code, Antigravity CLI). Выбор запоминается для пользователя.
import { log, say } from './ctx.mjs';
import { canUseEngine, grantedEngines, userEngines } from './access.mjs';
import { DEFAULT_ENGINE, ENGINES, isAvailable } from './engines.mjs';
import { endAgent, engineOf, isAdmin, saveEngine } from './state.mjs';
import { tg } from './telegram.mjs';
import { engineMenu } from './ui.mjs';

/** Поиск движка по id или названию: «claude», «Claude Code», «agy», «antigravity», «codex». */
export const findEngine = (q) => {
  const s = q.trim().toLowerCase();
  return Object.values(ENGINES).find((e) => [e.id, e.short.toLowerCase(), e.label.toLowerCase()].includes(s)) ?? null;
};

/**
 * Переключает движок пользователя. Текущая сессия закрывается: процесс агента работает в одном движке.
 * @returns {string} текст ответа пользователю
 */
export function switchEngine(st, id) {
  const e = ENGINES[id];
  if (!e) return '⚠️ Неизвестный движок.';
  if (!isAvailable(id)) return `⚠️ ${e.label} недоступен на сервере (не установлен или не запускается).`;
  if (!canUseEngine(st.userId, id)) return `🔒 Движок ${e.label} вам не выдан. Доступ к движкам выдаёт администратор.`;
  if (st.busy) return 'Сначала остановите текущий запрос: /stop';
  const before = engineOf(st);
  saveEngine(st, id);
  if (before.id === id) return `🤖 Движок уже выбран: ${e.label}`;
  endAgent(st, 'engine');
  log('движок переключён:', st.userId, id);
  return `🤖 Движок: ${e.label}\nНовая сессия начнётся со следующего запроса. Прошлые сессии этого проекта — /sessions.`;
}

export async function handleEngine(st, arg) {
  const q = (arg || '').trim();
  if (q) {
    const e = findEngine(q);
    return say(st.chatId, e ? switchEngine(st, e.id) : `⚠️ Неизвестный движок «${q}». Доступны: ${userEngines(st.userId).map((x) => x.id).join(', ')}`);
  }
  const engines = userEngines(st.userId);
  const v = engineMenu({
    engines,
    current: engineOf(st).id,
    defaultId: DEFAULT_ENGINE,
    // выданные пользователю, но не запустившиеся на сервере
    unavailable: grantedEngines(st.userId).filter((id) => !isAvailable(id)).map((id) => ENGINES[id].label),
  });
  const more = !isAdmin(st.userId) && grantedEngines(st.userId).length < Object.keys(ENGINES).length ? '\nДругие движки выдаёт администратор.' : '';
  return say(st.chatId, v.text + more, { reply_markup: v.markup });
}

/** Кнопка eng:<id>. */
export async function onEngineCallback(st, cb) {
  const id = (cb.data || '').slice('eng:'.length);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  const text = switchEngine(st, id);
  return tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(st.chatId, text));
}

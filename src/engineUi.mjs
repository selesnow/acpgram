// Команда /engine: выбор движка (Gemini CLI, Claude Code, Antigravity CLI). Выбор запоминается для пользователя.
import { langOf, log, say } from './ctx.mjs';
import { canUseEngine, grantedEngines, userEngines } from './access.mjs';
import { DEFAULT_ENGINE, ENGINES, isAvailable, needsLogin } from './engines.mjs';
import { t } from './i18n.mjs';
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
  const lang = langOf(st.userId);
  const e = ENGINES[id];
  if (!e) return t('eng.unknown', lang);
  if (!isAvailable(id)) return t('eng.unavailable', lang, { engine: e.label });
  if (!canUseEngine(st.userId, id)) return t('eng.notGranted', lang, { engine: e.label });
  if (st.busy) return t('busy.stop', lang);
  const before = engineOf(st);
  saveEngine(st, id);
  // не блокируем выбор: только предупреждаем, что движок не авторизован на сервере
  const warn = needsLogin(id) ? `\n${t('eng.needLogin', lang, { engine: e.label })}` : '';
  if (before.id === id) return t('eng.already', lang, { engine: e.label, warn });
  endAgent(st, 'engine');
  log('движок переключён:', st.userId, id);
  return t('eng.switched', lang, { engine: e.label, warn });
}

export async function handleEngine(st, arg) {
  const lang = langOf(st.userId);
  const q = (arg || '').trim();
  if (q) {
    const e = findEngine(q);
    return say(st.chatId, e ? switchEngine(st, e.id) : t('eng.badArg', lang, { q, list: userEngines(st.userId).map((x) => x.id).join(', ') }));
  }
  const engines = userEngines(st.userId);
  const v = engineMenu({
    engines,
    current: engineOf(st).id,
    defaultId: DEFAULT_ENGINE,
    needLogin: engines.filter((x) => needsLogin(x.id)).map((x) => x.id),
    // выданные пользователю, но не запустившиеся на сервере
    unavailable: grantedEngines(st.userId).filter((id) => !isAvailable(id)).map((id) => ENGINES[id].label),
    lang,
  });
  const more = !isAdmin(st.userId) && grantedEngines(st.userId).length < Object.keys(ENGINES).length ? `\n${t('engine.more', lang)}` : '';
  return say(st.chatId, v.text + more, { reply_markup: v.markup });
}

/** Кнопка eng:<id>. */
export async function onEngineCallback(st, cb) {
  const id = (cb.data || '').slice('eng:'.length);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  const text = switchEngine(st, id);
  return tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(st.chatId, text));
}

// Команда /topics — переключение режима «диалоги» (каждая тема чата — отдельный диалог с агентом) и /new в этом режиме:
// новая тема вместо сброса текущего диалога.
import { botInfo, db, langOf, log, say } from './ctx.mjs';
import { t } from './i18n.mjs';
import { showPath } from './projects.mjs';
import { engineOf, setTopicsMode, statesOf, stopUser, topicsOn, topicsSupport } from './state.mjs';
import { tg } from './telegram.mjs';
import { createTopic, topicLink, topicName } from './topics.mjs';

const modeKeyboard = (on, lang) => ({
  inline_keyboard: [
    [
      { text: `${on ? '✅ ' : ''}${t('topics.btn.on', lang)}`, callback_data: 'tpc:on' },
      { text: `${on ? '' : '✅ '}${t('topics.btn.off', lang)}`, callback_data: 'tpc:off' },
    ],
  ],
});

const stateText = (st, lang) => {
  const on = topicsOn(st.userId);
  const extra = on && !topicsSupport.usersCreate ? `\n\n${t('topics.botOnly', lang)}` : '';
  return `${t(on ? 'topics.stateOn' : 'topics.stateOff', lang)}${extra}`;
};

/**
 * Настройки тем бота из getMe: владелец мог изменить их в @BotFather, пока бот работает (при запуске они читаются
 * один раз). Ошибку запроса не показываем — остаются прежние значения.
 */
export async function refreshTopicsSupport() {
  try {
    const me = await tg('getMe');
    topicsSupport.enabled = Boolean(me.has_topics_enabled);
    topicsSupport.usersCreate = Boolean(me.allows_users_to_create_topics);
  } catch (e) {
    log('getMe (настройки тем):', e.message);
  }
}

/** /topics: текущий режим и кнопки переключения. */
export async function handleTopics(st) {
  await refreshTopicsSupport();
  const lang = langOf(st.userId);
  if (!topicsSupport.enabled) return say(st.to, t('topics.unsupported', lang));
  return say(st.to, stateText(st, lang), { reply_markup: modeKeyboard(topicsOn(st.userId), lang) });
}

/** Кнопка режима (tpc:on | tpc:off). */
export async function onTopicsCallback(st, cb) {
  const want = cb.data === 'tpc:on';
  const lang = langOf(st.userId);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
  if (!topicsSupport.enabled) return ack(t('topics.unsupported', lang));
  if (want === topicsOn(st.userId)) return ack();
  if (statesOf(st.userId).some((s) => s.busy)) return ack(t('topics.busy', lang));
  // в другом режиме — другие диалоги: процессы агентов закрываем (сессии тем сохранятся и продолжатся, когда режим вернут)
  for (const s of statesOf(st.userId)) stopUser(s, 'close');
  setTopicsMode(st.userId, want);
  log('режим «диалоги»', want ? 'включён' : 'выключен', '| пользователь', st.userId);
  await ack();
  const text = `${t(want ? 'topics.enabled' : 'topics.disabled', lang)}\n\n${stateText(st, lang)}`;
  await tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text, reply_markup: modeKeyboard(want, lang) }).catch(() =>
    say(st.to, text),
  );
}

/**
 * /new в режиме «диалоги»: создаёт тему — новый диалог с движком текущего и его проектом (или project — из списка
 * тем проекта). Название — «проект · Новый диалог», по первому ответу агент даст своё (turn.mjs).
 * В новой теме — приветствие, здесь — кнопка, открывающая её.
 */
export async function newTopic(st, { project = st.project } = {}) {
  const lang = langOf(st.userId);
  const name = topicName(project, t('topics.newName', lang));
  let threadId;
  try {
    threadId = await createTopic(st.chatId, name);
  } catch (e) {
    log('создание темы:', e.message, '| пользователь', st.userId);
    return say(st.to, t('topics.createFail', lang, { msg: e.message }));
  }
  const engine = engineOf(st);
  db.saveTopic(st.userId, threadId, { name, named: false, project, engine: engine.id });
  log('тема создана', threadId, '| пользователь', st.userId);
  await say({ chat_id: st.chatId, message_thread_id: threadId }, t('topics.hello', lang, { engine: engine.label, project: showPath(project, lang) }));
  const link = topicLink(botInfo.username, threadId);
  return say(st.to, t('topics.created', lang), link ? { reply_markup: { inline_keyboard: [[{ text: t('topics.open', lang), url: link }]] } } : {});
}

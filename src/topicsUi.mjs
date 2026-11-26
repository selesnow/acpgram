// Команда /topics — переключение режима «диалоги» (каждая тема чата — отдельный диалог с агентом) и /new в этом режиме:
// новая тема вместо сброса текущего диалога.
import { botInfo, db, langOf, log, say } from './ctx.mjs';
import { errText, t } from './i18n.mjs';
import { engineOf, errorRootOf, isAdmin, markReplyKeyboard, replyKeyboardOff, setTopicsMode, statesOf, stopUser, topicProject, topicsOn, topicsSupport, userPath } from './state.mjs';
import { tg } from './telegram.mjs';
import { cbCtx } from './uiActions.mjs';
import { cleanTitle, createTopic, topicLink, topicName } from './topics.mjs';
import { replyKeyboard } from './ui.mjs';

const topicKeyboardExtra = (st, lang) =>
  replyKeyboardOff(st.userId) ? {} : { reply_markup: replyKeyboard(lang, { admin: isAdmin(st.userId), topics: 'on' }) };

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

const botSettingsKeyboard = (lang) =>
  topicsSupport.enabled
    ? [
        [
          { text: t(topicsSupport.sidebar ? 'topics.bot.sidebarOn' : 'topics.bot.sidebarOff', lang), callback_data: 'tpc:bot:sidebar' },
          { text: t(topicsSupport.usersCreate ? 'topics.bot.createOn' : 'topics.bot.createOff', lang), callback_data: 'tpc:bot:create' },
        ],
        [
          { text: t(topicsSupport.canJoinGroups ? 'topics.bot.groupsOn' : 'topics.bot.groupsOff', lang), callback_data: 'tpc:bot:groups' },
          { text: t('topics.bot.disableTopics', lang), callback_data: 'tpc:bot:topics' },
        ],
      ]
    : [
        [{ text: t('topics.bot.enableTopics', lang), callback_data: 'tpc:bot:topics', style: 'primary' }],
        [{ text: t(topicsSupport.canJoinGroups ? 'topics.bot.groupsOn' : 'topics.bot.groupsOff', lang), callback_data: 'tpc:bot:groups' }],
      ];

const topicsView = (st, lang) => {
  const admin = isAdmin(st.userId);
  if (!topicsSupport.enabled) {
    if (!admin) return { text: t('topics.unsupported', lang) };
    return { text: t('topics.unsupportedAdmin', lang), markup: { inline_keyboard: botSettingsKeyboard(lang) } };
  }
  const text = admin ? `${stateText(st, lang)}\n\n${t('topics.botSettingsHead', lang)}` : stateText(st, lang);
  const rows = [...modeKeyboard(topicsOn(st.userId), lang).inline_keyboard, ...(admin ? botSettingsKeyboard(lang) : [])];
  return { text, markup: { inline_keyboard: rows } };
};

const syncBotInfo = (me) => {
  topicsSupport.enabled = Boolean(me.has_topics_enabled);
  topicsSupport.usersCreate = Boolean(me.allows_users_to_create_topics);
  topicsSupport.sidebar = Boolean(me.has_topic_sidebar);
  topicsSupport.canJoinGroups = me.can_join_groups !== false;
  const username = me.username || me.active_usernames?.[0];
  if (username) botInfo.username = username;
};

/**
 * Настройки тем бота из getMe (BotFullInfo): владелец мог изменить их в @BotFather или через setMySettings,
 * пока бот работает. Ошибку запроса не показываем — остаются прежние значения.
 */
async function refreshTopicsSupport() {
  try {
    syncBotInfo(await tg('getMe'));
  } catch (e) {
    log('getMe (настройки тем):', e.message);
  }
}

/** /topics: текущий режим и кнопки переключения (администратору — также настройки бота через setMySettings). */
export async function handleTopics(st) {
  await refreshTopicsSupport();
  const lang = langOf(st.userId);
  const v = topicsView(st, lang);
  return say(st.to, v.text, v.markup ? { reply_markup: v.markup } : {});
}

async function onBotSettingCallback(st, cb, lang) {
  const { ack, edit } = cbCtx(st, cb, { alert: true, notModified: true, fallback: (text, markup) => say(st.to, text, markup ? { reply_markup: markup } : {}) });
  if (!isAdmin(st.userId)) return ack(t('admin.only', lang));
  const setting = cb.data.slice('tpc:bot:'.length);
  const patches = {
    topics: topicsSupport.enabled ? { has_topics_enabled: false } : { has_topics_enabled: true, has_topic_sidebar: true },
    sidebar: { has_topic_sidebar: !topicsSupport.sidebar },
    create: { allows_users_to_create_topics: !topicsSupport.usersCreate },
    groups: { can_join_groups: !topicsSupport.canJoinGroups },
  };
  const patch = patches[setting];
  if (!patch) return ack();
  try {
    await tg('setMySettings', patch);
  } catch (e) {
    log('setMySettings:', e.message);
    return ack(t('topics.botFail', lang, { msg: errText(e, lang, errorRootOf(st.userId)) }));
  }
  if ('has_topics_enabled' in patch) topicsSupport.enabled = patch.has_topics_enabled;
  if ('has_topic_sidebar' in patch) topicsSupport.sidebar = patch.has_topic_sidebar;
  if ('allows_users_to_create_topics' in patch) topicsSupport.usersCreate = patch.allows_users_to_create_topics;
  if ('can_join_groups' in patch) topicsSupport.canJoinGroups = patch.can_join_groups;
  log('настройки бота изменены (setMySettings):', JSON.stringify(patch), '| администратор', st.userId);
  await ack(t('topics.botSaved', lang));
  return edit(topicsView(st, lang));
}

/** Кнопка режима (tpc:on | tpc:off) или глобальной настройки бота (tpc:bot:* — только администратор). */
export async function onTopicsCallback(st, cb) {
  const lang = langOf(st.userId);
  if (cb.data?.startsWith('tpc:bot:')) return onBotSettingCallback(st, cb, lang);
  const want = cb.data === 'tpc:on';
  const { ack, edit } = cbCtx(st, cb, { alert: true, fallback: (text) => say(st.to, text) });
  if (!topicsSupport.enabled) return ack(t('topics.unsupported', lang));
  if (want === topicsOn(st.userId)) return ack();
  if (statesOf(st.userId).some((s) => s.busy)) return ack(t('topics.busy', lang));
  // в другом режиме — другие диалоги: процессы агентов закрываем (сессии тем сохранятся и продолжатся, когда режим вернут)
  for (const s of statesOf(st.userId)) stopUser(s, 'close');
  setTopicsMode(st.userId, want);
  log('режим «диалоги»', want ? 'включён' : 'выключен', '| пользователь', st.userId);
  await ack();
  const v = topicsView(st, lang);
  await edit(`${t(want ? 'topics.enabled' : 'topics.disabled', lang)}\n\n${v.text}`, v.markup);
}

/**
 * /new в режиме «диалоги»: создаёт тему — новый диалог с движком текущего и его проектом (или project — из списка
 * тем проекта). Название — «проект · Новый диалог», по первому ответу агент даст своё (turn.mjs).
 * В новой теме — приветствие, здесь — кнопка, открывающая её.
 */
export async function newTopic(st, { project = st.project } = {}) {
  const lang = langOf(st.userId);
  const name = topicName(topicProject(st.userId, project, lang), t('topics.newName', lang));
  let threadId;
  try {
    threadId = await createTopic(st.chatId, name);
  } catch (e) {
    log('создание темы:', e.message, '| пользователь', st.userId);
    return say(st.to, t('topics.createFail', lang, { msg: errText(e, lang, errorRootOf(st.userId)) }));
  }
  const engine = engineOf(st);
  db.saveTopic(st.userId, threadId, { name, named: false, project, engine: engine.id });
  log('тема создана', threadId, '| пользователь', st.userId);
  const extra = topicKeyboardExtra(st, lang);
  const sent = await say({ chat_id: st.chatId, message_thread_id: threadId }, t('topics.hello', lang, { engine: engine.label, project: userPath(st.userId, project, lang) }), extra);
  if (extra.reply_markup && sent !== undefined) markReplyKeyboard(st.userId, threadId);
  const link = topicLink(botInfo.username, threadId);
  return say(st.to, t('topics.created', lang), link ? { reply_markup: { inline_keyboard: [[{ text: t('topics.open', lang), url: link }]] } } : {});
}

export async function offerAgentTopics(st, names, lang) {
  const titles = names.map(cleanTitle).filter(Boolean).slice(0, 3);
  if (!titles.length) return;
  const engine = engineOf(st);
  const created = [];
  for (const label of titles) {
    const name = topicName(topicProject(st.userId, st.project, lang), label);
    let threadId;
    try {
      threadId = await createTopic(st.chatId, name);
      if (!threadId) throw new Error('createForumTopic: нет message_thread_id');
    } catch (e) {
      log('создание темы агентом:', e.message, '| пользователь', st.userId);
      continue;
    }
    db.saveTopic(st.userId, threadId, { name, named: true, project: st.project, engine: engine.id });
    log('тема создана агентом', threadId, '| пользователь', st.userId);
    const extra = topicKeyboardExtra(st, lang);
    const sent = await say({ chat_id: st.chatId, message_thread_id: threadId }, t('topics.agentHello', lang, { engine: engine.label, project: userPath(st.userId, st.project, lang) }), extra).catch((e) => log('приветствие в теме агента:', e.message));
    if (extra.reply_markup && sent !== undefined) markReplyKeyboard(st.userId, threadId);
    created.push({ name, threadId });
  }
  if (!created.length) return say(st.to, t('topics.agentCreateFail', lang));
  const rows = created
    .map(({ threadId }) => topicLink(botInfo.username, threadId))
    .filter(Boolean)
    .map((url) => [{ text: t('topics.open', lang), url }]);
  const key = created.length > 1 ? 'topics.agentCreatedMany' : 'topics.agentCreated';
  return say(st.to, t(key, lang, { names: created.map(({ name }) => name).join(', ') }), rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
}

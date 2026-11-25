import { rmSync } from 'node:fs';

/** Есть ли у пользователя доступ: администратор или активный сотрудник. */
const hasAccessWith = (d, id) => d.isAdmin(id) || d.db.getUser(id)?.status === 'active';

/** Модель пользователя для экрана /start: выбранная или «Авто» на его языке. */
const modelLabel = (d, st) => {
  const engine = d.engineOf(st);
  const model = d.effectiveSelection(st.userId, engine).model;
  return model ? d.choiceName(engine, 'model', model) : d.t('auto', d.langOf(st.userId));
};

/** Выбор языка: три кнопки (по /language и кнопке на экране /start). По умолчанию язык берётся из настроек Telegram. */
const sendLangPicker = (d, chatId) =>
  d.say(chatId, d.LANG_PICK, { reply_markup: { inline_keyboard: [d.LANG_CODES.map((code) => ({ text: d.LANGS[code], callback_data: `lang:${code}` }))] } });

const replyOpts = (d, st) => ({ admin: d.isAdmin(st.userId), topics: d.topicsSupport.enabled ? (d.topicsOn(st.userId) ? 'on' : 'off') : null });
const replySeenKey = (userId) => `replyKeyboard:${userId}`;
const markReplyKeyboard = (d, userId) => d.db.setSetting(replySeenKey(userId), '1');

/** /keyboard: подключить reply-клавиатуру повторно (первый /start делает это сам). */
const sendReplyKeyboard = async (d, st) => {
  const lang = d.langOf(st.userId);
  await d.say(st.to, d.t('reply.keyboardOn', lang), { reply_markup: d.replyKeyboard(lang, replyOpts(d, st)) });
  markReplyKeyboard(d, st.userId);
};

/** Экран /start: rich-сообщение с кнопками (если Telegram его не примет — уйдёт обычным текстом со списком команд). */
const sendStart = async (d, st) => {
  const lang = d.langOf(st.userId);
  const opts = replyOpts(d, st);
  const view = d.startView({ level: d.levelLabel(st.userId), project: d.userPath(st.userId, st.project, lang), engine: d.engineOf(st).label, model: modelLabel(d, st), isAdmin: opts.admin, note: opts.admin ? null : d.welcomeNote(lang), topics: opts.topics, lang });
  const first = !d.db.getSetting(replySeenKey(st.userId));
  const extra = first ? { reply_markup: d.replyKeyboard(lang, opts) } : {};
  try {
    await d.sendRich(st.to, view, extra);
    if (first) markReplyKeyboard(d, st.userId);
  } catch (e) {
    d.log('start:', e.message);
  }
};

const helpCommand = (d, st) => {
  const lang = d.langOf(st.userId);
  return d.say(st.to, d.t('help.text', lang, { url: d.DOCS_URL }), { reply_markup: d.helpMarkup(lang) });
};

/** Кнопка «⏹ Остановить» под сообщениями «запрос ещё выполняется» — вместо набора /stop. */
const stopMarkup = (d, lang) => ({ inline_keyboard: [[{ text: d.t('btn.stop', lang), callback_data: 'ui:stop' }]] });
/** Кнопка «Сессии» — вместо набора /sessions. */
const sessionsMarkup = (d, lang) => ({ inline_keyboard: [[{ text: d.t('btn.sessions', lang), callback_data: 'ui:sessions' }]] });

/** Кнопка выбора языка (lang:<код>): запоминает выбор и заменяет меню итогом. */
async function onLangCallback(d, st, cb) {
  const code = (cb.data || '').slice('lang:'.length);
  const chatId = cb.message?.chat?.id ?? st.chatId;
  await d.tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!d.LANG_CODES.includes(code)) return;
  d.setLang(st.userId, code);
  const text = d.t('lang.set', code, { name: d.LANGS[code] });
  await d.tg('editMessageText', { chat_id: chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => d.say(chatId, text));
  return d.say(chatId, d.t('reply.updated', code));
}

/** /language [ru|uk|en] — без аргумента показываем выбор языка. */
function languageCommand(d, st, arg) {
  const q = (arg || '').trim().toLowerCase();
  const code = d.normLang(q);
  if (!code || q !== code) return sendLangPicker(d, st.to);
  d.setLang(st.userId, code);
  return d.say(st.to, d.t('lang.set', code, { name: d.LANGS[code] }));
}

function stopCommand(d, st) {
  const queued = d.dropQueue(st);
  if (!st.busy) return queued ? undefined : d.say(st.to, d.t('stop.none', d.langOf(st.userId)));
  st.agent?.cancel();
  d.forceStopAfter(st);
  d.dropPermissions(st);
}

function closeCommand(d, st) {
  const lang = d.langOf(st.userId);
  if (!d.closeSession(st, 'close')) return d.say(st.to, d.t('close.none', lang));
  return d.say(st.to, d.t('close.done', lang, { slot: d.isAdmin(st.userId) ? '' : d.t('close.slot', lang) }), { reply_markup: sessionsMarkup(d, lang) });
}

function newCommand(d, st) {
  const lang = d.langOf(st.userId);
  if (d.topicsOn(st.userId)) return d.newTopic(st);
  if (st.busy) return d.say(st.to, d.t('busy.stop', lang), { reply_markup: stopMarkup(d, lang) });
  d.endAgent(st, 'new');
  return d.say(st.to, d.t('new.done', lang, { engine: d.engineOf(st).label, project: d.userPath(st.userId, st.project, lang) }));
}

/**
 * Команды бота — единственный список: по нему работают разбор текста (handleText), меню Telegram (menuFor), кнопки
 * экрана /start (onUiCallback) и перенос команды из темы, созданной Telegram, в General (BOT_COMMANDS).
 *   aliases — другие имена команды; admin — только главному администратору; menu — показывать в меню команд
 *   (функция — по условию); button — есть кнопка ui:<имя> на экране /start; run(d, st, arg) — выполнение.
 * Порядок — порядок в меню: сначала команды администратора.
 */
export const COMMANDS = [
  { name: 'active', admin: true, menu: true, button: true, run: (d, st) => d.adminCommand(st.to, '/active') },
  { name: 'users', admin: true, menu: true, button: true, run: (d, st) => d.adminCommand(st.to, '/users') },
  { name: 'invite', admin: true, menu: true, button: true, run: (d, st) => d.adminCommand(st.to, '/invite') },
  { name: 'usage', admin: true, menu: true, button: true, run: (d, st) => d.adminCommand(st.to, '/usage') },
  { name: 'project', menu: true, button: true, run: (d, st, arg) => d.handleProject(st, arg) },
  { name: 'files', menu: true, button: true, run: (d, st) => d.handleFiles(st) },
  { name: 'git', menu: true, button: true, run: (d, st) => d.handleGit(st) },
  { name: 'engine', menu: true, button: true, run: (d, st, arg) => d.handleEngine(st, arg) },
  { name: 'model', menu: true, button: true, run: (d, st, arg) => d.handleModel(st, arg) },
  { name: 'new', menu: true, button: true, run: newCommand },
  { name: 'sessions', menu: true, button: true, run: (d, st) => d.handleSessions(st) },
  { name: 'stop', menu: true, button: true, run: stopCommand },
  { name: 'close', aliases: ['exit'], menu: true, button: true, run: closeCommand },
  { name: 'topics', menu: (d, admin) => admin || d.topicsSupport.enabled, button: true, run: (d, st) => d.handleTopics(st) },
  { name: 'language', aliases: ['lang'], menu: true, button: true, run: languageCommand },
  { name: 'keyboard', menu: false, run: (d, st) => sendReplyKeyboard(d, st) },
  { name: 'help', menu: true, run: helpCommand },
  { name: 'start', menu: true, run: sendStart },
];

/** Имена всех команд бота с псевдонимами: только они переносятся из темы, созданной Telegram, в General. */
export const BOT_COMMANDS = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));

export const commandsFor = (d) => COMMANDS.map((c) => ({ ...c, run: (st, arg) => c.run(d, st, arg) }));

/** Запрос агенту: если диалог занят — в очередь (уйдёт следующим), иначе сразу. */
const sendToAgent = (d, st, text, opts = {}) => (st.busy ? d.enqueue(st, text, opts) : d.runTurn(st, text, opts));

/**
 * Текст пользователя: команды или запрос к агенту. Неизвестная команда («/что-то») уходит агенту как обычный запрос —
 * у агентов есть свои команды («/compact»); но если она на одну правку отличается от команды бота и агент такой
 * команды не объявил, это, скорее всего, опечатка: спрашиваем, а не тратим запрос.
 * @param {{quote?: string|null}} [opts] quote — фрагмент прошлого сообщения, на которое отвечает пользователь
 */
async function handleTextWith(d, st, text, { quote = null, messageId = null } = {}) {
  const lang = d.langOf(st.userId);
  const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  const label = text.trim();
  const reply = label ? d.replyCommandOf(label, lang, { ...replyOpts(d, st), admin: true }) : null;
  const name = m?.[1]?.toLowerCase() || reply?.name;
  const command = name ? commandsFor(d).find((c) => c.name === name || c.aliases?.includes(name)) : null;
  if (command) {
    d.clearPendingInput(st);
    if (command.admin && !d.isAdmin(st.userId)) return d.say(st.to, d.t('admin.only', lang));
    const arg = m?.[2];
    return arg === undefined ? command.run(st) : command.run(st, arg);
  }

  if (await d.onProjectNameInput(st, text)) return;
  if (await d.onFileInput(st, text, { messageId })) return;
  if (await d.onGitInput(st, text, { messageId })) return;
  if (d.looksLikeSecret(text)) {
    if (messageId) d.tg('deleteMessage', { chat_id: st.chatId, message_id: messageId }).catch(() => {});
    return d.say(st.to, d.t('secret.detected', lang));
  }
  if (name && !st.agent?.commands?.has(name)) {
    const guess = d.nearCommand(name, COMMANDS.filter((c) => !c.admin || d.isAdmin(st.userId)).map((c) => c.name));
    if (guess) {
      st.rawCommand = text;
      return d.say(st.to, d.t('cmd.typo', lang, { cmd: name, guess }), {
        reply_markup: { inline_keyboard: [[{ text: `/${guess}`, callback_data: `ui:${guess}` }], [{ text: d.t('cmd.sendAsIs', lang), callback_data: 'cmd:raw' }]] },
      });
    }
  }
  return sendToAgent(d, st, text, { quote });
}

/** Кнопка «Отправить агенту как есть» под вопросом об опечатке в команде. */
async function onRawCommandCallback(d, st, cb) {
  const text = st.rawCommand;
  st.rawCommand = null;
  if (!text) return d.tg('answerCallbackQuery', { callback_query_id: cb.id, text: d.t('cmd.stale', d.langOf(st.userId)) }).catch(() => {});
  await d.tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  await d.tg('editMessageReplyMarkup', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  return sendToAgent(d, st, text);
}

/**
 * Меню команд на языке: по умолчанию — английский; русский и украинский — для клиентов Telegram с таким языком
 * (язык меню задаёт приложение Telegram, а не /language). У администратора — дополнительно /users, /active, /invite.
 */
const menuForWith = (d, lang, admin) =>
  COMMANDS.filter((c) => (typeof c.menu === 'function' ? c.menu(d, admin) : c.menu) && (admin || !c.admin)).map((c) => ({ command: c.name, description: d.t(`menu.${c.name}`, lang) }));

async function setupCommandsWith(d) {
  await d.tg('setMyCommands', { scope: { type: 'default' }, commands: menuForWith(d, 'en', false) });
  await d.tg('setMyCommands', { scope: { type: 'chat', chat_id: d.ADMIN_ID }, commands: menuForWith(d, 'en', true) });
  for (const code of d.LANG_CODES.filter((c) => c !== 'en')) {
    await d.tg('setMyCommands', { scope: { type: 'default' }, language_code: code, commands: menuForWith(d, code, false) });
    await d.tg('setMyCommands', { scope: { type: 'chat', chat_id: d.ADMIN_ID }, language_code: code, commands: menuForWith(d, code, true) });
  }
  await d.tg('setChatMenuButton', { menu_button: d.docsMenuButton() });
}

/**
 * Удаляет тему, которую Telegram создал под команду, отправленную из общего вида чата. Не удалось (нет прав, старый
 * Telegram) — false: команда выполнится в самой теме, как раньше.
 */
async function dropAutoTopic(d, userId, chatId, threadId) {
  try {
    await d.deleteTopic(chatId, threadId);
    d.db.deleteTopic(userId, threadId);
    d.log('тема, созданная Telegram под команду, удалена', threadId, '| команда выполнена в General | пользователь', userId);
    return true;
  } catch (e) {
    d.log('удаление темы под команду:', e.message, '| пользователь', userId);
    return false;
  }
}

/**
 * Запоминает тему, которую создал или переименовал пользователь (в режиме «диалоги»). Тема без названия
 * (is_name_implicit) получит название от агента по первому ответу; названную пользователем не переименовываем.
 * @returns {boolean} true — это служебное сообщение о теме (создана, переименована), отвечать на него не нужно
 */
function noteTopic(d, userId, threadId, msg) {
  if (!d.topicsOn(userId)) return false;
  if (msg.forum_topic_edited) {
    if (msg.forum_topic_edited.name) d.db.saveTopic(userId, threadId, { name: msg.forum_topic_edited.name, named: true });
    return true;
  }
  const info = d.topicInfoOf(msg);
  if (msg.forum_topic_created) d.topicsSupport.usersCreate = true;
  if (!d.db.getTopic(userId, threadId)) {
    d.db.saveTopic(userId, threadId, { name: info?.name ?? null, named: info ? !info.implicit : true });
    d.log('тема пользователя', threadId, info?.name ?? '', info?.implicit ? '(без названия)' : '', '| пользователь', userId);
  }
  return Boolean(msg.forum_topic_created);
}

export const createBotRouting = (d) => {
  const updateHits = new Map();
  const receiveQueue = d.createQueue(1);
  const reservedUploads = new Map();
  const commands = commandsFor(d);
  const UPDATE_LIMIT = d.UPDATE_LIMIT ?? 20;
  const UPDATE_WINDOW_MS = d.UPDATE_WINDOW_MS ?? 10_000;

  function tooManyUpdates(id) {
    const now = Date.now();
    const hits = (updateHits.get(id) ?? []).filter((at) => now - at < UPDATE_WINDOW_MS);
    if (hits.length >= UPDATE_LIMIT) {
      updateHits.set(id, hits);
      return true;
    }
    hits.push(now);
    updateHits.set(id, hits);
    return false;
  }

  function sweepUpdateLimits() {
    const until = Date.now() - UPDATE_WINDOW_MS;
    let n = 0;
    for (const [id, hits] of updateHits) {
      const fresh = hits.filter((at) => at > until);
      if (!fresh.length) {
        updateHits.delete(id);
        n++;
      } else updateHits.set(id, fresh);
    }
    return n;
  }

  function handleText(st, text, opts) {
    return handleTextWith(d, st, text, opts);
  }

  async function onUiCallback(st, cb) {
    const name = (cb.data || '').slice('ui:'.length);
    await d.tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    if (commands.some((c) => c.button && c.name === name)) return handleText(st, `/${name}`);
  }

  const reservedFor = (userId) => reservedUploads.get(String(userId)) ?? 0;
  const reserveUpload = (userId, bytes) => reservedUploads.set(String(userId), reservedFor(userId) + bytes);
  const releaseUpload = (userId, bytes) => reservedUploads.set(String(userId), Math.max(0, reservedFor(userId) - bytes));

  function dropReceived(files) {
    for (const f of files) {
      try {
        if (f.unpacked?.dir) rmSync(f.unpacked.dir, { recursive: true, force: true });
        rmSync(f.path, { force: true });
      } catch (e) {
        d.log('удаление непринятого файла:', e.message);
      }
    }
  }

  async function receiveFile(st, meta, lang) {
    if (meta.size > d.MAX_FILE_BYTES) {
      await d.say(st.to, d.t('file.tooBig', lang));
      return null;
    }
    const dir = d.uploadsDir(st.userId);
    if (!d.fitsUpload({ usedBytes: d.directorySize(dir), incomingBytes: meta.size, limitMb: d.UPLOADS_QUOTA_MB, free: d.freeBytes(dir), minFreeMb: d.MIN_FREE_MB, reservedBytes: reservedFor(st.userId) })) {
      await d.say(st.to, d.t('file.quota', lang));
      return null;
    }
    reserveUpload(st.userId, meta.size);
    let data;
    try {
      data = await d.downloadFile(meta.id);
    } catch (e) {
      d.log('скачивание файла:', e.message, '| пользователь', st.userId);
      await d.say(st.to, d.t('file.downloadFail', lang, { msg: d.errText(e, lang, d.errorRootOf(st.userId)) }));
      return null;
    } finally {
      releaseUpload(st.userId, meta.size);
    }
    if (data.length > d.MAX_FILE_BYTES) {
      await d.say(st.to, d.t('file.tooBig', lang));
      return null;
    }
    const path = await d.saveUpload(dir, meta.name, data);
    d.log('файл принят', st.userId, path, `${data.length} Б`);
    const file = { path, name: meta.name, mime: meta.mime, size: data.length };
    if (d.isImageMime(meta.mime) && data.length <= d.IMAGE_BLOCK_MAX) file.data = data;
    const kind = d.archiveKind(meta.name);
    if (kind) {
      const unpacked = `${path}_unpacked`;
      try {
        file.unpacked = { dir: unpacked, ...(await d.extractArchiveAsync(data, kind, unpacked)) };
        d.log('архив распакован', st.userId, unpacked, `${file.unpacked.files.length} файлов, пропущено ${file.unpacked.skipped}`);
      } catch (e) {
        d.log('архив не распакован:', e.reason ?? e.message, '| пользователь', st.userId);
        await d.say(st.to, d.t('file.archiveSkipped', lang, { name: meta.name, why: d.t(`file.archiveWhy.${e.reason ?? 'corrupt'}`, lang) }));
      }
    }
    return file;
  }

  async function processAttachments(st, msgs) {
    const lang = d.langOf(st.userId);
    if (st.receiving) return d.say(st.to, d.t('file.receiving', lang));
    if (st.busy) return d.say(st.to, d.t('busy.running', lang), { reply_markup: stopMarkup(d, lang) });
    st.receiving = true;
    try {
      const files = await receiveQueue.add(async () => {
        const out = [];
        for (const msg of msgs) {
          const meta = d.describeAttachment(msg);
          if (!meta) continue;
          const file = await receiveFile(st, meta, lang);
          if (file) out.push(file);
        }
        return out;
      });
      if (!files.length) return;
      if (st.busy) {
        dropReceived(files);
        return d.say(st.to, d.t('busy.running', lang), { reply_markup: stopMarkup(d, lang) });
      }
      const caption = msgs.map((m) => m.caption?.trim()).find(Boolean) ?? '';
      return await d.runTurn(st, caption, { files });
    } finally {
      st.receiving = false;
    }
  }

  const albums = d.createAlbumBuffer({
    onFlush: (_key, items) => {
      const { st } = items[0];
      processAttachments(st, items.map((i) => i.msg).sort((a, b) => a.message_id - b.message_id)).catch((e) => d.log('альбом:', e.message));
    },
  });

  function handleAttachment(st, msg) {
    if (msg.media_group_id) return albums.add(`${st.chatId}:${msg.media_group_id}`, { st, msg });
    return processAttachments(st, [msg]);
  }

  function stoppedGeneration(sg) {
    const st = d.findState(sg.chat?.id, sg.message_thread_id ?? null);
    if (st?.busy) {
      st.agent?.cancel();
      d.dropPermissions(st);
    }
  }

  function widgetQuery(q) {
    if (!q.from || q.from.is_bot || (q.chat && q.chat.type !== 'private') || !hasAccessWith(d, q.from.id)) return;
    return d.onWidgetQuery(q);
  }

  function deniedUpdate(from, cb, chatId, msg) {
    if (cb) return d.tg('answerCallbackQuery', { callback_query_id: cb.id, text: d.t('access.denied', d.langOf(from.id)) }).catch(() => {});
    if (msg?.write_access_allowed?.inviter) {
      d.log('приглашение через botinvite, id =', from.id, from.username);
      return d.handleBotInvite?.(from, chatId, msg.write_access_allowed.inviter);
    }
    if (msg?.text) {
      d.log('нет доступа, id =', from.id, from.username);
      return d.handleUnknownUser(from, chatId, msg.text);
    }
  }

  async function callbackUpdate(from, cb, chatId, threadId) {
    const data = cb.data || '';
    if (data.startsWith('adm:')) return d.isAdmin(from.id) ? d.onAdminCallback(cb) : d.tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    const st = d.getState(from.id, chatId, threadId);
    if (data.startsWith('tpc:')) return d.onTopicsCallback(st, cb);
    if (data.startsWith('tpl:')) return d.onTopicListCallback(st, cb);
    if (data.startsWith('nav:')) return d.onNavCallback(st, cb);
    if (data.startsWith('fl:')) return d.onFilesCallback(st, cb);
    if (data.startsWith('gt:')) return d.onGitCallback(st, cb);
    if (data.startsWith('perm:')) return d.onPermissionCallback(st, cb);
    if (data.startsWith('ask:')) return d.onAskCallback(st, cb);
    if (data.startsWith('q:')) return d.onQueueCallback(st, cb);
    if (data === 'cmd:raw') return onRawCommandCallback(d, st, cb);
    if (data === 'wid:model' || data === 'wid:sessions') {
      await d.tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
      return data === 'wid:model' ? d.handleModel(st, '', { classic: true }) : d.handleSessions(st, { classic: true });
    }
    if (data.startsWith('ses:')) return d.onSessionCallback(st, cb);
    if (data.startsWith('eng:')) return d.onEngineCallback(st, cb);
    if (data.startsWith('mdl:')) return d.onModelCallback(st, cb);
    if (data.startsWith('ui:')) return onUiCallback(st, cb);
    if (data.startsWith('lang:')) return onLangCallback(d, st, cb);
  }

  async function messageUpdate(from, msg, chatId, threadId) {
    if (msg?.text) return handleText(d.getState(from.id, chatId, threadId), msg.text, { quote: d.quoteOf(msg), messageId: msg.message_id });
    if (msg?.photo || msg?.document) {
      const st = d.getState(from.id, chatId, threadId);
      if (await d.onFileUpload(st, msg)) return;
      return handleAttachment(st, msg);
    }
    if (d.unsupportedKind(msg)) return d.say(d.getState(from.id, chatId, threadId).to, d.t('msg.unsupported', d.langOf(from.id)));
  }

  async function handleUpdate(u) {
    const actor = u.message?.from || u.callback_query?.from || u.widget_query?.from || (u.stopped_message_generation ? { id: u.stopped_message_generation.chat?.id ?? '?' } : null);
    if (actor && tooManyUpdates(actor.id)) return;

    if (u.stopped_message_generation) return stoppedGeneration(u.stopped_message_generation);

    if (u.widget_query) return widgetQuery(u.widget_query);

    const msg = u.message;
    const cb = u.callback_query;
    const from = msg?.from || cb?.from;
    if (!from || from.is_bot) return;
    if (msg && msg.chat.type !== 'private') return;
    if (cb?.message?.chat && cb.message.chat.type !== 'private') return;
    const chatId = msg?.chat.id ?? cb.message?.chat?.id ?? from.id;

    d.noteTgLang(from.id, from.language_code);
    if (!hasAccessWith(d, from.id)) return deniedUpdate(from, cb, chatId, msg);
    d.noteTgLang(from.id, from.language_code, true);
    if (!d.isAdmin(from.id)) d.db.touchUser(from.id, from.username, from.first_name);

    const source = msg ?? cb?.message;
    const threadId = source?.is_topic_message && source.message_thread_id ? source.message_thread_id : null;
    if (msg && threadId && d.topicsOn(from.id) && d.isAutoTopicCommand(msg, Boolean(d.db.getTopic(from.id, threadId)), BOT_COMMANDS)) {
      if (await dropAutoTopic(d, from.id, chatId, threadId)) return handleText(d.getState(from.id, chatId, null), msg.text);
    }
    if (msg && threadId && noteTopic(d, from.id, threadId, msg)) return;

    if (cb) return callbackUpdate(from, cb, chatId, threadId);
    if (msg) return messageUpdate(from, msg, chatId, threadId);
  }

  return {
    hasAccess: (id) => hasAccessWith(d, id),
    COMMANDS: commands,
    BOT_COMMANDS,
    tooManyUpdates,
    sweepUpdateLimits,
    handleText,
    handleUpdate,
    menuFor: (lang, admin) => menuForWith(d, lang, admin),
    setupCommands: () => setupCommandsWith(d),
  };
};

let active = null;

export function configureBotRouting(deps) {
  active = createBotRouting(deps);
  return active;
}

const current = () => {
  if (!active) throw new Error('Bot routing is not configured');
  return active;
};

export const hasAccess = (id) => current().hasAccess(id);
export const handleText = (st, text, opts) => current().handleText(st, text, opts);
export const handleUpdate = (u) => current().handleUpdate(u);
export const tooManyUpdates = (id) => current().tooManyUpdates(id);
export const sweepUpdateLimits = () => current().sweepUpdateLimits();
export const menuFor = (lang, admin) => current().menuFor(lang, admin);
export const setupCommands = () => current().setupCommands();

export { dropAutoTopic, handleTextWith, hasAccessWith, menuForWith, noteTopic, sendToAgent, setupCommandsWith };

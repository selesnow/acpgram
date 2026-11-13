// Telegram-интерфейс к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex) через ACP.
// Доступ: главный администратор (ALLOWED_USER_ID) и сотрудники, которым он выдал доступ. Остальным бот не отвечает,
// кроме запроса доступа администратору.
import { DEFAULT_ENGINE, checkEngines, isRequired, setAvailability } from './engines.mjs';
import { handleEngine, onEngineCallback } from './engineUi.mjs';
import { choiceName, effectiveSelection, killProbes, refreshCatalogs } from './access.mjs';
import { handleModel, onModelCallback } from './modelUi.mjs';
import { ADMIN_ID, IDLE_MINUTES, LEVEL_KEYS, MAX_AGENTS, botInfo, db, langOf, log, noteTgLang, say, setLang } from './ctx.mjs';
import { adminCommand, handleUnknownUser, onAdminCallback, welcomeNote } from './admin.mjs';
import { LANGS, LANG_CODES, LANG_PICK, normLang, t } from './i18n.mjs';
import { HOME, ROOT, showPath } from './projects.mjs';
import { handleProject, onNavCallback, onTopicListCallback } from './projectsUi.mjs';
import { handleSessions, onSessionCallback } from './sessionsUi.mjs';
import { dropPermissions, findState, getState, isAdmin, levelLabel, shutdownAll, startIdleReaper, endAgent, closeSession, engineOf, topicsOn, topicsSupport } from './state.mjs';
import { handleTopics, newTopic, onTopicsCallback } from './topicsUi.mjs';
import { topicInfoOf } from './topics.mjs';
import { setSyncKill } from './acp.mjs';
import { downloadFile, sendRich, tg } from './telegram.mjs';
import { MAX_FILE_BYTES, IMAGE_BLOCK_MAX, cleanupFiles, describeAttachment, isImageMime, saveUpload, uploadsDir } from './files.mjs';
import { archiveKind, extractArchiveAsync } from './archive.mjs';
import { createAlbumBuffer } from './albums.mjs';
import { onPermissionCallback, runTurn } from './turn.mjs';
import { startView } from './ui.mjs';

if (!process.env.TELEGRAM_BOT_TOKEN || !ADMIN_ID) {
  console.error('Нужны TELEGRAM_BOT_TOKEN и ALLOWED_USER_ID (см. .env)');
  process.exit(1);
}

/** Есть ли у пользователя доступ: администратор или активный сотрудник. */
const hasAccess = (id) => isAdmin(id) || db.getUser(id)?.status === 'active';

/** Модель пользователя для экрана /start: выбранная или «Авто» на его языке. */
const modelLabel = (st) => {
  const engine = engineOf(st);
  const model = effectiveSelection(st.userId, engine).model;
  return model ? choiceName(engine, 'model', model) : t('auto', langOf(st.userId));
};

/** Выбор языка: три кнопки (по /language и кнопке на экране /start). По умолчанию язык берётся из настроек Telegram. */
const sendLangPicker = (chatId) =>
  say(chatId, LANG_PICK, { reply_markup: { inline_keyboard: [LANG_CODES.map((code) => ({ text: LANGS[code], callback_data: `lang:${code}` }))] } });

/** Экран /start: rich-сообщение с кнопками (если Telegram его не примет — уйдёт обычным текстом со списком команд). */
const sendStart = (st) => {
  const lang = langOf(st.userId);
  const admin = isAdmin(st.userId);
  const topics = topicsSupport.enabled ? (topicsOn(st.userId) ? 'on' : 'off') : null; // режим «диалоги», если у бота есть темы
  return sendRich(st.to, startView({ level: levelLabel(st.userId), project: showPath(st.project, lang), engine: engineOf(st).label, model: modelLabel(st), isAdmin: admin, note: admin ? null : welcomeNote(lang), topics, lang })).catch((e) => log('start:', e.message));
};

/** Кнопки экрана /start (ui:<команда>) работают как соответствующие команды. */
const UI_COMMANDS = new Set(['project', 'engine', 'model', 'new', 'sessions', 'users', 'invite', 'close', 'active', 'language', 'topics']);
async function onUiCallback(st, cb) {
  const name = (cb.data || '').slice('ui:'.length);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (UI_COMMANDS.has(name)) return handleText(st, `/${name}`);
}

/** Кнопка выбора языка (lang:<код>): запоминает выбор и заменяет меню итогом. */
async function onLangCallback(st, cb) {
  const code = (cb.data || '').slice('lang:'.length);
  const chatId = cb.message?.chat?.id ?? st.chatId;
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!LANG_CODES.includes(code)) return;
  setLang(st.userId, code);
  const text = t('lang.set', code, { name: LANGS[code] });
  await tg('editMessageText', { chat_id: chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(chatId, text));
}

/** /language [ru|uk|en] — без аргумента показываем выбор языка. */
function languageCommand(st, arg) {
  const q = (arg || '').trim().toLowerCase();
  const code = normLang(q);
  if (!code || q !== code) return sendLangPicker(st.to);
  setLang(st.userId, code);
  return say(st.to, t('lang.set', code, { name: LANGS[code] }));
}

/** Текст пользователя: команды или запрос к агенту. */
async function handleText(st, text) {
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  const name = cmd?.[1]?.toLowerCase();
  const arg = cmd?.[2];

  const lang = langOf(st.userId);
  if (name === 'start') return sendStart(st);
  if (name === 'language' || name === 'lang') return languageCommand(st, arg);
  if (name === 'project') return handleProject(st, arg);
  if (name === 'engine') return handleEngine(st, arg);
  if (name === 'model') return handleModel(st);
  if (name === 'sessions') return handleSessions(st);
  if (name === 'topics') return handleTopics(st);
  if (name === 'stop') {
    if (!st.busy) return say(st.to, t('stop.none', lang));
    st.agent?.cancel();
    dropPermissions(st);
    return;
  }
  if (name === 'close' || name === 'exit') {
    if (!closeSession(st, 'close')) return say(st.to, t('close.none', lang));
    return say(st.to, t('close.done', lang, { slot: isAdmin(st.userId) ? '' : t('close.slot', lang) }));
  }
  if (name === 'new') {
    if (topicsOn(st.userId)) return newTopic(st); // режим «диалоги»: новый диалог — новая тема, текущий остаётся как есть
    if (st.busy) return say(st.to, t('busy.stop', lang));
    endAgent(st, 'new');
    return say(st.to, t('new.done', lang, { engine: engineOf(st).label, project: showPath(st.project, lang) }));
  }
  if (name === 'invite' || name === 'users' || name === 'active') {
    if (!isAdmin(st.userId)) return say(st.to, t('admin.only', lang));
    return adminCommand(st.to, `/${name}`);
  }
  if (st.busy) return say(st.to, t('busy.running', lang));
  return runTurn(st, text);
}

/**
 * Принимает файл: скачивает, сохраняет в каталог загрузок и (для архивов) распаковывает рядом.
 * Возвращает описание файла для агента или null, если файл не принят (пользователь уже уведомлён).
 */
async function receiveFile(st, meta, lang) {
  if (meta.size > MAX_FILE_BYTES) {
    await say(st.to, t('file.tooBig', lang));
    return null;
  }
  let data;
  try {
    data = await downloadFile(meta.id);
  } catch (e) {
    log('скачивание файла:', e.message, '| пользователь', st.userId);
    await say(st.to, t('file.downloadFail', lang, { msg: e.message }));
    return null;
  }
  if (data.length > MAX_FILE_BYTES) {
    await say(st.to, t('file.tooBig', lang));
    return null;
  }
  const path = saveUpload(uploadsDir(st.userId), meta.name, data);
  log('файл принят', st.userId, path, `${data.length} Б`);
  const file = { path, name: meta.name, mime: meta.mime, size: data.length };
  if (isImageMime(meta.mime) && data.length <= IMAGE_BLOCK_MAX) file.data = data; // только картинки и только небольшие
  const kind = archiveKind(meta.name);
  if (kind) {
    // архив: рядом с ним папка с содержимым; не вышло — агент получит сам архив, пользователь причину
    const dir = `${path}_unpacked`;
    try {
      file.unpacked = { dir, ...(await extractArchiveAsync(data, kind, dir)) };
      log('архив распакован', st.userId, dir, `${file.unpacked.files.length} файлов, пропущено ${file.unpacked.skipped}`);
    } catch (e) {
      log('архив не распакован:', e.reason ?? e.message, '| пользователь', st.userId);
      await say(st.to, t('file.archiveSkipped', lang, { name: meta.name, why: t(`file.archiveWhy.${e.reason ?? 'corrupt'}`, lang) }));
    }
  }
  return file;
}

/**
 * Фото или файлы от пользователя (одно сообщение или целый альбом): скачиваем, сохраняем и передаём агенту
 * вместе с подписью (первая найденная подпись). Изображения уходят блоком image (если агент это умеет), остальное — путём.
 */
async function processAttachments(st, msgs) {
  const lang = langOf(st.userId);
  if (st.busy) return say(st.to, t('busy.running', lang));
  const received = await Promise.all(msgs.map((m) => describeAttachment(m)).filter(Boolean).map((meta) => receiveFile(st, meta, lang)));
  const files = received.filter(Boolean);
  if (!files.length) return;
  // пока качался альбом, пользователь мог отправить текст и занять агента
  if (st.busy) return say(st.to, t('busy.running', lang));
  const caption = msgs.map((m) => m.caption?.trim()).find(Boolean) ?? '';
  return runTurn(st, caption, { files });
}

// альбом приходит отдельными сообщениями с общим media_group_id: собираем и обрабатываем одним запросом
const albums = createAlbumBuffer({
  onFlush: (key, items) => {
    const { st } = items[0];
    processAttachments(st, items.map((i) => i.msg).sort((a, b) => a.message_id - b.message_id)).catch((e) => log('альбом:', e.message));
  },
});

function handleAttachment(st, msg) {
  if (msg.media_group_id) return albums.add(`${st.chatId}:${msg.media_group_id}`, { st, msg });
  return processAttachments(st, [msg]);
}

/**
 * Меню команд на языке: по умолчанию — английский; русский и украинский — для клиентов Telegram с таким языком
 * (язык меню задаёт приложение Telegram, а не /language). У администратора — дополнительно /users, /active, /invite.
 */
const menuFor = (lang, admin) => {
  // /topics — только если у бота включены темы в личном чате
  const names = ['project', 'engine', 'model', 'new', 'sessions', 'stop', 'close', ...(topicsSupport.enabled ? ['topics'] : []), 'language', 'start'];
  const common = names.map((command) => ({ command, description: t(`menu.${command}`, lang) }));
  if (!admin) return common;
  return [{ command: 'active', description: t('menu.active', lang) }, { command: 'users', description: t('menu.users', lang) }, { command: 'invite', description: t('menu.invite', lang) }, ...common];
};

async function setupCommands() {
  await tg('setMyCommands', { scope: { type: 'default' }, commands: menuFor('en', false) });
  await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: menuFor('en', true) });
  for (const code of LANG_CODES.filter((c) => c !== 'en')) {
    await tg('setMyCommands', { scope: { type: 'default' }, language_code: code, commands: menuFor(code, false) });
    await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, language_code: code, commands: menuFor(code, true) });
  }
}

async function handleUpdate(u) {
  // пользователь нажал «стоп» на черновике
  if (u.stopped_message_generation) {
    const sg = u.stopped_message_generation;
    const st = findState(sg.chat?.id, sg.message_thread_id ?? null); // в личном чате id чата = id пользователя
    if (st?.busy) {
      st.agent?.cancel();
      dropPermissions(st);
    }
    return;
  }

  const msg = u.message;
  const cb = u.callback_query;
  const from = msg?.from || cb?.from;
  if (!from || from.is_bot) return;
  if (msg && msg.chat.type !== 'private') return; // работаем только в личных чатах
  // бот работает только в личных чатах, поэтому id чата = id пользователя (на случай кнопки без cb.message)
  const chatId = msg?.chat.id ?? cb.message?.chat?.id ?? from.id;

  noteTgLang(from.id, from.language_code); // язык по умолчанию — язык Telegram пользователя (в базу — только после проверки доступа)
  if (!hasAccess(from.id)) {
    if (cb) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: t('access.denied', langOf(from.id)) }).catch(() => {});
    if (msg?.text) {
      log('нет доступа, id =', from.id, from.username);
      return handleUnknownUser(from, chatId, msg.text);
    }
    return;
  }
  noteTgLang(from.id, from.language_code, true);
  if (!isAdmin(from.id)) db.touchUser(from.id, from.username, from.first_name);

  // тема, откуда пришло сообщение или нажата кнопка (темы в личном чате с ботом); null — общий чат
  const source = msg ?? cb?.message;
  const threadId = source?.is_topic_message && source.message_thread_id ? source.message_thread_id : null;
  if (msg && threadId && noteTopic(from.id, threadId, msg)) return; // служебное сообщение о теме — запомнили, отвечать не нужно

  if (cb) {
    const data = cb.data || '';
    if (data.startsWith('adm:')) return isAdmin(from.id) ? onAdminCallback(cb) : tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    const st = getState(from.id, chatId, threadId);
    if (data.startsWith('tpc:')) return onTopicsCallback(st, cb);
    if (data.startsWith('tpl:')) return onTopicListCallback(st, cb);
    if (data.startsWith('nav:')) return onNavCallback(st, cb);
    if (data.startsWith('perm:')) return onPermissionCallback(st, cb);
    if (data.startsWith('ses:')) return onSessionCallback(st, cb);
    if (data.startsWith('eng:')) return onEngineCallback(st, cb);
    if (data.startsWith('mdl:')) return onModelCallback(st, cb);
    if (data.startsWith('ui:')) return onUiCallback(st, cb);
    if (data.startsWith('lang:')) return onLangCallback(st, cb);
    return;
  }
  if (msg?.text) return handleText(getState(from.id, chatId, threadId), msg.text);
  if (msg?.photo || msg?.document) return handleAttachment(getState(from.id, chatId, threadId), msg);
}

/**
 * Запоминает тему, которую создал или переименовал пользователь (в режиме «диалоги»). Тема без названия
 * (is_name_implicit) получит название от агента по первому ответу; названную пользователем не переименовываем.
 * @returns {boolean} true — это служебное сообщение о теме (создана, переименована), отвечать на него не нужно
 */
function noteTopic(userId, threadId, msg) {
  if (!topicsOn(userId)) return false;
  if (msg.forum_topic_edited) {
    if (msg.forum_topic_edited.name) db.saveTopic(userId, threadId, { name: msg.forum_topic_edited.name, named: true });
    return true;
  }
  const info = topicInfoOf(msg);
  if (msg.forum_topic_created) topicsSupport.usersCreate = true; // пользователь создал тему сам — значит, это разрешено
  if (!db.getTopic(userId, threadId)) {
    // неизвестная тема без сведений о создании — считаем названной: чужое название не трогаем
    db.saveTopic(userId, threadId, { name: info?.name ?? null, named: info ? !info.implicit : true });
    log('тема пользователя', threadId, info?.name ?? '', info?.implicit ? '(без названия)' : '', '| пользователь', userId);
  }
  return Boolean(msg.forum_topic_created);
}

async function main() {
  // все движки проверяем параллельно; без движка по умолчанию (DEFAULT_ENGINE) бот не запускается, остальные — по возможности
  const asked = process.env.DEFAULT_ENGINE?.trim().toLowerCase();
  if (asked && asked !== DEFAULT_ENGINE) log(`⚠️ DEFAULT_ENGINE=${asked} не распознан (gemini | claude | agy | codex), используется ${DEFAULT_ENGINE}`);
  const checks = await checkEngines();
  setAvailability(checks);
  for (const r of checks) {
    const { engine: e, command } = r;
    if (r.ok) log(`${e.label} ${r.version} | ${command}`);
    else if (r.timeout) log(`⚠️ ${e.label} не ответил на ${e.versionArgs.join(' ')}: ${r.error} — продолжаем запуск`);
    else if (isRequired(e)) {
      console.error(`Не удалось запустить ${e.label} (${command}): ${r.error}\nУстановите: ${e.install} — или укажите полный путь в ${e.envVar} (см. .env.example)`);
      process.exit(1);
    } else log(`ℹ️ ${e.label} недоступен (${command}): ${r.error}. Установка: ${e.install}; путь — ${e.envVar}`);
  }
  log(`движок по умолчанию: ${DEFAULT_ENGINE}`);
  log(
    ROOT
      ? `корень проектов: ${ROOT} (проект — только папка внутри корня)`
      : `⚠️ PROJECTS_ROOT не задан: проектом может быть любая папка на машине, по умолчанию домашняя (${HOME})`,
  );
  // списки моделей движков — в фоне, запуск бота не ждёт; свежие (моложе суток, та же версия движка) не запрашиваются;
  // раз в сутки — обновление, чтобы новые модели появлялись и без перезапуска бота
  const catalogs = () => refreshCatalogs().catch((e) => log('каталоги моделей:', e.message));
  catalogs();
  setInterval(catalogs, 24 * 3600_000).unref();
  const me = await tg('getMe');
  botInfo.username = me.username;
  // темы в личном чате включает владелец бота в @BotFather; без них режим «диалоги» недоступен, бот работает как раньше
  topicsSupport.enabled = Boolean(me.has_topics_enabled);
  topicsSupport.usersCreate = Boolean(me.allows_users_to_create_topics);
  log(
    topicsSupport.enabled
      ? `темы в личном чате включены (режим «диалоги», /topics)${topicsSupport.usersCreate ? '' : ' — пользователи не могут создавать темы сами, только через /new'}`
      : 'темы в личном чате выключены — режим «диалоги» недоступен',
  );
  await setupCommands().catch((e) => log('setMyCommands:', e.message));
  // пропускаем накопившиеся до запуска обновления
  const old = await tg('getUpdates', { offset: -1, timeout: 0 });
  let offset = old.length ? old[old.length - 1].update_id + 1 : 0;
  startIdleReaper();
  // принятые и исходящие файлы хранятся FILES_KEEP_DAYS дней: чистим при старте и раз в сутки
  const sweep = () => {
    try {
      const n = cleanupFiles();
      if (n) log(`удалено старых файлов: ${n}`);
    } catch (e) {
      log('очистка файлов:', e.message);
    }
  };
  sweep();
  setInterval(sweep, 24 * 3600_000).unref();
  const admin = getState(ADMIN_ID, ADMIN_ID);
  log(`бот @${botInfo.username} запущен | администратор ${ADMIN_ID} | проект админа: ${admin.project} | сотрудников: ${db.listUsers().filter((x) => x.status === 'active').length} | лимит агентов сотрудников: ${MAX_AGENTS} | простой: ${IDLE_MINUTES} мин | уровни: ${LEVEL_KEYS.join('/')}`);

  for (;;) {
    let updates;
    try {
      // длинный опрос 30 с + запас: если соединение тихо оборвалось, через 45 с переподключаемся (а не через ~5 минут)
      updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'stopped_message_generation'] }, { timeoutMs: 45_000 });
    } catch (e) {
      log('getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      // запросы разных пользователей не блокируют друг друга
      handleUpdate(u).catch((e) => log('handleUpdate:', e.message));
    }
  }
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  setSyncKill(); // бот сейчас выйдет: процессы агентов завершаем синхронно, чтобы ни один не остался
  shutdownAll('shutdown'); // сессии пользователей: процессы агентов вместе с дочерними
  killProbes(); // и агенты, запущенные за списком моделей
  db.close();
}
// SIGBREAK / SIGHUP — так Windows останавливает консольную программу (служба nssm, закрытие окна)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    shutdown();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  shutdown();
  process.exit(1);
});

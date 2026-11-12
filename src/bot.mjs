// Telegram-интерфейс к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex) через ACP.
// Доступ: главный администратор (ALLOWED_USER_ID) и сотрудники, которым он выдал доступ. Остальным бот не отвечает,
// кроме запроса доступа администратору.
import { DEFAULT_ENGINE, checkEngines, isRequired, setAvailability } from './engines.mjs';
import { handleEngine, onEngineCallback } from './engineUi.mjs';
import { choiceName, effectiveSelection, killProbes, refreshCatalogs } from './access.mjs';
import { handleModel, onModelCallback } from './modelUi.mjs';
import { ADMIN_ID, IDLE_MINUTES, LEVEL_KEYS, MAX_AGENTS, botInfo, db, hasLang, langOf, log, say, setLang } from './ctx.mjs';
import { adminCommand, handleUnknownUser, onAdminCallback, welcomeNote } from './admin.mjs';
import { LANGS, LANG_CODES, LANG_PICK, normLang, t } from './i18n.mjs';
import { HOME, ROOT, showPath } from './projects.mjs';
import { handleProject, onNavCallback } from './projectsUi.mjs';
import { handleSessions, onSessionCallback } from './sessionsUi.mjs';
import { dropPermissions, findState, getState, isAdmin, levelLabel, shutdownAll, startIdleReaper, endAgent, closeSession, engineOf } from './state.mjs';
import { sendRich, tg } from './telegram.mjs';
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

/** Выбор языка: три кнопки. Показываем, пока язык пользователя не выбран, и по /language. */
const sendLangPicker = (chatId) =>
  say(chatId, LANG_PICK, { reply_markup: { inline_keyboard: [LANG_CODES.map((code) => ({ text: LANGS[code], callback_data: `lang:${code}` }))] } });

/** Экран /start: rich-сообщение с кнопками (если Telegram его не примет — уйдёт обычным текстом со списком команд). Без выбранного языка сначала предлагаем выбрать его (после выбора экран откроется сам). */
const sendStart = (st) => {
  if (!hasLang(st.userId)) return sendLangPicker(st.chatId);
  const lang = langOf(st.userId);
  const admin = isAdmin(st.userId);
  return sendRich(st.chatId, startView({ level: levelLabel(st.userId), project: showPath(st.project, lang), engine: engineOf(st).label, model: modelLabel(st), isAdmin: admin, note: admin ? null : welcomeNote(lang), lang })).catch((e) => log('start:', e.message));
};

/** Кнопки экрана /start (ui:<команда>) работают как соответствующие команды. */
const UI_COMMANDS = new Set(['project', 'engine', 'model', 'new', 'sessions', 'users', 'invite', 'close', 'active', 'language']);
async function onUiCallback(st, cb) {
  const name = (cb.data || '').slice('ui:'.length);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (UI_COMMANDS.has(name)) return handleText(st, `/${name}`);
}

/** Кнопка выбора языка (lang:<код>). Первый выбор сразу открывает /start. */
async function onLangCallback(st, cb) {
  const code = (cb.data || '').slice('lang:'.length);
  const chatId = cb.message?.chat?.id ?? st.chatId;
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!LANG_CODES.includes(code)) return;
  const first = !hasLang(st.userId);
  setLang(st.userId, code);
  const text = t('lang.set', code, { name: LANGS[code] });
  await tg('editMessageText', { chat_id: chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(chatId, text));
  if (first) return sendStart(st);
}

/** /language [ru|uk|en] — без аргумента показываем выбор языка. */
function languageCommand(st, arg) {
  const q = (arg || '').trim().toLowerCase();
  const code = normLang(q);
  if (!code || q !== code) return sendLangPicker(st.chatId);
  setLang(st.userId, code);
  return say(st.chatId, t('lang.set', code, { name: LANGS[code] }));
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
  if (name === 'stop') {
    if (!st.busy) return say(st.chatId, t('stop.none', lang));
    st.agent?.cancel();
    dropPermissions(st);
    return;
  }
  if (name === 'close' || name === 'exit') {
    if (!closeSession(st, 'close')) return say(st.chatId, t('close.none', lang));
    return say(st.chatId, t('close.done', lang, { slot: isAdmin(st.userId) ? '' : t('close.slot', lang) }));
  }
  if (name === 'new') {
    if (st.busy) return say(st.chatId, t('busy.stop', lang));
    endAgent(st, 'new');
    return say(st.chatId, t('new.done', lang, { engine: engineOf(st).label, project: showPath(st.project, lang) }));
  }
  if (name === 'invite' || name === 'users' || name === 'active') {
    if (!isAdmin(st.userId)) return say(st.chatId, t('admin.only', lang));
    return adminCommand(st.chatId, `/${name}`);
  }
  if (st.busy) return say(st.chatId, t('busy.running', lang));
  return runTurn(st, text);
}

/**
 * Меню команд на языке: по умолчанию — английский; русский и украинский — для клиентов Telegram с таким языком
 * (язык меню задаёт приложение Telegram, а не /language). У администратора — дополнительно /users, /active, /invite.
 */
const menuFor = (lang, admin) => {
  const common = ['project', 'engine', 'model', 'new', 'sessions', 'stop', 'close', 'language', 'start'].map((command) => ({ command, description: t(`menu.${command}`, lang) }));
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
    const st = findState(u.stopped_message_generation.chat?.id);
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

  if (!hasAccess(from.id)) {
    if (cb) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: t('access.denied', langOf(from.id)) }).catch(() => {});
    if (msg?.text) {
      log('нет доступа, id =', from.id, from.username);
      return handleUnknownUser(from, chatId, msg.text);
    }
    return;
  }
  if (!isAdmin(from.id)) db.touchUser(from.id, from.username, from.first_name);

  if (cb) {
    const data = cb.data || '';
    if (data.startsWith('adm:')) return isAdmin(from.id) ? onAdminCallback(cb) : tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    const st = getState(from.id, chatId);
    if (data.startsWith('nav:')) return onNavCallback(st, cb);
    if (data.startsWith('perm:')) return onPermissionCallback(st, cb);
    if (data.startsWith('ses:')) return onSessionCallback(st, cb);
    if (data.startsWith('eng:')) return onEngineCallback(st, cb);
    if (data.startsWith('mdl:')) return onModelCallback(st, cb);
    if (data.startsWith('ui:')) return onUiCallback(st, cb);
    if (data.startsWith('lang:')) return onLangCallback(st, cb);
    return;
  }
  if (msg?.text) return handleText(getState(from.id, chatId), msg.text);
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
  // списки моделей движков — в фоне, запуск бота не ждёт
  refreshCatalogs().catch((e) => log('каталоги моделей:', e.message));
  const me = await tg('getMe');
  botInfo.username = me.username;
  await setupCommands().catch((e) => log('setMyCommands:', e.message));
  // пропускаем накопившиеся до запуска обновления
  const old = await tg('getUpdates', { offset: -1, timeout: 0 });
  let offset = old.length ? old[old.length - 1].update_id + 1 : 0;
  startIdleReaper();
  const admin = getState(ADMIN_ID, ADMIN_ID);
  log(`бот @${botInfo.username} запущен | администратор ${ADMIN_ID} | проект админа: ${admin.project} | сотрудников: ${db.listUsers().filter((x) => x.status === 'active').length} | лимит агентов сотрудников: ${MAX_AGENTS} | простой: ${IDLE_MINUTES} мин | уровни: ${LEVEL_KEYS.join('/')}`);

  for (;;) {
    let updates;
    try {
      updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'stopped_message_generation'] });
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

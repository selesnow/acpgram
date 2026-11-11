// Telegram-интерфейс к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI) через ACP.
// Доступ: главный администратор (ALLOWED_USER_ID) и сотрудники, которым он выдал доступ. Остальным бот не отвечает,
// кроме запроса доступа администратору.
import { DEFAULT_ENGINE, checkEngines, isRequired, setAvailability } from './engines.mjs';
import { handleEngine, onEngineCallback } from './engineUi.mjs';
import { choiceName, effectiveSelection, refreshCatalogs } from './access.mjs';
import { handleModel, onModelCallback } from './modelUi.mjs';
import { ADMIN_ID, IDLE_MINUTES, LEVELS, MAX_AGENTS, botInfo, db, log, say } from './ctx.mjs';
import { adminCommand, handleUnknownUser, onAdminCallback, WELCOME_NOTE } from './admin.mjs';
import { HOME, ROOT, display } from './projects.mjs';
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

/** Экран /start: rich-сообщение с кнопками (если Telegram его не примет — уйдёт обычным текстом со списком команд). */
const modelLabel = (st) => {
  const engine = engineOf(st);
  const model = effectiveSelection(st.userId, engine).model;
  return model ? choiceName(engine, 'model', model) : 'Авто';
};
const sendStart = (st) =>
  sendRich(st.chatId, startView({ level: levelLabel(st.userId), project: display(st.project), engine: engineOf(st).label, model: modelLabel(st), isAdmin: isAdmin(st.userId), note: isAdmin(st.userId) ? null : WELCOME_NOTE })).catch((e) => log('start:', e.message));

/** Кнопки экрана /start (ui:<команда>) работают как соответствующие команды. */
const UI_COMMANDS = new Set(['project', 'engine', 'model', 'new', 'sessions', 'users', 'invite', 'close', 'active']);
async function onUiCallback(st, cb) {
  const name = (cb.data || '').slice('ui:'.length);
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (UI_COMMANDS.has(name)) return handleText(st, `/${name}`);
}

/** Текст пользователя: команды или запрос к агенту. */
async function handleText(st, text) {
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  const name = cmd?.[1]?.toLowerCase();
  const arg = cmd?.[2];

  if (name === 'start') return sendStart(st);
  if (name === 'project') return handleProject(st, arg);
  if (name === 'engine') return handleEngine(st, arg);
  if (name === 'model') return handleModel(st);
  if (name === 'sessions') return handleSessions(st);
  if (name === 'stop') {
    if (!st.busy) return say(st.chatId, 'Сейчас ничего не выполняется.');
    st.agent?.cancel();
    dropPermissions(st);
    return;
  }
  if (name === 'close' || name === 'exit') {
    if (!closeSession(st, 'close')) return say(st.chatId, 'Активной сессии нет — процесс агента не запущен.');
    return say(st.chatId, `🛑 Сессия закрыта, процесс выгружен из памяти сервера.${isAdmin(st.userId) ? '' : ' Слот освобождён.'}\nВернуться к диалогу можно через /sessions.`);
  }
  if (name === 'new') {
    if (st.busy) return say(st.chatId, 'Сначала остановите текущий запрос: /stop');
    endAgent(st, 'new');
    return say(st.chatId, `🆕 Новая сессия. ${engineOf(st).label} начнёт диалог с чистого листа.\n📁 Проект: ${display(st.project)}`);
  }
  if (name === 'invite' || name === 'users' || name === 'active') {
    if (!isAdmin(st.userId)) return say(st.chatId, 'Команда доступна только администратору.');
    return adminCommand(st.chatId, `/${name}`);
  }
  if (st.busy) return say(st.chatId, 'Предыдущий запрос ещё выполняется. /stop — остановить.');
  return runTurn(st, text);
}

/** Меню команд: у всех общее, у администратора дополнительно /users и /invite. */
async function setupCommands() {
  const common = [
    { command: 'project', description: 'Выбрать проект (папку), в которой работает агент' },
    { command: 'engine', description: 'Выбрать движок: Gemini CLI, Claude Code, Antigravity CLI' },
    { command: 'model', description: 'Выбрать модель и уровень рассуждений' },
    { command: 'new', description: 'Начать новый диалог (новая сессия агента)' },
    { command: 'sessions', description: 'Вернуться к прошлой сессии в этом проекте' },
    { command: 'stop', description: 'Остановить выполняющийся запрос' },
    { command: 'close', description: 'Закрыть сессию и освободить слот' },
    { command: 'start', description: 'Приветствие и текущий проект' },
  ];
  await tg('setMyCommands', { scope: { type: 'default' }, commands: common });
  await tg('setMyCommands', {
    scope: { type: 'chat', chat_id: ADMIN_ID },
    commands: [{ command: 'active', description: 'Активные сессии: кто занимает слоты' }, { command: 'users', description: 'Сотрудники с доступом: уровни и отзыв' }, { command: 'invite', description: 'Пригласить сотрудника по ссылке' }, ...common],
  });
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
    if (cb) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' }).catch(() => {});
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
    return;
  }
  if (msg?.text) return handleText(getState(from.id, chatId), msg.text);
}

async function main() {
  // все движки проверяем параллельно; без движка по умолчанию (DEFAULT_ENGINE) бот не запускается, остальные — по возможности
  const asked = process.env.DEFAULT_ENGINE?.trim().toLowerCase();
  if (asked && asked !== DEFAULT_ENGINE) log(`⚠️ DEFAULT_ENGINE=${asked} не распознан (gemini | claude | agy), используется ${DEFAULT_ENGINE}`);
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
  log(`бот @${botInfo.username} запущен | администратор ${ADMIN_ID} | проект админа: ${admin.project} | сотрудников: ${db.listUsers().filter((x) => x.status === 'active').length} | лимит агентов сотрудников: ${MAX_AGENTS} | простой: ${IDLE_MINUTES} мин | уровни: ${Object.keys(LEVELS).join('/')}`);

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

function shutdown() {
  shutdownAll('shutdown');
  db.close();
}
for (const sig of ['SIGINT', 'SIGTERM']) {
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

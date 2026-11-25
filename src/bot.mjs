// Telegram-интерфейс к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex, OpenCode) через ACP.
// Доступ: главный администратор (ALLOWED_USER_ID) и сотрудники, которым он выдал доступ. Остальным бот не отвечает,
// кроме запроса доступа администратору.
import { DEFAULT_ENGINE, agentEnv, checkEngines, isRequired, setAvailability, setSandboxBroken } from './engines.mjs';
import { SANDBOX, checkInSandbox, probeSandbox } from './sandbox.mjs';
import { choiceName, effectiveSelection, killProbes, refreshCatalogs } from './access.mjs';
import { handleEngine, onEngineCallback } from './engineUi.mjs';
import { handleModel, onModelCallback } from './modelUi.mjs';
import { ADMIN_ID, DATA_DIR, HISTORY_KEEP_DAYS, IDLE_MINUTES, LEVEL_KEYS, LOGS_KEEP_DAYS, MAX_AGENTS, botInfo, db, langOf, log, noteTgLang, say, setLang, sweepLangCache } from './ctx.mjs';
import { adminCommand, handleBotInvite, handleUnknownUser, onAdminCallback, sweepUnknownUsers, welcomeNote } from './admin.mjs';
import { tc } from './cli-i18n.mjs';
import { LANGS, LANG_CODES, LANG_PICK, errText, normLang, t } from './i18n.mjs';
import { HOME, ROOT, USER_WORKSPACES } from './projects.mjs';
import { handleProject, onNavCallback, onProjectNameInput, onTopicListCallback } from './projectsUi.mjs';
import { handleFiles, onFileInput, onFileUpload, onFilesCallback } from './filesUi.mjs';
import { checkGit, gitCommand } from './git.mjs';
import { GIT_AGENT_AUTH, tokenReminders } from './gitAccess.mjs';
import { handleGit, onGitCallback, onGitInput } from './gitUi.mjs';
import { handleSessions, onSessionCallback } from './sessionsUi.mjs';
import { ADMIN_SANDBOX, closeSession, dropPermissions, endAgent, engineOf, errorRootOf, findState, getState, isAdmin, levelLabel, shutdownAll, startIdleReaper, topicsOn, topicsSupport, userPath } from './state.mjs';
import { handleTopics, newTopic, onTopicsCallback } from './topicsUi.mjs';
import { deleteTopic, isAutoTopicCommand, topicInfoOf } from './topics.mjs';
import { setSyncKill } from './acp.mjs';
import { downloadFile, sendRich, tg } from './telegram.mjs';
import { IMAGE_BLOCK_MAX, MAX_FILE_BYTES, cleanupFiles, describeAttachment, isImageMime, saveUpload, uploadsDir } from './files.mjs';
import { archiveKind, extractArchiveAsync } from './archive.mjs';
import { createAlbumBuffer } from './albums.mjs';
import { dropQueue, enqueue, onAskCallback, onPermissionCallback, onQueueCallback, runTurn } from './turn.mjs';
import { nearCommand, quoteOf, unsupportedKind } from './incoming.mjs';
import { onWidgetQuery } from './widgetsUi.mjs';
import { DOCS_URL, docsMenuButton, helpMarkup, replyCommandOf, replyKeyboard, startView } from './ui.mjs';
import { fmtDate } from './uiActions.mjs';
import { positiveEnv } from './app.mjs';
import { createQueue } from './queue.mjs';
import { directorySize, fitsUpload, freeBytes } from './quota.mjs';
import { forceStopAfter } from './forceStop.mjs';
import { looksLikeSecret } from './pending.mjs';
import { clearPendingInput } from './pendingInput.mjs';
import { cleanupLogs, logError } from './log.mjs';
import { maybeNotifySafety } from './warnings.mjs';
import { configureBotRouting, handleUpdate, setupCommands, sweepUpdateLimits } from './botRouting.mjs';

const UPLOADS_QUOTA_MB = positiveEnv('UPLOADS_QUOTA_MB', 0);
const MIN_FREE_MB = positiveEnv('MIN_FREE_MB', 100);

configureBotRouting({
  ADMIN_ID,
  ADMIN_SANDBOX,
  DOCS_URL,
  IMAGE_BLOCK_MAX,
  LANGS,
  LANG_CODES,
  LANG_PICK,
  MAX_FILE_BYTES,
  MIN_FREE_MB,
  UPLOADS_QUOTA_MB,
  adminCommand,
  archiveKind,
  choiceName,
  clearPendingInput,
  closeSession,
  createAlbumBuffer,
  createQueue,
  db,
  deleteTopic,
  describeAttachment,
  directorySize,
  docsMenuButton,
  downloadFile,
  dropPermissions,
  dropQueue,
  effectiveSelection,
  endAgent,
  engineOf,
  enqueue,
  errorRootOf,
  errText,
  extractArchiveAsync,
  findState,
  fitsUpload,
  forceStopAfter,
  freeBytes,
  getState,
  handleBotInvite,
  handleEngine,
  handleFiles,
  handleGit,
  handleModel,
  handleProject,
  handleSessions,
  handleTopics,
  handleUnknownUser,
  helpMarkup,
  isAdmin,
  isAutoTopicCommand,
  isImageMime,
  langOf,
  levelLabel,
  log,
  looksLikeSecret,
  nearCommand,
  newTopic,
  normLang,
  noteTgLang,
  onAdminCallback,
  onAskCallback,
  onEngineCallback,
  onFileInput,
  onFilesCallback,
  onFileUpload,
  onGitCallback,
  onGitInput,
  onModelCallback,
  onNavCallback,
  onPermissionCallback,
  onProjectNameInput,
  onQueueCallback,
  onSessionCallback,
  onTopicListCallback,
  onTopicsCallback,
  onWidgetQuery,
  quoteOf,
  replyCommandOf,
  replyKeyboard,
  runTurn,
  saveUpload,
  say,
  sendRich,
  setLang,
  startView,
  t,
  tg,
  topicInfoOf,
  topicsOn,
  topicsSupport,
  unsupportedKind,
  uploadsDir,
  userPath,
  welcomeNote,
});

if (!process.env.TELEGRAM_BOT_TOKEN || !ADMIN_ID) {
  logError('Нужны TELEGRAM_BOT_TOKEN и ALLOWED_USER_ID (см. .env)');
  process.exit(1);
}

/**
 * Песочница агентов сотрудников (AGENT_SANDBOX): проверка при старте. Не работает сама песочница или в ней не
 * запускается движок по умолчанию — бот не запускается: без этого сотрудники работали бы без изоляции или не работали
 * вовсе. Остальные движки, не запустившиеся в песочнице, сотрудникам не предлагаются.
 */
async function setupSandbox(checks) {
  const probe = probeSandbox();
  if (!probe.ok) {
    logError([`AGENT_SANDBOX=${SANDBOX}: песочница не работает — ${probe.error}`, probe.hint].join('\n'));
    process.exit(1);
  }
  log([
    'песочница агентов включена (bubblewrap): агент видит только папку проектов сотрудника, его файлы и его домашнюю папку',
    ADMIN_SANDBOX ? 'администратор песочнится в папках сотрудников (ADMIN_SANDBOX=1)' : 'администратор работает без песочницы',
  ].join('; '));
  const usable = checks.filter((r) => r.ok || r.timeout);
  const inside = await Promise.all(usable.map((r) => checkInSandbox(r.command, r.engine.versionArgs, agentEnv(r.engine))));
  const broken = [];
  usable.forEach((r, i) => {
    const s = inside[i];
    if (s.ok || s.timeout) return;
    const text = `${r.engine.label} не запускается в песочнице (${r.command}): ${s.error}. Если движок установлен в нестандартном месте, добавьте его папку в SANDBOX_RO_PATHS`;
    if (isRequired(r.engine)) {
      logError(text);
      process.exit(1);
    }
    log(`⚠️ ${text} — сотрудникам он не предлагается`);
    broken.push(r.engine.id);
  });
  setSandboxBroken(broken);
}

/** При старте помечает оборванные перезапуском запросы и сообщает их авторам. */
function notifyInterrupted() {
  const rows = db.unfinishedRequests() ?? [];
  const n = db.interruptRequests('interrupted by bot restart') ?? 0;
  if (!rows.length) return n;
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.user_id}:${r.chat_id ?? r.user_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    say(r.chat_id ?? r.user_id, t('turn.restarted', langOf(r.user_id))).catch((e) => log('уведомление о перезапуске:', e.message, '| пользователь', r.user_id));
  }
  log(`запросов, прерванных перезапуском: ${n}; уведомлено диалогов: ${seen.size}`);
  return n;
}

async function main() {
  if (SANDBOX && !ROOT) {
    logError('AGENT_SANDBOX=bwrap: задайте PROJECTS_ROOT — без корня сотрудник может выбрать проектом любую папку сервера');
    process.exit(1);
  }
  // все движки проверяем параллельно; без движка по умолчанию (DEFAULT_ENGINE) бот не запускается, остальные — по возможности
  const asked = process.env.DEFAULT_ENGINE?.trim().toLowerCase();
  if (asked && asked !== DEFAULT_ENGINE) log(`⚠️ DEFAULT_ENGINE=${asked} не распознан (gemini | claude | agy | codex | opencode), используется ${DEFAULT_ENGINE}`);
  const checks = await checkEngines();
  setAvailability(checks);
  for (const r of checks) {
    const { engine: e, command } = r;
    if (r.ok) log(`${e.label} ${r.version} | ${command}`);
    else if (r.timeout) log(`⚠️ ${e.label} не ответил на ${e.versionArgs.join(' ')}: ${r.error} — продолжаем запуск`);
    else if (isRequired(e)) {
      logError([
        `Не удалось запустить ${e.label} (${command}): ${r.errorI18n ? tc(r.errorI18n.key, r.errorI18n.vars) : r.error}`,
        `Установите: ${e.installKey ? tc(e.installKey) : e.install} — или укажите полный путь в ${e.envVar} (см. .env.example)`,
      ].join('\n'));
      process.exit(1);
    } else log(`ℹ️ ${e.label} недоступен (${command}): ${r.error}. Установка: ${e.install}; путь — ${e.envVar}`);
  }
  log(`движок по умолчанию: ${DEFAULT_ENGINE}`);
  if (SANDBOX) await setupSandbox(checks);
  // git — необязательная системная программа: без неё раздел /git отвечает, что недоступен
  const git = await checkGit();
  log(
    git.ok
      ? `${git.version} | ${gitCommand()} — /git доступен${GIT_AGENT_AUTH ? '; ⚠️ GIT_AGENT_AUTH=1: вход в Git передаётся агентам, токены сотрудников им видны' : '; вход в Git агентам не передаётся'}`
      : `ℹ️ git не найден (${gitCommand()}): /git недоступен. Установите git или укажите путь в GIT_COMMAND`,
  );
  log(
    ROOT
      ? `корень проектов: ${ROOT} (проект — только папка внутри корня)`
      : `⚠️ PROJECTS_ROOT не задан: проектом может быть любая папка на машине, по умолчанию домашняя (${HOME})`,
  );
  if (USER_WORKSPACES) log('личные пространства включены: у каждого сотрудника своя папка в корне проектов (имя — его Telegram ID), администратор видит весь корень');
  // списки моделей движков — в фоне, запуск бота не ждёт; свежие (моложе суток, та же версия движка) не запрашиваются;
  // раз в сутки — обновление, чтобы новые модели появлялись и без перезапуска бота
  const catalogs = () => refreshCatalogs().catch((e) => log('каталоги моделей:', e.message));
  catalogs();
  setInterval(catalogs, 24 * 3600_000).unref();
  const me = await tg('getMe');
  botInfo.username = me.username || me.active_usernames?.[0] || '';
  // настройки тем и групп бота (BotFullInfo, Bot API 10.5); администратор может менять их в /topics или в мастере настройки
  topicsSupport.enabled = Boolean(me.has_topics_enabled);
  topicsSupport.usersCreate = Boolean(me.allows_users_to_create_topics);
  topicsSupport.sidebar = Boolean(me.has_topic_sidebar);
  topicsSupport.canJoinGroups = me.can_join_groups !== false;
  log(
    topicsSupport.enabled
      ? `темы в личном чате включены (режим «диалоги», /topics)${topicsSupport.sidebar ? ', боковая панель тем' : ''}${topicsSupport.usersCreate ? '' : ' — пользователи не могут создавать темы сами, только через /new'}`
      : 'темы в личном чате выключены — режим «диалоги» недоступен (администратор может включить в /topics)',
  );
  await setupCommands().catch((e) => log('настройка меню:', e.message));
  notifyInterrupted();
  maybeNotifySafety();
  // пропускаем накопившиеся до запуска обновления
  const old = await tg('getUpdates', { offset: -1, timeout: 0 });
  let offset = old.length ? old[old.length - 1].update_id + 1 : 0;
  startIdleReaper();
  // принятые и исходящие файлы хранятся FILES_KEEP_DAYS дней: чистим при старте и раз в сутки
  const sweep = async () => {
    try {
      const n = await cleanupFiles();
      if (n) log(`удалено старых файлов: ${n}`);
    } catch (e) {
      log('очистка файлов:', e.message);
    }
    const h = db.cleanupHistory(HISTORY_KEEP_DAYS);
    if (h) log(`удалено старых записей истории: ${h}`);
    const l = cleanupLogs(DATA_DIR, LOGS_KEEP_DAYS);
    if (l) log(`удалено старых файлов журнала: ${l}`);
    const c = sweepUpdateLimits() + sweepUnknownUsers() + sweepLangCache();
    if (c) log(`удалено старых записей кэша обновлений: ${c}`);
  };
  sweep();
  setInterval(sweep, 24 * 3600_000).unref();
  // токены доступа к Git истекают: владельцу аккаунта — напоминание за неделю, за день и по истечении
  const remind = () => {
    try {
      for (const r of tokenReminders()) {
        const lang = langOf(r.userId);
        const date = fmtDate(r.account.expires_at, lang);
        log('git: напоминание о токене:', r.userId, r.host.id, r.stage);
        say(r.userId, t(r.stage === 'expired' ? 'git.exp.expired' : 'git.exp.soon', lang, { host: r.host.label, login: r.account.login, date, days: r.days }), {
          reply_markup: { inline_keyboard: [[{ text: t('start.btn.git', lang), callback_data: 'ui:git' }]] },
        });
      }
    } catch (e) {
      log('напоминания о токенах git:', e.message);
    }
  };
  remind();
  setInterval(remind, 12 * 3600_000).unref();
  const admin = getState(ADMIN_ID, ADMIN_ID);
  log([
    `бот @${botInfo.username} запущен`,
    `администратор ${ADMIN_ID}`,
    `проект админа: ${admin.project}`,
    `сотрудников: ${db.listUsers().filter((x) => x.status === 'active').length}`,
    `лимит агентов сотрудников: ${MAX_AGENTS}`,
    `простой: ${IDLE_MINUTES} мин`,
    `уровни: ${LEVEL_KEYS.join('/')}`,
  ].join(' | '));

  for (;;) {
    let updates;
    try {
      // длинный опрос 30 с + запас: если соединение тихо оборвалось, через 45 с переподключаемся (а не через ~5 минут)
      updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'stopped_message_generation', 'widget_query'] }, { timeoutMs: 45_000 });
    } catch (e) {
      log('getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      // запросы разных пользователей не блокируют друг друга
      handleUpdate(u).catch((e) => {
        const from = u.message?.from?.id ?? u.callback_query?.from?.id ?? u.widget_query?.from?.id ?? '?';
        log('handleUpdate:', e.message, '| обновление', u.update_id, '| пользователь', from);
        logError('handleUpdate, стек:', e.stack ?? e.message);
      });
    }
  }
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  setSyncKill();
  shutdownAll('shutdown');
  killProbes();
  db.close();
}
// SIGBREAK / SIGHUP — так Windows останавливает консольную программу (служба nssm, закрытие окна)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    shutdown();
    process.exit(0);
  });
}

// Ошибка в обработчике события или таймере, которую никто не поймал, не должна молча завершать бот для всех
// пользователей: отклонённый промис — в журнал и работаем дальше; необработанное исключение — в журнал, агенты
// завершаются, и процесс выходит (служба поднимет его заново).
process.on('unhandledRejection', (e) => log('⚠️ необработанное отклонение:', e?.stack ?? e));
process.on('uncaughtException', (e) => {
  logError('необработанное исключение:', e?.stack ?? e);
  shutdown();
  process.exit(1);
});

main().catch((e) => {
  logError(e);
  shutdown();
  process.exit(1);
});

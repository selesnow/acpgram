// Команда /git: аккаунты GitHub и GitLab пользователя (вход по токену доступа), клонирование репозитория кнопками,
// состояние репозитория проекта, «Получить», «Отправить», «Сохранить и отправить».
// Токен вводится сообщением, которое не передаётся агенту и удаляется из чата; команды git с входом выполняет бот.
import { db, langOf, log, say } from './ctx.mjs';
import { canManageFiles } from './filesUi.mjs';
import { fetchRepo, gitAvailable } from './git.mjs';
import { accountsOf, findHost, hosts as allHosts, refreshAccounts } from './gitAccess.mjs';
import { onAccountCallback, onTokenInput } from './gitAccountsUi.mjs';
import { cleanFailedClone, onCloneCallback, onSearchInput } from './gitCloneUi.mjs';
import { acquireGitLock, failText, gitNetOpts, projectOf, releaseGitLock, repoOf } from './gitCtx.mjs';
import { showRemote } from './gitHosts.mjs';
import { onHostCallback, onHostInput } from './gitHostsUi.mjs';
import { PUBLISH_ACTIONS, PUBLISH_INPUTS, canPublish, onPublishCallback, onPublishInput } from './gitPublishUi.mjs';
import { REPO_ACTIONS, onBranchInput, onRepoCallback } from './gitRepoUi.mjs';
import { onMessageInput, onRepoActionCallback } from './gitRepoAction.mjs';
import { t } from './i18n.mjs';
import { canCreateProject } from './projectsUi.mjs';
import { clearPendingInput, isPendingExpired, pendingKindMatches } from './pendingInput.mjs';
import { errorRootOf, isAdmin, userPath } from './state.mjs';
import { dest, tg } from './telegram.mjs';
import { hCode, th } from './ui.mjs';
import { cbCtx } from './uiActions.mjs';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
/** Сколько бот ждёт токен, описание изменений или строку поиска. */
export { GIT_WAIT_MS } from './pendingInput.mjs';

/**
 * Экран /git: состояние репозитория проекта, аккаунты, кнопки. Текст — HTML.
 * sync — сначала свериться с сервером (git fetch), чтобы «новых на сервере» было настоящим числом: при открытии экрана
 * и по кнопке «Обновить». Пока агент выполняет запрос или идёт другая операция git, сверка пропускается.
 */
async function gitView(st, lang = langOf(st.userId), { sync = false } = {}) {
  const project = projectOf(st);
  const hosts = allHosts();
  const accounts = accountsOf(st.userId);
  const lines = [th('git.head', lang, { p: hCode(project ? userPath(st.userId, project, lang) : '—') })];
  const rows = [];
  const load = () => (project ? repoOf(st, project).catch((e) => (log('git: состояние:', e.message), null)) : null);
  let repo = await load();
  let syncError = null;
  if (sync && repo?.account && !st.busy && !st.gitBusy) {
    const lock = acquireGitLock(st, project);
    if (lock) {
      try {
        await fetchRepo(project, gitNetOpts(st, project, repo));
        repo = await load();
      } catch (e) {
        log('git: сверка с сервером:', e.message, '| пользователь', st.userId);
        syncError = e.message;
      } finally {
        releaseGitLock(st, lock);
      }
    }
  }
  if (repo) {
    const s = repo.state;
    lines.push(th('git.repo', lang, { branch: s.branch ?? '—', changed: s.changed, ahead: s.ahead, behind: s.behind, remote: hCode(s.remote ? showRemote(s.remote) : '—') }));
    if (syncError) lines.push(th('git.syncFail', lang, { msg: syncError }));
    if (repo.account) {
      if (canManageFiles(st.userId)) {
        rows.push([{ text: t('git.pull', lang), callback_data: 'gt:pull' }, { text: t('git.push', lang), callback_data: 'gt:push' }]);
        rows.push([{ text: t('git.save', lang), callback_data: 'gt:save', style: 'success' }]);
        if (s.branch) rows.push([{ text: t('git.mrBtn', lang), callback_data: 'gt:mr' }]);
      }
    } else if (repo.host) lines.push(th('git.needAccount', lang, { host: repo.host.label }));
    else lines.push(th(s.remote ? 'git.foreign' : 'git.noRemote', lang));
    // что изменено и какие есть ветки — можно смотреть без агента и без аккаунта
    rows.push([{ text: t('git.changesBtn', lang), callback_data: 'gt:ch:0' }, { text: t('git.branchesBtn', lang), callback_data: 'gt:br:0' }]);
  } else lines.push(th('git.noRepo', lang));
  // папку, которая ещё не связана с сервером, можно опубликовать: бот создаст для неё репозиторий
  const publishable = project && !repo?.state.remote ? await canPublish(st, project).catch(() => false) : false;
  if (publishable) rows.push([{ text: t('git.pbBtn', lang), callback_data: 'gt:pb' }]);
  lines.push(accounts.length ? [t('git.accounts', lang), ...accounts.map(({ host, account }) => th('git.accLine', lang, { host: host.label, login: account.login }))].join('\n') : th('git.noAccounts', lang));
  if (accounts.length && canCreateProject(st.userId)) rows.push([{ text: t('git.clone', lang), callback_data: 'gt:cl' }]);
  for (const h of hosts) {
    const acc = accounts.find((x) => x.host.id === h.id)?.account;
    rows.push([acc ? { text: t('git.accBtn', lang, { host: h.label, login: acc.login }), callback_data: `gt:a:${h.id}` } : { text: t('git.connect', lang, { host: h.label }), callback_data: `gt:c:${h.id}` }]);
  }
  // свои серверы (GitLab, GitHub Enterprise) добавляет администратор — прямо здесь, без правки настроек
  rows.push([...(isAdmin(st.userId) ? [{ text: t('git.hostsBtn', lang), callback_data: 'gt:h' }] : []), { text: t('btn.refresh', lang), callback_data: 'gt:v' }]);
  return { text: lines.join('\n\n'), markup: { inline_keyboard: rows } };
}

/**
 * Перед любой операцией /git: обновить входы, которым пора (вход по коду с истекающим токеном). Если сервис больше
 * не принимает вход, аккаунт отключён — пользователю об этом сообщение.
 */
async function freshen(st) {
  const lost = await refreshAccounts(st.userId).catch((e) => (log('git: обновление входа:', e.message), []));
  for (const x of lost) await say(st.to, t('git.dv.lost', langOf(st.userId), { host: x.host.label, login: x.login }));
}

/** /git */
export async function handleGit(st) {
  const lang = langOf(st.userId);
  if (!gitAvailable()) return say(st.to, t('git.none', lang));
  if (st.gitBusy) return say(st.to, t('git.busy', lang));
  await freshen(st);
  const v = await gitView(st, lang, { sync: true });
  return tg('sendMessage', { ...dest(st.to), text: v.text, ...HTML, reply_markup: v.markup }).catch((e) => log('git:', e.message));
}

/**
 * Агент попросил отправить или получить изменения (метки [[git:push]] / [[git:pull]] в ответе): под ответом —
 * сообщение с кнопкой. Нажатие выполняет ту же операцию, что и кнопка на экране /git. Проект не связан с сервером
 * или аккаунт не подключён — подсказка открыть /git.
 * @param {('push'|'pull')[]} actions
 */
export async function offerGitActions(st, actions) {
  if (!gitAvailable() || !actions.length) return;
  await freshen(st);
  const lang = langOf(st.userId);
  const project = projectOf(st);
  const repo = project ? await repoOf(st, project).catch(() => null) : null;
  if (!repo?.account || !canManageFiles(st.userId)) return say(st.to, t('git.offer.noAccount', lang), { reply_markup: { inline_keyboard: [[{ text: t('start.btn.git', lang), callback_data: 'ui:git' }]] } });
  const row = actions.map((a) => ({ text: t(a === 'push' ? 'git.push' : 'git.pull', lang), callback_data: a === 'push' ? 'gt:push' : 'gt:pull' }));
  return say(st.to, t(actions.length > 1 ? 'git.offer.both' : `git.offer.${actions[0]}`, lang), { reply_markup: { inline_keyboard: [row] } });
}

/** Кнопки /git (gt:<действие>[:<аргумент>[:<страница>]]). */
export async function onGitCallback(st, cb) {
  const [, action, arg, pageStr] = (cb.data || '').split(':');
  const lang = langOf(st.userId);
  const { ack, edit } = cbCtx(st, cb, { html: true, alert: true, notModified: 'loose', label: 'git:' });
  if (!gitAvailable()) return ack(t('git.none', lang));
  await freshen(st);
  if (action === 'x') {
    clearPendingInput(st);
    st.gitDevice = null; // и ожидание входа по коду, если оно шло
    await ack();
    return edit({ text: th('files.cancelled', lang) });
  }
  if (action === 'v') {
    await ack();
    return edit(await gitView(st, lang, { sync: true }));
  }
  const view = () => gitView(st, lang);
  const h = { action, arg, pageStr, lang, ack, edit, view, cloneKeyPrefix: 'gt:k:' };
  // ---- свои серверы: только администратор ----
  if (['h', 'ha', 'hn', 'hd', 'hD'].includes(action)) return onHostCallback(st, h);
  // экраны «Изменения» и «Ветки» — gitRepoUi
  if (REPO_ACTIONS.includes(action)) return onRepoCallback(st, { action, arg, lang, ack, edit, project: projectOf(st) });
  // «Опубликовать проект» и «Запрос на слияние» — gitPublishUi
  if (PUBLISH_ACTIONS.includes(action)) return onPublishCallback(st, { action, arg, lang, ack, edit, project: projectOf(st), view });
  const host = findHost(arg);
  const account = host ? db.getGitAccount(st.userId, host.id) : null;
  h.host = host;
  h.account = account;
  try {
    // ---- аккаунты ----
    if (['c', 'dv', 'a', 'd', 'D'].includes(action)) return onAccountCallback(st, h);
    // ---- клонирование ----
    if (['cl', 'r', 's', 'k'].includes(action)) return onCloneCallback(st, h);
    // ---- репозиторий проекта ----
    if (['pull', 'push', 'pushf', 'save', 'savenow'].includes(action)) return onRepoActionCallback(st, h);
    return ack(t('proj.stale', lang));
  } catch (e) {
    log('git:', e.message, '| пользователь', st.userId);
    await ack();
    return edit({ text: failText(e, lang, null, errorRootOf(st.userId)) });
  }
}

/**
 * Текст пользователя, пока бот ждёт токен доступа, строку поиска репозитория или описание изменений. true — текст
 * обработан здесь и агенту не передаётся. Токен агенту не уходит никогда: даже если ожидание истекло, сообщение
 * удаляется, а не превращается в запрос.
 */
export async function onGitInput(st, text, { messageId, now = Date.now() } = {}) {
  const wait = st.pendingInput;
  if (!pendingKindMatches(wait, ['gitToken', 'gitSearch', 'gitMessage', 'gitHostUrl', 'gitHostName', 'gitBranch', ...PUBLISH_INPUTS])) return false;
  const lang = langOf(st.userId);
  await freshen(st);
  const expired = isPendingExpired(wait, now);
  const send = (v) => tg('sendMessage', { ...dest(st.to), text: v.text, ...HTML, reply_markup: v.markup ?? { inline_keyboard: [] } }).catch((e) => log('git:', e.message));
  const view = () => gitView(st, lang);

  if (wait.kind === 'gitToken') return onTokenInput(st, text, { wait, expired, lang, messageId, send, view });

  clearPendingInput(st);
  if (expired) return false; // адрес сервера, строка поиска и описание изменений — не секреты: позже это обычный запрос агенту
  if (wait.kind === 'gitBranch') return onBranchInput(st, text, { wait, now, lang, project: projectOf(st) });
  if (pendingKindMatches(wait, PUBLISH_INPUTS)) return onPublishInput(st, text, { wait, now, lang, send, project: projectOf(st), view });
  // свои серверы: адрес нового сервера или новое название — только от администратора
  if (pendingKindMatches(wait, ['gitHostUrl', 'gitHostName'])) return onHostInput(st, text, { wait, now, lang, send });
  if (wait.kind === 'gitSearch') return onSearchInput(st, text, { wait, lang, send });
  // описание изменений: первая строка, не длиннее 200 символов
  return onMessageInput(st, text, { lang, send, view });
}

export { cleanFailedClone };

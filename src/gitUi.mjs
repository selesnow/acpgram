// Команда /git: аккаунты GitHub и GitLab пользователя (вход по токену доступа), клонирование репозитория кнопками,
// состояние репозитория проекта, «Получить», «Отправить», «Сохранить и отправить».
// Токен вводится сообщением, которое не передаётся агенту и удаляется из чата; команды git с входом выполняет бот.
import { join } from 'node:path';
import { db, langOf, log, say } from './ctx.mjs';
import { canManageFiles } from './filesUi.mjs';
import { GitError, cloneRepo, commitAll, fetchRepo, gitAvailable, gitCommand, gitEnv, pullRepo, pushRepo, repoState, unpushedSecrets } from './git.mjs';
import { accountsOf, addCustomHost, findHost, hostFor, hosts as allHosts, identityOf, removeCustomHost, renameCustomHost } from './gitAccess.mjs';
import { REPO_ACTIONS, onBranchInput, onRepoCallback } from './gitRepoUi.mjs';
import { HostError, authConfig, customHost, fetchProfile, listRepos, missingScopes, probeHost, repoFolder, showRemote } from './gitHosts.mjs';
import { LOCALES, errText, t } from './i18n.mjs';
import { ROOT, folderName, insideRoot, isPersonalRoot, navStart } from './projects.mjs';
import { canCreateProject, selectProject } from './projectsUi.mjs';
import { agentSandbox } from './sandbox.mjs';
import { isAdmin, rootOf, sandboxed, userPath } from './state.mjs';
import { dest, tg } from './telegram.mjs';
import { hCode, th } from './ui.mjs';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
/** Сколько бот ждёт токен, описание изменений или строку поиска. */
export const GIT_WAIT_MS = 10 * 60_000;

const cancelMarkup = (lang) => ({ inline_keyboard: [[{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] });
const dateOf = (iso, lang) => (iso ? new Date(iso).toLocaleDateString(LOCALES[lang] ?? LOCALES.en, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

/** Папка проекта диалога, если она доступна, иначе null. */
const projectOf = (st) => insideRoot(st.project, rootOf(st.userId));

/**
 * Как запускать git для этого пользователя: окружение (автор коммитов, вход в сервис), песочница сотрудника
 * (если она включена) и строки, которые нужно вычистить из сообщений об ошибках.
 */
function gitOpts(st, cwd, { host = null, account = null } = {}) {
  const who = account ?? accountsOf(st.userId)[0]?.account ?? null;
  const auth = host && account ? authConfig(host, account.token) : [];
  const root = rootOf(st.userId);
  const wrap = sandboxed(st.userId)
    ? agentSandbox({ userId: st.userId, cwd, root, command: gitCommand(), protect: isPersonalRoot(root) ? [ROOT] : [] })
    : null;
  return { env: gitEnv({ identity: identityOf(who), auth }), wrap, hide: account ? [account.token, auth[0]?.[1]?.split(' ').pop()] : [] };
}

/** Репозиторий проекта и его сервис: {state, host, account} или null, если проект не репозиторий (или репозиторий выше корня пользователя). */
async function repoOf(st, project) {
  const state = await repoState(project, gitOpts(st, project));
  if (!state || !insideRoot(state.top, rootOf(st.userId))) return null;
  const host = hostFor(state.remote);
  const account = host ? db.getGitAccount(st.userId, host.id) : null;
  return { state, host, account };
}

/**
 * Экран /git: состояние репозитория проекта, аккаунты, кнопки. Текст — HTML.
 * sync — сначала свериться с сервером (git fetch), чтобы «новых на сервере» было настоящим числом: при открытии экрана
 * и по кнопке «Обновить». Пока агент выполняет запрос или идёт другая операция git, сверка пропускается.
 */
export async function gitView(st, lang = langOf(st.userId), { sync = false } = {}) {
  const project = projectOf(st);
  const hosts = allHosts();
  const accounts = accountsOf(st.userId);
  const lines = [th('git.head', lang, { p: hCode(project ? userPath(st.userId, project, lang) : '—') })];
  const rows = [];
  const load = () => (project ? repoOf(st, project).catch((e) => (log('git: состояние:', e.message), null)) : null);
  let repo = await load();
  let syncError = null;
  if (sync && repo?.account && !st.busy && !st.gitBusy) {
    try {
      await fetchRepo(project, gitOpts(st, project, repo));
      repo = await load();
    } catch (e) {
      log('git: сверка с сервером:', e.message, '| пользователь', st.userId);
      syncError = e.message;
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
      }
    } else if (repo.host) lines.push(th('git.needAccount', lang, { host: repo.host.label }));
    else lines.push(th(s.remote ? 'git.foreign' : 'git.noRemote', lang));
    // что изменено и какие есть ветки — можно смотреть без агента и без аккаунта
    rows.push([{ text: t('git.changesBtn', lang), callback_data: 'gt:ch:0' }, { text: t('git.branchesBtn', lang), callback_data: 'gt:br:0' }]);
  } else lines.push(th('git.noRepo', lang));
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

const KIND_LABEL = { gitlab: 'GitLab', github: 'GitHub Enterprise' };

/** Экран администратора «Свои серверы»: список, добавление GitLab или GitHub Enterprise, название, удаление. */
function hostsView(lang, note = '') {
  const own = allHosts().filter((h) => h.custom);
  const list = own.length
    ? own.map((h) => th('git.hosts.line', lang, { label: h.label, url: h.web, kind: KIND_LABEL[h.kind] }) + (h.fromEnv ? th('git.hosts.env', lang) : '')).join('\n')
    : `<i>${th('git.hosts.none', lang)}</i>`;
  const rows = own.filter((h) => !h.fromEnv).map((h) => [{ text: `✏️ ${h.label}`, callback_data: `gt:hn:${h.id}` }, { text: `🗑 ${t('git.hosts.remove', lang)}`, callback_data: `gt:hd:${h.id}` }]);
  rows.push([{ text: t('git.hosts.addGitlab', lang), callback_data: 'gt:ha:gitlab' }, { text: t('git.hosts.addGithub', lang), callback_data: 'gt:ha:github' }]);
  rows.push([{ text: t('btn.back', lang), callback_data: 'gt:v' }]);
  return { text: `${note ? `${note}\n\n` : ''}${th('git.hosts.head', lang)}\n\n${list}`, markup: { inline_keyboard: rows } };
}

/** /git */
export async function handleGit(st) {
  const lang = langOf(st.userId);
  if (!gitAvailable()) return say(st.to, t('git.none', lang));
  const v = await gitView(st, lang, { sync: true });
  return tg('sendMessage', { ...dest(st.to), text: v.text, ...HTML, reply_markup: v.markup }).catch((e) => log('git:', e.message));
}

/** Текст ошибки git или сервиса для пользователя. */
const failText = (e, lang) => th('git.opFail', lang, { msg: e instanceof GitError || e instanceof HostError ? e.message : errText(e, lang) });

/** Куда клонировать: личное пространство сотрудника, иначе — папка рядом с текущим проектом (или корень). */
function cloneBase(st) {
  const root = rootOf(st.userId);
  if (isPersonalRoot(root)) return insideRoot(root, root);
  return insideRoot(navStart(st.project, root), root) ?? (root ? insideRoot(root, root) : null);
}

/** Список репозиториев сервиса кнопками (страница, поиск). Выбор — gt:k:<номер> по запомненному списку. */
async function reposView(st, host, account, { page = 0, search = '' } = {}, lang) {
  const { items, more } = await listRepos(host, account.token, { page, search });
  st.gitRepos = { host: host.id, items, page, search };
  const base = cloneBase(st);
  const rows = items.map((r, i) => [{ text: [...`${r.private ? '🔒' : '📂'} ${r.name}`].slice(0, 60).join(''), callback_data: `gt:k:${i}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀', callback_data: `gt:r:${host.id}:${page - 1}` });
  if (more) nav.push({ text: '▶', callback_data: `gt:r:${host.id}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: t('git.search', lang), callback_data: `gt:s:${host.id}` }, { text: t('btn.back', lang), callback_data: 'gt:v' }]);
  const head = th('git.repos', lang, { host: host.label, q: search ? ` «${search}»` : '', dir: hCode(base ? userPath(st.userId, base, lang) : '—') });
  return { text: items.length ? head : `${head}\n\n<i>${th('git.reposNone', lang)}</i>`, markup: { inline_keyboard: rows } };
}

/** Клонирует выбранный репозиторий в пространство пользователя и выбирает его проектом. */
async function cloneChosen(st, repo, host, account, lang, edit) {
  const base = cloneBase(st);
  const name = folderName(repoFolder(repo.url));
  if (!base || !name) return edit({ text: th('git.cloneBadName', lang) });
  const target = join(base, name);
  if (insideRoot(target, rootOf(st.userId))) return edit({ text: th('git.cloneExists', lang, { name: hCode(name), dir: hCode(userPath(st.userId, base, lang)) }) });
  await edit({ text: th('git.cloning', lang, { name: hCode(repo.name) }) });
  try {
    await cloneRepo(repo.url, name, { cwd: base, ...gitOpts(st, base, { host, account }) });
  } catch (e) {
    log('git: клонирование:', e.message, '| пользователь', st.userId);
    return edit({ text: failText(e, lang) });
  }
  const dir = insideRoot(target, rootOf(st.userId));
  if (!dir) return edit({ text: th('git.cloneBadName', lang) });
  log('репозиторий клонирован:', st.userId, repo.name, dir);
  await edit({ text: th('git.cloned', lang, { name: hCode(repo.name), p: hCode(userPath(st.userId, dir, lang)) }) });
  return selectProject(st, dir);
}

/**
 * Операция с репозиторием проекта: 'pull', 'push', 'pushf' (отправить, несмотря на секреты в коммитах) или 'save'
 * (закоммитить всё с описанием message и отправить). Итог пишется в сообщение edit вместе с обновлённым экраном.
 */
async function repoAction(st, action, lang, edit, { message = null } = {}) {
  const project = projectOf(st);
  const repo = project ? await repoOf(st, project) : null;
  if (!repo?.account) return edit(await gitView(st, lang));
  const opts = gitOpts(st, project, repo);
  const done = async (text) => {
    const v = await gitView(st, lang);
    return edit({ text: `${text}\n\n${v.text}`, markup: v.markup });
  };
  st.gitBusy = true;
  try {
    if (action === 'pull') {
      await edit({ text: th('git.pulling', lang) });
      const result = await pullRepo(project, opts);
      log('git: получено:', st.userId, project, '|', result);
      return await done(th(`git.pull.${result}`, lang));
    }
    let note = '';
    if (action === 'save') {
      await edit({ text: th('git.saving', lang) });
      const r = await commitAll(project, message, opts);
      if (r.skipped.length) note += `\n${th('git.skipped', lang, { files: r.skipped.join(', ') })}`;
      if (r.tracked.length) note += `\n${th('git.tracked', lang, { files: r.tracked.join(', ') })}`;
      const after = await repoState(project, opts);
      if (!r.committed && !after?.ahead && after?.upstream) return await done(th('git.savedNothing', lang) + note);
    } else await edit({ text: th('git.pushing', lang) });
    // секреты в коммитах, которые сделал агент: перед отправкой — предупреждение и явное согласие
    if (action !== 'pushf') {
      const secrets = await unpushedSecrets(project, opts);
      if (secrets.length) {
        const markup = { inline_keyboard: [[{ text: t('git.pushAnyway', lang), callback_data: 'gt:pushf' }, { text: t('btn.cancel', lang), callback_data: 'gt:v' }]] };
        return await edit({ text: th('git.secretsWarn', lang, { files: secrets.slice(0, 20).join('\n') }) + note, markup });
      }
    }
    const state = await repoState(project, opts);
    if (state?.upstream && !state.ahead) return await done(th('git.nothingToPush', lang) + note);
    try {
      await pushRepo(project, opts);
    } catch (e) {
      if (/rejected|non-fast-forward|fetch first/i.test(`${e.message} ${e.stderr ?? ''}`)) return await done(th('git.pushRejected', lang) + note);
      throw e;
    }
    log('git: отправлено:', st.userId, project);
    return await done(th(action === 'save' ? 'git.saved' : 'git.pushed', lang) + note);
  } catch (e) {
    log(`git: ${action}:`, e.message, '| пользователь', st.userId);
    return await done(failText(e, lang));
  } finally {
    st.gitBusy = false;
  }
}

/** Кнопки /git (gt:<действие>[:<аргумент>[:<страница>]]). */
export async function onGitCallback(st, cb) {
  const [, action, arg, pageStr] = (cb.data || '').split(':');
  const lang = langOf(st.userId);
  const chatId = cb.message?.chat?.id ?? st.chatId;
  const messageId = cb.message?.message_id;
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
  const edit = (v) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text: v.text, ...HTML, reply_markup: v.markup ?? { inline_keyboard: [] } }).catch((e) => /not modified/i.test(e.message) || log('git:', e.message));
  if (!gitAvailable()) return ack(t('git.none', lang));
  if (action === 'x') {
    st.pendingInput = null;
    await ack();
    return edit({ text: th('files.cancelled', lang) });
  }
  if (action === 'v') {
    await ack();
    return edit(await gitView(st, lang, { sync: true }));
  }
  // ---- свои серверы: только администратор ----
  if (['h', 'ha', 'hn', 'hd', 'hD'].includes(action)) {
    if (!isAdmin(st.userId)) return ack(t('admin.only', lang));
    if (action === 'h') return (await ack(), edit(hostsView(lang)));
    if (action === 'ha' && KIND_LABEL[arg]) {
      await ack();
      st.pendingInput = { kind: 'gitHostUrl', hostKind: arg, at: Date.now() };
      return say(st.to, t('git.hosts.urlAsk', lang, { kind: KIND_LABEL[arg] }), { reply_markup: cancelMarkup(lang) });
    }
    const own = findHost(arg);
    if (!own?.custom || own.fromEnv) return ack(t('proj.stale', lang));
    if (action === 'hn') {
      await ack();
      st.pendingInput = { kind: 'gitHostName', host: own.id, at: Date.now() };
      return say(st.to, t('git.hosts.nameAsk', lang), { reply_markup: cancelMarkup(lang) });
    }
    if (action === 'hd') {
      await ack();
      return edit({ text: th('git.hosts.deleteAsk', lang, { label: own.label }), markup: { inline_keyboard: [[{ text: t('git.hosts.remove', lang), callback_data: `gt:hD:${own.id}` }, { text: t('btn.cancel', lang), callback_data: 'gt:h' }]] } });
    }
    const n = removeCustomHost(own.id);
    log('свой сервер git убран:', own.web, '| отключено аккаунтов', n);
    await ack();
    return edit(hostsView(lang, th('git.hosts.deleted', lang, { label: own.label, n: n ?? 0 })));
  }
  // экраны «Изменения» и «Ветки» — gitRepoUi
  if (REPO_ACTIONS.includes(action)) return onRepoCallback(st, cb, { action, arg, lang, ack, edit, project: projectOf(st), repoOf, gitOpts });
  const host = findHost(arg);
  const account = host ? db.getGitAccount(st.userId, host.id) : null;
  try {
    // ---- аккаунты ----
    if (action === 'c' && host) {
      await ack();
      st.pendingInput = { kind: 'gitToken', host: host.id, at: Date.now() };
      return say(st.to, th('git.tokenAsk', lang, { host: host.label, url: host.tokenUrl, scopes: hCode(host.scopes) }), { ...HTML, reply_markup: cancelMarkup(lang) });
    }
    if ((action === 'a' || action === 'd') && account) {
      await ack();
      const text = th(action === 'd' ? 'git.disconnectAsk' : 'git.accCard', lang, { host: host.label, login: account.login, name: account.name ?? '', email: hCode(account.email ?? '—'), date: dateOf(account.expires_at, lang) });
      const rows = action === 'd'
        ? [[{ text: t('git.disconnect', lang), callback_data: `gt:D:${host.id}` }, { text: t('btn.cancel', lang), callback_data: `gt:a:${host.id}` }]]
        : [[{ text: t('git.disconnect', lang), callback_data: `gt:d:${host.id}` }], [{ text: t('btn.back', lang), callback_data: 'gt:v' }]];
      return edit({ text, markup: { inline_keyboard: rows } });
    }
    if (action === 'D' && account) {
      db.deleteGitAccount(st.userId, host.id);
      log('аккаунт git отключён:', st.userId, host.id);
      await ack(t('git.disconnected', lang, { host: host.label }));
      return edit(await gitView(st, lang));
    }
    // ---- клонирование ----
    if (action === 'cl') {
      if (!canCreateProject(st.userId)) return ack(t('files.noRights', lang));
      const list = accountsOf(st.userId);
      if (!list.length) return ack(t('git.connectFirst', lang));
      await ack();
      if (list.length === 1) return edit(await reposView(st, list[0].host, list[0].account, {}, lang));
      return edit({ text: th('git.pickHost', lang), markup: { inline_keyboard: [...list.map((x) => [{ text: x.host.label, callback_data: `gt:r:${x.host.id}:0` }]), [{ text: t('btn.back', lang), callback_data: 'gt:v' }]] } });
    }
    if (action === 'r' && account) {
      await ack();
      const search = st.gitRepos?.host === host.id ? st.gitRepos.search : '';
      return edit(await reposView(st, host, account, { page: Number(pageStr) || 0, search }, lang));
    }
    if (action === 's' && account) {
      await ack();
      st.pendingInput = { kind: 'gitSearch', host: host.id, at: Date.now() };
      return say(st.to, t('git.searchAsk', lang), { reply_markup: cancelMarkup(lang) });
    }
    if (action === 'k') {
      const list = st.gitRepos;
      const repo = list?.items[Number(arg)];
      const h = findHost(list?.host);
      const acc = h ? db.getGitAccount(st.userId, h.id) : null;
      if (!repo || !acc || !canCreateProject(st.userId)) return ack(t('proj.stale', lang));
      if (hostFor(repo.url)?.id !== h.id) return ack(t('proj.stale', lang)); // адрес обязан принадлежать своему сервису
      if (st.gitBusy) return ack(t('git.busy', lang));
      await ack();
      st.gitBusy = true;
      try {
        return await cloneChosen(st, repo, h, acc, lang, edit);
      } finally {
        st.gitBusy = false;
      }
    }
    // ---- репозиторий проекта ----
    if (['pull', 'push', 'pushf', 'save', 'savenow'].includes(action)) {
      if (!canManageFiles(st.userId)) return ack(t('files.noRights', lang));
      if (st.gitBusy) return ack(t('git.busy', lang));
      if (st.busy) return ack(t('git.agentBusy', lang));
      await ack();
      if (action === 'save') {
        st.pendingInput = { kind: 'gitMessage', at: Date.now() };
        const markup = { inline_keyboard: [[{ text: t('git.noMessage', lang), callback_data: 'gt:savenow' }], [{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] };
        return say(st.to, t('git.messageAsk', lang), { reply_markup: markup });
      }
      if (action === 'savenow') {
        st.pendingInput = null;
        return repoAction(st, 'save', lang, edit, { message: t('git.autoMessage', lang, { date: dateOf(new Date().toISOString(), lang) }) });
      }
      return repoAction(st, action, lang, edit);
    }
    return ack(t('proj.stale', lang));
  } catch (e) {
    log('git:', e.message, '| пользователь', st.userId);
    await ack();
    return edit({ text: failText(e, lang) });
  }
}

/** Удаляет сообщение пользователя (с токеном): копии в чате остаться не должно. */
const dropMessage = (st, messageId) => (messageId ? tg('deleteMessage', { chat_id: st.chatId, message_id: messageId }).catch((e) => log('git: сообщение не удалено:', e.message)) : null);

/**
 * Текст пользователя, пока бот ждёт токен доступа, строку поиска репозитория или описание изменений. true — текст
 * обработан здесь и агенту не передаётся. Токен агенту не уходит никогда: даже если ожидание истекло, сообщение
 * удаляется, а не превращается в запрос.
 */
export async function onGitInput(st, text, { messageId, now = Date.now() } = {}) {
  const wait = st.pendingInput;
  if (!['gitToken', 'gitSearch', 'gitMessage', 'gitHostUrl', 'gitHostName', 'gitBranch'].includes(wait?.kind)) return false;
  const lang = langOf(st.userId);
  const expired = now - wait.at > GIT_WAIT_MS;
  const send = (v) => tg('sendMessage', { ...dest(st.to), text: v.text, ...HTML, reply_markup: v.markup ?? { inline_keyboard: [] } }).catch((e) => log('git:', e.message));

  if (wait.kind === 'gitToken') {
    await dropMessage(st, messageId);
    const host = findHost(wait.host);
    if (expired || !host) {
      st.pendingInput = null;
      return (await say(st.to, t('git.tokenExpired', lang)), true);
    }
    const token = text.trim();
    if (/\s/.test(token) || token.length < 10) return (await say(st.to, t('git.tokenBad', lang), { reply_markup: cancelMarkup(lang) }), true);
    let profile;
    try {
      profile = await fetchProfile(host, token);
    } catch (e) {
      log('git: проверка токена:', e.message, '| пользователь', st.userId);
      const textFail = e instanceof HostError && e.code === 'auth' ? t('git.tokenBad', lang) : t('git.tokenFail', lang, { msg: e.message });
      return (await say(st.to, textFail, { reply_markup: cancelMarkup(lang) }), true); // ожидание остаётся: можно прислать ещё раз
    }
    st.pendingInput = null;
    if (!db.saveGitAccount(st.userId, { host: host.id, login: profile.login, name: profile.name, email: profile.email, token, expiresAt: profile.expiresAt })) {
      return (await say(st.to, t('access.saveFail', lang)), true);
    }
    log('аккаунт git подключён:', st.userId, host.id, profile.login);
    const lack = missingScopes(host, profile.scopes);
    const parts = [
      th('git.connected', lang, { host: host.label, login: profile.login, name: profile.name }),
      ...(profile.expiresAt ? [th('git.expires', lang, { date: dateOf(profile.expiresAt, lang) })] : []),
      ...(lack.length ? [th('git.scopesWarn', lang, { scopes: lack.join(', ') })] : []),
    ];
    await send({ text: parts.join('\n') });
    await send(await gitView(st, lang));
    return true;
  }

  st.pendingInput = null;
  if (expired) return false; // адрес сервера, строка поиска и описание изменений — не секреты: позже это обычный запрос агенту
  if (wait.kind === 'gitBranch') return onBranchInput(st, text, { wait, now, lang, project: projectOf(st), repoOf, gitOpts });
  // свои серверы: адрес нового сервера или новое название — только от администратора
  if (wait.kind === 'gitHostUrl' || wait.kind === 'gitHostName') {
    if (!isAdmin(st.userId)) return false;
    if (wait.kind === 'gitHostName') {
      renameCustomHost(wait.host, text);
      return (await send(hostsView(lang)), true);
    }
    const again = () => (st.pendingInput = { ...wait, at: now }); // адрес не подошёл — ждём другой
    const candidate = customHost(wait.hostKind, text);
    if (!candidate) return (again(), await say(st.to, t('git.hosts.badUrl', lang), { reply_markup: cancelMarkup(lang) }), true);
    const probe = await probeHost(candidate);
    if (!probe.ok) {
      again();
      return (await say(st.to, t('git.hosts.probeFail', lang, { url: candidate.web, kind: KIND_LABEL[candidate.kind], msg: probe.error }), { reply_markup: cancelMarkup(lang) }), true);
    }
    const added = addCustomHost(wait.hostKind, candidate.web);
    if (added.error) return (await send(hostsView(lang, th('git.hosts.exists', lang))), true);
    log('свой сервер git добавлен:', added.host.kind, added.host.web, '| администратор', st.userId);
    return (await send(hostsView(lang, th('git.hosts.added', lang, { label: added.host.label }))), true);
  }
  if (wait.kind === 'gitSearch') {
    const host = findHost(wait.host);
    const account = host ? db.getGitAccount(st.userId, host.id) : null;
    if (!account) return false;
    try {
      await send(await reposView(st, host, account, { search: text.trim().slice(0, 60) }, lang));
    } catch (e) {
      await send({ text: failText(e, lang) });
    }
    return true;
  }
  // описание изменений: первая строка, не длиннее 200 символов
  const message = [...text.trim().split(/\r?\n/)[0]].slice(0, 200).join('') || t('git.autoMessage', lang, { date: dateOf(new Date().toISOString(), lang) });
  if (st.gitBusy || st.busy) return (await say(st.to, t(st.busy ? 'git.agentBusy' : 'git.busy', lang)), true);
  const progress = await tg('sendMessage', { ...dest(st.to), text: th('git.saving', lang), ...HTML }).catch(() => null);
  const edit = (v) =>
    progress
      ? tg('editMessageText', { chat_id: st.chatId, message_id: progress.message_id, text: v.text, ...HTML, reply_markup: v.markup ?? { inline_keyboard: [] } }).catch((e) => /not modified/i.test(e.message) || log('git:', e.message))
      : send(v);
  await repoAction(st, 'save', lang, edit, { message });
  return true;
}

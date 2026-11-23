// Экраны /git «Опубликовать проект» и «Запрос на слияние».
// Публикация: папка, которая ещё не связана с сервером, становится репозиторием — пользователь выбирает сервис, место
// (личное пространство, группа или организация), видимость и название; бот создаёт репозиторий, делает первый коммит
// (без файлов с секретами) и отправляет. Запрос на слияние: из текущей ветки в основную ветку репозитория.
// Общие помощники (проект, репозиторий, запуск git) живут в gitCtx.mjs.
import { basename } from 'node:path';
import { db, log, say } from './ctx.mjs';
import { canManageFiles } from './filesUi.mjs';
import { commitAll, pushRepo, repoState } from './git.mjs';
import { accountsOf, findHost, hostFor } from './gitAccess.mjs';
import { acquireGitLock, failText, gitNetOpts, gitOpts, releaseGitLock, repoOf } from './gitCtx.mjs';
import { recall, remember } from './gitKeys.mjs';
import { createRepo, listNamespaces, openMergeRequest, repoInfo, repoSlug, visibilities } from './gitApi.mjs';
import { HostError, showRemote } from './gitHosts.mjs';
import { ensureRepo, hasCommits, isRepoRoot, lastSubject, setRemote } from './gitInspect.mjs';
import { t } from './i18n.mjs';
import { userPath } from './state.mjs';
import { hCode, th } from './ui.mjs';

/** Действия кнопок этого модуля (gt:<действие>:<аргумент>). */
export const PUBLISH_ACTIONS = ['pb', 'pbh', 'pbn', 'pbs', 'pbv', 'pbname', 'pbgo', 'mr', 'mrgo'];
/** Ожидания текста, которые обрабатывает этот модуль. */
export const PUBLISH_INPUTS = ['gitNsSearch', 'gitRepoName', 'gitMrTitle'];

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const NS_MAX = 30;
const VIS_MARK = { private: '🔒', internal: '🏢', public: '🌍' };
const backRow = (lang) => [{ text: t('btn.back', lang), callback_data: 'gt:v' }];
const cancelMarkup = (lang) => ({ inline_keyboard: [[{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] });

/** Можно ли публиковать проект: это ещё не репозиторий с адресом сервера (свой репозиторий без origin — тоже можно). */
export async function canPublish(st, project) {
  if (!canManageFiles(st.userId) || !accountsOf(st.userId).length) return false;
  const opts = gitOpts(st, project);
  if (!(await isRepoRoot(project, opts))) return true;
  return !(await repoState(project, opts))?.remote;
}

const accountOf = (st, pub) => {
  const host = findHost(pub?.hostId);
  const account = host ? db.getGitAccount(st.userId, host.id) : null;
  return host && account ? { host, account } : null;
};

/** Шаг «куда»: личное пространство и группы (организации) кнопками, поиск по группам. */
async function namespacesView(st, lang, search = '') {
  const { host, account } = accountOf(st, st.gitPublish);
  const list = (await listNamespaces(host, account.token, account.login, { search })).slice(0, NS_MAX);
  const rows = list.map((n) => [{ text: [...(n.kind === 'user' ? `👤 ${n.path} — ${t('git.pb.personal', lang)}` : `👥 ${n.path}`)].slice(0, 60).join(''), callback_data: `gt:pbn:${remember(st, { host: host.id, namespace: n })}` }]);
  rows.push([{ text: t('git.pb.search', lang), callback_data: 'gt:pbs' }, ...backRow(lang)]);
  const head = th('git.pb.where', lang, { host: host.label, q: search ? ` «${search}»` : '' });
  return { text: list.length ? head : `${head}\n\n<i>${th('git.pb.noPlaces', lang)}</i>`, markup: { inline_keyboard: rows } };
}

/** Итог перед созданием: что и куда публикуется; название можно изменить. */
function summaryView(st, project, lang) {
  const pub = st.gitPublish;
  const { host } = accountOf(st, pub);
  const address = pub.slug ? `${showRemote(host.web)}/${pub.namespace.path}/${pub.slug}` : '—';
  const text = th('git.pb.summary', lang, { p: hCode(userPath(st.userId, project, lang)), address: hCode(address), vis: `${VIS_MARK[pub.visibility]} ${t(`git.vis.${pub.visibility}`, lang)}` });
  const rows = [
    ...(pub.slug ? [[{ text: t('git.pb.go', lang), callback_data: 'gt:pbgo', style: 'success' }]] : []),
    [{ text: t('git.pb.rename', lang), callback_data: 'gt:pbname' }],
    backRow(lang),
  ];
  return { text, markup: { inline_keyboard: rows } };
}

/** Создаёт репозиторий на сервисе, делает первый коммит и отправляет. */
async function publish(st, project, lang, edit, view) {
  const pub = st.gitPublish;
  const { host, account } = accountOf(st, pub);
  const opts = gitOpts(st, project, account);
  const net = gitNetOpts(st, project, { host, account });
  const lock = acquireGitLock(st, project);
  if (!lock) return edit({ text: t('git.busy', lang), markup: { inline_keyboard: [backRow(lang)] } });
  try {
    await edit({ text: th('git.pb.working', lang) });
    // сначала локальная часть: если публиковать нечего, репозиторий на сервере не создаётся
    await ensureRepo(project, opts);
    const first = await commitAll(project, t('git.pb.firstCommit', lang), opts);
    if (!(await hasCommits(project, opts))) return await edit({ text: th('git.pb.empty', lang), markup: { inline_keyboard: [backRow(lang)] } });
    const created = await createRepo(host, account.token, { name: pub.name, slug: pub.slug, namespace: pub.namespace, visibility: pub.visibility });
    log('git: репозиторий создан:', st.userId, host.id, created.path);
    // адрес из ответа сервиса уходит в настройки репозитория: чужой адрес (или не адрес вовсе) не принимаем
    if (hostFor(created.url)?.id !== host.id) throw new HostError('http', `${host.label}: unexpected repository address`);
    await setRemote(project, created.url, opts);
    await pushRepo(project, net);
    log('git: проект опубликован:', st.userId, project, '→', created.path);
    st.gitPublish = null;
    const note = [
      ...(first.skipped.length ? [th('git.skipped', lang, { files: first.skipped.join(', ') })] : []),
      ...(first.tracked.length ? [th('git.tracked', lang, { files: first.tracked.join(', ') })] : []),
      ...(first.ignoreWarning ? [th('git.ignoreLink', lang)] : []),
    ].map((s) => `\n${s}`).join('');
    const v = await view();
    const open = created.web ? [[{ text: t('git.open', lang), url: created.web }]] : [];
    return await edit({ text: `${th('git.pb.done', lang, { address: hCode(showRemote(created.url)) })}${note}\n\n${v.text}`, markup: { inline_keyboard: [...open, ...v.markup.inline_keyboard] } });
  } catch (e) {
    log('git: публикация:', e.message, '| пользователь', st.userId);
    return await edit({ text: failText(e, lang, host), markup: { inline_keyboard: [backRow(lang)] } });
  } finally {
    releaseGitLock(st, lock);
  }
}

/** Создаёт запрос на слияние текущей ветки в основную (или находит уже открытый) и даёт ссылку. */
async function mergeRequest(st, project, title, lang, edit) {
  const mr = st.gitMr;
  const repo = await repoOf(st, project);
  if (!mr || !repo?.account) return edit({ text: th('git.diff.gone', lang), markup: { inline_keyboard: [backRow(lang)] } });
  st.gitMr = null;
  try {
    const r = await openMergeRequest(repo.host, repo.account.token, repo.state.remote, { branch: mr.branch, target: mr.target, title });
    log('git: запрос на слияние:', st.userId, project, mr.branch, '→', mr.target, r.existed ? '(уже был)' : '');
    const text = th(r.existed ? 'git.mr.exists' : 'git.mr.done', lang, { n: r.number, branch: hCode(mr.branch), target: hCode(mr.target) });
    return await edit({ text, markup: { inline_keyboard: [[{ text: t('git.open', lang), url: r.url }], backRow(lang)] } });
  } catch (e) {
    log('git: запрос на слияние:', e.message, '| пользователь', st.userId);
    return await edit({ text: failText(e, lang, repo.host), markup: { inline_keyboard: [backRow(lang)] } });
  }
}

/** Кнопки «Опубликовать проект» (pb…) и «Запрос на слияние» (mr…). */
export async function onPublishCallback(st, cb, h) {
  const { action, arg, lang, ack, edit, project, view } = h;
  if (!project) return ack(t('state.projectGone', lang));
  if (!canManageFiles(st.userId)) return ack(t('files.noRights', lang));
  if (st.gitBusy) return ack(t('git.busy', lang));
  if (st.busy) return ack(t('git.agentBusy', lang));
  try {
    // ---- запрос на слияние ----
    if (action === 'mr') {
      const repo = await repoOf(st, project);
      if (!repo?.account || !repo.state.branch) return ack(t('proj.stale', lang));
      await ack();
      const info = await repoInfo(repo.host, repo.account.token, repo.state.remote);
      const s = repo.state;
      if (s.branch === info.defaultBranch) return edit({ text: th('git.mr.onDefault', lang, { branch: hCode(s.branch) }), markup: { inline_keyboard: [[{ text: t('git.branchesBtn', lang), callback_data: 'gt:br:0' }], backRow(lang)] } });
      if (!s.upstream || s.ahead) return edit({ text: th('git.mr.pushFirst', lang, { branch: hCode(s.branch) }), markup: { inline_keyboard: [[{ text: t('git.push', lang), callback_data: 'gt:push' }], backRow(lang)] } });
      const suggested = (await lastSubject(project, gitOpts(st, project, repo.account))) || s.branch;
      st.gitMr = { branch: s.branch, target: info.defaultBranch, suggested };
      st.pendingInput = { kind: 'gitMrTitle', at: Date.now() };
      const markup = { inline_keyboard: [[{ text: [...`«${suggested}»`].slice(0, 60).join(''), callback_data: 'gt:mrgo' }], [{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] };
      return edit({ text: th('git.mr.ask', lang, { branch: hCode(s.branch), target: hCode(info.defaultBranch) }), markup });
    }
    if (action === 'mrgo') {
      st.pendingInput = null;
      await ack();
      return await mergeRequest(st, project, st.gitMr?.suggested ?? '', lang, edit);
    }
    // ---- публикация ----
    if (!(await canPublish(st, project))) return ack(t('proj.stale', lang));
    const accounts = accountsOf(st.userId);
    if (action === 'pb') {
      await ack();
      st.gitPublish = { hostId: accounts[0].host.id, visibility: 'private', name: basename(project), slug: repoSlug(basename(project)) };
      if (accounts.length === 1) return edit(await namespacesView(st, lang));
      return edit({ text: th('git.pb.pickHost', lang), markup: { inline_keyboard: [...accounts.map((x) => [{ text: x.host.label, callback_data: `gt:pbh:${x.host.id}` }]), backRow(lang)] } });
    }
    const pub = st.gitPublish;
    if (!pub) return ack(t('proj.stale', lang));
    if (action === 'pbh') {
      if (!accounts.some((x) => x.host.id === arg)) return ack(t('proj.stale', lang));
      pub.hostId = arg;
      await ack();
      return edit(await namespacesView(st, lang));
    }
    if (!accountOf(st, pub)) return ack(t('proj.stale', lang));
    if (action === 'pbs') {
      await ack();
      st.pendingInput = { kind: 'gitNsSearch', at: Date.now() };
      return say(st.to, t('git.pb.searchAsk', lang), { reply_markup: cancelMarkup(lang) });
    }
    if (action === 'pbn') {
      const chosen = recall(st, arg);
      const ns = chosen?.host === pub.hostId ? chosen.namespace : null; // место — того же сервиса, что выбран для публикации
      if (!ns) return ack(t('proj.stale', lang));
      pub.namespace = ns;
      await ack();
      const { host } = accountOf(st, pub);
      const rows = visibilities(host).map((v) => [{ text: `${VIS_MARK[v]} ${t(`git.vis.${v}`, lang)} — ${t(`git.vis.${v}.hint`, lang)}`, callback_data: `gt:pbv:${v}` }]);
      return edit({ text: th('git.pb.visAsk', lang, { where: hCode(ns.path) }), markup: { inline_keyboard: [...rows, backRow(lang)] } });
    }
    if (!pub.namespace) return ack(t('proj.stale', lang));
    if (action === 'pbv') {
      if (!visibilities(accountOf(st, pub).host).includes(arg)) return ack(t('proj.stale', lang));
      pub.visibility = arg;
      await ack();
      return edit(summaryView(st, project, lang));
    }
    if (action === 'pbname') {
      await ack();
      st.pendingInput = { kind: 'gitRepoName', at: Date.now() };
      return say(st.to, t('git.pb.nameAsk', lang), { reply_markup: cancelMarkup(lang) });
    }
    if (action === 'pbgo') {
      if (!pub.slug) return ack(t('git.pb.nameBad', lang));
      await ack();
      return await publish(st, project, lang, edit, view);
    }
    return ack(t('proj.stale', lang));
  } catch (e) {
    log(`git: ${action}:`, e.message, '| пользователь', st.userId);
    await ack();
    return edit({ text: failText(e, lang, accountOf(st, st.gitPublish)?.host), markup: { inline_keyboard: [backRow(lang)] } });
  }
}

/**
 * Текст пользователя для публикации и запроса на слияние: строка поиска группы, название репозитория, заголовок запроса.
 * @param {object} h {wait, now, lang, project, send, view}
 * @returns {Promise<boolean>} true — текст обработан здесь
 */
export async function onPublishInput(st, text, h) {
  const { wait, lang, project, send } = h;
  if (!project || !canManageFiles(st.userId)) return false;
  try {
    if (wait.kind === 'gitMrTitle') {
      if (st.gitBusy || st.busy) return (await say(st.to, t(st.busy ? 'git.agentBusy' : 'git.busy', lang)), true);
      const title = [...text.trim().split(/\r?\n/)[0]].slice(0, 200).join('') || st.gitMr?.suggested || '';
      await mergeRequest(st, project, title, lang, send);
      return true;
    }
    const pub = st.gitPublish;
    if (!pub || !accountOf(st, pub)) return false;
    if (wait.kind === 'gitNsSearch') return (await send(await namespacesView(st, lang, text.trim().slice(0, 60))), true);
    // название репозитория
    const slug = repoSlug(text);
    if (!slug) {
      st.pendingInput = { ...wait, at: h.now }; // название не подошло — ждём другое
      return (await say(st.to, t('git.pb.nameBad', lang), { reply_markup: cancelMarkup(lang) }), true);
    }
    Object.assign(pub, { name: text.trim().slice(0, 100), slug });
    if (!pub.namespace) return (await send(await namespacesView(st, lang)), true);
    return (await send(summaryView(st, project, lang)), true);
  } catch (e) {
    log('git: публикация (ввод):', e.message, '| пользователь', st.userId);
    await say(st.to, failText(e, lang, accountOf(st, st.gitPublish)?.host), HTML);
    return true;
  }
}

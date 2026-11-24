import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, log, say } from './ctx.mjs';
import { cloneRepo } from './git.mjs';
import { accountsOf, findHost, hostFor } from './gitAccess.mjs';
import { GIT_BUSY, failText, gitNetOpts, withGitLock } from './gitCtx.mjs';
import { recall, remember } from './gitKeys.mjs';
import { listRepos, repoFolder } from './gitHosts.mjs';
import { t } from './i18n.mjs';
import { setPendingInput } from './pendingInput.mjs';
import { folderName, insideRoot, isPersonalRoot, navStart } from './projects.mjs';
import { canCreateProject, selectProject } from './projectsUi.mjs';
import { errorRootOf, rootOf, userPath } from './state.mjs';
import { hCode, th } from './ui.mjs';
import { pageRow } from './pagination.mjs';
import { btnText, cancelRow } from './uiActions.mjs';

/** Куда клонировать: личное пространство сотрудника, иначе — папка рядом с текущим проектом (или корень). */
function cloneBase(st) {
  const root = rootOf(st.userId);
  if (isPersonalRoot(root)) return insideRoot(root, root);
  return insideRoot(navStart(st.project, root), root) ?? (root ? insideRoot(root, root) : null);
}

/** Список репозиториев сервиса кнопками (страница, поиск). Выбор — gt:k:<ключ кнопки> (gitKeys). */
async function reposView(st, host, account, { page = 0, search = '' } = {}, lang) {
  const { items, more } = await listRepos(host, account.token, { page, search });
  st.gitRepos = { host: host.id, page, search }; // для перелистывания с тем же поиском
  const base = cloneBase(st);
  const rows = items.map((r) => [{ text: btnText(`${r.private ? '🔒' : '📂'} ${r.name}`), callback_data: `gt:k:${remember(st, { host: host.id, repo: r })}` }]);
  const nav = pageRow(page, more ? page + 2 : page + 1, (p) => `gt:r:${host.id}:${p}`, { center: false, prev: page > 0, next: more });
  if (nav.length) rows.push(nav);
  rows.push([{ text: t('git.search', lang), callback_data: `gt:s:${host.id}` }, { text: t('btn.back', lang), callback_data: 'gt:v' }]);
  const head = th('git.repos', lang, { host: host.label, q: search ? ` «${search}»` : '', dir: hCode(base ? userPath(st.userId, base, lang) : '—') });
  return { text: items.length ? head : `${head}\n\n<i>${th('git.reposNone', lang)}</i>`, markup: { inline_keyboard: rows } };
}

export function cleanFailedClone(st, target, base) {
  try {
    const info = lstatSync(target);
    const real = realpathSync.native(target);
    if (!info.isDirectory() || info.isSymbolicLink() || !insideRoot(real, base)) return;
    rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    log('git: папка неудачного клона не убрана:', e.message, '| пользователь', st.userId);
  }
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
    await cloneRepo(repo.url, name, { cwd: base, ...gitNetOpts(st, base, { host, account }) });
  } catch (e) {
    log('git: клонирование:', e.message, '| пользователь', st.userId);
    cleanFailedClone(st, target, base);
    return edit({ text: failText(e, lang, null, errorRootOf(st.userId)) });
  }
  const dir = insideRoot(target, rootOf(st.userId));
  if (!dir) return edit({ text: th('git.cloneBadName', lang) });
  log('репозиторий клонирован:', st.userId, repo.name, dir);
  await edit({ text: th('git.cloned', lang, { name: hCode(repo.name), p: hCode(userPath(st.userId, dir, lang)) }) });
  return selectProject(st, dir);
}

export async function onCloneCallback(st, h) {
  const { action, arg, pageStr, lang, ack, edit, host, account } = h;
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
    setPendingInput(st, 'gitSearch', { host: host.id });
    return say(st.to, t('git.searchAsk', lang), { reply_markup: cancelRow('gt', lang) });
  }
  if (action === 'k') {
    const chosen = recall(st, arg);
    const repo = chosen?.repo;
    const chosenHost = findHost(chosen?.host);
    const acc = chosenHost ? db.getGitAccount(st.userId, chosenHost.id) : null;
    if (!repo || !acc || !canCreateProject(st.userId)) return ack(t('proj.stale', lang));
    if (hostFor(repo.url)?.id !== chosenHost.id) return ack(t('proj.stale', lang)); // адрес обязан принадлежать своему сервису
    const result = await withGitLock(st, async () => {
      await ack();
      return cloneChosen(st, repo, chosenHost, acc, lang, edit);
    }, cloneBase(st) ?? st.userId);
    return result === GIT_BUSY ? ack(t('git.busy', lang)) : result;
  }
  return ack(t('proj.stale', lang));
}

export async function onSearchInput(st, text, h) {
  const { wait, lang, send } = h;
  const host = findHost(wait.host);
  const account = host ? db.getGitAccount(st.userId, host.id) : null;
  if (!account) return false;
  try {
    await send(await reposView(st, host, account, { search: text.trim().slice(0, 60) }, lang));
  } catch (e) {
    await send({ text: failText(e, lang, null, errorRootOf(st.userId)) });
  }
  return true;
}

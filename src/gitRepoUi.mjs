// Экраны /git «Изменения» и «Ветки»: что изменено в проекте (список файлов, изменения по файлу, неотправленные и
// ожидающие на сервере коммиты) и ветки (список, переключение, новая ветка). Смотреть может любой пользователь —
// без агента и без запросов к модели; переключать и создавать ветки — тот, кому разрешено менять файлы проекта.
// Вызывается из gitUi.mjs, который передаёт сюда общие помощники (h): проект, репозиторий, запуск git.
import { basename } from 'node:path';
import { log, say } from './ctx.mjs';
import { isSecretName, safeFileName } from './files.mjs';
import { canManageFiles } from './filesUi.mjs';
import { GitError, fetchRepo } from './git.mjs';
import { recall, remember } from './gitKeys.mjs';
import { branchName, changedFiles, commitList, createBranch, discardFiles, fileDiff, listBranches, switchBranch } from './gitInspect.mjs';
import { errText, t } from './i18n.mjs';
import { endAgent, userPath } from './state.mjs';
import { escHtml, sendBuffer } from './telegram.mjs';
import { hCode, th } from './ui.mjs';

/** Действия кнопок, которые обрабатывает этот модуль (gt:<действие>:<аргумент>). */
export const REPO_ACTIONS = ['ch', 'cf', 'cm', 'br', 'bs', 'bn', 'dx', 'dX', 'da', 'dA'];

const PAGE = 10;
/** Изменения файла длиннее этого приходят файлом: в сообщение Telegram они не помещаются. */
export const DIFF_INLINE_MAX = 3200;
const DIFF_FILE_MAX = 1024 * 1024;
const MARK = { new: '🆕', modified: '✏️', deleted: '🗑', renamed: '🔀', conflict: '⚠️' };

const failText = (e, lang) => th('git.opFail', lang, { msg: e instanceof GitError ? e.message : errText(e, lang) });
/** Длинный путь на кнопке показывается хвостом: имя файла важнее начала пути. */
const tail = (s, n) => ([...s].length > n ? `…${[...s].slice(-(n - 1)).join('')}` : s);
const counts = (f) => [f.added ? `+${f.added}` : '', f.deleted ? `−${f.deleted}` : ''].filter(Boolean).join(' ');
const pager = (prefix, page, pages) => {
  const nav = [];
  if (page > 0) nav.push({ text: '◀', callback_data: `${prefix}:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: 'nav:n' });
  if (page < pages - 1) nav.push({ text: '▶', callback_data: `${prefix}:${page + 1}` });
  return nav;
};

/** Экран «Изменения»: несохранённые изменения рабочей папки кнопками по файлам и переходы к спискам коммитов. */
async function changesView(st, project, repo, opts, page, lang) {
  const { files, total } = await changedFiles(project, opts);
  const pages = Math.max(1, Math.ceil(files.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const sum = (key) => files.reduce((n, f) => n + (f[key] ?? 0), 0);
  const head = th('git.ch.head', lang, { p: hCode(userPath(st.userId, project, lang)), branch: repo.state.branch ?? '—' });
  const body = total ? th('git.ch.sum', lang, { n: total, a: sum('added'), d: sum('deleted') }) + (total > files.length ? `\n<i>${th('git.ch.cut', lang, { n: files.length })}</i>` : '') : th('git.ch.none', lang);
  const rows = files.slice(page * PAGE, (page + 1) * PAGE).map((f) => [{ text: [...`${MARK[f.kind] ?? '✏️'} ${tail(f.path, 40)} ${counts(f)}`.trim()].slice(0, 60).join(''), callback_data: `gt:cf:${remember(st, { path: f.path })}` }]);
  if (pages > 1) rows.push(pager('gt:ch', page, pages));
  const s = repo.state;
  const commits = [];
  if (!s.upstream) commits.push({ text: t('git.ch.local', lang), callback_data: 'gt:cm:o' });
  if (s.upstream && s.ahead) commits.push({ text: t('git.ch.out', lang, { n: s.ahead }), callback_data: 'gt:cm:o' });
  if (s.upstream && s.behind) commits.push({ text: t('git.ch.in', lang, { n: s.behind }), callback_data: 'gt:cm:i' });
  if (commits.length) rows.push(commits);
  if (files.length && canManageFiles(st.userId)) rows.push([{ text: t('git.da.btn', lang), callback_data: 'gt:da' }]);
  rows.push([{ text: t('btn.back', lang), callback_data: 'gt:v' }]);
  return { text: `${head}\n\n${body}`, markup: { inline_keyboard: rows } };
}

/** Файлы с секретами отменой не трогаем: ими пользователь управляет сам в /files. */
const isSecretFile = (f) => isSecretName(`/${f.path}`);

/** Экран «Ветки»: текущая отмечена, ветки только с сервера помечены облаком; нажатие переключает. */
async function branchesView(st, project, repo, opts, page, lang, { sync = false } = {}) {
  // ветки сервера узнаём сверкой с ним — нужен подключённый аккаунт; не вышло — показываем то, что известно
  if (sync && repo.account && !st.busy && !st.gitBusy) await fetchRepo(project, opts).catch((e) => log('git: сверка веток:', e.message, '| пользователь', st.userId));
  const { current, branches } = await listBranches(project, opts);
  const pages = Math.max(1, Math.ceil(branches.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const rows = branches.slice(page * PAGE, (page + 1) * PAGE).map((b) => [{ text: [...`${b.current ? '✓' : b.local ? '🌿' : '☁️'} ${b.name}`].slice(0, 60).join(''), callback_data: `gt:bs:${remember(st, { branch: b.name })}` }]);
  if (pages > 1) rows.push(pager('gt:br', page, pages));
  if (canManageFiles(st.userId)) rows.push([{ text: t('git.br.new', lang), callback_data: 'gt:bn' }]);
  rows.push([{ text: t('btn.back', lang), callback_data: 'gt:v' }]);
  return { text: th('git.br.head', lang, { branch: hCode(current ?? '—') }), markup: { inline_keyboard: rows } };
}

/** Изменения одного файла: короткие — в сообщении, длинные — файлом; содержимое файлов с секретами не показывается. */
async function showDiff(st, project, file, index, opts, lang, edit) {
  const toList = [{ text: t('git.ch.back', lang), callback_data: 'gt:ch:0' }];
  const title = `${MARK[file.kind] ?? '✏️'} ${hCode(file.path).html}`;
  if (isSecretFile(file)) return edit({ text: th('git.diff.secret', lang, { path: hCode(file.path) }), markup: { inline_keyboard: [toList] } });
  // «Вернуть как было» — отмена изменений этого файла (с подтверждением)
  const back = { inline_keyboard: [...(canManageFiles(st.userId) ? [[{ text: t('git.dx.btn', lang), callback_data: `gt:dx:${index}` }]] : []), toList] };
  const diff = await fileDiff(project, file, opts);
  if (!diff) return edit({ text: `${title}\n\n${th('git.diff.empty', lang)}`, markup: back });
  if (diff.length <= DIFF_INLINE_MAX) return edit({ text: `${title}\n<pre><code class="language-diff">${escHtml(diff)}</code></pre>`, markup: back });
  const content = diff.length > DIFF_FILE_MAX ? `${diff.slice(0, DIFF_FILE_MAX)}\n… (truncated)\n` : `${diff}\n`;
  await sendBuffer(st.to, Buffer.from(content), `${safeFileName(basename(file.path))}.diff`);
  return edit({ text: th('git.diff.sent', lang, { path: hCode(file.path) }), markup: back });
}

/** Список коммитов: ещё не отправленных ('o') или ждущих на сервере ('i'). */
async function commitsView(project, opts, which, lang) {
  const list = await commitList(project, which === 'i' ? 'in' : 'out', opts);
  const lines = list.map((c) => `<code>${escHtml(c.hash)}</code> ${escHtml(c.date)} · ${escHtml(c.author)}\n${escHtml(c.subject)}`);
  const head = th(which === 'i' ? 'git.cm.in' : 'git.cm.out', lang, { n: list.length });
  return { text: `${head}\n\n${lines.length ? lines.join('\n\n') : `<i>${th('git.cm.none', lang)}</i>`}`, markup: { inline_keyboard: [[{ text: t('git.ch.back', lang), callback_data: 'gt:ch:0' }]] } };
}

/**
 * Кнопки экранов «Изменения» и «Ветки».
 * @param {object} h помощники из gitUi: {action, arg, lang, ack, edit, project, repoOf, gitOpts}
 */
export async function onRepoCallback(st, cb, h) {
  const { action, arg, lang, ack, edit, project } = h;
  if (!project) return ack(t('state.projectGone', lang));
  try {
    const repo = await h.repoOf(st, project);
    if (!repo) return (await ack(), edit({ text: th('git.noRepo', lang), markup: { inline_keyboard: [[{ text: t('btn.back', lang), callback_data: 'gt:v' }]] } }));
    const opts = h.gitOpts(st, project, repo);
    if (action === 'ch') return (await ack(), edit(await changesView(st, project, repo, opts, Number(arg) || 0, lang)));
    if (action === 'cm') return (await ack(), edit(await commitsView(project, opts, arg, lang)));
    if (action === 'cf') {
      // кнопка помнит путь файла; сам файл ищется в свежем списке изменений
      const path = recall(st, arg)?.path;
      const file = path ? (await changedFiles(project, opts)).files.find((f) => f.path === path) : null;
      if (!file) return ack(t('git.diff.gone', lang));
      await ack();
      return await showDiff(st, project, file, arg, opts, lang, edit);
    }
    if (action === 'br') return (await ack(), edit(await branchesView(st, project, repo, opts, Number(arg) || 0, lang, { sync: true })));
    // ---- переключение и создание ветки меняют проект ----
    if (!canManageFiles(st.userId)) return ack(t('files.noRights', lang));
    if (st.gitBusy) return ack(t('git.busy', lang));
    if (st.busy) return ack(t('git.agentBusy', lang));
    if (action === 'bn') {
      await ack();
      st.pendingInput = { kind: 'gitBranch', at: Date.now() };
      return say(st.to, th('git.br.nameAsk', lang, { branch: hCode(repo.state.branch ?? '—') }), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] } });
    }
    // ---- отмена изменений: необратимо, поэтому сначала вопрос, а список файлов берётся заново ----
    if (['dx', 'dX', 'da', 'dA'].includes(action)) {
      const fresh = (await changedFiles(project, opts)).files;
      const run = async (list) => {
        st.gitBusy = true;
        try {
          return await discardFiles(project, list, opts);
        } finally {
          st.gitBusy = false;
        }
      };
      const show = async (note) => {
        const v = await changesView(st, project, await h.repoOf(st, project), opts, 0, lang);
        return edit({ text: `${note}\n\n${v.text}`, markup: v.markup });
      };
      if (action === 'dx' || action === 'dX') {
        const path = recall(st, arg)?.path;
        const file = path ? fresh.find((f) => f.path === path) : null;
        if (!file) return ack(t('git.diff.gone', lang));
        if (isSecretFile(file)) return ack(t('git.dx.secret', lang));
        await ack();
        if (action === 'dx') {
          const markup = { inline_keyboard: [[{ text: t('git.dx.yes', lang), callback_data: `gt:dX:${arg}` }, { text: t('btn.cancel', lang), callback_data: `gt:cf:${arg}` }]] };
          return edit({ text: th(file.kind === 'new' ? 'git.dx.askNew' : 'git.dx.ask', lang, { path: hCode(file.path) }), markup });
        }
        await run([file]);
        log('git: изменения файла отменены:', st.userId, project, file.path);
        return show(th('git.dx.done', lang, { path: hCode(file.path) }));
      }
      const list = fresh.filter((f) => !isSecretFile(f));
      if (!list.length) return ack(t('git.ch.none', lang));
      await ack();
      if (action === 'da') {
        const markup = { inline_keyboard: [[{ text: t('git.da.yes', lang), callback_data: 'gt:dA' }, { text: t('btn.cancel', lang), callback_data: 'gt:ch:0' }]] };
        const names = list.slice(0, 15).map((f) => `${MARK[f.kind] ?? '✏️'} ${escHtml(f.path)}`).join('\n') + (list.length > 15 ? '\n…' : '');
        return edit({ text: `${th('git.da.ask', lang, { n: list.length })}\n\n${names}`, markup });
      }
      const n = await run(list);
      log('git: все изменения отменены:', st.userId, project, '| файлов', n);
      return show(th('git.da.done', lang, { n }));
    }
    // кнопка помнит название ветки; сама ветка ищется в свежем списке
    const name = recall(st, arg)?.branch;
    const branch = name ? (await listBranches(project, opts)).branches.find((b) => b.name === name) : null;
    if (!branch) return ack(t('proj.stale', lang));
    if (branch.current) return ack(t('git.br.same', lang));
    // несохранённые изменения git либо не даст унести, либо молча перенесёт в другую ветку — сначала их нужно сохранить
    if (repo.state.changed) {
      await ack();
      const markup = { inline_keyboard: [[{ text: t('git.save', lang), callback_data: 'gt:save' }], [{ text: t('btn.back', lang), callback_data: 'gt:br:0' }]] };
      return edit({ text: th('git.br.dirty', lang, { n: repo.state.changed, name: hCode(branch.name) }), markup });
    }
    await ack();
    st.gitBusy = true;
    try {
      await switchBranch(project, branch, opts);
    } finally {
      st.gitBusy = false;
    }
    // файлы проекта сменились целиком: сессия агента с прежним представлением о них продолжаться не должна
    endAgent(st, 'branch');
    log('git: ветка переключена:', st.userId, project, '→', branch.name);
    const v = await branchesView(st, project, repo, opts, 0, lang);
    return edit({ text: `${th('git.br.switched', lang, { name: hCode(branch.name) })}\n\n${v.text}`, markup: v.markup });
  } catch (e) {
    log(`git: ${action}:`, e.message, '| пользователь', st.userId);
    await ack();
    return edit({ text: failText(e, lang), markup: { inline_keyboard: [[{ text: t('btn.back', lang), callback_data: 'gt:v' }]] } });
  }
}

/**
 * Название новой ветки от пользователя (после кнопки «Новая ветка»): создаёт ветку от текущей и переключается на неё.
 * Несохранённые изменения остаются в рабочей папке, сессия агента продолжается — файлы те же.
 * @param {object} h {wait, now, lang, project, repoOf, gitOpts}
 * @returns {Promise<boolean>} true — текст обработан здесь
 */
export async function onBranchInput(st, text, h) {
  const { lang, project } = h;
  const html = { parse_mode: 'HTML' };
  if (!project || !canManageFiles(st.userId)) return false;
  if (st.gitBusy || st.busy) return (await say(st.to, t(st.busy ? 'git.agentBusy' : 'git.busy', lang)), true);
  try {
    const repo = await h.repoOf(st, project);
    if (!repo) return (await say(st.to, th('git.noRepo', lang), html), true);
    const opts = h.gitOpts(st, project, repo);
    const name = await branchName(text, { cwd: project, ...opts });
    if (!name) {
      st.pendingInput = { ...h.wait, at: h.now }; // название не подошло — ждём другое
      return (await say(st.to, t('git.br.badName', lang), { reply_markup: { inline_keyboard: [[{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] } }), true);
    }
    await createBranch(project, name, opts);
    log('git: ветка создана:', st.userId, project, name);
    const markup = { inline_keyboard: [[{ text: t('git.branchesBtn', lang), callback_data: 'gt:br:0' }, { text: t('btn.back', lang), callback_data: 'gt:v' }]] };
    await say(st.to, th('git.br.created', lang, { name: hCode(name) }), { ...html, reply_markup: markup });
  } catch (e) {
    log('git: новая ветка:', e.message, '| пользователь', st.userId);
    await say(st.to, failText(e, lang), html);
  }
  return true;
}

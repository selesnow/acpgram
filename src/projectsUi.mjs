// Команда /project: выбор проекта (рабочей папки агента) кнопками или поиском по названию.
import { dirname, join } from 'node:path';
import { botInfo, db, langOf, log, say, who } from './ctx.mjs';
import { ROOT, USER_WORKSPACES, canGoUp, createDir, findDirs, folderName, insideRoot, isPersonalRoot, listDirs, navStart, resolveAsPath, samePath, showPath } from './projects.mjs';
import { gitAvailable } from './git.mjs';
import { errText, t } from './i18n.mjs';
import { clearPendingInput, isPendingExpired, pendingKindMatches, setPendingInput } from './pendingInput.mjs';
import { endAgent, errorRootOf, isAdmin, recentProjects, rootOf, saveProject, topicsOn } from './state.mjs';
import { topicLink } from './topics.mjs';
import { newTopic } from './topicsUi.mjs';
import { dest, tg } from './telegram.mjs';
import { hCode, hRaw, th } from './ui.mjs';
import { pageInfo, pageNav, pagesOf } from './pagination.mjs';
import { btnText, cancelRow, cbCtx, fmtDate } from './uiActions.mjs';
import { createKeyRegistry } from './keyRegistry.mjs';

const PAGE = 20;
const HTML = { parse_mode: 'HTML' };
/** Имя папки не длиннее этого помещается в кнопку половинной ширины целиком. */
const SHORT_NAME = 16;

/**
 * Раскладка кнопок папок: две короткие подряд — в один ряд, длинная — на всю ширину (имя должно читаться целиком,
 * по нему выбирают). Порядок папок сохраняется.
 * @param {string[]} names имена папок по порядку
 * @param {(name: string) => string} [labelOf] подпись кнопки, если она отличается от имени (ширина считается по ней)
 * @returns {string[][]} ряды имён
 */
export function folderRows(names, labelOf = (n) => n) {
  const short = (n) => [...labelOf(n)].length <= SHORT_NAME;
  const rows = [];
  for (let i = 0; i < names.length; i++) {
    if (short(names[i]) && i + 1 < names.length && short(names[i + 1])) rows.push([names[i], names[++i]]);
    else rows.push([names[i]]);
  }
  return rows;
}

const pathKeys = createKeyRegistry({ scope: 'global', limit: 3000, eviction: 'clear', stable: true });
const tok = (p) => pathKeys.add(p);

/** Токен пути для кнопок других экранов (/files). Путь из токена обязан проверять тот, кто его использует. */
export const pathToken = tok;
/** Путь по токену из кнопки или undefined, если кнопка устарела. */
export const tokenPath = (tk) => pathKeys.get(Number(tk));

/** Путь для показа пользователю диалога: относительно его корня (личное пространство — без пути на сервере). */
const pathFor = (st, p, lang) => showPath(p, lang, rootOf(st.userId));

/**
 * Может ли пользователь создавать папки проектов кнопкой «Новый проект»: администратор — везде, сотрудник — только
 * в личном пространстве (в общем корне папки заводит администратор).
 */
export const canCreateProject = (userId) => isAdmin(userId) || isPersonalRoot(rootOf(userId));

/**
 * Подпись папки в навигации. Администратору в корне проектов личные папки сотрудников (имя — Telegram ID)
 * показываются с именем сотрудника: «123456 · @nick».
 */
function folderLabel(st, dir, name) {
  if (!USER_WORKSPACES || !isAdmin(st.userId) || !samePath(dir, ROOT) || !/^\d+$/.test(name)) return name;
  const u = db.getUser(Number(name));
  return u ? `${name} · ${who(u)}` : name;
}

/** Текст экрана навигации (HTML): открытая папка и текущий проект — моноширинным, чтобы путь читался и копировался. */
const navText = (st, dir, lang) =>
  `${th('proj.nav', lang, { dir: hCode(pathFor(st, dir, lang)), cur: hCode(pathFor(st, st.project, lang)) })}${listDirs(dir).length ? '' : `\n\n<i>${th('proj.noSub', lang)}</i>`}`;

/** recent — недавние проекты: кнопки «🕘» в начале списка (только на первом экране /project). */
function navKeyboard(st, dir, page = 0, recent = [], lang) {
  const root = rootOf(st.userId);
  const label = (n) => folderLabel(st, dir, n);
  const kids = listDirs(dir);
  const { page: current, pages } = pageInfo(kids.length, PAGE, page);
  const rows = [
    // обрезка по символам, а не по UTF-16: половинка эмодзи — невалидный UTF-8, Telegram отклонил бы всё сообщение
    ...recent.map((p) => [{ text: btnText(`🕘 ${pathFor(st, p, lang)}`, 120), callback_data: `nav:s:${tok(p)}` }]),
    ...folderRows(kids.slice(current * PAGE, (current + 1) * PAGE), label).map((row) => row.map((n) => ({ text: `📁 ${label(n)}`, callback_data: `nav:o:${tok(join(dir, n))}:0` }))),
  ];
  rows.push(...pageNav(current, pages, (p) => `nav:o:${tok(dir)}:${p}`));
  const ctl = [];
  if (canGoUp(dir, root)) ctl.push({ text: t('proj.up', lang), callback_data: `nav:o:${tok(dirname(dir))}:0` });
  ctl.push({ text: t('proj.choose', lang), callback_data: `nav:s:${tok(dir)}`, style: 'success' });
  rows.push(ctl);
  if (canCreateProject(st.userId)) {
    rows.push([
      { text: t('proj.new', lang), callback_data: `nav:c:${tok(dir)}` },
      // клонирование — экран /git (gitUi): нужен подключённый аккаунт, без него кнопка подскажет его подключить
      ...(gitAvailable() ? [{ text: t('git.cloneShort', lang), callback_data: 'gt:cl' }] : []),
    ]);
  }
  return { inline_keyboard: rows };
}

/** Переключает проект: закрывает текущую сессию агента пользователя, новая начнётся с ближайшим запросом. */
export async function selectProject(st, p, messageId) {
  const chatId = st.chatId;
  const lang = langOf(st.userId);
  const reply = (text) =>
    messageId
      ? tg('editMessageText', { chat_id: chatId, message_id: messageId, text, ...HTML, reply_markup: { inline_keyboard: [] } }).catch(() => say(st.to, text, HTML))
      : say(st.to, text, HTML);
  const root = rootOf(st.userId);
  const real = insideRoot(p, root);
  // сотруднику с личным пространством путь корня на сервере не показываем
  if (!real) return reply(!root ? th('proj.notFound', lang) : isPersonalRoot(root) ? th('proj.unavailableMine', lang) : th('proj.unavailableRoot', lang, { root: hCode(root) }));
  if (topicsOn(st.userId)) {
    // режим «диалоги»: тема закреплена за своим проектом — в теме выбор проекта только показывает его темы
    // и предлагает новый диалог в нём; в General проект переключается, как раньше, и показываются темы проекта
    if (!st.topic && !samePath(real, st.project)) {
      if (st.busy) return reply(th('busy.stop', lang));
      saveProject(st, real);
      endAgent(st, 'project');
      log('проект переключён:', st.userId, real);
    }
    return showProjectTopics(st, real, { messageId });
  }
  if (st.busy) return reply(th('busy.stop', lang));
  if (samePath(real, st.project)) return reply(th('proj.same', lang, { p: hCode(pathFor(st, real, lang)) }));
  saveProject(st, real);
  endAgent(st, 'project');
  log('проект переключён:', st.userId, real);
  return reply(th('proj.set', lang, { p: hCode(pathFor(st, real, lang)) }));
}

export async function handleProject(st, arg) {
  const lang = langOf(st.userId);
  const q = (arg || '').trim();
  const root = rootOf(st.userId);
  if (!q) {
    // проект мог оказаться недоступным (папку удалили, на её месте ссылка) — тогда навигация начинается с корня
    const from = navStart(st.project, root);
    const start = insideRoot(from, root) ?? root ?? from;
    const recent = recentProjects(st);
    const text = navText(st, start, lang) + (recent.length ? `\n\n<i>${th('proj.recentLegend', lang)}</i>` : '');
    return tg('sendMessage', { ...dest(st.to), text, ...HTML, reply_markup: navKeyboard(st, start, 0, recent, lang) }).catch((e) => log('project:', e.message));
  }
  const direct = resolveAsPath(q, root); // запрос может быть путём: абсолютным, «~/…» или от корня (без корня — от домашней папки)
  if (direct) return selectProject(st, direct);
  const { results, truncated } = await findDirs(q, root ? { base: root } : {});
  if (!results.length) return say(st.to, th('proj.none', lang, { q }), HTML);
  if (results.length === 1) return selectProject(st, results[0]);
  const note = hRaw(truncated ? `\n<i>${th('proj.moreResults', lang)}</i>` : '');
  return tg('sendMessage', {
    ...dest(st.to),
    text: th('proj.found', lang, { n: results.length, note }),
    ...HTML,
    reply_markup: { inline_keyboard: results.map((r) => [{ text: `📁 ${pathFor(st, r, lang)}`, callback_data: `nav:s:${tok(r)}` }]) },
  }).catch((e) => log('project:', e.message));
}

export async function onNavCallback(st, cb) {
  const [, action, tokStr, pageStr] = cb.data.split(':');
  const lang = langOf(st.userId);
  const { ack, edit: editQuiet, messageId } = cbCtx({ chatId: cb.message?.chat?.id }, cb, { html: true, alert: true });
  const { edit: editNav } = cbCtx({ chatId: cb.message?.chat?.id }, cb, { html: true, label: 'nav:' });
  if (action === 'n') return ack();
  if (action === 'x') {
    // «Отмена» под просьбой прислать название нового проекта
    clearPendingInput(st);
    await ack();
    return editQuiet({ text: th('proj.newCancelled', lang) });
  }
  // токены путей общие для всех пользователей, поэтому путь из кнопки каждый раз проверяется по корню нажавшего
  const root = rootOf(st.userId);
  const p = tokenPath(tokStr);
  if (!p) return ack(t('proj.stale', lang));
  if (action === 'o') {
    const dir = insideRoot(p, root);
    if (!dir) return ack(t('proj.noFolder', lang));
    await ack();
    return editNav({ text: navText(st, dir, lang), markup: navKeyboard(st, dir, Number(pageStr) || 0, [], lang) });
  }
  if (action === 'c') {
    const dir = canCreateProject(st.userId) ? insideRoot(p, root) : null;
    if (!dir) return ack(t('proj.noFolder', lang));
    if (st.busy) return ack(t('busy.stop', lang));
    await ack();
    setPendingInput(st, 'newProject', { dir });
    return say(st.to, th('proj.newAsk', lang, { dir: hCode(pathFor(st, dir, lang)) }), { ...HTML, reply_markup: cancelRow('nav', lang) });
  }
  if (action === 's') {
    if (st.busy) return ack(t('busy.stop', lang));
    await ack();
    return selectProject(st, p, messageId);
  }
}

// ---- новый проект: кнопка «Новый проект» → бот ждёт название папки следующим сообщением ----

/** Сколько бот ждёт название папки нового проекта; позже текст снова считается запросом агенту. */
export { NEW_PROJECT_WAIT_MS } from './pendingInput.mjs';

/**
 * Текст пользователя, когда бот ждёт название папки нового проекта (st.pendingInput): создаёт папку и выбирает её
 * проектом. Имя не подходит — просит другое, ожидание остаётся.
 * @returns {Promise<boolean>} true — текст был названием (агенту его не отправляем)
 */
export async function onProjectNameInput(st, text, now = Date.now()) {
  const wait = st.pendingInput;
  if (!pendingKindMatches(wait, 'newProject')) return false;
  if (isPendingExpired(wait, now)) {
    clearPendingInput(st);
    return false;
  }
  const lang = langOf(st.userId);
  if (!folderName(text)) {
    await say(st.to, th('proj.newBad', lang), { ...HTML, reply_markup: cancelRow('nav', lang) });
    return true;
  }
  clearPendingInput(st);
  let dir;
  try {
    // право и место проверяются заново: за время ожидания они могли измениться
    dir = canCreateProject(st.userId) ? createDir(wait.dir, text, rootOf(st.userId)) : null;
  } catch (e) {
    log('создание папки проекта:', e.message, '| пользователь', st.userId);
    await say(st.to, th('proj.newFail', lang, { msg: errText(e, lang, errorRootOf(st.userId)) }), HTML);
    return true;
  }
  if (!dir) {
    await say(st.to, th('proj.noFolder', lang), HTML);
    return true;
  }
  log('папка проекта создана:', st.userId, dir);
  await selectProject(st, dir);
  return true;
}

// ---- темы проекта (режим «диалоги»): список с кнопками-ссылками на темы, новый диалог в проекте, уборка списка ----

const TOPICS_PAGE = 10;

/**
 * Темы пользователя в проекте: кнопки, открывающие тему (последние по активности, по TOPICS_PAGE на страницу),
 * «➕ Новый диалог в этом проекте» и «🧹 Убрать лишние». cleanup — режим уборки: у тем кнопки «✖» (убрать из списка).
 * В General — после выбора проекта (General переключён на него); в теме — тема остаётся в своём проекте. Текст — HTML.
 */
export function projectTopicsView(st, project, { page = 0, cleanup = false } = {}) {
  const lang = langOf(st.userId);
  const p = tok(project);
  const { items, total } = db.listTopics(st.userId, project, TOPICS_PAGE, page * TOPICS_PAGE);
  const pages = pagesOf(total, TOPICS_PAGE);
  const head = th(st.topic ? 'tpl.headTopic' : 'tpl.headGeneral', lang, { p: hCode(pathFor(st, project, lang)) });
  const body = !total ? th('tpl.none', lang) : cleanup ? th('tpl.cleanupHint', lang) : th('tpl.list', lang, { n: total });
  const label = (x) => btnText(`${x.name || t('tpl.unnamed', lang)} · ${fmtDate(x.updated_at, lang, { year: false })}`);
  const rows = items.map((x) => {
    if (cleanup) return [{ text: `✖ ${label(x)}`, callback_data: `tpl:h:${p}:${x.thread_id}:${page}` }];
    const url = topicLink(botInfo.username, x.thread_id);
    return [url ? { text: label(x), url } : { text: label(x), callback_data: 'nav:n' }];
  });
  const mode = cleanup ? 'c' : 'p';
  rows.push(...pageNav(page, pages, (n) => `tpl:${mode}:${p}:${n}`));
  if (cleanup) rows.push([{ text: t('tpl.done', lang), callback_data: `tpl:p:${p}:0` }]);
  else {
    rows.push([{ text: t('tpl.new', lang), callback_data: `tpl:n:${p}`, style: 'success' }]);
    if (total) rows.push([{ text: t('tpl.cleanup', lang), callback_data: `tpl:c:${p}:0` }]);
  }
  return { text: `${head}\n\n${body}`, markup: { inline_keyboard: rows } };
}

/** Показывает темы проекта: новым сообщением или вместо сообщения с выбором проекта (messageId). */
function showProjectTopics(st, project, { messageId } = {}) {
  const v = projectTopicsView(st, project);
  if (!messageId) return say(st.to, v.text, { ...HTML, reply_markup: v.markup });
  const { edit } = cbCtx(st, { message: { chat: { id: st.chatId }, message_id: messageId } }, {
    html: true,
    fallback: (text, markup, view) => say(st.to, text, { ...HTML, reply_markup: view?.markup ?? markup }),
  });
  return edit(v);
}

/** Кнопки списка тем: tpl:p (страница), tpl:c (уборка), tpl:h (убрать тему из списка), tpl:n (новый диалог в проекте). */
export async function onTopicListCallback(st, cb) {
  const [, action, tokStr, a3, a4] = (cb.data || '').split(':');
  const lang = langOf(st.userId);
  const { ack, edit } = cbCtx(st, cb, { html: true, label: 'темы проекта:' });
  // путь из кнопки проверяется по корню нажавшего: токены путей общие для всех пользователей
  const known = tokenPath(tokStr);
  const project = known ? insideRoot(known, rootOf(st.userId)) : null;
  if (!project) return ack(t('proj.stale', lang));
  if (action === 'n') {
    await ack();
    return newTopic(st, { project });
  }
  if (action === 'h') {
    db.saveTopic(st.userId, Number(a3), { hidden: true });
    await ack(t('tpl.hidden', lang));
    return edit(projectTopicsView(st, project, { page: Number(a4) || 0, cleanup: true }));
  }
  await ack();
  return edit(projectTopicsView(st, project, { page: Number(a3) || 0, cleanup: action === 'c' }));
}

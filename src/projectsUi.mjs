// Команда /project: выбор проекта (рабочей папки агента) кнопками или поиском по названию.
import { dirname, join } from 'node:path';
import { botInfo, db, langOf, log, say } from './ctx.mjs';
import { ROOT, canGoUp, findDirs, insideRoot, listDirs, navStart, resolveAsPath, samePath, showPath } from './projects.mjs';
import { LOCALES, t } from './i18n.mjs';
import { endAgent, recentProjects, saveProject, topicsOn } from './state.mjs';
import { topicLink } from './topics.mjs';
import { newTopic } from './topicsUi.mjs';
import { dest, tg } from './telegram.mjs';
import { hCode, hRaw, th } from './ui.mjs';

const PAGE = 20;
const HTML = { parse_mode: 'HTML' };
/** Имя папки не длиннее этого помещается в кнопку половинной ширины целиком. */
const SHORT_NAME = 16;

/**
 * Раскладка кнопок папок: две короткие подряд — в один ряд, длинная — на всю ширину (имя должно читаться целиком,
 * по нему выбирают). Порядок папок сохраняется.
 * @param {string[]} names имена папок по порядку
 * @returns {string[][]} ряды имён
 */
export function folderRows(names) {
  const short = (n) => [...n].length <= SHORT_NAME;
  const rows = [];
  for (let i = 0; i < names.length; i++) {
    if (short(names[i]) && i + 1 < names.length && short(names[i + 1])) rows.push([names[i], names[++i]]);
    else rows.push([names[i]]);
  }
  return rows;
}

// callback_data в Telegram ограничена 64 байтами, поэтому пути в кнопках заменены числовыми токенами
let tokSeq = 0;
const tokByPath = new Map();
const pathByTok = new Map();
function tok(p) {
  let tk = tokByPath.get(p);
  if (tk === undefined) {
    if (pathByTok.size > 3000) {
      tokByPath.clear();
      pathByTok.clear(); // старые кнопки станут «устаревшими», а не укажут на чужую папку: счётчик не сбрасывается
    }
    tk = ++tokSeq;
    tokByPath.set(p, tk);
    pathByTok.set(tk, p);
  }
  return tk;
}

/** Текст экрана навигации (HTML): открытая папка и текущий проект — моноширинным, чтобы путь читался и копировался. */
const navText = (st, dir, lang) =>
  `${th('proj.nav', lang, { dir: hCode(showPath(dir, lang)), cur: hCode(showPath(st.project, lang)) })}${listDirs(dir).length ? '' : `\n\n<i>${th('proj.noSub', lang)}</i>`}`;

/** recent — недавние проекты: кнопки «🕘» в начале списка (только на первом экране /project). */
function navKeyboard(dir, page = 0, recent = [], lang) {
  const kids = listDirs(dir);
  const pages = Math.max(1, Math.ceil(kids.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const rows = [
    // обрезка по символам, а не по UTF-16: половинка эмодзи — невалидный UTF-8, Telegram отклонил бы всё сообщение
    ...recent.map((p) => [{ text: [...`🕘 ${showPath(p, lang)}`].slice(0, 120).join(''), callback_data: `nav:s:${tok(p)}` }]),
    ...folderRows(kids.slice(page * PAGE, (page + 1) * PAGE)).map((row) => row.map((n) => ({ text: `📁 ${n}`, callback_data: `nav:o:${tok(join(dir, n))}:0` }))),
  ];
  if (pages > 1) {
    const r = [];
    if (page > 0) r.push({ text: '◀', callback_data: `nav:o:${tok(dir)}:${page - 1}` });
    r.push({ text: `${page + 1}/${pages}`, callback_data: 'nav:n' });
    if (page < pages - 1) r.push({ text: '▶', callback_data: `nav:o:${tok(dir)}:${page + 1}` });
    rows.push(r);
  }
  const ctl = [];
  if (canGoUp(dir)) ctl.push({ text: t('proj.up', lang), callback_data: `nav:o:${tok(dirname(dir))}:0` });
  ctl.push({ text: t('proj.choose', lang), callback_data: `nav:s:${tok(dir)}`, style: 'success' });
  rows.push(ctl);
  return { inline_keyboard: rows };
}

/** Переключает проект: закрывает текущую сессию агента пользователя, новая начнётся с ближайшим запросом. */
async function selectProject(st, p, messageId) {
  const chatId = st.chatId;
  const lang = langOf(st.userId);
  const reply = (text) =>
    messageId
      ? tg('editMessageText', { chat_id: chatId, message_id: messageId, text, ...HTML, reply_markup: { inline_keyboard: [] } }).catch(() => say(st.to, text, HTML))
      : say(st.to, text, HTML);
  const real = insideRoot(p);
  if (!real) return reply(ROOT ? th('proj.unavailableRoot', lang, { root: hCode(ROOT) }) : th('proj.notFound', lang));
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
  if (samePath(real, st.project)) return reply(th('proj.same', lang, { p: hCode(showPath(real, lang)) }));
  saveProject(st, real);
  endAgent(st, 'project');
  log('проект переключён:', st.userId, real);
  return reply(th('proj.set', lang, { p: hCode(showPath(real, lang)) }));
}

export async function handleProject(st, arg) {
  const lang = langOf(st.userId);
  const q = (arg || '').trim();
  if (!q) {
    const start = navStart(st.project);
    const recent = recentProjects(st);
    const text = navText(st, start, lang) + (recent.length ? `\n\n<i>${th('proj.recentLegend', lang)}</i>` : '');
    return tg('sendMessage', { ...dest(st.to), text, ...HTML, reply_markup: navKeyboard(start, 0, recent, lang) }).catch((e) => log('project:', e.message));
  }
  const direct = resolveAsPath(q); // запрос может быть путём: абсолютным, «~/…» или от корня (без корня — от домашней папки)
  if (direct) return selectProject(st, direct);
  const { results, truncated } = await findDirs(q);
  if (!results.length) return say(st.to, th('proj.none', lang, { q }), HTML);
  if (results.length === 1) return selectProject(st, results[0]);
  const note = hRaw(truncated ? `\n<i>${th('proj.moreResults', lang)}</i>` : '');
  return tg('sendMessage', {
    ...dest(st.to),
    text: th('proj.found', lang, { n: results.length, note }),
    ...HTML,
    reply_markup: { inline_keyboard: results.map((r) => [{ text: `📁 ${showPath(r, lang)}`, callback_data: `nav:s:${tok(r)}` }]) },
  }).catch((e) => log('project:', e.message));
}

export async function onNavCallback(st, cb) {
  const [, action, tokStr, pageStr] = cb.data.split(':');
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  const lang = langOf(st.userId);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
  if (action === 'n') return ack();
  const p = pathByTok.get(Number(tokStr));
  if (!p) return ack(t('proj.stale', lang));
  if (action === 'o') {
    const dir = insideRoot(p);
    if (!dir) return ack(t('proj.noFolder', lang));
    await ack();
    return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: navText(st, dir, lang), ...HTML, reply_markup: navKeyboard(dir, Number(pageStr) || 0, [], lang) }).catch((e) => log('nav:', e.message));
  }
  if (action === 's') {
    if (st.busy) return ack(t('busy.stop', lang));
    await ack();
    return selectProject(st, p, messageId);
  }
}

// ---- темы проекта (режим «диалоги»): список с кнопками-ссылками на темы, новый диалог в проекте, уборка списка ----

const TOPICS_PAGE = 10;

/** Дата последней активности темы на кнопке: «12.11». */
const shortDate = (iso, lang) => new Date(iso).toLocaleDateString(LOCALES[lang] ?? LOCALES.en, { day: '2-digit', month: '2-digit' });

/**
 * Темы пользователя в проекте: кнопки, открывающие тему (последние по активности, по TOPICS_PAGE на страницу),
 * «➕ Новый диалог в этом проекте» и «🧹 Убрать лишние». cleanup — режим уборки: у тем кнопки «✖» (убрать из списка).
 * В General — после выбора проекта (General переключён на него); в теме — тема остаётся в своём проекте. Текст — HTML.
 */
export function projectTopicsView(st, project, { page = 0, cleanup = false } = {}) {
  const lang = langOf(st.userId);
  const p = tok(project);
  const { items, total } = db.listTopics(st.userId, project, TOPICS_PAGE, page * TOPICS_PAGE);
  const pages = Math.max(1, Math.ceil(total / TOPICS_PAGE));
  const head = th(st.topic ? 'tpl.headTopic' : 'tpl.headGeneral', lang, { p: hCode(showPath(project, lang)) });
  const body = !total ? th('tpl.none', lang) : cleanup ? th('tpl.cleanupHint', lang) : th('tpl.list', lang, { n: total });
  const label = (x) => [...`${x.name || t('tpl.unnamed', lang)} · ${shortDate(x.updated_at, lang)}`].slice(0, 60).join('');
  const rows = items.map((x) => {
    if (cleanup) return [{ text: `✖ ${label(x)}`, callback_data: `tpl:h:${p}:${x.thread_id}:${page}` }];
    const url = topicLink(botInfo.username, x.thread_id);
    return [url ? { text: label(x), url } : { text: label(x), callback_data: 'nav:n' }];
  });
  if (pages > 1) {
    const mode = cleanup ? 'c' : 'p';
    const nav = [];
    if (page > 0) nav.push({ text: '◀', callback_data: `tpl:${mode}:${p}:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'nav:n' });
    if (page < pages - 1) nav.push({ text: '▶', callback_data: `tpl:${mode}:${p}:${page + 1}` });
    rows.push(nav);
  }
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
  return messageId
    ? tg('editMessageText', { chat_id: st.chatId, message_id: messageId, text: v.text, ...HTML, reply_markup: v.markup }).catch(() => say(st.to, v.text, { ...HTML, reply_markup: v.markup }))
    : say(st.to, v.text, { ...HTML, reply_markup: v.markup });
}

/** Кнопки списка тем: tpl:p (страница), tpl:c (уборка), tpl:h (убрать тему из списка), tpl:n (новый диалог в проекте). */
export async function onTopicListCallback(st, cb) {
  const [, action, tokStr, a3, a4] = (cb.data || '').split(':');
  const lang = langOf(st.userId);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const project = pathByTok.get(Number(tokStr));
  if (!project) return ack(t('proj.stale', lang));
  const edit = (v) => tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text: v.text, ...HTML, reply_markup: v.markup }).catch((e) => log('темы проекта:', e.message));
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

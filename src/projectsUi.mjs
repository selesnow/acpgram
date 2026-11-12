// Команда /project: выбор проекта (рабочей папки агента) кнопками или поиском по названию.
import { dirname, join } from 'node:path';
import { db, langOf, log, say } from './ctx.mjs';
import { ROOT, canGoUp, findDirs, insideRoot, listDirs, navStart, resolveAsPath, samePath, showPath } from './projects.mjs';
import { t } from './i18n.mjs';
import { endAgent, recentProjects, saveProject } from './state.mjs';
import { tg } from './telegram.mjs';

const PAGE = 20;

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

const navText = (st, dir, lang) => `${t('proj.nav', lang, { dir: showPath(dir, lang), cur: showPath(st.project, lang) })}${listDirs(dir).length ? '' : `\n${t('proj.noSub', lang)}`}`;

/** recent — недавние проекты: кнопки «🕘» в начале списка (только на первом экране /project). */
function navKeyboard(dir, page = 0, recent = [], lang) {
  const kids = listDirs(dir);
  const pages = Math.max(1, Math.ceil(kids.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const rows = [
    // обрезка по символам, а не по UTF-16: половинка эмодзи — невалидный UTF-8, Telegram отклонил бы всё сообщение
    ...recent.map((p) => [{ text: [...`🕘 ${showPath(p, lang)}`].slice(0, 120).join(''), callback_data: `nav:s:${tok(p)}` }]),
    ...kids.slice(page * PAGE, (page + 1) * PAGE).map((n) => [{ text: `📁 ${n}`, callback_data: `nav:o:${tok(join(dir, n))}:0` }]),
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
  ctl.push({ text: t('proj.choose', lang), callback_data: `nav:s:${tok(dir)}` });
  rows.push(ctl);
  return { inline_keyboard: rows };
}

/** Переключает проект: закрывает текущую сессию агента пользователя, новая начнётся с ближайшим запросом. */
async function selectProject(st, p, messageId) {
  const chatId = st.chatId;
  const lang = langOf(st.userId);
  const reply = (text) =>
    messageId
      ? tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(chatId, text))
      : say(chatId, text);
  const real = insideRoot(p);
  if (!real) return reply(ROOT ? t('proj.unavailableRoot', lang, { root: ROOT }) : t('proj.notFound', lang));
  if (st.busy) return reply(t('busy.stop', lang));
  if (samePath(real, st.project)) return reply(t('proj.same', lang, { p: showPath(real, lang) }));
  saveProject(st, real);
  endAgent(st, 'project');
  log('проект переключён:', st.userId, real);
  return reply(t('proj.set', lang, { p: showPath(real, lang) }));
}

export async function handleProject(st, arg) {
  const chatId = st.chatId;
  const lang = langOf(st.userId);
  const q = (arg || '').trim();
  if (!q) {
    const start = navStart(st.project);
    const recent = recentProjects(st);
    const text = navText(st, start, lang) + (recent.length ? `\n${t('proj.recentLegend', lang)}` : '');
    return tg('sendMessage', { chat_id: chatId, text, reply_markup: navKeyboard(start, 0, recent, lang) }).catch((e) => log('project:', e.message));
  }
  const direct = resolveAsPath(q); // запрос может быть путём: абсолютным, «~/…» или от корня (без корня — от домашней папки)
  if (direct) return selectProject(st, direct);
  const { results, truncated } = findDirs(q);
  if (!results.length) return say(chatId, t('proj.none', lang, { q }));
  if (results.length === 1) return selectProject(st, results[0]);
  const note = truncated ? `\n${t('proj.moreResults', lang)}` : '';
  return tg('sendMessage', {
    chat_id: chatId,
    text: t('proj.found', lang, { n: results.length, note }),
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
    return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: navText(st, dir, lang), reply_markup: navKeyboard(dir, Number(pageStr) || 0, [], lang) }).catch((e) => log('nav:', e.message));
  }
  if (action === 's') {
    if (st.busy) return ack(t('busy.stop', lang));
    await ack();
    return selectProject(st, p, messageId);
  }
}

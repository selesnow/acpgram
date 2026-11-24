// Команда /files: файлы проекта, которыми пользователь управляет сам, в обход агента — список, создание файла из
// сообщения, загрузка файла с устройства, удаление. Содержимое таких файлов не попадает в запрос к модели: так в проект
// кладут секреты (.env, ключи). Обычная отправка файла боту по-прежнему передаёт его агенту.
import { basename, dirname, join, relative, sep } from 'node:path';
import { db, langOf, log, say } from './ctx.mjs';
import { MAX_FILE_BYTES, describeAttachment, safeFileName } from './files.mjs';
import { LOCALES, errText, t } from './i18n.mjs';
import { FileError, deleteProjectFile, fmtSize, listProjectDir, projectFileInfo, relPath, resolveTarget, writeProjectFile } from './projectFiles.mjs';
import { insideRoot, isPersonalRoot, samePath } from './projects.mjs';
import { folderRows, pathToken, tokenPath } from './projectsUi.mjs';
import { errorRootOf, isAdmin, rootOf, userPath } from './state.mjs';
import { dest, downloadFile, tg } from './telegram.mjs';
import { hCode, th } from './ui.mjs';

const PAGE = 20;
const HTML = { parse_mode: 'HTML' };
/** Сколько бот ждёт имя файла или сам файл; позже сообщения снова уходят агенту. */
export const FILE_WAIT_MS = 10 * 60_000;
/** Содержимое файла одним сообщением: длиннее Telegram делит текст на части, и вторая ушла бы агенту. */
export const INLINE_MAX = 3500;
/** Сколько после слишком длинного содержимого бот не передаёт текст агенту (части разбитого сообщения). */
const SWALLOW_MS = 5000;
/** Альбом из нескольких файлов приходит отдельными сообщениями: все они относятся к одной загрузке. */
const ALBUM_MS = 60_000;

/**
 * Может ли пользователь сам класть и удалять файлы в проекте: администратор — всегда; сотрудник — в личном
 * пространстве, а в общем корне — если его уровень разрешает агенту менять файлы («Обычный», «Полный»).
 */
export const canManageFiles = (userId) => isAdmin(userId) || isPersonalRoot(rootOf(userId)) || ['normal', 'full'].includes(db.getUser(userId)?.level);

/** Папка проекта диалога, если она доступна (существует и лежит в корне пользователя), иначе null. */
const projectOf = (st) => insideRoot(st.project, rootOf(st.userId));

/** Путь внутри проекта для показа: «config/.env»; сама папка проекта — «/». */
const relShow = (project, path) => relative(project, path).split(sep).join('/') || '/';

const cancelMarkup = (lang) => ({ inline_keyboard: [[{ text: t('btn.cancel', lang), callback_data: 'fl:x' }]] });

/** Текст причины отказа (FileError.code) на языке пользователя. */
const whyText = (e, lang, userId) => (e instanceof FileError ? t(`files.err.${e.code}`, lang) : errText(e, lang, errorRootOf(userId)));

/** Удаляет сообщение пользователя с содержимым или файлом: в чате не должно оставаться копии секрета. */
const dropMessage = (st, messageId) => (messageId ? tg('deleteMessage', { chat_id: st.chatId, message_id: messageId }).catch((e) => log('files: сообщение не удалено:', e.message)) : null);

/** Экран папки проекта: папки, файлы с размером, «Вверх», «Создать файл» и «Загрузить файл». Текст — HTML. */
export async function filesView(st, project, dir, page = 0, lang = langOf(st.userId)) {
  const { dirs, files } = await listProjectDir(project, dir, { hideConfig: !canManageFiles(st.userId) });
  const entries = [...dirs.map((name) => ({ name, dir: true })), ...files];
  const pages = Math.max(1, Math.ceil(entries.length / PAGE));
  page = Math.min(Math.max(page, 0), pages - 1);
  const shown = entries.slice(page * PAGE, (page + 1) * PAGE);
  const rows = [
    ...folderRows(shown.filter((e) => e.dir).map((e) => e.name)).map((row) => row.map((n) => ({ text: `📁 ${n}`, callback_data: `fl:o:${pathToken(join(dir, n))}:0` }))),
    ...shown.filter((e) => !e.dir).map((f) => [{ text: [...`📄 ${f.name} · ${fmtSize(f.size)}`].slice(0, 60).join(''), callback_data: `fl:f:${pathToken(join(dir, f.name))}` }]),
  ];
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀', callback_data: `fl:o:${pathToken(dir)}:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'nav:n' });
    if (page < pages - 1) nav.push({ text: '▶', callback_data: `fl:o:${pathToken(dir)}:${page + 1}` });
    rows.push(nav);
  }
  if (!samePath(dir, project)) rows.push([{ text: t('proj.up', lang), callback_data: `fl:o:${pathToken(dirname(dir))}:0` }]);
  if (canManageFiles(st.userId)) {
    rows.push([
      { text: t('files.create', lang), callback_data: `fl:n:${pathToken(dir)}` },
      { text: t('files.upload', lang), callback_data: `fl:u:${pathToken(dir)}` },
    ]);
  }
  const head = th('files.head', lang, { p: hCode(userPath(st.userId, project, lang)), dir: hCode(relShow(project, dir)) });
  const body = entries.length ? th('files.hint', lang) : `<i>${th('files.empty', lang)}</i>\n\n${th('files.hint', lang)}`;
  return { text: `${head}\n\n${body}`, markup: { inline_keyboard: rows } };
}

/** /files — файлы текущего проекта. */
export async function handleFiles(st) {
  const lang = langOf(st.userId);
  const project = projectOf(st);
  if (!project) return say(st.to, t('state.projectGone', lang));
  const v = await filesView(st, project, project, 0, lang);
  return tg('sendMessage', { ...dest(st.to), text: v.text, ...HTML, reply_markup: v.markup }).catch((e) => log('files:', e.message));
}

/** Карточка файла: путь, размер, дата изменения, удаление. */
function fileCard(st, project, path, lang, { confirm = false } = {}) {
  const info = projectFileInfo(project, path);
  if (!info) return null;
  const when = new Date(info.mtime).toLocaleString(LOCALES[lang] ?? LOCALES.en, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tk = pathToken(path);
  const back = { text: t('files.back', lang), callback_data: `fl:o:${pathToken(dirname(path))}:0` };
  const rows = confirm
    ? [[{ text: t('files.deleteYes', lang), callback_data: `fl:D:${tk}` }, { text: t('btn.cancel', lang), callback_data: `fl:f:${tk}` }]]
    : [...(canManageFiles(st.userId) ? [[{ text: t('files.delete', lang), callback_data: `fl:d:${tk}` }]] : []), [back]];
  const text = th(confirm ? 'files.deleteAsk' : 'files.card', lang, { path: hCode(relShow(project, path)), size: fmtSize(info.size), when });
  return { text, markup: { inline_keyboard: rows } };
}

let replaceSeq = 0;

/** Спрашивает, заменить ли существующий файл; что именно писать — запоминается до ответа (st.replaces). */
function askReplace(st, project, job, lang) {
  st.replaces ??= new Map();
  if (st.replaces.size > 20) st.replaces.clear();
  const id = ++replaceSeq;
  st.replaces.set(id, job);
  const path = join(job.dir, ...job.parts);
  return say(st.to, th('files.existsAsk', lang, { path: hCode(relShow(project, path)) }), {
    ...HTML,
    reply_markup: { inline_keyboard: [[{ text: t('files.replace', lang), callback_data: `fl:r:${id}` }, { text: t('btn.cancel', lang), callback_data: 'fl:x' }]] },
  });
}

/** Просит прислать содержимое файла следующим сообщением. */
function askContent(st, project, { dir, parts, replace = false }, lang) {
  st.pendingInput = { kind: 'fileContent', dir, parts, replace, at: Date.now() };
  return say(st.to, th('files.contentAsk', lang, { path: hCode(relShow(project, join(dir, ...parts))) }), { ...HTML, reply_markup: cancelMarkup(lang) });
}

/** Скачивает присланный файл и кладёт его в проект. */
async function saveUpload(st, project, { dir, parts, meta, messageId }, lang, { replace = false } = {}) {
  let data;
  try {
    data = await downloadFile(meta.id);
  } catch (e) {
    log('files: скачивание:', e.message, '| пользователь', st.userId);
    return say(st.to, t('file.downloadFail', lang, { msg: errText(e, lang, errorRootOf(st.userId)) }));
  }
  if (data.length > MAX_FILE_BYTES) return say(st.to, t('file.tooBig', lang));
  try {
    const r = writeProjectFile(project, dir, parts, data, { replace });
    log('файл загружен в проект:', st.userId, r.path, `${r.size} Б`);
    await dropMessage(st, messageId);
    return say(st.to, th('files.saved', lang, { path: hCode(relShow(project, r.path)), size: fmtSize(r.size) }), HTML);
  } catch (e) {
    log('files: запись:', e.message, '| пользователь', st.userId);
    return say(st.to, th('files.saveFail', lang, { why: whyText(e, lang, st.userId) }), HTML);
  }
}

/** Кнопки экрана файлов: fl:o (папка), fl:f (файл), fl:d / fl:D (удаление), fl:n (создать), fl:u (загрузить), fl:r (заменить), fl:x (отмена). */
export async function onFilesCallback(st, cb) {
  const [, action, arg, pageStr] = (cb.data || '').split(':');
  const lang = langOf(st.userId);
  const chatId = cb.message?.chat?.id ?? st.chatId;
  const messageId = cb.message?.message_id;
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
  const edit = (v) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text: v.text, ...HTML, reply_markup: v.markup ?? { inline_keyboard: [] } }).catch((e) => log('files:', e.message));

  if (action === 'x') {
    st.pendingInput = null;
    st.replaces?.clear();
    await ack();
    return edit({ text: th('files.cancelled', lang) });
  }
  const project = projectOf(st);
  if (!project) return ack(t('state.projectGone', lang));
  const manage = canManageFiles(st.userId);

  if (action === 'r') {
    const job = st.replaces?.get(Number(arg));
    if (!job || !manage) return ack(t('proj.stale', lang));
    st.replaces.delete(Number(arg));
    await ack();
    await edit({ text: th('files.replacing', lang, { path: hCode(relShow(project, join(job.dir, ...job.parts))) }) });
    return job.meta ? saveUpload(st, project, job, lang, { replace: true }) : askContent(st, project, { ...job, replace: true }, lang);
  }

  // токены путей общие для всех пользователей: путь из кнопки каждый раз проверяется по проекту нажавшего
  const path = tokenPath(arg);
  if (!path) return ack(t('proj.stale', lang));
  try {
    if (action === 'o') {
      const v = await filesView(st, project, path, Number(pageStr) || 0, lang);
      await ack();
      return edit(v);
    }
    if (action === 'f' || action === 'd') {
      const card = fileCard(st, project, path, lang, { confirm: action === 'd' && manage });
      if (!card) return ack(t('files.err.missing', lang));
      await ack();
      return edit(card);
    }
    if (!manage) return ack(t('files.noRights', lang));
    if (action === 'D') {
      deleteProjectFile(project, path);
      log('файл проекта удалён:', st.userId, path);
      await ack(t('files.deleted', lang, { name: basename(path) }));
      return edit(await filesView(st, project, dirname(path), 0, lang));
    }
    if (action === 'n' || action === 'u') {
      await listProjectDir(project, path, { hideConfig: !canManageFiles(st.userId) }); // папка должна быть внутри проекта
      await ack();
      st.pendingInput = { kind: action === 'n' ? 'fileName' : 'fileUpload', dir: path, at: Date.now() };
      return say(st.to, th(action === 'n' ? 'files.nameAsk' : 'files.uploadAsk', lang, { dir: hCode(relShow(project, path)) }), { ...HTML, reply_markup: cancelMarkup(lang) });
    }
  } catch (e) {
    if (!(e instanceof FileError)) log('files:', e.message, '| пользователь', st.userId);
    return ack(whyText(e, lang, st.userId));
  }
}

/**
 * Текст пользователя, пока бот ждёт имя файла или его содержимое. Возвращает true, если текст обработан здесь:
 * агенту он тогда не передаётся. Содержимое не пишется в журнал и базу, а сообщение с ним удаляется из чата.
 * @param {{messageId?: number, now?: number}} [o]
 */
export async function onFileInput(st, text, { messageId, now = Date.now() } = {}) {
  const lang = langOf(st.userId);
  // хвост слишком длинного содержимого, разбитого Telegram на несколько сообщений: агенту не передаём
  if (st.swallowUntil && now < st.swallowUntil) {
    await dropMessage(st, messageId);
    return true;
  }
  const wait = st.pendingInput;
  if (wait?.kind !== 'fileName' && wait?.kind !== 'fileContent') return false;
  const expired = now - wait.at > FILE_WAIT_MS;
  const project = projectOf(st);

  if (wait.kind === 'fileContent') {
    // это может быть секрет: что бы ни случилось, агенту текст не уходит, а сообщение удаляется
    st.pendingInput = null;
    // до первого await: вторая часть разбитого Telegram сообщения обрабатывается параллельно и иначе ушла бы агенту
    const tooLong = [...text].length > INLINE_MAX;
    if (tooLong) st.swallowUntil = now + SWALLOW_MS;
    await dropMessage(st, messageId);
    if (expired || !project || !canManageFiles(st.userId)) return (await say(st.to, t('files.contentExpired', lang)), true);
    if (tooLong) {
      const markup = { inline_keyboard: [[{ text: t('files.upload', lang), callback_data: `fl:u:${pathToken(wait.dir)}` }]] };
      return (await say(st.to, t('files.contentLong', lang, { max: INLINE_MAX }), { reply_markup: markup }), true);
    }
    try {
      const r = writeProjectFile(project, wait.dir, wait.parts, text.endsWith('\n') ? text : `${text}\n`, { replace: wait.replace });
      log('файл создан в проекте:', st.userId, r.path, `${r.size} Б`);
      await say(st.to, th('files.saved', lang, { path: hCode(relShow(project, r.path)), size: fmtSize(r.size) }), HTML);
    } catch (e) {
      log('files: запись:', e.message, '| пользователь', st.userId);
      await say(st.to, th('files.saveFail', lang, { why: whyText(e, lang, st.userId) }), HTML);
    }
    return true;
  }

  // имя файла
  if (expired) {
    st.pendingInput = null;
    return false;
  }
  if (!project || !canManageFiles(st.userId)) {
    st.pendingInput = null;
    return (await say(st.to, t('state.projectGone', lang)), true);
  }
  const parts = relPath(text, { hideConfig: !canManageFiles(st.userId) });
  if (!parts) return (await say(st.to, t('files.nameBad', lang), { reply_markup: cancelMarkup(lang) }), true);
  let target;
  try {
    target = resolveTarget(project, wait.dir, parts);
  } catch (e) {
    return (await say(st.to, th('files.saveFail', lang, { why: whyText(e, lang, st.userId) }), { ...HTML, reply_markup: cancelMarkup(lang) }), true);
  }
  st.pendingInput = null;
  if (target.exists) await askReplace(st, project, { dir: wait.dir, parts }, lang);
  else await askContent(st, project, { dir: wait.dir, parts }, lang);
  return true;
}

/**
 * Файл или фото от пользователя, пока бот ждёт загрузку в проект (кнопка «Загрузить файл»). Возвращает true, если
 * файл сохранён в проект (или отклонён здесь): агенту он тогда не передаётся. Без ожидания — false: файл для агента.
 */
export async function onFileUpload(st, msg, now = Date.now()) {
  const wait = st.pendingInput;
  const waiting = wait?.kind === 'fileUpload' && now - wait.at <= FILE_WAIT_MS;
  const album = msg.media_group_id && st.uploadGroup?.id === msg.media_group_id && now < st.uploadGroup.until;
  if (!waiting && !album) return false;
  const dir = waiting ? wait.dir : st.uploadGroup.dir;
  if (waiting) st.pendingInput = null;
  if (msg.media_group_id) st.uploadGroup = { id: msg.media_group_id, dir, until: now + ALBUM_MS };
  const lang = langOf(st.userId);
  const project = projectOf(st);
  if (!project || !canManageFiles(st.userId)) return (await say(st.to, t('state.projectGone', lang)), true);
  const meta = describeAttachment(msg);
  if (!meta) return false;
  if (meta.size > MAX_FILE_BYTES) return (await say(st.to, t('file.tooBig', lang)), true);
  // имя — как у присланного файла (с точкой в начале, если она есть); непригодное заменяется безопасным
  const opts = { hideConfig: !canManageFiles(st.userId) };
  const parts = relPath(basename(String(meta.name).replace(/\\/g, '/')), opts) ?? relPath(safeFileName(meta.name), opts);
  if (!parts) return (await say(st.to, t('files.nameBad', lang)), true);
  const job = { dir, parts, meta, messageId: msg.message_id };
  try {
    if (resolveTarget(project, dir, parts).exists) return (await askReplace(st, project, job, lang), true);
  } catch (e) {
    return (await say(st.to, th('files.saveFail', lang, { why: whyText(e, lang, st.userId) }), HTML), true);
  }
  await saveUpload(st, project, job, lang);
  return true;
}

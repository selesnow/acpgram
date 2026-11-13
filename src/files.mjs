// Вложения: приём файлов и изображений от пользователя и отправка файлов, которые создал агент.
// Файлы от пользователя сохраняются на диск (агент читает их своими инструментами по пути) — так работает любой
// движок и любой формат; изображения дополнительно уходят блоком image, если агент это заявил (promptCapabilities).
// Файлы агента — по метке [[send:путь]] в ответе: отправляются только из каталога исходящих и из папки проекта.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { DATA_DIR, ENV_PATH } from './app.mjs';
import { isWithin } from './projects.mjs';

/** Максимальный размер файла в обе стороны: 20 МБ (лимит скачивания файлов Bot API). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Картинки крупнее этого размера уходят агенту только путём к файлу, а не блоком image (лимиты моделей). */
export const IMAGE_BLOCK_MAX = 5 * 1024 * 1024;
/** Сколько дней хранятся принятые и исходящие файлы. */
export const KEEP_DAYS = Number(process.env.FILES_KEEP_DAYS) > 0 ? Number(process.env.FILES_KEEP_DAYS) : 7;

/** Базовый каталог файлов: FILES_DIR из .env, иначе каталог данных бота. */
export const FILES_BASE = process.env.FILES_DIR?.trim() || DATA_DIR;
export const uploadsRoot = (base = FILES_BASE) => join(base, 'uploads');
export const outboxRoot = (base = FILES_BASE) => join(base, 'outbox');
/** Каталог принятых файлов пользователя и каталог файлов для отправки ему. */
export const uploadsDir = (userId, base = FILES_BASE) => join(uploadsRoot(base), String(userId));
export const outboxDir = (userId, base = FILES_BASE) => join(outboxRoot(base), String(userId));

const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Типы изображений, которые принимают модели. */
export const IMAGE_MIMES = new Set(Object.values(IMAGE_EXT));

export const isImageMime = (mime) => IMAGE_MIMES.has(String(mime ?? '').toLowerCase());
/** MIME изображения по расширению файла или null. */
export const imageMimeOf = (name) => IMAGE_EXT[extname(String(name ?? '')).toLowerCase()] ?? null;

/** Описание вложения сообщения Telegram: {id, name, mime, size} или null (фото берётся самого большого размера). */
export function describeAttachment(msg) {
  const doc = msg?.document;
  if (doc) return { id: doc.file_id, name: doc.file_name || `file_${doc.file_unique_id}`, mime: doc.mime_type || imageMimeOf(doc.file_name) || '', size: doc.file_size };
  const photo = msg?.photo?.at(-1); // Telegram присылает несколько размеров, последний — самый большой
  if (photo) return { id: photo.file_id, name: `photo_${photo.file_unique_id}.jpg`, mime: 'image/jpeg', size: photo.file_size };
  return null;
}

/** Безопасное имя файла: без путей, управляющих и запрещённых в Windows символов, зарезервированных имён. */
export function safeFileName(name, fallback = 'file') {
  let n = basename(String(name ?? '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (!n) n = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (n.length > 100) {
    const ext = extname(n).slice(0, 16);
    n = n.slice(0, 100 - ext.length) + ext;
  }
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Сохраняет файл в `dir` под именем «ГГГГММДД-ЧЧММСС_имя» (существующие файлы не перезаписываются). Возвращает путь. */
export function saveUpload(dir, name, buffer, date = new Date()) {
  mkdirSync(dir, { recursive: true });
  const safe = safeFileName(name);
  for (let i = 0; ; i++) {
    const path = join(dir, `${stamp(date)}${i ? `-${i}` : ''}_${safe}`);
    try {
      writeFileSync(path, buffer, { flag: 'wx' });
      return path;
    } catch (e) {
      if (e.code !== 'EEXIST' || i > 99) throw e;
    }
  }
}

/** Удаляет файлы старше maxAgeMs в каталогах пользователей внутри `root` (root/<id>/файл). Возвращает число удалённых. */
export function cleanupOldFiles(root, maxAgeMs, now = Date.now()) {
  let removed = 0;
  if (!existsSync(root)) return 0;
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = join(root, dir.name);
    for (const f of readdirSync(full, { withFileTypes: true })) {
      const p = join(full, f.name);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) {
          rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch {}
    }
  }
  return removed;
}

/** Чистка загрузок и исходящих файлов старше KEEP_DAYS. */
export function cleanupFiles(base = FILES_BASE) {
  const age = KEEP_DAYS * 24 * 3600_000;
  return cleanupOldFiles(uploadsRoot(base), age) + cleanupOldFiles(outboxRoot(base), age);
}

const UNPACKED_LIST = 50; // сколько файлов распакованного архива перечислять агенту

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Подсказка агенту, как отправлять файлы пользователю. Служебный текст для агента — на английском. */
export function outboxNote(outbox) {
  return (
    `[AcpGram] You can send a file to the user in Telegram: save it (preferably in "${outbox}") and put [[send:<absolute path>]] ` +
    `on its own line in your reply. Allowed: that folder and the project folder, up to 20 MB per file, never secrets (.env, databases). ` +
    `Use it only when the user asks for a file or a file is the natural result of the task; do not mention this mechanism otherwise.`
  );
}

const NO_TEXT_PROMPT = 'The user sent the attached file(s) without a message. Look at them, briefly say what they contain and ask what to do with them.';

/**
 * Блоки промпта ACP: текст пользователя, изображения (если агент принимает image) и служебная заметка со списком файлов
 * и правилами отправки. files: [{path, name, mime, size, data?}] — data (Buffer) только у изображений.
 */
export function buildPromptBlocks({ text, files = [], caps, outbox }) {
  const blocks = [{ type: 'text', text: text?.trim() || (files.length ? NO_TEXT_PROMPT : '') }];
  const imageOk = Boolean(caps?.promptCapabilities?.image);
  for (const f of files) {
    if (imageOk && f.data && isImageMime(f.mime) && f.size <= IMAGE_BLOCK_MAX) {
      blocks.push({ type: 'image', data: f.data.toString('base64'), mimeType: f.mime.toLowerCase() });
    }
  }
  const note = [];
  if (files.length) {
    note.push('[AcpGram] The user attached files (saved on the server, open them with your file tools when needed):');
    for (const f of files) {
      note.push(`- ${f.path} (${f.mime || 'unknown type'}, ${kb(f.size)}${imageOk && f.data && f.size <= IMAGE_BLOCK_MAX && isImageMime(f.mime) ? ', also shown inline' : ''})`);
      if (f.unpacked) {
        // архив распакован ботом: агенту — папка и список файлов (первые UNPACKED_LIST)
        const { dir, files: inner, skipped = 0 } = f.unpacked;
        note.push(`  The archive was unpacked to "${dir}" (${inner.length} files${skipped ? `, ${skipped} unsafe or unsupported entries skipped` : ''}):`);
        for (const x of inner.slice(0, UNPACKED_LIST)) note.push(`  - ${x.path} (${kb(x.size)})`);
        if (inner.length > UNPACKED_LIST) note.push(`  - ... and ${inner.length - UNPACKED_LIST} more`);
      }
    }
  }
  if (outbox) note.push(outboxNote(outbox));
  if (note.length) blocks.push({ type: 'text', text: note.join('\n') });
  return blocks;
}

const MARK = /\[\[send:([^\]\r\n]+)\]\]/g;

/** Убирает метки отправки из текста ответа и возвращает пути из них (без повторов). */
export function extractSendMarks(text) {
  const src = String(text ?? '');
  if (!src.includes('[[send:')) return { text: src, paths: [] }; // ответ без меток не трогаем
  const paths = [];
  const stripped = src
    .replace(MARK, (_, p) => {
      const path = p.trim().replace(/^["']|["']$/g, '');
      if (path && !paths.includes(path)) paths.push(path);
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, paths };
}

/** Для черновика: убирает и целые метки, и ещё не дописанные в потоке («[[send:C:\x», «[[se»). */
export function stripSendMarks(text) {
  return String(text ?? '')
    .replace(/\[\[send:[^\]\r\n]*(?:\]\]?)?/g, '')
    .replace(/\[{1,2}(?:s(?:e(?:n(?:d)?)?)?)?$/, '');
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/** Секретные места, которые агент не может отправить: .env, база и логи бота, служебная папка git. */
function isSecret(path) {
  if (/^\.env(\.|$)/i.test(basename(path))) return true;
  if (/[\\/]\.git[\\/]/.test(path)) return true;
  const envReal = real(ENV_PATH);
  if (envReal && isWithin(path, envReal)) return true;
  const data = real(DATA_DIR);
  return Boolean(data && isWithin(path, data));
}

/**
 * Проверка файла к отправке пользователю. Разрешено: каталог исходящих пользователя (outbox) и папка проекта (cwd),
 * без секретов, только обычные файлы до MAX_FILE_BYTES. Ссылки и «..» разрешаются до проверки.
 * @returns {{ok: true, path: string, size: number} | {ok: false, reason: 'missing'|'notfile'|'denied'|'empty'|'big'}}
 */
export function resolveSendable(p, { cwd, outbox, maxBytes = MAX_FILE_BYTES }) {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const file = real(abs);
  if (!file) return { ok: false, reason: 'missing' };
  const st = statSync(file);
  if (!st.isFile()) return { ok: false, reason: 'notfile' };
  const outboxReal = outbox && real(outbox);
  const cwdReal = cwd && real(cwd);
  const inOutbox = Boolean(outboxReal && isWithin(file, outboxReal));
  if (!inOutbox && !(cwdReal && isWithin(file, cwdReal) && !isSecret(file))) return { ok: false, reason: 'denied' };
  if (st.size === 0) return { ok: false, reason: 'empty' };
  if (st.size > maxBytes) return { ok: false, reason: 'big' };
  return { ok: true, path: file, size: st.size };
}

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
    `on its own line in your reply where the file should appear (the image or file is shown right there, inside the message). ` +
    `Allowed: that folder and the project folder, up to 20 MB per file, never secrets (.env, databases). ` +
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

/** Строчный код: отрезок из n обратных кавычек до следующего отрезка ровно из n кавычек (как в CommonMark). */
function splitInlineCode(text, out) {
  let i = 0;
  let from = 0;
  while (i < text.length) {
    const open = text.indexOf('`', i);
    if (open < 0) break;
    let n = 1;
    while (text[open + n] === '`') n++;
    const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, 'g');
    close.lastIndex = open + n;
    const m = close.exec(text);
    if (!m) {
      i = open + n; // незакрытые кавычки — обычный текст
      continue;
    }
    if (open > from) out.push({ code: false, s: text.slice(from, open) });
    out.push({ code: true, s: text.slice(open, m.index + n) });
    i = from = m.index + n;
  }
  if (from < text.length) out.push({ code: false, s: text.slice(from) });
}

/**
 * Делит Markdown на куски текста и кода: блоки ``` / ~~~ (незакрытый — код до конца) и строчный код в `кавычках`.
 * Метки отправки ищутся только в тексте: упоминание метки в коде (пример, документация) — не команда отправки.
 * @returns {{code: boolean, s: string}[]}
 */
export function splitCode(text) {
  const out = [];
  const lines = String(text ?? '').split(/(?<=\n)/);
  let buf = '';
  let fence = null; // открывающий забор: символ и длина
  for (const line of lines) {
    if (fence) {
      buf += line;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        out.push({ code: true, s: buf });
        buf = '';
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      if (buf) splitInlineCode(buf, out);
      buf = line;
      fence = open[1];
      continue;
    }
    buf += line;
  }
  if (fence) out.push({ code: true, s: buf });
  else if (buf) splitInlineCode(buf, out);
  return out;
}

/** Заглушка на месте метки: туда потом встаёт сам файл (блок rich-сообщения). Символы \u0000 в ответе агента не встречаются. */
export const filePlaceholder = (i) => `\u0000${i}\u0000`;
export const FILE_PLACEHOLDER = /\u0000(\d+)\u0000/g;

/**
 * Убирает метки отправки из текста ответа и возвращает пути из них (без повторов). Метки внутри кода не трогает.
 * placeholders: true — на месте первой метки каждого файла остаётся filePlaceholder(номер пути), чтобы файл встал туда же.
 */
export function extractSendMarks(text, { placeholders = false } = {}) {
  const src = String(text ?? '');
  if (!src.includes('[[send:')) return { text: src, paths: [] }; // ответ без меток не трогаем
  const paths = [];
  const stripped = splitCode(src)
    .map(({ code, s }) => {
      if (code || !s.includes('[[send:')) return s;
      return s
        .replace(MARK, (_, p) => {
          const path = p.trim().replace(/^["']|["']$/g, '');
          if (!path || paths.includes(path)) return '';
          paths.push(path);
          return placeholders ? filePlaceholder(paths.length - 1) : '';
        })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
    })
    .join('')
    .trim();
  return { text: stripped, paths };
}

/** Сколько файлов агента отправляем пользователю за один ответ. */
export const MAX_FILES_PER_TURN = 10;
/** Файлы внутри ответа загружаются одним запросом вместе с ним; лимит загрузки Bot API — 50 МБ. */
export const MAX_EMBED_BYTES = 45 * 1024 * 1024;
/** Фото Telegram принимает до 10 МБ (крупнее — документом). */
const PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Ставит файлы агента в текст ответа на место меток (заглушки FILE_PLACEHOLDER из extractSendMarks):
 * доступный файл — блоком rich-сообщения (фото или документ), недоступный — строкой failText(имя, причина).
 * Файлы сверх maxBytes (суммарно) — в extra: уйдут отдельными сообщениями после ответа.
 * @param {{cwd: string, outbox: string, failText: (name: string, reason: string) => string, onSkip?: (path: string, reason: string) => void, maxBytes?: number}} o
 * @returns {{text: string, media: Object<string, {path: string, name: string, size: number, photo: boolean}>, extra: object[]}}
 */
export function attachFiles(text, paths, { cwd, outbox, failText, onSkip = () => {}, maxBytes = MAX_EMBED_BYTES }) {
  const media = {};
  const extra = [];
  let budget = maxBytes;
  const place = (n) => {
    const i = Number(n);
    const p = paths[i];
    if (p == null) return null;
    if (i >= MAX_FILES_PER_TURN) {
      onSkip(p, 'limit');
      return null;
    }
    const r = resolveSendable(p, { cwd, outbox });
    if (!r.ok) {
      onSkip(p, r.reason);
      return failText(basename(p), r.reason);
    }
    const file = { path: r.path, name: basename(r.path), size: r.size, photo: ['image/jpeg', 'image/png'].includes(imageMimeOf(r.path)) && r.size <= PHOTO_BYTES };
    if (r.size > budget) {
      extra.push(file);
      return null;
    }
    budget -= r.size;
    const id = `f${i}`;
    media[id] = file;
    return `![](tg://${file.photo ? 'photo' : 'document'}?id=${id})`;
  };
  // заглушки, идущие подряд, вместе с пробелами и переводами строк вокруг → блоки через пустую строку;
  // остальной текст (и код в нём) не трогаем
  const out = String(text ?? '').replace(/[ \t]*\n*(?:\u0000\d+\u0000[ \t]*\n*)+/g, (run) => {
    const blocks = [...run.matchAll(FILE_PLACEHOLDER)].map((m) => place(m[1])).filter(Boolean);
    return blocks.length ? `\n\n${blocks.join('\n\n')}\n\n` : '\n\n';
  });
  return { text: out.trim(), media, extra };
}

/** Для черновика: убирает и целые метки, и ещё не дописанные в потоке («[[send:C:\x», «[[se»). Код не трогает. */
export function stripSendMarks(text) {
  const parts = splitCode(text);
  return parts
    .map(({ code, s }, i) => {
      if (code) return s;
      const r = s.replace(/\[\[send:[^\]\r\n]*(?:\]\]?)?/g, '');
      return i === parts.length - 1 ? r.replace(/\[{1,2}(?:s(?:e(?:n(?:d)?)?)?)?$/, '') : r;
    })
    .join('');
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

// Папки с ключами и входами: SSH, облака, менеджеры пакетов и сами AI-агенты (токены Claude Code, Gemini CLI, Codex)
const SECRET_DIRS = /[\\/](?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.claude|\.gemini|\.codex|\.acpgram|\.config[\\/](?:gh|gcloud))[\\/]/i;
// Файлы с секретами: .env*, .Renviron (пароли и токены в R-проектах), закрытые ключи и сертификаты, входы npm/pip/git
const SECRET_FILES = /^(?:\.env(?:\..*)?|\.Renviron|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk)|credentials(?:\.json)?|client_secret.*\.json)$/i;

/**
 * Секретные места, которые агент не может отправить из папки проекта: файлы и папки с ключами (SECRET_FILES,
 * SECRET_DIRS), .env и каталог данных бота (база, журналы). Это защита от случайной или навязанной (prompt injection)
 * отправки файла; прочитать файл и пересказать его текстом агент по-прежнему может своими инструментами.
 */
export function isSecret(path) {
  if (SECRET_FILES.test(basename(path))) return true;
  if (SECRET_DIRS.test(path)) return true;
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

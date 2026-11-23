// Файлы проекта, которыми пользователь управляет сам, в обход агента (/files): список, создание, загрузка, удаление.
// Так в проект попадают секреты (.env, ключи): содержимое не проходит через запрос к модели.
//
// Все операции работают только внутри папки проекта и не ходят по ссылкам: агент пишет в ту же папку и мог бы подложить
// ссылку «.env → файл вне проекта», чтобы бот (он работает без песочницы) перезаписал чужой файл.
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFileError, openVerified, verifyStable } from './agentFiles.mjs';
import { isWithin } from './projects.mjs';

/** Наибольшая длина одного имени в пути и наибольшая вложенность. */
export const NAME_MAX = 100;
export const DEPTH_MAX = 8;

// В эти папки бот не пишет и их не показывает: служебные данные git и тяжёлые каталоги зависимостей
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'renv', 'packrat', 'site-packages']);
const CONFIG_DIRS = new Set(['.claude', '.gemini', '.codex', '.opencode']);
const CONFIG_FILES = new Set(['opencode.json']);

/** Ошибка операции с файлом проекта: code — причина для сообщения пользователю (ключ files.err.<code>). */
export class FileError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/**
 * Относительный путь файла из текста пользователя: «.env», «config/.env», «docs\notes.txt».
 * Возвращает части пути или null, если путь не подходит: абсолютный, с «..», с запрещёнными символами, в служебной папке.
 * Имена с точки (.env, .Renviron) разрешены — ради них это и сделано.
 */
export function relPath(input, { hideConfig = false } = {}) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('~')) return null;
  const parts = raw.split('/').map((s) => s.trim());
  if (parts.length > DEPTH_MAX) return null;
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || [...p].length > NAME_MAX) return null;
    // eslint-disable-next-line no-control-regex -- управляющие символы в имени файла недопустимы
    if (/[\u0000-\u001f<>:"|?*]/.test(p) || /[. ]$/.test(p)) return null;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p)) return null;
    const lower = p.toLowerCase();
    if (SKIP_DIRS.has(lower)) return null;
    if (hideConfig && (CONFIG_DIRS.has(lower) || CONFIG_FILES.has(lower))) return null;
  }
  return parts;
}

const lstat = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

/** Настоящий путь папки проекта; папка dir должна лежать в нём (иначе FileError 'outside'). */
function inProject(project, dir) {
  let root;
  let real;
  try {
    root = realpathSync.native(project);
    real = realpathSync.native(dir);
  } catch {
    throw new FileError('outside');
  }
  if (!isWithin(real, root) || !lstatSync(real).isDirectory()) throw new FileError('outside');
  return { root, real };
}

/**
 * Куда ляжет файл: проходит по частям пути от папки dir, не заходя в ссылки. create — создавать недостающие папки.
 * @returns {{path: string, dir: string, exists: boolean}} path — полный путь файла; exists — такой файл уже есть
 */
export function resolveTarget(project, dir, parts, { create = false } = {}) {
  const { real } = inProject(project, dir);
  let cur = real;
  for (const name of parts.slice(0, -1)) {
    cur = join(cur, name);
    const st = lstat(cur);
    if (!st) {
      if (!create) return { path: join(real, ...parts), dir: null, exists: false };
      mkdirSync(cur);
    } else if (!st.isDirectory()) throw new FileError(st.isSymbolicLink() ? 'link' : 'notdir'); // ссылка или файл на месте папки
  }
  const path = join(cur, parts.at(-1));
  const st = lstat(path);
  if (st && !st.isFile()) throw new FileError(st.isSymbolicLink() ? 'link' : 'isdir');
  return { path, dir: cur, exists: Boolean(st) };
}

/**
 * Записывает файл проекта. Содержимое пишется во временный файл рядом и переименованием встаёт на место: так ссылка,
 * подложенная на месте файла, заменяется самим файлом, а не ведёт запись наружу. Существующий файл без replace не трогается.
 * @param {string} project папка проекта
 * @param {string} dir     папка внутри проекта, от которой задан путь
 * @param {string[]} parts части пути (relPath)
 * @param {Buffer|string} data
 * @returns {{path: string, size: number, replaced: boolean}}
 */
export function writeProjectFile(project, dir, parts, data, { replace = false } = {}) {
  const { root } = inProject(project, dir);
  const target = resolveTarget(project, dir, parts, { create: true });
  if (target.exists && !replace) throw new FileError('exists');
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = join(target.dir, `.acpgram-${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600); // 'wx' не идёт по ссылке и не затирает существующее
  try {
    // папку могли подменить ссылкой между проверкой и открытием: файл должен лежать в проекте, иначе ничего не пишем
    if (!isWithin(realpathSync.native(tmp), root)) throw new FileError('outside');
    writeSync(fd, buf);
  } catch (e) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* временный файл уже исчез */
    }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, target.path);
  return { path: target.path, size: buf.length, replaced: target.exists };
}

/** Удаляет файл проекта (только обычный файл, не папку и не ссылку). */
export function deleteProjectFile(project, path) {
  const { root } = inProject(project, join(path, '..'));
  let handle;
  try {
    handle = openVerified(path, { allowed: (file) => isWithin(file, root), allowEmpty: true, noFollow: true });
    verifyStable(handle.fd, path);
    unlinkSync(path);
  } catch (e) {
    if (e instanceof AgentFileError) {
      if (e.code === 'missing') throw new FileError('missing');
      if (e.code === 'link' || e.code === 'notfile') throw new FileError(e.code === 'link' ? 'link' : 'isdir');
      throw new FileError('outside');
    }
    throw e;
  } finally {
    if (handle) closeSync(handle.fd);
  }
}

/**
 * Содержимое папки проекта: папки и файлы по алфавиту, со скрытыми файлами (.env), без ссылок и служебных папок.
 * @returns {{dirs: string[], files: {name: string, size: number, mtime: number}[]}}
 */
export function listProjectDir(project, dir, { hideConfig = false } = {}) {
  const { real } = inProject(project, dir);
  const dirs = [];
  const files = [];
  for (const d of readdirSync(real, { withFileTypes: true })) {
    if (d.isSymbolicLink() || d.name.endsWith('.tmp') && d.name.startsWith('.acpgram-')) continue;
    const lower = d.name.toLowerCase();
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(lower) && !(hideConfig && CONFIG_DIRS.has(lower))) dirs.push(d.name);
    } else if (d.isFile()) {
      if (hideConfig && CONFIG_FILES.has(lower)) continue;
      const st = lstat(join(real, d.name));
      if (st) files.push({ name: d.name, size: st.size, mtime: st.mtimeMs });
    }
  }
  const byName = (a, b) => a.localeCompare(b, 'ru');
  return { dirs: dirs.sort(byName), files: files.sort((a, b) => byName(a.name, b.name)) };
}

/** Сведения о файле проекта для его карточки или null, если это не обычный файл внутри проекта. */
export function projectFileInfo(project, path) {
  try {
    const { root } = inProject(project, join(path, '..'));
    const st = lstat(path);
    if (!st?.isFile() || !isWithin(realpathSync.native(path), root)) return null;
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Размер для человека: «812 B», «3.4 KB», «1.2 MB». */
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

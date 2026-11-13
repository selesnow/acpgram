// Распаковка присланных архивов (.zip, .tar, .tar.gz, .tgz) без внешних программ и зависимостей — только zlib.
// Архив недоверенный: пути выхода за папку («../», абсолютные, диски), ссылки и зашифрованные записи пропускаются,
// размер и число файлов ограничены (защита от zip-бомбы). 7z и rar не поддерживаются — остаются обычным файлом.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { safeFileName } from './files.mjs';
import { isWithin } from './projects.mjs';

/** Не больше стольких файлов в архиве и стольких байт суммарно после распаковки. */
export const MAX_ARCHIVE_FILES = 500;
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/** reason: 'limit' (слишком много или слишком большой), 'corrupt' (повреждён), 'unsupported' (zip64 и т. п.). */
export class ArchiveError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.reason = reason;
  }
}

/** Вид архива по имени файла: 'zip' | 'tar' | 'tgz' | null. */
export function archiveKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tgz';
  if (n.endsWith('.tar')) return 'tar';
  return null;
}

/** Путь записи архива → безопасные части пути или null (выход за папку, абсолютный путь, диск). */
export function safeEntryPath(raw) {
  const s = String(raw ?? '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.includes('\0')) return null;
  const parts = s.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.map((p) => safeFileName(p, '_'));
}

const tooBig = (e) => e?.code === 'ERR_BUFFER_TOO_LARGE';

function decodeName(raw, utf8Flag) {
  if (utf8Flag) return raw.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return raw.toString('latin1');
  }
}

/** Записи zip по центральному каталогу. Данные читаются лениво: read(budget) → Buffer. */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('corrupt');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('unsupported'); // zip64
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('corrupt');
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new ArchiveError('corrupt');
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), Boolean(flags & 0x800));
    p += 46 + nameLen + extraLen + commentLen;
    const dir = name.endsWith('/');
    const link = madeBy === 3 && ((attr >>> 16) & 0xf000) === 0xa000; // символическая ссылка (unix)
    // зашифрованные, zip64-записи и неизвестные методы сжатия пропускаются
    const unsupported = Boolean(flags & 1) || csize === 0xffffffff || usize === 0xffffffff || (method !== 0 && method !== 8);
    entries.push({
      name,
      dir,
      link,
      unsupported,
      size: usize,
      read(budget) {
        if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) throw new ArchiveError('corrupt');
        const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
        if (start + csize > buf.length) throw new ArchiveError('corrupt');
        const data = buf.subarray(start, start + csize);
        if (method === 0) {
          if (data.length > budget) throw new ArchiveError('limit');
          return data;
        }
        try {
          return inflateRawSync(data, { maxOutputLength: Math.max(budget, 1) });
        } catch (e) {
          throw new ArchiveError(tooBig(e) ? 'limit' : 'corrupt');
        }
      },
    });
  }
  return entries;
}

const cstr = (b, from, len) => {
  const slice = b.subarray(from, from + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
};

/** Длинное имя из расширенного заголовка pax («<длина> path=<имя>\n»). */
function paxPath(data) {
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const len = parseInt(data.subarray(i, sp).toString(), 10);
    if (sp < 0 || !(len > 0)) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    if (rec.startsWith('path=')) return rec.slice(5);
    i += len;
  }
  return null;
}

/** Записи tar (в памяти). */
function tarEntries(buf) {
  const entries = [];
  let p = 0;
  let longName = null;
  let pax = null;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    let name = cstr(h, 0, 100);
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError('corrupt');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    if (cstr(h, 257, 5) === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const start = p + 512;
    if (start + size > buf.length) throw new ArchiveError('corrupt');
    const data = buf.subarray(start, start + size);
    p = start + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      pax = paxPath(data);
      continue;
    }
    if (type === 'g') continue;
    if (longName) name = longName;
    if (pax) name = pax;
    longName = pax = null;
    const isFile = type === '0' || type === '7';
    entries.push({
      name,
      dir: type === '5' || name.endsWith('/'),
      link: type === '1' || type === '2',
      unsupported: !isFile && type !== '5' && type !== '1' && type !== '2',
      size,
      read: (budget) => {
        if (data.length > budget) throw new ArchiveError('limit');
        return data;
      },
    });
  }
  return entries;
}

/**
 * Распаковывает архив в destDir. Возвращает {files: [{path, size}], skipped, total}: skipped — пропущенные записи
 * (небезопасный путь, ссылка, шифрование, дубликат). При любой ошибке destDir удаляется, бросается ArchiveError.
 */
export function extractArchive(buffer, kind, destDir, { maxFiles = MAX_ARCHIVE_FILES, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  let entries;
  try {
    if (kind === 'zip') entries = zipEntries(buffer);
    else {
      let tar = buffer;
      if (kind === 'tgz') {
        try {
          tar = gunzipSync(buffer, { maxOutputLength: maxBytes + 16 * 1024 * 1024 }); // запас на заголовки tar
        } catch (e) {
          throw new ArchiveError(tooBig(e) ? 'limit' : 'corrupt');
        }
      }
      entries = tarEntries(tar);
    }
  } catch (e) {
    throw e instanceof ArchiveError ? e : new ArchiveError('corrupt', e.message);
  }
  // объявленный размер проверяем сразу, не распаковывая
  const declared = entries.filter((e) => !e.dir && !e.link && !e.unsupported);
  if (declared.length > maxFiles || declared.reduce((s, e) => s + e.size, 0) > maxBytes) throw new ArchiveError('limit');

  const files = [];
  let skipped = 0;
  let total = 0;
  mkdirSync(destDir, { recursive: true });
  try {
    for (const e of entries) {
      if (e.dir) continue;
      const parts = e.link || e.unsupported ? null : safeEntryPath(e.name);
      if (!parts) {
        skipped++;
        continue;
      }
      const target = join(destDir, ...parts);
      if (!isWithin(resolve(target), resolve(destDir))) {
        skipped++;
        continue;
      }
      const data = e.read(maxBytes - total);
      total += data.length;
      if (total > maxBytes) throw new ArchiveError('limit');
      mkdirSync(dirname(target), { recursive: true });
      try {
        writeFileSync(target, data, { flag: 'wx' });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        skipped++; // два файла с одним именем после очистки путей
        continue;
      }
      files.push({ path: parts.join('/'), size: data.length });
    }
  } catch (e) {
    rmSync(destDir, { recursive: true, force: true });
    throw e instanceof ArchiveError ? e : new ArchiveError('corrupt', e.message);
  }
  return { files, skipped, total };
}

/**
 * То же, что extractArchive, но в отдельном потоке (worker_threads): распаковка до 100 МБ (zlib) и запись файлов
 * занимают секунды, и в главном потоке на это время замирал бы весь бот — черновики и запросы всех пользователей.
 * Ошибки — те же ArchiveError с reason.
 */
export function extractArchiveAsync(buffer, kind, destDir, opts = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { acpgramArchive: true, buffer, kind, destDir, opts } });
    w.once('message', (m) => (m.ok ? resolve(m.result) : reject(new ArchiveError(m.reason, m.message))));
    w.once('error', (e) => reject(new ArchiveError('corrupt', e.message)));
    w.once('exit', (code) => reject(new ArchiveError('corrupt', `поток распаковки завершился с кодом ${code}`))); // после ответа ни на что не влияет
  });
}

// этот же модуль — тело потока распаковки
if (!isMainThread && workerData?.acpgramArchive) {
  const { buffer, kind, destDir, opts } = workerData;
  try {
    const data = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    parentPort.postMessage({ ok: true, result: extractArchive(data, kind, destDir, opts) });
  } catch (e) {
    parentPort.postMessage({ ok: false, reason: e.reason ?? 'corrupt', message: e.message });
  }
}

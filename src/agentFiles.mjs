import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isWithin } from './projects.mjs';

export class AgentFileError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

const lstat = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

export function openVerified(path, { allowed = () => true, maxBytes = Infinity, allowEmpty = false, noFollow = false } = {}) {
  if (noFollow) {
    const original = lstat(path);
    if (!original) throw new AgentFileError('missing');
    if (!original.isFile()) throw new AgentFileError(original.isSymbolicLink() ? 'link' : 'notfile');
  }
  const first = real(path);
  if (!first) throw new AgentFileError('missing');
  if (!allowed(first)) throw new AgentFileError('denied');
  const st = lstat(first);
  if (!st) throw new AgentFileError('missing');
  if (!st.isFile()) throw new AgentFileError(st.isSymbolicLink() ? 'link' : 'notfile');
  if (st.size === 0 && !allowEmpty) throw new AgentFileError('empty');
  if (st.size > maxBytes) throw new AgentFileError('big');
  let fd;
  try {
    fd = openSync(first, 'r');
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size !== st.size) throw new AgentFileError('changed');
    const second = real(path);
    if (!second || !allowed(second)) throw new AgentFileError('changed');
    const st2 = lstat(second);
    if (second !== first || !st2 || st2.dev !== fst.dev || st2.ino !== fst.ino || st2.size !== fst.size) throw new AgentFileError('changed');
    return { fd, path: first, size: fst.size, dev: fst.dev, ino: fst.ino };
  } catch (e) {
    if (fd != null) closeSync(fd);
    throw e;
  }
}

export function readFd(fd, size) {
  const buf = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const n = readSync(fd, buf, offset, size - offset, offset);
    if (n <= 0) break;
    offset += n;
  }
  return offset === size ? buf : buf.subarray(0, offset);
}

export function readStable(path, opts = {}) {
  let h;
  try {
    h = openVerified(path, opts);
    const buffer = readFd(h.fd, h.size);
    verifyStable(h.fd, h.path);
    return { ok: true, path: h.path, size: h.size, buffer };
  } catch (e) {
    if (e instanceof AgentFileError) return { ok: false, reason: e.code };
    throw e;
  } finally {
    if (h) closeSync(h.fd);
  }
}

export function verifyStable(fd, path) {
  const fst = fstatSync(fd);
  const cur = lstat(path);
  if (!cur || !cur.isFile() || cur.dev !== fst.dev || cur.ino !== fst.ino || cur.size !== fst.size) throw new AgentFileError('changed');
  return real(path);
}

export function updateNoFollow(file, root, update) {
  const top = real(root);
  if (!top) throw new AgentFileError('outside');
  const st = lstat(file);
  let have = '';
  if (st) {
    if (!st.isFile()) throw new AgentFileError(st.isSymbolicLink() ? 'link' : 'notfile');
    const target = real(file);
    if (!target || !isWithin(target, top)) throw new AgentFileError('outside');
    have = readFileSync(target, 'utf8');
  }
  const data = update(have);
  if (data === have) return false;
  const tmp = join(dirname(file), `.acpgram-${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    const realTmp = real(tmp);
    if (!realTmp || !isWithin(realTmp, top)) throw new AgentFileError('outside');
    const buf = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < buf.length) offset += writeSync(fd, buf, offset, buf.length - offset);
  } catch (e) {
    if (fd != null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      void 0;
    }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, file);
  return true;
}

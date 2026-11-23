import { readdirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

const MB = 1024 * 1024;

export function directorySize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySize(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      continue;
    }
  }
  return total;
}

export function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

export function fitsUpload({ usedBytes = 0, incomingBytes = 0, limitMb = 0, free = Infinity, minFreeMb = 0, reservedBytes = 0 } = {}) {
  const used = usedBytes + reservedBytes;
  if (limitMb > 0 && used + incomingBytes > limitMb * MB) return false;
  if (Number.isFinite(free) && free - incomingBytes < minFreeMb * MB) return false;
  return true;
}

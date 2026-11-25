import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { directorySize, fitsUpload, freeBytes } from '../src/quota.mjs';

test('fitsUpload: квота учитывает уже занятое и зарезервированное место', () => {
  assert.equal(fitsUpload({ usedBytes: 5 * 1024 * 1024, incomingBytes: 5 * 1024 * 1024, limitMb: 10 }), true);
  assert.equal(fitsUpload({ usedBytes: 6 * 1024 * 1024, incomingBytes: 5 * 1024 * 1024, limitMb: 10 }), false);
  assert.equal(fitsUpload({ usedBytes: 5 * 1024 * 1024, reservedBytes: 2 * 1024 * 1024, incomingBytes: 4 * 1024 * 1024, limitMb: 10 }), false);
  assert.equal(fitsUpload({ incomingBytes: 100 * 1024 * 1024, limitMb: 0 }), true);
});

test('fitsUpload: свободного места должно хватать с запасом', () => {
  const free = 100 * 1024 * 1024;
  assert.equal(fitsUpload({ incomingBytes: 20 * 1024 * 1024, free, minFreeMb: 50 }), true);
  assert.equal(fitsUpload({ incomingBytes: 60 * 1024 * 1024, free, minFreeMb: 50 }), false);
  assert.equal(fitsUpload({ incomingBytes: 60 * 1024 * 1024, free: Infinity, minFreeMb: 50 }), true);
});

test('directorySize: считает файлы во вложенных папках, отсутствующая папка — ноль', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acpgram-quota-'));
  try {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'a.txt'), '12345');
    writeFileSync(join(dir, 'b.txt'), '1234567');
    assert.equal(directorySize(dir), 12);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  assert.equal(directorySize(join(dir, 'missing')), 0);
});

test('freeBytes: для существующей папки место конечно, для отсутствующей — бесконечность', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acpgram-free-'));
  try {
    assert.ok(freeBytes(dir) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  assert.equal(freeBytes(join(dir, 'missing')), Infinity);
});

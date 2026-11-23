import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitsUpload } from '../src/quota.mjs';

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

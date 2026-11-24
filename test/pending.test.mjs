import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPendingStore, looksLikeSecret } from '../src/pending.mjs';

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    getSetting: (key) => rows.get(key) ?? null,
    setSetting: (key, value) => rows.set(key, value),
    allSettings: () => [...rows].map(([key, value]) => ({ key, value })),
  };
}

test('pending: ожидание живёт в базе и различается по пользователю и теме', () => {
  let clock = 1000;
  const db = fakeDb();
  const store = createPendingStore(db, { now: () => clock, ttlMs: 600 });
  store.set(7, 0, { kind: 'gitToken', host: 'github' });
  assert.deepEqual(store.get(7, 0), { kind: 'gitToken', host: 'github', at: 1000 });
  assert.equal(store.get(8, 0), null);
  assert.equal(store.get(7, 12), null);
  clock += 601;
  assert.equal(store.get(7, 0), null);
  assert.equal(db.getSetting('pending:7:0'), null);
});

test('pending: clear и sweep удаляют просроченные ожидания', () => {
  let clock = 2000;
  const db = fakeDb();
  const store = createPendingStore(db, { now: () => clock, ttlMs: 100 });
  store.set(1, 0, { kind: 'fileContent' });
  store.set(2, 0, { kind: 'gitToken' });
  store.clear(1, 0);
  assert.equal(store.get(1, 0), null);
  clock += 101;
  assert.equal(store.sweep(), 1);
  assert.equal(store.sweep(), 0);
});

test('looksLikeSecret: токены известных форматов распознаются', () => {
  for (const s of ['ghp_abcdefghijklmnopqrstuvwxyz', 'gho_abcdefghijklmnopqrstuvwxyz', 'ghu_abcdefghijklmnopqrstuvwxyz', 'github_pat_abcdefghijklmnop', 'glpat-abcdefghijklmnop', 'npm_abcdefghijklmnopqrst', 'sk-abcdefghijklmnopqrst', 'AKIA' + 'IOSFODNN7EXAMPLE']) {
    assert.equal(looksLikeSecret(s), true, s);
  }
  for (const s of ['hello', '/project', 'ghp_short', '']) assert.equal(looksLikeSecret(s), false, s);
});

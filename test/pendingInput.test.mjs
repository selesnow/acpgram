import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FILE_WAIT_MS,
  GIT_WAIT_MS,
  NEW_PROJECT_WAIT_MS,
  PENDING_INPUT_KINDS,
  PENDING_INPUTS,
  clearPendingInput,
  isPendingExpired,
  isPendingKind,
  isSecretPendingInput,
  pendingKindMatches,
  pendingKindsOf,
  renewPendingInput,
  setPendingInput,
} from '../src/pendingInput.mjs';

const EXPECTED_KINDS = [
  'gitToken',
  'gitSearch',
  'gitMessage',
  'gitHostUrl',
  'gitHostName',
  'gitBranch',
  'gitNsSearch',
  'gitRepoName',
  'gitMrTitle',
  'newProject',
  'fileName',
  'fileContent',
  'fileUpload',
];

test('pendingInput: в таблице ровно 13 видов ожидания', () => {
  assert.equal(PENDING_INPUT_KINDS.length, 13);
  assert.deepEqual([...PENDING_INPUT_KINDS].sort(), [...EXPECTED_KINDS].sort());
  for (const kind of PENDING_INPUT_KINDS) assert.equal(isPendingKind(kind), true, kind);
  assert.equal(isPendingKind('unknown'), false);
  assert.equal(isPendingKind(null), false);
});

test('pendingInput: группа publish перечисляет свои виды в порядке обработчика', () => {
  assert.deepEqual(pendingKindsOf('publish'), ['gitNsSearch', 'gitRepoName', 'gitMrTitle']);
  assert.deepEqual(pendingKindsOf('unknown'), []);
});

test('pendingInput: secret только у gitToken', () => {
  assert.deepEqual(PENDING_INPUT_KINDS.filter((kind) => PENDING_INPUTS[kind].secret), ['gitToken']);
  assert.equal(isSecretPendingInput({ kind: 'gitToken' }), true);
  assert.equal(isSecretPendingInput({ kind: 'fileContent' }), false);
  assert.equal(isSecretPendingInput(null), false);
});

test('pendingInput: TTL совпадают со старыми константами', () => {
  assert.equal(GIT_WAIT_MS, 10 * 60_000);
  assert.equal(FILE_WAIT_MS, 10 * 60_000);
  assert.equal(NEW_PROJECT_WAIT_MS, 10 * 60_000);
  for (const kind of PENDING_INPUT_KINDS) {
    const ttl = kind.startsWith('file') ? FILE_WAIT_MS : kind === 'newProject' ? NEW_PROJECT_WAIT_MS : GIT_WAIT_MS;
    assert.equal(PENDING_INPUTS[kind].ttl, ttl, kind);
  }
});

test('pendingInput: просрочка по строгому сравнению с TTL', () => {
  const at = 10_000;
  assert.equal(isPendingExpired({ kind: 'gitToken', at }, at + GIT_WAIT_MS), false);
  assert.equal(isPendingExpired({ kind: 'gitToken', at }, at + GIT_WAIT_MS + 1), true);
  assert.equal(isPendingExpired({ kind: 'fileUpload', at }, at + FILE_WAIT_MS - 1), false);
  assert.equal(isPendingExpired({ kind: 'newProject', at }, at + NEW_PROJECT_WAIT_MS + 1), true);
  assert.equal(isPendingExpired(null, at), true);
  assert.equal(isPendingExpired({ kind: 'gitToken' }, at), true);
});

test('pendingInput: set, renew, clear и проверка kind сохраняют поля', () => {
  const st = { pendingInput: null };
  const wait = setPendingInput(st, 'gitHostUrl', { hostKind: 'gitlab' }, 100);
  assert.deepEqual(wait, { kind: 'gitHostUrl', hostKind: 'gitlab', at: 100 });
  assert.equal(st.pendingInput, wait);
  assert.equal(pendingKindMatches(wait, ['gitToken', 'gitHostUrl']), true);
  assert.equal(pendingKindMatches(wait, 'gitHostUrl'), true);
  assert.equal(pendingKindMatches(wait, 'gitToken'), false);
  assert.equal(pendingKindMatches(null, 'gitToken'), false);
  renewPendingInput(st, wait, 200);
  assert.deepEqual(st.pendingInput, { kind: 'gitHostUrl', hostKind: 'gitlab', at: 200 });
  clearPendingInput(st);
  assert.equal(st.pendingInput, null);
});

test('pendingInput: помощники понимают старую форму записи в state', () => {
  const st = { pendingInput: null };
  st.pendingInput = { kind: 'fileContent', dir: '/p', parts: ['a.env'], replace: false, at: 500 };
  const wait = st.pendingInput;
  assert.equal(pendingKindMatches(wait, ['fileName', 'fileContent']), true);
  assert.equal(isPendingExpired(wait, 500 + FILE_WAIT_MS), false);
  assert.equal(isPendingExpired(wait, 500 + FILE_WAIT_MS + 1), true);
  renewPendingInput(st, wait, 900);
  assert.deepEqual(st.pendingInput, { kind: 'fileContent', dir: '/p', parts: ['a.env'], replace: false, at: 900 });
});

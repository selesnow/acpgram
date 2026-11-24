import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createKeyRegistry } from '../src/keyRegistry.mjs';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-keys-')));
const root = join(home, 'projects');
mkdirSync(root, { recursive: true });
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.USER_WORKSPACES = '1';
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
};
const take = () => sent.splice(0);
const press = (id, data) => ({ id: 'cb', data, message: { chat: { id }, message_id: 5 } });

const ctx = await import('../src/ctx.mjs');
const S = await import('../src/state.mjs');
const { pathToken, tokenPath, onNavCallback } = await import('../src/projectsUi.mjs');
const { remember, recall } = await import('../src/gitKeys.mjs');

const ADMIN = ctx.ADMIN_ID;
const ANN = 7101 === ADMIN ? 7201 : 7101;
const BOB = 7102 === ADMIN ? 7202 : 7102;
for (const id of [ANN, BOB]) ctx.db.upsertUser({ user_id: id, username: `u${id}`, level: 'normal', added_by: ADMIN });
S.topicsSupport.enabled = false;
const ann = S.getState(ANN, ANN);
const bob = S.getState(BOB, BOB);

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  rmSync(home, { recursive: true, force: true });
});

test('clear: при превышении лимита старые ключи становятся устаревшими', () => {
  const keys = createKeyRegistry({ limit: 2, eviction: 'clear' });
  const a = keys.add('a');
  const b = keys.add('b');
  keys.add('c');
  const d = keys.add('d');
  assert.equal(keys.get(a), undefined);
  assert.equal(keys.get(b), undefined);
  assert.equal(keys.get(d), 'd');
  assert.equal(keys.get('no-such-key'), undefined);
});

test('full: вытеснение на границе лимита (как у gitKeys)', () => {
  const keys = createKeyRegistry({ limit: 2, eviction: 'clear', full: true });
  const a = keys.add('a');
  keys.add('b');
  const c = keys.add('c');
  assert.equal(keys.get(a), undefined);
  assert.equal(keys.get(c), 'c');
});

test('oldest: вытесняется самый старый ключ, остальные продолжают работать', () => {
  const keys = createKeyRegistry({ limit: 2, eviction: 'oldest' });
  const a = keys.add('a');
  const b = keys.add('b');
  const c = keys.add('c');
  assert.equal(keys.get(a), undefined);
  assert.equal(keys.get(b), 'b');
  assert.equal(keys.get(c), 'c');
});

test('стабильный id для того же значения и устаревший ключ после удаления', () => {
  const keys = createKeyRegistry({ stable: true });
  const a = keys.add('/p');
  assert.equal(keys.add('/p'), a);
  assert.equal(keys.get(a), '/p');
  keys.drop(a);
  assert.equal(keys.get(a), undefined);
  assert.notEqual(keys.add('/p'), a);
});

test('scope state/global и разные реестры не делят одну карту', () => {
  const globalKeys = createKeyRegistry({ field: 'shared' });
  const leftKeys = createKeyRegistry({ scope: 'state', field: 'shared' });
  const rightKeys = createKeyRegistry({ scope: 'state', field: 'other' });
  const g = globalKeys.add('global');
  const l = leftKeys.add('left', {});
  const st = {};
  const r = rightKeys.add('right', st);
  assert.equal(globalKeys.get(g), 'global');
  assert.equal(leftKeys.get(g, {}), undefined);
  assert.equal(rightKeys.get(l, {}), undefined);
  assert.equal(rightKeys.get(r, st), 'right');
  assert.equal(leftKeys.get(l, st), undefined);
});

test('публичные адаптеры: tokenPath, remember/recall и namespace кнопок', () => {
  const p = join(root, String(ANN), 'site');
  const tk = pathToken(p);
  assert.equal(pathToken(p), tk);
  assert.equal(tokenPath(String(tk)), p);
  assert.equal(tokenPath('нет-такого-токена'), undefined);

  const st = {};
  const key = remember(st, { repo: 'app' });
  assert.equal(recall(st, key).repo, 'app');
  assert.equal(recall({}, key), null);
  assert.equal(recall(st, 'нет-такого-ключа'), null);
  assert.equal(tokenPath(key) === p || recall(st, tk) === null, true, 'ключи разных реестров не подменяют друг друга');

  const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
  for (const [file, prefix] of [['gitUi.mjs', 'gt:k:'], ['gitRepoUi.mjs', 'gt:cf:'], ['gitRepoUi.mjs', 'gt:bs:'], ['gitPublishUi.mjs', 'gt:pbn:']]) {
    assert.ok(src(file).includes(prefix), `${file}: namespace ${prefix} сохранён`);
  }
});

test('gitKeys: 600 clear и никогда не повторяющийся ключ для того же значения', () => {
  const st = {};
  const first = remember(st, { id: 1 });
  assert.notEqual(remember(st, { id: 1 }), first);
  for (let i = 0; i < 600; i++) remember(st, { id: i });
  assert.equal(recall(st, first), null);
  assert.ok(st.gitKeys.size <= 600);
});

test('потребитель path-token всё равно проверяет insideRoot(rootOf(userId))', async () => {
  const foreign = join(root, String(ANN), 'private');
  mkdirSync(foreign, { recursive: true });
  const tk = pathToken(foreign);
  const before = bob.project;
  take();

  await onNavCallback(bob, press(BOB, `nav:o:${tk}:0`));
  assert.equal(bob.project, before, 'открыть чужую папку по токену нельзя');
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery']);

  await onNavCallback(bob, press(BOB, `nav:s:${tk}`));
  assert.equal(bob.project, before, 'выбрать чужой проект по токену нельзя');
  assert.ok(take().length > 0, 'пользователь получил ответ');
  assert.equal(ann.project, join(root, String(ANN)), 'своя папка не пострадала');
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-cloneui-')));
const root = join(home, 'projects');
mkdirSync(root, { recursive: true });
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.USER_WORKSPACES = '1';
delete process.env.GITLAB_URL;
delete process.env.GITHUB_URL;
delete process.env.GIT_AGENT_AUTH;
delete process.env.AGENT_SANDBOX;
delete process.env.GIT_COMMAND;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.DEFAULT_LANG = 'ru';
const ADMIN = 7201;
const BOB = 7202;
process.env.ALLOWED_USER_ID = String(ADMIN);

const ctx = await import('../src/ctx.mjs');
const G = await import('../src/git.mjs');
const GCtx = await import('../src/gitCtx.mjs');
const GA = await import('../src/gitAccess.mjs');
const GK = await import('../src/gitKeys.mjs');
const { HostError } = await import('../src/gitHosts.mjs');
const UI = await import('../src/gitCloneUi.mjs');
const { t } = await import('../src/i18n.mjs');
const { errorRootOf } = await import('../src/state.mjs');
const { hCode, th } = await import('../src/ui.mjs');
const { cancelRow } = await import('../src/uiActions.mjs');

G.setGitAvailable(true);
const originalFetch = globalThis.fetch;
const token = 'ghp_test0123456789';
ctx.db.saveGitAccount(ADMIN, { host: 'github', login: 'ann-dev', name: 'Ann Dev', email: 'ann@example.com', token });

const makeState = (userId = ADMIN) => ({ userId, project: root, to: userId, gitBusy: false });
const collector = () => {
  const acks = [];
  const edits = [];
  return {
    acks,
    edits,
    ack: async (text) => (acks.push(text), text),
    edit: async (msg) => (edits.push(msg), msg),
  };
};
const jsonResponse = (data, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
});

after(() => {
  ctx.db.close();
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('gt:k: репозиторий чужого сервиса не клонируется', async () => {
  const st = makeState();
  const repo = { name: 'acme/other', url: 'https://gitlab.com/acme/other.git', private: false };
  const key = GK.remember(st, { host: 'github', repo });
  const h = collector();
  await UI.onCloneCallback(st, { action: 'k', arg: key, lang: 'ru', ack: h.ack, edit: h.edit });
  assert.deepEqual(h.acks, [t('proj.stale', 'ru')]);
  assert.equal(h.edits.length, 0);
});

test('onCloneCallback: неизвестное действие не делает ничего', async () => {
  const h = collector();
  await UI.onCloneCallback(makeState(), { action: 'x', lang: 'ru', ack: h.ack, edit: h.edit });
  assert.deepEqual(h.acks, [t('proj.stale', 'ru')]);
});

test('gt:c: один аккаунт открывает список, несколько — выбор сервиса', async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse([{ full_name: 'acme/alpha', clone_url: 'https://github.com/acme/alpha.git', private: false }]);
  try {
    const bob = makeState(BOB);
    ctx.db.saveGitAccount(BOB, { host: 'github', login: 'bob', name: 'Bob', email: 'bob@example.com', token });
    const single = collector();
    await UI.onCloneCallback(bob, { action: 'cl', lang: 'ru', ack: single.ack, edit: single.edit });
    assert.equal(single.acks.length, 1);
    assert.ok(single.edits[0].markup.inline_keyboard.flat().some((b) => b.text.includes('acme/alpha')));
    assert.equal(bob.gitRepos.host, 'github');

    ctx.db.saveGitAccount(ADMIN, { host: 'gitlab', login: 'ann', name: 'Ann', email: 'ann@example.com', token: 'glpat-test' });
    const multi = collector();
    await UI.onCloneCallback(makeState(), { action: 'cl', lang: 'ru', ack: multi.ack, edit: multi.edit });
    const keys = multi.edits[0].markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(keys.includes('gt:r:github:0'));
    assert.ok(keys.includes('gt:r:gitlab:0'));
  } finally {
    ctx.db.deleteGitAccount(ADMIN, 'gitlab');
    globalThis.fetch = fetch;
  }
});

test('gt:r: поиск сохраняется при перелистывании и сбрасывается при смене сервиса', async () => {
  const fetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(String(url)), jsonResponse([{ full_name: 'acme/alpha', clone_url: 'https://github.com/acme/alpha.git', private: false }]));
  const host = GA.findHost('github');
  const account = ctx.db.getGitAccount(ADMIN, 'github');
  try {
    const st = makeState();
    st.gitRepos = { host: 'github', page: 0, search: 'keep' };
    const h = collector();
    await UI.onCloneCallback(st, { action: 'r', pageStr: '2', lang: 'ru', host, account, ack: h.ack, edit: h.edit });
    assert.deepEqual(st.gitRepos, { host: 'github', page: 2, search: 'keep' });
    assert.ok(urls[0].includes('page=1'));
    assert.ok(h.edits[0].text.includes('«keep»'));
    st.gitRepos = { host: 'gitlab', page: 0, search: 'old' };
    await UI.onCloneCallback(st, { action: 'r', pageStr: '0', lang: 'ru', host, account, ack: h.ack, edit: h.edit });
    assert.equal(st.gitRepos.search, '');
  } finally {
    globalThis.fetch = fetch;
  }
});

test('gt:s: поиск сохраняет ожидание и отправляет подсказку с отменой', async () => {
  const fetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => (calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') }), jsonResponse({ ok: true, result: {} }));
  try {
    const st = makeState();
    const h = collector();
    await UI.onCloneCallback(st, { action: 's', lang: 'ru', host: GA.findHost('github'), account: ctx.db.getGitAccount(ADMIN, 'github'), ack: h.ack, edit: h.edit });
    assert.equal(st.pendingInput.kind, 'gitSearch');
    assert.equal(st.pendingInput.host, 'github');
    const msg = calls.find((c) => c.url.includes('/sendMessage')).body;
    assert.equal(msg.text, t('git.searchAsk', 'ru'));
    assert.deepEqual(msg.reply_markup, cancelRow('gt', 'ru'));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('onSearchInput: поиск обрезает пробелы и показывает репозитории', async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse([{ full_name: 'acme/alpha', clone_url: 'https://github.com/acme/alpha.git', private: false }]);
  try {
    const st = makeState();
    const sent = [];
    const ok = await UI.onSearchInput(st, '  alpha  ', { wait: { host: 'github' }, lang: 'ru', send: async (msg) => (sent.push(msg), msg) });
    assert.equal(ok, true);
    assert.equal(st.gitRepos.search, 'alpha');
    assert.ok(sent[0].text.includes('«alpha»'));
    assert.ok(sent[0].markup.inline_keyboard.flat().some((b) => b.text.includes('acme/alpha')));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('onSearchInput: ошибка API не роняет обработчик', async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const st = makeState();
    const sent = [];
    const ok = await UI.onSearchInput(st, 'x', { wait: { host: 'github' }, lang: 'ru', send: async (msg) => (sent.push(msg), msg) });
    assert.equal(ok, true);
    assert.equal(sent[0].text, GCtx.failText(new HostError('network', 'GitHub: network down'), 'ru', null, errorRootOf(ADMIN)));
  } finally {
    globalThis.fetch = fetch;
  }
});

test('gt:k: неудачный клон показывает ошибку и удаляет папку только внутри корня', async () => {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const name = process.argv.at(-1);',
    "const dir = path.join(process.cwd(), name);",
    "fs.mkdirSync(dir, { recursive: true });",
    "fs.writeFileSync(path.join(dir, 'partial.txt'), 'x');",
    "console.error('fatal: test');",
    'process.exitCode = 1;',
  ].join('\n');
  writeFileSync(join(root, 'clone'), script);
  const outside = join(home, 'outside-clone');
  mkdirSync(outside);
  const st = makeState();
  const repo = { name: 'acme/broken', url: 'https://github.com/acme/broken.git', private: false };
  const key = GK.remember(st, { host: 'github', repo });
  const h = collector();
  const command = process.env.GIT_COMMAND;
  process.env.GIT_COMMAND = process.execPath;
  try {
    await UI.onCloneCallback(st, { action: 'k', arg: key, lang: 'ru', ack: h.ack, edit: h.edit });
    assert.deepEqual(h.acks, [undefined]);
    assert.equal(h.edits[0].text, th('git.cloning', 'ru', { name: hCode(repo.name) }));
    const failure = new G.GitError('fatal: test', { code: 1, i18n: { key: 'err.gitExit', vars: { cmd: 'clone', code: 1 } } });
    assert.equal(h.edits.at(-1).text, GCtx.failText(failure, 'ru', null, errorRootOf(ADMIN)));
    assert.equal(existsSync(join(root, 'broken')), false);
    UI.cleanFailedClone(st, outside, root);
    assert.ok(existsSync(outside));
  } finally {
    if (command === undefined) delete process.env.GIT_COMMAND;
    else process.env.GIT_COMMAND = command;
  }
});

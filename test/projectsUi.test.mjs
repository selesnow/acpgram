import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { setCliLang } from '../src/cli-i18n.mjs';

setCliLang('ru');

const UI_URL = new URL('../src/projectsUi.mjs', import.meta.url).href;
const tempDirs = [];
after(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));

const UI_MOCK = String.raw`
import { join } from 'node:path';
const env = process.env;
const calls = [];
const push = (method, arg) => calls.push({ method, arg });
const flag = (name, fallback = false) => env[name] == null ? fallback : env[name] === '1' || env[name] === 'true';
const json = (name, fallback) => { try { return JSON.parse(env[name] ?? JSON.stringify(fallback)); } catch { return fallback; } };

export const botInfo = { username: 'test_bot' };
export const db = {
  listTopics: (userId, project, limit, offset) => {
    push('listTopics', { userId, project, limit, offset });
    const all = json('FAKE_TOPICS', []);
    return { items: all.slice(offset, offset + limit), total: all.length };
  },
  saveTopic: (userId, id, patch) => push('saveTopic', { userId, id, patch }),
  getUser: (id) => ({ id, nickname: 'nick' + id }),
};
export const langOf = () => 'ru';
export const log = (...arg) => push('log', arg);
export const say = async (to, text, opts) => push('say', { to, text, opts });
export const who = (u) => '@' + (u.nickname ?? u.nick);

export const ROOT = env.FAKE_ROOT || 'C:/root';
export const USER_WORKSPACES = flag('FAKE_WORKSPACES');
export const NEW_PROJECT_WAIT_MS = 60_000;
export const canGoUp = () => flag('FAKE_UP');
export const createDir = (dir, name, root) => {
  push('createDir', { dir, name, root });
  const mode = env.FAKE_CREATE_MODE || 'ok';
  if (mode === 'throw') throw new Error(' access denied ');
  return mode === 'null' ? null : join(dir, name);
};
export const findDirs = async () => ({ results: json('FAKE_FIND', []), truncated: flag('FAKE_TRUNCATED') });
export const folderName = (name) => /^[A-Za-z0-9_-]+$/.test(String(name ?? ''));
export const insideRoot = (p, root) => (flag('FAKE_OUTSIDE') ? null : (p ?? root));
export const isPersonalRoot = () => flag('FAKE_PERSONAL');
export const listDirs = () => json('FAKE_KIDS', []);
export const navStart = (p) => p;
export const resolveAsPath = () => null;
export const samePath = (a, b) => String(a ?? '') === String(b ?? '');
export const showPath = (p) => p;
export const gitAvailable = () => flag('FAKE_GIT');
export const errText = (e) => String(e?.message ?? e);
export const t = (key) => key;
export const th = (key, lang, vars) => key + ' ' + JSON.stringify(vars ?? {});
export const hCode = (v) => String(v);
export const hRaw = (v) => v;

export const clearPendingInput = (st) => { st.pendingInput = null; push('clearPendingInput'); };
export const setPendingInput = (st, kind, data) => {
  st.pendingInput = { kind, expires: Date.now() + NEW_PROJECT_WAIT_MS, ...data };
  push('setPendingInput', { kind, data });
};
export const pendingKindMatches = (wait, kind) => wait?.kind === kind;
export const isPendingExpired = (wait, now) => Boolean(wait?.expires && now > wait.expires);

export const endAgent = (st, reason) => push('endAgent', { reason });
export const errorRootOf = () => '';
export const isAdmin = () => flag('FAKE_ADMIN');
export const recentProjects = () => json('FAKE_RECENT', []);
export const rootOf = () => env.FAKE_ROOT || 'C:/root';
export const saveProject = (st, p) => push('saveProject', { p });
export const topicsOn = () => flag('FAKE_TOPICS_ON');
export const topicLink = (username, id) => flag('FAKE_NO_LINK') ? null : 'https://t.me/' + username + '?start=' + id;
export const newTopic = async (st, arg) => push('newTopic', arg);
export const dest = (to) => ({ chat_id: to });
export const tg = async (method, arg) => { push('tg', { method, arg }); return { message_id: 99 }; };
export const isNotModified = () => false;
export const DEFAULT_LANG = 'ru';
export const LOCALES = { ru: 'ru-RU', en: 'en-US' };
export const clamp = (page, pages) => Math.min(Math.max(Number(page) || 0, 0), Math.max(1, pages) - 1);
export const pagesOf = (total, size) => Math.max(1, Math.ceil(Number(total) / size));
export const pageInfo = (total, size, page = 0) => {
  const pages = pagesOf(total, size);
  return { page: clamp(page, pages), pages };
};
export const pageNav = (page, pages, data) => {
  const row = [];
  if (page > 0) row.push({ text: '◀', callback_data: data(page - 1) });
  if (pages >= 2) row.push({ text: page + 1 + '/' + pages, callback_data: 'nav:n' });
  if (page < pages - 1) row.push({ text: '▶', callback_data: data(page + 1) });
  return row.length ? [row] : [];
};
export const btnText = (s, limit = 60) => [...String(s ?? '')].slice(0, limit).join('');
export const cancelRow = () => ({ inline_keyboard: [[{ text: 'btn.cancel', callback_data: 'nav:x' }]] });
export const fmtDate = () => '01.01.2026';
export const cbCtx = (st, cb, options = {}) => ({
  ack: async (text) => push('ack', { text, alert: options.alert }),
  edit: async (view, markup) => push('edit', { view, markup, options }),
  messageId: cb.message?.message_id,
});
const keys = new Map();
let next = 1;
export const createKeyRegistry = () => ({
  add: (p) => { const k = String(next++); keys.set(k, p); return k; },
  get: (k) => keys.get(String(k)),
});
export const takeCalls = () => calls.splice(0, calls.length);
export const peekCall = (method) => calls.filter((c) => c.method === method);
`;

const harness = (options = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-projui-'));
  tempDirs.push(tmp);
  const mockPath = join(tmp, 'mock.mjs');
  writeFileSync(mockPath, UI_MOCK);
  const loader = join(tmp, 'loader.mjs');
  writeFileSync(loader, String.raw`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./')) return { url: ${JSON.stringify(pathToFileURL(mockPath).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`);
  const env = { ...process.env, ACPGRAM_LANG: 'ru', FAKE_ROOT: options.root ?? 'C:/root', ...options.env };
  const nodeArgs = ['--no-warnings', '--experimental-loader', pathToFileURL(loader).href];
  const run = (body) => {
    const script = join(tmp, 'case.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const U = await import(${JSON.stringify(UI_URL)});
const M = await import(${JSON.stringify(pathToFileURL(mockPath).href)});
const result = {};
${body}
result.calls = M.takeCalls();
writeFileSync(process.env.FAKE_RESULT, JSON.stringify(result));
`);
    const resultPath = join(tmp, 'result.json');
    const r = spawnSync(process.execPath, [...nodeArgs, script], { cwd: tmp, encoding: 'utf8', env: { ...env, FAKE_RESULT: resultPath }, timeout: 30_000 });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    return { result: JSON.parse(readFileSync(resultPath, 'utf8')) };
  };
  return { tmp, run };
};

const st = (extra = {}) => ({ userId: 42, chatId: 7, to: 7, project: 'C:/root/proj', topic: null, busy: false, ...extra });

test('projectTopicsView: 12 тем разбиты на страницы по 10, ссылки ведут в темы', () => {
  const topics = Array.from({ length: 12 }, (_, i) => ({ thread_id: i + 1, name: 'Тема ' + (i + 1), updated_at: '2026-01-01' }));
  const { result } = harness({ env: { FAKE_TOPICS: JSON.stringify(topics) } }).run(`
result.view = U.projectTopicsView(${JSON.stringify(st())}, ${JSON.stringify(st().project)});
`);
  assert.deepEqual(result.calls.find((c) => c.method === 'listTopics').arg, { userId: 42, project: 'C:/root/proj', limit: 10, offset: 0 });
  assert.equal(result.view.markup.inline_keyboard.filter((row) => row[0].url).length, 10);
  assert.ok(result.view.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'tpl:p:1:1')));
  assert.ok(result.view.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'tpl:n:1')));
});

test('projectTopicsView: вторая страница и режим уборки меняют кнопки', () => {
  const topics = Array.from({ length: 12 }, (_, i) => ({ thread_id: i + 1, name: 'Тема ' + (i + 1), updated_at: '2026-01-01' }));
  const { result } = harness({ env: { FAKE_TOPICS: JSON.stringify(topics) } }).run(`
result.page = U.projectTopicsView(${JSON.stringify(st())}, ${JSON.stringify(st().project)}, { page: 1 });
result.clean = U.projectTopicsView(${JSON.stringify(st())}, ${JSON.stringify(st().project)}, { page: 1, cleanup: true });
`);
  assert.equal(result.calls.filter((c) => c.method === 'listTopics' && c.arg.offset === 10).length, 2);
  assert.ok(result.page.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data === 'tpl:p:1:0')));
  assert.ok(result.clean.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data?.startsWith('tpl:h:') && b.callback_data.endsWith(':11:1'))));
  assert.ok(result.clean.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data?.startsWith('tpl:p:') && b.callback_data.endsWith(':0'))));
});

test('projectTopicsView: без тем номер之一就是 ссылка на новую тему и нет уборки', () => {
  const { result } = harness().run(`
result.view = U.projectTopicsView(${JSON.stringify(st())}, ${JSON.stringify(st().project)});
`);
  assert.equal(result.calls.find((c) => c.method === 'listTopics').arg.offset, 0);
  assert.ok(result.view.text.includes('tpl.none'));
  assert.ok(!result.view.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data?.startsWith('tpl:c:'))));
});

test('onTopicListCallback: просроченный токен не редактирует сообщение', () => {
  const { result } = harness().run(`
await U.onTopicListCallback(${JSON.stringify(st())}, { id: 'cb', data: 'tpl:p:999:0', message: { chat: { id: 7 }, message_id: 8 } });
`);
  assert.equal(result.calls.find((c) => c.method === 'ack').arg.text, 'proj.stale');
  assert.equal(result.calls.filter((c) => c.method === 'edit').length, 0);
});

test('onTopicListCallback: уборка скрывает тему и возвращает экран уборки', () => {
  const topics = [{ thread_id: 11, name: 'Тема', updated_at: '2026-01-01' }];
  const { result } = harness({ env: { FAKE_TOPICS: JSON.stringify(topics) } }).run(`
const tk = U.pathToken(${JSON.stringify(st().project)});
await U.onTopicListCallback(${JSON.stringify(st())}, { id: 'cb', data: 'tpl:h:' + tk + ':11:0', message: { chat: { id: 7 }, message_id: 8 } });
`);
  assert.deepEqual(result.calls.find((c) => c.method === 'saveTopic').arg, { userId: 42, id: 11, patch: { hidden: true } });
  assert.equal(result.calls.find((c) => c.method === 'ack').arg.text, 'tpl.hidden');
  assert.ok(result.calls.find((c) => c.method === 'edit').arg.view.markup.inline_keyboard.some((row) => row.some((b) => b.callback_data?.startsWith('tpl:h:'))));
});

test('onTopicListCallback: кнопка «новый диалог» уходит в topicsUi и не редактирует список', () => {
  const { result } = harness().run(`
const tk = U.pathToken(${JSON.stringify(st().project)});
await U.onTopicListCallback(${JSON.stringify(st())}, { id: 'cb', data: 'tpl:n:' + tk, message: { chat: { id: 7 }, message_id: 8 } });
`);
  assert.deepEqual(result.calls.find((c) => c.method === 'newTopic').arg, { project: 'C:/root/proj' });
  assert.equal(result.calls.filter((c) => c.method === 'edit').length, 0);
});

test('onProjectNameInput: неверное имя оставляет ожидание, выброс и отказ createDir не выбирают проект', () => {
  const bad = harness({ env: { FAKE_CREATE_MODE: 'ok' } }).run(`
const s = ${JSON.stringify(st({ pendingInput: { kind: 'newProject', dir: 'C:/root', expires: 9999999999999 } }))};
result.bad = await U.onProjectNameInput(s, 'имя с пробелом', 1000);
result.waitAfterBad = Boolean(s.pendingInput);
`);
  assert.equal(bad.result.bad, true);
  assert.equal(bad.result.waitAfterBad, true);
  assert.ok(bad.result.calls.some((c) => c.method === 'say' && c.arg.text.includes('proj.newBad')));

  const thrown = harness({ env: { FAKE_CREATE_MODE: 'throw', FAKE_ADMIN: '1' } }).run(`
const s = ${JSON.stringify(st({ pendingInput: { kind: 'newProject', dir: 'C:/root', expires: 9999999999999 } }))};
result.thrown = await U.onProjectNameInput(s, 'good_name', 1000);
result.waitAfterThrow = Boolean(s.pendingInput);
`);
  assert.equal(thrown.result.thrown, true);
  assert.equal(thrown.result.waitAfterThrow, false);
  assert.ok(thrown.result.calls.some((c) => c.method === 'say' && c.arg.text.includes('proj.newFail')), JSON.stringify(thrown.result.calls));

  const refused = harness({ env: { FAKE_CREATE_MODE: 'null', FAKE_ADMIN: '1' } }).run(`
const s = ${JSON.stringify(st({ pendingInput: { kind: 'newProject', dir: 'C:/root', expires: 9999999999999 } }))};
result.refused = await U.onProjectNameInput(s, 'good_name', 1000);
`);
  assert.equal(refused.result.refused, true);
  assert.ok(refused.result.calls.some((c) => c.method === 'say' && c.arg.text.includes('proj.noFolder')));
  assert.equal(refused.result.calls.filter((c) => c.method === 'saveProject').length, 0);
});

test('onProjectNameInput: истёкшее и чужое ожидание не перехватывают текст', () => {
  const { result } = harness().run(`
const expired = ${JSON.stringify(st({ pendingInput: { kind: 'newProject', dir: 'C:/root', expires: 500 } }))};
result.expired = await U.onProjectNameInput(expired, 'name', 1000);
result.afterExpired = Boolean(expired.pendingInput);
const other = ${JSON.stringify(st({ pendingInput: { kind: 'newTopic', dir: 'C:/root', expires: 9999999999999 } }))};
result.other = await U.onProjectNameInput(other, 'name', 1000);
`);
  assert.equal(result.expired, false);
  assert.equal(result.afterExpired, false);
  assert.equal(result.other, false);
  assert.equal(result.calls.filter((c) => c.method === 'clearPendingInput').length, 1);
  assert.equal(result.calls.filter((c) => c.method === 'createDir').length, 0);
});

test('onProjectNameInput: удачная папка становится проектом и закрывает агента', () => {
  const { result } = harness({ env: { FAKE_ADMIN: '1' } }).run(`
const s = ${JSON.stringify(st({ pendingInput: { kind: 'newProject', dir: 'C:/root', expires: 9999999999999 } }))};
result.ok = await U.onProjectNameInput(s, 'new_project', 1000);
`);
  assert.equal(result.ok, true);
  assert.deepEqual(result.calls.find((c) => c.method === 'createDir').arg, { dir: 'C:/root', name: 'new_project', root: 'C:/root' });
  assert.equal(result.calls.find((c) => c.method === 'saveProject')?.arg.p, join('C:/root', 'new_project'), JSON.stringify(result.calls));
  assert.equal(result.calls.find((c) => c.method === 'endAgent').arg.reason, 'project');
  assert.equal(result.calls.find((c) => c.method === 'say').arg.text.includes('proj.set'), true);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BOT_COMMANDS, COMMANDS, configureBotRouting, createBotRouting, handleUpdate, hasAccess } from '../src/botRouting.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ADMIN = 100;
const USER = 200;
const STRANGER = 300;
const t = (key, _lang, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const from = (id, language_code = 'ru') => ({ id, username: `u${id}`, first_name: `U${id}`, language_code });
const message = (id, text, extra = {}) => ({ message: { from: from(id), chat: { id, type: 'private' }, text, message_id: 7, ...extra }, update_id: id });
const callback = (id, data, extra = {}) => ({ callback_query: { id: 'cb', from: from(id), data, message: { chat: { id, type: 'private' }, message_id: 9 }, ...extra }, update_id: id });
const first = (calls, name) => calls.find((c) => c[0] === name);
const all = (calls, name) => calls.filter((c) => c[0] === name);
const names = (calls) => calls.map((c) => c[0]);

const depsFor = (overrides = {}) => {
  const calls = [];
  const users = new Map([
    [ADMIN, { status: 'active', level: 'full' }],
    [USER, { status: 'active', level: 'normal' }],
  ]);
  const states = new Map();
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const asyncRec = (name, result = false) => async (...args) => { calls.push([name, ...args]); return result; };
  const db = {
    getUser: (id) => {
      calls.push(['getUser', id]);
      return users.get(id) ?? null;
    },
    touchUser: rec('touchUser'),
    getSetting: () => null,
    setSetting: rec('setSetting'),
    getTopic: () => null,
    saveTopic: rec('saveTopic'),
    deleteTopic: rec('deleteTopic'),
  };
  const deps = {
    ADMIN_ID: ADMIN,
    ADMIN_SANDBOX: false,
    DOCS_URL: 'https://docs.example',
    IMAGE_BLOCK_MAX: 1000,
    LANGS: { en: 'English', ru: 'Русский', uk: 'Українська' },
    LANG_CODES: ['en', 'ru', 'uk'],
    LANG_PICK: 'PICK_LANG',
    MAX_FILE_BYTES: 1000,
    MIN_FREE_MB: 100,
    UPLOADS_QUOTA_MB: 0,
    UPDATE_LIMIT: 20,
    UPDATE_WINDOW_MS: 10_000,
    adminCommand: rec('adminCommand'),
    archiveKind: () => null,
    choiceName: () => 'Auto',
    clearPendingInput: rec('clearPendingInput'),
    closeSession: rec('closeSession'),
    createAlbumBuffer: () => ({ add: async (key, item) => { calls.push(['albums.add', key, item.msg.message_id]); } }),
    createQueue: () => ({ add: async (fn) => fn() }),
    db,
    deleteTopic: asyncRec('deleteTopic'),
    describeAttachment: () => null,
    directorySize: () => 0,
    docsMenuButton: () => ({ type: 'link' }),
    downloadFile: asyncRec('downloadFile', Buffer.from('data')),
    dropPermissions: rec('dropPermissions'),
    dropQueue: () => false,
    effectiveSelection: () => ({ model: null }),
    endAgent: rec('endAgent'),
    engineOf: () => ({ label: 'Gemini' }),
    enqueue: rec('enqueue'),
    errorRootOf: () => null,
    errText: (e) => e.message,
    extractArchiveAsync: asyncRec('extractArchiveAsync', { files: [], skipped: 0 }),
    findState: () => null,
    fitsUpload: () => true,
    forceStopAfter: rec('forceStopAfter'),
    freeBytes: () => 1000,
    getState: (userId, chatId, threadId) => {
      const key = `${userId}:${chatId}:${threadId ?? ''}`;
      if (!states.has(key)) states.set(key, { userId, chatId, threadId, to: chatId, busy: false, agent: null, project: '/p' });
      return states.get(key);
    },
    handleEngine: rec('handleEngine'),
    handleFiles: rec('handleFiles'),
    handleGit: rec('handleGit'),
    handleModel: rec('handleModel'),
    handleProject: rec('handleProject'),
    handleSessions: rec('handleSessions'),
    handleTopics: rec('handleTopics'),
    handleUnknownUser: rec('handleUnknownUser'),
    helpMarkup: () => ({ inline_keyboard: [[{ text: 'docs', url: 'https://docs.example' }]] }),
    isAdmin: (id) => id === ADMIN,
    isAutoTopicCommand: () => false,
    isImageMime: () => false,
    langOf: () => 'en',
    levelLabel: () => 'read',
    log: rec('log'),
    looksLikeSecret: () => false,
    nearCommand: () => null,
    newTopic: rec('newTopic'),
    normLang: (q) => (['en', 'ru', 'uk'].includes(q) ? q : null),
    noteTgLang: rec('noteTgLang'),
    onAdminCallback: rec('onAdminCallback'),
    onAskCallback: rec('onAskCallback'),
    onEngineCallback: rec('onEngineCallback'),
    onFileInput: asyncRec('onFileInput'),
    onFilesCallback: rec('onFilesCallback'),
    onFileUpload: asyncRec('onFileUpload'),
    onGitCallback: rec('onGitCallback'),
    onGitInput: asyncRec('onGitInput'),
    onModelCallback: rec('onModelCallback'),
    onNavCallback: rec('onNavCallback'),
    onPermissionCallback: rec('onPermissionCallback'),
    onProjectNameInput: asyncRec('onProjectNameInput'),
    onQueueCallback: rec('onQueueCallback'),
    onSessionCallback: rec('onSessionCallback'),
    onTopicListCallback: rec('onTopicListCallback'),
    onTopicsCallback: rec('onTopicsCallback'),
    onWidgetQuery: rec('onWidgetQuery'),
    quoteOf: (msg) => msg.quote?.text ?? null,
    runTurn: rec('runTurn'),
    saveUpload: asyncRec('saveUpload', '/tmp/x'),
    say: rec('say'),
    sendRich: asyncRec('sendRich'),
    setLang: rec('setLang'),
    startView: (view) => view,
    t,
    tg: (method, body) => {
      calls.push(['tg', method, body]);
      return Promise.resolve({});
    },
    topicInfoOf: () => null,
    topicsOn: () => false,
    topicsSupport: { enabled: false, usersCreate: false },
    unsupportedKind: () => null,
    uploadsDir: () => '/tmp',
    userPath: () => '/p',
    welcomeNote: () => 'WELCOME',
    ...overrides,
  };
  return { deps, calls, users, states };
};

test('импорт botRouting.mjs: без опроса, .env, process.exit и сети', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-routing-import-'));
  const target = pathToFileURL(join(root, 'src', 'botRouting.mjs')).href;
  const code = `
    globalThis.fetch = () => { throw new Error('network'); };
    process.exit = () => { throw new Error('exit'); };
    process.loadEnvFile = () => { throw new Error('env'); };
    const m = await import(${JSON.stringify(target)});
    if (typeof m.handleUpdate !== 'function' || typeof m.hasAccess !== 'function' || typeof m.handleText !== 'function' || !Array.isArray(m.COMMANDS)) throw new Error('exports');
  `;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ACPGRAM_HOME: home, TELEGRAM_BOT_TOKEN: '', ALLOWED_USER_ID: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(home, 'data')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('COMMANDS и BOT_COMMANDS: порядок, флаги, псевдонимы', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ['active', 'users', 'invite', 'usage', 'project', 'files', 'git', 'engine', 'model', 'new', 'sessions', 'stop', 'close', 'topics', 'language', 'help', 'start']);
  assert.deepEqual(COMMANDS.filter((c) => c.admin).map((c) => c.name), ['active', 'users', 'invite', 'usage']);
  assert.deepEqual(COMMANDS.find((c) => c.name === 'close').aliases, ['exit']);
  assert.deepEqual(COMMANDS.find((c) => c.name === 'language').aliases, ['lang']);
  assert.equal(BOT_COMMANDS.has('exit'), true);
  assert.equal(BOT_COMMANDS.has('lang'), true);
});

test('hasAccess: администратор и активный сотрудник — да, чужой и отозванный — нет', () => {
  const { deps, users } = depsFor();
  users.set(400, { status: 'blocked' });
  const routing = createBotRouting(deps);
  assert.equal(routing.hasAccess(ADMIN), true);
  assert.equal(routing.hasAccess(USER), true);
  assert.equal(routing.hasAccess(STRANGER), false);
  assert.equal(routing.hasAccess(400), false);
  configureBotRouting(deps);
  assert.equal(hasAccess(ADMIN), true);
  assert.equal(hasAccess(STRANGER), false);
});

test('чужой пользователь: текст уходит администратору, кнопка отклоняется, виджет игнорируется', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  await routing.handleUpdate(message(STRANGER, 'нужен доступ'));
  assert.deepEqual(names(calls), ['noteTgLang', 'getUser', 'log', 'handleUnknownUser']);
  assert.deepEqual(first(calls, 'noteTgLang'), ['noteTgLang', STRANGER, 'ru']);
  assert.deepEqual(first(calls, 'handleUnknownUser'), ['handleUnknownUser', from(STRANGER), STRANGER, 'нужен доступ']);
  assert.equal(first(calls, 'touchUser'), undefined);
  calls.length = 0;

  await routing.handleUpdate(callback(STRANGER, 'ui:help'));
  assert.deepEqual(first(calls, 'tg'), ['tg', 'answerCallbackQuery', { callback_query_id: 'cb', text: t('access.denied', 'en') }]);
  assert.equal(first(calls, 'handleUnknownUser'), undefined);
  calls.length = 0;

  await routing.handleUpdate({ widget_query: { from: from(STRANGER), chat: { type: 'private' }, data: 'x' }, update_id: 1 });
  assert.equal(first(calls, 'onWidgetQuery'), undefined);
});

test('обычный пользователь: сперва проверка доступа, затем touchUser, темы и маршрутизация', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);
  await routing.handleUpdate(message(USER, 'привет', { quote: { text: 'цитата' } }));
  assert.deepEqual(names(calls), ['noteTgLang', 'getUser', 'noteTgLang', 'touchUser', 'onProjectNameInput', 'onFileInput', 'onGitInput', 'runTurn']);
  assert.deepEqual(first(calls, 'touchUser'), ['touchUser', USER, `u${USER}`, `U${USER}`]);
  assert.deepEqual(first(calls, 'runTurn'), ['runTurn', st, 'привет', { quote: 'цитата' }]);
});

test('порядок проверок: лимит, остановка генерации, личные чаты и боты', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  for (let i = 0; i < 20; i++) await routing.handleUpdate(message(USER, `m${i}`));
  calls.length = 0;
  await routing.handleUpdate(message(USER, 'm20'));
  assert.deepEqual(calls, [], '21-е обновление за 10 секунд отклоняется до всех проверок');

  const { deps: d2, calls: c2, states: s2 } = depsFor();
  let cancelled = 0;
  const st = d2.getState(USER, USER, null);
  st.busy = true;
  st.agent = { cancel: () => cancelled++ };
  s2.set(`${USER}:${USER}:`, st);
  const routing2 = createBotRouting({ ...d2, findState: (chatId) => chatId === USER ? st : null });
  await routing2.handleUpdate({ stopped_message_generation: { chat: { id: USER } }, update_id: 1 });
  assert.equal(cancelled, 1);
  assert.deepEqual(c2, [['dropPermissions', st]]);

  const { deps: d3, calls: c3 } = depsFor();
  const routing3 = createBotRouting(d3);
  await routing3.handleUpdate({ message: { from: from(USER), chat: { id: -1, type: 'group' }, text: 'x' }, update_id: 1 });
  await routing3.handleUpdate({ message: { from: { id: USER, is_bot: true }, chat: { id: USER, type: 'private' }, text: 'x' }, update_id: 2 });
  await routing3.handleUpdate(callback(USER, 'ui:help', { message: { chat: { id: USER, type: 'group' }, message_id: 9 } }));
  assert.deepEqual(c3, []);
});

test('команды: admin-only недоступна сотруднику, доступна администратору', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);
  await routing.handleText(st, '/users');
  assert.deepEqual(first(calls, 'clearPendingInput'), ['clearPendingInput', st]);
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('admin.only', 'en')]);
  assert.equal(first(calls, 'adminCommand'), undefined);
  calls.length = 0;

  await routing.handleUpdate(message(ADMIN, '/users arg'));
  assert.deepEqual(first(calls, 'adminCommand'), ['adminCommand', ADMIN, '/users']);
  assert.equal(first(calls, 'say'), undefined);
});

test('handleText: unknown command goes to agent, typo offers buttons, secret is deleted', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);
  await routing.handleText(st, '/compact');
  assert.deepEqual(first(calls, 'runTurn'), ['runTurn', st, '/compact', { quote: null }]);

  calls.length = 0;
  const typoDeps = { ...deps, nearCommand: (name, cmds) => name === 'modle' && cmds.includes('model') ? 'model' : null };
  const typo = createBotRouting(typoDeps);
  await typo.handleText(st, '/modle');
  assert.deepEqual(first(calls, 'say'), [
    'say', USER, t('cmd.typo', 'en', { cmd: 'modle', guess: 'model' }),
    { reply_markup: { inline_keyboard: [[{ text: '/model', callback_data: 'ui:model' }], [{ text: t('cmd.sendAsIs', 'en'), callback_data: 'cmd:raw' }]] } },
  ]);
  assert.equal(st.rawCommand, '/modle');
  assert.equal(first(calls, 'runTurn'), undefined);

  calls.length = 0;
  const secret = createBotRouting({ ...deps, looksLikeSecret: () => true });
  await secret.handleText(st, 'токен', { messageId: 7 });
  assert.deepEqual(first(calls, 'tg'), ['tg', 'deleteMessage', { chat_id: USER, message_id: 7 }]);
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('secret.detected', 'en')]);
});

test('adm:-кнопки: администратор получает обработчик, чужой — только пустой answer', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  const cb = callback(ADMIN, 'adm:g:200:normal').callback_query;
  await routing.handleUpdate({ callback_query: cb, update_id: 1 });
  assert.deepEqual(first(calls, 'onAdminCallback'), ['onAdminCallback', cb]);
  assert.equal(first(calls, 'tg'), undefined);
  calls.length = 0;

  await routing.handleUpdate(callback(USER, 'adm:g:200:normal'));
  assert.deepEqual(first(calls, 'tg'), ['tg', 'answerCallbackQuery', { callback_query_id: 'cb' }]);
  assert.equal(first(calls, 'onAdminCallback'), undefined);
});

test('callback-кнопки: каждый префикс идёт своему обработчику', async () => {
  const cases = [
    ['tpc:', 'onTopicsCallback'], ['tpl:', 'onTopicListCallback'], ['nav:', 'onNavCallback'],
    ['fl:', 'onFilesCallback'], ['gt:', 'onGitCallback'], ['perm:', 'onPermissionCallback'],
    ['ask:', 'onAskCallback'], ['q:', 'onQueueCallback'], ['ses:', 'onSessionCallback'],
    ['eng:', 'onEngineCallback'], ['mdl:', 'onModelCallback'],
  ];
  for (const [prefix, handler] of cases) {
    const { deps, calls } = depsFor();
    const routing = createBotRouting(deps);
    await routing.handleUpdate(callback(USER, `${prefix}1`));
    assert.equal(all(calls, handler).length, 1, prefix);
    assert.equal(calls.filter((c) => c[0].startsWith('on') && c[0] !== handler).length, 0, prefix);
  }
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  await routing.handleUpdate(callback(USER, 'zz:1'));
  assert.equal(calls.some((c) => c[0].startsWith('on')), false);
});

test('кнопки экранов и меню: ui:, lang:, cmd:raw, wid:model', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  await routing.handleUpdate(callback(USER, 'ui:project'));
  assert.equal(all(calls, 'tg').some((c) => c[1] === 'answerCallbackQuery'), true);
  assert.deepEqual(first(calls, 'handleProject'), ['handleProject', deps.getState(USER, USER, null), undefined]);
  calls.length = 0;

  await routing.handleUpdate(callback(USER, 'lang:ru'));
  assert.deepEqual(first(calls, 'setLang'), ['setLang', USER, 'ru']);
  assert.deepEqual(all(calls, 'tg').find((c) => c[1] === 'editMessageText'), ['tg', 'editMessageText', { chat_id: USER, message_id: 9, text: t('lang.set', 'ru', { name: 'Русский' }), reply_markup: { inline_keyboard: [] } }]);
  calls.length = 0;

  const st = deps.getState(USER, USER, null);
  st.rawCommand = '/compact';
  await routing.handleUpdate(callback(USER, 'cmd:raw'));
  assert.equal(st.rawCommand, null);
  assert.deepEqual(first(calls, 'runTurn'), ['runTurn', st, '/compact', {}]);
  calls.length = 0;

  await routing.handleUpdate(callback(USER, 'wid:model'));
  assert.deepEqual(first(calls, 'handleModel'), ['handleModel', deps.getState(USER, USER, null), '', { classic: true }]);
});

test('вложения и неподдерживаемые сообщения не уходят агенту зря', async () => {
  const { deps, calls } = depsFor({ unsupportedKind: () => 'voice' });
  const routing = createBotRouting(deps);
  await routing.handleUpdate({ message: { from: from(USER), chat: { id: USER, type: 'private' }, voice: {}, message_id: 7 }, update_id: 1 });
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('msg.unsupported', 'en')]);

  const { deps: d2, calls: c2 } = depsFor();
  d2.onFileUpload = async (...args) => { c2.push(['onFileUpload', ...args]); return true; };
  const routing2 = createBotRouting(d2);
  await routing2.handleUpdate({ message: { from: from(USER), chat: { id: USER, type: 'private' }, document: {}, message_id: 7 }, update_id: 1 });
  assert.equal(first(c2, 'runTurn'), undefined);
  assert.equal(all(c2, 'onFileUpload').length, 1);
});

test('configureBotRouting: публичный handleUpdate работает на настроенных зависимостях', async () => {
  const { deps, calls } = depsFor();
  configureBotRouting(deps);
  await handleUpdate(message(USER, 'привет'));
  assert.equal(all(calls, 'runTurn').length, 1);
});

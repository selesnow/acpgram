import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BOT_COMMANDS, COMMANDS, configureBotRouting, createBotRouting, handleUpdate, hasAccess } from '../src/botRouting.mjs';
import { removeReplyKeyboard, replyCommandOf, replyKeyboard } from '../src/ui.mjs';
import { t as realT } from '../src/i18n.mjs';

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
  const settings = new Map();
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const asyncRec = (name, result = false) => async (...args) => { calls.push([name, ...args]); return result; };
  const db = {
    getUser: (id) => {
      calls.push(['getUser', id]);
      return users.get(id) ?? null;
    },
    touchUser: rec('touchUser'),
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => {
      calls.push(['setSetting', key, value]);
      settings.set(key, value);
    },
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
      if (!states.has(key)) states.set(key, { userId, chatId, threadId, topic: threadId ?? 0, to: threadId ? { chat_id: chatId, message_thread_id: threadId } : chatId, busy: false, agent: null, project: '/p' });
      return states.get(key);
    },
    handleBotInvite: rec('handleBotInvite'),
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
    removeReplyKeyboard: () => removeReplyKeyboard(),
    replyCommandOf: (text) => replyCommandOf(text),
    replyKeyboard: (lang, opts) => replyKeyboard(lang, opts),
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
  assert.deepEqual(COMMANDS.map((c) => c.name), ['active', 'users', 'invite', 'usage', 'project', 'files', 'git', 'engine', 'model', 'new', 'sessions', 'stop', 'close', 'topics', 'language', 'keyboard', 'help', 'start']);
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

  await routing.handleUpdate({ message: { chat: { id: STRANGER, type: 'private' }, from: from(STRANGER), write_access_allowed: { inviter: from(ADMIN) } } });
  assert.deepEqual(first(calls, 'handleBotInvite'), ['handleBotInvite', from(STRANGER), STRANGER, from(ADMIN)]);
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

test('/start: reply-клавиатура подключается отдельным sendMessage один раз на каждый диалог/топик', async () => {
  const { deps, calls } = depsFor();
  deps.langOf = () => 'ru';
  const routing = createBotRouting(deps);
  const stGeneral = deps.getState(USER, USER, null);

  await routing.handleText(stGeneral, '/start');
  const firstSend = first(calls, 'sendRich');
  assert.ok(firstSend, 'приветствие отправлено');
  assert.equal(firstSend[1], USER);
  assert.equal(firstSend[3], undefined, 'в rich-сообщение reply_markup не примешивается');
  assert.deepEqual(first(calls, 'say'), [
    'say', USER, t('reply.keyboardOn', 'ru'),
    { reply_markup: replyKeyboard('ru', { admin: false, topics: null }) },
  ]);
  assert.deepEqual(first(calls, 'setSetting'), ['setSetting', `replyKb:${USER}:0`, '1']);

  calls.length = 0;
  await routing.handleText(stGeneral, '/start');
  assert.ok(first(calls, 'sendRich'), 'повторное приветствие отправлено');
  assert.equal(first(calls, 'say'), undefined, 'повторный /start в General клавиатуру не дёргает');
  assert.equal(first(calls, 'setSetting'), undefined);

  calls.length = 0;
  const stTopic = deps.getState(USER, USER, 55);
  await routing.handleText(stTopic, '/start');
  assert.deepEqual(first(calls, 'say'), [
    'say', { chat_id: USER, message_thread_id: 55 }, t('reply.keyboardOn', 'ru'),
    { reply_markup: replyKeyboard('ru', { admin: false, topics: null }) },
  ]);
  assert.deepEqual(first(calls, 'setSetting'), ['setSetting', `replyKb:${USER}:55`, '1']);
});

test('кнопки reply-меню: подписи выполняют команды на любом языке, обычный текст уходит агенту', async () => {
  const { deps, calls } = depsFor();
  deps.langOf = () => 'en';
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);

  await routing.handleText(st, realT('start.btn.files', 'ru'));
  assert.deepEqual(first(calls, 'clearPendingInput'), ['clearPendingInput', st]);
  assert.deepEqual(first(calls, 'handleFiles'), ['handleFiles', st]);
  assert.equal(first(calls, 'runTurn'), undefined);
  calls.length = 0;

  await routing.handleText(st, 'обычный запрос агенту');
  assert.deepEqual(first(calls, 'runTurn'), ['runTurn', st, 'обычный запрос агенту', { quote: null }]);
  calls.length = 0;

  await routing.handleText(st, realT('reply.usage', 'ru'));
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('admin.only', 'en')]);
});

test('смена языка не подключает reply-клавиатуру повторно и не шлёт ложное уведомление', async () => {
  const { deps, calls } = depsFor();
  deps.langOf = () => 'en';
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);
  await routing.handleText(st, '/language uk');
  assert.deepEqual(first(calls, 'setLang'), ['setLang', USER, 'uk']);
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('lang.set', 'uk', { name: 'Українська' })]);

  calls.length = 0;
  await routing.handleUpdate(callback(USER, 'lang:ru'));
  assert.deepEqual(first(calls, 'setLang'), ['setLang', USER, 'ru']);
  assert.equal(first(calls, 'say'), undefined, 'при смене языка кнопкой ложное reply.updated не отправляется');
});

test('/keyboard [off]: подключает, отключает (remove_keyboard) и управляет автоподключением', async () => {
  const { deps, calls } = depsFor();
  deps.langOf = () => 'ru';
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);

  await routing.handleText(st, '/keyboard');
  assert.deepEqual(first(calls, 'say'), [
    'say', USER, t('reply.keyboardOn', 'ru'),
    { reply_markup: replyKeyboard('ru', { admin: false, topics: null }) },
  ]);
  assert.deepEqual(all(calls, 'setSetting'), [
    ['setSetting', `replyKbOff:${USER}`, ''],
    ['setSetting', `replyKb:${USER}:0`, '1'],
  ]);

  calls.length = 0;
  await routing.handleText(st, '/keyboard off');
  assert.deepEqual(first(calls, 'say'), [
    'say', USER, t('reply.keyboardOff', 'ru'),
    { reply_markup: { remove_keyboard: true } },
  ]);
  assert.deepEqual(first(calls, 'setSetting'), ['setSetting', `replyKbOff:${USER}`, '1']);

  calls.length = 0;
  const stNewTopic = deps.getState(USER, USER, 99);
  await routing.handleText(stNewTopic, '/start');
  assert.equal(first(calls, 'say'), undefined, 'при /keyboard off автоподключение в новых темах отключено');

  calls.length = 0;
  await routing.handleText(stNewTopic, '/keyboard');
  assert.deepEqual(first(calls, 'say'), [
    'say', { chat_id: USER, message_thread_id: 99 }, t('reply.keyboardOn', 'ru'),
    { reply_markup: replyKeyboard('ru', { admin: false, topics: null }) },
  ]);
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

test('команды /language, /start, /stop, /close, /new: аргументы и состояния', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  const st = deps.getState(USER, USER, null);
  await routing.handleText(st, '/language ru');
  assert.deepEqual(first(calls, 'setLang'), ['setLang', USER, 'ru']);
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('lang.set', 'ru', { name: 'Русский' })]);
  calls.length = 0;

  await routing.handleText(st, '/language xx');
  assert.deepEqual(first(calls, 'say'), [
    'say', USER, deps.LANG_PICK,
    { reply_markup: { inline_keyboard: [['en', 'ru', 'uk'].map((code) => ({ text: deps.LANGS[code], callback_data: `lang:${code}` }))] } },
  ]);
  calls.length = 0;

  await routing.handleText(st, '/start');
  assert.equal(first(calls, 'sendRich').length, 3);
  calls.length = 0;

  await routing.handleText(st, '/stop');
  assert.deepEqual(first(calls, 'say'), ['say', USER, t('stop.none', 'en')]);
  const stopped = depsFor({ dropQueue: () => true });
  const stStopped = stopped.deps.getState(USER, USER, null);
  await createBotRouting(stopped.deps).handleText(stStopped, '/stop');
  assert.equal(first(stopped.calls, 'say'), undefined);
  calls.length = 0;

  const busy = depsFor();
  const stBusy = busy.deps.getState(USER, USER, null);
  stBusy.busy = true;
  let cancelled = 0;
  stBusy.agent = { cancel: () => cancelled++ };
  await createBotRouting(busy.deps).handleText(stBusy, '/stop');
  assert.equal(cancelled, 1);
  assert.equal(first(busy.calls, 'forceStopAfter')[1], stBusy);
  assert.equal(first(busy.calls, 'dropPermissions')[1], stBusy);

  const closing = depsFor({ closeSession: () => false });
  const stClosing = closing.deps.getState(USER, USER, null);
  await createBotRouting(closing.deps).handleText(stClosing, '/close');
  assert.deepEqual(first(closing.calls, 'say'), ['say', USER, t('close.none', 'en')]);
  const closed = depsFor({ closeSession: () => true });
  const stClosed = closed.deps.getState(USER, USER, null);
  await createBotRouting(closed.deps).handleText(stClosed, '/close');
  assert.ok(first(closed.calls, 'say')[2].startsWith('close.done'));
  assert.deepEqual(first(closed.calls, 'say')[3], { reply_markup: { inline_keyboard: [[{ text: t('btn.sessions', 'en'), callback_data: 'ui:sessions' }]] } });

  const topic = depsFor({ topicsOn: () => true });
  const stTopic = topic.deps.getState(USER, USER, null);
  await createBotRouting(topic.deps).handleText(stTopic, '/new');
  assert.deepEqual(first(topic.calls, 'newTopic'), ['newTopic', stTopic]);
  const newBusy = depsFor();
  const stNewBusy = newBusy.deps.getState(USER, USER, null);
  stNewBusy.busy = true;
  await createBotRouting(newBusy.deps).handleText(stNewBusy, '/new');
  assert.equal(first(newBusy.calls, 'say')[2], t('busy.stop', 'en'));
  const newFree = depsFor();
  const stNewFree = newFree.deps.getState(USER, USER, null);
  await createBotRouting(newFree.deps).handleText(stNewFree, '/new');
  assert.deepEqual(first(newFree.calls, 'endAgent'), ['endAgent', stNewFree, 'new']);
  assert.ok(first(newFree.calls, 'say')[2].startsWith('new.done'));
});

test('setupCommands и sweepUpdateLimits: меню всех языков и уборка старых лимитов', async () => {
  const { deps, calls } = depsFor();
  const routing = createBotRouting(deps);
  await routing.setupCommands();
  const tg = all(calls, 'tg');
  assert.equal(tg.filter((c) => c[1] === 'setMyCommands').length, 6);
  const adminMenu = tg.find((c) => c[1] === 'setMyCommands' && c[2]?.scope?.chat_id === ADMIN)?.[2]?.commands?.map((x) => x.command) ?? [];
  const userMenu = tg.find((c) => c[1] === 'setMyCommands' && c[2]?.scope?.type === 'default')?.[2]?.commands?.map((x) => x.command) ?? [];
  assert.ok(adminMenu.includes('topics'), 'администратору /topics доступен даже при выключенных темах');
  assert.ok(!userMenu.includes('topics'), 'обычным пользователям /topics скрыт при выключенных темах');
  assert.ok(userMenu.includes('keyboard'), '/keyboard виден в меню команд');
  assert.deepEqual(tg.at(-1), ['tg', 'setChatMenuButton', { menu_button: { type: 'link' } }]);

  const limited = depsFor({ UPDATE_WINDOW_MS: 1 });
  const r = createBotRouting(limited.deps);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 21; i++) assert.equal(r.tooManyUpdates(USER), i === 20);
    now += 2;
    assert.equal(r.sweepUpdateLimits(), 1);
    assert.equal(r.sweepUpdateLimits(), 0);
  } finally {
    Date.now = realNow;
  }
});

test('служебные сообщения тем: создание вручную (с клавиатурой), неявное создание, переименование и перенос команды/кнопки в General', async () => {
  const { deps, calls } = depsFor({
    topicsOn: () => true,
    topicsSupport: { enabled: true, usersCreate: true },
    isAutoTopicCommand: (msg, _known, _cmds, isBtn) => Boolean(msg.text && (msg.text.startsWith('/') || isBtn?.(msg.text.trim()))),
    topicInfoOf: (msg) => (msg.forum_topic_created?.is_name_implicit ? { name: 'Авто', implicit: true } : { name: 'Новая', implicit: false }),
  });
  const routing = createBotRouting(deps);
  await routing.handleUpdate(message(USER, '', { is_topic_message: true, message_thread_id: 55, forum_topic_created: {} }));
  assert.deepEqual(first(calls, 'saveTopic'), ['saveTopic', USER, 55, { name: 'Новая', named: true }]);
  assert.deepEqual(first(calls, 'say'), [
    'say', { chat_id: USER, message_thread_id: 55 },
    t('topics.hello', 'en', { engine: 'Gemini', project: '/p' }),
    { reply_markup: replyKeyboard('en', { admin: false, topics: 'on' }) },
  ]);
  assert.deepEqual(first(calls, 'setSetting'), ['setSetting', `replyKb:${USER}:55`, '1']);
  assert.equal(first(calls, 'runTurn'), undefined);
  calls.length = 0;

  await routing.handleUpdate(message(USER, '', { is_topic_message: true, message_thread_id: 56, forum_topic_created: { is_name_implicit: true } }));
  assert.equal(first(calls, 'say'), undefined, 'неявно созданной теме приветствие не шлётся');
  calls.length = 0;

  await routing.handleUpdate(message(USER, '', { is_topic_message: true, message_thread_id: 55, forum_topic_edited: { name: 'Имя' } }));
  assert.deepEqual(first(calls, 'saveTopic'), ['saveTopic', USER, 55, { name: 'Имя', named: true }]);
  assert.equal(first(calls, 'runTurn'), undefined);
  calls.length = 0;

  await routing.handleUpdate(message(USER, '/model', { is_topic_message: true, message_thread_id: 77 }));
  assert.equal(first(calls, 'deleteTopic')[1], USER);
  assert.equal(first(calls, 'runTurn'), undefined);
  assert.equal(first(calls, 'handleModel')[1], deps.getState(USER, USER, null));
  calls.length = 0;

  await routing.handleUpdate(message(USER, realT('start.btn.project', 'ru'), { is_topic_message: true, message_thread_id: 79 }));
  assert.equal(first(calls, 'deleteTopic')[2], 79, 'авто-тема от кнопки reply-клавиатуры удаляется');
  assert.equal(first(calls, 'handleProject')[1], deps.getState(USER, USER, null), 'кнопка выполняется в General');

  const failed = depsFor({ topicsOn: () => true, isAutoTopicCommand: () => true, deleteTopic: async () => { throw new Error('нет прав'); } });
  await createBotRouting(failed.deps).handleUpdate(message(USER, 'привет', { is_topic_message: true, message_thread_id: 78 }));
  assert.equal(all(failed.calls, 'runTurn').length, 1);
  assert.ok(failed.calls.some((c) => c[0] === 'log' && String(c[1]).includes('удаление темы под команду')));
});

test('receiveFile: лимит по размеру, квота и сбой скачивания не создают файл', async () => {
  const meta = { id: 'f1', name: 'a.txt', mime: 'text/plain', size: 2000 };
  const big = depsFor({ describeAttachment: () => meta });
  await createBotRouting(big.deps).handleUpdate(message(USER, '', { document: {} }));
  assert.equal(first(big.calls, 'say')[2], t('file.tooBig', 'en'));
  assert.equal(first(big.calls, 'downloadFile'), undefined);

  const quota = depsFor({ describeAttachment: () => ({ ...meta, size: 10 }), fitsUpload: () => false });
  await createBotRouting(quota.deps).handleUpdate(message(USER, '', { document: {} }));
  assert.equal(first(quota.calls, 'say')[2], t('file.quota', 'en'));
  assert.equal(first(quota.calls, 'saveUpload'), undefined);

  const failed = depsFor({
    describeAttachment: () => ({ ...meta, size: 10 }),
    downloadFile: async () => { throw new Error('network'); },
  });
  await createBotRouting(failed.deps).handleUpdate(message(USER, '', { document: {} }));
  assert.ok(first(failed.calls, 'say')[2].startsWith('file.downloadFail'));
  assert.equal(first(failed.calls, 'saveUpload'), undefined);

  const grown = depsFor({ describeAttachment: () => ({ ...meta, size: 10 }), downloadFile: async () => Buffer.alloc(2000) });
  await createBotRouting(grown.deps).handleUpdate(message(USER, '', { document: {} }));
  assert.equal(first(grown.calls, 'say')[2], t('file.tooBig', 'en'));
  assert.equal(first(grown.calls, 'saveUpload'), undefined);
});

test('receiveFile: картинка попадает в файл, а сбой распаковки архива не срывает запрос', async () => {
  const { deps, calls } = depsFor({
    describeAttachment: () => ({ id: 'f1', name: 'a.zip', mime: 'image/png', size: 10 }),
    isImageMime: () => true,
    archiveKind: () => 'zip',
    extractArchiveAsync: async () => { throw Object.assign(new Error('boom'), { reason: 'encrypted' }); },
  });
  const routing = createBotRouting(deps);
  await routing.handleUpdate(message(USER, '', { document: {}, caption: ' captions ' }));
  assert.ok(calls.some((c) => c[0] === 'say' && c[2].startsWith('file.archiveSkipped')));
  const sent = first(calls, 'runTurn');
  assert.equal(sent[2], 'captions');
  assert.equal(sent[3].files[0].name, 'a.zip');
  assert.ok(Buffer.isBuffer(sent[3].files[0].data));
});

test('processAttachments: файл, принятый пока диалог занялся, удаляется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acpgram-routing-upload-'));
  const path = join(dir, 'drop.txt');
  writeFileSync(path, 'x');
  const { deps, calls } = depsFor({
    uploadsDir: () => dir,
    describeAttachment: () => ({ id: 'f1', name: 'drop.txt', mime: 'text/plain', size: 10 }),
    saveUpload: async () => path,
    downloadFile: async () => Buffer.from('x'),
  });
  const st = deps.getState(USER, USER, null);
  deps.downloadFile = async () => {
    st.busy = true;
    return Buffer.from('x');
  };
  try {
    await createBotRouting(deps).handleUpdate(message(USER, '', { document: {} }));
    assert.equal(existsSync(path), false);
    assert.equal(first(calls, 'say')[2], t('busy.running', 'en'));
    assert.equal(first(calls, 'runTurn'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('альбом: буфер сортирует сообщения по message_id и уходит одним запросом', async () => {
  const items = [];
  let onFlush;
  const { deps, calls } = depsFor({
    createAlbumBuffer: ({ onFlush: flush }) => {
      onFlush = flush;
      return { add: async (key, item) => { calls.push(['albums.add', key, item.msg.message_id]); items.push(item); } };
    },
    describeAttachment: (msg) => ({ id: `f${msg.message_id}`, name: msg.message_id === 1 ? 'a.txt' : 'b.txt', mime: 'text/plain', size: 10 }),
    saveUpload: async (_dir, name) => `/tmp/${name}`,
  });
  const routing = createBotRouting(deps);
  await routing.handleUpdate(message(USER, '', { photo: [{}], media_group_id: 'g', message_id: 2 }));
  await routing.handleUpdate(message(USER, '', { photo: [{}], media_group_id: 'g', message_id: 1 }));
  assert.deepEqual(all(calls, 'albums.add').map((c) => c[2]), [2, 1]);
  onFlush('key', items);
  await new Promise((resolve) => setImmediate(resolve));
  const sent = first(calls, 'runTurn');
  assert.deepEqual(sent[3].files.map((f) => f.name), ['a.txt', 'b.txt']);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = (name) => pathToFileURL(join(root, 'src', name)).href;
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-topic-model-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
process.env.ACPGRAM_LANG = 'en';
process.env.WIDGETS = '1';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const realFetch = globalThis.fetch;
const calls = [];
const failMethods = new Set();
let messageId = 100;
let me = { username: 'smoke_bot', has_topics_enabled: true, allows_users_to_create_topics: false };
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ method, body });
  if (failMethods.has(method)) throw new Error(`${method} rejected`);
  if (method === 'getMe') return { json: async () => ({ ok: true, result: me }) };
  if (method === 'createForumTopic') return { json: async () => ({ ok: true, result: { message_thread_id: 77 } }) };
  return { json: async () => ({ ok: true, result: { message_id: messageId++ } }) };
};

const { botInfo, db } = await import(target('ctx.mjs'));
const { envSignature } = await import(target('access.mjs'));
const { getEngine, engineVersion, setAvailability } = await import(target('engines.mjs'));
const { t } = await import(target('i18n.mjs'));
const { getState, topicsSupport } = await import(target('state.mjs'));
const { handleTopics, newTopic, offerAgentTopics, onTopicsCallback } = await import(target('topicsUi.mjs'));
const { replyKeyboard } = await import(target('ui.mjs'));
const { applyChoice, handleModel, modelWidgetHtml, onModelCallback } = await import(target('modelUi.mjs'));

const USER = 1;
const MODEL_USER = USER;
const project = join(home, 'project');
mkdirSync(project, { recursive: true });
db.setSetting(`lang:${USER}`, 'en');
db.setSetting(`lang:${MODEL_USER}`, 'en');
botInfo.username = 'smoke_bot';
setAvailability([]);
const catalog = {
  models: [
    { id: 'm1', name: 'Model One', group: 'g', groupLabel: 'Group G' },
    { id: 'm2', name: 'Model Two' },
  ],
  efforts: [{ id: 'high', name: 'High' }],
  defaultModel: 'm1',
  defaultEffort: 'high',
  at: new Date().toISOString(),
  version: engineVersion('claude'),
  envSig: envSignature(),
};
db.setSetting('catalog:claude', JSON.stringify(catalog));

const findCall = (method) => calls.find((c) => c.method === method);
const all = (method) => calls.filter((c) => c.method === method);
const cb = (userId, data) => ({ id: 'cb', from: { id: userId }, data, message: { chat: { id: userId }, message_id: 9 } });

function freshState(userId = USER, engine = 'gemini') {
  const st = getState(userId, userId, null);
  st.agent = null;
  st.engine = engine;
  st.project = project;
  st.busy = false;
  st.queued = null;
  st.perms = new Map();
  st.asks = new Map();
  return st;
}

function fakeAgent(st) {
  const a = {
    engine: getEngine('gemini'),
    sessionId: 'agent-session',
    dbSessionId: db.startSession('agent-session', st.userId, st.chatId, 'default', project, 'gemini'),
    mode: 'default',
    closed: false,
    close() {
      this.closed = true;
    },
  };
  st.agent = a;
  return a;
}

after(() => {
  setAvailability([]);
  globalThis.fetch = realFetch;
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('/topics: поддержка из getMe, active_usernames, режим с заметкой и настройки бота для администратора', async () => {
  const st = freshState();
  const emp = getState(2, 2, null);
  db.setSetting('lang:2', 'en');
  botInfo.username = '';
  me = { active_usernames: ['alias_bot'], has_topics_enabled: false, allows_users_to_create_topics: false, has_topic_sidebar: false, can_join_groups: true };
  calls.length = 0;
  await handleTopics(emp);
  assert.equal(findCall('sendMessage').body.text, t('topics.unsupported', 'en'));
  assert.equal(findCall('sendMessage').body.reply_markup, undefined);
  assert.equal(botInfo.username, 'alias_bot');

  calls.length = 0;
  await handleTopics(st);
  const adminOff = findCall('sendMessage').body;
  assert.equal(adminOff.text, t('topics.unsupportedAdmin', 'en'));
  assert.deepEqual(
    adminOff.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    ['tpc:bot:topics', 'tpc:bot:groups'],
  );

  me = { username: 'acp_bot', has_topics_enabled: true, allows_users_to_create_topics: false, has_topic_sidebar: true, can_join_groups: false };
  db.setSetting(`topics:${USER}`, 'on');
  calls.length = 0;
  await handleTopics(st);
  const menu = findCall('sendMessage');
  assert.equal(topicsSupport.enabled, true);
  assert.equal(topicsSupport.usersCreate, false);
  assert.equal(topicsSupport.sidebar, true);
  assert.equal(topicsSupport.canJoinGroups, false);
  assert.equal(botInfo.username, 'acp_bot');
  assert.ok(menu.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'tpc:off'));
  assert.ok(menu.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'tpc:bot:sidebar'));
  assert.match(menu.body.text, /creating topics yourself is turned off/i);

  failMethods.add('getMe');
  calls.length = 0;
  await handleTopics(st);
  failMethods.delete('getMe');
  assert.ok(findCall('sendMessage'));
  assert.equal(topicsSupport.enabled, true);
  botInfo.username = 'smoke_bot';
});

test('tpc:bot:*: администратор меняет настройки бота через setMySettings, сотрудник получает отказ', async () => {
  const admin = freshState();
  const emp = getState(2, 2, null);
  db.setSetting('lang:2', 'en');
  topicsSupport.enabled = false;
  topicsSupport.sidebar = false;
  topicsSupport.usersCreate = false;
  topicsSupport.canJoinGroups = true;

  calls.length = 0;
  await onTopicsCallback(emp, cb(2, 'tpc:bot:topics'));
  assert.equal(findCall('answerCallbackQuery').body.text, t('admin.only', 'en'));
  assert.equal(findCall('setMySettings'), undefined);

  calls.length = 0;
  await onTopicsCallback(admin, cb(USER, 'tpc:bot:topics'));
  assert.deepEqual(findCall('setMySettings').body, { has_topics_enabled: true, has_topic_sidebar: true });
  assert.equal(topicsSupport.enabled, true);
  assert.equal(topicsSupport.sidebar, true);
  assert.equal(findCall('answerCallbackQuery').body.text, t('topics.botSaved', 'en'));
  assert.ok(findCall('editMessageText'));

  calls.length = 0;
  await onTopicsCallback(admin, cb(USER, 'tpc:bot:sidebar'));
  assert.deepEqual(findCall('setMySettings').body, { has_topic_sidebar: false });
  assert.equal(topicsSupport.sidebar, false);

  calls.length = 0;
  await onTopicsCallback(admin, cb(USER, 'tpc:bot:create'));
  assert.deepEqual(findCall('setMySettings').body, { allows_users_to_create_topics: true });
  assert.equal(topicsSupport.usersCreate, true);

  calls.length = 0;
  await onTopicsCallback(admin, cb(USER, 'tpc:bot:groups'));
  assert.deepEqual(findCall('setMySettings').body, { can_join_groups: false });
  assert.equal(topicsSupport.canJoinGroups, false);

  failMethods.add('setMySettings');
  calls.length = 0;
  await onTopicsCallback(admin, cb(USER, 'tpc:bot:sidebar'));
  failMethods.delete('setMySettings');
  assert.equal(topicsSupport.sidebar, false);
  assert.match(findCall('answerCallbackQuery').body.text, /setMySettings rejected/);

  calls.length = 0;
  await onTopicsCallback(admin, cb(USER, 'tpc:bot:topics'));
  assert.deepEqual(findCall('setMySettings').body, { has_topics_enabled: false });
  assert.equal(topicsSupport.enabled, false);
});

test('tpc:off: лишние нажатия, занятый диалог, закрытие агентов и fallbacksend', async () => {
  const st = freshState();
  topicsSupport.enabled = true;
  topicsSupport.usersCreate = true;
  db.setSetting(`topics:${USER}`, 'on');

  calls.length = 0;
  topicsSupport.enabled = false;
  await onTopicsCallback(st, cb(USER, 'tpc:off'));
  assert.equal(findCall('answerCallbackQuery').body.text, t('topics.unsupported', 'en'));
  topicsSupport.enabled = true;

  calls.length = 0;
  await onTopicsCallback(st, cb(USER, 'tpc:on'));
  assert.equal(findCall('answerCallbackQuery').body.text, undefined);
  assert.equal(all('editMessageText').length, 0);

  calls.length = 0;
  st.busy = true;
  await onTopicsCallback(st, cb(USER, 'tpc:off'));
  assert.equal(findCall('answerCallbackQuery').body.text, t('topics.busy', 'en'));
  st.busy = false;

  calls.length = 0;
  const agent = fakeAgent(st);
  await onTopicsCallback(st, cb(USER, 'tpc:off'));
  assert.equal(agent.closed, true);
  assert.equal(db.getSetting(`topics:${USER}`), 'off');
  assert.ok(findCall('editMessageText'));

  calls.length = 0;
  db.setSetting(`topics:${USER}`, 'on');
  failMethods.add('editMessageText');
  await onTopicsCallback(st, cb(USER, 'tpc:off'));
  failMethods.delete('editMessageText');
  assert.ok(findCall('sendMessage'));
});

test('/new: создаёт тему, сохраняет её и показывает ссылку; ошибкаcreation не роняет бота', async () => {
  const st = freshState();
  calls.length = 0;
  await newTopic(st, { project });
  const created = findCall('createForumTopic');
  assert.equal(created.body.chat_id, USER);
  assert.match(created.body.name, /New dialog/i);
  const saved = db.getTopic(USER, 77);
  assert.equal(saved.project, project);
  assert.equal(saved.engine, 'gemini');
  const hello = all('sendMessage').find((c) => c.body.message_thread_id === 77);
  assert.ok(hello);
  assert.deepEqual(hello.body.reply_markup, replyKeyboard('en', { admin: true, topics: 'on' }));
  const link = all('sendMessage').find((c) => c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url);
  assert.match(link.body.reply_markup.inline_keyboard[0][0].url, /t\.me\/smoke_bot\/77/);

  calls.length = 0;
  failMethods.add('createForumTopic');
  await newTopic(st, { project });
  failMethods.delete('createForumTopic');
  assert.ok(findCall('sendMessage'));
  assert.equal(db.getTopic(USER, 77).name, saved.name);
});

test('темы, созданные агентом, получают reply-клавиатуру в приветствии и уважают /keyboard off', async () => {
  const st = freshState();
  calls.length = 0;
  await offerAgentTopics(st, ['Design'], 'en');
  const hello = all('sendMessage').find((c) => c.body.message_thread_id === 77);
  assert.ok(hello);
  assert.deepEqual(hello.body.reply_markup, replyKeyboard('en', { admin: true, topics: 'on' }));
  assert.equal(db.getSetting(`replyKb:${USER}:77`), '1');

  db.setSetting(`replyKbOff:${USER}`, '1');
  calls.length = 0;
  await newTopic(st, { project });
  const mutedHello = all('sendMessage').find((c) => c.body.message_thread_id === 77);
  assert.ok(mutedHello);
  assert.equal(mutedHello.body.reply_markup, undefined, 'при отключённой клавиатуре новая тема без reply_markup');
  db.setSetting(`replyKbOff:${USER}`, '');
});

test('/model: виджет, обычное меню и поиск по каталогу', async () => {
  const st = freshState(MODEL_USER, 'claude');
  calls.length = 0;
  await handleModel(st);
  const widget = findCall('sendWidget');
  assert.ok(widget, JSON.stringify(calls));
  assert.match(widget.body.html, /Model One/);

  calls.length = 0;
  await handleModel(st, '', { classic: true });
  const menu = findCall('sendMessage');
  assert.ok(menu.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data?.startsWith('mdl:claude:')));

  calls.length = 0;
  await handleModel(st, 'one');
  const search = findCall('sendMessage');
  assert.match(search.body.text, /found 1/i);
  assert.ok(search.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'mdl:claude:m:m1'));
});

test('modelWidgetHtml: группы каталога попадают в разметку виджета', () => {
  const st = freshState(MODEL_USER, 'claude');
  const html = modelWidgetHtml(st, getEngine('claude'), catalog);
  assert.match(html, /Group G|Model One/);
});

test('applyChoice: неверный вариант, нет каталога, Авто, номер и уровень рассуждений', () => {
  const st = freshState(MODEL_USER, 'claude');
  const engine = getEngine('claude');
  assert.deepEqual(applyChoice(st, engine, 'model', 'нет'), { ok: false, error: t('model.badOption', 'en') });
  assert.deepEqual(applyChoice(st, { id: 'none' }, 'model', 'm1'), { ok: false, error: t('model.noCatalog', 'en') });
  assert.deepEqual(applyChoice(st, engine, 'model', '~'), { ok: true, value: null });
  assert.deepEqual(applyChoice(st, engine, 'model', '#0'), { ok: true, value: 'm1' });
  assert.deepEqual(applyChoice(st, engine, 'effort', 'high'), { ok: true, value: 'high' });
});

test('mdl: смена движка, нет каталога, группа, выбор и fallback', async () => {
  const st = freshState(MODEL_USER, 'claude');
  calls.length = 0;
  await onModelCallback(st, cb(MODEL_USER, 'mdl:gemini:m:m1'));
  assert.match(findCall('answerCallbackQuery').body.text, /changed/i);

  st.engine = 'gemini';
  calls.length = 0;
  await onModelCallback(st, cb(MODEL_USER, 'mdl:gemini:m:m1'));
  assert.equal(findCall('answerCallbackQuery').body.text, t('model.noCatalog', 'en'));
  st.engine = 'claude';

  calls.length = 0;
  await onModelCallback(st, cb(MODEL_USER, 'mdl:claude:g:~:0'));
  assert.ok(findCall('editMessageText'));
  assert.equal(findCall('answerCallbackQuery').body.text, undefined);

  calls.length = 0;
  await onModelCallback(st, cb(MODEL_USER, 'mdl:claude:m:m2'));
  assert.ok(findCall('editMessageText'));

  calls.length = 0;
  failMethods.add('editMessageText');
  await onModelCallback(st, cb(MODEL_USER, 'mdl:claude:e:high'));
  failMethods.delete('editMessageText');
  assert.ok(findCall('sendMessage'));
});

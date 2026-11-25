import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-ui-boundaries-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
process.env.WIDGETS = '1';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const realFetch = globalThis.fetch;
const calls = [];
const failMethods = new Set();
let messageId = 42;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ method, body });
  if (failMethods.has(method)) throw new Error(`${method} rejected`);
  return { json: async () => ({ ok: true, result: { message_id: messageId++ } }) };
};

const { db } = await import('../src/ctx.mjs');
const { ENGINES, getEngine, setAvailability, setNeedsLogin } = await import('../src/engines.mjs');
const { getState } = await import('../src/state.mjs');
const { handleEngine, onEngineCallback } = await import('../src/engineUi.mjs');
const { WIDGETS, sendWidgetMessage } = await import('../src/widgetHost.mjs');
const { widgetFits } = await import('../src/widgets.mjs');
const { onWidgetQuery } = await import('../src/widgetsUi.mjs');

const USER = 1;
const STRANGER = 2;
const project = join(home, 'project');
mkdirSync(project, { recursive: true });
db.setSetting(`lang:${USER}`, 'en');
db.setSetting(`lang:${STRANGER}`, 'en');
db.setSetting('catalog:claude', JSON.stringify({
  models: [{ id: 'm1', name: 'Model One' }, { id: 'm2', name: 'Model Two' }],
  efforts: [{ id: 'high', name: 'High' }],
  defaultModel: 'm1',
  defaultEffort: 'high',
  at: new Date().toISOString(),
  version: null,
  envSig: null,
}));
setAvailability([]);
setNeedsLogin('claude', false);

const findCall = (method) => calls.find((c) => c.method === method);
const all = (method) => calls.filter((c) => c.method === method);
const widgetQuery = (data, messageIdValue = 42) => ({ id: 'wq', from: { id: USER }, chat: { id: USER }, message_id: messageIdValue, data });

function freshState(userId = USER) {
  const st = getState(userId, userId, null);
  st.agent = null;
  st.engine = 'gemini';
  st.project = project;
  st.busy = false;
  st.queued = null;
  st.perms = new Map();
  st.asks = new Map();
  return st;
}

function fakeAgent(st, sessionId = 'agent-session') {
  const a = {
    engine: getEngine('claude'),
    sessionId,
    dbSessionId: db.startSession(sessionId, st.userId, st.chatId, 'default', project, 'claude'),
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
  setNeedsLogin('claude', false);
  globalThis.fetch = realFetch;
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('/engine: меню, псевдоним, предупреждение о входе и отказы', async () => {
  const st = freshState();
  calls.length = 0;
  await handleEngine(st, '');
  const menu = findCall('sendMessage');
  assert.equal(menu.body.parse_mode, 'HTML');
  assert.match(menu.body.text, /Gemini CLI/);
  assert.ok(menu.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'eng:claude'));

  calls.length = 0;
  const agent = fakeAgent(st);
  agent.engine = getEngine('gemini');
  st.engine = 'gemini';
  setNeedsLogin('claude', true);
  await handleEngine(st, 'claude');
  setNeedsLogin('claude', false);
  assert.equal(st.engine, 'claude');
  assert.equal(agent.closed, true);
  assert.match(findCall('sendMessage').body.text, /not signed in|sign-in/i);

  calls.length = 0;
  await handleEngine(st, 'не-движок');
  assert.match(findCall('sendMessage').body.text, /Unknown engine/);

  calls.length = 0;
  setAvailability([{ engine: ENGINES.claude, ok: false }]);
  await handleEngine(st, 'claude');
  setAvailability([]);
  assert.match(findCall('sendMessage').body.text, /unavailable on the server/);

  calls.length = 0;
  await handleEngine(freshState(STRANGER), 'claude');
  assert.match(findCall('sendMessage').body.text, /not granted|не выдан/i);

  calls.length = 0;
  const busy = freshState();
  busy.busy = true;
  await handleEngine(busy, 'claude');
  assert.match(findCall('sendMessage').body.text, /Stop the current request/);
});

test('onEngineCallback: редактирует сообщение, при отказе Telegram пишет новым', async () => {
  const st = freshState();
  const cb = { id: 'cb', data: 'eng:claude', message: { chat: { id: USER }, message_id: 9 } };
  calls.length = 0;
  await onEngineCallback(st, cb);
  assert.equal(findCall('answerCallbackQuery').body.callback_query_id, 'cb');
  const edited = findCall('editMessageText');
  assert.equal(edited.body.message_id, 9);
  assert.deepEqual(edited.body.reply_markup, { inline_keyboard: [] });
  assert.equal(st.engine, 'claude');

  calls.length = 0;
  failMethods.add('editMessageText');
  try {
    const st2 = freshState();
    st2.engine = 'claude';
    await onEngineCallback(st2, { ...cb, data: 'eng:gemini' });
  } finally {
    failMethods.delete('editMessageText');
  }
  assert.match(findCall('sendMessage').body.text, /Engine:/);
  assert.equal(all('editMessageText').length, 1);
});

test('виджет: неверный запрос, чужой движок и выбор модели/уровня', async () => {
  const st = freshState();
  st.engine = 'claude';
  assert.equal(WIDGETS, true);
  assert.equal(widgetFits('<b>Модели</b>'), true);
  messageId = 42;
  const sent = await sendWidgetMessage(st, { html: '<b>Модели</b>', caption: 'Модели', kind: 'model', engine: 'claude' });
  assert.equal(sent, true);
  assert.equal(findCall('sendWidget').body.html, '<b>Модели</b>');

  calls.length = 0;
  await onWidgetQuery(widgetQuery('x:1'));
  assert.match(JSON.parse(findCall('answerWidgetQuery').body.data).t, /out of date/i);

  calls.length = 0;
  st.engine = 'gemini';
  await onWidgetQuery(widgetQuery('m:m1'));
  assert.match(JSON.parse(findCall('answerWidgetQuery').body.data).t, /engine has changed/i);
  st.engine = 'claude';

  calls.length = 0;
  await onWidgetQuery(widgetQuery('m:m1'));
  let answer = JSON.parse(findCall('answerWidgetQuery').body.data);
  assert.equal(answer.s.m, 'm1');
  assert.equal(JSON.parse(findCall('editMessageWidgetData').body.chat_data).m, 'm1');

  calls.length = 0;
  await onWidgetQuery(widgetQuery('e:high'));
  answer = JSON.parse(findCall('answerWidgetQuery').body.data);
  assert.equal(answer.s.e, 'high');
  assert.equal(JSON.parse(findCall('editMessageWidgetData').body.chat_data).e, 'high');
});

test('виджет сессий: занятый диалог, отсутствующая сессия и возобновление', async () => {
  const st = freshState();
  st.engine = 'claude';
  st.project = project;
  messageId = 42;
  await sendWidgetMessage(st, { html: '<b>Сессии</b>', caption: 'Сессии', kind: 'sessions', engine: 'claude' });

  calls.length = 0;
  st.busy = true;
  await onWidgetQuery(widgetQuery('s:acp-1'));
  assert.match(JSON.parse(findCall('answerWidgetQuery').body.data).t, /Stop the current request/);
  st.busy = false;

  calls.length = 0;
  await onWidgetQuery(widgetQuery('s:нет'));
  assert.match(JSON.parse(findCall('answerWidgetQuery').body.data).t, /was not found/i);

  const sid = db.startSession('acp-1', USER, USER, 'default', project, 'claude');
  db.startRequest(sid, 'первый запрос');
  const agent = fakeAgent(st, 'other-session');
  let currentAgent = agent;
  Object.defineProperty(st, 'agent', {
    configurable: true,
    get: () => currentAgent,
    set: (value) => {
      if (value !== null) currentAgent = value;
    },
  });
  agent.close = () => {};
  calls.length = 0;
  await onWidgetQuery(widgetQuery('s:acp-1'));
  assert.ok(JSON.parse(findCall('answerWidgetQuery').body.data).t);
  assert.equal(all('sendMessage').length, 2);
  assert.equal(st.busy, false);
});

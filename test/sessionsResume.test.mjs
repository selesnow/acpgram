import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-sessions-resume-')));
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

const { AcpAgent } = await import('../src/acp.mjs');
const realFetch = globalThis.fetch;
const calls = [];
let messageId = 100;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : JSON.parse(init.body || '{}');
  calls.push({ method, body });
  return { json: async () => ({ ok: true, result: { message_id: messageId++ } }) };
};

const { db } = await import('../src/ctx.mjs');
const { ENGINES } = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');
const stateApi = await import('../src/state.mjs');
const sessionsUi = await import('../src/sessionsUi.mjs');

const USER = 1;
const project = join(home, 'project');
mkdirSync(project, { recursive: true });
db.setSetting(`lang:${USER}`, 'en');
stateApi.topicsSupport.enabled = false;

const resetCalls = () => {
  calls.length = 0;
};
const findCall = (method) => calls.find((c) => c.method === method);

function state() {
  const st = stateApi.getState(USER, USER, null);
  st.agent = null;
  st.engine = 'gemini';
  st.project = project;
  st.busy = false;
  st.suppress = false;
  st.queued = null;
  st.resumeId = null;
  st.perms = new Map();
  st.asks = new Map();
  return st;
}

function seedSession(id, engine, cwd = project, text = 'Сделай отчёт') {
  const dbId = db.startSession(id, USER, USER, 'default', cwd, engine);
  db.startRequest(dbId, text);
  return sessionItem(id, cwd);
}

function sessionItem(id, cwd = project) {
  return db.listSessions(USER, cwd, 50).find((s) => s.acp_id === id);
}

function fakeAgent(sessionId, engine) {
  return {
    engine,
    sessionId,
    dbSessionId: null,
    cwd: project,
    mode: 'default',
    caps: {},
    applied: {},
    promptCount: 0,
    prompts: [],
    closed: false,
    request: async () => ({}),
    prompt(blocks) {
      this.prompts.push(blocks);
      return Promise.resolve({ stopReason: 'end_turn' });
    },
    cancel() {},
    close() {
      this.closed = true;
    },
  };
}

function armedState() {
  const st = state();
  const oldAgent = fakeAgent('old-session', ENGINES.gemini);
  const resumedAgent = fakeAgent('resumed-session', ENGINES.gemini);
  let current = oldAgent;
  Object.defineProperty(st, 'agent', {
    configurable: true,
    get: () => current,
    set: (value) => {
      if (value) current = value;
    },
  });
  oldAgent.close = () => {
    oldAgent.closed = true;
    current = resumedAgent;
  };
  Object.defineProperty(resumedAgent, 'engine', { get: () => ENGINES[st.engine] ?? ENGINES.gemini });
  return { st, oldAgent, resumedAgent };
}

after(() => {
  try {
    globalThis.fetch = realFetch;
    stateApi.shutdownAll('test-cleanup');
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('handleSessions: виджет сессий отправляется, обычный список показывает кнопки и текущую сессию', async () => {
  seedSession('ses-widget', 'gemini');
  seedSession('ses-current', 'claude');
  seedSession('ses-third', 'gemini');
  const st = state();
  resetCalls();
  await sessionsUi.handleSessions(st);
  assert.equal(findCall('sendWidget')?.body.allow_queries, true);
  assert.match(findCall('sendWidget').body.html, /ses-current/);
  assert.equal(findCall('sendMessage'), undefined);

  st.agent = fakeAgent('ses-current', ENGINES.claude);
  resetCalls();
  await sessionsUi.handleSessions(st, { classic: true });
  const message = findCall('sendMessage');
  assert.ok(message, 'обычный список отправлен');
  assert.match(message.body.text, /▶️/);
  assert.match(message.body.text, /Сделай отчёт/);
  const buttons = message.body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'ses:ses-current'));
  assert.ok(buttons.some((b) => b.callback_data === 'ses:ses-widget'));
});

test('handleSessions: нет сохранённых сессий — одно сообщение без кнопок', async () => {
  const st = state();
  st.project = join(home, 'empty-project');
  resetCalls();
  await sessionsUi.handleSessions(st);
  assert.equal(calls.length, 1);
  assert.equal(findCall('sendMessage').body.text, t('ses.none', 'en', { p: stateApi.userPath(USER, st.project, 'en') }));
  assert.equal(findCall('sendMessage').body.reply_markup, undefined);
});

test('onSessionCallback: чужой и несуществующий id отклоняются без возобновления', async () => {
  seedSession('ses-mine', 'gemini', project);
  seedSession('ses-other', 'gemini', join(home, 'other-project'));
  const st = state();
  for (const id of ['ses-other', 'ses-missing']) {
    resetCalls();
    await sessionsUi.onSessionCallback(st, { id: `cb-${id}`, data: `ses:${id}`, message: { chat: { id: USER }, message_id: 5 } });
    assert.equal(findCall('answerCallbackQuery').body.text, t('ses.notFound', 'en'));
    assert.equal(findCall('editMessageText'), undefined);
    assert.equal(st.engine, 'gemini');
    assert.equal(st.busy, false);
  }
});

test('onSessionCallback: занятый диалог не возобновляет сессию', async () => {
  seedSession('ses-busy', 'gemini');
  const st = state();
  st.busy = true;
  st.agent = fakeAgent('active', ENGINES.gemini);
  resetCalls();
  await sessionsUi.onSessionCallback(st, { id: 'cb-busy', data: 'ses:ses-busy', message: { chat: { id: USER }, message_id: 6 } });
  assert.equal(findCall('answerCallbackQuery').body.text, t('busy.stop', 'en'));
  assert.equal(findCall('editMessageText'), undefined);
  assert.equal(st.agent.sessionId, 'active');
  st.busy = false;
});

test('resumeSession: успех переключает движок и отправляет в возобновлённую сессию сообщение из очереди', async () => {
  const item = seedSession('ses-claude', 'claude');
  const { st, oldAgent, resumedAgent } = armedState();
  st.queued = { text: 'из очереди', quote: null, messageId: null };
  const report = [];
  resetCalls();
  await sessionsUi.resumeSession(st, item, ENGINES.claude, async (text) => report.push(text));
  assert.equal(oldAgent.closed, true);
  assert.equal(st.engine, 'claude');
  assert.equal(db.getSetting(`engine:${USER}`), 'claude');
  assert.equal(st.busy, false);
  assert.equal(st.queued, null);
  assert.match(report[0], /Returning to the session/);
  assert.match(report[1], /Session resumed/);
  assert.match(report[1], /Engine switched to Claude/);
  assert.equal(resumedAgent.prompts[0][0].text, 'из очереди');
  assert.ok(calls.some((c) => c.method === 'sendRichMessage'), 'очередь доставлена');
});

test('onSessionCallback: кнопка сессии подтверждается и пишет ход возобновления в сообщение', async () => {
  const item = seedSession('ses-callback', 'claude');
  const { st } = armedState();
  resetCalls();
  await sessionsUi.onSessionCallback(st, { id: 'cb-ok', data: `ses:${item.acp_id}`, message: { chat: { id: USER }, message_id: 7 } });
  const ack = findCall('answerCallbackQuery');
  assert.ok(ack);
  assert.equal(ack.body.text, undefined);
  const edits = calls.filter((c) => c.method === 'editMessageText').map((c) => c.body.text);
  assert.match(edits[0], /Returning to the session/);
  assert.match(edits.at(-1), /Session resumed/);
  assert.equal(st.busy, false);
});

test('resumeSession: ошибка ensureAgent откатывает движок, сообщает об ошибке и не оставляет диалог занятым', async () => {
  const item = seedSession('ses-fail', 'claude');
  const st = state();
  st.project = join(home, 'missing-project');
  st.queued = { text: 'после ошибки', quote: null, messageId: null };
  const report = [];
  resetCalls();
  await sessionsUi.resumeSession(st, item, ENGINES.claude, async (text) => report.push(text));
  assert.equal(st.engine, 'gemini');
  assert.equal(db.getSetting(`engine:${USER}`), 'gemini');
  assert.equal(st.busy, false);
  assert.equal(st.queued, null);
  assert.equal(report.length, 2);
  assert.match(report[0], /Returning to the session/);
  assert.equal(report[1], t('state.projectGone', 'en'));
  assert.ok(calls.some((c) => c.method === 'sendRichMessage'), 'очередь обработана после ошибки');
});

test('ensureAgent: неудавшееся возобновление повторяет запуск без resume', async () => {
  const originalInit = AcpAgent.prototype.init;
  const originalClose = AcpAgent.prototype.close;
  const initCalls = [];
  let st = null;
  AcpAgent.prototype.init = async function (mode, opts = {}) {
    initCalls.push({ resume: opts.resume, resumeIdAtCall: st?.resumeId ?? null });
    if (opts.resume === 'broken-session') throw new Error('сессия исчезла');
    this.mode = mode || 'default';
    this.sessionId = 'fallback-fresh';
    this.closed = false;
    return { sessionId: this.sessionId, modes: { currentModeId: this.mode } };
  };
  AcpAgent.prototype.close = function () {
    this.closed = true;
  };
  try {
    st = state();
    st.resumeId = 'broken-session';
    const agent = await stateApi.ensureAgent(st);
    assert.deepEqual(initCalls.map((c) => c.resume), ['broken-session', undefined]);
    assert.equal(initCalls[1].resumeIdAtCall, null);
    assert.equal(agent.sessionId, 'fallback-fresh');
    assert.equal(st.resumeId, 'fallback-fresh');
    assert.equal(st.agent, agent);
    agent.close();
  } finally {
    AcpAgent.prototype.init = originalInit;
    AcpAgent.prototype.close = originalClose;
  }
});

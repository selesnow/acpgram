import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-state-safety-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
process.env.AGENT_START_TIMEOUT = '2';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
};

const { db } = await import('../src/ctx.mjs');
const { AcpAgent } = await import('../src/acp.mjs');
const { t } = await import('../src/i18n.mjs');
const S = await import('../src/state.mjs');

const ADMIN = 1;
const project = join(home, 'project');
mkdirSync(project, { recursive: true });

function freshState(userId, level = 'read') {
  db.upsertUser({ user_id: userId, level, added_by: ADMIN });
  db.setSetting(`lang:${userId}`, 'en');
  const st = S.getState(userId, userId, null);
  st.project = project;
  st.engine = 'gemini';
  st.agent = null;
  st.resumeId = null;
  st.busy = false;
  st.suppress = false;
  st.queued = null;
  return st;
}

function installAgent(tc, init = async function () {}) {
  const calls = { init: [], close: 0, cancel: 0, startSession: 0, endSession: [] };
  mock.method(AcpAgent.prototype, 'init', async function (mode, opts) {
    calls.init.push({ mode, opts });
    await init.call(this, mode, opts);
  });
  mock.method(AcpAgent.prototype, 'close', function () {
    calls.close++;
    this.closed = true;
  });
  mock.method(AcpAgent.prototype, 'cancel', function () {
    calls.cancel++;
  });
  mock.method(db, 'startSession', () => ++calls.startSession);
  mock.method(db, 'endSession', (id, reason) => calls.endSession.push([id, reason]));
  tc.after(() => mock.restoreAll());
  return calls;
}

const ready = (sessionId) => async function () {
  this.sessionId = sessionId;
  this.mode = 'plan';
};

after(() => {
  globalThis.fetch = realFetch;
  S.shutdownAll('test-cleanup');
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('startAgent onUpdate: запрещённый режим останавливает пользователя и закрывает процесс', async (tc) => {
  const st = freshState(9501);
  const calls = installAgent(tc, ready('mode-session'));
  sent.length = 0;
  const a = await S.ensureAgent(st);
  st.busy = true;
  st.queued = { text: 'next' };
  let forwarded = 0;
  let dropped = 0;
  let resolved = null;
  st.onUpdate = () => forwarded++;
  st.perms.set(1, { dbId: 1, resolve: (o) => (resolved = o), onDrop: () => dropped++ });

  a.onUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'yolo' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(st.agent, null);
  assert.equal(st.resumeId, null);
  assert.equal(st.suppress, true);
  assert.equal(st.queued, null);
  assert.equal(st.perms.size, 0);
  assert.deepEqual(resolved, { outcome: 'cancelled' });
  assert.equal(dropped, 1);
  assert.equal(a.closed, true);
  assert.equal(calls.close, 1);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.endSession.at(-1)[1], 'mode-violation');
  assert.equal(forwarded, 0);
  assert.ok(sent.some((c) => c.url.endsWith('/sendMessage') && c.body.text === t('state.modeViolation', 'en', { mode: 'yolo' })));
});

test('startAgent onUpdate: модель вне списка останавливает пользователя и закрывает процесс', async (tc) => {
  const st = freshState(9502);
  db.setUserModels(9502, { gemini: ['allowed-model'] });
  const calls = installAgent(tc, ready('model-session'));
  sent.length = 0;
  const a = await S.ensureAgent(st);
  st.busy = true;
  st.queued = { text: 'next' };
  let dropped = 0;
  st.perms.set(2, { dbId: 2, resolve: () => {}, onDrop: () => dropped++ });

  a.onUpdate({ sessionUpdate: 'usage_update', cost: { amount: 1 }, _meta: { '_claude/model': 'forbidden-model' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(st.agent, null);
  assert.equal(st.resumeId, null);
  assert.equal(st.suppress, true);
  assert.equal(st.queued, null);
  assert.equal(st.perms.size, 0);
  assert.equal(dropped, 1);
  assert.equal(a.closed, true);
  assert.equal(a.lastModel, 'forbidden-model');
  assert.equal(calls.close, 1);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.endSession.at(-1)[1], 'model-violation');
  assert.ok(sent.some((c) => c.url.endsWith('/sendMessage') && c.body.text === t('state.modelViolation', 'en', { model: 'forbidden-model' })));
});

test('startAgent: START_TIMEOUT ACP превращается в сообщение пользователю без фантомного агента', async (tc) => {
  const st = freshState(9503);
  let started = null;
  const calls = installAgent(tc, async function () {
    started = this;
    const error = new Error('Gemini CLI: нет ответа за 2 с');
    error.code = 'START_TIMEOUT';
    throw error;
  });

  const error = await S.ensureAgent(st).catch((e) => e);
  assert.ok(error instanceof Error);
  assert.equal(error.message, t('state.startTimeout', 'en', { engine: 'Gemini CLI', sec: 2 }));
  assert.equal(error.code, undefined);
  assert.equal(error.cause.code, 'START_TIMEOUT');
  assert.equal(st.agent, null);
  assert.equal(st.resumeId, null);
  assert.equal(started.closed, true);
  assert.equal(calls.startSession, 0);
  assert.equal(calls.init[0].opts.timeoutMs, 2000);
});

test('startAgent: закрытие сессии во время init не оставляет агента и не регистрирует сессию', async (tc) => {
  const st = freshState(9504);
  let started = null;
  const calls = installAgent(tc, async function () {
    started = this;
    S.endAgent(st, 'close');
    throw new Error('процесс закрыт пользователем');
  });

  const error = await S.ensureAgent(st).catch((e) => e);
  assert.ok(error instanceof S.ClosedError);
  assert.equal(st.agent, null);
  assert.equal(st.resumeId, null);
  assert.equal(started.closed, true);
  assert.equal(calls.startSession, 0);
  assert.equal(calls.endSession.length, 1);
  assert.equal(calls.endSession[0][1], 'close');
});

test('startAgent: закрытие сессии сразу после успешного init не регистрирует сессию', async (tc) => {
  const st = freshState(9505);
  let started = null;
  const calls = installAgent(tc, async function () {
    started = this;
    this.sessionId = 'closed-session';
    S.endAgent(st, 'close');
  });

  const error = await S.ensureAgent(st).catch((e) => e);
  assert.ok(error instanceof S.ClosedError);
  assert.equal(st.agent, null);
  assert.equal(st.resumeId, null);
  assert.equal(started.closed, true);
  assert.equal(calls.startSession, 0);
  assert.equal(calls.endSession.length, 1);
  assert.equal(calls.endSession[0][1], 'close');
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'acpgram-turn-stream-'));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
delete process.env.TURN_IDLE_MINUTES;

const { db } = await import('../src/ctx.mjs');
const { getEngine } = await import('../src/engines.mjs');
const { createTurnStream } = await import('../src/turnStream.mjs');

const USER = 1;
const engine = getEngine('claude');
const calls = [];
const originalFetch = globalThis.fetch;
const captureFetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : JSON.parse(init.body);
  calls.push({ method, body });
  return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
};
globalThis.fetch = captureFetch;

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function startStream({ requestId = 'auto' } = {}) {
  const session = db.startSession('s-stream', USER, USER, 'default', home, 'claude');
  const id = requestId === 'auto' ? db.startRequest(session, 'тест') : requestId;
  return createTurnStream({
    st: { userId: USER, to: USER },
    to: USER,
    clean: (s) => s,
    engine,
    lang: 'ru',
    startedAt: Date.now(),
    getRequestId: () => id,
  });
}

test('createTurnStream: события ACP собирают ответ, шаги, план и usage', async () => {
  const stream = startStream();
  try {
    const usage = { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'claude-x' } };
    stream.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', title: 'ls', content: [] });
    stream.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'ls -la', status: 'completed', content: [] });
    stream.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '**Проверяю** файл' } });
    stream.onUpdate({ sessionUpdate: 'plan', entries: [{ content: 'Шаг 1', status: 'completed' }, { content: 'Шаг 2', status: 'in_progress' }] });
    stream.onUpdate(usage);

    assert.equal(stream.steps.length, 1);
    assert.equal(stream.steps[0].toolCallId, 't1');
    assert.equal(stream.steps[0].title, 'ls -la');
    assert.equal(stream.steps[0].status, 'completed');
    assert.equal(stream.lastUsage, usage);

    await stream.pushDraft();
    const draft = calls.at(-1);
    assert.equal(draft.method, 'sendRichMessageDraft');
    assert.equal(draft.body.can_stop, true);
    assert.equal(draft.body.keep_on_stop, true);
    assert.ok(draft.body.draft_id > 0);
    const thinking = draft.body.rich_message.markdown;
    assert.match(thinking, /Проверяю/);
    assert.match(thinking, /План: 1\/2/);
    assert.match(thinking, /Шаг 2/);
    assert.match(thinking, /✅ ⚙️/);

    stream.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Первый' } });
    stream.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', kind: 'read', title: 'cat', content: [] });
    stream.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Второй' } });
    assert.equal(stream.answer, 'Первый\n\nВторой');
    assert.equal(stream.steps.length, 2);

    await stream.pushDraft();
    assert.match(calls.at(-1).body.rich_message.markdown, /Первый\n\nВторой/);
  } finally {
    stream.stop();
    calls.length = 0;
  }
});

test('createTurnStream: обрезает ответ и ограничивает число шагов', () => {
  const stream = startStream({ requestId: null });
  try {
    stream.addAnswer('x'.repeat(1024 * 1024 + 100));
    assert.equal(stream.answer.length, 1024 * 1024);
    assert.equal(stream.truncated, true);
    stream.addAnswer('ещё');
    assert.equal(stream.answer.length, 1024 * 1024);
    assert.equal(stream.truncated, true);

    for (let i = 0; i < 5001; i++) {
      stream.onUpdate({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, kind: 'read', title: 'read' });
    }
    assert.equal(stream.steps.length, 5000);
  } finally {
    stream.stop();
    calls.length = 0;
  }
});

test('createTurnStream: черновик шлётся по изменению и heartbeat, waitDraft дожидается отправки', async () => {
  const stream = startStream();
  const previousFetch = globalThis.fetch;
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  let deferred = null;
  try {
    await stream.pushDraft();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendMessageDraft');
    assert.equal(calls[0].body.text, '');
    assert.equal(calls[0].body.can_stop, true);

    await stream.pushDraft();
    assert.equal(calls.length, 1, 'без изменений черновик не отправляется');

    stream.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Привет' } });
    await stream.pushDraft();
    assert.equal(calls.length, 2);
    await stream.pushDraft();
    assert.equal(calls.length, 2);

    shift = 9000;
    await stream.pushDraft();
    assert.equal(calls.length, 3, 'долгое отсутствие изменений вызывает heartbeat');
    shift = 0;

    stream.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ещё' } });
    globalThis.fetch = async (url, init) => {
      const method = String(url).split('/').pop().split('?')[0];
      calls.push({ method, body: JSON.parse(init.body) });
      await new Promise((resolve) => { deferred = resolve; });
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };
    const pending = stream.pushDraft();
    setTimeout(() => deferred?.(), 10);
    await stream.waitDraft();
    await pending;
    assert.equal(calls.length, 4);
  } finally {
    Date.now = realNow;
    globalThis.fetch = previousFetch;
    stream.stop();
    calls.length = 0;
  }
});

test('createTurnStream: waitDraft не ждёт зависшую отправку дольше 3 с', async () => {
  const stream = startStream();
  const previousFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let release = null;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').pop().split('?')[0], body: JSON.parse(init.body) });
    await held;
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 3000 ? 10 : ms, ...args);
  const pending = stream.pushDraft();
  const started = Date.now();
  try {
    await stream.waitDraft();
    assert.ok(Date.now() - started < 1000, 'ожидание черновика прервалось по тайм-ауту');
    assert.equal(calls[0].method, 'sendMessageDraft');
  } finally {
    release?.();
    await pending.catch(() => {});
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = originalSetTimeout;
    stream.stop();
    calls.length = 0;
  }
});

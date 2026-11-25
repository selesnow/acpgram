import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'acpgram-turn-stream-idle-'));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
process.env.TURN_IDLE_MINUTES = '0.01';

const { db } = await import('../src/ctx.mjs');
const { getEngine } = await import('../src/engines.mjs');
const { createTurnStream } = await import('../src/turnStream.mjs');

const USER = 1;
const engine = getEngine('claude');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) });

after(() => {
  globalThis.fetch = originalFetch;
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('createTurnStream: длительный простой без событий закрывает агента и снимает таймер остановки', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const intervals = [];
  let force = null;
  let closed = false;
  globalThis.setInterval = (fn, ms) => {
    const item = { fn, ms, cleared: false };
    intervals.push(item);
    return item;
  };
  globalThis.clearInterval = (id) => {
    if (id) id.cleared = true;
  };
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 0) {
      force = fn;
      return { forced: true };
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  globalThis.clearTimeout = (id) => {
    if (id?.forced) return;
    return originalClearTimeout(id);
  };
  const session = db.startSession(`s-idle-${Date.now()}`, USER, USER, 'default', home, 'claude');
  const requestId = db.startRequest(session, 'простой');
  const st = { userId: USER, to: USER, busy: true, agent: { closed: false, close: () => (closed = true) }, turnId: 'idle', stopTimer: null };
  const stream = createTurnStream({ st, to: USER, clean: (s) => s, engine, lang: 'ru', startedAt: Date.now(), getRequestId: () => requestId });
  try {
    const idle = intervals.find((x) => x.ms === 600);
    const draft = intervals.find((x) => x.ms === 1000);
    assert.ok(idle, 'таймер простоя создан');
    assert.ok(draft, 'таймер черновика создан');
    await new Promise((resolve) => originalSetTimeout(resolve, 650));
    idle.fn();
    assert.equal(typeof force, 'function');
    force();
    assert.equal(closed, true);
    assert.equal(st.stopTimer, null);
    stream.stop();
    assert.equal(idle.cleared, true);
    assert.equal(draft.cleared, true);
  } finally {
    stream.stop();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

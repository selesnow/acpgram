import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-turn-queue-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const realFetch = globalThis.fetch;
const calls = [];
let messageId = 100;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ method, body });
  return { json: async () => ({ ok: true, result: { message_id: messageId++ } }) };
};

const { db } = await import('../src/ctx.mjs');
const { getEngine } = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');
const { placeAsks } = await import('../src/asks.mjs');
const { getState } = await import('../src/state.mjs');
const { drainQueue, dropQueue, enqueue, onAskCallback, onQueueCallback } = await import('../src/turn.mjs');

const USER = 1;
const project = join(home, 'project');
mkdirSync(project, { recursive: true });
db.setSetting(`lang:${USER}`, 'en');
db.setSetting('catalog:claude', JSON.stringify({ models: [{ id: 'test-model', name: 'Test' }], efforts: [], defaultModel: 'test-model', defaultEffort: null, at: new Date().toISOString(), version: null, envSig: null }));
db.setSetting(`model:${USER}:claude`, 'test-model');

const findCall = (method) => calls.find((c) => c.method === method);
const cb = (data, messageIdValue = 9) => ({ id: 'cb', data, message: { message_id: messageIdValue } });

function freshState() {
  const st = getState(USER, USER, null);
  st.agent = null;
  st.engine = 'claude';
  st.project = project;
  st.busy = false;
  st.suppress = false;
  st.queued = null;
  st.perms = new Map();
  st.asks = new Map();
  return st;
}

function failingAgent(st) {
  const a = {
    engine: getEngine('claude'),
    cwd: project,
    sessionId: 'queue-session',
    dbSessionId: db.startSession('queue-session', USER, USER, 'default', project, 'claude'),
    mode: 'default',
    caps: {},
    applied: {},
    promptCount: 0,
    closed: false,
    request: async () => ({}),
    prompt: async () => {
      throw new Error('queue stop');
    },
    cancel() {},
    close() {
      this.closed = true;
    },
  };
  st.agent = a;
  return a;
}

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('enqueue: сообщение в очереди можно заменить, старое уведомление редактируется', async () => {
  const st = freshState();
  st.busy = true;
  calls.length = 0;
  await enqueue(st, 'первый', { quote: 'цитата' });
  assert.equal(st.queued.text, 'первый');
  assert.equal(st.queued.quote, 'цитата');
  const added = findCall('sendMessage');
  assert.equal(added.body.text, t('queue.added', 'en'));
  assert.ok(calls.some((c) => c.body.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === 'q:x')));
  const firstId = st.queued.messageId;

  calls.length = 0;
  await enqueue(st, 'второй');
  assert.equal(st.queued.text, 'второй');
  const replaced = findCall('editMessageText');
  assert.equal(replaced.body.message_id, firstId);
  assert.equal(replaced.body.text, t('queue.replaced', 'en'));
});

test('dropQueue и drainQueue: пустая очередь и занятый диалог ничего не отправляют', async () => {
  const st = freshState();
  assert.equal(dropQueue(st), false);
  assert.equal(await drainQueue(st), undefined);
  st.queued = { text: 'x', quote: null, messageId: 7 };
  st.busy = true;
  assert.equal(await drainQueue(st), undefined);
  assert.equal(st.queued.text, 'x');
});

test('onQueueCallback: устаревшая кнопка, отмена и прерывание занятого запроса', async () => {
  const st = freshState();
  calls.length = 0;
  await onQueueCallback(st, cb('q:x', 1));
  assert.equal(findCall('answerCallbackQuery').body.text, t('queue.stale', 'en'));

  calls.length = 0;
  st.queued = { text: 'x', quote: null, messageId: 9 };
  await onQueueCallback(st, cb('q:x'));
  assert.equal(st.queued, null);
  assert.equal(findCall('editMessageText').body.text, t('queue.cancelled', 'en'));

  calls.length = 0;
  st.busy = true;
  st.queued = { text: 'x', quote: null, messageId: 9 };
  let cancelled = 0;
  st.agent = { cancel: () => cancelled++ };
  await onQueueCallback(st, cb('q:s'));
  assert.equal(cancelled, 1);
  assert.equal(st.queued.text, 'x');
});

test('onQueueCallback: кнопка «отправить» запускает очередь, когда диалог свободен', async () => {
  const st = freshState();
  const a = failingAgent(st);
  st.queued = { text: 'из очереди', quote: null, messageId: 9 };
  calls.length = 0;
  await onQueueCallback(st, cb('q:s'));
  assert.equal(st.queued, null);
  assert.equal(st.busy, false);
  assert.ok(calls.some((c) => c.method === 'sendRichMessage'), 'очередь дошла до delivering');
  a.close();
});

test('onAskCallback: неактуальный вариант и выбор во время запроса уходит в очередь', async () => {
  const st = freshState();
  calls.length = 0;
  await onAskCallback(st, cb('ask:999:0'));
  assert.equal(findCall('answerCallbackQuery').body.text, t('ask.stale', 'en'));

  const text = placeAsks(st, '\u00010\u0001', [['Да', 'Нет']]);
  const data = /ask:(\d+):0/.exec(text)?.[0];
  assert.ok(data, 'кнопка быстрого ответа зарегистрирована');
  st.busy = true;
  calls.length = 0;
  await onAskCallback(st, cb(data));
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.text === t('ask.chosen', 'en', { text: 'Да' })));
  assert.equal(st.queued.text, 'Да');
});

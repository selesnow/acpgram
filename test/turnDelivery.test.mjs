import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-turn-delivery-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;
delete process.env.TURN_IDLE_MINUTES;

const realFetch = globalThis.fetch;
const calls = [];
let messageId = 100;
let failRich = false;
let failDocument = false;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : JSON.parse(init.body || '{}');
  calls.push({ method, body });
  if (failRich && method === 'sendRichMessage') throw new Error('rich network error');
  if (failDocument && method === 'sendDocument') return { json: async () => ({ ok: false, error_code: 400, description: 'bad file' }) };
  return { json: async () => ({ ok: true, result: { message_id: messageId++ } }) };
};

const { db } = await import('../src/ctx.mjs');
const { ENGINES } = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');
const stateApi = await import('../src/state.mjs');
const { deliverTurn } = await import('../src/turnDelivery.mjs');

const USER = 1;
const project = join(home, 'project');
const report = join(project, 'report.txt');
mkdirSync(project, { recursive: true });
writeFileSync(report, 'Содержание отчёта');
db.setSetting(`lang:${USER}`, 'en');
stateApi.topicsSupport.enabled = false;

const resetCalls = () => {
  calls.length = 0;
};
const findCall = (method, test) => calls.find((c) => c.method === method && (!test || test(c)));
const richMarkdown = (call) => {
  const rich = call.body.rich_message;
  return (typeof rich === 'string' ? JSON.parse(rich) : rich).markdown;
};

function state() {
  const st = stateApi.getState(USER, USER, null);
  st.agent = null;
  st.project = project;
  st.busy = false;
  st.suppress = false;
  st.queued = null;
  st.perms = new Map();
  st.asks = new Map();
  return st;
}

function delivery(overrides = {}) {
  const st = overrides.st ?? state();
  const sessionId = db.startSession('delivery-session', USER, USER, 'default', project, 'claude');
  return {
    st,
    to: st.to,
    text: 'сделай отчёт',
    dbText: 'сделай отчёт',
    lang: 'en',
    engine: ENGINES.claude,
    naming: false,
    stopReason: 'end_turn',
    error: null,
    usage: {},
    agent: { cwd: project },
    startedAt: Date.now() - 100,
    steps: [],
    sent: { text: 'Готово', paths: [] },
    asked: { asks: [] },
    gitted: { actions: [] },
    titled: { title: '' },
    answerText: 'Готово',
    limited: false,
    truncated: false,
    requestId: db.startRequest(sessionId, 'сделай отчёт'),
    ...overrides,
  };
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

test('deliverTurn: файл уходит внутри rich-сообщения один раз и не дублируется отдельной отправкой', async () => {
  const params = delivery({ sent: { text: `Отчёт \u00000\u0000 готов`, paths: [report] }, answerText: 'Отчёт готов' });
  resetCalls();
  failRich = false;
  failDocument = false;
  try {
    assert.equal(await deliverTurn(params), true);
    const richCalls = calls.filter((c) => c.method === 'sendRichMessage');
    assert.equal(richCalls.length, 1);
    const rich = JSON.parse(richCalls[0].body.rich_message);
    assert.equal((rich.markdown.match(/tg:\/\/document\?id=f0/g) ?? []).length, 1);
    assert.deepEqual(rich.media.map((m) => m.id), ['f0']);
    assert.equal(findCall('sendDocument'), undefined);
    assert.equal(findCall('sendPhoto'), undefined);
  } finally {
    failRich = false;
    failDocument = false;
  }
});

test('deliverTurn: отказ sendRich не роняет ответ, файлы уходят отдельно и неудавшийся файл сообщает об ошибке', async () => {
  const params = delivery({ sent: { text: `Отчёт \u00000\u0000 готов`, paths: [report] }, answerText: 'Отчёт готов' });
  resetCalls();
  failRich = true;
  failDocument = true;
  try {
    assert.equal(await deliverTurn(params), true);
    assert.ok(findCall('sendRichMessage'), 'попытка rich-отправки была');
    const documents = calls.filter((c) => c.method === 'sendDocument');
    assert.equal(documents.length, 1, 'файл отправлен отдельно ровно один раз');
    assert.match(documents[0].body.document ?? '', /\[file\]/);
    const notice = findCall('sendMessage', (c) => /Could not send the file/.test(c.body.text ?? ''));
    assert.ok(notice, 'пользователь видит сообщение о неудачной отправке');
    assert.equal(notice.body.text, t('file.sendFail', 'en', { name: 'report.txt', why: t('file.why.error', 'en', { msg: 'Telegram sendDocument: 400 bad file' }) }));
  } finally {
    failRich = false;
    failDocument = false;
  }
});

test('deliverTurn: недоступный файл заменяется текстом file.sendFail внутри ответа', async () => {
  const missing = join(project, 'missing.txt');
  const params = delivery({ sent: { text: `Отчёт \u00000\u0000 готов`, paths: [missing] }, answerText: 'Отчёт готов' });
  resetCalls();
  failRich = false;
  failDocument = false;
  assert.equal(await deliverTurn(params), true);
  const markdown = richMarkdown(findCall('sendRichMessage'));
  assert.match(markdown, /Could not send the file «missing.txt»: the file does not exist/);
  assert.equal(findCall('sendDocument'), undefined);
});

test('deliverTurn: подавленный ход завершает запрос, сбрасывает очередь и ничего не отправляет', async () => {
  const st = state();
  st.suppress = true;
  st.queued = { text: 'следующее сообщение', quote: null, messageId: null };
  const params = delivery({ st, to: st.to });
  resetCalls();
  assert.equal(await deliverTurn(params), false);
  assert.equal(st.suppress, false);
  assert.equal(st.queued, null);
  assert.equal(calls.length, 0);
  assert.equal(db.unfinishedRequests().some((r) => r.id === params.requestId), false, 'запрос закрыт в базе');
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'acpgram-turn-agent-'));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

const { db } = await import('../src/ctx.mjs');
const { getEngine } = await import('../src/engines.mjs');
db.setSetting('catalog:claude', JSON.stringify({
  models: [{ id: 'm1', name: 'Model One' }],
  efforts: [{ id: 'high', name: 'High' }],
  defaultModel: 'm1',
  defaultEffort: 'high',
  at: new Date().toISOString(),
  version: null,
  envSig: null,
}));
db.setSetting('model:1:claude', 'm1');
db.setSetting('effort:1:claude', 'high');
db.upsertUser({ user_id: 2, level: 'normal', added_by: 1 });
db.setUserModels(2, { claude: [] });

const { ClosedError, LimitError, ProjectError, topicsSupport } = await import('../src/state.mjs');
const { callAgent } = await import('../src/turnAgent.mjs');

const USER = 1;
const OTHER = 2;
const engine = getEngine('claude');

after(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeAgent({ prompt = async () => ({ stopReason: 'end_turn', usage: {} }), ...extra } = {}) {
  const a = {
    engine,
    sessionId: 's-agent',
    dbSessionId: 77,
    mode: 'default',
    caps: {},
    applied: {},
    promptCount: 0,
    requests: [],
    prompts: [],
    lastCostTotal: null,
    costSoFar: null,
    request(method, params) {
      this.requests.push([method, params]);
      return Promise.resolve({});
    },
    ...extra,
    prompt(blocks) {
      this.prompts.push(blocks);
      return prompt(blocks);
    },
  };
  return a;
}

function fakeStream({ pushDraftError = null, ...extra } = {}) {
  return {
    answer: '',
    lastUsage: null,
    pushDraftCalls: 0,
    added: [],
    async pushDraft() {
      this.pushDraftCalls++;
      if (pushDraftError) throw pushDraftError;
    },
    addAnswer(part) {
      this.added.push(part);
      this.answer += part;
    },
    ...extra,
  };
}

async function invoke(a, { userId = USER, lang = 'en', naming = false, stream = fakeStream(), text = 'привет' } = {}) {
  const st = { userId, suppress: false, agent: a };
  const begun = [];
  const result = await callAgent({
    st,
    text,
    files: [],
    quote: null,
    lang,
    naming,
    stream,
    beginRequest: (sessionId) => {
      begun.push(sessionId);
      st.requestId = begun.length;
    },
    getRequestId: () => st.requestId ?? null,
  });
  return { ...result, stream, begun };
}

test('callAgent: успешный запрос передаёт подсказки, считает стоимость и возвращает usage', async () => {
  const stream = fakeStream({ lastUsage: { _meta: { '_claude/model': 'claude-x' } } });
  const a = fakeAgent({
    lastCostTotal: 1.25,
    costSoFar: 0.25,
    applied: { model: 'm1', effort: 'high' },
    prompt: async () => ({
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 4, cachedReadTokens: 1, totalTokens: 8 },
    }),
  });
  const result = await invoke(a, { stream, naming: true });

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.error, null);
  assert.equal(result.limited, false);
  assert.equal(result.usage.model, 'claude-x');
  assert.equal(result.usage.effort, 'High');
  assert.equal(result.usage.cost, 1);
  assert.deepEqual(
    { input: result.usage.input, output: result.usage.output, cachedRead: result.usage.cachedRead, total: result.usage.total },
    { input: 3, output: 4, cachedRead: 1, total: 8 },
  );
  assert.equal(stream.pushDraftCalls, 1);
  assert.deepEqual(result.begun, [77]);
  assert.equal(a.prompts.length, 1);
  assert.equal(a.promptCount, 1);
  const text = a.prompts[0].filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  assert.match(text, /привет/);
  assert.match(text, /\[\[ask:/);
  assert.match(text, /\[\[title:/);
  assert.match(text, /outbox/);
  assert.equal(a.requests.length, 0, 'выбранная модель и уровень совпадают с настройками сессии');
});

test('callAgent: в режиме диалогов агент получает подсказку о метке темы', async () => {
  topicsSupport.enabled = true;
  const a = fakeAgent();
  try {
    await invoke(a, { naming: true });
    const text = a.prompts[0].filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    assert.match(text, /\[\[topic:/);
  } finally {
    topicsSupport.enabled = false;
  }
});

test('callAgent: подсказки и имя модели уходят только в первый запрос из десяти', async () => {
  const a = fakeAgent({ promptCount: 9, applied: { model: 'm1', effort: 'high' } });
  const result = await invoke(a);

  assert.equal(a.promptCount, 10);
  assert.equal(a.prompts[0].length, 1);
  assert.equal(a.prompts[0][0].type, 'text');
  assert.equal(a.prompts[0][0].text, 'привет');
  assert.equal(result.usage.model, 'Model One');
  assert.equal(result.usage.effort, 'High');
});

test('callAgent: первая стоимость после возобновления сессии не оценивается', async () => {
  const a = fakeAgent({ lastCostTotal: 5, costBaseUnknown: true, applied: { model: 'm1', effort: 'high' } });
  const result = await invoke(a);

  assert.equal(result.usage.cost, null);
  assert.equal(a.costBaseUnknown, false);
  assert.equal(a.costSoFar, 5);
});

test('callAgent: ошибка доступа к модели не отправляет запрос', async () => {
  const stream = fakeStream();
  const a = fakeAgent({ applied: {} });
  const result = await invoke(a, { userId: OTHER, stream });

  assert.equal(result.limited, true);
  assert.ok(stream.answer.length > 0);
  assert.equal(a.prompts.length, 0);
  assert.deepEqual(result.begun, [77]);
});

test('callAgent: отказ переключить модель из-за ограничения не отправляет запрос', async () => {
  db.setUserModels(OTHER, { claude: ['m1'] });
  db.setSetting('model:2:claude', 'm1');
  const stream = fakeStream();
  const a = fakeAgent({
    applied: { model: '?' },
    request: () => Promise.reject(new Error('нет доступа')),
  });
  try {
    const result = await invoke(a, { userId: OTHER, stream });

    assert.equal(result.limited, true);
    assert.ok(stream.answer.length > 0);
    assert.equal(a.prompts.length, 0);
  } finally {
    db.setUserModels(OTHER, { claude: [] });
  }
});

test('callAgent: закрытие сессии отменяет ход, лимиты показываются ответом', async () => {
  const closed = fakeStream({ pushDraftError: new ClosedError() });
  const closedResult = await invoke(fakeAgent(), { stream: closed });
  assert.equal(closedResult.stopReason, 'cancelled');
  assert.equal(closedResult.limited, false);
  assert.equal(closed.answer, '');

  const limited = fakeStream({ pushDraftError: new LimitError('нет слотов') });
  const limitResult = await invoke(fakeAgent(), { stream: limited });
  assert.equal(limitResult.limited, true);
  assert.equal(limitResult.stream.answer, 'нет слотов');

  const project = fakeStream({ pushDraftError: new ProjectError('проект недоступен') });
  const projectResult = await invoke(fakeAgent(), { stream: project });
  assert.equal(projectResult.limited, true);
  assert.equal(projectResult.stream.answer, 'проект недоступен');
});

test('callAgent: обычная ошибка добавляется в ответ и создаёт запрос с ID сессии', async () => {
  const stream = fakeStream({ pushDraftError: new Error('boom') });
  const a = fakeAgent({ dbSessionId: 99 });
  const result = await invoke(a, { stream });

  assert.equal(result.limited, false);
  assert.equal(result.error, 'boom');
  assert.match(stream.answer, /⚠️ Error: boom/);
  assert.deepEqual(result.begun, [99]);
  assert.equal(result.usage, null);
});

test('callAgent: подавленный ход не запускает агента', async () => {
  const stream = fakeStream();
  const a = fakeAgent();
  const st = { userId: USER, suppress: true, agent: a };
  let beginCalls = 0;
  const result = await callAgent({
    st,
    text: 'привет',
    files: [],
    quote: null,
    lang: 'en',
    naming: false,
    stream,
    beginRequest: () => { beginCalls++; },
    getRequestId: () => null,
  });

  assert.equal(result.stopReason, 'cancelled');
  assert.equal(a.prompts.length, 0);
  assert.equal(beginCalls, 1);
});

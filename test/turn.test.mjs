import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'acpgram-turn-'));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
delete process.env.TURN_IDLE_MINUTES;

const { botInfo, db } = await import('../src/ctx.mjs');
const { getEngine } = await import('../src/engines.mjs');
const { setGitAvailable } = await import('../src/git.mjs');
const { askPermission } = await import('../src/permission.mjs');
const { getState, stopUser, topicsSupport } = await import('../src/state.mjs');
const { onPermissionCallback, runTurn } = await import('../src/turn.mjs');

const USER_ID = 1;
const CHAT_ID = 1;
const project = join(home, 'project');
const engine = getEngine('claude');

mkdirSync(project, { recursive: true });
db.setSetting('catalog:claude', JSON.stringify({ models: [{ id: 'test-model', name: 'Test' }], efforts: [], defaultModel: 'test-model', defaultEffort: null, at: new Date().toISOString(), version: null, envSig: null }));
db.setSetting(`lang:${USER_ID}`, 'en');
topicsSupport.enabled = true;

after(() => {
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function state(topic) {
  const st = getState(USER_ID, CHAT_ID, topic);
  st.agent = null;
  st.engine = 'claude';
  st.project = project;
  st.busy = false;
  st.suppress = false;
  st.queued = null;
  st.onUpdate = null;
  st.requestId = null;
  st.stopTimer = null;
  st.turnId = null;
  st.perms = new Map();
  st.asks = new Map();
  return st;
}

function agent(st, sessionId, prompt) {
  const a = {
    engine,
    cwd: project,
    sessionId,
    dbSessionId: db.startSession(sessionId, USER_ID, CHAT_ID, 'default', project, 'claude'),
    mode: 'default',
    caps: {},
    applied: {},
    promptCount: 0,
    requests: [],
    closed: false,
    request(method, params) {
      this.requests.push([method, params]);
      return Promise.resolve({});
    },
    prompt(blocks) {
      return prompt(this, blocks, st);
    },
    cancel() {},
    close() {
      this.closed = true;
    },
  };
  a.onPermission = (p) => askPermission(st, p);
  st.agent = a;
  return a;
}

function telegram(handlers = {}) {
  const calls = [];
  const original = globalThis.fetch;
  let messageId = 100;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop().split('?')[0];
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : JSON.parse(init.body);
    const result = method === 'sendMessage' ? { message_id: messageId++ } : {};
    calls.push({ method, body });
    await handlers[method]?.({ body, result, calls });
    return { json: async () => ({ ok: true, result }) };
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const findCall = (calls, method) => calls.find((c) => c.method === method);

function finalRichCall(calls) {
  const call = calls.find((c) => {
    if (c.method !== 'sendRichMessage' || !c.body.rich_message) return false;
    const rich = typeof c.body.rich_message === 'string' ? JSON.parse(c.body.rich_message) : c.body.rich_message;
    return Boolean(rich.markdown);
  });
  assert.ok(call, 'итоговое rich-сообщение отправлено');
  return call;
}

function finalMarkdown(calls) {
  const rich = finalRichCall(calls).body.rich_message;
  return (typeof rich === 'string' ? JSON.parse(rich) : rich).markdown;
}

test('runTurn: черновик, события ACP, метки и смена модели до финальной доставки', async () => {
  setGitAvailable(true);
  writeFileSync(join(project, 'report.txt'), 'отчёт');
  db.setSetting(`model:${USER_ID}:claude`, 'test-model');
  db.saveTopic(USER_ID, 70, { project, engine: 'claude', named: false });
  const st = state(70);
  const tg = telegram();
  let eventCallCount = null;
  const a = agent(st, 's-normal', async (_a, _blocks, st) => {
    eventCallCount = tg.calls.length;
    st.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[[title: Отчёт за ноябрь]]\nГотово: [[ask: Да | Нет]] [[git:push]] [[send:report.txt]]' } });
    st.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'execute', title: 'ls', content: [] });
    st.onUpdate({ sessionUpdate: 'usage_update', _meta: { '_claude/model': 'test-model' } });
    return { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4 } };
  });
  try {
    await runTurn(st, 'сделай отчёт');
    assert.equal(eventCallCount, 1, 'до событий уже отправлен черновик');
    assert.equal(tg.calls[0].method, 'sendMessageDraft');
    assert.equal(a.requests[0][1].value, 'test-model', 'модель агента выставлена до prompt');
    const finalIndex = tg.calls.indexOf(finalRichCall(tg.calls));
    assert.ok(finalIndex > 0);
    const rich = finalMarkdown(tg.calls);
    assert.match(rich, /Готово/);
    assert.match(rich, /tg-button-row/);
    assert.doesNotMatch(rich, /\[\[(title|ask|git|send):/);
    assert.ok(st.asks.size > 0, 'кнопки быстрого ответа запомнены в диалоге');
    assert.equal(db.getTopic(USER_ID, 70).named, 1, 'тема названа по метке title');
    assert.equal(findCall(tg.calls, 'editForumTopic').body.name.includes('Отчёт за ноябрь'), true);
    assert.ok(tg.calls.slice(finalIndex + 1).some((c) => c.method === 'sendMessage' && /git|Git/i.test(c.body.text ?? '')), 'метка git предложила кнопку под ответом');
    assert.ok(tg.calls.some((c) => c.method === 'sendRichMessage' && typeof c.body.rich_message === 'string' && c.body.rich_message.includes('attach://f0')), 'метка send прикрепила файл');
    assert.equal(st.busy, false);
    assert.equal(st.onUpdate, null);
  } finally {
    a.close();
    tg.restore();
    setGitAvailable(false);
    db.setSetting(`model:${USER_ID}:claude`, null);
    db.saveTopic(USER_ID, 70, { named: false });
  }
});

test('runTurn: метка topic создаёт тему ботом и даёт ссылку', async () => {
  const st = state(null);
  const tg = telegram({ createForumTopic: ({ result }) => (result.message_thread_id = 555) });
  const prevUsername = botInfo.username;
  botInfo.username = 'acp_bot';
  const a = agent(st, 's-topic', async (_a, _blocks, st) => {
    st.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Готово: [[topic: Отчёт по списаниям]]' } });
    return { stopReason: 'end_turn' };
  });
  try {
    await runTurn(st, 'создай тему');
    const created = findCall(tg.calls, 'createForumTopic');
    assert.ok(created, 'тема создана через Bot API');
    assert.match(created.body.name, /Отчёт по списаниям/);
    assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && c.body.message_thread_id === 555), 'в новой теме есть приветствие');
    assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url === 'https://t.me/acp_bot/555'), 'в ответе есть ссылка на тему');
    assert.equal(db.getTopic(USER_ID, 555)?.engine, 'claude');
    assert.doesNotMatch(finalMarkdown(tg.calls), /\[\[topic:/);
  } finally {
    a.close();
    tg.restore();
    botInfo.username = prevUsername;
    db.deleteTopic(USER_ID, 555);
  }
});

test('runTurn: запрос разрешения, ответ кнопкой и смена режима агента', async () => {
  setGitAvailable(true);
  const st = state(null);
  let resolveCallback;
  const callbackDone = new Promise((resolve) => (resolveCallback = resolve));
  let answered = false;
  const tg = telegram({
    sendMessage: ({ body }) => {
      const data = body.reply_markup?.inline_keyboard?.[1]?.[0]?.callback_data;
      if (!data?.startsWith('perm:') || answered) return;
      answered = true;
      setTimeout(async () => {
        try {
          await onPermissionCallback(st, { id: 'cb-1', data, message: { message_id: 1 } });
          resolveCallback();
        } catch (e) {
          resolveCallback(e);
        }
      }, 0);
    },
  });
  let outcome = null;
  const a = agent(st, 's-perm', async (a, _blocks, st) => {
    outcome = await a.onPermission({
      sessionId: 's-perm',
      toolCall: { toolCallId: 'c1', kind: 'execute', title: 'git status', rawInput: { command: 'git status' } },
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'exit-plan-default', kind: 'other', name: 'Exit plan mode' },
      ],
    });
    st.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Разрешено' } });
    return { stopReason: 'end_turn' };
  });
  try {
    await runTurn(st, 'проверь git');
    const callbackError = await callbackDone;
    if (callbackError) throw callbackError;
    assert.deepEqual(outcome, { outcome: 'selected', optionId: 'exit-plan-default' });
    assert.equal(answered, true);
    const ask = findCall(tg.calls, 'sendMessage');
    assert.match(ask.body.text, /git status/);
    assert.equal(ask.body.reply_markup.inline_keyboard[1][0].text, '▶️ Exit plan mode');
    const settled = findCall(tg.calls, 'editMessageReplyMarkup');
    assert.equal(settled.body.reply_markup.inline_keyboard[0][0].text, '▶️ Exit plan mode');
    assert.match(finalMarkdown(tg.calls), /Разрешено/);
    assert.equal(st.perms.size, 0);
  } finally {
    a.close();
    tg.restore();
    setGitAvailable(false);
  }
});

test('runTurn: типичная ошибка агента доходит до пользователя и закрывает запрос', async () => {
  const st = state(null);
  const tg = telegram();
  const a = agent(st, 's-error', async () => {
    throw new Error('boom');
  });
  try {
    await runTurn(st, 'упади');
    const rich = finalMarkdown(tg.calls);
    assert.match(rich, /⚠️ Error: boom/);
    assert.equal(st.busy, false);
    assert.equal(st.requestId, null);
  } finally {
    a.close();
    tg.restore();
  }
});

test('runTurn: остановка во время хода гасит финальный ответ и очищает очередь', async () => {
  const st = state(null);
  st.queued = { text: 'следующий запрос', quote: null, messageId: 1 };
  const tg = telegram();
  let promptCount = 0;
  const a = agent(st, 's-suppressed', async (_a, _blocks, turnState) => {
    promptCount++;
    stopUser(turnState, 'test');
    turnState.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ответ не нужен' } });
    return { stopReason: 'end_turn' };
  });
  try {
    await runTurn(st, 'прервать');
    assert.equal(promptCount, 1);
    assert.equal(st.queued, null);
    assert.equal(st.suppress, false);
    assert.equal(st.busy, false);
    assert.ok(tg.calls.some((c) => c.method === 'sendMessageDraft'), 'черновик до остановки отправлен');
    assert.equal(tg.calls.some((c) => c.method === 'sendRichMessage' && c.body.rich_message), false, 'финальный ответ подавлен');
  } finally {
    a.close();
    tg.restore();
  }
});

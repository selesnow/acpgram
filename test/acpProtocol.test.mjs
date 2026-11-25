import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpAgent } from '../src/acp.mjs';

const PROTOCOL = fileURLToPath(new URL('./fixtures/protocol-agent.mjs', import.meta.url));
const dirs = [];

function makeAgent({ scenario, onPermission, onUpdate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acpgram-acp-protocol-'));
  dirs.push(dir);
  const log = join(dir, 'rpc.jsonl');
  const agent = new AcpAgent({
    cwd: dir,
    command: process.execPath,
    args: [PROTOCOL],
    env: { ...process.env, ACPGRAM_HOME: dir, FAKE_PROTOCOL: scenario, FAKE_LOG: log },
    name: 'Protocol',
    onPermission,
    onUpdate,
  });
  const messages = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).msg) : [];
  return { agent, messages };
}

async function closeAgent(agent) {
  if (agent.closed) return;
  const done = new Promise((resolve) => {
    agent.onExit = resolve;
  });
  agent.close();
  await done;
}

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > ms) throw new Error('условие не выполнено');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const OVERFLOW_SCRIPT = `
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const heartbeat = process.env.FAKE_HEARTBEAT;
spawn(process.execPath, ['-e', 'setInterval(() => require("fs").appendFileSync(process.argv[1], Date.now() + "\\\\n"), 50)', heartbeat], { stdio: 'ignore' });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: { currentModeId: 'default' } } });
  if (msg.method === 'session/prompt') setTimeout(() => process.stdout.write('x'.repeat(33 * 1024 * 1024) + "\\n"), 50);
});
`;

function makeOverflowAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'acpgram-acp-overflow-'));
  dirs.push(dir);
  const script = join(dir, 'overflow-agent.mjs');
  const heartbeat = join(dir, 'heartbeat.log');
  writeFileSync(script, OVERFLOW_SCRIPT);
  const agent = new AcpAgent({
    cwd: dir,
    command: process.execPath,
    args: [script],
    env: { ...process.env, FAKE_HEARTBEAT: heartbeat },
    name: 'Overflow',
  });
  return { agent, heartbeat };
}

async function waitStable(path, stableMs = 700, timeoutMs = 5000) {
  const start = Date.now();
  let last = -1;
  let changed = Date.now();
  for (;;) {
    const size = existsSync(path) ? statSync(path).size : -1;
    if (size !== last) {
      last = size;
      changed = Date.now();
    }
    if (last > 0 && Date.now() - changed > stableMs) return;
    if (Date.now() - start > timeoutMs) throw new Error('потомок агента не остановился');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('AcpAgent: outcome разрешения уходит агенту тем же id и возвращается в ответе', async () => {
  const outcome = { outcome: 'selected', optionId: 'allow' };
  let request;
  const { agent, messages } = makeAgent({
    scenario: 'permission',
    onPermission: async (params) => {
      request = params;
      return outcome;
    },
  });
  try {
    await agent.init();
    const res = await agent.prompt('продолжить');
    assert.equal(request.options[0].optionId, 'allow');
    assert.deepEqual(res.outcome, outcome);
    const reply = messages().find((msg) => msg.id === 9001 && !msg.method && msg.result?.outcome);
    assert.deepEqual(reply.result.outcome, outcome, 'ответ с outcome ушёл с id запроса агента');
  } finally {
    await closeAgent(agent);
  }
});

test('AcpAgent: исключение в обработчике разрешения превращается в cancelled', async () => {
  const { agent, messages } = makeAgent({
    scenario: 'permission',
    onPermission: async () => {
      throw new Error('boom');
    },
  });
  try {
    await agent.init();
    const res = await agent.prompt('продолжить');
    assert.deepEqual(res.outcome, { outcome: 'cancelled' });
    const reply = messages().find((msg) => msg.id === 9001 && !msg.method && msg.result?.outcome);
    assert.deepEqual(reply.result.outcome, { outcome: 'cancelled' });
  } finally {
    await closeAgent(agent);
  }
});

test('AcpAgent: неизвестный метод агента получает -32601 и не ломает ответ', async () => {
  const { agent, messages } = makeAgent({ scenario: 'unknown_method' });
  try {
    await agent.init();
    const res = await agent.prompt('вопрос');
    assert.deepEqual(res.botError, { code: -32601, message: 'Method not supported' });
    const reply = messages().find((msg) => msg.id === 9002 && !msg.method && msg.error);
    assert.deepEqual(reply.error, { code: -32601, message: 'Method not supported' });
  } finally {
    await closeAgent(agent);
  }
});

test('AcpAgent: ошибка JSON-RPC отклоняет ожидающий запрос', async () => {
  const { agent } = makeAgent({ scenario: 'prompt_error' });
  try {
    await agent.init();
    await assert.rejects(agent.prompt('привет'), /ACP -42: boom/);
  } finally {
    await closeAgent(agent);
  }
});

test('AcpAgent: бросающий onUpdate не роняет обмен и не оставляет unhandledRejection', async () => {
  const updates = [];
  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on('unhandledRejection', onRejection);
  const { agent } = makeAgent({
    scenario: 'update_throw',
    onUpdate: (update) => {
      updates.push(update);
      throw new Error('обработчик обновления упал');
    },
  });
  try {
    await agent.init();
    const res = await agent.prompt('привет');
    assert.equal(res.stopReason, 'end_turn');
    assert.equal(updates[0].content.text, 'событие');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    await closeAgent(agent);
  }
});

test('AcpAgent: resume загружает сессию, дожидается истории и не меняет совпадающий режим', async () => {
  const updates = [];
  const { agent, messages } = makeAgent({
    scenario: 'resume',
    onUpdate: (update) => updates.push(update.content.text),
  });
  try {
    await agent.init('default', { resume: 'old-session' });
    assert.equal(agent.sessionId, 'old-session');
    assert.deepEqual(updates, ['старая история', 'конец истории']);
    const sent = messages();
    assert.ok(sent.some((msg) => msg.method === 'session/load' && msg.params.sessionId === 'old-session'));
    assert.equal(sent.some((msg) => msg.method === 'session/set_mode'), false);
    assert.equal((await agent.prompt('новое сообщение')).stopReason, 'end_turn');
  } finally {
    await closeAgent(agent);
  }
});

test('AcpAgent: cancel до init безопасен, после init отправляет session/cancel', async () => {
  const { agent, messages } = makeAgent({ scenario: 'plain' });
  agent.cancel();
  try {
    await agent.init();
    agent.cancel();
    await waitFor(() => messages().some((msg) => msg.method === 'session/cancel'));
    const cancel = messages().find((msg) => msg.method === 'session/cancel');
    assert.deepEqual(cancel.params, { sessionId: 's1' });
  } finally {
    await closeAgent(agent);
  }
});

test('AcpAgent: строка агента больше 32 МБ завершает процесс вместе с потомками', async () => {
  const { agent, heartbeat } = makeOverflowAgent();
  let exitCode = 'не завершался';
  agent.onExit = (code) => {
    exitCode = code;
  };
  try {
    await agent.init();
    const error = await agent.prompt('много').then(() => null, (e) => e);
    assert.equal(error?.i18n?.key, 'err.agentLineTooLong');
    assert.match(error.message, /строка агента больше 32 МБ/);
    await waitFor(() => existsSync(heartbeat));
    await waitStable(heartbeat);
    assert.equal(exitCode, null);
  } finally {
    await closeAgent(agent);
  }
});

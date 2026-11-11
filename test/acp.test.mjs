import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpAgent, checkCommand } from '../src/acp.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitDead(pids, ms = 8000) {
  const start = Date.now();
  while (pids.some(alive) && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 100));
  return pids.filter(alive);
}

test('AcpAgent: обмен JSON-RPC и завершение всего дерева процессов', async () => {
  const updates = [];
  let exitCode;
  const exited = new Promise((r) => {
    exitCode = r;
  });
  const agent = new AcpAgent({ cwd: process.cwd(), command: process.execPath, args: [FAKE], onUpdate: (u) => updates.push(u), onExit: (c) => exitCode(c) });

  await agent.init('plan');
  assert.equal(agent.sessionId, 's1');
  assert.equal(agent.mode, 'plan');

  const res = await agent.prompt('привет');
  assert.equal(res.stopReason, 'end_turn');
  const text = updates.map((u) => u.content?.text).find((t) => t?.startsWith('pids'));
  assert.ok(text, 'агент прислал session/update');
  const pids = text.split(' ').slice(1).map(Number);

  agent.close();
  await exited;
  assert.deepEqual(await waitDead(pids), [], 'после close() не осталось живых процессов агента');
  assert.equal(agent.closed, true);
});

test('AcpAgent: несуществующая команда не роняет процесс, ожидающие запросы отклоняются', async () => {
  const agent = new AcpAgent({ cwd: process.cwd(), command: 'no-such-gemini-command-xyz', args: ['--acp'] });
  await assert.rejects(agent.init());
  assert.equal(agent.closed, true);
});

test('checkCommand: рабочая и несуществующая команда', async () => {
  const ok = await checkCommand(process.execPath);
  assert.equal(ok.ok, true);
  assert.match(ok.version, /^v\d+/);

  const bad = await checkCommand('no-such-gemini-command-xyz');
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test('AcpAgent: запрос к закрытому агенту сразу отклоняется, а не висит (закрытие сессии во время запуска)', async () => {
  const agent = new AcpAgent({ cwd: process.cwd(), command: process.execPath, args: [FAKE] });
  const exited = new Promise((r) => (agent.onExit = r));
  await agent.init();
  agent.close();
  const t0 = Date.now();
  await assert.rejects(agent.prompt('после закрытия'), /уже завершён/);
  await assert.rejects(agent.request('session/set_mode', { modeId: 'plan' }), /уже завершён/);
  assert.ok(Date.now() - t0 < 1000, 'отказ мгновенный');
  await exited;
});

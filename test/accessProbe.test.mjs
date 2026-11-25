import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROBE = fileURLToPath(new URL('./fixtures/probe-agent.mjs', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'acpgram-access-probe-'));
process.env.ACPGRAM_HOME = home;
process.env.ALLOWED_USER_ID = '42';
process.env.ACPGRAM_TEST_PROBE_CMD = process.execPath;

const { db } = await import('../src/ctx.mjs');
const { getCatalog, killProbes, probeCatalog, refreshCatalogs } = await import('../src/access.mjs');
const { ENGINES, needsLogin, setAvailability, setNeedsLogin } = await import('../src/engines.mjs');

function fakeEngine(id) {
  const base = ENGINES[id];
  return {
    ...base,
    envVar: 'ACPGRAM_TEST_PROBE_CMD',
    defaultCommand: process.execPath,
    args: [PROBE],
    modelMeta: base.modelMeta ? { ...base.modelMeta, args: [PROBE, 'meta'] } : base.modelMeta,
  };
}

function setScenario(scenario, name) {
  process.env.FAKE_PROBE = scenario;
  process.env.FAKE_PROBE_LOG = join(home, `${name}.jsonl`);
  return process.env.FAKE_PROBE_LOG;
}

function messages(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > ms) throw new Error('условие не выполнено');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

after(() => {
  killProbes();
  setAvailability([]);
  for (const id of ['opencode', 'gemini', 'codex', 'agy']) setNeedsLogin(id, false);
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test('probeCatalog: параллельные вызовы используют один зонд и сохраняют каталог с meta', async () => {
  const engine = fakeEngine('opencode');
  const logPath = setScenario('ok', 'ok');
  setNeedsLogin('opencode', true);
  const [first, second] = await Promise.all([probeCatalog(engine), probeCatalog(engine)]);
  assert.strictEqual(first, second);
  const catalog = getCatalog('opencode');
  assert.ok(catalog);
  assert.deepEqual(catalog.models.map((m) => m.id), ['opencode/zen']);
  assert.equal(catalog.models[0].free, true);
  assert.deepEqual(catalog.efforts, []);
  assert.equal(typeof catalog.envSig, 'string');
  assert.equal(needsLogin('opencode'), false);
  assert.equal(messages(logPath).filter((m) => m.method === 'initialize').length, 1);
  assert.deepEqual(JSON.parse(db.getSetting('catalog:opencode')).models.map((m) => m.id), ['opencode/zen']);
});

test('probeCatalog: сбой modelMeta не роняет каталог и оставляет модели без пометок', async () => {
  const engine = fakeEngine('opencode');
  const logPath = setScenario('meta_fail', 'meta-fail');
  const catalog = await probeCatalog(engine);
  assert.deepEqual(catalog.models.map((m) => m.id), ['opencode/zen', 'opencode/image']);
  assert.equal(catalog.models.find((m) => m.id === 'opencode/zen').free, undefined);
  assert.equal(messages(logPath).some((m) => m.method === 'session/new'), true);
});

test('probeCatalog: ошибка авторизации отмечает движок и ставит паузу повтора', async () => {
  const engine = fakeEngine('gemini');
  const logPath = setScenario('auth', 'auth');
  setNeedsLogin('gemini', false);
  await assert.rejects(probeCatalog(engine), /401|unauthorized/i);
  assert.equal(needsLogin('gemini'), true);
  await assert.rejects(probeCatalog(engine), /недавняя попытка не удалась/);
  assert.equal(messages(logPath).filter((m) => m.method === 'initialize').length, 1);
  setNeedsLogin('gemini', false);
});

test('killProbes: завершает зависший зонд и разблокирует ожидающий запрос', async () => {
  const engine = fakeEngine('codex');
  const logPath = setScenario('hang', 'hang');
  setNeedsLogin('codex', false);
  let pending;
  try {
    pending = probeCatalog(engine, 5000).then(() => null, (e) => e);
    await waitFor(() => messages(logPath).some((m) => m.method === 'session/new'));
    killProbes();
    const err = await pending;
    assert.ok(err instanceof Error);
    assert.equal(needsLogin('codex'), false);
  } finally {
    killProbes();
    if (pending) await pending.catch(() => {});
  }
});

test('refreshCatalogs: ошибка зонда одного движка не прерывает обновление', async () => {
  const oldCommand = process.env.AGY_COMMAND;
  process.env.AGY_COMMAND = join(home, 'missing-agy');
  try {
    setAvailability(Object.values(ENGINES).map((engine) => ({ engine, ok: engine.id === 'agy' })));
    await assert.doesNotReject(() => refreshCatalogs({ force: true }));
  } finally {
    setAvailability([]);
    if (oldCommand === undefined) delete process.env.AGY_COMMAND;
    else process.env.AGY_COMMAND = oldCommand;
  }
});

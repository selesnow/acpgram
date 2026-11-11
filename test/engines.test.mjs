import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENGINE, ENGINES, availableEngines, checkEngines, createAgent, engineCommand, engineMode, getEngine, isAvailable, isRequired, modeAllowed, permissionOptions, resolveEngine, setAvailability,
} from '../src/engines.mjs';
import { parseTool } from '../src/tools.mjs';

// ключи уровней доступа из ctx.mjs (сам ctx.mjs не импортируем: он открывает базу бота)
const LEVEL_KEYS = ['read', 'normal', 'full'];
const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

test('реестр: у каждого движка полный контракт, Gemini — по умолчанию и обязательный', () => {
  assert.equal(DEFAULT_ENGINE, 'gemini');
  assert.equal(getEngine('нет-такого'), ENGINES.gemini);
  assert.equal(getEngine(undefined), ENGINES.gemini);
  for (const e of Object.values(ENGINES)) {
    for (const k of ['id', 'label', 'envVar', 'defaultCommand', 'install']) assert.equal(typeof e[k], 'string', `${e.id}.${k}`);
    assert.ok(Array.isArray(e.args) && Array.isArray(e.versionArgs), e.id);
    assert.equal(typeof e.cleanText, 'function', e.id);
    assert.equal(typeof e.toolName, 'function', e.id);
    assert.equal(typeof e.short, 'string', `${e.id}.short`);
    // режим задан для каждого уровня доступа и для администратора
    for (const level of LEVEL_KEYS) assert.ok(e.modes?.[level], `${e.id}: режим для ${level}`);
    assert.ok(e.adminMode, `${e.id}: режим администратора`);
  }
  // обязателен только движок по умолчанию
  assert.deepEqual(Object.values(ENGINES).filter(isRequired).map((e) => e.id), ['gemini']);
  assert.deepEqual(ENGINES.gemini.args, ['--acp']);
  assert.deepEqual(ENGINES.agy.args, ['acp']);
});

test('engineMode: уровни Gemini, неизвестный уровень — чтение, администратор — свой режим', () => {
  const g = ENGINES.gemini;
  assert.equal(engineMode(g, { level: 'read' }), 'plan');
  assert.equal(engineMode(g, { level: 'normal' }), 'default');
  assert.equal(engineMode(g, { level: 'full' }), 'autoEdit');
  assert.equal(engineMode(g, { level: 'что-то' }), 'plan');
  assert.equal(engineMode(g, {}), 'plan');
  assert.equal(engineMode(g, { admin: true, level: 'read' }), g.adminMode);
  // режимы, проверенные по ответу session/new реальных агентов
  assert.deepEqual(ENGINES.claude.modes, { read: 'plan', normal: 'default', full: 'bypassPermissions' });
  assert.deepEqual(ENGINES.agy.modes, { read: 'plan', normal: 'default', full: 'accept-edits' });
  assert.equal(engineMode(ENGINES.claude, { level: 'неизвестный' }), 'plan');
  assert.equal(engineMode(ENGINES.claude, { admin: true }), 'bypassPermissions');
  assert.equal(engineMode(ENGINES.agy, { admin: true }), 'accept-edits');
});

test('доступность: недоступный движок не выбирается, пользователь откатывается на движок по умолчанию', () => {
  try {
    setAvailability([
      { engine: ENGINES.gemini, ok: true },
      { engine: ENGINES.claude, ok: false, error: 'not found' },
      { engine: ENGINES.agy, ok: false, timeout: true }, // медленный, но установлен — считаем доступным
    ]);
    assert.equal(isAvailable('claude'), false);
    assert.equal(isAvailable('agy'), true);
    assert.equal(isAvailable('нет-такого'), false);
    assert.deepEqual(availableEngines().map((e) => e.id), ['gemini', 'agy']);
    assert.equal(resolveEngine('claude'), ENGINES.gemini);
    assert.equal(resolveEngine('agy'), ENGINES.agy);
    assert.equal(resolveEngine(null), ENGINES.gemini);
  } finally {
    setAvailability([]);
  }
  assert.equal(resolveEngine('claude'), ENGINES.claude);
});

test('engineCommand: переменная окружения важнее команды по умолчанию', () => {
  const e = { envVar: 'TEST_ENGINE_COMMAND_XYZ', defaultCommand: 'default-cmd' };
  assert.equal(engineCommand(e), 'default-cmd');
  process.env.TEST_ENGINE_COMMAND_XYZ = '/opt/agent';
  try {
    assert.equal(engineCommand(e), '/opt/agent');
  } finally {
    delete process.env.TEST_ENGINE_COMMAND_XYZ;
  }
});

test('cleanText: служебная строка Gemini убирается, у других движков текст не трогается', () => {
  assert.equal(ENGINES.gemini.cleanText('[MODE_UPDATE] autoEdit Готово'), ' Готово');
  assert.equal(ENGINES.gemini.cleanText('Текст [MODE_UPDATE] plan'), 'Текст [MODE_UPDATE] plan');
  assert.equal(ENGINES.claude.cleanText('[MODE_UPDATE] plan'), '[MODE_UPDATE] plan');
});

test('parseTool: имя инструмента по правилам движка', () => {
  const gem = { toolCallId: 'read_file__call_123', kind: 'read', title: 'a.txt', status: 'completed' };
  assert.equal(parseTool(gem).tool, 'read_file'); // по умолчанию — Gemini, как раньше
  assert.equal(parseTool(gem, ENGINES.gemini).tool, 'read_file');
  const claude = { toolCallId: 'toolu_01', kind: 'read', title: 'Read a.txt', _meta: { claudeCode: { toolName: 'Read' } } };
  assert.equal(parseTool(claude, ENGINES.claude).tool, 'Read');
  assert.equal(parseTool({ toolCallId: 't1', kind: 'edit' }, ENGINES.agy).tool, 'edit');
});

test('createAgent: клиент получает команду и аргументы движка', async () => {
  const fake = { ...ENGINES.gemini, id: 'fake', label: 'Fake', envVar: 'TEST_FAKE_AGENT_CMD', defaultCommand: process.execPath, args: [FAKE] };
  const a = createAgent(fake, { cwd: process.cwd() });
  assert.equal(a.engine, fake);
  assert.equal(a.command, process.execPath);
  assert.deepEqual(a.args, [FAKE]);
  await a.init(engineMode(fake, { level: 'read' }));
  assert.equal(a.sessionId, 's1');
  assert.equal(a.mode, 'plan');
  const exited = new Promise((r) => (a.onExit = r));
  a.close();
  await exited;
});

test('checkEngines: доступный и недоступный движок проверяются параллельно', async () => {
  const ok = { id: 'ok', label: 'OK', envVar: 'TEST_OK_CMD', defaultCommand: process.execPath, versionArgs: ['--version'] };
  const bad = { id: 'bad', label: 'Bad', envVar: 'TEST_BAD_CMD', defaultCommand: 'no-such-agent-command-xyz', versionArgs: ['--version'] };
  const [r1, r2] = await checkEngines([ok, bad]);
  assert.equal(r1.engine, ok);
  assert.equal(r1.ok, true);
  assert.match(r1.version, /^v\d+/);
  assert.equal(r2.engine, bad);
  assert.equal(r2.ok, false);
  assert.equal(r2.command, 'no-such-agent-command-xyz');
});

test('parseTool: описание действия Claude Code (rawInput.description) и Antigravity (toolSummary)', () => {
  // события сняты с живых агентов
  const claude = parseTool(
    { _meta: { claudeCode: { toolName: 'PowerShell' } }, toolCallId: 'toolu_01', sessionUpdate: 'tool_call_update', rawInput: { command: 'echo hello', description: 'Print hello' }, content: [{ type: 'content', content: { type: 'text', text: 'Print hello' } }] },
    ENGINES.claude,
  );
  assert.equal(claude.tool, 'PowerShell');
  assert.equal(claude.description, 'Print hello');
  assert.equal(claude.output, '', 'описание не пишется в вывод команды');
  const agy = parseTool({ sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'run_command', args: { CommandLine: 'echo hello', toolSummary: 'Run echo hello command' }, status: 'in_progress', kind: 'execute', title: 'echo hello', rawInput: { CommandLine: 'echo hello', toolSummary: 'Run echo hello command' } }, ENGINES.agy);
  assert.equal(agy.tool, 'run_command');
  assert.equal(agy.description, 'Run echo hello command');
});

test('quietStderr: служебная трассировка моста Claude не попадает в лог, ошибки — попадают', () => {
  const q = ENGINES.claude.quietStderr;
  assert.ok(q.test('[session/create] sessionId=6fa1 phase=settings durationMs=26 totalMs=27'));
  assert.ok(q.test('[session/load] sessionId=812b phase=replay durationMs=0'));
  assert.ok(q.test('[idle-compaction] skip: cache TTL is 5m, not 1h'));
  assert.ok(!q.test('Error: Invalid API key'));
  assert.ok(!q.test('API Error: 401 authentication_error'));
});

test('modeAllowed: выше режима уровня доступа не пускаем, неизвестный режим — только если совпадает', () => {
  const c = ENGINES.claude;
  assert.equal(modeAllowed(c, 'plan', 'plan'), true);
  assert.equal(modeAllowed(c, 'default', 'plan'), false);
  assert.equal(modeAllowed(c, 'bypassPermissions', 'default'), false);
  assert.equal(modeAllowed(c, 'acceptEdits', 'bypassPermissions'), true);
  assert.equal(modeAllowed(c, 'что-то-новое', 'bypassPermissions'), false);
  assert.equal(modeAllowed(ENGINES.gemini, 'yolo', 'autoEdit'), false);
  assert.equal(modeAllowed(ENGINES.agy, 'accept-edits', 'default'), false);
});

test('permissionOptions: без постоянных правил и без выхода из плана выше уровня доступа', () => {
  // варианты моста claude-agent-acp 0.106.0
  const exitPlan = ['exit-plan-bypass', 'exit-plan-auto', 'exit-plan-accept-edits', 'exit-plan-default'].map((id) => ({ optionId: id, kind: 'allow_always', name: id }));
  const reject = { optionId: 'reject', kind: 'reject_once', name: 'No' };
  const ids = (list) => list.map((o) => o.optionId);
  const c = ENGINES.claude;
  assert.deepEqual(ids(permissionOptions(c, [...exitPlan, reject], engineMode(c, { level: 'read' }))), ['reject']);
  assert.deepEqual(ids(permissionOptions(c, [...exitPlan, reject], engineMode(c, { level: 'normal' }))), ['exit-plan-default', 'reject']);
  assert.deepEqual(ids(permissionOptions(c, [...exitPlan, reject], engineMode(c, { level: 'full' }))), [...ids(exitPlan), 'reject']);
  const tool = [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'allow-with-updates', kind: 'allow_always' }, { optionId: 'allow-skill-prefix', kind: 'allow_always' }, reject];
  assert.deepEqual(ids(permissionOptions(c, tool, 'bypassPermissions')), ['allow-once', 'reject'], 'постоянные правила не даём даже администратору');
  const gem = [{ optionId: 'proceed_once', kind: 'allow_once' }, { optionId: 'proceed_always', kind: 'allow_always' }, { optionId: 'proceed_always_and_save', kind: 'allow_always' }, { optionId: 'cancel', kind: 'reject_once' }];
  assert.deepEqual(ids(permissionOptions(ENGINES.gemini, gem, 'default')), ['proceed_once', 'proceed_always', 'cancel']);
});

test('ENGINES без прототипа: id из кнопки вроде constructor не считается движком', () => {
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(isAvailable(id), false, id);
    assert.equal(getEngine(id), ENGINES[DEFAULT_ENGINE], id);
    assert.equal(resolveEngine(id), ENGINES[DEFAULT_ENGINE], id);
  }
  assert.equal(engineMode(ENGINES.claude, { level: 'constructor' }), 'plan');
  assert.throws(() => { ENGINES.evil = {}; });
});

test('checkEngines: слишком старая версия движка — недоступен, с подсказкой обновления', async () => {
  // «движок» — node: его версия v24 «старше» минимальной 99 не будет
  const old = { id: 'old', label: 'Old', envVar: 'TEST_OLD_CMD', defaultCommand: process.execPath, versionArgs: ['--version'], minVersion: '99.0.0', update: 'old update' };
  const fresh = { ...old, id: 'fresh', minVersion: '1.0.0' };
  const [a, b] = await checkEngines([old, fresh]);
  assert.equal(a.ok, false);
  assert.equal(a.tooOld, true);
  assert.match(a.error, /нужна 99\.0\.0\+ — обновите: old update/);
  assert.equal(b.ok, true);
  assert.equal(ENGINES.agy.minVersion, '1.5.0');
});

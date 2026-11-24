import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ENGINE, ENGINES, PROVIDER_KEYS, agentEnv, checkEngines, createAgent, engineCommand, engineMode, getEngine, isAvailable, isRequired, modeAllowed, permissionOptions, resolveEngine, setAvailability, isAuthError, needsLogin, setNeedsLogin, opencodeConfig, opencodeGoogleKey, parseCatalog, parseOpencodeModels, vendorName,
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
  assert.deepEqual(ENGINES.codex.args, []);
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
  // codex-acp 2.6.0: режимы из ответа session/new
  assert.deepEqual(ENGINES.codex.modes, { read: 'read-only', normal: 'workspace-write', full: 'agent-full-access' });
  assert.equal(engineMode(ENGINES.codex, { level: 'неизвестный' }), 'read-only');
  assert.equal(engineMode(ENGINES.codex, { admin: true }), 'agent-full-access');
});

test('доступность: недоступный движок не выбирается, пользователь откатывается на движок по умолчанию', () => {
  try {
    setAvailability([
      { engine: ENGINES.gemini, ok: true },
      { engine: ENGINES.claude, ok: false, error: 'not found' },
      { engine: ENGINES.agy, ok: false, timeout: true }, // медленный, но установлен — считаем доступным
      { engine: ENGINES.codex, ok: false, error: 'not found' },
      { engine: ENGINES.opencode, ok: false, error: 'not found' },
    ]);
    assert.equal(isAvailable('claude'), false);
    assert.equal(isAvailable('agy'), true);
    assert.equal(isAvailable('нет-такого'), false);
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
  assert.equal(modeAllowed(ENGINES.codex, 'agent-full-access', 'workspace-write'), false);
  assert.equal(modeAllowed(ENGINES.codex, 'read-only', 'workspace-write'), true);
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
  assert.deepEqual(a.errorI18n, { key: 'err.engineOld.update', vars: { version: a.version, min: '99.0.0', update: 'old update' } });
  assert.equal(b.ok, true);
  assert.equal(ENGINES.agy.minVersion, '1.5.0');
  assert.deepEqual(['agy', 'codex', 'opencode'].map((id) => ENGINES[id].installKey), ['install.agy', 'install.codex', 'install.opencode']);

  const noUpdate = { ...old, id: 'old-no-update', update: '' };
  const [c] = await checkEngines([noUpdate]);
  assert.equal(c.tooOld, true);
  assert.deepEqual(c.errorI18n, { key: 'err.engineOld.noUpdate', vars: { version: c.version, min: '99.0.0' } });
});

test('isAuthError: ошибки входа и ключей API отличаются от прочих', () => {
  for (const m of ['Authentication required', 'Gemini API key is missing or not configured.', 'Please log in', 'HTTP 401 Unauthorized', 'No credentials found', 'Authorization failed']) {
    assert.equal(isAuthError(new Error(`ACP -32000: ${m}`)), true, m);
  }
  for (const m of ['нет ответа', 'недавняя попытка не удалась, повтор позже', 'spawn ENOENT', 'Connection reset', 'author mismatch', 'code 14012']) assert.equal(isAuthError(new Error(m)), false, m);
  assert.equal(isAuthError(undefined), false);
});

test('needsLogin: отметка ставится и снимается', () => {
  setNeedsLogin('agy', true);
  assert.equal(needsLogin('agy'), true);
  assert.equal(needsLogin('claude'), false);
  setNeedsLogin('agy', false);
  assert.equal(needsLogin('agy'), false);
});

// ---------- OpenCode ----------

test('OpenCode: запуск opencode acp, режимы plan / build, без своего «навсегда»', () => {
  const o = ENGINES.opencode;
  assert.deepEqual(o.args, ['acp']);
  assert.equal(o.defaultCommand, 'opencode');
  assert.equal(engineMode(o, { level: 'read' }), 'plan');
  assert.equal(engineMode(o, { level: 'normal' }), 'build');
  assert.equal(engineMode(o, { level: 'full' }), 'build');
  assert.equal(engineMode(o, { admin: true }), 'build');
  assert.equal(modeAllowed(o, 'build', 'plan'), false);
  // «always» у OpenCode живёт в памяти процесса (проверено на 1.19.5) — это «на эту сессию», его оставляем
  const opts = [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }];
  assert.deepEqual(permissionOptions(o, opts, 'build').map((x) => x.optionId), ['once', 'always', 'reject']);
});

test('opencodeConfig: права по уровню доступа, неизвестный уровень — чтение', () => {
  assert.deepEqual(opencodeConfig({ level: 'read' }).permission, { edit: 'deny', bash: 'deny', webfetch: 'ask' });
  assert.deepEqual(opencodeConfig({ level: 'normal' }).permission, { edit: 'ask', bash: 'ask', webfetch: 'ask' });
  assert.equal(opencodeConfig({ level: 'full' }).permission.bash, 'allow');
  assert.equal(opencodeConfig({ admin: true, level: 'read' }).permission.edit, 'allow');
  assert.equal(opencodeConfig({ level: 'constructor' }).permission.edit, 'deny');
  assert.equal(opencodeConfig({}).permission.bash, 'deny');
  const env = ENGINES.opencode.processEnv({ level: 'normal' });
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } });
});

test('opencodeGoogleKey: ключ Google для OpenCode из GEMINI_API_KEY / GOOGLE_API_KEY, свой не перезаписывается', () => {
  assert.deepEqual(opencodeGoogleKey({ GEMINI_API_KEY: 'g' }), { GOOGLE_GENERATIVE_AI_API_KEY: 'g' });
  assert.deepEqual(opencodeGoogleKey({ GOOGLE_API_KEY: 'k' }), { GOOGLE_GENERATIVE_AI_API_KEY: 'k' });
  assert.deepEqual(opencodeGoogleKey({ GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k' }), { GOOGLE_GENERATIVE_AI_API_KEY: 'g' });
  assert.deepEqual(opencodeGoogleKey({ GOOGLE_GENERATIVE_AI_API_KEY: 'own', GEMINI_API_KEY: 'g' }), {});
  assert.deepEqual(opencodeGoogleKey({}), {});
});

test('createAgent: переменные движка (processEnv) доходят до процесса агента, без who — не передаются', async () => {
  const fake = { ...ENGINES.gemini, id: 'fake', label: 'Fake', envVar: 'TEST_FAKE_AGENT_CMD', defaultCommand: process.execPath, args: [FAKE], processEnv: (who) => ({ ACPGRAM_TEST_ENV: `level=${who.level}` }) };
  for (const [who, want] of [[{ level: 'normal' }, 'level=normal'], [undefined, null]]) {
    const a = createAgent(fake, { cwd: process.cwd(), ...(who ? { who } : {}) });
    await a.init(null);
    const res = await a.prompt('hi');
    assert.equal(res._meta.env, want);
    const exited = new Promise((r) => (a.onExit = r));
    a.close();
    await exited;
  }
});

test('parseOpencodeModels: цена и умение вызывать инструменты из opencode models --verbose', () => {
  const block = (id, cost, toolcall = true, status = 'active') =>
    `${id}\n${JSON.stringify({ id, status, ...(cost ? { cost } : {}), capabilities: { toolcall } }, null, 2)}`;
  const text = [
    block('opencode/big-pickle', { input: 0, output: 0, cache: { read: 0, write: 0 } }),
    block('anthropic/claude-haiku-4-5', { input: 1, output: 5 }),
    block('google/lyria-3-pro-preview', { input: 0, output: 0 }, false),
    block('openai/old', { input: 1, output: 1 }, true, 'deprecated'),
    block('x/no-cost', null),
    'opencode/broken\n{ не JSON',
  ].join('\r\n');
  const m = parseOpencodeModels(text);
  assert.deepEqual(m.get('opencode/big-pickle'), { free: true, tools: true });
  assert.deepEqual(m.get('anthropic/claude-haiku-4-5'), { free: false, tools: true });
  assert.equal(m.get('google/lyria-3-pro-preview').tools, false, 'генерация музыки: цена 0, но без инструментов');
  assert.equal(m.get('openai/old').tools, false, 'устаревшая модель');
  assert.equal(m.get('x/no-cost').free, false, 'неизвестная цена — не бесплатная');
  assert.equal(m.has('opencode/broken'), false);
  assert.equal(parseOpencodeModels('').size, 0);
});

test('parseCatalog: модели OpenCode с группами провайдеров, пометкой бесплатных и без моделей без инструментов', () => {
  const res = {
    configOptions: [
      {
        id: 'model',
        currentValue: 'opencode/big-pickle',
        options: [
          { value: 'anthropic/claude-haiku-4-5', name: 'Anthropic/Claude Haiku 4.5' },
          { value: 'google/lyria-3-pro-preview', name: 'Google/Lyria 3 Pro' },
          { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
        ],
      },
      { id: 'mode', currentValue: 'build', options: [{ value: 'build' }, { value: 'plan' }] },
    ],
  };
  const meta = new Map([
    ['anthropic/claude-haiku-4-5', { free: false, tools: true }],
    ['google/lyria-3-pro-preview', { free: true, tools: false }],
    ['opencode/big-pickle', { free: true, tools: true }],
  ]);
  const c = parseCatalog(ENGINES.opencode, res, meta);
  assert.deepEqual(c.models, [
    { id: 'anthropic/claude-haiku-4-5', name: 'Anthropic/Claude Haiku 4.5', group: 'anthropic', groupLabel: 'Anthropic', short: 'Claude Haiku 4.5' },
    { id: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle', group: 'opencode', groupLabel: 'OpenCode Zen', short: 'Big Pickle', free: true },
  ]);
  assert.equal(c.defaultModel, 'opencode/big-pickle');
  assert.deepEqual(c.efforts, []);
  // без сведений о моделях — все модели, без пометок
  assert.equal(parseCatalog(ENGINES.opencode, res).models.length, 3);
  // у движков без групп модели как раньше
  const claude = parseCatalog(ENGINES.claude, { configOptions: [{ id: 'model', options: [{ value: 'opus', name: 'Opus' }] }] });
  assert.deepEqual(claude.models, [{ id: 'opus', name: 'Opus' }]);
});

test('parseCatalog: у моделей OpenRouter — вендор (sub) и его название из «Вендор: модель»', () => {
  const res = { configOptions: [{ id: 'model', options: [
    { value: 'openrouter/anthropic/claude-sonnet-4.5', name: 'OpenRouter/Anthropic: Claude Sonnet 4.5' },
    { value: 'openrouter/qwen/qwen3-coder:free', name: 'OpenRouter/qwen3-coder' },
    { value: 'anthropic/claude-haiku-4-5', name: 'Anthropic/Claude Haiku 4.5' },
    { value: 'openrouter/~openai/gpt-latest', name: 'OpenRouter/GPT Latest' },
    { value: 'openrouter/z-ai/glm-5', name: 'OpenRouter/GLM 5' },
  ] }] };
  const [a, q, h, latest, z] = parseCatalog(ENGINES.opencode, res).models;
  assert.equal(a.group, 'openrouter');
  assert.equal(a.sub, 'anthropic');
  assert.equal(a.subLabel, 'Anthropic');
  assert.equal(a.short, 'Anthropic: Claude Sonnet 4.5');
  assert.equal(q.sub, 'qwen');
  assert.equal(q.subLabel, 'Qwen', 'без «Вендор:» в названии — по id вендора');
  assert.equal(h.sub, undefined, 'у обычного провайдера вендора нет');
  assert.equal(latest.sub, 'openai', '«~openai» — псевдоним «последняя версия», тот же вендор');
  assert.equal(latest.subLabel, 'OpenAI');
  assert.equal(z.subLabel, 'Z.ai');
  assert.equal(vendorName('somecorp'), 'Somecorp');
});

test('agentEnv: токен бота и ключи чужих провайдеров до процесса агента не доходят', () => {
  const env = {
    PATH: '/bin', HTTPS_PROXY: 'http://p', PLANFIX_API_KEY: 'pf', GITHUB_TOKEN: 'gh', DEPT_EMAIL_PWD: 'mail', Telegram_Bot_Token: 't', TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1', ALLOWED_USERNAME: 'u',
    GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'gg', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r', GROQ_API_KEY: 'q',
  };
  const keys = (id) => Object.keys(agentEnv(ENGINES[id], env)).sort();
  const common = ['HTTPS_PROXY', 'PATH']; // системные переменные — как есть
  assert.deepEqual(keys('claude'), ['ANTHROPIC_API_KEY', ...common]);
  assert.deepEqual(keys('codex'), [...common.slice(0, 1), 'OPENAI_API_KEY', ...common.slice(1)]);
  assert.deepEqual(keys('gemini'), ['GEMINI_API_KEY', 'GOOGLE_API_KEY', ...common]);
  assert.deepEqual(keys('agy'), keys('gemini'));
  // OpenCode работает с моделями всех провайдеров — ключи все, но не переменные бота
  assert.deepEqual(keys('opencode'), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'HTTPS_PROXY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'PATH']);
  for (const hidden of ['GITHUB_TOKEN', 'PLANFIX_API_KEY', 'DEPT_EMAIL_PWD', 'TELEGRAM_BOT_TOKEN']) assert.ok(!Object.keys(agentEnv(ENGINES.gemini, env)).includes(hidden), hidden);
  assert.equal(env.TELEGRAM_BOT_TOKEN, 't', 'исходное окружение не меняется');
  // у каждого движка ключи заданы явно: забытое поле означало бы «все ключи»
  for (const e of Object.values(ENGINES)) assert.ok(e.apiKeys === null ? e.id === 'opencode' : e.apiKeys.every((k) => PROVIDER_KEYS.has(k)), e.id);
});

test('agentEnv: AGENT_ENV_HIDE и AGENT_ENV_PASS задают исключения из фильтра секретов', () => {
  const env = { PATH: '/bin', PLANFIX_API_KEY: 'pf', CUSTOM_SECRET: 's', AGENT_ENV_HIDE: 'PATH', AGENT_ENV_PASS: 'PLANFIX_API_KEY' };
  assert.deepEqual(agentEnv(ENGINES.gemini, env), { PLANFIX_API_KEY: 'pf' });
});

test('createAgent: процесс агента не видит токен бота и чужие ключи, свои — видит', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'bot-token', ANTHROPIC_API_KEY: 'a-key', GEMINI_API_KEY: 'g-key' });
  // фальшивый агент возвращает в _meta.env значение ACPGRAM_TEST_ENV — в него собираем то, что он видит
  const probe = { ...ENGINES.gemini, id: 'fake', label: 'Fake', envVar: 'TEST_FAKE_AGENT_CMD', defaultCommand: process.execPath, args: [FAKE] };
  try {
    const a = createAgent(probe, { cwd: process.cwd() });
    assert.equal(a.env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(a.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(a.env.GEMINI_API_KEY, 'g-key');
    assert.ok(a.env.PATH ?? a.env.Path, 'PATH передаётся');
    await a.init(null);
    const exited = new Promise((r) => (a.onExit = r));
    a.close();
    await exited;
  } finally {
    for (const k of ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) {
      if (k in saved) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

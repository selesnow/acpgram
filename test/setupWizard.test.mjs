import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { setCliLang } from '../src/cli-i18n.mjs';

setCliLang('ru');

const SETUP_URL = new URL('../src/setup.mjs', import.meta.url).href;
const ADMIN_ME = { match: '/getMe', result: { username: 'test_bot', first_name: 'Bot' } };
const tempDirs = [];
const samePath = (actual, expected) => process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
after(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PROMPT_MOCK = String.raw`
globalThis.__FAKE_CALLS__ = [];
globalThis.__FAKE_PROMPTS__ = JSON.parse(process.env.FAKE_PROMPTS || '[]');
const take = (method, args) => {
  globalThis.__FAKE_CALLS__.push({ method, args });
  const list = globalThis.__FAKE_PROMPTS__;
  const i = list.findIndex((x) => x.method === method && !x.used);
  if (i < 0) throw new Error('нет ответа на ' + method);
  list[i].used = true;
  return Promise.resolve(list[i].answer);
};
const fetchRules = JSON.parse(process.env.FAKE_FETCH || '[]');
globalThis.fetch = async (url, options) => {
  globalThis.__FAKE_CALLS__.push({ method: 'fetch', args: [String(url), options?.body ? JSON.parse(options.body) : {}] });
  const rule = fetchRules.find((r) => String(url).includes(r.match) && !r.used);
  if (!rule) throw new Error('нет правила fetch: ' + url);
  rule.used = true;
  if (rule.throw) throw new Error(rule.throw);
  return {
    status: rule.status ?? 200,
    json: async () => ({ ok: rule.ok ?? true, result: rule.result ?? {}, description: rule.description ?? '' }),
  };
};
export function prompter() {
  return {
    ask: (q, def) => take('ask', [q, def]),
    secret: (q) => take('secret', [q]),
    yes: (q, def) => take('yes', [q, def]),
    close: () => globalThis.__FAKE_CALLS__.push({ method: 'close', args: [] }),
  };
}
`;

const ENGINE_MOCK = String.raw`
export const ENGINES = {
  gemini: { id: 'gemini', label: 'Gemini CLI', envVar: 'GEMINI_COMMAND', defaultCommand: 'gemini', install: 'install gemini' },
  claude: { id: 'claude', label: 'Claude', envVar: 'CLAUDE_COMMAND', defaultCommand: 'claude', install: 'install claude' },
  codex: { id: 'codex', label: 'Codex', envVar: 'CODEX_COMMAND', defaultCommand: 'codex', install: 'install codex' },
  agy: { id: 'agy', label: 'Antigravity', envVar: 'AGY_COMMAND', defaultCommand: 'agy', install: 'install agy' },
  opencode: { id: 'opencode', label: 'OpenCode', envVar: 'OPENCODE_COMMAND', defaultCommand: 'opencode', install: 'install opencode' },
};
export function checkEngines(list, timeout) {
  const n = globalThis.__ENGINE_CALLS__ = (globalThis.__ENGINE_CALLS__ || 0) + 1;
  globalThis.__FAKE_CALLS__.push({ method: 'checkEngines', args: [list.map((e) => e.id), n] });
  const rules = JSON.parse(process.env.FAKE_ENGINE_CHECKS || '[]');
  return Promise.resolve((rules[n - 1] ?? []).map((r, i) => ({ ...r, engine: list[i] })));
}
`;

const SERVICE_MOCK = String.raw`
export async function installService(options) {
  globalThis.__FAKE_CALLS__.push({ method: 'installService', args: [{ name: options.name, dry: options.dry, allowSystem: options.allowSystem }] });
  return JSON.parse(process.env.FAKE_SERVICE_RESULT || '{"ok":true}');
}
`;

const SANDBOX_MOCK = String.raw`
export const findCommand = () => (process.env.FAKE_BWRAP === '1' ? '/usr/bin/bwrap' : null);
export const bwrapCommand = () => 'bwrap';
`;

const SPAWN_MOCK = String.raw`
export function spawnSync(cmd, args, opts) {
  globalThis.__FAKE_CALLS__.push({ method: 'spawnSync', args: [cmd, args, { stdio: opts?.stdio, encoding: opts?.encoding }] });
  const all = [cmd, ...(args || [])].join(' ');
  if (all.includes('prefix -g')) return { status: 0, stdout: (process.env.FAKE_NPM_PREFIX || '') + '\n', stderr: '' };
  if (all.includes('install -g')) return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: '' };
}
`;

const harness = ({ prompts = [], fetchRules = [], engineChecks = [], serviceResult = { ok: true }, platform, bwrap = false } = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-setup-'));
  tempDirs.push(tmp);
  const home = join(tmp, 'home');
  const root = join(tmp, 'projects');
  const prefix = join(tmp, 'npm');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, 'opencode.cmd'), '');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'opencode'), '');

  const mocks = {
    './prompt.mjs': PROMPT_MOCK,
    './engines.mjs': ENGINE_MOCK,
    './service.mjs': SERVICE_MOCK,
    './sandbox.mjs': SANDBOX_MOCK,
    'node:child_process': SPAWN_MOCK,
  };
  const map = {};
  for (const [specifier, source] of Object.entries(mocks)) {
    const file = join(tmp, specifier.replace(/[^a-z0-9]/gi, '_') + '.mjs');
    writeFileSync(file, source);
    map[specifier] = file;
  }
  const loader = join(tmp, 'loader.mjs');
  writeFileSync(loader, String.raw`
import { pathToFileURL } from 'node:url';
const map = JSON.parse(process.env.FAKE_MOCK_MAP);
export async function resolve(specifier, context, nextResolve) {
  const file = map[specifier];
  return file ? { url: pathToFileURL(file).href, shortCircuit: true } : nextResolve(specifier, context);
}
`);
  const prelude = join(tmp, 'prelude.mjs');
  writeFileSync(prelude, String.raw`
if (process.env.FAKE_PLATFORM) Object.defineProperty(process, 'platform', { value: process.env.FAKE_PLATFORM, configurable: true });
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
`);
  const promptUrl = pathToFileURL(map['./prompt.mjs']).href;
  const out = join(tmp, 'calls.json');
  const run = (body) => {
    const script = join(tmp, 'case.mjs');
    writeFileSync(script, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const S = await import(${JSON.stringify(SETUP_URL)});
const P = await import(${JSON.stringify(promptUrl)});
const ROOT_PATH = ${JSON.stringify(root)};
const CMD = (name) => join(process.env.FAKE_TMP, name);
const result = {};
${body}
writeFileSync(process.env.FAKE_OUT, JSON.stringify({ result, calls: globalThis.__FAKE_CALLS__ }));
`);
    const env = {
      ...process.env,
      PATH: '',
      ACPGRAM_HOME: home,
      ACPGRAM_LANG: 'ru',
      FAKE_TMP: tmp,
      PROJECTS_ROOT: '',
      USER_WORKSPACES: '',
      FAKE_MOCK_MAP: JSON.stringify(map),
      FAKE_PROMPTS: JSON.stringify(prompts).replaceAll('__ROOT__', JSON.stringify(root).slice(1, -1)),
      FAKE_FETCH: JSON.stringify(fetchRules),
      FAKE_ENGINE_CHECKS: JSON.stringify(engineChecks),
      FAKE_SERVICE_RESULT: JSON.stringify(serviceResult),
      FAKE_BWRAP: bwrap ? '1' : '0',
      FAKE_NPM_PREFIX: prefix,
      FAKE_OUT: out,
      ...(platform ? { FAKE_PLATFORM: platform } : {}),
    };
    const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', pathToFileURL(loader).href, '--import', pathToFileURL(prelude).href, script], {
      cwd: tmp, encoding: 'utf8', env, timeout: 30_000,
    });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    return { ...JSON.parse(readFileSync(out, 'utf8')), stdout: r.stdout };
  };
  return { tmp, home, root, prefix, run, prompts, fetchRules, engineChecks };
};

const adminFetch = () => [
  ADMIN_ME,
  { match: '/deleteWebhook', result: true },
  { match: '/getUpdates', result: [] },
  { match: '/getUpdates', result: [{ update_id: 1, message: { chat: { type: 'private' }, from: { id: 42, username: 'alice' } } }] },
  { match: '/getUpdates', result: [] },
];

test('setupRoot: неверный путь спрашивается заново, корень и личные пространства сохраняются', () => {
  const missing = join(tmpdir(), 'acpgram-нет-такого-корня');
  const h = harness({
    prompts: [
      { method: 'ask', answer: missing },
      { method: 'ask', answer: '__ROOT__' },
      { method: 'yes', answer: true },
      { method: 'yes', answer: false },
    ],
  });
  const { result, calls } = h.run(`
const env = { AGENT_SANDBOX: 'bwrap' };
await S.setupRoot(P.prompter(), env);
result.env = env;
`);
  assert.equal(calls.filter((c) => c.method === 'ask').length, 2);
  assert.ok(samePath(result.env.PROJECTS_ROOT, h.root));
  assert.equal(result.env.USER_WORKSPACES, '1');
  assert.equal(result.env.AGENT_SANDBOX, 'bwrap');
  assert.equal(Object.hasOwn(result.env, 'ADMIN_SANDBOX'), false);
  assert.ok(calls.filter((c) => c.method === 'yes').length === 2);
});

test('setupRoot: корень «-» выключает проекты, личные пространства и песочницу', () => {
  const h = harness({ platform: 'linux', bwrap: false, prompts: [{ method: 'ask', answer: '-' }] });
  const { result } = h.run(`
const env = { PROJECTS_ROOT: ROOT_PATH, USER_WORKSPACES: '1', AGENT_SANDBOX: 'bwrap', ADMIN_SANDBOX: '1' };
await S.setupRoot(P.prompter(), env);
result.env = env;
`);
  assert.equal(Object.hasOwn(result.env, 'PROJECTS_ROOT'), false);
  assert.equal(Object.hasOwn(result.env, 'USER_WORKSPACES'), false);
  assert.equal(Object.hasOwn(result.env, 'AGENT_SANDBOX'), false);
  assert.equal(Object.hasOwn(result.env, 'ADMIN_SANDBOX'), false);
});

test('setupRoot: на Linux с bwrap песочница и админская песочница включаются', () => {
  const h = harness({
    platform: 'linux',
    bwrap: true,
    prompts: [
      { method: 'ask', answer: '__ROOT__' },
      { method: 'yes', answer: false },
      { method: 'yes', answer: true },
      { method: 'yes', answer: true },
    ],
  });
  const { result, calls } = h.run(`
const env = {};
await S.setupRoot(P.prompter(), env);
result.env = env;
`);
  assert.ok(samePath(result.env.PROJECTS_ROOT, h.root));
  assert.equal(result.env.AGENT_SANDBOX, 'bwrap');
  assert.equal(result.env.ADMIN_SANDBOX, '1');
  assert.equal(Object.hasOwn(result.env, 'USER_WORKSPACES'), false);
  assert.equal(calls.filter((c) => c.method === 'yes').length, 3);
});

test('setupEngines: доступные движки, устаревший движок не выбирается по умолчанию', () => {
  const h = harness({
    engineChecks: [[{ ok: true, version: '1.0' }, { ok: false, tooOld: true, error: 'старый' }]],
  });
  writeFileSync(join(h.tmp, 'gemini'), '');
  writeFileSync(join(h.tmp, 'claude'), '');
  const { result, calls } = h.run(`
const env = { GEMINI_COMMAND: CMD('gemini'), CLAUDE_COMMAND: CMD('claude') };
result.available = await S.setupEngines(P.prompter(), env);
result.env = env;
`);
  assert.deepEqual(result.available, ['gemini']);
  assert.equal(result.env.DEFAULT_ENGINE, 'gemini');
  assert.equal(result.env.CLAUDE_COMMAND, join(h.tmp, 'claude'), 'устаревший движок остаётся прописанным');
  assert.deepEqual(calls.filter((c) => c.method === 'checkEngines').map((c) => c.args[0]), [['gemini', 'claude']]);
});

test('setupEngines: автодостановка OpenCode и сохранение полного пути к команде', () => {
  const h = harness({
    prompts: [{ method: 'yes', answer: true }],
    engineChecks: [[], [{ ok: true, version: '1.0' }]],
  });
  const { result, calls } = h.run(`
const env = {};
result.available = await S.setupEngines(P.prompter(), env);
result.env = env;
`);
  assert.deepEqual(result.available, ['opencode']);
  assert.equal(result.env.DEFAULT_ENGINE, 'opencode');
  assert.equal(result.env.OPENCODE_COMMAND, join(h.prefix, process.platform === 'win32' ? 'opencode.cmd' : join('bin', 'opencode')));
  assert.deepEqual(calls.filter((c) => c.method === 'checkEngines').map((c) => c.args[0]), [[], ['opencode']]);
  assert.ok(calls.some((c) => c.method === 'spawnSync' && JSON.stringify(c.args).includes('opencode-ai') && JSON.stringify(c.args).includes('install')));
});

test('setupEngines: неверный ответ на выбор движка заменяется подсказкой по умолчанию', () => {
  const h = harness({
    prompts: [{ method: 'ask', answer: 'net这样的engine' }],
    engineChecks: [[{ ok: true, version: '1' }, { ok: true, version: '2' }]],
  });
  writeFileSync(join(h.tmp, 'gemini'), '');
  writeFileSync(join(h.tmp, 'claude'), '');
  const { result } = h.run(`
const env = { GEMINI_COMMAND: CMD('gemini'), CLAUDE_COMMAND: CMD('claude') };
result.available = await S.setupEngines(P.prompter(), env);
result.env = env;
`);
  assert.deepEqual(result.available, ['gemini', 'claude']);
  assert.equal(result.env.DEFAULT_ENGINE, 'gemini');
});

test('runSetup: порядок шагов, сохранение .env, тестовое сообщение и отказ от службы', () => {
  const h = harness({
    prompts: [
      { method: 'secret', answer: '123:SECRET' },
      { method: 'yes', answer: true },
      { method: 'ask', answer: '__ROOT__' },
      { method: 'yes', answer: false },
      { method: 'yes', answer: false },
      { method: 'yes', answer: false },
    ],
    fetchRules: [...adminFetch(), { match: '/sendMessage', result: { message_id: 1 } }],
    engineChecks: [[]],
    serviceResult: { ok: true },
  });
  const { result, calls, stdout } = h.run(`
result.setup = await S.runSetup({});
result.envFile = existsSync(process.env.ACPGRAM_HOME + '/.env') ? readFileSync(process.env.ACPGRAM_HOME + '/.env', 'utf8') : '';
result.db = existsSync(process.env.ACPGRAM_HOME + '/data/bot.db');
`);
  assert.deepEqual(result.setup, { ok: true, service: false }, stdout);
  assert.equal(result.db, true);
  assert.match(result.envFile, /TELEGRAM_BOT_TOKEN=123:SECRET/);
  assert.match(result.envFile, /ALLOWED_USER_ID=42/);
  assert.ok(result.envFile.toLowerCase().includes(('PROJECTS_ROOT=' + h.root).toLowerCase()), result.envFile);
  assert.match(result.envFile, /GIT_AGENT_AUTH=1/);
  assert.deepEqual(calls.filter((c) => ['secret', 'ask', 'yes', 'close'].includes(c.method)).map((c) => c.method), [
    'secret', 'yes', 'ask', 'yes', 'yes', 'yes', 'close',
  ]);
  assert.deepEqual(calls.filter((c) => c.method === 'installService'), []);
  assert.ok(calls.some((c) => c.method === 'fetch' && c.args[0].includes('/sendMessage')));
});

test('runSetup: отказ сохранить .env прерывает мастер до регистрации службы', () => {
  const h = harness({
    prompts: [
      { method: 'secret', answer: '123:TO\nKEN' },
      { method: 'yes', answer: true },
      { method: 'ask', answer: '__ROOT__' },
      { method: 'yes', answer: false },
      { method: 'yes', answer: false },
    ],
    fetchRules: adminFetch(),
    engineChecks: [[]],
  });
  const { result, calls } = h.run(`
result.setup = await S.runSetup({});
result.envFile = existsSync(process.env.ACPGRAM_HOME + '/.env');
`);
  assert.deepEqual(result.setup, { ok: false, service: false });
  assert.equal(result.envFile, false);
  assert.deepEqual(calls.filter((c) => c.method === 'installService'), []);
  assert.equal(calls.at(-1).method, 'close');
});

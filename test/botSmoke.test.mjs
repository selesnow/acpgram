import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { t } from '../src/i18n.mjs';
import { fmtDate } from '../src/uiActions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = (name) => pathToFileURL(join(root, 'src', name)).href;

const waitFor = async (check, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('ожидание не завершилось');
};

const baseEnv = (home) => {
  const env = {
    ...process.env,
    ACPGRAM_HOME: home,
    TELEGRAM_BOT_TOKEN: 'test',
    ALLOWED_USER_ID: '1',
    DEFAULT_ENGINE: 'gemini',
    DEFAULT_LANG: 'en',
    PROJECTS_ROOT: home,
    GEMINI_COMMAND: process.execPath,
    CLAUDE_COMMAND: process.execPath,
    AGY_COMMAND: process.execPath,
    CODEX_COMMAND: process.execPath,
    QWEN_COMMAND: process.execPath,
    OPENCODE_COMMAND: process.execPath,
  };
  for (const key of ['AGENT_SANDBOX', 'ADMIN_SANDBOX', 'USER_WORKSPACES', 'GIT_AGENT_AUTH', 'WIDGETS']) delete env[key];
  return env;
};

const configCode = `
  globalThis.fetch = async (url) => {
    if (String(url).includes('getUpdates')) process.exit(3);
    return { json: async () => ({ ok: true, result: [] }) };
  };
  await import(${JSON.stringify(target('bot.mjs'))});
`;

const botHarness = (home, body) => `
  import { spawnSync } from 'node:child_process';
  import { writeFileSync } from 'node:fs';
  import { db } from ${JSON.stringify(target('ctx.mjs'))};
  import { envSignature } from ${JSON.stringify(target('access.mjs'))};
  import { ENGINES } from ${JSON.stringify(target('engines.mjs'))};
  const version = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();
  for (const id of Object.keys(ENGINES)) db.setSetting('catalog:' + id, JSON.stringify({
    models: [{ id: 'm', name: 'M' }], efforts: [], defaultModel: 'm', defaultEffort: null,
    at: new Date().toISOString(), version, envSig: envSignature(),
  }));
  const calls = [];
  const callsFile = ${JSON.stringify(join(home, 'calls.json'))};
  const dump = () => writeFileSync(callsFile, JSON.stringify(calls));
  const me = () => ({ json: async () => ({ ok: true, result: { username: 'smoke_bot', has_topics_enabled: false, allows_users_to_create_topics: false } }) });
  const empty = () => ({ json: async () => ({ ok: true, result: [] }) });
  const realExit = process.exit.bind(process);
  ${body}
`;

const runBot = (home, code, extra = {}) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...baseEnv(home), ...extra },
  });

test('импорт bot.mjs: контракт запуска без длинного polling-цикла', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-smoke-'));
  const callsFile = join(home, 'calls.json');
  const progressFile = join(home, 'progress.txt');
  const code = `
    import { spawnSync } from 'node:child_process';
    import { appendFileSync, writeFileSync } from 'node:fs';
    const { db } = await import(${JSON.stringify(target('ctx.mjs'))});
    const { envSignature } = await import(${JSON.stringify(target('access.mjs'))});
    const { ENGINES } = await import(${JSON.stringify(target('engines.mjs'))});
    const version = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' }).stdout.trim();
    for (const id of Object.keys(ENGINES)) db.setSetting('catalog:' + id, JSON.stringify({
      models: [{ id: 'm', name: 'M' }], efforts: [], defaultModel: 'm', defaultEffort: null,
      at: new Date().toISOString(), version, envSig: envSignature(),
    }));
    const realExit = process.exit.bind(process);
    const mark = (s) => appendFileSync(${JSON.stringify(progressFile)}, s + '\\n');
    mark('imports ok');
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const method = String(url).split('/').pop().split('?')[0];
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ method, body });
      if (method === 'getMe') return { json: async () => ({ ok: true, result: { username: 'smoke_bot', has_topics_enabled: false, allows_users_to_create_topics: false } }) };
      if (method === 'getUpdates' && body.offset === -1) {
        writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
      }
      if (method === 'getUpdates' && body.timeout === 30) {
        writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
        mark('first polling update');
        realExit(0);
      }
      return { json: async () => ({ ok: true, result: [] }) };
    };
    mark('before bot import');
    await import(${JSON.stringify(target('bot.mjs'))});
    mark('after bot import');
    setTimeout(() => { writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls)); mark('timeout exit'); realExit(2); }, 8000);
  `;
  const env = baseEnv(home);
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
    assert.equal(r.status, 0, `${r.stderr}\nprogress: ${existsSync(progressFile) ? readFileSync(progressFile, 'utf8') : 'empty'}`);
    const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
    assert.ok(calls.some((c) => c.method === 'getMe'));
    assert.ok(calls.some((c) => c.method === 'setMyCommands'));
    assert.ok(calls.some((c) => c.method === 'getUpdates' && c.body.offset === -1));
    assert.ok(calls.filter((c) => c.method === 'getUpdates' && c.body.timeout === 30).length <= 2, 'цикл getUpdates не должен крутиться в тесте');
    assert.equal(existsSync(join(home, 'data', 'bot.db')), true);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: без TELEGRAM_BOT_TOKEN бот завершается с ошибкой конфигурации', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-config-'));
  const env = baseEnv(home);
  env.TELEGRAM_BOT_TOKEN = '';
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', configCode], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /TELEGRAM_BOT_TOKEN/);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: некорректная конфигурация AGENT_SANDBOX запрещает запуск', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-sandbox-'));
  const env = baseEnv(home);
  env.AGENT_SANDBOX = 'bwrap';
  env.PROJECTS_ROOT = '';
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', configCode], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /PROJECTS_ROOT|только на Linux/);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: недоступный DEFAULT_ENGINE завершает запуск', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-engine-'));
  const env = baseEnv(home);
  env.GEMINI_COMMAND = join(home, 'missing-gemini');
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', configCode], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Не удалось запустить Gemini CLI|GEMINI_COMMAND/);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: оборванные запросы помечаются, уведомление уходит один раз на диалог', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-interrupted-'));
  const callsFile = join(home, 'calls.json');
  const body = `
    const s1 = db.startSession('s1', 111, 111, 'general', ${JSON.stringify(home)}, 'gemini');
    const s2 = db.startSession('s2', 222, 222, 'general', ${JSON.stringify(home)}, 'gemini');
    db.setSetting('lang:111', 'ru');
    db.setSetting('lang:222', 'en');
    db.startRequest(s1, 'a');
    db.startRequest(s1, 'b');
    db.startRequest(s2, 'c');
    globalThis.fetch = async (url, init) => {
      const method = String(url).split('/').pop().split('?')[0];
      const data = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body: data });
      dump();
      if (method === 'getMe') return me();
      if (method === 'getUpdates' && data.timeout === 30) realExit(0);
      return empty();
    };
    await import(${JSON.stringify(target('bot.mjs'))});
  `;
  try {
    const r = runBot(home, botHarness(home, body));
    assert.equal(r.status, 0, `${r.stderr}\n${existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''}`);
    const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
    const notices = calls.filter((c) => c.method === 'sendMessage');
    assert.equal(notices.length, 2);
    assert.deepEqual(notices.map((c) => c.body.chat_id).sort(), [111, 222]);
    assert.equal(notices.find((c) => c.body.chat_id === 111).body.text, t('turn.restarted', 'ru'));
    assert.equal(notices.find((c) => c.body.chat_id === 222).body.text, t('turn.restarted', 'en'));
    const database = new DatabaseSync(join(home, 'data', 'bot.db'), { readOnly: true });
    try {
      const rows = database.prepare('SELECT id, finished_at, stop_reason, error FROM requests ORDER BY id').all();
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.finished_at && row.stop_reason === 'interrupted' && row.error === 'interrupted by bot restart'), JSON.stringify(rows));
    } finally {
      database.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: чистка старых данных и напоминание о токене git при запуске', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-sweep-'));
  const callsFile = join(home, 'calls.json');
  const expiresFile = join(home, 'expires.json');
  const old = Date.now() - 5 * 86400_000;
  const dirs = [join(home, 'data', 'uploads', '555'), join(home, 'data', 'outbox', '555')];
  const body = `
    import { DatabaseSync } from 'node:sqlite';
    const direct = new DatabaseSync(${JSON.stringify(join(home, 'data', 'bot.db'))});
    const old = ${old};
    const oldSession = db.startSession('oldsweep', 555, 555, 'general', ${JSON.stringify(home)}, 'gemini');
    const oldRequest = db.startRequest(oldSession, 'old');
    direct.prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?').run(new Date(old).toISOString(), new Date(old).toISOString(), oldSession);
    direct.prepare('UPDATE requests SET started_at = ?, finished_at = ? WHERE id = ?').run(new Date(old).toISOString(), new Date(old).toISOString(), oldRequest);
    const freshSession = db.startSession('fresh', 556, 556, 'general', ${JSON.stringify(home)}, 'gemini');
    db.startRequest(freshSession, 'fresh');
    direct.close();
    const expires = new Date(Date.now() + 3 * 86400_000).toISOString();
    db.saveGitAccount(555, { host: 'github', login: 'alice', token: 't', expiresAt: expires });
    writeFileSync(${JSON.stringify(expiresFile)}, expires);
    globalThis.fetch = async (url, init) => {
      const method = String(url).split('/').pop().split('?')[0];
      const data = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body: data });
      dump();
      if (method === 'getMe') return me();
      if (method === 'getUpdates' && data.timeout === 30) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        dump();
        realExit(0);
      }
      return empty();
    };
    await import(${JSON.stringify(target('bot.mjs'))});
  `;
  try {
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      const stale = join(dir, 'old.txt');
      const fresh = join(dir, 'fresh.txt');
      writeFileSync(stale, 'old');
      writeFileSync(fresh, 'fresh');
      utimesSync(stale, old / 1000, old / 1000);
    }
    writeFileSync(join(home, 'data', 'debug.log.1'), 'old');
    writeFileSync(join(home, 'data', 'debug.log.2'), 'fresh');
    utimesSync(join(home, 'data', 'debug.log.1'), old / 1000, old / 1000);
    const r = runBot(home, botHarness(home, body), { FILES_KEEP_DAYS: '1', HISTORY_KEEP_DAYS: '1', LOGS_KEEP: '1' });
    assert.equal(r.status, 0, `${r.stderr}\n${existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''}`);
    assert.match(r.stdout, /удалено старых файлов: 2/);
    assert.match(r.stdout, /удалено старых записей истории: 2/);
    assert.match(r.stdout, /удалено старых файлов журнала: 1/);
    assert.match(r.stdout, /git: напоминание о токене: 555 github 7/);
    assert.equal(existsSync(join(home, 'data', 'debug.log.1')), false);
    assert.equal(existsSync(join(home, 'data', 'debug.log.2')), true);
    for (const dir of dirs) {
      assert.equal(existsSync(join(dir, 'old.txt')), false);
      assert.equal(existsSync(join(dir, 'fresh.txt')), true);
    }
    const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
    const notices = calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === 555);
    assert.equal(notices.length, 1);
    const expires = readFileSync(expiresFile, 'utf8');
    assert.equal(notices[0].body.text, t('git.exp.soon', 'en', { host: 'GitHub', login: 'alice', date: fmtDate(expires, 'en'), days: 3 }));
    assert.deepEqual(notices[0].body.reply_markup, { inline_keyboard: [[{ text: t('start.btn.git', 'en'), callback_data: 'ui:git' }]] });
    const database = new DatabaseSync(join(home, 'data', 'bot.db'), { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    } finally {
      database.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: ошибка getUpdates не останавливает обработку обновлений', () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-poll-'));
  const callsFile = join(home, 'calls.json');
  const body = `
    let polls = 0;
    globalThis.fetch = async (url, init) => {
      const method = String(url).split('/').pop().split('?')[0];
      const data = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body: data });
      dump();
      if (method === 'getMe') return me();
      if (method === 'getUpdates' && data.timeout === 30) {
        polls++;
        if (polls === 1) throw new Error('boom');
        if (polls === 2) return { json: async () => ({ ok: true, result: [{
          update_id: 7,
          message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'Admin', language_code: 'en' }, text: '/start' },
        }] }) };
        await new Promise((resolve) => setTimeout(resolve, 150));
        dump();
        realExit(0);
      }
      return empty();
    };
    await import(${JSON.stringify(target('bot.mjs'))});
  `;
  try {
    const r = runBot(home, botHarness(home, body));
    assert.equal(r.status, 0, `${r.stderr}\n${existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''}`);
    assert.match(r.stdout, /getUpdates: boom/);
    const calls = JSON.parse(readFileSync(callsFile, 'utf8'));
    const polls = calls.filter((c) => c.method === 'getUpdates' && c.body.timeout === 30);
    assert.ok(polls.length >= 3);
    assert.equal(polls[1].body.offset, polls[0].body.offset);
    assert.equal(polls.at(-1).body.offset, 8);
    assert.ok(calls.some((c) => c.method === 'sendRichMessage' && c.body.rich_message.markdown.includes(t('start.title', 'en'))), JSON.stringify(calls));
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('bot.mjs: SIGTERM закрывает базу и завершает процесс без необработанных ошибок', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-bot-shutdown-'));
  const pollingFile = join(home, 'polling.txt');
  const closedFile = join(home, 'closed.txt');
  const body = `
    const originalClose = db.close.bind(db);
    db.close = () => {
      writeFileSync(${JSON.stringify(closedFile)}, 'closed');
      originalClose();
    };
    globalThis.fetch = async (url, init) => {
      const method = String(url).split('/').pop().split('?')[0];
      const data = init?.body ? JSON.parse(init.body) : {};
      calls.push({ method, body: data });
      dump();
      if (method === 'getMe') return me();
      if (method === 'getUpdates' && data.timeout === 30) {
        writeFileSync(${JSON.stringify(pollingFile)}, 'ready');
        setTimeout(() => process.emit('SIGTERM'), 100);
        return new Promise(() => {});
      }
      return empty();
    };
    await import(${JSON.stringify(target('bot.mjs'))});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', botHarness(home, body)], {
    cwd: root,
    env: baseEnv(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(pollingFile), 10_000);
    const status = await new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', reject);
      setTimeout(() => reject(new Error(`бот не завершился: ${stderr}`)), 10_000);
    });
    assert.equal(status.code, 0, `${stderr}\n${stdout}`);
    assert.equal(existsSync(closedFile), true);
    assert.equal(readFileSync(closedFile, 'utf8'), 'closed');
    assert.doesNotMatch(stderr, /необработанное исключение/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

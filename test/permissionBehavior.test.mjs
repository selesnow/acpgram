import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-permission-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const realFetch = globalThis.fetch;
const calls = [];
let messageId = 100;
let failMarkup = false;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop().split('?')[0];
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ method, body });
  if (failMarkup && method === 'editMessageReplyMarkup') throw new Error('markup rejected');
  return { json: async () => ({ ok: true, result: { message_id: messageId++ } }) };
};

const { db } = await import('../src/ctx.mjs');
const { getEngine } = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');
const { dropPermissions, getState } = await import('../src/state.mjs');
const { askPermission, onPermissionCallback } = await import('../src/permission.mjs');

const USER = 1;
db.setSetting(`lang:${USER}`, 'en');

const findCall = (method) => calls.find((c) => c.method === method);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cb = (data) => ({ id: 'cb', data, message: { message_id: 9 } });

function freshState() {
  const st = getState(USER, USER, null);
  const dbSessionId = db.startSession('perm-session', USER, USER, 'default', home, 'claude');
  st.agent = {
    engine: getEngine('claude'),
    sessionId: 'perm-session',
    dbSessionId,
    closed: false,
  };
  st.engine = 'claude';
  st.requestId = db.startRequest(dbSessionId, 'permission test');
  st.perms = new Map();
  st.busy = true;
  return st;
}

const params = (options) => ({
  sessionId: 'perm-session',
  toolCall: { toolCallId: 'c1', kind: 'execute', title: 'git status', rawInput: { command: 'git status' } },
  options,
});

const allowOnce = { optionId: 'allow-once', kind: 'allow_once', name: 'Allow' };
const rejectOnce = { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' };

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('askPermission: правило сессии отвечает без вопроса пользователю', async () => {
  const st = freshState();
  st.agent.sessionRules = new Set(['exec:git status']);
  calls.length = 0;
  const result = await askPermission(st, params([allowOnce, { optionId: 'allow-always', kind: 'allow_always', name: 'Always' }]));
  assert.deepEqual(result, { outcome: 'selected', optionId: 'allow-once' });
  assert.equal(findCall('sendMessage'), undefined);
  assert.equal(st.perms.size, 0);
});

test('askPermission: без вариантов разрешения запрос отклоняется автоматически', async () => {
  const st = freshState();
  calls.length = 0;
  const result = await askPermission(st, params([rejectOnce]));
  assert.deepEqual(result, { outcome: 'selected', optionId: 'reject-once' });
  assert.match(findCall('sendMessage').body.text, /git status/);
  assert.equal(st.perms.size, 0);
});

test('onPermissionCallback: устаревший и неверный вариант получают отдельный ответ', async () => {
  const st = freshState();
  calls.length = 0;
  await onPermissionCallback(st, cb('perm:999:0'));
  assert.equal(findCall('answerCallbackQuery').body.text, t('perm.stale', 'en'));

  const pending = askPermission(st, params([allowOnce, rejectOnce]));
  await tick();
  const seq = [...st.perms.keys()][0];
  assert.ok(seq, 'интерактивный запрос зарегистрирован');
  calls.length = 0;
  await onPermissionCallback(st, cb(`perm:${seq}:99`));
  assert.equal(findCall('answerCallbackQuery').body.text, t('perm.badOption', 'en'));
  dropPermissions(st);
  await pending;
});

test('onPermissionCallback: вариант «на сессию» запоминает правило и отвечает агенту «один раз»', async () => {
  const st = freshState();
  const pending = askPermission(st, params([allowOnce, rejectOnce]));
  await tick();
  const seq = [...st.perms.keys()][0];
  const ask = findCall('sendMessage');
  const data = ask.body.reply_markup.inline_keyboard[1][0].callback_data;
  assert.equal(data, `perm:${seq}:1`);
  calls.length = 0;
  await onPermissionCallback(st, cb(data));
  const result = await pending;
  assert.deepEqual(result, { outcome: 'selected', optionId: 'allow-once' });
  assert.ok(st.agent.sessionRules.has('exec:git status'));
  assert.equal(findCall('editMessageReplyMarkup').body.reply_markup.inline_keyboard[0][0].text, t('perm.res.allow_always', 'en'));
});

test('dropPermissions: при отказе Telegram редактировать кнопки уходит текст итога', async () => {
  const st = freshState();
  const pending = askPermission(st, params([allowOnce, rejectOnce]));
  await tick();
  calls.length = 0;
  failMarkup = true;
  try {
    dropPermissions(st);
    await pending;
    await tick();
  } finally {
    failMarkup = false;
  }
  assert.equal(findCall('editMessageReplyMarkup').method, 'editMessageReplyMarkup');
  assert.ok(findCall('editMessageText'));
});

test('askPermission: таймаут 5 минут отклоняет запрос, помечает его в базе и убирает кнопку', async (tc) => {
  const st = freshState();
  const answers = [];
  mock.method(db, 'permissionAnswered', (...args) => answers.push(args));
  mock.timers.enable({ apis: ['setTimeout'] });
  tc.after(() => {
    mock.timers.reset();
    mock.restoreAll();
  });
  calls.length = 0;
  const pending = askPermission(st, params([allowOnce, rejectOnce]));
  await tick();
  assert.equal(st.perms.size, 1);

  mock.timers.tick(5 * 60 * 1000 - 1);
  assert.equal(st.perms.size, 1);
  mock.timers.tick(1);

  assert.deepEqual(await pending, { outcome: 'cancelled' });
  await tick();
  assert.equal(st.perms.size, 0);
  assert.deepEqual(answers.at(-1).slice(1), [null, 'timeout']);
  const markup = findCall('editMessageReplyMarkup');
  assert.ok(markup);
  const button = markup.body.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, t('perm.res.timeout', 'en'));
  assert.equal(button.style, 'danger');
  assert.deepEqual(button.disabled, {});
});

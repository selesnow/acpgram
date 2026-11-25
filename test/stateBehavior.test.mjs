import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-state-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.ALLOWED_USER_ID = '1';
process.env.DEFAULT_ENGINE = 'gemini';
process.env.IDLE_MINUTES = '1';
delete process.env.PROJECTS_ROOT;
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) });

const { db, IDLE_MS, langOf } = await import('../src/ctx.mjs');
const { ENGINES } = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');
const S = await import('../src/state.mjs');

const ADMIN = 1;
const USER = 902;
const project = join(home, 'project');
mkdirSync(project, { recursive: true });
db.setSetting(`lang:${ADMIN}`, 'en');
db.setSetting(`lang:${USER}`, 'en');

const fakeAgent = (sessionId, engine = ENGINES.gemini) => ({
  engine,
  sessionId,
  dbSessionId: null,
  cwd: project,
  startedAt: 1,
  closed: false,
  cancel() {},
  close() {
    this.closed = true;
  },
});

after(() => {
  globalThis.fetch = realFetch;
  S.shutdownAll('test-cleanup');
  db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('levelLabel, modeFor и engineOf: неизвестные значения падают на безопасный выбор', () => {
  assert.equal(langOf(ADMIN), 'en');
  assert.equal(S.levelLabel(ADMIN), t('level.admin', 'en'));
  assert.equal(S.levelLabel(USER), '—');
  assert.equal(S.modeFor(USER, ENGINES.gemini), ENGINES.gemini.modes.read);
  const st = S.getState(903, 903, null);
  st.engine = 'unknown';
  assert.equal(S.engineOf(st).id, 'gemini');
});

test('recentProjects: только существующие папки внутри корня, без текущего проекта', () => {
  const first = join(home, 'recent-one');
  const second = join(home, 'recent-two');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const st = S.getState(904, 904, null);
  st.project = first;
  db.setSetting(`recent:${904}`, JSON.stringify([first, second, join(home, 'deleted'), 'C:\\outside', 42]));
  assert.deepEqual(S.recentProjects(st), [second]);
});

test('saveEngine: выбор темы пишется и в тему, и в настройки пользователя', () => {
  S.topicsSupport.enabled = true;
  const st = S.getState(905, 905, 61);
  st.resumeId = 'old-session';
  S.saveEngine(st, 'claude');
  assert.equal(st.engine, 'claude');
  assert.equal(st.resumeId, null);
  assert.equal(db.getSetting(`engine:${905}`), 'claude');
  assert.equal(db.getTopic(905, 61).engine, 'claude');
});

test('dropPermissions: все ожидающие запросы получают итог и снимают кнопки', () => {
  const st = S.getState(906, 906, null);
  const outcomes = [];
  let dropped = 0;
  st.perms.set(1, {
    dbId: 1,
    resolve: (o) => outcomes.push(o),
    onDrop: () => dropped++,
  });
  st.perms.set(2, {
    dbId: 2,
    resolve: (o) => outcomes.push(o),
  });
  const outcome = { outcome: 'selected', optionId: 'allow-once' };
  S.dropPermissions(st, outcome);
  assert.equal(st.perms.size, 0);
  assert.deepEqual(outcomes, [outcome, outcome]);
  assert.equal(dropped, 1);
});

test('stopUser и closeSession: запрос и очередь прерываются, сессия закрывается', () => {
  const st = S.getState(907, 907, null);
  st.busy = true;
  st.queued = { text: 'next' };
  st.suppress = false;
  st.agent = fakeAgent('s-907');
  let cancelled = 0;
  st.agent.cancel = () => cancelled++;
  const outcome = { outcome: 'cancelled' };
  let resolved = null;
  st.perms.set(3, { dbId: 3, resolve: (o) => (resolved = o) });

  S.stopUser(st, 'access');
  assert.equal(cancelled, 1);
  assert.equal(st.suppress, true);
  assert.equal(st.queued, null);
  assert.equal(st.agent, null);
  assert.equal(st.perms.size, 0);
  assert.deepEqual(resolved, outcome);
  st.busy = false;
  assert.equal(S.closeSession(st, 'close'), false);


  st.agent = fakeAgent('s-907-2');
  assert.equal(S.closeSession(st, 'close'), true);
  assert.equal(st.agent, null);
});

test('activeSessions: работающие сессии видны с названием темы и флагом занятости', () => {
  S.topicsSupport.enabled = true;
  const general = S.getState(908, 908, null);
  const topic = S.getState(908, 908, 62);
  db.saveTopic(908, 62, { name: 'Отчёты', named: true });
  general.agent = fakeAgent('g', ENGINES.claude);
  topic.agent = fakeAgent('t', ENGINES.gemini);
  topic.busy = true;
  const rows = S.activeSessions().filter((s) => s.userId === ADMIN || s.userId === 908);
  const byTopic = rows.find((s) => s.topic === 'Отчёты');
  assert.ok(byTopic);
  assert.equal(byTopic.engine, 'Gemini');
  assert.equal(byTopic.busy, true);
  assert.equal(byTopic.project, project);
  general.agent = null;
  topic.agent = null;
  topic.busy = false;
});

test('ensureAgent: недоступный проект не запускает агента', async () => {
  const st = S.getState(909, 909, null);
  st.project = join(home, 'missing-project');
  st.agent = null;
  await assert.rejects(() => S.ensureAgent(st), (e) => e instanceof S.ProjectError);
});

test('topicsOn и setTopicsMode: режим «диалоги» выключается и включается', () => {
  S.topicsSupport.enabled = true;
  assert.equal(S.topicsOn(913), true);
  S.setTopicsMode(913, false);
  assert.equal(S.topicsOn(913), false);
  S.setTopicsMode(913, true);
  assert.equal(S.topicsOn(913), true);
});

test('saveProject: проект темы, недавние проекты и сессия обновляются', () => {
  S.topicsSupport.enabled = true;
  const st = S.getState(914, 914, 65);
  st.project = project;
  st.resumeId = 'old-session';
  const next = join(home, 'next-project');
  mkdirSync(next, { recursive: true });
  S.saveProject(st, next);
  assert.equal(st.project, next);
  assert.equal(st.resumeId, null);
  assert.equal(db.getSetting(`project:${914}`), next);
  assert.equal(db.getTopic(914, 65).project, next);
  const recent = JSON.parse(db.getSetting(`recent:${914}`));
  assert.ok(recent.includes(project));
  assert.equal(recent.includes(next), false);
});

test('endAgent: в теме сессия сохраняется только после безопасного закрытия', () => {
  S.topicsSupport.enabled = true;
  const st = S.getState(915, 915, 66);
  db.saveTopic(915, 66, { name: 'Сессия', named: true });
  st.agent = fakeAgent('keep-session');
  S.endAgent(st, 'evicted');
  assert.equal(st.resumeId, 'keep-session');
  assert.equal(st.agent, null);
  st.agent = fakeAgent('drop-session');
  S.endAgent(st, 'mode-violation');
  assert.equal(st.resumeId, null);
  assert.equal(db.getTopic(915, 66).acp_session_id, '');
});

test('reserveSlot: выгружается давний простаивающий диалог, занятые не трогаются', () => {
  S.topicsSupport.enabled = true;
  const user = 916;
  const current = S.getState(user, user, 67);
  const old = S.getState(user, user, 68);
  const fresh = S.getState(user, user, 69);
  old.agent = fakeAgent('old');
  fresh.agent = fakeAgent('fresh');
  old.lastActive = 1;
  fresh.lastActive = Date.now();
  S.reserveSlot(current);
  assert.equal(old.agent, null);
  assert.notEqual(fresh.agent, null);
  const busyUser = 917;
  const busyCurrent = S.getState(busyUser, busyUser, 70);
  const busyA = S.getState(busyUser, busyUser, 71);
  const busyB = S.getState(busyUser, busyUser, 72);
  busyA.agent = fakeAgent('busy-a');
  busyB.agent = fakeAgent('busy-b');
  busyA.busy = true;
  busyB.busy = true;
  assert.throws(() => S.reserveSlot(busyCurrent), (e) => e instanceof S.LimitError);
  busyA.agent = null;
  busyB.agent = null;
  busyA.busy = false;
  busyB.busy = false;
});

test('releaseSessionElsewhere: сессия переносится, занятый диалог блокирует перенос', () => {
  S.topicsSupport.enabled = true;
  const user = 918;
  const current = S.getState(user, user, 73);
  const other = S.getState(user, user, 74);
  const agent = fakeAgent('shared');
  other.agent = agent;
  other.resumeId = 'shared';
  S.releaseSessionElsewhere(current, 'shared');
  assert.equal(agent.closed, true);
  assert.equal(other.agent, null);
  assert.equal(other.resumeId, null);
  assert.equal(db.getTopic(user, 74).acp_session_id, '');
  const busy = fakeAgent('busy-shared');
  other.agent = busy;
  other.busy = true;
  assert.throws(() => S.releaseSessionElsewhere(current, 'busy-shared'), (e) => e instanceof S.LimitError);
  other.agent = null;
  other.busy = false;
});

test('startIdleReaper: простаивающая сессия закрывается с кнопкой возврата к сессиям', async () => {
  S.topicsSupport.enabled = false;
  const st = S.getState(910, 910, null);
  st.agent = fakeAgent('idle-session');
  st.busy = false;
  st.lastActive = Date.now() - IDLE_MS - 1000;
  const calls = [];
  const originalSetInterval = globalThis.setInterval;
  const originalFetch = globalThis.fetch;
  let tick;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { json: async () => ({ ok: true, result: { message_id: 2 } }) };
  };
  globalThis.setInterval = (fn) => {
    tick = fn;
    return { unref() {} };
  };
  try {
    S.startIdleReaper();
    assert.equal(typeof tick, 'function');
    tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(st.agent, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'ui:sessions');
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.fetch = originalFetch;
  }
});

test('shutdownAll: закрывает все агенты и снимает ожидающие разрешения', () => {
  const a = S.getState(911, 911, null);
  const b = S.getState(912, 912, null);
  const agentA = fakeAgent('a');
  const agentB = fakeAgent('b');
  a.agent = agentA;
  b.agent = agentB;
  let resolved = 0;
  a.perms.set(4, { dbId: 4, resolve: () => resolved++ });
  S.shutdownAll('test');
  assert.equal(agentA.closed, true);
  assert.equal(agentB.closed, true);
  assert.equal(a.agent, null);
  assert.equal(b.agent, null);
  assert.equal(a.perms.size, 0);
  assert.equal(resolved, 1);
});

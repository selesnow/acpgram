// Модули, которые при загрузке открывают базу бота (ctx.mjs, access.mjs): каталог данных — временный.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// настоящий путь: на macOS временная папка — ссылка (/var → /private/var), на Windows бывает короткое имя (RUNNER~1),
// а бот хранит проект настоящим путём
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-runtime-')));
process.env.ACPGRAM_HOME = home;
delete process.env.PROJECTS_ROOT; // проект — любая папка (иначе временная папка вне корня), независимо от окружения службы
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
const ctx = await import('../src/ctx.mjs');
const { CATALOG_TTL_MS, catalogFresh } = await import('../src/access.mjs');
after(() => {
  ctx.db.close();
  rmSync(home, { recursive: true, force: true });
});

test('debug.log: по умолчанию выключен', async () => {
  assert.equal(ctx.DEBUG, false);
  await ctx.dbg('draft', 'текст');
  assert.equal(existsSync(join(home, 'data', 'debug.log')), false);
});

test('createDebugLog: запись по очереди, при превышении размера — один прошлый файл .1', async () => {
  const path = join(home, 'dbg.log');
  const write = ctx.createDebugLog(path, 300);
  for (let i = 0; i < 8; i++) write('draft', `запись ${i} ${'x'.repeat(40)}`);
  await write('final', 'последняя');
  assert.ok(existsSync(`${path}.1`), 'прошлый файл сохранён');
  assert.ok(statSync(path).size < 300 + 200);
  assert.match(readFileSync(path, 'utf8'), /последняя/);
  assert.equal(existsSync(`${path}.2`), false);
});

test('catalogFresh: свежий каталог той же версии движка не запрашивается заново', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const cat = (hoursAgo, extra = {}) => ({ models: [{ id: 'm', name: 'M' }], efforts: [], at: new Date(now - hoursAgo * 3600_000).toISOString(), version: '1.2.3', ...extra });
  assert.equal(catalogFresh(cat(1), '1.2.3', now), true);
  assert.equal(catalogFresh(cat(CATALOG_TTL_MS / 3600_000 + 1), '1.2.3', now), false, 'старше суток');
  assert.equal(catalogFresh(cat(1), '1.3.0', now), false, 'движок обновился');
  assert.equal(catalogFresh(cat(1, { version: undefined }), '1.2.3', now), false, 'каталог до 1.16 — без версии');
  assert.equal(catalogFresh(cat(1, { models: [], efforts: [] }), '1.2.3', now), false, 'пустой');
  assert.equal(catalogFresh(null, '1.2.3', now), false);
});

// ---- диалоги и темы (state.mjs) ----
const S = await import('../src/state.mjs');
const fakeAgent = (sessionId) => ({ sessionId, closed: false, dbSessionId: null, close() { this.closed = true; } });

test('getState: без тем у бота — один диалог, ответы в тему последнего сообщения', () => {
  S.topicsSupport.enabled = false;
  const a = S.getState(101, 101, 7);
  const b = S.getState(101, 101, 9);
  assert.equal(a, b, 'одно состояние на пользователя');
  assert.equal(b.topic, 0);
  assert.deepEqual(b.to, { chat_id: 101, message_thread_id: 9 }, 'ответ — туда, откуда пришло сообщение');
  assert.equal(S.getState(101, 101, null).to, 101);
});

test('getState: режим «диалоги» — своё состояние у каждой темы, General — обычный диалог; пользователь может выключить', () => {
  S.topicsSupport.enabled = true;
  const general = S.getState(102, 102, null);
  const t1 = S.getState(102, 102, 11);
  const t2 = S.getState(102, 102, 12);
  assert.notEqual(t1, t2);
  assert.notEqual(general, t1);
  assert.equal(t1.topic, 11);
  assert.deepEqual(t1.to, { chat_id: 102, message_thread_id: 11 });
  assert.equal(S.findState(102, 12), t2);
  assert.equal(S.statesOf(102).length, 3);

  S.setTopicsMode(102, false);
  assert.equal(S.topicsOn(102), false);
  assert.equal(S.getState(102, 102, 11), general, 'выключил — снова один диалог');
  S.setTopicsMode(102, true);
  assert.equal(S.getState(102, 102, 11), t1);
});

test('тема помнит проект, движок и сессию; после простоя или /close сессия продолжается, после смены проекта — нет', () => {
  S.topicsSupport.enabled = true;
  const st = S.getState(103, 103, 21);
  S.saveProject(st, home);
  assert.equal(ctx.db.getTopic(103, 21).project, home);

  st.agent = fakeAgent('sess-1');
  ctx.db.saveTopic(103, 21, { acpSessionId: 'sess-1' });
  S.endAgent(st, 'idle');
  assert.equal(st.resumeId, 'sess-1', 'простой — продолжим ту же сессию');

  st.agent = fakeAgent('sess-1');
  S.endAgent(st, 'project');
  assert.equal(st.resumeId, null, 'другой проект — новая сессия');
  assert.equal(ctx.db.getTopic(103, 21).acp_session_id, '', 'и в базе тоже');

  // после перезапуска бота тема поднимает сессию из базы
  ctx.db.saveTopic(103, 22, { acpSessionId: 'sess-2', project: home, engine: 'claude' });
  const fresh = S.getState(103, 103, 22);
  assert.equal(fresh.resumeId, 'sess-2');
  assert.equal(fresh.engine, 'claude');
  assert.equal(fresh.project, home);
});

test('обычный диалог: после простоя — новая сессия (как раньше), после выгрузки ради места — та же', () => {
  S.topicsSupport.enabled = false;
  const st = S.getState(104, 104, null);
  st.agent = fakeAgent('c-1');
  S.endAgent(st, 'idle');
  assert.equal(st.resumeId, null);
  st.agent = fakeAgent('c-2');
  S.endAgent(st, 'evicted');
  assert.equal(st.resumeId, 'c-2');
});

test('лимит агентов: свой самый давний простаивающий диалог выгружается, занятые — нет', () => {
  S.topicsSupport.enabled = true;
  const [a, b, c] = [31, 32, 33].map((th) => S.getState(105, 105, th));
  a.agent = fakeAgent('a');
  a.lastActive = 1;
  b.agent = fakeAgent('b');
  b.lastActive = 2;
  S.reserveSlot(c); // лимит сотрудника — 2: выгружается самый давний (a)
  assert.equal(a.agent, null);
  assert.equal(a.resumeId, 'a', 'выгруженная тема продолжит свою сессию');
  assert.ok(b.agent);

  c.agent = fakeAgent('c');
  b.busy = true;
  c.busy = true;
  assert.throws(() => S.reserveSlot(a), (e) => e instanceof S.LimitError, 'все свои агенты заняты — ждать');
  b.busy = c.busy = false;
  b.agent = c.agent = null;
});

// ---- темы проекта (режим «диалоги», v1.19) ----
const { projectTopicsView } = await import('../src/projectsUi.mjs');

test('listTopics: темы проекта свежие первыми, без убранных, без учёта регистра пути', async () => {
  const proj = join(home, 'ProjA');
  for (const [th, name] of [[41, 'Первая'], [42, 'Вторая'], [43, 'Третья']]) {
    ctx.db.saveTopic(106, th, { name, named: true, project: proj });
    await new Promise((r) => setTimeout(r, 5)); // разное время активности
  }
  ctx.db.saveTopic(106, 44, { name: 'Чужой проект', project: join(home, 'ProjB') });
  ctx.db.saveTopic(106, 42, { hidden: true });
  const r = ctx.db.listTopics(106, proj.toLowerCase(), 10, 0);
  assert.deepEqual(r.items.map((x) => x.name), ['Третья', 'Первая']);
  assert.equal(r.total, 2);
  ctx.db.saveTopic(106, 42, { hidden: false }); // написали в тему — вернулась наверх
  assert.equal(ctx.db.listTopics(106, proj, 10, 0).items[0].name, 'Вторая');
});

test('projectTopicsView: кнопки-ссылки на темы, новый диалог, уборка, страницы', () => {
  ctx.botInfo.username = 'test_bot';
  S.topicsSupport.enabled = true;
  const proj = join(home, 'ProjC');
  for (let i = 1; i <= 12; i++) ctx.db.saveTopic(107, 100 + i, { name: `Тема ${i}`, named: true, project: proj });
  const general = S.getState(107, 107, null);
  const v = projectTopicsView(general, proj);
  const rows = v.markup.inline_keyboard;
  assert.equal(rows.filter((r) => r[0].url).length, 10, '10 тем на странице');
  assert.match(rows[0][0].url, /^https:\/\/t\.me\/test_bot\/\d+$/);
  assert.match(rows[0][0].text, /^Тема \d+ · \d\d[./]\d\d$/); // дата на языке пользователя: 13.11 или 11/13
  assert.ok(rows.some((r) => r.some((b) => b.text === '1/2')), 'есть вторая страница');
  assert.ok(rows.some((r) => r[0].callback_data?.startsWith('tpl:n:')), 'новый диалог в проекте');
  assert.ok(rows.some((r) => r[0].callback_data?.startsWith('tpl:c:')), 'уборка');

  const c = projectTopicsView(general, proj, { page: 1, cleanup: true });
  const cr = c.markup.inline_keyboard;
  assert.equal(cr.filter((r) => r[0].callback_data?.startsWith('tpl:h:')).length, 2, 'на второй странице 2 темы с ✖');
  assert.ok(cr.at(-1)[0].callback_data.startsWith('tpl:p:'), 'Готово — назад к списку');

  const empty = projectTopicsView(general, join(home, 'Empty'));
  assert.equal(empty.markup.inline_keyboard.length, 1, 'только «новый диалог»');
  const inTopic = projectTopicsView(S.getState(107, 107, 101), proj);
  assert.notEqual(inTopic.text.split('\n')[1], v.text.split('\n')[1], 'в теме — свой заголовок');
});

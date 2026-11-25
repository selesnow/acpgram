// Модули, которые при загрузке открывают базу бота (ctx.mjs, access.mjs): каталог данных — временный.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// настоящий путь: на macOS временная папка — ссылка (/var → /private/var), на Windows бывает короткое имя (RUNNER~1),
// а бот хранит проект настоящим путём
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-runtime-')));
process.env.ACPGRAM_HOME = home;
delete process.env.PROJECTS_ROOT; // проект — любая папка (иначе временная папка вне корня), независимо от окружения службы
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.WIDGETS = '1'; // виджеты выключены по умолчанию — в тестах отправки они нужны
process.env.ALLOWED_USER_ID ??= '1';
// Telegram в тестах не вызывается: без подмены сообщение из проверяемого кода (say) ушло бы настоящим запросом в Bot API —
// а в окружении, где задан токен рабочего бота, ещё и от его имени
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) });
const ctx = await import('../src/ctx.mjs');
const { CATALOG_TTL_MS, catalogFresh, catalogStaleReason, envSignature } =await import('../src/access.mjs');
const PROBE = fileURLToPath(new URL('./fixtures/probe-agent.mjs', import.meta.url));
after(() => {
  globalThis.fetch = realFetch;
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
  const cat = (hoursAgo, extra = {}) => ({ models: [{ id: 'm', name: 'M' }], efforts: [], at: new Date(now - hoursAgo * 3600_000).toISOString(), version: '1.2.3', envSig: 'sig1', ...extra });
  assert.equal(catalogFresh(cat(1), '1.2.3', now, 'sig1'), true);
  assert.equal(catalogFresh(cat(CATALOG_TTL_MS / 3600_000 + 1), '1.2.3', now, 'sig1'), false, 'старше суток');
  assert.equal(catalogFresh(cat(1), '1.3.0', now, 'sig1'), false, 'движок обновился');
  assert.equal(catalogFresh(cat(1, { version: undefined }), '1.2.3', now, 'sig1'), false, 'каталог до 1.16 — без версии');
  assert.equal(catalogFresh(cat(1, { models: [], efforts: [] }), '1.2.3', now, 'sig1'), false, 'пустой');
  assert.equal(catalogFresh(null, '1.2.3', now, 'sig1'), false);
  assert.equal(catalogFresh(cat(1), '1.2.3', now, 'sig2'), false, 'изменился набор ключей API');
  assert.equal(catalogFresh(cat(1, { envSig: undefined }), '1.2.3', now, 'sig1'), false, 'каталог до 1.20.1 — без отпечатка ключей');
  assert.match(catalogStaleReason(cat(1), '1.2.3', now, 'sig2'), /ключей/);
  assert.equal(catalogStaleReason(cat(1), '1.2.3', now, 'sig1'), null);
});

test('envSignature: зависит от набора заданных *_API_KEY, но не от значений и порядка', () => {
  const a = envSignature({ OPENAI_API_KEY: 'x', GROQ_API_KEY: 'y', PATH: 'p' });
  assert.equal(a, envSignature({ GROQ_API_KEY: 'другое', OPENAI_API_KEY: 'значение' }), 'значения и порядок не важны');
  assert.notEqual(a, envSignature({ OPENAI_API_KEY: 'x', GROQ_API_KEY: 'y', OPENROUTER_API_KEY: 'z' }), 'добавлен ключ');
  assert.equal(a, envSignature({ OPENAI_API_KEY: 'x', GROQ_API_KEY: 'y', OPENROUTER_API_KEY: '' }), 'пустой ключ не считается');
  assert.doesNotMatch(a, /x|y/, 'значения в отпечаток не попадают');
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
const { folderRows, projectTopicsView } = await import('../src/projectsUi.mjs');

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
  assert.match(v.text.split('\n')[0], /<code>.*ProjC<\/code>$/, 'путь проекта — моноширинным (HTML)');
});

test('folderRows: короткие имена папок — по две в ряд, длинное — на всю ширину, порядок сохраняется', () => {
  assert.deepEqual(folderRows(['a', 'b', 'c']), [['a', 'b'], ['c']]);
  const long = 'recruitment_research_ai_assistant';
  assert.deepEqual(folderRows(['a', long, 'b', 'c', 'd']), [['a'], [long], ['b', 'c'], ['d']]);
  assert.deepEqual(folderRows([]), []);
});

test('одна сессия — в одном диалоге: при возобновлении в другом месте лишняя закрывается', () => {
  S.topicsSupport.enabled = true;
  const general = S.getState(108, 108, null);
  const topicA = S.getState(108, 108, 51);
  const topicB = S.getState(108, 108, 52);
  general.agent = fakeAgent('X');
  ctx.db.saveTopic(108, 52, { acpSessionId: 'X' });
  topicB.resumeId = 'X';

  S.releaseSessionElsewhere(topicA, 'X'); // /sessions в теме A возвращает сессию X
  assert.equal(general.agent, null, 'в General процесс сессии X закрыт');
  assert.equal(general.resumeId, null, 'и не возобновится там сам');
  assert.equal(topicB.resumeId, null, 'тема B, ждавшая X, её забыла');
  assert.equal(ctx.db.getTopic(108, 52).acp_session_id, '');

  general.agent = fakeAgent('Y');
  general.busy = true;
  assert.throws(() => S.releaseSessionElsewhere(topicA, 'Y'), (e) => e instanceof S.LimitError, 'занятый запросом диалог не трогаем');
  assert.ok(general.agent);
  general.busy = false;
  general.agent = null;
  S.releaseSessionElsewhere(topicA, null); // без сессии — ничего
});

// ---- виджеты: отправка с откатом на обычное меню (widgetHost.mjs), HTML экранов (modelUi, sessionsUi) ----
test('sendWidgetMessage: успех запоминает тему; отказ Telegram — false и пауза, а не повтор при каждом /model', async () => {
  const H = await import('../src/widgetHost.mjs');
  const st = { userId: 7, chatId: 7, threadId: 42, to: { chat_id: 7, message_thread_id: 42 } };
  const calls = [];
  const ok = async (method, body) => (calls.push([method, body]), { message_id: 900 });
  assert.equal(await H.sendWidgetMessage(st, { html: '<p>x</p>', caption: 'c', kind: 'model', engine: 'claude' }, { send: ok, now: 1000 }), true);
  assert.equal(calls[0][0], 'sendWidget');
  assert.equal(calls[0][1].message_thread_id, 42);
  assert.equal(calls[0][1].allow_queries, true);
  assert.equal(calls[0][1].reply_markup.inline_keyboard[0][0].callback_data, 'wid:model', 'кнопка «Обычное меню»');
  assert.deepEqual(H.widgetInfo(7, 900), { threadId: 42, kind: 'model', engine: 'claude' });
  assert.equal(H.widgetInfo(7, 901), null);
  // слишком большой виджет не отправляется вовсе
  assert.equal(await H.sendWidgetMessage(st, { html: 'x'.repeat(40_000), caption: 'c', kind: 'model' }, { send: ok, now: 1000 }), false);
  assert.equal(calls.length, 1);
  // обычная ошибка — откат без паузы; «виджеты боту не разрешены» — пауза на час
  let n = 0;
  const fail = (msg) => async () => (n++, Promise.reject(new Error(msg)));
  assert.equal(await H.sendWidgetMessage(st, { html: '<p>x</p>', caption: 'c', kind: 'sessions' }, { send: fail('Telegram sendWidget: 400 Bad Request: SOMETHING'), now: 2000 }), false);
  assert.equal(await H.sendWidgetMessage(st, { html: '<p>x</p>', caption: 'c', kind: 'sessions' }, { send: fail('Telegram sendWidget: 400 Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED'), now: 3000 }), false);
  assert.equal(n, 2);
  assert.equal(await H.sendWidgetMessage(st, { html: '<p>x</p>', caption: 'c', kind: 'sessions' }, { send: ok, now: 3000 + H.NOT_ALLOWED_PAUSE_MS - 1 }), false, 'в течение паузы не пробуем');
  assert.equal(calls.length, 1);
  assert.equal(await H.sendWidgetMessage(st, { html: '<p>x</p>', caption: 'c', kind: 'sessions' }, { send: ok, now: 3000 + H.NOT_ALLOWED_PAUSE_MS }), true, 'после паузы — снова');
  assert.equal(H.isNotAllowed(new Error('x INPUT_MEDIA_WIDGET_NOT_ALLOWED')), true);
  assert.equal(H.isNotAllowed(new Error('INPUT_MEDIA_WIDGET_TOO_LARGE')), false);
});

test('sessionsWidgetHtml и checkResumable: виджет сессий помещается в лимит, чужую и работающую сессию возобновить нельзя', async () => {
  const U = await import('../src/sessionsUi.mjs');
  const { widgetFits } = await import('../src/widgets.mjs');
  const list = Array.from({ length: 30 }, (_, i) => ({ acp_id: `ses-${i}`, engine: 'gemini', last_at: new Date(Date.UTC(2026, 10, 1 + (i % 28), 9, i)).toISOString(), n: i + 1, first_text: `Запрос ${i}: ${'очень длинный и неповторяющийся текст '.repeat(4)}${Math.sin(i)}` }));
  const html = U.sessionsWidgetHtml({ list, current: 'ses-2', project: 'reports', lang: 'ru' });
  assert.ok(html && widgetFits(html));
  assert.match(html, /Сессии проекта reports: \d+/);
  const st = { userId: 1, agent: { sessionId: 'ses-2' } };
  assert.match(U.checkResumable(st, null).error, /не найдена|not found/i);
  assert.ok(U.checkResumable(st, list[2]).error, 'уже работает в этом диалоге');
});

test('applyChoice: выбор модели из виджета и кнопок — только из разрешённого, ссылкой, номером или «Авто»', async () => {
  const A = await import('../src/access.mjs');
  const M = await import('../src/modelUi.mjs');
  const { ENGINES } = await import('../src/engines.mjs');
  const { shortKey } = await import('../src/widgets.mjs');
  const engine = ENGINES.claude;
  A.saveCatalog(engine, { configOptions: [{ id: 'model', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] }, { id: 'effort', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'high', name: 'High' }] }] });
  const st = { userId: 1 };
  assert.deepEqual(M.applyChoice(st, engine, 'model', 'opus'), { ok: true, value: 'opus' });
  assert.equal(A.effectiveSelection(1, engine).model, 'opus');
  assert.deepEqual(M.applyChoice(st, engine, 'model', shortKey('sonnet')), { ok: true, value: 'sonnet' });
  assert.deepEqual(M.applyChoice(st, engine, 'model', '#0'), { ok: true, value: 'opus' });
  assert.deepEqual(M.applyChoice(st, engine, 'effort', 'high'), { ok: true, value: 'high' });
  assert.deepEqual(M.applyChoice(st, engine, 'model', '~'), { ok: true, value: null });
  assert.equal(M.applyChoice(st, engine, 'model', 'gpt-5').ok, false, 'модели нет в каталоге движка');
  assert.equal(M.applyChoice(st, engine, 'effort', 'ultra').ok, false);
  const html = M.modelWidgetHtml({ userId: 1 }, engine, A.getCatalog(engine.id));
  assert.match(html, /"m":\[\["opus","Opus"\],\["sonnet","Sonnet"\]\]/);
});

test('/model: устаревший каталог обновляется по запросу и показывает свежий список', async () => {
  const A = await import('../src/access.mjs');
  const M = await import('../src/modelUi.mjs');
  const { ENGINES } = await import('../src/engines.mjs');
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalClaudeArgs = ENGINES.claude.args;
  const originalGeminiArgs = ENGINES.gemini.args;
  const originalClaudeCommand = process.env.CLAUDE_COMMAND;
  const originalGeminiCommand = process.env.GEMINI_COMMAND;
  const originalProbe = process.env.FAKE_PROBE;
  const restoreEnv = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(url).split('/').pop().split('?')[0], body: init.body ? JSON.parse(init.body) : {} });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    process.env.CLAUDE_COMMAND = process.execPath;
    process.env.GEMINI_COMMAND = process.execPath;
    process.env.FAKE_PROBE = 'normal';
    ENGINES.claude.args = [PROBE];
    ENGINES.gemini.args = [PROBE];
    const seeded = A.saveCatalog(ENGINES.claude, { configOptions: [{ id: 'model', currentValue: 'opencode/old', options: [{ value: 'opencode/old', name: 'Old' }] }] });
    seeded.at = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    ctx.db.setSetting('lang:1', 'en');
    await M.handleModel({ userId: 1, to: 1, engine: 'claude' }, '', { classic: true });
    assert.ok(calls.some((c) => /Updating the model list/.test(c.body.text ?? '')), 'показано сообщение об обновлении');
    assert.match(JSON.stringify(calls.at(-1).body.reply_markup), /Zen/);
    assert.ok(A.getCatalog('claude').models.some((m) => m.id === 'opencode/zen'));
  } finally {
    A.killProbes();
    globalThis.fetch = originalFetch;
    ENGINES.claude.args = originalClaudeArgs;
    ENGINES.gemini.args = originalGeminiArgs;
    restoreEnv('CLAUDE_COMMAND', originalClaudeCommand);
    restoreEnv('GEMINI_COMMAND', originalGeminiCommand);
    restoreEnv('FAKE_PROBE', originalProbe);
  }
});

test('/model: если обновить каталог не вышло, показывается прежний список', async () => {
  const A = await import('../src/access.mjs');
  const M = await import('../src/modelUi.mjs');
  const { ENGINES } = await import('../src/engines.mjs');
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalClaudeArgs = ENGINES.claude.args;
  const originalGeminiArgs = ENGINES.gemini.args;
  const originalClaudeCommand = process.env.CLAUDE_COMMAND;
  const originalGeminiCommand = process.env.GEMINI_COMMAND;
  const originalProbe = process.env.FAKE_PROBE;
  const restoreEnv = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(url).split('/').pop().split('?')[0], body: init.body ? JSON.parse(init.body) : {} });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  try {
    process.env.CLAUDE_COMMAND = process.execPath;
    process.env.GEMINI_COMMAND = process.execPath;
    process.env.FAKE_PROBE = 'auth';
    ENGINES.claude.args = [PROBE];
    ENGINES.gemini.args = [PROBE];
    const seeded = A.saveCatalog(ENGINES.gemini, { models: { currentModelId: 'gemini-old', availableModels: [{ modelId: 'gemini-old', name: 'Old Gemini' }] } });
    seeded.at = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    ctx.db.setSetting('lang:1', 'en');
    await M.handleModel({ userId: 1, to: 1, engine: 'gemini' }, '', { classic: true });
    assert.ok(calls.some((c) => /Updating the model list/.test(c.body.text ?? '')), 'показано сообщение об обновлении');
    assert.match(JSON.stringify(calls.at(-1).body.reply_markup), /Old Gemini/);
    assert.equal(A.getCatalog('gemini').models[0].id, 'gemini-old');
  } finally {
    A.killProbes();
    globalThis.fetch = originalFetch;
    ENGINES.claude.args = originalClaudeArgs;
    ENGINES.gemini.args = originalGeminiArgs;
    restoreEnv('CLAUDE_COMMAND', originalClaudeCommand);
    restoreEnv('GEMINI_COMMAND', originalGeminiCommand);
    restoreEnv('FAKE_PROBE', originalProbe);
  }
});

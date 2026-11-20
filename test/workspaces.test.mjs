// Личные пространства (USER_WORKSPACES=1): у каждого сотрудника свой корень — папка <корень>/<Telegram ID>.
// Модули открывают базу бота и читают настройки при загрузке, поэтому режим включается до импорта, а каталог данных — временный.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-ws-')));
const root = join(home, 'projects');
mkdirSync(join(root, 'shared', 'old'), { recursive: true });
mkdirSync(join(home, 'outside'));
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.USER_WORKSPACES = '1';
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

// Telegram в тестах не вызывается: запросы складываются в sent
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: { message_id: sent.length, message_thread_id: 900 + sent.length } }) };
};
const take = () => sent.splice(0);

const ctx = await import('../src/ctx.mjs');
const P = await import('../src/projects.mjs');
const S = await import('../src/state.mjs');
const U = await import('../src/projectsUi.mjs');

const ADMIN = ctx.ADMIN_ID;
const [ANN, BOB, EVE] = [2001, 2002, 2003].map((id) => (id === ADMIN ? id + 100 : id));
const dirOf = (id) => join(root, String(id));
for (const id of [ANN, BOB, EVE, ADMIN]) ctx.setLang(id, 'ru');
ctx.db.upsertUser({ user_id: ANN, username: 'ann', first_name: 'Ann', level: 'normal', added_by: ADMIN });
ctx.db.upsertUser({ user_id: BOB, username: null, first_name: 'Bob', level: 'normal', added_by: ADMIN });

/** Нажатие кнопки пользователем. */
const press = (id, data) => ({ id: 'cb', data, message: { chat: { id }, message_id: 5 } });
/** Кнопки последнего сообщения с клавиатурой. */
const buttons = (calls) => calls.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  rmSync(home, { recursive: true, force: true });
});

test('корень: сотруднику — своя папка (создаётся сама), администратору — весь корень проектов', () => {
  assert.equal(P.USER_WORKSPACES, true);
  assert.equal(S.rootOf(ADMIN), root);
  assert.equal(existsSync(dirOf(ANN)), false, 'до первого обращения папки нет');
  assert.equal(S.rootOf(ANN), dirOf(ANN));
  assert.ok(existsSync(dirOf(ANN)), 'папка создана при первом обращении');
  assert.equal(S.getState(ANN, ANN).project, dirOf(ANN), 'новый сотрудник начинает в своей папке');
  assert.equal(S.getState(ADMIN, ADMIN).project, root);
});

test('пути показываются от личного пространства, без пути на сервере', () => {
  mkdirSync(join(dirOf(ANN), 'site'), { recursive: true });
  assert.equal(S.userPath(ANN, dirOf(ANN), 'ru'), 'Моё пространство');
  assert.equal(S.userPath(ANN, dirOf(ANN), 'en'), 'My workspace');
  assert.equal(S.userPath(ANN, join(dirOf(ANN), 'site'), 'ru'), 'site');
  assert.equal(S.userPath(ADMIN, dirOf(ANN), 'ru'), String(ANN), 'администратор видит папку сотрудника от общего корня');
  assert.equal(S.topicProject(ANN, dirOf(ANN), 'ru'), 'Моё пространство', 'тема в корне пространства — не «2001 · …»');
  assert.equal(S.topicProject(ANN, join(dirOf(ANN), 'site'), 'ru'), join(dirOf(ANN), 'site'));
});

test('сохранённый проект вне личного пространства сбрасывается на него; сессия темы в чужой папке не продолжается', () => {
  S.topicsSupport.enabled = true;
  const old = join(root, 'shared', 'old'); // общий проект, выбранный до включения личных пространств
  const mine = join(dirOf(BOB), 'app');
  mkdirSync(mine, { recursive: true });
  ctx.db.setSetting(`project:${BOB}`, old);
  ctx.db.setSetting(`recent:${BOB}`, JSON.stringify([old, dirOf(ANN), mine]));
  ctx.db.saveTopic(BOB, 31, { project: old, acpSessionId: 'sess-old' });
  ctx.db.saveTopic(BOB, 32, { project: mine, acpSessionId: 'sess-mine' });

  const general = S.getState(BOB, BOB, null);
  assert.equal(general.project, dirOf(BOB));
  assert.deepEqual(S.recentProjects(general), [mine], 'в недавних — только свои папки');
  const moved = S.getState(BOB, BOB, 31);
  assert.equal(moved.project, dirOf(BOB));
  assert.equal(moved.resumeId, null, 'сессия из общей папки не возобновляется');
  const kept = S.getState(BOB, BOB, 32);
  assert.equal(kept.project, mine);
  assert.equal(kept.resumeId, 'sess-mine', 'тема в своей папке продолжает сессию');
  S.topicsSupport.enabled = false;
});

test('/project: чужая папка недоступна ни по пути, ни по кнопке, ни через список тем', async () => {
  S.topicsSupport.enabled = false;
  const ann = S.getState(ANN, ANN);
  S.rootOf(BOB);
  for (const q of [dirOf(BOB), `../${BOB}`, root, '..']) {
    await U.handleProject(ann, q);
    assert.equal(ann.project, dirOf(ANN), `запрос «${q}» проект не меняет`);
  }
  take();

  // администратор открывает корень: в кнопках — токены чужих папок, подписи — с именами сотрудников
  await U.handleProject(S.getState(ADMIN, ADMIN), '');
  const adminButtons = buttons(take());
  const bobFolder = adminButtons.find((b) => b.text.startsWith(`📁 ${BOB}`));
  assert.equal(adminButtons.find((b) => b.text.startsWith(`📁 ${ANN}`)).text, `📁 ${ANN} · @ann`);
  assert.equal(bobFolder.text, `📁 ${BOB} · Bob`);
  const tok = bobFolder.callback_data.split(':')[2];

  // сотрудник подставляет чужой токен в свои кнопки
  await U.onNavCallback(ann, press(ANN, `nav:s:${tok}`));
  assert.equal(ann.project, dirOf(ANN));
  const denied = take().map((c) => c.body.text ?? '').join('\n');
  assert.match(denied, /вне вашего пространства/);
  assert.ok(!denied.includes(root), 'путь корня на сервере сотруднику не показывается');
  await U.onNavCallback(ann, press(ANN, `nav:o:${tok}:0`));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery'], 'чужая папка не открывается');
  await U.onNavCallback(ann, press(ANN, `nav:c:${tok}`));
  assert.equal(ann.pendingInput ?? null, null, 'и папку в ней не создать');
  await U.onTopicListCallback(ann, press(ANN, `tpl:n:${tok}`));
  assert.ok(!take().some((c) => c.method === 'createForumTopic'), 'диалог в чужой папке не создаётся');

  // свои папки — как обычно; «Вверх» из своего корня нет
  await U.handleProject(ann, '');
  const own = buttons(take());
  assert.ok(own.some((b) => b.text === '📁 site'));
  assert.ok(!own.some((b) => b.text === '⬆️ Вверх'), 'выше личного пространства подняться нельзя');
  await U.handleProject(ann, 'site');
  assert.equal(ann.project, join(dirOf(ANN), 'site'));
  take();
});

test('«Новый проект»: бот ждёт название, создаёт папку в личном пространстве и выбирает её проектом', async () => {
  S.topicsSupport.enabled = false;
  const ann = S.getState(ANN, ANN);
  assert.equal(U.canCreateProject(ANN), true);
  assert.equal(U.canCreateProject(ADMIN), true);
  await U.handleProject(ann, '');
  const create = buttons(take()).find((b) => b.callback_data.startsWith('nav:c:'));
  assert.equal(create.text, '➕ Новый проект');

  assert.equal(await U.onProjectNameInput(ann, 'обычный запрос'), false, 'без ожидания текст — запрос агенту');
  await U.onNavCallback(ann, press(ANN, create.callback_data));
  assert.equal(ann.pendingInput.kind, 'newProject');
  take();

  assert.equal(await U.onProjectNameInput(ann, `../${BOB}/evil`), true);
  assert.match(take()[0].body.text, /не подойдёт/);
  assert.equal(existsSync(join(dirOf(BOB), 'evil')), false);
  assert.ok(ann.pendingInput, 'после неподходящего названия бот ждёт другое');

  assert.equal(await U.onProjectNameInput(ann, '  Мой сайт '), true);
  const made = join(dirOf(ANN), 'Мой сайт');
  assert.ok(existsSync(made), 'папка создана рядом с открытой в навигации');
  assert.equal(ann.project, made, 'и выбрана проектом');
  assert.equal(ann.pendingInput, null);
  take();

  // отмена и истечение ожидания
  await U.onNavCallback(ann, press(ANN, create.callback_data));
  await U.onNavCallback(ann, press(ANN, 'nav:x'));
  assert.equal(ann.pendingInput, null);
  ann.pendingInput = { kind: 'newProject', dir: dirOf(ANN), at: Date.now() - U.NEW_PROJECT_WAIT_MS - 1 };
  assert.equal(await U.onProjectNameInput(ann, 'поздно'), false, 'через 10 минут текст снова уходит агенту');
  assert.equal(existsSync(join(dirOf(ANN), 'поздно')), false);
  take();
});

test('агент не запускается, если папка проекта оказалась вне корня пользователя', async () => {
  const ann = S.getState(ANN, ANN);
  const saved = ann.project;
  ann.project = dirOf(BOB); // состояние подменено в обход проверок выбора
  await assert.rejects(S.ensureAgent(ann), (e) => e instanceof S.ProjectError && /Папка проекта недоступна/.test(e.message));
  assert.equal(ann.agent, null, 'процесс агента не создан');
  ann.project = join(dirOf(ANN), 'удалили');
  await assert.rejects(S.ensureAgent(ann), (e) => e instanceof S.ProjectError);
  ann.project = saved;
});

test('ссылка на месте личной папки доступ не расширяет', async (t) => {
  try {
    symlinkSync(join(home, 'outside'), dirOf(EVE), 'junction'); // на Windows junction не требует прав администратора
  } catch {
    return t.skip('не удалось создать ссылку');
  }
  assert.equal(S.rootOf(EVE), dirOf(EVE), 'корень — сам путь папки, а не то, куда ведёт ссылка');
  assert.equal(P.insideRoot(dirOf(EVE), S.rootOf(EVE)), null);
  assert.equal(P.insideRoot(join(home, 'outside'), S.rootOf(EVE)), null);
  const eve = S.getState(EVE, EVE);
  await assert.rejects(S.ensureAgent(eve), (e) => e instanceof S.ProjectError, 'агент в папке по ссылке не запускается');
  await U.handleProject(eve, '');
  assert.ok(!buttons(take()).some((b) => b.callback_data.startsWith('nav:o:')), 'содержимое папки по ссылке не показывается');
});

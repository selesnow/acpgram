// Git, вторая часть: отмена изменений, публикация проекта, запрос на слияние, метки агента [[git:push]] / [[git:pull]],
// напоминание об истекающем токене. Сеть не нужна: API GitHub и Telegram подменены, адреса репозиториев на GitHub
// подставляются на локальные репозитории настройкой git url.<путь>.insteadOf.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const hasGit = spawnSync('git', ['--version']).status === 0;
const needGit = { skip: hasGit ? false : 'git не установлен' };

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-git2-')));
const root = join(home, 'projects');
const bareApp = join(home, 'remote', 'app.git').replace(/\\/g, '/');
const bareNew = join(home, 'remote', 'newproj.git').replace(/\\/g, '/');
const APP_URL = 'https://github.com/acme/app.git';
const NEW_URL = 'https://github.com/acme/newproj.git';
mkdirSync(root);
mkdirSync(join(home, 'remote'));
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.USER_WORKSPACES = '1';
for (const k of ['GITLAB_URL', 'GITHUB_URL', 'GIT_AGENT_AUTH', 'AGENT_SANDBOX', 'GIT_COMMAND']) delete process.env[k];
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${bareApp}.insteadOf`,
  GIT_CONFIG_VALUE_0: APP_URL,
  GIT_CONFIG_KEY_1: `url.${bareNew}.insteadOf`,
  GIT_CONFIG_VALUE_1: NEW_URL,
});

const TOKEN = 'ghp_test0123456789secretTOKEN';
const sent = [];
const apiLog = []; // запросы к API: [метод, путь, тело]
const gh = { pulls: [], forbid: false };
const realFetch = globalThis.fetch;
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.github.com')) {
    const path = u.slice('https://api.github.com'.length);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    apiLog.push([method, path, body]);
    if (gh.forbid && method === 'POST') return json({ message: 'Resource not accessible by personal access token' }, 403);
    if (path === '/user') return json({ login: 'ann-dev', name: 'Ann Dev', email: 'ann@example.com', id: 42 });
    if (path.startsWith('/user/orgs')) return json([{ login: 'acme' }, { login: 'other-team' }]);
    if (method === 'POST' && (path === '/user/repos' || path === '/orgs/acme/repos')) return json({ clone_url: NEW_URL, html_url: 'https://github.com/acme/newproj', full_name: 'acme/newproj' }, 201);
    if (path === '/repos/acme/app') return json({ default_branch: 'main', html_url: 'https://github.com/acme/app' });
    if (method === 'GET' && path.startsWith('/repos/acme/app/pulls')) return json(gh.pulls);
    if (method === 'POST' && path === '/repos/acme/app/pulls') {
      gh.pulls = [{ html_url: 'https://github.com/acme/app/pull/7', number: 7 }];
      return json(gh.pulls[0], 201);
    }
    return json({ message: 'Not Found' }, 404);
  }
  const method = u.split('/').pop();
  sent.push({ method, body: typeof init.body === 'string' ? JSON.parse(init.body) : {} });
  return { json: async () => ({ ok: true, result: { message_id: 700 + sent.length } }) };
};
const take = () => sent.splice(0);
const texts = (calls) => calls.map((c) => c.body.text ?? '').join('\n');
const buttons = (calls) => calls.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();
const press = (id, data) => ({ id: 'cb', data, message: { chat: { id }, message_id: 5 } });

const ctx = await import('../src/ctx.mjs');
const G = await import('../src/git.mjs');
const I = await import('../src/gitInspect.mjs');
const A = await import('../src/gitAccess.mjs');
const API = await import('../src/gitApi.mjs');
const H = await import('../src/gitHosts.mjs');
const M = await import('../src/gitMarks.mjs');
const S = await import('../src/state.mjs');
const U = await import('../src/gitUi.mjs');
G.setGitAvailable(hasGit);

const ADMIN = ctx.ADMIN_ID;
const ANN = ADMIN === 5001 ? 5101 : 5001;
ctx.setLang(ANN, 'ru');
ctx.db.upsertUser({ user_id: ANN, username: 'ann', level: 'normal', added_by: ADMIN });
ctx.db.saveGitAccount(ANN, { host: 'github', login: 'ann-dev', name: 'Ann Dev', email: 'ann@example.com', token: TOKEN });
S.topicsSupport.enabled = false;
const ann = S.getState(ANN, ANN);
const ws = S.rootOf(ANN);
const env = G.gitEnv({ identity: { name: 'Сервер', email: 'server@example.com' } });
const git = (cwd, ...args) => G.runGit(args, { cwd, env });
const github = H.gitHosts({})[0];
/** Текст файла с переводами строк LF: на Windows git при настройке core.autocrlf возвращает файлы с CRLF. */
const text = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows не всегда сразу отпускает папку, в которой только что работал git: уборка временной папки — не предмет теста */
  }
});

test('метки агента [[git:push]] / [[git:pull]]: убираются из ответа, в коде не срабатывают, в черновике не мелькают', () => {
  assert.deepEqual(M.extractGitMarks('Готово, закоммитил.\n\n[[git:push]]\n'), { text: 'Готово, закоммитил.', actions: ['push'] });
  assert.deepEqual(M.extractGitMarks('a [[git:pull]] b\n[[GIT:PUSH]]\n[[git:push]]\nконец'), { text: 'a b\n\nконец', actions: ['pull', 'push'] });
  assert.deepEqual(M.extractGitMarks('пример: `[[git:push]]`\n```\n[[git:pull]]\n```'), { text: 'пример: `[[git:push]]`\n```\n[[git:pull]]\n```', actions: [] });
  assert.deepEqual(M.extractGitMarks('без меток [[grid]]'), { text: 'без меток [[grid]]', actions: [] });
  for (const [draft, shown] of [['текст [[git:push]]', 'текст '], ['текст [[git:pu', 'текст '], ['текст [[g', 'текст '], ['текст [[', 'текст [['], ['список [[grid]]', 'список [[grid]]']]) {
    assert.equal(M.stripGitMarks(draft), shown, draft);
  }
});

test('API: места для публикации, создание репозитория, сведения о нём и запрос на слияние (GitHub и GitLab)', async () => {
  const seen = [];
  const gitlab = H.customHost('gitlab', 'https://git.example.com');
  const reply = (handler) => async (url, init = {}) => {
    seen.push([init.method ?? 'GET', url.replace(/^https:\/\/[^/]+/, ''), init.body ? JSON.parse(init.body) : null]);
    return handler(url, init);
  };
  // GitLab
  let f = reply((url) => json(url.includes('/groups') ? [{ id: 9, full_path: 'team/web' }] : url.includes('/merge_requests?') ? [] : { http_url_to_repo: 'https://git.example.com/team/web/site.git', web_url: 'https://git.example.com/team/web/site', path_with_namespace: 'team/web/site', default_branch: 'master', iid: 3 }));
  assert.deepEqual(await API.listNamespaces(gitlab, 't', 'bob', { fetchImpl: f }), [{ id: null, path: 'bob', kind: 'user' }, { id: 9, path: 'team/web', kind: 'group' }]);
  assert.deepEqual(await API.listNamespaces(gitlab, 't', 'bob', { search: 'Web', fetchImpl: f }), [{ id: 9, path: 'team/web', kind: 'group' }], 'личное пространство под поиск не подошло');
  assert.match(seen.at(-1)[1], /\/groups\?min_access_level=30.*&search=web$/);
  assert.deepEqual(API.visibilities(gitlab), ['private', 'internal', 'public']);
  const made = await API.createRepo(gitlab, 't', { name: 'Мой сайт', slug: 'site', namespace: { id: 9, path: 'team/web' }, visibility: 'internal' }, { fetchImpl: f });
  assert.deepEqual(made, { url: 'https://git.example.com/team/web/site.git', web: 'https://git.example.com/team/web/site', path: 'team/web/site' });
  assert.deepEqual(seen.at(-1), ['POST', '/api/v4/projects', { name: 'Мой сайт', path: 'site', visibility: 'internal', initialize_with_readme: false, namespace_id: 9 }]);
  const remote = 'https://git.example.com/team/web/site.git';
  assert.equal(API.repoPath(gitlab, remote), 'team/web/site');
  assert.deepEqual(await API.repoInfo(gitlab, 't', remote, { fetchImpl: f }), { defaultBranch: 'master', web: 'https://git.example.com/team/web/site' });
  assert.equal(seen.at(-1)[1], '/api/v4/projects/team%2Fweb%2Fsite');
  const mr = await API.openMergeRequest(gitlab, 't', remote, { branch: 'fix/1', target: 'master', title: 'Правка' }, { fetchImpl: f });
  assert.deepEqual(mr, { url: 'https://git.example.com/team/web/site', number: 3, existed: false });
  assert.deepEqual(seen.at(-1), ['POST', '/api/v4/projects/team%2Fweb%2Fsite/merge_requests', { source_branch: 'fix/1', target_branch: 'master', title: 'Правка' }]);
  f = reply(() => json([{ web_url: 'https://git.example.com/mr/5', iid: 5 }]));
  assert.deepEqual(await API.openMergeRequest(gitlab, 't', remote, { branch: 'fix/1', target: 'master', title: 'x' }, { fetchImpl: f }), { url: 'https://git.example.com/mr/5', number: 5, existed: true }, 'открытый запрос не дублируется');
  // ошибки: текст сервиса и отдельный код для нехватки прав
  await assert.rejects(API.createRepo(gitlab, 't', { name: 'x', slug: 'x' }, { fetchImpl: reply(() => json({ message: { name: ['has already been taken'], path: ['has already been taken'] } }, 400)) }), (e) => e.code === 'http' && /name has already been taken; path has already been taken/.test(e.message));
  await assert.rejects(API.createRepo(gitlab, 't', { name: 'x', slug: 'x' }, { fetchImpl: reply(() => json({ message: '403 Forbidden' }, 403)) }), (e) => e.code === 'forbidden');
  // GitHub: организации вместо групп, внутренней видимости нет
  assert.deepEqual((await API.listNamespaces(github, TOKEN, 'ann-dev')).map((n) => n.path), ['ann-dev', 'acme', 'other-team']);
  assert.deepEqual((await API.listNamespaces(github, TOKEN, 'ann-dev', { search: 'ACME' })).map((n) => n.path), ['acme']);
  assert.deepEqual(API.visibilities(github), ['private', 'public']);
  assert.equal(API.repoPath(github, APP_URL), 'acme/app');
  // название репозитория из названия папки
  assert.equal(API.repoSlug('My Site_v2.git'), 'my-site_v2');
  assert.equal(API.repoSlug('  --Сайт 2026--  '), '2026');
  for (const bad of ['Мой сайт', '', '...', '---']) assert.equal(API.repoSlug(bad), null, bad);
});

test('напоминания о токене: за неделю, за день и по истечении — каждое один раз', () => {
  const day = 24 * 3600_000;
  const now = Date.parse('2026-12-01T12:00:00Z');
  const set = (iso) => ctx.db.saveGitAccount(ANN, { host: 'github', login: 'ann-dev', name: 'Ann Dev', email: 'ann@example.com', token: TOKEN, expiresAt: iso });
  set(new Date(now + 30 * day).toISOString());
  assert.deepEqual(A.tokenReminders(now), [], 'до срока далеко');
  set(new Date(now + 5 * day).toISOString());
  let r = A.tokenReminders(now);
  assert.deepEqual(r.map((x) => [x.userId, x.host.id, x.stage, x.days]), [[ANN, 'github', '7', 5]]);
  assert.deepEqual(A.tokenReminders(now + 3600_000), [], 'то же напоминание не повторяется');
  r = A.tokenReminders(now + 4.5 * day);
  assert.deepEqual(r.map((x) => x.stage), ['1']);
  r = A.tokenReminders(now + 6 * day);
  assert.deepEqual(r.map((x) => x.stage), ['expired']);
  assert.deepEqual(A.tokenReminders(now + 9 * day), []);
  set(null);
  assert.deepEqual(A.tokenReminders(now), [], 'токен без срока');
});

test('git: отмена изменений файлов и подготовка папки к публикации — на настоящем репозитории', needGit, async () => {
  const w = join(home, 'discard');
  mkdirSync(w);
  assert.equal(await I.isRepoRoot(w, { env }), false);
  await I.ensureRepo(w, { env });
  assert.equal(await I.isRepoRoot(w, { env }), true);
  assert.equal(await I.hasCommits(w, { env }), false);
  writeFileSync(join(w, 'a.txt'), 'раз\n');
  writeFileSync(join(w, 'b.txt'), 'два\n');
  writeFileSync(join(w, 'c.txt'), 'три\n');
  await G.commitAll(w, 'начало работы', { env });
  assert.equal(await I.hasCommits(w, { env }), true);
  assert.equal(await I.lastSubject(w, { env }), 'начало работы');
  // вложенная папка — не корень репозитория: для публикации в ней заводится свой
  mkdirSync(join(w, 'inner'));
  assert.equal(await I.isRepoRoot(join(w, 'inner'), { env }), false);
  await I.setRemote(w, 'https://github.com/acme/one.git', { env });
  await I.setRemote(w, 'https://github.com/acme/two.git', { env });
  assert.equal((await G.repoState(w, { env })).remote, 'https://github.com/acme/two.git', 'адрес заменяется, а не дублируется');

  writeFileSync(join(w, 'a.txt'), 'ИЗМЕНЕНО\n');
  rmSync(join(w, 'b.txt'));
  writeFileSync(join(w, 'new.txt'), 'новый\n');
  await git(w, 'mv', 'c.txt', 'c2.txt');
  const files = (await I.changedFiles(w, { env })).files.filter((f) => f.path !== 'inner');
  assert.deepEqual(files.map((f) => [f.path, f.kind]).sort(), [['a.txt', 'modified'], ['b.txt', 'deleted'], ['c2.txt', 'renamed'], ['new.txt', 'new']]);
  const pick = (name) => files.filter((f) => f.path === name);
  await I.discardFiles(w, pick('a.txt'), { env });
  assert.equal(text(join(w, 'a.txt')), 'раз\n', 'изменённый файл вернулся к коммиту');
  assert.ok(existsSync(join(w, 'new.txt')), 'остальные изменения не тронуты');
  await I.discardFiles(w, [...pick('new.txt'), ...pick('b.txt'), ...pick('c2.txt')], { env });
  assert.equal(existsSync(join(w, 'new.txt')), false, 'новый файл удалён');
  assert.equal(text(join(w, 'b.txt')), 'два\n', 'удалённый файл восстановлен');
  assert.ok(existsSync(join(w, 'c.txt')) && !existsSync(join(w, 'c2.txt')), 'переименование отменено');
  assert.equal((await I.changedFiles(w, { env })).total, 0);
  assert.equal(await I.discardFiles(w, [], { env }), 0);
});

test('/git: отмена изменений — с подтверждением, файлы с секретами не трогаются, при работающем агенте — отказ', needGit, async () => {
  await git(home, 'init', '-q', '--bare', '-b', 'main', bareApp);
  await G.cloneRepo(APP_URL, 'app', { cwd: ws, env });
  const proj = join(ws, 'app');
  writeFileSync(join(proj, 'index.html'), '<h1>сайт</h1>\n');
  writeFileSync(join(proj, 'style.css'), 'body{}\n');
  await G.commitAll(proj, 'первый', { env });
  await G.pushRepo(proj, { env });
  S.saveProject(ann, proj);

  writeFileSync(join(proj, 'index.html'), '<h1>ИСПОРЧЕНО</h1>\n');
  writeFileSync(join(proj, 'trash.txt'), 'мусор\n');
  writeFileSync(join(proj, '.env'), 'KEY=1\n');
  await U.onGitCallback(ann, press(ANN, 'gt:ch:0'));
  const list = take().filter((c) => c.method === 'editMessageText');
  assert.ok(buttons(list).some((b) => b.callback_data === 'gt:da' && b.text === '↩️ Отменить все изменения'));
  const cf = (name) => buttons(list).find((b) => b.text.includes(name)).callback_data;
  const idx = (name) => cf(name).split(':')[2];

  // один файл: карточка → вопрос → отмена
  await U.onGitCallback(ann, press(ANN, cf('index.html')));
  assert.ok(buttons(take()).some((b) => b.callback_data === `gt:dx:${idx('index.html')}` && b.text === '↩️ Вернуть как было'));
  await U.onGitCallback(ann, press(ANN, `gt:dx:${idx('index.html')}`));
  assert.match(texts(take()), /Вернуть файл <code>index\.html<\/code> к последнему коммиту\?/);
  assert.match(readFileSync(join(proj, 'index.html'), 'utf8'), /ИСПОРЧЕНО/, 'до подтверждения файл не тронут');
  ann.busy = true;
  await U.onGitCallback(ann, press(ANN, `gt:dX:${idx('index.html')}`));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery'], 'пока агент работает — отказ');
  ann.busy = false;
  await U.onGitCallback(ann, press(ANN, `gt:dX:${idx('index.html')}`));
  assert.match(texts(take()), /Изменения в файле <code>index\.html<\/code> отменены/);
  assert.equal(text(join(proj, 'index.html')), '<h1>сайт</h1>\n');

  // секрет отменой не трогается
  await U.onGitCallback(ann, press(ANN, `gt:dX:${idx('.env')}`));
  assert.ok(existsSync(join(proj, '.env')));
  take();

  // всё сразу: новый файл удаляется, .env остаётся
  writeFileSync(join(proj, 'style.css'), 'body{color:red}\n');
  await U.onGitCallback(ann, press(ANN, 'gt:da'));
  const ask = take();
  assert.match(texts(ask), /Отменить все несохранённые изменения \(файлов: 2\)\?/);
  assert.match(texts(ask), /🆕 trash\.txt/);
  assert.ok(!texts(ask).includes('.env'), 'секреты в списке на отмену не значатся');
  await U.onGitCallback(ann, press(ANN, 'gt:dA'));
  assert.match(texts(take()), /Изменения отменены, файлов: 2/);
  assert.equal(existsSync(join(proj, 'trash.txt')), false);
  assert.equal(text(join(proj, 'style.css')), 'body{}\n');
  assert.equal(readFileSync(join(proj, '.env'), 'utf8'), 'KEY=1\n', 'файл с секретами цел');
  rmSync(join(proj, '.env'));
});

test('/git: агент просит отправить — под ответом кнопка; запрос на слияние из ветки в основную', needGit, async () => {
  const proj = join(ws, 'app');
  await U.offerGitActions(ann, ['push']);
  const offer = take();
  assert.match(texts(offer), /Агент предлагает отправить изменения на сервер/);
  assert.deepEqual(buttons(offer).map((b) => b.callback_data), ['gt:push']);
  await U.offerGitActions(ann, ['pull', 'push']);
  assert.deepEqual(buttons(take()).map((b) => b.callback_data), ['gt:pull', 'gt:push']);

  // на основной ветке запрос на слияние не делается
  await U.handleGit(ann);
  assert.ok(buttons(take()).some((b) => b.callback_data === 'gt:mr' && b.text === '🔀 Запрос на слияние'));
  await U.onGitCallback(ann, press(ANN, 'gt:mr'));
  assert.match(texts(take()), /Вы на основной ветке <code>main<\/code>/);

  await I.createBranch(proj, 'feature/menu', { env });
  writeFileSync(join(proj, 'menu.html'), '<nav></nav>\n');
  await G.commitAll(proj, 'Добавил меню', { env });
  await U.onGitCallback(ann, press(ANN, 'gt:mr'));
  const first = take();
  assert.match(texts(first), /Сначала отправьте изменения ветки <code>feature\/menu<\/code>/);
  assert.ok(buttons(first).some((b) => b.callback_data === 'gt:push'));
  await G.pushRepo(proj, { env });

  await U.onGitCallback(ann, press(ANN, 'gt:mr'));
  const ask = take();
  assert.match(texts(ask), /Запрос на слияние ветки <code>feature\/menu<\/code> в <code>main<\/code>/);
  assert.equal(buttons(ask)[0].text, '«Добавил меню»', 'предложен заголовок — описание последнего коммита');
  assert.equal(ann.pendingInput.kind, 'gitMrTitle');
  apiLog.length = 0;
  assert.equal(await U.onGitInput(ann, 'Меню сайта\nподробности'), true);
  const done = take();
  assert.match(texts(done), /Запрос на слияние №7 создан: <code>feature\/menu<\/code> → <code>main<\/code>/);
  assert.equal(buttons(done)[0].url, 'https://github.com/acme/app/pull/7');
  assert.deepEqual(apiLog.at(-1), ['POST', '/repos/acme/app/pulls', { title: 'Меню сайта', head: 'feature/menu', base: 'main' }]);

  // повторно — находит открытый; без прав у токена — подсказка про api
  await U.onGitCallback(ann, press(ANN, 'gt:mr'));
  await U.onGitCallback(ann, press(ANN, 'gt:mrgo'));
  assert.match(texts(take()), /уже открыт \(№7\)/);
  gh.pulls = [];
  gh.forbid = true;
  await U.onGitCallback(ann, press(ANN, 'gt:mr'));
  await U.onGitCallback(ann, press(ANN, 'gt:mrgo'));
  assert.match(texts(take()), /токену не хватает прав для этого действия[\s\S]*права?м? api|правом api/);
  gh.forbid = false;
});

test('/git: публикация проекта — место, видимость, название; первый коммит без секретов', needGit, async () => {
  await git(home, 'init', '-q', '--bare', '-b', 'main', bareNew);
  const proj = join(ws, 'Мой сайт');
  mkdirSync(proj);
  S.saveProject(ann, proj);
  await U.handleGit(ann);
  const view = take();
  assert.match(texts(view), /не связан с Git/);
  assert.ok(buttons(view).some((b) => b.callback_data === 'gt:pb' && b.text === '🚀 Опубликовать проект'));

  // куда: личное пространство и организации
  await U.onGitCallback(ann, press(ANN, 'gt:pb'));
  const where = take().filter((c) => c.method === 'editMessageText');
  assert.deepEqual(buttons(where).filter((b) => b.callback_data.startsWith('gt:pbn:')).map((b) => b.text), ['👤 ann-dev — личное пространство', '👥 acme', '👥 other-team']);
  await U.onGitCallback(ann, press(ANN, 'gt:pbs'));
  assert.equal(ann.pendingInput.kind, 'gitNsSearch');
  take();
  assert.equal(await U.onGitInput(ann, 'acm'), true);
  const found = take();
  assert.deepEqual(buttons(found).filter((b) => b.callback_data.startsWith('gt:pbn:')).map((b) => b.text), ['👥 acme']);
  await U.onGitCallback(ann, press(ANN, buttons(found).find((b) => b.text === '👥 acme').callback_data));
  await U.onGitCallback(ann, press(ANN, 'gt:pbn:zzz'));
  assert.deepEqual(sent.at(-1).method, 'answerCallbackQuery', 'устаревшая кнопка места — отказ');
  sent.pop();
  const vis = take();
  assert.match(texts(vis), /будет создан в <code>acme<\/code>/);
  assert.deepEqual(buttons(vis).filter((b) => b.callback_data.startsWith('gt:pbv:')).map((b) => b.callback_data), ['gt:pbv:private', 'gt:pbv:public'], 'у GitHub внутренней видимости нет');

  // название папки кириллицей в адрес не годится — бот просит другое
  await U.onGitCallback(ann, press(ANN, 'gt:pbv:private'));
  const summary = take();
  assert.match(texts(summary), /Адрес: <code>—<\/code>/);
  assert.ok(!buttons(summary).some((b) => b.callback_data === 'gt:pbgo'), 'без названия создавать нечего');
  await U.onGitCallback(ann, press(ANN, 'gt:pbname'));
  take();
  assert.equal(await U.onGitInput(ann, 'Только кириллица'), true);
  assert.match(texts(take()), /Нужно название латиницей/);
  assert.equal(ann.pendingInput.kind, 'gitRepoName');
  assert.equal(await U.onGitInput(ann, 'newproj'), true);
  const ready = take();
  assert.match(texts(ready), /Адрес: <code>github\.com\/acme\/newproj<\/code>\nВидимость: 🔒 Закрытый/);
  assert.ok(buttons(ready).some((b) => b.callback_data === 'gt:pbgo'));

  // пустая папка: репозиторий на сервере не создаётся
  apiLog.length = 0;
  await U.onGitCallback(ann, press(ANN, 'gt:pbgo'));
  assert.match(texts(take()), /нет файлов для публикации — репозиторий не создан/);
  assert.ok(!apiLog.some(([m]) => m === 'POST'));

  writeFileSync(join(proj, 'index.html'), '<h1>привет</h1>\n');
  writeFileSync(join(proj, '.env'), 'TOKEN=sekret\n');
  await U.onGitCallback(ann, press(ANN, 'gt:pbgo'));
  const done = take();
  assert.match(texts(done), /Проект опубликован: <code>github\.com\/acme\/newproj<\/code>/);
  assert.match(texts(done), /в коммит не вошли и добавлены в \.gitignore: \.env/);
  assert.ok(buttons(done).some((b) => b.url === 'https://github.com/acme/newproj'));
  assert.deepEqual(apiLog.find(([m]) => m === 'POST'), ['POST', '/orgs/acme/repos', { name: 'newproj', private: true, auto_init: false }]);
  const onServer = (await G.runGit(['--git-dir', bareNew, 'log', '-1', '--format=%an|%s', '--name-only', 'main'], { cwd: home, env })).trim().split('\n').filter(Boolean);
  assert.equal(onServer[0], 'Ann Dev|Первый коммит');
  assert.deepEqual(onServer.slice(1).sort(), ['.gitignore', 'index.html'], 'секреты на сервер не ушли');
  const st = await G.repoState(proj, { env });
  assert.deepEqual([st.remote, st.branch, st.upstream, st.ahead], [NEW_URL, 'main', 'origin/main', 0]);
  assert.ok(!readFileSync(join(proj, '.git', 'config'), 'utf8').includes(TOKEN));
  // опубликованный проект второй раз не публикуется
  await U.handleGit(ann);
  assert.ok(!buttons(take()).some((b) => b.callback_data === 'gt:pb'));
  await U.onGitCallback(ann, press(ANN, 'gt:pb'));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery']);
});

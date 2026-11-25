// Git (/git): сервисы и их API, команды git на настоящих локальных репозиториях, окружение и подсказка агенту,
// сценарии экрана. Сеть не нужна: API сервисов и Telegram подменены, а адрес https://github.com/acme/app.git
// подставляется на локальный репозиторий настройкой git url.<путь>.insteadOf.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const hasGit = spawnSync('git', ['--version']).status === 0;
const needGit = { skip: hasGit ? false : 'git не установлен' };

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-git-')));
const root = join(home, 'projects');
const bare = join(home, 'remote', 'app.git').replace(/\\/g, '/');
const REPO_URL = 'https://github.com/acme/app.git';
mkdirSync(root);
mkdirSync(join(home, 'remote'));
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.USER_WORKSPACES = '1';
process.env.GITLAB_URL = 'https://git.example.com/';
delete process.env.GITLAB_NAME;
delete process.env.GIT_AGENT_AUTH;
delete process.env.AGENT_SANDBOX;
delete process.env.GIT_COMMAND;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';
// «сервер»: адрес репозитория на GitHub ведёт в локальный репозиторий
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
  GIT_CONFIG_VALUE_0: REPO_URL,
  GIT_CONFIG_KEY_1: 'protocol.file.allow',
  GIT_CONFIG_VALUE_1: 'always',
});

const TOKEN = 'ghp_test0123456789secretTOKEN';
const sent = [];
const apiCalls = [];
const realFetch = globalThis.fetch;
const json = (data, headers = {}) => ({ ok: true, status: 200, json: async () => data, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.github.com')) {
    apiCalls.push(u);
    if (init.headers?.authorization !== `Bearer ${TOKEN}`) return { ok: false, status: 401, json: async () => ({}), headers: { get: () => null } };
    if (u.endsWith('/user')) return json({ login: 'ann-dev', name: 'Ann Dev', email: null, id: 42 }, { 'x-oauth-scopes': 'repo, workflow', 'github-authentication-token-expiration': '2027-03-01 00:00:00 UTC' });
    return json([{ full_name: 'acme/app', clone_url: REPO_URL, private: true }, { full_name: 'evil/x', clone_url: 'https://evil.example/x.git', private: false }]);
  }
  // свои серверы: настоящий GitLab без токена отвечает отказом 401 в JSON, посторонний сайт — страницей
  if (u.startsWith('https://git.mycorp.io/')) return { ok: false, status: 401, json: async () => ({ message: '401 Unauthorized' }), headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) } };
  if (u.startsWith('https://nothing.mycorp.io/')) return { ok: false, status: 404, json: async () => ({}), headers: { get: () => 'text/html' } };
  const method = u.split('/').pop();
  // отправка файла идёт формой, а не JSON: тело не разбираем
  sent.push({ method, body: typeof init.body === 'string' ? JSON.parse(init.body) : {} });
  return { json: async () => ({ ok: true, result: { message_id: 500 + sent.length } }) };
};
const take = () => sent.splice(0);
const texts = (calls) => calls.map((c) => c.body.text ?? '').join('\n');
const buttons = (calls) => calls.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();
const press = (id, data) => ({ id: 'cb', data, message: { chat: { id }, message_id: 5 } });

const ctx = await import('../src/ctx.mjs');
const H = await import('../src/gitHosts.mjs');
const G = await import('../src/git.mjs');
const A = await import('../src/gitAccess.mjs');
const S = await import('../src/state.mjs');
const U = await import('../src/gitUi.mjs');
const RA = await import('../src/gitRepoAction.mjs');
G.setGitAvailable(hasGit);
const CORP = 'gitlab-git-example-com'; // id своего GitLab из GITLAB_URL: вид и адрес

const ADMIN = ctx.ADMIN_ID;
const [ANN, BOB] = [4001, 4002].map((id) => (id === ADMIN ? id + 100 : id));
for (const id of [ANN, BOB, ADMIN]) ctx.setLang(id, 'ru');
ctx.db.upsertUser({ user_id: ANN, username: 'ann', level: 'normal', added_by: ADMIN });
ctx.db.upsertUser({ user_id: BOB, username: 'bob', level: 'normal', added_by: ADMIN });
S.topicsSupport.enabled = false;
const ann = S.getState(ANN, ANN);
const bob = S.getState(BOB, BOB);
const ws = S.rootOf(ANN);
const env = G.gitEnv({ identity: { name: 'Сервер', email: 'server@example.com' } });
const git = (cwd, ...args) => G.runGit(args, { cwd, env });

async function freshRepo(userId) {
  ctx.setLang(userId, 'ru');
  ctx.db.upsertUser({ user_id: userId, username: `u${userId}`, level: 'normal', added_by: ADMIN });
  ctx.db.saveGitAccount(userId, { host: 'github', login: `dev${userId}`, name: 'Dev', email: `${userId}@example.com`, token: TOKEN });
  const root = S.rootOf(userId);
  mkdirSync(root, { recursive: true });
  const project = join(root, 'app');
  await git(root, 'clone', '-q', REPO_URL, 'app');
  const st = S.getState(userId, userId);
  st.project = project;
  const edits = [];
  const acks = [];
  const view = async () => ({ text: 'экран', markup: { inline_keyboard: [] } });
  const edit = async (payload) => { edits.push(payload); return payload; };
  const ack = async (text) => { acks.push(text); };
  return { st, project, edits, acks, view, edit, ack };
}

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows не всегда сразу отпускает папку, в которой только что работал git: уборка временной папки — не предмет теста */
  }
});

test('сервисы: GitHub, GitLab.com и свой GitLab из GITLAB_URL; адрес репозитория → сервис', () => {
  const hosts = H.gitHosts();
  assert.deepEqual(hosts.map((h) => [h.id, h.kind, h.label, h.web]), [
    ['github', 'github', 'GitHub', 'https://github.com'],
    ['gitlab', 'gitlab', 'GitLab.com', 'https://gitlab.com'],
    [CORP, 'gitlab', 'git.example.com', 'https://git.example.com'],
  ]);
  assert.deepEqual(H.gitHosts({}).map((h) => h.id), ['github', 'gitlab'], 'без настроек — только общие сервисы');
  assert.equal(H.gitHosts({ GITLAB_URL: 'https://git.x.io', GITLAB_NAME: 'Наш GitLab' })[2].label, 'Наш GitLab');
  for (const bad of ['', 'http://git.x.io', 'git.x.io', 'https://gitlab.com/', 'https://user:pw@git.x.io', 'https://localhost']) assert.equal(H.gitHosts({ GITLAB_URL: bad }).length, 2, bad);
  // свой GitHub (GitHub Enterprise) и серверы, добавленные администратором; один адрес дважды не попадает
  const all = H.gitHosts({ GITLAB_URL: 'https://Git.X.io/', GITHUB_URL: 'https://ghe.x.io' }, [{ kind: 'gitlab', url: 'https://git.x.io' }, { kind: 'gitlab', url: 'https://lab.x.io/gitlab/', name: 'Лаба' }, { kind: 'svn', url: 'https://s.x.io' }]);
  assert.deepEqual(all.slice(2).map((h) => [h.id, h.label, h.api, Boolean(h.fromEnv)]), [
    ['gitlab-git-x-io', 'git.x.io', 'https://git.x.io/api/v4', true],
    ['github-ghe-x-io', 'ghe.x.io', 'https://ghe.x.io/api/v3', true],
    ['gitlab-lab-x-io-gitlab', 'Лаба', 'https://lab.x.io/gitlab/api/v4', false],
  ]);
  assert.equal(all[3].tokenUrl, 'https://ghe.x.io/settings/tokens');
  assert.equal(H.customHost('github', 'https://github.com'), null, 'общие сервисы своими не добавляются');
  assert.equal(H.hostOfUrl('https://lab.x.io/gitlab/team/app.git', all).id, 'gitlab-lab-x-io-gitlab');
  assert.equal(H.hostOfUrl('https://github.com/acme/app.git').id, 'github');
  assert.equal(H.hostOfUrl('HTTPS://git.example.com/team/app').id, CORP);
  for (const foreign of ['https://github.com.evil.io/a/b', 'git@github.com:acme/app.git', 'https://evil.example/x.git', null]) assert.equal(H.hostOfUrl(foreign), null, String(foreign));
  assert.equal(H.showRemote('https://oauth2:tok@git.example.com/team/app.git'), 'git.example.com/team/app', 'вход в адресе не показывается');
  assert.equal(H.repoFolder('https://git.example.com/team/sub/my-app.git'), 'my-app');
  // вход — заголовком только для адресов своего сервиса
  const [[key, value]] = H.authConfig(hosts[2], 'tok123');
  assert.equal(key, 'http.https://git.example.com/.extraheader');
  assert.equal(Buffer.from(value.split(' ').pop(), 'base64').toString(), 'oauth2:tok123');
  assert.equal(Buffer.from(H.authConfig(hosts[0], 't')[0][1].split(' ').pop(), 'base64').toString(), 'x-access-token:t');
});

test('API сервисов: профиль, права и срок токена, список репозиториев, отказ по неверному токену', async () => {
  const [github, , corp] = H.gitHosts();
  const gh = await H.fetchProfile(github, TOKEN);
  assert.deepEqual(gh, { login: 'ann-dev', name: 'Ann Dev', email: '42+ann-dev@users.noreply.github.com', expiresAt: '2027-03-01T00:00:00.000Z', scopes: ['repo', 'workflow'] });
  await assert.rejects(H.fetchProfile(github, 'wrong-token-000'), (e) => e instanceof H.HostError && e.code === 'auth');
  assert.deepEqual(H.missingScopes(github, ['repo']), []);
  assert.deepEqual(H.missingScopes(github, ['gist']), ['repo']);
  assert.deepEqual(H.missingScopes(github, []), [], 'у токенов с точечными правами список пуст — не предупреждаем');
  assert.deepEqual(H.missingScopes(corp, ['read_api', 'read_repository', 'write_repository']), ['api'], 'без api нельзя создать репозиторий и запрос на слияние');
  assert.match(corp.scopes, /^api, /, 'бот сразу просит полный набор прав');
  assert.deepEqual(H.missingScopes(corp, ['api']), []);
  assert.deepEqual(H.missingScopes(corp, null), [], 'права неизвестны — не предупреждаем');

  // GitLab: свой формат ответов и поиск на стороне сервера
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.authorization]);
    if (url.endsWith('/user')) return json({ username: 'bob', name: 'Bob', commit_email: 'bob@corp.io' });
    if (url.includes('/personal_access_tokens/self')) return json({ expires_at: '2027-01-31', scopes: ['api'] });
    return json([{ path_with_namespace: 'team/site', http_url_to_repo: 'https://git.example.com/team/site.git', visibility: 'private' }], { 'x-next-page': '' });
  };
  assert.deepEqual(await H.fetchProfile(corp, 'glpat', { fetchImpl }), { login: 'bob', name: 'Bob', email: 'bob@corp.io', expiresAt: '2027-01-31T00:00:00.000Z', scopes: ['api'] });
  const list = await H.listRepos(corp, 'glpat', { search: 'Site', page: 1, fetchImpl });
  assert.deepEqual(list, { items: [{ name: 'team/site', url: 'https://git.example.com/team/site.git', private: true }], more: false });
  assert.match(seen.at(-1)[0], /^https:\/\/git\.example\.com\/api\/v4\/projects\?membership=true.*&page=2&search=site$/);
  assert.ok(seen.every(([, auth]) => auth === 'Bearer glpat'));
});

test('окружение git бота: без токена бота, без хуков и помощников входа; настройки — через окружение', () => {
  const e = G.gitEnv({ identity: { name: 'Ann', email: 'a@x.io' }, auth: [['http.https://h/.extraheader', 'Authorization: Basic xx']], base: { PATH: '/bin', TELEGRAM_BOT_TOKEN: 'bot', OPENROUTER_API_KEY: 'k' } });
  assert.equal('TELEGRAM_BOT_TOKEN' in e || 'OPENROUTER_API_KEY' in e, false);
  assert.equal(e.GIT_TERMINAL_PROMPT, '0');
  assert.equal(e.GIT_AUTHOR_NAME, 'Ann');
  assert.equal(e.GIT_COMMITTER_EMAIL, 'a@x.io');
  const cfg = Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]));
  assert.equal(cfg['core.fsmonitor'], 'false');
  assert.equal(cfg['credential.helper'], '');
  assert.ok('core.hooksPath' in cfg);
  assert.equal(cfg['http.https://h/.extraheader'], 'Authorization: Basic xx');
  assert.deepEqual(G.configEnv([['a.b', '1']], { GIT_CONFIG_COUNT: '2' }), { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'a.b', GIT_CONFIG_VALUE_2: '1' }, 'добавляется к уже заданным');
  assert.deepEqual(G.parseStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 1 1 1 a a f.txt\n? new.txt\n'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changed: 2 });
  assert.equal(G.parseStatus('# branch.head (detached)\n').branch, null);
});

test('git: клонирование, коммит без секретов, отправка, получение — на настоящих репозиториях', needGit, async () => {
  await git(home, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(home, 'seed');
  await G.cloneRepo(bare, 'seed', { cwd: home, env });
  writeFileSync(join(seed, 'README.md'), '# app\n');
  assert.deepEqual(await G.commitAll(seed, 'начало', { env }), { committed: true, skipped: [], tracked: [], ignoreWarning: false });
  await G.pushRepo(seed, { env });

  const work = join(home, 'work');
  await G.cloneRepo(REPO_URL, 'work', { cwd: home, env }); // по адресу GitHub — в локальный репозиторий
  const st = await G.repoState(work, { env });
  assert.equal(st.remote, REPO_URL, 'адрес — как записан в репозитории, без подстановки');
  assert.deepEqual([st.branch, st.upstream, st.ahead, st.changed], ['main', 'origin/main', 0, 0]);
  assert.equal(await G.repoState(home, { env }), null, 'не репозиторий');

  // хук репозитория, который запретил бы коммит, ботом не выполняется
  mkdirSync(join(work, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(work, 'app.js'), 'x');
  writeFileSync(join(work, '.env'), 'TOKEN=1');
  mkdirSync(join(work, 'conf'));
  writeFileSync(join(work, 'conf', 'id_rsa'), 'key');
  const r = await G.commitAll(work, 'работа "с кавычками" & знаками; $(echo x)', { env });
  assert.deepEqual(r, { committed: true, skipped: ['.env', 'conf/id_rsa'], tracked: [], ignoreWarning: false });
  assert.deepEqual(readFileSync(join(work, '.gitignore'), 'utf8').split('\n').filter(Boolean), ['/.env', '/conf/id_rsa']);
  assert.equal((await git(work, 'log', '-1', '--format=%s')).trim(), 'работа "с кавычками" & знаками; $(echo x)', 'описание передано как есть, без оболочки');
  assert.deepEqual((await git(work, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort(), ['.gitignore', 'app.js']);
  assert.deepEqual(await G.unpushedSecrets(work, { env }), []);
  await G.pushRepo(work, { env });
  assert.equal((await G.repoState(work, { env })).ahead, 0);
  assert.deepEqual(await G.commitAll(work, 'пусто', { env }), { committed: false, skipped: [], tracked: [], ignoreWarning: false }, 'нечего коммитить');

  // секрет, закоммиченный в обход (так мог сделать агент), виден до отправки
  await git(work, 'add', '-f', '.env');
  await git(work, 'commit', '-q', '-m', 'секрет');
  assert.deepEqual(await G.unpushedSecrets(work, { env }), ['.env']);
  writeFileSync(join(work, '.env'), 'TOKEN=2');
  assert.deepEqual((await G.commitAll(work, 'ещё', { env })).tracked, ['.env'], 'изменения секрета, уже лежащего в репозитории, в коммит не идут');
  await git(work, 'reset', '-q', '--hard', 'origin/main');

  // .gitignore-ссылка не перезаписывается: секрет остаётся вне коммита, но сообщение об ignoreWarnings не лжёт
  const linked = join(home, 'linked');
  mkdirSync(linked, { recursive: true });
  await git(linked, 'init', '-q', '-b', 'main');
  const outsideIgnore = join(home, 'outside.gitignore');
  writeFileSync(outsideIgnore, 'SAFE\n');
  try {
    symlinkSync(outsideIgnore, join(linked, '.gitignore'));
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
  }
  writeFileSync(join(linked, '.env'), 'TOKEN=3');
  writeFileSync(join(linked, 'app.js'), 'x');
  const linkedResult = await G.commitAll(linked, 'ссылка', { env });
  if (existsSync(join(linked, '.gitignore')) && readFileSync(join(linked, '.gitignore'), 'utf8') === 'SAFE\n') {
    assert.equal(linkedResult.ignoreWarning, true);
    assert.deepEqual(linkedResult.skipped, [], 'в .gitignore ничего не записано');
    assert.deepEqual((await git(linked, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort(), ['app.js'], 'секрет в коммит не вошёл');
    assert.equal(readFileSync(outsideIgnore, 'utf8'), 'SAFE\n');
  }

  // получение: новое на сервере → перемотка; разошлись → слияние не делается
  await git(seed, 'pull', '-q', '--ff-only');
  writeFileSync(join(seed, 'server.txt'), '1');
  await G.commitAll(seed, 'с сервера', { env });
  await G.pushRepo(seed, { env });
  assert.equal(await G.pullRepo(work, { env }), 'updated');
  assert.ok(existsSync(join(work, 'server.txt')));
  assert.equal(await G.pullRepo(work, { env }), 'uptodate');
  writeFileSync(join(seed, 'server2.txt'), '2');
  await G.commitAll(seed, 'ещё с сервера', { env });
  await G.pushRepo(seed, { env });
  writeFileSync(join(work, 'mine.txt'), '3');
  await G.commitAll(work, 'моё', { env });
  assert.equal(await G.pullRepo(work, { env }), 'diverged');
  await assert.rejects(G.pushRepo(work, { env }), (e) => e instanceof G.GitError && e.i18n?.key === 'err.gitExit' && /rejected|fetch first/.test(`${e.message} ${e.stderr}`));
  // строки из hide не попадают в текст ошибки
  await assert.rejects(G.runGit(['clone', 'https://sekret-tok@invalid.invalid/x.git'], { cwd: home, env, hide: ['sekret-tok'], timeoutMs: 30_000 }), (e) => !`${e.message}${e.stderr}`.includes('sekret-tok'));
  await assert.rejects(G.runGit(['-C', home, 'rev-parse', '--verify', 'no-such-ref'], { cwd: home, env }), (e) => e instanceof G.GitError && e.i18n?.key === 'err.gitExit' && e.i18n.vars.cmd === '-C' && Number.isInteger(e.i18n.vars.code));
});

test('агент: автор коммитов — из аккаунта; вход передаётся агенту только в режиме GIT_AGENT_AUTH', () => {
  assert.deepEqual(A.agentGitEnv(BOB), {}, 'без аккаунта окружение агента не меняется');
  ctx.db.saveGitAccount(BOB, { host: CORP, login: 'bob', name: 'Bob B', email: 'bob@corp.io', token: 'glpat-bob-token' });
  // автор — настройкой git по умолчанию (уступает явному -c и GIT_AUTHOR_*), нумерация — после уже заданных в окружении
  assert.deepEqual(A.agentGitEnv(BOB, { base: {} }), { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Bob B', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'bob@corp.io' });
  assert.deepEqual(A.agentGitEnv(BOB, { base: { GIT_CONFIG_COUNT: '3' } }).GIT_CONFIG_KEY_3, 'user.name');
  assert.ok(!JSON.stringify(A.agentGitEnv(BOB)).includes('glpat') && !('GIT_AUTHOR_NAME' in A.agentGitEnv(BOB)), 'по умолчанию токена в окружении агента нет');
  const withAuth = A.agentGitEnv(BOB, { agentAuth: true, base: {} });
  assert.equal(withAuth.GIT_CONFIG_COUNT, '3');
  assert.equal(withAuth.GIT_CONFIG_KEY_2, 'http.https://git.example.com/.extraheader');
  assert.equal(Buffer.from(withAuth.GIT_CONFIG_VALUE_2.split(' ').pop(), 'base64').toString(), 'oauth2:glpat-bob-token');
  assert.equal(withAuth.GIT_TERMINAL_PROMPT, '0');
  assert.equal(A.GIT_AGENT_AUTH, false, 'режим выключен, пока администратор его не включил');

  G.setGitAvailable(true);
  assert.match(A.gitNote(BOB), /no credentials for the remote/);
  assert.match(A.gitNote(BOB), /put \[\[git:push\]\] or \[\[git:pull\]\] on its own line/, 'отправку агент просит меткой — кнопку показывает бот');
  assert.match(A.gitNote(BOB, { agentAuth: true }), /Never print, echo or store these credentials/);
  assert.match(A.gitNote(ANN, { agentAuth: true }), /no credentials/, 'без аккаунта входа нет и в режиме GIT_AGENT_AUTH');
  G.setGitAvailable(false);
  assert.equal(A.gitNote(BOB), null, 'нет git — нет и подсказки');
  G.setGitAvailable(hasGit);
  ctx.db.deleteGitAccount(BOB, CORP);
});

test('/git: подключение аккаунта — токен не уходит агенту, не повторяется ботом, сообщение удаляется', needGit, async () => {
  await U.handleGit(ann);
  const screen = take();
  assert.match(texts(screen), /Аккаунты не подключены/);
  assert.deepEqual(buttons(screen).filter((b) => b.callback_data.startsWith('gt:c:')).map((b) => b.text), ['➕ Подключить GitHub', '➕ Подключить GitLab.com', '➕ Подключить git.example.com']);
  assert.ok(!buttons(screen).some((b) => b.callback_data === 'gt:cl'), 'без аккаунта клонировать нечего');

  assert.equal(await U.onGitInput(ann, 'обычный запрос'), false);
  await U.onGitCallback(ann, press(ANN, 'gt:c:github'));
  assert.equal(ann.pendingInput.kind, 'gitToken');
  assert.match(texts(take()), /github\.com\/settings\/tokens/);

  assert.equal(await U.onGitInput(ann, 'это не токен', { messageId: 60 }), true);
  let calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 60), 'любое сообщение в ожидании токена удаляется');
  assert.equal(await U.onGitInput(ann, 'ghp_wrongwrongwrong000', { messageId: 61 }), true);
  assert.match(texts(take()), /не принял токен/);
  assert.equal(ann.pendingInput.kind, 'gitToken', 'можно прислать ещё раз');

  assert.equal(await U.onGitInput(ann, `  ${TOKEN} `, { messageId: 62 }), true);
  calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 62));
  assert.match(texts(calls), /GitHub подключён: ann-dev \(Ann Dev\)/);
  assert.match(texts(calls), /Токен действует до 01[./]03[./]2027/);
  assert.ok(!JSON.stringify(calls).includes(TOKEN), 'токен не повторяется в сообщениях бота');
  assert.equal(ctx.db.getGitAccount(ANN, 'github').token, TOKEN);
  assert.equal(ctx.db.getGitAccount(BOB, 'github'), null, 'аккаунт — только у подключившего');
  assert.equal(ann.pendingInput, null);

  // запоздавший токен не превращается в запрос агенту
  ann.pendingInput = { kind: 'gitToken', host: 'gitlab', at: Date.now() - U.GIT_WAIT_MS - 1 };
  assert.equal(await U.onGitInput(ann, 'glpat-late-token-000', { messageId: 63 }), true);
  calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 63));
  assert.match(texts(calls), /Ожидание токена закончилось/);
  assert.equal(ctx.db.getGitAccount(ANN, 'gitlab'), null);
});

test('/git: клонирование кнопкой, «Сохранить и отправить» без секретов, «Получить», предупреждение о секретах', needGit, async () => {
  await U.handleGit(ann);
  assert.ok(buttons(take()).some((b) => b.callback_data === 'gt:cl'));
  await U.onGitCallback(ann, press(ANN, 'gt:cl'));
  const list = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(list), /Репозитории GitHub\. Выберите, какой клонировать в <code>Моё пространство<\/code>/);
  assert.deepEqual(buttons(list).filter((b) => b.callback_data.startsWith('gt:k:')).map((b) => b.text), ['🔒 acme/app', '📂 evil/x']);

  const repoBtn = (name) => buttons(list).find((b) => b.text.endsWith(name)).callback_data;
  await U.onGitCallback(ann, press(ANN, repoBtn('evil/x'))); // адрес не своего сервиса: токен туда не понесём
  assert.equal(existsSync(join(ws, 'x')), false);
  take();
  await U.onGitCallback(ann, press(ANN, repoBtn('acme/app')));
  const cloned = take();
  assert.match(texts(cloned), /Репозиторий <code>acme\/app<\/code> клонирован в <code>app<\/code>/);
  const proj = join(ws, 'app');
  assert.ok(existsSync(join(proj, '.git')) && existsSync(join(proj, 'README.md')));
  assert.equal(ann.project, proj, 'клон выбран проектом');
  assert.ok(!readFileSync(join(proj, '.git', 'config'), 'utf8').includes(TOKEN), 'токена в настройках репозитория нет');
  await U.onGitCallback(ann, press(ANN, repoBtn('acme/app')));
  assert.match(texts(take()), /Папка <code>app<\/code> уже есть/);

  // сохранить и отправить: описание следующим сообщением, .env в коммит не идёт
  writeFileSync(join(proj, 'page.html'), '<p>hi</p>');
  writeFileSync(join(proj, '.env.local'), 'KEY=1'); // «/.env» уже в .gitignore репозитория — берём другой файл с секретами
  await U.handleGit(ann);
  const view = take();
  assert.match(texts(view), /Ветка: main\nИзменено файлов: 2/);
  assert.match(texts(view), /Сервер: <code>github\.com\/acme\/app<\/code>/);
  await U.onGitCallback(ann, press(ANN, 'gt:save'));
  assert.equal(ann.pendingInput.kind, 'gitMessage');
  take();
  assert.equal(await U.onGitInput(ann, 'Добавил страницу\nвторая строка'), true);
  const saved = take();
  assert.match(texts(saved), /Изменения сохранены и отправлены/);
  assert.match(texts(saved), /в коммит не вошли и добавлены в \.gitignore: \.env\.local/);
  const onServer = (await G.runGit(['--git-dir', bare, 'log', '-1', '--format=%an|%ae|%s', '--name-only', 'main'], { cwd: home, env })).trim().split('\n').filter(Boolean);
  assert.equal(onServer[0], 'Ann Dev|42+ann-dev@users.noreply.github.com|Добавил страницу', 'автор — владелец аккаунта, описание — первая строка');
  assert.deepEqual(onServer.slice(1).sort(), ['.gitignore', 'page.html']);

  // получить: новое с сервера
  const seed = join(home, 'seed');
  await git(seed, 'pull', '-q', '--ff-only');
  writeFileSync(join(seed, 'from-server.txt'), 's');
  await G.commitAll(seed, 'с сервера', { env });
  await G.pushRepo(seed, { env });
  await U.handleGit(ann); // экран сам сверяется с сервером: новое видно до нажатия «Получить»
  assert.match(texts(take()), /новых на сервере: 1/);
  await U.onGitCallback(ann, press(ANN, 'gt:pull'));
  assert.match(texts(take()), /Изменения получены/);
  assert.ok(existsSync(join(proj, 'from-server.txt')));

  // секрет, закоммиченный агентом: отправка только после явного согласия
  await git(proj, 'add', '-f', '.env.local');
  await G.runGit(['commit', '-q', '-m', 'агент добавил секреты'], { cwd: proj, env });
  await U.onGitCallback(ann, press(ANN, 'gt:push'));
  const warn = take();
  assert.match(texts(warn), /есть файлы с секретами:\n\.env\.local/);
  assert.ok(buttons(warn).some((b) => b.callback_data === 'gt:pushf'));
  assert.equal((await G.repoState(proj, { env })).ahead, 1, 'не отправлено');
  // пока агент выполняет запрос, операции git не запускаются
  ann.busy = true;
  await U.onGitCallback(ann, press(ANN, 'gt:pushf'));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery']);
  ann.busy = false;
});

test('/git: у другого сотрудника — свои аккаунты и свой проект; отключение удаляет токен', needGit, async () => {
  await U.handleGit(bob);
  const view = take();
  assert.match(texts(view), /не связан с Git/);
  assert.match(texts(view), /Аккаунты не подключены/);
  await U.onGitCallback(bob, press(BOB, 'gt:pull'));
  assert.ok(!texts(take()).includes('Получаю'), 'в чужом репозитории ничего не выполняется');
  await U.onGitCallback(bob, press(BOB, 'gt:cl'));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery'], 'без аккаунта клонирование недоступно');

  await U.onGitCallback(ann, press(ANN, 'gt:a:github'));
  assert.match(texts(take()), /Аккаунт: ann-dev \(Ann Dev\)\nПочта для коммитов: <code>42\+ann-dev@users\.noreply\.github\.com<\/code>/);
  await U.onGitCallback(ann, press(ANN, 'gt:d:github'));
  assert.match(texts(take()), /Отключить GitHub \(ann-dev\)\?/);
  await U.onGitCallback(ann, press(ANN, 'gt:D:github'));
  assert.equal(ctx.db.getGitAccount(ANN, 'github'), null);
  take();
});

test('/git: свои серверы добавляет администратор прямо в меню; сотруднику это недоступно', needGit, async () => {
  const admin = S.getState(ADMIN, ADMIN);
  await U.handleGit(admin);
  assert.ok(buttons(take()).some((b) => b.callback_data === 'gt:h' && b.text === '⚙️ Свои серверы'));
  await U.handleGit(ann);
  assert.ok(!buttons(take()).some((b) => b.callback_data === 'gt:h'), 'сотруднику кнопки нет');
  for (const data of ['gt:h', 'gt:ha:gitlab', `gt:hD:${CORP}`]) {
    await U.onGitCallback(ann, press(ANN, data));
    assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery'], `${data}: сотруднику — отказ`);
  }
  assert.equal(ann.pendingInput ?? null, null);

  await U.onGitCallback(admin, press(ADMIN, 'gt:h'));
  const list = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(list), /git\.example\.com — https:\/\/git\.example\.com \(GitLab\) — задан в настройках/);
  assert.ok(!buttons(list).some((b) => b.callback_data.startsWith('gt:hd:')), 'сервер из настроек отсюда не убирается');

  await U.onGitCallback(admin, press(ADMIN, 'gt:ha:gitlab'));
  assert.equal(admin.pendingInput.kind, 'gitHostUrl');
  take();
  assert.equal(await U.onGitInput(admin, 'http://git.mycorp.io'), true);
  assert.match(texts(take()), /только https/);
  assert.equal(await U.onGitInput(admin, 'https://nothing.mycorp.io'), true);
  assert.match(texts(take()), /не отвечает GitLab \(HTTP 404\)/);
  assert.equal(admin.pendingInput.kind, 'gitHostUrl', 'после неподходящего адреса бот ждёт другой');
  assert.equal(await U.onGitInput(admin, ' https://git.mycorp.io/ '), true);
  const OWN = 'gitlab-git-mycorp-io';
  assert.match(texts(take()), /Сервер git\.mycorp\.io добавлен/);
  assert.deepEqual(A.findHost(OWN).api, 'https://git.mycorp.io/api/v4');
  assert.equal(A.hostFor('https://git.mycorp.io/team/app.git').id, OWN);
  await U.handleGit(ann);
  assert.ok(buttons(take()).some((b) => b.text === '➕ Подключить git.mycorp.io'), 'сервер сразу доступен сотрудникам');

  // повтор того же адреса и название для кнопок
  await U.onGitCallback(admin, press(ADMIN, 'gt:ha:gitlab'));
  await U.onGitInput(admin, 'https://git.mycorp.io');
  assert.match(texts(take()), /уже есть в списке/);
  await U.onGitCallback(admin, press(ADMIN, `gt:hn:${OWN}`));
  assert.equal(await U.onGitInput(admin, 'Наш GitLab'), true);
  assert.equal(A.findHost(OWN).label, 'Наш GitLab');
  take();

  // удаление сервера отключает подключённые к нему аккаунты
  ctx.db.saveGitAccount(BOB, { host: OWN, login: 'bob', name: 'Bob', email: 'b@mycorp.io', token: 'glpat-bob-own-token' });
  await U.onGitCallback(admin, press(ADMIN, `gt:hd:${OWN}`));
  assert.match(texts(take()), /Убрать сервер Наш GitLab\?/);
  assert.ok(A.findHost(OWN), 'до подтверждения сервер на месте');
  await U.onGitCallback(admin, press(ADMIN, `gt:hD:${OWN}`));
  assert.match(texts(take()), /Сервер Наш GitLab убран, отключено аккаунтов: 1/);
  assert.equal(A.findHost(OWN), null);
  assert.equal(ctx.db.getGitAccount(BOB, OWN), null, 'токен сотрудника удалён вместе с сервером');
  await U.onGitCallback(admin, press(ADMIN, `gt:hD:${CORP}`));
  assert.ok(A.findHost(CORP), 'сервер из настроек кнопкой не убрать');
  take();
});

test('проверка своего сервера: GitHub Enterprise и GitLab отвечают по своим адресам API', async () => {
  const seen = [];
  const answer = (status, type) => async (url) => (seen.push(url), { status, headers: { get: () => type } });
  assert.deepEqual(await H.probeHost(H.customHost('github', 'https://ghe.x.io'), { fetchImpl: answer(200, 'application/json; charset=utf-8') }), { ok: true });
  assert.deepEqual(await H.probeHost(H.customHost('gitlab', 'https://git.x.io'), { fetchImpl: answer(401, 'application/json') }), { ok: true });
  assert.deepEqual(seen, ['https://ghe.x.io/api/v3/meta', 'https://git.x.io/api/v4/version']);
  assert.deepEqual(await H.probeHost(H.customHost('gitlab', 'https://site.x.io'), { fetchImpl: answer(200, 'text/html') }), { ok: false, error: 'HTTP 200' }, 'обычный сайт — не GitLab');
  const down = await H.probeHost(H.customHost('gitlab', 'https://down.x.io'), { fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.deepEqual(down, { ok: false, error: 'connect ECONNREFUSED' });
});

// ---------- «Изменения» и «Ветки» ----------

const I = await import('../src/gitInspect.mjs');

test('разбор вывода git: изменённые файлы (с переименованием) и число строк', () => {
  assert.deepEqual(I.parseChanges(' M a.txt\0?? src/новый файл.js\0D  old.txt\0R  new name.txt\0old name.txt\0UU both.txt\0A  added.txt\0'), [
    { path: 'a.txt', kind: 'modified' },
    { path: 'src/новый файл.js', kind: 'new' },
    { path: 'old.txt', kind: 'deleted' },
    { path: 'new name.txt', kind: 'renamed', from: 'old name.txt' },
    { path: 'both.txt', kind: 'conflict' },
    { path: 'added.txt', kind: 'new' },
  ]);
  assert.deepEqual(I.parseChanges(''), []);
  const n = I.parseNumstat('2\t1\ta.txt\0-\t-\timg.png\0' + '3\t0\t\0old.txt\0new.txt\0');
  assert.deepEqual([...n], [['a.txt', { added: 2, deleted: 1 }], ['img.png', { added: null, deleted: null }], ['new.txt', { added: 3, deleted: 0 }]]);
});

test('git: изменения, diff по файлу, коммиты и ветки — на настоящем репозитории', needGit, async () => {
  const w = join(home, 'inspect');
  await G.cloneRepo(REPO_URL, 'inspect', { cwd: home, env });
  assert.deepEqual(await I.changedFiles(w, { env }), { files: [], total: 0 });
  writeFileSync(join(w, 'README.md'), '# app\nновая строка\n');
  writeFileSync(join(w, 'заметки.txt'), 'раз\nдва');
  rmSync(join(w, 'app.js'));
  const { files, total } = await I.changedFiles(w, { env });
  assert.equal(total, 3);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(by['README.md'], { path: 'README.md', kind: 'modified', added: 1, deleted: 0 });
  assert.deepEqual(by['app.js'], { path: 'app.js', kind: 'deleted', added: 0, deleted: 1 });
  assert.deepEqual(by['заметки.txt'], { path: 'заметки.txt', kind: 'new', added: 2, deleted: 0 }, 'у нового файла строки считает бот');

  const d = await I.fileDiff(w, by['README.md'], { env });
  assert.match(d, /^--- a\/README\.md\n\+\+\+ b\/README\.md\n@@ /, 'служебное начало убрано');
  assert.match(d, /\n\+новая строка$/);
  assert.match(await I.fileDiff(w, by['заметки.txt'], { env }), /\n\+раз\n\+два/, 'новый файл — целиком как добавленный');
  assert.match(await I.fileDiff(w, by['app.js'], { env }), /\n-x(\n|$)/, 'удалённый файл — целиком как убранный');

  // ветки: новая от текущей, ветка только на сервере, переключение
  assert.equal(await I.branchName('  моя задача 1 ', { cwd: w, env }), 'моя-задача-1');
  for (const bad of ['', '-x', 'a..b', 'x.lock', 'a b~c']) assert.equal(await I.branchName(bad, { cwd: w, env }), null, bad);
  const seed = join(home, 'seed');
  await git(seed, 'pull', '-q', '--ff-only');
  await git(seed, 'switch', '-q', '-c', 'feature-x');
  writeFileSync(join(seed, 'feature.txt'), 'f');
  await G.commitAll(seed, 'в ветке', { env });
  await G.pushRepo(seed, { env });
  await git(seed, 'switch', '-q', 'main');
  await G.fetchRepo(w, { env });
  let b = await I.listBranches(w, { env });
  assert.equal(b.current, 'main');
  assert.deepEqual(b.branches.map((x) => [x.name, x.local, x.remote, x.current]), [['main', true, true, true], ['feature-x', false, true, false]]);
  await git(w, 'stash', '-q', '--include-untracked');
  await I.switchBranch(w, b.branches[1], { env });
  assert.ok(existsSync(join(w, 'feature.txt')), 'ветка сервера стала локальной');
  assert.equal((await G.repoState(w, { env })).upstream, 'origin/feature-x');
  await I.createBranch(w, 'моя-задача-1', { env });
  writeFileSync(join(w, 'mine.txt'), 'm');
  await G.commitAll(w, 'моя правка', { env });
  b = await I.listBranches(w, { env });
  assert.deepEqual([b.current, b.branches[0].name, b.branches[0].remote], ['моя-задача-1', 'моя-задача-1', false]);
  assert.deepEqual((await I.commitList(w, 'out', { env })).map((c) => c.subject).slice(0, 1), ['моя правка'], 'без ветки на сервере — коммиты самой ветки');
  assert.deepEqual(await I.commitList(w, 'in', { env }), []);
  await assert.rejects(I.switchBranch(w, { name: '-evil', local: true }, { env }), (e) => e instanceof G.GitError && e.i18n?.key === 'err.gitBadBranch');
});

test('/git: «Изменения» — список файлов, diff в сообщении и файлом, секреты не показываются; «Ветки» — переключение и новая ветка', needGit, async () => {
  ctx.db.saveGitAccount(ANN, { host: 'github', login: 'ann-dev', name: 'Ann Dev', email: 'ann@example.com', token: TOKEN });
  const proj = join(ws, 'app');
  assert.equal(ann.project, proj);
  writeFileSync(join(proj, 'page.html'), '<p>hi</p>\n<p>новый абзац</p>\n');
  writeFileSync(join(proj, 'notes.txt'), 'заметка\n');
  writeFileSync(join(proj, '.env.local'), 'KEY=sekret-999\n');
  writeFileSync(join(proj, 'big.txt'), Array.from({ length: 900 }, (_, i) => `строка ${i}`).join('\n'));
  await U.handleGit(ann);
  const main = buttons(take());
  assert.ok(main.some((x) => x.callback_data === 'gt:ch:0' && x.text === '📋 Изменения') && main.some((x) => x.callback_data === 'gt:br:0'));

  await U.onGitCallback(ann, press(ANN, 'gt:ch:0'));
  const ch = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(ch), /Изменено файлов: 4 · добавлено строк: 90\d · убрано: \d/);
  const files = buttons(ch).filter((x) => x.callback_data.startsWith('gt:cf:'));
  assert.ok(files.some((x) => x.text === '✏️ page.html +2 −1') && files.some((x) => x.text === '🆕 notes.txt +1'), JSON.stringify(files.map((x) => x.text)));
  assert.ok(buttons(ch).some((x) => x.callback_data === 'gt:cm:o' && x.text === '⬆️ Не отправлено: 1'));
  const cf = (name) => files.find((x) => x.text.includes(name)).callback_data;

  await U.onGitCallback(ann, press(ANN, cf('page.html')));
  const diff = texts(take().filter((c) => c.method === 'editMessageText'));
  assert.match(diff, /^✏️ <code>page\.html<\/code>\n<pre><code class="language-diff">/);
  assert.match(diff, /\+&lt;p&gt;новый абзац&lt;\/p&gt;/, 'содержимое экранировано');

  await U.onGitCallback(ann, press(ANN, cf('.env.local')));
  const secret = take();
  assert.match(texts(secret), /файл с секретами, его содержимое здесь не показывается/);
  assert.ok(!JSON.stringify(secret).includes('sekret-999'));

  await U.onGitCallback(ann, press(ANN, cf('big.txt')));
  const big = take();
  assert.ok(big.some((c) => c.method === 'sendDocument'), 'большой diff приходит файлом');
  assert.match(texts(big), /большие — отправил их файлом/);
  assert.equal(existsSync(join(home, 'data', 'outbox', String(ANN), 'big.txt.diff')), false, 'временный файл убран');

  await U.onGitCallback(ann, press(ANN, 'gt:cm:o'));
  assert.match(texts(take()), /Коммиты, которых ещё нет на сервере: 1[\s\S]*агент добавил секреты/);
  await U.onGitCallback(ann, press(ANN, 'gt:cf:99'));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery'], 'устаревший номер файла');

  // ветки: с сервера приходит feature-x (её создал предыдущий тест)
  await U.onGitCallback(ann, press(ANN, 'gt:br:0'));
  const br = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(br), /Текущая: <code>main<\/code>/);
  const branchBtn = (name) => buttons(br).find((x) => x.text.endsWith(` ${name}`));
  assert.equal(branchBtn('main').text, '✓ main');
  assert.equal(branchBtn('feature-x').text, '☁️ feature-x', 'ветка только на сервере видна после сверки');

  // с несохранёнными изменениями не переключаемся
  await U.onGitCallback(ann, press(ANN, branchBtn('feature-x').callback_data));
  const dirty = take();
  assert.match(texts(dirty), /есть несохранённые изменения \(файлов: 4\)/);
  assert.ok(buttons(dirty).some((x) => x.callback_data === 'gt:save'));
  assert.equal((await G.repoState(proj, { env })).branch, 'main');

  for (const f of ['notes.txt', 'big.txt']) rmSync(join(proj, f));
  await git(proj, 'checkout', '--', 'page.html', '.env.local');
  // пока агент выполняет запрос — отказ; сессия агента после переключения не продолжается
  ann.busy = true;
  await U.onGitCallback(ann, press(ANN, branchBtn('feature-x').callback_data));
  assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery']);
  ann.busy = false;
  ann.agent = { sessionId: 'old', closed: false, dbSessionId: null, close() { this.closed = true; } };
  await U.onGitCallback(ann, press(ANN, branchBtn('feature-x').callback_data));
  assert.match(texts(take()), /Вы на ветке <code>feature-x<\/code>\. Следующий запрос агенту начнёт новую сессию/);
  assert.equal((await G.repoState(proj, { env })).branch, 'feature-x');
  assert.equal(ann.agent, null, 'сессия агента закрыта');
  assert.equal(ann.resumeId, null);

  // новая ветка: название следующим сообщением
  await U.onGitCallback(ann, press(ANN, 'gt:bn'));
  assert.equal(ann.pendingInput.kind, 'gitBranch');
  take();
  assert.equal(await U.onGitInput(ann, 'плохое..имя'), true);
  assert.match(texts(take()), /не подойдёт/);
  assert.equal(ann.pendingInput.kind, 'gitBranch', 'ждём другое название');
  assert.equal(await U.onGitInput(ann, 'правки главной'), true);
  assert.match(texts(take()), /Создана и выбрана ветка <code>правки-главной<\/code>/);
  assert.equal((await G.repoState(proj, { env })).branch, 'правки-главной');
});

test('gt:savenow: описание коммита проставляется автоматически', needGit, async () => {
  const { st, project, edits, view, edit, ack } = await freshRepo(4101);
  writeFileSync(join(project, 'auto.txt'), 'auto\n');

  await RA.onRepoActionCallback(st, { action: 'save', lang: 'ru', ack, edit, view });
  assert.equal(st.pendingInput?.kind, 'gitMessage');
  take();

  await RA.onRepoActionCallback(st, { action: 'savenow', lang: 'ru', ack, edit, view });
  assert.equal(st.pendingInput, null);
  assert.match(edits.map((x) => x.text ?? '').join('\n'), /Изменения сохранены и отправлены/);
  const message = (await git(home, '--git-dir', bare, 'log', '-1', '--format=%s', 'main')).trim();
  assert.match(message, /^Изменения из AcpGram,/);
});

test('gt:push: отклонение не-fast-forward предлагает получить изменения', needGit, async () => {
  const { st, project, edits, view, edit, ack } = await freshRepo(4102);
  writeFileSync(join(project, 'reject.txt'), 'локально\n');
  await G.commitAll(project, 'локальный коммит', { env });

  const otherHome = join(home, 'other-reject');
  mkdirSync(otherHome);
  await git(otherHome, 'clone', '-q', REPO_URL, 'work');
  const other = join(otherHome, 'work');
  writeFileSync(join(other, 'server.txt'), 'с сервера\n');
  await G.commitAll(other, 'удалённый коммит', { env });
  await G.pushRepo(other, { env });

  await RA.onRepoActionCallback(st, { action: 'push', lang: 'ru', ack, edit, view });
  assert.match(edits.map((x) => x.text ?? '').join('\n'), /Сервер не принял отправку/);
  assert.equal((await G.repoState(project, { env })).ahead, 1);
});

test('gt:push: общий сбой git показывается с текстом ошибки', needGit, async () => {
  const { st, project, edits, view, edit, ack } = await freshRepo(4103);
  writeFileSync(join(project, 'fail.txt'), 'fail\n');
  await G.commitAll(project, 'перед сбоем', { env });

  const saved = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_CONFIG_VALUE_0 = join(home, 'нет-такого-remote.git');
  try {
    await RA.onRepoActionCallback(st, { action: 'push', lang: 'ru', ack, edit, view });
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = saved;
  }
  assert.match(edits.map((x) => x.text ?? '').join('\n'), /⚠️ Git:/);
});

// Вход в Git по ссылке и коду (без токена): запросы к сервису, обновление входа и сценарий в /git.
// Сеть подменена, паузы между опросами убраны.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const hasGit = spawnSync('git', ['--version']).status === 0;
const needGit = { skip: hasGit ? false : 'git не установлен' };
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-dev-')));
mkdirSync(join(home, 'projects'));
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = join(home, 'projects');
process.env.USER_WORKSPACES = '1';
for (const k of ['GITLAB_URL', 'GITHUB_URL', 'GITHUB_CLIENT_ID', 'GITLAB_CLIENT_ID', 'GIT_AGENT_AUTH', 'AGENT_SANDBOX', 'GIT_COMMAND']) delete process.env[k];
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

const sent = [];
const calls = []; // запросы к сервисам: [адрес, тело, заголовок авторизации]
// ответы на опросы по очереди (последний повторяется); gitlabGrant — что GitLab выдаёт при подтверждении и обновлении
const service = { polls: [], gitlabGrant: { access_token: 'glo_first', refresh_token: 'glr_first', expires_in: 7200 } };
const realFetch = globalThis.fetch;
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, headers: { get: () => null } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  if (u.includes('github.com')) {
    calls.push([u, body, init.headers?.authorization ?? null]);
    if (u.endsWith('/login/device/code')) return json({ device_code: 'DEV-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (u.endsWith('/login/oauth/access_token')) return json(service.polls.length > 1 ? service.polls.shift() : service.polls[0]);
    if (u.endsWith('/user')) return json({ login: 'ann-dev', name: 'Ann Dev', email: null, id: 42 });
    return json({ message: 'Not Found' }, 404);
  }
  if (u.includes('gitlab.com')) {
    calls.push([u, body, init.headers?.authorization ?? null]);
    if (u.endsWith('/oauth/authorize_device')) return json({ device_code: 'GL-DEV', user_code: 'WXYZ9876', verification_uri: 'https://gitlab.com/oauth/device', verification_uri_complete: 'https://gitlab.com/oauth/device?user_code=WXYZ9876', expires_in: 300, interval: 5 });
    if (u.endsWith('/oauth/token')) return json(service.gitlabGrant, service.gitlabGrant.error ? 400 : 200);
    if (u.endsWith('/api/v4/user')) return json({ username: 'ann', name: 'Ann', commit_email: 'ann@example.com' });
    return json({ message: '404 Not Found' }, 404); // сведения о токене доступа: у входа по коду их нет
  }
  sent.push({ method: u.split('/').pop(), body: body ?? {} });
  return { json: async () => ({ ok: true, result: { message_id: 900 + sent.length } }) };
};
const take = () => sent.splice(0);
const texts = (list) => list.map((c) => c.body.text ?? '').join('\n');
const buttons = (list) => list.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();
const press = (id, data) => ({ id: 'cb', data, message: { chat: { id }, message_id: 5 } });
/** Ждёт, пока фоновое ожидание входа допишет сообщения. */
const settle = async (cond) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setImmediate(r));
};

const ctx = await import('../src/ctx.mjs');
const D = await import('../src/gitDevice.mjs');
const H = await import('../src/gitHosts.mjs');
const G = await import('../src/git.mjs');
const A = await import('../src/gitAccess.mjs');
const S = await import('../src/state.mjs');
const U = await import('../src/gitUi.mjs');
G.setGitAvailable(true);
D.deviceTiming.sleep = async () => {}; // без пауз между опросами

const ADMIN = ctx.ADMIN_ID;
const ANN = ADMIN === 6001 ? 6101 : 6001;
ctx.setLang(ANN, 'ru');
ctx.db.upsertUser({ user_id: ANN, username: 'ann', level: 'normal', added_by: ADMIN });
S.topicsSupport.enabled = false;
const ann = S.getState(ANN, ANN);
const [github, gitlab] = H.gitHosts({});

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* Windows не всегда сразу отпускает папку, в которой только что работал git: уборка временной папки — не предмет теста */
  }
});

test('вход по коду есть у GitHub.com и GitLab.com (встроенные приложения); свой идентификатор и выключение — настройкой', () => {
  const gh = D.deviceLogin(github, {});
  assert.deepEqual([gh.codeUrl, gh.tokenUrl, gh.scope], ['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'repo read:org']);
  assert.match(gh.clientId, /^Ov23/);
  const gl = D.deviceLogin(gitlab, {});
  assert.deepEqual([gl.codeUrl, gl.tokenUrl, gl.scope], ['https://gitlab.com/oauth/authorize_device', 'https://gitlab.com/oauth/token', 'api read_repository write_repository']);
  assert.match(gl.clientId, /^[0-9a-f]{64}$/);
  assert.equal(D.deviceLogin(github, { GITHUB_CLIENT_ID: ' Iv1.own ' }).clientId, 'Iv1.own');
  assert.equal(D.deviceLogin(gitlab, { GITLAB_CLIENT_ID: 'own-app' }).clientId, 'own-app');
  assert.equal(D.deviceLogin(github, { GITHUB_CLIENT_ID: '0' }), null, 'выключено — остаётся вход по токену');
  assert.equal(D.deviceLogin(gitlab, { GITLAB_CLIENT_ID: 'off' }), null);
  assert.ok(D.deviceLogin(gitlab, { GITHUB_CLIENT_ID: '0' }), 'выключение одного сервиса не трогает другой');
  for (const own of [H.customHost('github', 'https://ghe.x.io'), H.customHost('gitlab', 'https://git.x.io'), null]) assert.equal(D.deviceLogin(own, {}), null, 'свой сервер — только токен');
});

test('запросы входа по коду: выдача кода, ожидание, просьба опрашивать реже, отказ, истечение, обновление входа', async () => {
  const cfg = D.deviceLogin(github, {});
  const login = await D.startDeviceLogin(cfg);
  assert.deepEqual(login, { deviceCode: 'DEV-1', userCode: 'ABCD-1234', url: 'https://github.com/login/device', interval: 5, expiresIn: 900 });
  assert.deepEqual(calls.at(-1).slice(0, 2), ['https://github.com/login/device/code', { client_id: cfg.clientId, scope: 'repo read:org' }]);
  // у GitLab страница сразу с кодом в адресе
  const glCfg = D.deviceLogin(gitlab, {});
  assert.equal((await D.startDeviceLogin(glCfg)).url, 'https://gitlab.com/oauth/device?user_code=WXYZ9876');

  service.polls = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'gho_fromcode' }];
  const waits = [];
  const sleep = D.deviceTiming.sleep;
  D.deviceTiming.sleep = async (ms) => waits.push(ms);
  assert.deepEqual(await D.waitDeviceLogin(cfg, login), { token: 'gho_fromcode', refreshToken: null, expiresIn: null }, 'у GitHub вход бессрочный');
  assert.deepEqual(waits, [5000, 5000, 10000], 'после «опрашивайте реже» интервал увеличен');
  assert.deepEqual(calls.at(-1).slice(0, 2), ['https://github.com/login/oauth/access_token', { client_id: cfg.clientId, device_code: 'DEV-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }]);
  D.deviceTiming.sleep = sleep;
  assert.deepEqual(await D.waitDeviceLogin(glCfg, { deviceCode: 'GL-DEV', interval: 5, expiresIn: 300 }), { token: 'glo_first', refreshToken: 'glr_first', expiresIn: 7200 }, 'у GitLab — срок и токен обновления');

  service.polls = [{ error: 'access_denied' }];
  await assert.rejects(D.waitDeviceLogin(cfg, login), (e) => e instanceof D.DeviceError && e.code === 'denied');
  service.polls = [{ error: 'expired_token' }];
  await assert.rejects(D.waitDeviceLogin(cfg, login), (e) => e.code === 'expired');
  service.polls = [{ error: 'authorization_pending' }];
  let clock = 0;
  await assert.rejects(D.waitDeviceLogin(cfg, { ...login, expiresIn: 20 }, { now: () => (clock += 7000) }), (e) => e.code === 'expired', 'срок кода вышел — ожидание прекращается');
  let polls = 0;
  await assert.rejects(D.waitDeviceLogin(cfg, login, { cancelled: () => ++polls > 2 }), (e) => e.code === 'cancelled');
  await assert.rejects(D.startDeviceLogin(cfg, { fetchImpl: async () => json({ error: 'device_flow_disabled' }) }), (e) => e.code === 'failed' && /device_flow_disabled/.test(e.message));
  await assert.rejects(D.startDeviceLogin(cfg, { fetchImpl: async () => json({}) }), (e) => e.code === 'failed' && e.i18n?.key === 'err.gitDeviceNoCode');
  service.polls = [{}];
  await assert.rejects(D.waitDeviceLogin(cfg, login), (e) => e.code === 'failed' && e.i18n?.key === 'err.gitDeviceUnknown');

  // обновление: новая пара токенов; отказ сервиса — вход больше не действует
  service.gitlabGrant = { access_token: 'glo_second', refresh_token: 'glr_second', expires_in: 7200 };
  assert.deepEqual(await D.refreshLogin(glCfg, 'glr_first'), { token: 'glo_second', refreshToken: 'glr_second', expiresIn: 7200 });
  assert.deepEqual(calls.at(-1).slice(0, 2), ['https://gitlab.com/oauth/token', { client_id: glCfg.clientId, refresh_token: 'glr_first', grant_type: 'refresh_token' }]);
  service.gitlabGrant = { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' };
  await assert.rejects(D.refreshLogin(glCfg, 'glr_used'), (e) => e.code === 'expired');
  service.gitlabGrant = { access_token: 'glo_first', refresh_token: 'glr_first', expires_in: 7200 };
});

test('обновление входа перед операцией: заранее, одно на всех, с отключением аккаунта при отказе сервиса', async () => {
  const soon = () => new Date(Date.now() + 5 * 60_000).toISOString();
  const save = (extra) => ctx.db.saveGitAccount(ANN, { host: 'gitlab', login: 'ann', name: 'Ann', email: 'ann@example.com', token: 'glo_old', refreshToken: 'glr_old', accessUntil: soon(), ...extra });
  // свежий токен не трогаем
  save({ accessUntil: new Date(Date.now() + 90 * 60_000).toISOString() });
  let n = 0;
  const refresh = async () => (n++, { token: 'glo_new', refreshToken: 'glr_new', expiresIn: 7200 });
  assert.deepEqual(await A.refreshAccounts(ANN, { refresh }), []);
  assert.equal(n, 0);
  // истекающий — обновляется один раз, даже если операции идут одновременно (токен обновления одноразовый)
  save();
  const slow = async () => (n++, await new Promise((r) => setTimeout(r, 20)), { token: 'glo_new', refreshToken: 'glr_new', expiresIn: 7200 });
  await Promise.all([A.refreshAccounts(ANN, { refresh: slow }), A.refreshAccounts(ANN, { refresh: slow }), A.refreshAccounts(ANN, { refresh: slow })]);
  assert.equal(n, 1);
  const acc = ctx.db.getGitAccount(ANN, 'gitlab');
  assert.deepEqual([acc.token, acc.refresh_token], ['glo_new', 'glr_new']);
  assert.ok(Date.parse(acc.access_until) - Date.now() > 100 * 60_000, 'срок продлён на два часа');
  // сбой сети — аккаунт остаётся: попробуем при следующей операции
  save();
  const failed = async () => {
    throw new D.DeviceError('failed', 'fetch failed');
  };
  assert.deepEqual(await A.refreshAccounts(ANN, { refresh: failed }), []);
  assert.equal(ctx.db.getGitAccount(ANN, 'gitlab').token, 'glo_old');
  // сервис больше не принимает вход — аккаунт отключается, пользователю сообщается
  const rejected = async () => {
    throw new D.DeviceError('expired');
  };
  const lost = await A.refreshAccounts(ANN, { refresh: rejected });
  assert.deepEqual(lost.map((x) => [x.host.id, x.login]), [['gitlab', 'ann']]);
  assert.equal(ctx.db.getGitAccount(ANN, 'gitlab'), null);
  // токен доступа (без токена обновления) не обновляется никогда
  ctx.db.saveGitAccount(ANN, { host: 'gitlab', login: 'ann', token: 'glpat-x', expiresAt: soon() });
  assert.deepEqual(await A.refreshAccounts(ANN, { refresh }), []);
  assert.equal(ctx.db.getGitAccount(ANN, 'gitlab').token, 'glpat-x');
  ctx.db.deleteGitAccount(ANN, 'gitlab');
});

test('/git: «Войти без токена» — ссылка и код в сообщении, аккаунт подключается сам; отмена прекращает ожидание', needGit, async () => {
  await U.onGitCallback(ann, press(ANN, 'gt:c:github'));
  const ask = take();
  assert.match(texts(ask), /Или войдите без токена — кнопкой ниже/);
  assert.ok(buttons(ask).some((b) => b.callback_data === 'gt:dv:github' && b.text === '🔗 Войти без токена'));

  // отмена: ожидание прекращается, аккаунт не подключён
  service.polls = [{ error: 'authorization_pending' }];
  await U.onGitCallback(ann, press(ANN, 'gt:dv:github'));
  const how = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(how), /Введите код: <code>ABCD-1234<\/code>/);
  assert.match(texts(how), /Код действует 15 мин/);
  assert.equal(buttons(how)[0].url, 'https://github.com/login/device');
  assert.equal(ann.pendingInput, null, 'токен сообщением больше не ждём');
  await U.onGitCallback(ann, press(ANN, 'gt:x'));
  await settle(() => !ann.gitDevice);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ctx.db.getGitAccount(ANN, 'github'), null);
  take();

  // подтверждение на сайте: бот получает токен сам и подключает аккаунт
  service.polls = [{ error: 'authorization_pending' }, { access_token: 'gho_secret_from_code' }];
  await U.onGitCallback(ann, press(ANN, 'gt:dv:github'));
  await settle(() => sent.some((c) => /Аккаунты:/.test(c.body.text ?? '')));
  const done = take();
  const acc = ctx.db.getGitAccount(ANN, 'github');
  assert.deepEqual([acc.token, acc.refresh_token, acc.access_until], ['gho_secret_from_code', null, null]);
  assert.match(texts(done), /Доступ к GitHub подтверждён/);
  assert.match(texts(done), /GitHub подключён: ann-dev \(Ann Dev\)\./);
  assert.ok(!texts(done).includes('Сообщение с токеном'), 'сообщения с токеном не было — и упоминать его незачем');
  assert.ok(!JSON.stringify(done).includes('gho_secret_from_code'), 'токен в чат не попадает');
  assert.equal(calls.findLast(([u]) => u.endsWith('api.github.com/user'))[2], 'Bearer gho_secret_from_code', 'профиль запрошен полученным токеном');

  // отказ на сайте
  ctx.db.deleteGitAccount(ANN, 'github');
  service.polls = [{ error: 'access_denied' }];
  await U.onGitCallback(ann, press(ANN, 'gt:dv:github'));
  await settle(() => sent.some((c) => /Доступ не подтверждён/.test(c.body.text ?? '')));
  assert.match(texts(take()), /Доступ не подтверждён/);
  assert.equal(ctx.db.getGitAccount(ANN, 'github'), null);
});

test('/git: вход по коду в GitLab.com — токен на 2 часа сохраняется вместе с токеном обновления; необновляемый вход не подключается', needGit, async () => {
  await U.onGitCallback(ann, press(ANN, 'gt:c:gitlab'));
  assert.ok(buttons(take()).some((b) => b.callback_data === 'gt:dv:gitlab'));
  service.gitlabGrant = { access_token: 'glo_from_code', refresh_token: 'glr_from_code', expires_in: 7200 };
  await U.onGitCallback(ann, press(ANN, 'gt:dv:gitlab'));
  await settle(() => sent.some((c) => /Аккаунты:/.test(c.body.text ?? '')));
  const done = take();
  assert.match(texts(done), /Введите код: <code>WXYZ9876<\/code>/);
  assert.match(texts(done), /GitLab\.com подключён: ann \(Ann\)\./);
  const acc = ctx.db.getGitAccount(ANN, 'gitlab');
  assert.deepEqual([acc.token, acc.refresh_token, acc.expires_at], ['glo_from_code', 'glr_from_code', null], 'срок токена доступа не задан — напоминать не о чем');
  assert.ok(Date.parse(acc.access_until) - Date.now() > 100 * 60_000);
  assert.ok(!JSON.stringify(done).includes('glo_from_code') && !JSON.stringify(done).includes('glr_from_code'), 'токены в чат не попадают');
  assert.equal(calls.findLast(([u]) => u.endsWith('/api/v4/user'))[2], 'Bearer glo_from_code');
  assert.deepEqual(A.tokenReminders(Date.now() + 3 * 3600_000), [], 'обновляемый вход не «истекает» для напоминаний');

  // сервис выдал срок, но не выдал токен обновления: через два часа вход перестал бы работать — не подключаем
  ctx.db.deleteGitAccount(ANN, 'gitlab');
  service.gitlabGrant = { access_token: 'glo_short', expires_in: 7200 };
  await U.onGitCallback(ann, press(ANN, 'gt:dv:gitlab'));
  await settle(() => sent.some((c) => /не продлевается/.test(c.body.text ?? '')));
  assert.match(texts(take()), /GitLab\.com выдал вход, который истекает и не продлевается/);
  assert.equal(ctx.db.getGitAccount(ANN, 'gitlab'), null);
});

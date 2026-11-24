import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-admin-auth-')));
const root = join(home, 'projects');
mkdirSync(root, { recursive: true });
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.ALLOWED_USER_ID = '44001';
process.env.TELEGRAM_BOT_TOKEN = 'test';
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  sent.push({ method: String(url).split('/').pop(), body: init.body ? JSON.parse(init.body) : {} });
  return { json: async () => ({ ok: true, result: { message_id: 100 + sent.length } }) };
};

const ctx = await import('../src/ctx.mjs');
const state = await import('../src/state.mjs');
const admin = await import('../src/admin.mjs');
const filesUi = await import('../src/filesUi.mjs');
const projectsUi = await import('../src/projectsUi.mjs');
const pendingInput = await import('../src/pendingInput.mjs');
const git = await import('../src/git.mjs');
const gitUi = await import('../src/gitUi.mjs');
const engines = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');

const ADMIN = ctx.ADMIN_ID;
const lang = 'en';
const userId = (offset) => ADMIN + offset;
const from = (id, username = `user${id}`) => ({ id, username, first_name: username, language_code: lang });
const press = (data, id) => ({ id: 'cb', data, message: { chat: { id: id ?? ADMIN }, message_id: 9 } });
const take = () => sent.splice(0);
const messages = (calls) => calls.filter((c) => c.method === 'sendMessage');
const edits = (calls) => calls.filter((c) => c.method === 'editMessageText');
const acks = (calls) => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text ?? '');
const buttons = (calls) => calls.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();
const toUser = (calls, id) => messages(calls).filter((c) => c.body.chat_id === id).map((c) => c.body.text).join('\n');
const callbackOf = (calls, prefix) => buttons(calls).find((b) => b.callback_data?.startsWith(prefix))?.callback_data;

ctx.setLang(ADMIN, lang);
ctx.botInfo.username = 'acpgram_test_bot';

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('/invite: администратор выбирает уровень, одноразовая ссылка открывает доступ и не работает повторно', async () => {
  const invited = userId(1);
  const second = userId(2);
  await admin.adminCommand(ADMIN, '/invite');
  let calls = take();
  assert.equal(toUser(calls, ADMIN), t('adm.inviteAsk', lang));
  assert.deepEqual(buttons(calls).map((b) => b.callback_data), ['adm:i:read', 'adm:i:normal', 'adm:i:full']);

  await admin.onAdminCallback(press('adm:i:normal'));
  calls = take();
  const made = edits(calls)[0]?.body.text ?? '';
  assert.deepEqual(acks(calls), ['']);
  assert.ok(made.includes(t('adm.inviteMade', lang, { level: ctx.levelName('normal', lang), bot: ctx.botInfo.username, code: '' }).split('?start=')[0]));
  const code = /[?&]start=([A-Za-z0-9_-]+)/.exec(made)?.[1];
  assert.ok(code, 'в ответе администратору есть код приглашения');

  await admin.handleUnknownUser(from(invited), invited, `/start ${code}`);
  calls = take();
  assert.equal(ctx.db.getUser(invited)?.level, 'normal');
  assert.equal(ctx.db.getUser(invited)?.status, 'active');
  assert.ok(toUser(calls, invited).includes(ctx.levelName('normal', lang)));
  assert.ok(toUser(calls, invited).includes(ctx.levelHint('normal', lang)));
  assert.ok(toUser(calls, ADMIN).includes(`@user${invited}`));

  admin.sweepUnknownUsers(0);
  await admin.handleUnknownUser(from(second), second, `/start ${code}`);
  assert.equal(toUser(take(), second), t('access.inviteBad', lang));
  assert.equal(ctx.db.getUser(second), null);

  admin.sweepUnknownUsers(0);
  await admin.handleUnknownUser(from(second), second, '/start totally-wrong-code');
  assert.equal(toUser(take(), second), t('access.inviteBad', lang));
  assert.equal(ctx.db.getUser(second), null);
});

test('приглашение с истёкшим сроком не даёт доступа', async () => {
  const expired = userId(3);
  ctx.db.createInvite('expired-code', 'full', ADMIN, new Date(Date.now() - 60_000).toISOString());
  await admin.handleUnknownUser(from(expired), expired, '/start expired-code');
  assert.equal(toUser(take(), expired), t('access.inviteBad', lang));
  assert.equal(ctx.db.getUser(expired), null);
});

test('запрос доступа: сотрудник видит подтверждение, администратор получает кнопки решений, повтор не спамит', async () => {
  const requester = userId(4);
  await admin.handleUnknownUser(from(requester), requester, 'нужен доступ');
  let calls = take();
  assert.equal(toUser(calls, requester), t('access.requestSent', lang));
  assert.equal(ctx.db.getRequest(requester)?.status, 'pending');
  const adminNotice = messages(calls).find((c) => c.body.chat_id === ADMIN);
  assert.ok(adminNotice?.body.text.includes('нужен доступ'));
  assert.deepEqual(buttons(calls).map((b) => b.callback_data), [
    `adm:g:${requester}:read`,
    `adm:g:${requester}:normal`,
    `adm:g:${requester}:full`,
    `adm:d:${requester}`,
  ]);

  await admin.handleUnknownUser(from(requester), requester, 'ещё раз');
  assert.deepEqual(take(), [], 'повтор в течение часа не отправляется');

  admin.sweepUnknownUsers(0);
  await admin.handleUnknownUser(from(requester), requester, 'ещё раз');
  assert.equal(toUser(take(), requester), t('access.pending', lang));
});

test('решение администратора: выдача прав по запросу и отклонение с тихим игнорированием дальше', async () => {
  const granted = userId(4);
  await admin.onAdminCallback(press(`adm:g:${granted}:full`));
  let calls = take();
  assert.equal(ctx.db.getUser(granted)?.level, 'full');
  assert.equal(ctx.db.getRequest(granted)?.status, 'approved');
  assert.ok(toUser(calls, granted).includes(t('access.grantedByAdmin', lang, { level: '', hint: '', note: '' }).slice(0, 30)));
  assert.ok(edits(calls)[0]?.body.text.includes(ctx.levelName('full', lang)));

  const rejected = userId(5);
  await admin.handleUnknownUser(from(rejected), rejected, 'отклоните');
  take();
  await admin.onAdminCallback(press(`adm:d:${rejected}`));
  calls = take();
  assert.equal(ctx.db.getRequest(rejected)?.status, 'rejected');
  assert.equal(toUser(calls, rejected), t('access.rejectedByAdmin', lang));
  assert.equal(ctx.db.getUser(rejected), null);

  admin.sweepUnknownUsers(0);
  await admin.handleUnknownUser(from(rejected), rejected, 'можно ещё раз?');
  assert.deepEqual(take(), [], 'отклонённый запрос больше не отвечает');
});

test('уровень доступа: администратор меняет уровень, сотрудник получает сообщение, режим агента становится читающим', async () => {
  const member = userId(6);
  ctx.db.upsertUser({ user_id: member, username: 'member', first_name: 'Member', level: 'normal', added_by: ADMIN });
  ctx.setLang(member, lang);

  await admin.adminCommand(ADMIN, '/users');
  let calls = take();
  assert.equal(toUser(calls, ADMIN).includes(`@member`), true);
  await admin.onAdminCallback(press(`adm:u:${member}`));
  calls = take();
  assert.equal(callbackOf(calls, `adm:l:${member}:`), `adm:l:${member}:read`);

  await admin.onAdminCallback(press(`adm:l:${member}:read`));
  calls = take();
  assert.equal(ctx.db.getUser(member)?.level, 'read');
  assert.deepEqual(acks(calls), [t('adm.ackLevelChanged', lang)]);
  assert.ok(toUser(calls, member).includes(ctx.levelName('read', lang)));
  assert.equal(state.modeFor(member, engines.ENGINES[engines.DEFAULT_ENGINE]), engines.ENGINES[engines.DEFAULT_ENGINE].modes.read);
  assert.ok(buttons(calls).find((b) => b.callback_data === `adm:l:${member}:read`)?.text?.startsWith('✓'));
});

test('отзыв доступа: подтверждение, уведомление сотруднику и исчезновение из списка активных', async () => {
  const member = userId(6);
  await admin.onAdminCallback(press(`adm:r:${member}`));
  let calls = take();
  assert.equal(callbackOf(calls, 'adm:ro:'), `adm:ro:${member}`);
  assert.ok(edits(calls)[0]?.body.text.includes(t('adm.revokeAsk', lang, { name: '@member' }).split('\n')[0]));

  await admin.onAdminCallback(press(`adm:ro:${member}`));
  calls = take();
  assert.equal(ctx.db.getUser(member)?.status, 'revoked');
  assert.deepEqual(acks(calls), [t('adm.ackRevoked', lang)]);
  assert.equal(toUser(calls, member), t('access.revoked', lang));
  assert.ok(!(edits(calls)[0]?.body.text ?? '').includes('@member — '));
});

test('admin-only команды: /users, /active и /usage открывают административные экраны с ответом и кнопками', async () => {
  for (const command of ['/users', '/active', '/usage']) {
    await admin.adminCommand(ADMIN, command);
    const calls = take();
    const reply = messages(calls).find((c) => c.body.chat_id === ADMIN);
    assert.ok(reply?.body.text, `команда ${command} должна что-то показать администратору`);
    assert.ok(reply.body.reply_markup?.inline_keyboard?.length, `команда ${command} должна показать кнопки`);
  }
});

const low = userId(20);
ctx.db.upsertUser({ user_id: low, username: 'low', first_name: 'Low', level: 'read', added_by: ADMIN });
ctx.setLang(low, lang);
const shared = join(root, 'shared');
mkdirSync(shared, { recursive: true });
const keptFile = join(shared, 'note.txt');
writeFileSync(keptFile, 'keep me');
const lowState = state.getState(low, low);
state.saveProject(lowState, shared);

test('общий корень, уровень Чтение: в /files нет кнопок создания, загрузки и удаления', async () => {
  assert.equal(state.rootOf(low), root, 'сотрудник видит общий корень');
  assert.equal(filesUi.canManageFiles(low), false);
  await filesUi.handleFiles(lowState);
  const calls = take();
  const data = buttons(calls).map((b) => b.callback_data ?? '');
  assert.ok(data.some((d) => d.startsWith('fl:f:')));
  assert.equal(data.some((d) => /^fl:(n|u|d|D):/.test(d)), false);

  const token = callbackOf(calls, 'fl:f:')?.split(':')[2];
  assert.ok(token);
  await admin.sweepUnknownUsers(0);

  await filesUi.onFilesCallback(lowState, press(`fl:D:${token}`, low));
  assert.deepEqual(acks(take()), [t('files.noRights', lang)]);
  assert.equal(readFileSync(keptFile, 'utf8'), 'keep me');

  await filesUi.onFilesCallback(lowState, press(`fl:n:${token}`, low));
  assert.deepEqual(acks(take()), [t('files.noRights', lang)]);
  assert.equal(lowState.pendingInput, null);

  await filesUi.onFilesCallback(lowState, press(`fl:u:${token}`, low));
  assert.deepEqual(acks(take()), [t('files.noRights', lang)]);
  assert.equal(lowState.pendingInput, null);
});

test('общий корень, уровень Чтение: ожидание ввода не позволяет записать файл в проект', async () => {
  pendingInput.setPendingInput(lowState, 'fileName', { dir: shared });
  assert.equal(await filesUi.onFileInput(lowState, 'new.txt', { messageId: 12 }), true);
  assert.equal(toUser(take(), low), t('state.projectGone', lang));
  assert.equal(existsSync(join(shared, 'new.txt')), false);

  pendingInput.setPendingInput(lowState, 'fileContent', { dir: shared, parts: ['note.txt'] });
  assert.equal(await filesUi.onFileInput(lowState, 'перезаписано', { messageId: 13 }), true);
  assert.equal(toUser(take(), low), t('files.contentExpired', lang));
  assert.equal(readFileSync(keptFile, 'utf8'), 'keep me');

  pendingInput.setPendingInput(lowState, 'fileUpload', { dir: shared });
  const uploaded = await filesUi.onFileUpload(lowState, {
    message_id: 14,
    document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'note.txt', file_size: 5 },
  });
  assert.equal(uploaded, true);
  assert.equal(toUser(take(), low), t('state.projectGone', lang));
  assert.equal(sent.some((c) => c.method === 'getFile'), false);
  assert.equal(readFileSync(keptFile, 'utf8'), 'keep me');
});

test('общий корень, уровень Чтение: /project не предлагает создать папку и не создаёт её', async () => {
  assert.equal(projectsUi.canCreateProject(low), false);
  await projectsUi.handleProject(lowState);
  const calls = take();
  const data = buttons(calls).map((b) => b.callback_data ?? '');
  assert.ok(data.some((d) => d.startsWith('nav:s:')));
  assert.equal(data.some((d) => d.startsWith('nav:c:')), false);
  assert.equal(data.includes('gt:cl'), false);

  const token = projectsUi.pathToken(root);
  await projectsUi.onNavCallback(lowState, press(`nav:c:${token}`, low));
  assert.deepEqual(acks(take()), [t('proj.noFolder', lang)]);
  assert.equal(lowState.pendingInput, null);

  pendingInput.setPendingInput(lowState, 'newProject', { dir: root });
  assert.equal(await projectsUi.onProjectNameInput(lowState, 'forbidden'), true);
  assert.equal(toUser(take(), low), t('proj.noFolder', lang));
  assert.equal(existsSync(join(root, 'forbidden')), false);
});

test('общий корень, уровень Чтение: /git не предлагает push/pull и не выполняет публикацию', async () => {
  git.setGitAvailable(true);
  await gitUi.onGitCallback(lowState, press('gt:push', low));
  assert.deepEqual(acks(take()), [t('files.noRights', lang)]);
  await gitUi.onGitCallback(lowState, press('gt:pb', low));
  assert.deepEqual(acks(take()), [t('files.noRights', lang)]);
});

const hasGit = spawnSync('git', ['--version']).status === 0;

test('общий корень, уровень Чтение: агент не получает кнопки push/pull даже с подключённым аккаунтом', { skip: hasGit ? false : 'git не установлен' }, async () => {
  const gitProject = join(root, 'with-remote');
  mkdirSync(gitProject, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: gitProject }).status, 0);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/acpgram.git'], { cwd: gitProject }).status, 0);
  ctx.db.saveGitAccount(low, { host: 'github', login: 'low', name: 'Low', email: 'low@example.com', token: 'ghp_test0123456789' });
  state.saveProject(lowState, gitProject);

  await gitUi.offerGitActions(lowState, ['push', 'pull']);
  const calls = take();
  assert.equal(toUser(calls, low), t('git.offer.noAccount', lang));
  assert.deepEqual(buttons(calls).map((b) => b.callback_data), ['ui:git']);
  ctx.db.deleteGitAccount(low, 'github');
});

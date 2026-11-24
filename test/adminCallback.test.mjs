import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-admin-callback-')));
const root = join(home, 'projects');
mkdirSync(root, { recursive: true });
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.ALLOWED_USER_ID = '91001';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.DEFAULT_ENGINE = 'gemini';
delete process.env.USER_WORKSPACES;
delete process.env.AGENT_SANDBOX;
delete process.env.ADMIN_SANDBOX;
delete process.env.GIT_AGENT_AUTH;

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  sent.push({ method: String(url).split('/').pop(), body: init.body ? JSON.parse(init.body) : {} });
  return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
};

const ctx = await import('../src/ctx.mjs');
const state = await import('../src/state.mjs');
const admin = await import('../src/admin.mjs');
const access = await import('../src/access.mjs');
const engines = await import('../src/engines.mjs');
const { t } = await import('../src/i18n.mjs');

const ADMIN = ctx.ADMIN_ID;
const lang = 'en';
const idOf = (n) => ADMIN + n;
const from = (id) => ({ id, username: `user${id}`, first_name: `User${id}`, language_code: lang });
const press = (data) => ({ id: 'cb', data, message: { chat: { id: ADMIN }, message_id: 9 } });
const take = () => sent.splice(0);
const callsOf = (calls, method) => calls.filter((c) => c.method === method);
const acks = (calls) => callsOf(calls, 'answerCallbackQuery').map((c) => c.body.text ?? '');
const edits = (calls) => callsOf(calls, 'editMessageText');
const toUser = (calls, id) => callsOf(calls, 'sendMessage').filter((c) => c.body.chat_id === id).map((c) => c.body.text).join('\n');
const buttons = (calls) => calls.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();
const callbackOf = (calls, prefix) => buttons(calls).find((b) => b.callback_data?.startsWith(prefix))?.callback_data;

ctx.setLang(ADMIN, lang);
ctx.botInfo.username = 'acpgram_test_bot';

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const member = idOf(10);
const requester = idOf(11);
const rejected = idOf(12);
const extra = Object.keys(engines.ENGINES).find((id) => id !== engines.DEFAULT_ENGINE);

ctx.db.upsertUser({ user_id: member, username: 'member', first_name: 'Member', level: 'normal', added_by: ADMIN });
ctx.setLang(member, lang);
ctx.db.setSetting(`catalog:${extra}`, JSON.stringify({ models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }], at: new Date().toISOString() }));

test('adm:i — приглашение создаётся и редактирует сообщение администратору', async () => {
  await admin.onAdminCallback(press('adm:i:normal'));
  let calls = take();
  assert.deepEqual(acks(calls), ['']);
  const text = edits(calls)[0]?.body.text ?? '';
  assert.ok(text.includes(t('adm.inviteMade', lang, { level: ctx.levelName('normal', lang), bot: ctx.botInfo.username, code: '' }).split('?start=')[0]));

  await admin.onAdminCallback(press('adm:i:wrong'));
  calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.deepEqual(edits(calls), []);
});

test('adm:g и adm:d — решение по запросу доступа', async () => {
  ctx.db.saveRequest(from(requester));
  await admin.onAdminCallback(press(`adm:g:${requester}:full`));
  let calls = take();
  assert.equal(ctx.db.getUser(requester)?.level, 'full');
  assert.equal(ctx.db.getRequest(requester)?.status, 'approved');
  assert.ok(toUser(calls, requester).includes(ctx.levelName('full', lang)));
  assert.ok(edits(calls)[0]?.body.text.includes(ctx.levelName('full', lang)));

  ctx.db.saveRequest(from(rejected));
  await admin.onAdminCallback(press(`adm:d:${rejected}`));
  calls = take();
  assert.equal(ctx.db.getRequest(rejected)?.status, 'rejected');
  assert.equal(toUser(calls, rejected), t('access.rejectedByAdmin', lang));
  assert.equal(ctx.db.getUser(rejected), null);
});

test('adm:list, adm:act и adm:us — административные экраны открываются редактированием', async () => {
  let usageText = null;
  for (const [data, button] of [['adm:list', `adm:u:${member}`], ['adm:act', 'adm:act'], ['adm:us:1', 'adm:us:7']]) {
    await admin.onAdminCallback(press(data));
    const calls = take();
    assert.deepEqual(acks(calls), ['']);
    assert.ok(edits(calls).length, `${data} редактирует сообщение`);
    assert.ok(callbackOf(calls, button), `${data} показывает кнопку ${button}`);
    if (data === 'adm:us:1') usageText = edits(calls)[0]?.body.text;
  }

  await admin.onAdminCallback(press('adm:us:999'));
  assert.equal(edits(take())[0]?.body.text, usageText);
});

test('adm:u — карточка сотрудника с кнопками уровня и моделей', async () => {
  await admin.onAdminCallback(press(`adm:u:${member}`));
  const calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.equal(callbackOf(calls, `adm:l:${member}:`), `adm:l:${member}:read`);
  assert.equal(callbackOf(calls, `adm:mm:${member}`), `adm:mm:${member}`);
});

test('adm:k — завершение сессии и возврат на экран /active', async () => {
  const st = state.getState(member, member);
  let closed = false;
  st.agent = {
    engine: { id: engines.DEFAULT_ENGINE },
    closed: false,
    sessionId: 's1',
    close() {
      closed = true;
      this.closed = true;
    },
    cancel() {},
  };

  await admin.onAdminCallback(press(`adm:k:${member}:a`));
  const calls = take();
  assert.equal(closed, true);
  assert.deepEqual(acks(calls), [t('adm.ackKilled', lang)]);
  assert.ok(toUser(calls, member).includes(t('adm.killedByAdmin', lang)));
  assert.equal(callbackOf(calls, 'adm:act'), 'adm:act');
});

test('adm:et и adm:mm — выдача движка и обзор прав на модели', async () => {
  await admin.onAdminCallback(press(`adm:et:${member}:${extra}`));
  let calls = take();
  assert.ok(access.grantedEngines(member).includes(extra));
  assert.deepEqual(acks(calls), [t('adm.ackEngineOn', lang, { engine: engines.ENGINES[extra].label })]);
  assert.ok(toUser(calls, member).includes(t('access.engineGranted', lang, { engine: engines.ENGINES[extra].label })));
  assert.ok(callbackOf(calls, `adm:mm:${member}`));

  await admin.onAdminCallback(press(`adm:mm:${member}`));
  calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.ok(edits(calls)[0]?.body.text.includes(t('adm.modelsTitle', lang, { name: '@member' })));
  assert.equal(callbackOf(calls, `adm:me:${member}:${extra}`), `adm:me:${member}:${extra}`);
});

test('adm:me, adm:mt, adm:ma, adm:mg и adm:ms — экраны и переключатели моделей', async () => {
  await admin.onAdminCallback(press(`adm:me:${member}:${extra}`));
  let calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.equal(callbackOf(calls, `adm:mt:${member}:${extra}:`), `adm:mt:${member}:${extra}:m1`);

  await admin.onAdminCallback(press(`adm:mt:${member}:${extra}:m1`));
  calls = take();
  assert.deepEqual(access.modelRestriction(member, extra), ['m2']);
  assert.deepEqual(acks(calls), ['']);
  assert.ok(edits(calls)[0]?.body.text.includes(t('adm.modelsSome', lang, { a: 1, t: 2 })));

  await admin.onAdminCallback(press(`adm:ma:${member}:${extra}`));
  calls = take();
  assert.equal(access.modelRestriction(member, extra), null);
  assert.deepEqual(acks(calls), [t('adm.ackModelsAll', lang)]);

  await admin.onAdminCallback(press(`adm:mg:${member}:${extra}:group:3`));
  calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.ok(edits(calls).length);

  await admin.onAdminCallback(press(`adm:ms:${member}:${extra}:group:vendor:2`));
  calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.ok(edits(calls).length);
});

test('adm:l — смена уровня и уведомление сотруднику', async () => {
  await admin.onAdminCallback(press(`adm:l:${member}:read`));
  const calls = take();
  assert.equal(ctx.db.getUser(member)?.level, 'read');
  assert.deepEqual(acks(calls), [t('adm.ackLevelChanged', lang)]);
  assert.ok(toUser(calls, member).includes(ctx.levelName('read', lang)));
  assert.ok(buttons(calls).find((b) => b.callback_data === `adm:l:${member}:read`)?.text?.startsWith('✓'));
});

test('adm:r и adm:ro — подтверждение и отзыв доступа', async () => {
  await admin.onAdminCallback(press(`adm:r:${member}`));
  let calls = take();
  assert.deepEqual(acks(calls), ['']);
  assert.ok(edits(calls)[0]?.body.text.includes(t('adm.revokeAsk', lang, { name: '@member' }).split('\n')[0]));
  assert.equal(callbackOf(calls, `adm:ro:${member}`), `adm:ro:${member}`);

  await admin.onAdminCallback(press(`adm:ro:${member}`));
  calls = take();
  assert.equal(ctx.db.getUser(member)?.status, 'revoked');
  assert.deepEqual(acks(calls), [t('adm.ackRevoked', lang)]);
  assert.equal(toUser(calls, member), t('access.revoked', lang));
  assert.equal(callbackOf(calls, `adm:u:${member}`), undefined);
});

test('неизвестное действие adm:* сохраняет поведение dispatch', async () => {
  const other = idOf(20);
  ctx.db.upsertUser({ user_id: other, username: 'other', first_name: 'Other', level: 'normal', added_by: ADMIN });
  ctx.setLang(other, lang);

  await admin.onAdminCallback(press(`adm:zz:${other}`));
  assert.deepEqual(take(), []);

  await admin.onAdminCallback(press('adm:zz:999999'));
  const calls = take();
  assert.deepEqual(acks(calls), [t('adm.ackNoUser', lang)]);
  assert.ok(edits(calls).length);
});

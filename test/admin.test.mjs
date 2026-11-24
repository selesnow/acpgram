// Управление доступом (admin.mjs): отзыв доступа и смена уровня не сообщают об успехе, если запись в базу не прошла.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-admin-')));
process.env.ACPGRAM_HOME = home;
delete process.env.PROJECTS_ROOT;
delete process.env.AGENT_SANDBOX;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

// Telegram в тестах не вызывается: запросы складываются в sent
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  sent.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
};
const take = () => sent.splice(0);
const acks = (calls) => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text ?? '');

const ctx = await import('../src/ctx.mjs');
const { handleUnknownUser, onAdminCallback } = await import('../src/admin.mjs');
const { t } = await import('../src/i18n.mjs');

const ADMIN = ctx.ADMIN_ID;
const USER = ADMIN === 4001 ? 4002 : 4001;
const press = (data) => ({ id: 'cb', data, message: { chat: { id: ADMIN }, message_id: 7 } });
const lang = ctx.langOf(ADMIN);

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  rmSync(home, { recursive: true, force: true });
});

test('отзыв доступа: при ошибке записи в базу доступ остаётся и администратору об этом сказано', async () => {
  ctx.db.upsertUser({ user_id: USER, username: 'bob', first_name: 'Bob', level: 'normal', added_by: ADMIN });
  const realRevoke = ctx.db.revokeUser;
  ctx.db.revokeUser = () => null; // так обёртка базы отвечает на любую ошибку записи (диск полон, база занята)
  try {
    await onAdminCallback(press(`adm:ro:${USER}`));
  } finally {
    ctx.db.revokeUser = realRevoke;
  }
  let calls = take();
  assert.equal(ctx.db.getUser(USER).status, 'active');
  assert.deepEqual(acks(calls), [t('access.saveFail', lang)], 'вместо «доступ отозван» — сообщение об ошибке');
  assert.equal(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === USER), false, 'сотруднику про отзыв не пишем');

  await onAdminCallback(press(`adm:ro:${USER}`));
  calls = take();
  assert.equal(ctx.db.getUser(USER).status, 'revoked', 'обычный отзыв работает как раньше');
  assert.ok(calls.some((c) => c.method === 'sendMessage' && c.body.chat_id === USER));
});

test('смена уровня: при ошибке записи в базу уровень прежний и сессии не закрываются', async () => {
  ctx.db.upsertUser({ user_id: USER, username: 'bob', first_name: 'Bob', level: 'normal', added_by: ADMIN });
  const realSet = ctx.db.setUserLevel;
  ctx.db.setUserLevel = () => null;
  try {
    await onAdminCallback(press(`adm:l:${USER}:full`));
  } finally {
    ctx.db.setUserLevel = realSet;
  }
  assert.equal(ctx.db.getUser(USER).level, 'normal');
  assert.deepEqual(acks(take()), [t('access.saveFail', lang)]);

  await onAdminCallback(press(`adm:l:${USER}:full`));
  assert.equal(ctx.db.getUser(USER).level, 'full', 'обычная смена уровня работает как раньше');
  take();
});

test('незнакомец: повторные сообщения за пять минут не отправляются и администратору', async () => {
  const stranger = ADMIN === 4003 ? 4004 : 4003;
  const from = { id: stranger, username: 'stranger', first_name: 'Stranger', language_code: 'en' };
  take();
  await handleUnknownUser(from, stranger, 'please');
  const first = take();
  assert.equal(first.filter((c) => c.method === 'sendMessage' && c.body.chat_id === stranger).length, 1);
  assert.equal(first.filter((c) => c.method === 'sendMessage' && c.body.chat_id === ADMIN).length, 1);
  await handleUnknownUser(from, stranger, 'again');
  assert.deepEqual(take(), []);
});

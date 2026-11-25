import assert from 'node:assert/strict';
import { test } from 'node:test';
import { btnText, cancelRow, cbCtx, dropMessage, fmtDate } from '../src/uiActions.mjs';

const cb = { id: '77', message: { chat: { id: 42 }, message_id: 13 } };
const st = { chatId: 42, to: 42 };

function recorder() {
  const calls = [];
  return { calls, api: async (method, payload) => ({ method, payload, calls: calls.push({ method, payload }) }) };
}

function failing(message = 'boom') {
  return async () => {
    throw new Error(message);
  };
}

test('cbCtx.ack: alert только для непустого текста', async () => {
  const first = recorder();
  await cbCtx(st, cb, { api: first.api, alert: true }).ack('сохранено');
  assert.deepEqual(first.calls, [{ method: 'answerCallbackQuery', payload: { callback_query_id: '77', text: 'сохранено', show_alert: true } }]);

  const second = recorder();
  await cbCtx(st, cb, { api: second.api, alert: true }).ack('');
  assert.deepEqual(second.calls, [{ method: 'answerCallbackQuery', payload: { callback_query_id: '77' } }]);
});

test('cbCtx.edit: HTML и reply_markup по умолчанию', async () => {
  const plain = recorder();
  await cbCtx(st, cb, { api: plain.api }).edit('текст');
  assert.deepEqual(plain.calls[0].payload, { chat_id: 42, message_id: 13, text: 'текст', reply_markup: { inline_keyboard: [] } });

  const html = recorder();
  const markup = { inline_keyboard: [[{ text: 'Ок', callback_data: 'ok' }]] };
  await cbCtx(st, cb, { api: html.api, html: true }).edit({ text: '<b>текст</b>', markup });
  assert.deepEqual(html.calls[0].payload, { chat_id: 42, message_id: 13, text: '<b>текст</b>', parse_mode: 'HTML', reply_markup: markup });
});

test('cbCtx.edit: подавление message is not modified без cookies', async () => {
  const logs = [];
  await cbCtx(st, cb, { api: failing('message is not modified'), notModified: true, label: 'menu:', logger: (...a) => logs.push(a) }).edit('текст');
  assert.deepEqual(logs, []);
});

test('cbCtx.edit: loose подавляет короткое not modified', async () => {
  const strict = [];
  await cbCtx(st, cb, { api: failing('not modified'), notModified: true, label: 'strict:', logger: (...a) => strict.push(a) }).edit('текст');
  assert.equal(strict.length, 1);

  const loose = [];
  await cbCtx(st, cb, { api: failing('Not modified'), notModified: 'loose', label: 'loose:', logger: (...a) => loose.push(a) }).edit('текст');
  assert.deepEqual(loose, []);
});

test('cbCtx.edit: fallback-функция получает текст, разметку и вид', async () => {
  const view = { text: 'текст', markup: { inline_keyboard: [] } };
  const markup = { inline_keyboard: [[{ text: 'Назад', callback_data: 'back' }]] };
  let got;
  const result = await cbCtx(st, cb, { api: failing(), fallback: (text, replyMarkup, original) => (got = { text, replyMarkup, original }, 'fallback') }).edit(view, markup);
  assert.equal(result, 'fallback');
  assert.equal(got.text, 'текст');
  assert.deepEqual(got.replyMarkup, markup);
  assert.equal(got.original, view);
});

test('cbCtx.edit: fallback-объект уходит в say', async () => {
  const sends = [];
  const send = (to, text, extra) => (sends.push({ to, text, extra }), 'sent');
  const result = await cbCtx(st, cb, { api: failing(), send, fallback: { parse_mode: 'HTML' } }).edit('текст');
  assert.equal(result, 'sent');
  assert.deepEqual(sends, [{ to: 42, text: 'текст', extra: { parse_mode: 'HTML' } }]);
});

test('cbCtx.edit: richHtml уходит в rich_message, при ошибке откатывается на text или onRichError', async () => {
  const ok = recorder();
  const markup = { inline_keyboard: [[{ text: 'Назад', callback_data: 'back' }]] };
  await cbCtx(st, cb, { api: ok.api, html: true }).edit({ richHtml: '<p>hi</p><blockquote expandable><pre>a</pre></blockquote>', text: 'hi', markup });
  assert.deepEqual(ok.calls[0].payload, { chat_id: 42, message_id: 13, rich_message: { html: '<p>hi</p><blockquote expandable><pre>a</pre></blockquote>' }, reply_markup: markup });

  const calls = [];
  const apiFailRich = async (method, payload) => {
    calls.push({ method, payload });
    if (payload.rich_message) throw new Error('Bad Request: rich rejected');
    return {};
  };
  await cbCtx(st, cb, { api: apiFailRich, html: true }).edit({ richHtml: '<p>hi</p>', text: '<b>hi</b>', markup });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.text, '<b>hi</b>');
  assert.equal(calls[1].payload.parse_mode, 'HTML');

  let richErr = null;
  await cbCtx(st, cb, { api: failing('rich fail'), html: true }).edit({ richHtml: '<p>hi</p>', markup, onRichError: (e) => (richErr = e.message) });
  assert.equal(richErr, 'rich fail');
});

test('btnText: обрезка по символам, а не по половинке эмодзи', () => {
  assert.equal(btnText(null), '');
  assert.equal(btnText('🙂abcdef', 3), '🙂ab');
  assert.equal(btnText('abcdef', 2), 'ab');
});

test('cancelRow: одна кнопка с нужным префиксом и языком', () => {
  assert.deepEqual(cancelRow('fl', 'ru'), { inline_keyboard: [[{ text: 'Отмена', callback_data: 'fl:x' }]] });
  assert.deepEqual(cancelRow('gt', 'en'), { inline_keyboard: [[{ text: 'Cancel', callback_data: 'gt:x' }]] });
  assert.deepEqual(cancelRow('nav', 'uk'), { inline_keyboard: [[{ text: 'Скасувати', callback_data: 'nav:x' }]] });
});

test('fmtDate: локаль, год, время и пустое значение', () => {
  const iso = '2024-03-04T05:06:00Z';
  assert.equal(fmtDate('', 'en'), '—');
  assert.equal(fmtDate('не дата', 'en'), '—');
  assert.equal(fmtDate(iso, 'xx'), fmtDate(iso, 'en'));
  assert.equal(fmtDate(iso, 'uk'), new Date(iso).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' }));
  assert.ok(!fmtDate(iso, 'ru', { year: false }).includes('2024'));
  assert.equal(fmtDate(iso, 'en', { time: true }), new Date(iso).toLocaleString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
  assert.equal(fmtDate(iso, 'en', { empty: 'нет' }), new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }));
});

test('dropMessage: без id не зовёт API, с id удаляет в чате состояния', async () => {
  const calls = [];
  const api = async (method, payload) => (calls.push({ method, payload }), {});
  assert.equal(dropMessage(st, null, { api }), null);
  assert.deepEqual(calls, []);
  await dropMessage(st, 99, { api });
  assert.deepEqual(calls, [{ method: 'deleteMessage', payload: { chat_id: 42, message_id: 99 } }]);
});

test('dropMessage: ошибка удаления пишется в журнал с подписью', async () => {
  const logs = [];
  await dropMessage(st, 99, { api: failing(), label: 'files: сообщение не удалено:', logger: (...a) => logs.push(a) });
  assert.deepEqual(logs, [['files: сообщение не удалено:', 'boom']]);
});

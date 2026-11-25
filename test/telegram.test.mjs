import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramError, callApi, sendBuffer, sendRich } from '../src/telegram.mjs';

/** Поддельный fetch: отдаёт ответы по очереди и считает вызовы. */
const fakeFetch = (...replies) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    return { json: async () => r };
  };
  return { impl, calls };
};
const json = () => ({ body: '{}' });

test('callApi: после 429 ждёт retry_after и повторяет', async () => {
  const f = fakeFetch({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } }, { ok: true, result: 42 });
  assert.equal(await callApi('sendMessage', json, { fetchImpl: f.impl }), 42);
  assert.equal(f.calls.length, 2);
});

test('callApi: повторов не больше retries, долгий retry_after и другие ошибки — сразу ошибка', async () => {
  const busy = { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } };
  let f = fakeFetch(busy);
  await assert.rejects(callApi('sendMessage', json, { fetchImpl: f.impl, retries: 2 }), (e) => e instanceof TelegramError && e.code === 429);
  assert.equal(f.calls.length, 3);

  f = fakeFetch({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 600 } });
  await assert.rejects(callApi('sendMessage', json, { fetchImpl: f.impl }), /429/);
  assert.equal(f.calls.length, 1, 'ждать 10 минут не будем');

  f = fakeFetch({ ok: false, error_code: 400, description: 'Bad Request: can\'t parse' });
  await assert.rejects(callApi('sendMessage', json, { fetchImpl: f.impl }), (e) => e.code === 400);
  assert.equal(f.calls.length, 1);

  f = fakeFetch(busy, { ok: true, result: 1 });
  await assert.rejects(callApi('sendMessageDraft', json, { fetchImpl: f.impl, retries: 0 }), /429/);
  assert.equal(f.calls.length, 1, 'черновики не повторяются');
});

test('callApi: нет ответа — понятная ошибка по тайм-ауту, без повтора', async () => {
  const f = fakeFetch('hang');
  const t0 = Date.now();
  // таймер AbortSignal.timeout не удерживает процесс (в Node 22 тест иначе обрывается раньше времени);
  // в боте процесс держит длинный опрос Telegram, здесь — обычный таймер на время теста
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(callApi('getUpdates', json, { fetchImpl: f.impl, timeoutMs: 200 }), /getUpdates: нет ответа за 0 с/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(f.calls.length, 1);
});

test('callApi: тело запроса собирается заново для повтора', async () => {
  let built = 0;
  const f = fakeFetch({ ok: false, error_code: 429, description: 'x', parameters: { retry_after: 0 } }, { ok: true, result: true });
  await callApi('sendDocument', () => (built++, { body: 'x' }), { fetchImpl: f.impl });
  assert.equal(built, 2);
});

test('callApi: retryTransient повторяет 5xx и сетевую ошибку, но не тайм-аут', async () => {
  const f = fakeFetch({ ok: false, error_code: 500, description: 'Server Error' }, { ok: true, result: 'ok' });
  assert.equal(await callApi('sendMessage', json, { fetchImpl: f.impl, retryTransient: true }), 'ok');
  assert.equal(f.calls.length, 2);

  let n = 0;
  const network = async () => {
    if (++n === 1) throw new TypeError('fetch failed');
    return { json: async () => ({ ok: true, result: 7 }) };
  };
  assert.equal(await callApi('sendRichMessage', json, { fetchImpl: network, retryTransient: true }), 7);
  assert.equal(n, 2);

  const hang = fakeFetch('hang');
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    await assert.rejects(callApi('sendRichMessage', json, { fetchImpl: hang.impl, retryTransient: true, timeoutMs: 100 }), /нет ответа/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(hang.calls.length, 1, 'после тайм-аута не повторяем — сообщение могло дойти');
});

test('sendRich: обычным текстом отправляем только после 400, при 5xx ошибка уходит вызывающему', async () => {
  const server = fakeFetch({ ok: false, error_code: 500, description: 'Server Error' });
  await assert.rejects(sendRich(42, '**ответ**', { fetchImpl: server.impl, retries: 0 }), /500/);
  assert.deepEqual(server.calls.map((c) => c.url.split('/').pop()), ['sendRichMessage'], 'plain-дубля не отправляем');

  const bad = fakeFetch({ ok: false, error_code: 400, description: 'can\'t parse' }, { ok: true, result: {} });
  await sendRich(42, '**ответ**', { fetchImpl: bad.impl, retries: 0 });
  assert.deepEqual(bad.calls.map((c) => c.url.split('/').pop()), ['sendRichMessage', 'sendMessage']);
});

test('sendRich: reply-клавиатура уходит с rich-сообщением и с обычным текстом при откате', async () => {
  const markup = { keyboard: [[{ text: 'Help' }]], resize_keyboard: true };
  const ok = fakeFetch({ ok: true, result: {} });
  await sendRich(42, '**ответ**', { fetchImpl: ok.impl, reply_markup: markup });
  assert.deepEqual(JSON.parse(ok.calls[0].init.body).reply_markup, markup);

  const bad = fakeFetch({ ok: false, error_code: 400, description: "can't parse" }, { ok: true, result: {} });
  await sendRich(42, '**ответ**', { fetchImpl: bad.impl, reply_markup: markup });
  assert.deepEqual(JSON.parse(bad.calls[1].init.body).reply_markup, markup);
});

test('sendBuffer: документ уходит из памяти без обращения к файлу', async () => {
  const f = fakeFetch({ ok: true, result: { message_id: 1 } });
  assert.equal((await sendBuffer(42, Buffer.from('diff'), 'change.diff', { fetchImpl: f.impl })).message_id, 1);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /sendDocument$/);
  const form = f.calls[0].init.body;
  assert.ok(form instanceof FormData);
  const file = form.get('document');
  assert.equal(file.name, 'change.diff');
  assert.equal(await file.text(), 'diff');
});

test('isNotModified: правка сообщения тем же содержимым — не ошибка', async () => {
  const { isNotModified } = await import('../src/telegram.mjs');
  assert.equal(isNotModified(new Error('Telegram editMessageText: 400 Bad Request: message is not modified: specified new message content…')), true);
  assert.equal(isNotModified(new Error('Telegram editMessageText: 400 Bad Request: message to edit not found')), false);
  assert.equal(isNotModified(null), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramError, callApi } from '../src/telegram.mjs';

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

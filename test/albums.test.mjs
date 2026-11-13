import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlbumBuffer } from '../src/albums.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('альбом: элементы одной группы отдаются вместе после паузы, группы не смешиваются', async () => {
  const flushed = [];
  const buf = createAlbumBuffer({ waitMs: 40, onFlush: (key, items) => flushed.push([key, items]) });
  buf.add('1:a', 'фото 1');
  buf.add('2:b', 'чужое фото');
  await wait(20);
  buf.add('1:a', 'фото 2'); // сбрасывает таймер группы a
  assert.equal(buf.size, 2);
  await wait(30);
  assert.deepEqual(flushed.map((f) => f[0]), ['2:b'], 'группа b ушла раньше, группа a ещё ждёт');
  buf.add('1:a', 'фото 3');
  await wait(80);
  assert.deepEqual(flushed.find((f) => f[0] === '1:a')[1], ['фото 1', 'фото 2', 'фото 3']);
  assert.equal(flushed.length, 2);
  assert.equal(buf.size, 0);
});

test('альбом: после отправки та же группа начинает новый набор', async () => {
  const flushed = [];
  const buf = createAlbumBuffer({ waitMs: 20, onFlush: (_, items) => flushed.push(items) });
  buf.add('k', 1);
  await wait(60);
  buf.add('k', 2);
  await wait(60);
  assert.deepEqual(flushed, [[1], [2]]);
});

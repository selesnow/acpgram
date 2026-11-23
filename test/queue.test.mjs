import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueue } from '../src/queue.mjs';

test('queue: не больше limit задач, порядок очереди и ошибки не ломают остальные', async () => {
  const q = createQueue(2);
  const events = [];
  const run = (name, ms, fail = false) => q.add(async () => {
    events.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, ms));
    if (fail) throw new Error(name);
    events.push(`end:${name}`);
    return name;
  });
  const a = run('a', 20);
  const b = run('b', 5, true);
  const c = run('c', 5);
  const d = run('d', 1);
  assert.equal(q.active, 2);
  assert.equal(q.size, 2);
  assert.equal(await a, 'a');
  await assert.rejects(b, /b/);
  assert.equal(await c, 'c');
  assert.equal(await d, 'd');
  assert.deepEqual(events.slice(0, 2), ['start:a', 'start:b']);
  assert.equal(q.active, 0);
  assert.equal(q.size, 0);
});

test('queue: некорректный limit — одна задача', async () => {
  for (const n of [0, -1, NaN, undefined]) {
    const q = createQueue(n);
    assert.equal(await q.add(() => 42), 42);
  }
});

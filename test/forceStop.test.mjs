import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearStopTimer, forceStopAfter } from '../src/forceStop.mjs';

test('forceStopAfter: закрывает агента, если ход не завершился за ms', () => {
  const calls = [];
  let scheduled = null;
  const st = { busy: true, turnId: 'turn-1', agent: { closed: false } };
  const cancel = forceStopAfter(st, {
    ms: 5000,
    setTimer: (fn, ms) => {
      calls.push(['set', ms]);
      scheduled = fn;
      return { unref() {}, id: 1 };
    },
    clearTimer: (timer) => calls.push(['clear', timer.id]),
    kill: (agent) => calls.push(['kill', agent === st.agent]),
  });
  assert.deepEqual(calls, [['set', 5000]]);
  scheduled();
  assert.deepEqual(calls, [['set', 5000], ['kill', true]]);
  assert.equal(st.stopTimer, null);
  cancel();
});

test('forceStopAfter: не трогает завершившийся или другой ход', () => {
  const killed = [];
  let scheduled;
  const st = { busy: true, turnId: 'turn-1', agent: {} };
  forceStopAfter(st, {
    setTimer: (fn) => {
      scheduled = fn;
      return { unref() {} };
    },
    clearTimer: () => {},
    kill: (a) => killed.push(a),
  });
  st.turnId = 'turn-2';
  scheduled();
  assert.deepEqual(killed, []);
  st.turnId = 'turn-1';
  scheduled();
  assert.deepEqual(killed, [st.agent]);
});

test('forceStopAfter и clearStopTimer: нет агента или таймера — ничего не делаем', () => {
  const st = { busy: false, agent: null };
  assert.equal(forceStopAfter(st)(), undefined);
  clearStopTimer(st);
  assert.equal(st.stopTimer, null);
});

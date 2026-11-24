import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regQuery } from '../src/winReg.mjs';

test('regQuery: общий запуск reg.exe с нужными аргументами и параметрами', () => {
  const calls = [];
  const result = regQuery(['query', 'K', '/v', 'N'], {
    exe: 'C:\\Windows\\System32\\reg.exe',
    encoding: 'utf8',
    timeout: 3000,
    spawn: (exe, args, options) => (calls.push({ exe, args, options }), { status: 0, stdout: 'ok' }),
  });
  assert.deepEqual(result, { status: 0, stdout: 'ok' });
  assert.deepEqual(calls, [{
    exe: 'C:\\Windows\\System32\\reg.exe',
    args: ['query', 'K', '/v', 'N'],
    options: { windowsHide: true, encoding: 'utf8', timeout: 3000 },
  }]);
});

test('regQuery: без кодировки вывод остаётся байтами, тайм-аут не навязывается', () => {
  let options;
  regQuery(['query', 'K'], {
    exe: 'reg',
    encoding: null,
    spawn: (_exe, _args, opts) => ((options = opts), { status: 0, stdout: Buffer.from('ok') }),
  });
  assert.deepEqual(options, { windowsHide: true });
});

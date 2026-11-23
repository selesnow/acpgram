import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envAclRisk, protectWindowsPath } from '../src/protect.mjs';

test('protectWindowsPath: на Windows снимает наследование и оставляет только служебные учётные записи', () => {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = protectWindowsPath('C:\\app\\.env', { platform: 'win32', env: { USERNAME: 'User' }, run });
  assert.equal(r.status, 0);
  assert.deepEqual(calls[0].args.slice(1), ['/inheritance:r', '/grant:r', '.\\User:F', 'SYSTEM:F', 'Administrators:F']);
  protectWindowsPath('C:\\app\\data', { directory: true, platform: 'win32', env: { USERDOMAIN: 'CORP', USERNAME: 'User' }, run });
  assert.deepEqual(calls[1].args.slice(3), ['CORP\\User:(OI)(CI)F', 'SYSTEM:(OI)(CI)F', 'Administrators:(OI)(CI)F']);
  assert.equal(protectWindowsPath('/home/a/.env', { platform: 'linux', run }), null);
  assert.equal(calls.length, 2);
});

test('envAclRisk: широкие группы в ACL .env — риск, конкретная учётная запись — нет', () => {
  const risk = (stdout) => envAclRisk('C:\\app\\.env', { platform: 'win32', run: () => ({ status: 0, stdout, stderr: '' }) });
  assert.equal(risk('C:\\app\\.env BUILTIN\\Users:(I)(M)'), true);
  assert.equal(risk('C:\\app\\.env CORP\\User:(F)'), false);
  assert.equal(envAclRisk('/home/a/.env', { platform: 'linux', run: () => ({ status: 0, stdout: 'Users:(F)' }) }), false);
  assert.equal(envAclRisk('x', { platform: 'win32', run: () => ({ status: 1, stdout: 'Users:(F)', stderr: '' }) }), false);
});

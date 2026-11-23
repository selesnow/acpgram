import assert from 'node:assert/strict';
import { test } from 'node:test';
import { broadAclFromOutput, newWarningIds, safetyWarningIds } from '../src/safety.mjs';

test('safetyWarningIds: предупреждения только для реально опасных сочетаний', () => {
  assert.deepEqual(safetyWarningIds({ sandbox: false, activeUsers: true, adminSandbox: false, personalWorkspaces: false, aclRisk: true }), ['noSandbox', 'adminNoSandbox', 'broadAcl']);
  assert.deepEqual(safetyWarningIds({ sandbox: true, activeUsers: true, adminSandbox: false, personalWorkspaces: false, aclRisk: false }), ['adminNoSandbox']);
  assert.deepEqual(safetyWarningIds({ sandbox: true, activeUsers: true, adminSandbox: true, personalWorkspaces: false, aclRisk: false }), []);
  assert.deepEqual(safetyWarningIds({ sandbox: false, activeUsers: false, adminSandbox: false, personalWorkspaces: false, aclRisk: false }), []);
});

test('newWarningIds: каждое сочетание приходит администратору один раз', () => {
  assert.deepEqual(newWarningIds(['noSandbox', 'broadAcl', 'noSandbox'], ['noSandbox']), ['broadAcl']);
});

test('broadAclFromOutput: широкие группы и SID определяются, конкретные учётные записи — нет', () => {
  assert.equal(broadAclFromOutput('C:\\app\\.env BUILTIN\\Users:(I)(M)'), true);
  assert.equal(broadAclFromOutput('NT AUTHORITY\\Authenticated Users:(I)(RX)'), true);
  assert.equal(broadAclFromOutput('Everyone:(F)'), true);
  assert.equal(broadAclFromOutput('*S-1-1-0:(F)'), true);
  assert.equal(broadAclFromOutput('CORP\\User:(F)'), false);
  assert.equal(broadAclFromOutput(''), false);
});

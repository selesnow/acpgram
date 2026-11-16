import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINES } from '../src/engines.mjs';
import { SESSION_OPTION_ID, allowOnceOption, commandRoots, permissionKeys, rulesAllow, withSessionOption } from '../src/permRules.mjs';

test('commandRoots: имена программ составной команды', () => {
  assert.deepEqual(commandRoots('git status'), ['git']);
  assert.deepEqual(commandRoots(String.raw`cd /d C:\proj && "C:\R\bin\Rscript.exe" run.R 2>&1`), ['cd', 'rscript']);
  assert.deepEqual(commandRoots('git log | head -5; git status'), ['git', 'head']);
  assert.deepEqual(commandRoots('LANG=C sort a.txt > nul'), ['sort']);
  assert.deepEqual(commandRoots('npm test 2>/dev/null'), ['npm']);
  assert.deepEqual(commandRoots('& npm.cmd run lint'), ['npm']);
});

test('commandRoots: обёртки, подстановки и запись в файл — только точная команда', () => {
  for (const cmd of ['bash -c "rm -rf x"', 'powershell -Command Remove-Item x', 'cmd /c del x', 'sudo apt install x', 'echo $(rm -rf x)', 'echo `id`', 'echo x > important.txt', 'cat a >> b', 'git status && sh -c "x"', '', '   ']) {
    assert.equal(commandRoots(cmd), null, cmd);
  }
});

test('permissionKeys: команды по программам, правки целиком, прочее по виду и инструменту', () => {
  assert.deepEqual(permissionKeys({ kind: 'execute', command: 'git add . && git commit -m x' }), ['exec:git']);
  assert.deepEqual(permissionKeys({ kind: 'execute', command: 'bash -c "x"' }), ['exec=bash -c "x"']);
  assert.equal(permissionKeys({ kind: 'execute', command: '' }), null);
  assert.deepEqual(permissionKeys({ kind: 'edit', tool: 'Edit' }), ['kind:edit']);
  assert.deepEqual(permissionKeys({ kind: 'delete' }), ['kind:delete']);
  assert.deepEqual(permissionKeys({ kind: 'fetch', tool: 'WebFetch' }), ['tool:fetch:WebFetch']);
  assert.deepEqual(permissionKeys({ kind: 'other', tool: 'mcp__srv__do' }), ['tool:other:mcp__srv__do']);
  assert.equal(permissionKeys({}), null);
});

test('rulesAllow: все ключи запроса должны быть разрешены', () => {
  const rules = new Set(['exec:git', 'kind:edit']);
  assert.equal(rulesAllow(rules, ['exec:git']), true);
  assert.equal(rulesAllow(rules, ['exec:git', 'exec:rm']), false, 'git && rm — rm не разрешён');
  assert.equal(rulesAllow(rules, null), false);
  assert.equal(rulesAllow(undefined, ['exec:git']), false);
  assert.equal(rulesAllow(rules, []), false);
});

test('withSessionOption: Claude Code получает «на эту сессию» от бота сразу после «один раз»', () => {
  const claude = [{ optionId: 'allow-once', kind: 'allow_once', name: 'Yes' }, { optionId: 'reject', kind: 'reject_once', name: 'No' }];
  const out = withSessionOption(claude, ['exec:git'], ENGINES.claude.optionMode);
  assert.deepEqual(out.map((o) => o.optionId), ['allow-once', SESSION_OPTION_ID, 'reject']);
  assert.equal(out[1].kind, 'allow_always');
  assert.equal(allowOnceOption(out).optionId, 'allow-once');
});

test('withSessionOption: свой вариант агента, нет ключей, нет «один раз» или выход из плана — без варианта бота', () => {
  const ids = (l) => l.map((o) => o.optionId);
  const gemini = [{ optionId: 'proceed_once', kind: 'allow_once' }, { optionId: 'proceed_always', kind: 'allow_always' }, { optionId: 'cancel', kind: 'reject_once' }];
  assert.deepEqual(ids(withSessionOption(gemini, ['exec:git'])), ['proceed_once', 'proceed_always', 'cancel']);
  const claude = [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
  assert.deepEqual(ids(withSessionOption(claude, null)), ['allow-once', 'reject']);
  assert.deepEqual(ids(withSessionOption([{ optionId: 'reject', kind: 'reject_once' }], ['kind:edit'])), ['reject']);
  // выход из плана у Claude Code: варианты переключают режим — автоматически выбирать их нельзя
  const exitPlan = [{ optionId: 'exit-plan-default', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
  assert.deepEqual(ids(withSessionOption(exitPlan, ['tool:other:ExitPlanMode'], ENGINES.claude.optionMode)), ['exit-plan-default', 'reject']);
  assert.equal(allowOnceOption(exitPlan, ENGINES.claude.optionMode), null);
});

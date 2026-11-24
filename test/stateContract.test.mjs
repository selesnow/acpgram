import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-contract-')));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

const ctx = await import('../src/ctx.mjs');
const S = await import('../src/state.mjs');

after(() => {
  ctx.db.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const srcDir = new URL('../src/', import.meta.url);
const files = readdirSync(srcDir).filter((name) => name.endsWith('.mjs'));
const source = (name) => readFileSync(new URL(name, srcDir), 'utf8');
const names = (text, pattern) => [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];

test('STATE_FIELDS: Contains every dialog state field used in the source', () => {
  const ignored = new Set(['git.mjs', 'agentFiles.mjs', 'gitInspect.mjs', 'projectFiles.mjs']);
  const used = new Set();
  for (const name of files) {
    if (ignored.has(name)) continue;
    for (const field of names(source(name), /\bst\.([A-Za-z_$][\w$]*)/g)) used.add(field);
    for (const match of source(name).matchAll(/createKeyRegistry\(\{[^}]*scope:\s*'state'[^}]*field:\s*'([^']+)'/g)) used.add(match[1]);
  }
  assert.deepEqual([...used].filter((field) => !S.STATE_FIELDS.includes(field)), []);
  assert.equal(S.STATE_FIELDS.length, new Set(S.STATE_FIELDS).size);
  assert.ok(Object.isFrozen(S.STATE_FIELDS));
});

test('STATE_FIELDS: Covers newly created state', () => {
  const st = S.getState(9901, 9901, null);
  assert.deepEqual(Object.keys(st).filter((field) => !S.STATE_FIELDS.includes(field)), []);
});

test('AGENT_FIELDS: Contains every agent field used in the source', () => {
  const methods = new Set(['start', 'init', 'close', 'request', 'prompt', 'cancel']);
  const filesWithAgents = ['acp.mjs', 'access.mjs', 'engines.mjs', 'state.mjs', 'turn.mjs'];
  const used = new Set();
  for (const name of filesWithAgents) {
    const text = source(name);
    if (name === 'acp.mjs') for (const field of names(text, /\bthis\.([A-Za-z_$][\w$]*)/g)) if (!methods.has(field)) used.add(field);
    for (const field of names(text, /\b(?:a|agent)\.([A-Za-z_$][\w$]*)/g)) if (!methods.has(field)) used.add(field);
    if (/#finished\s*=/.test(text)) used.add('#finished');
  }
  assert.deepEqual([...used].filter((field) => !S.AGENT_FIELDS.includes(field)), []);
  assert.equal(S.AGENT_FIELDS.length, new Set(S.AGENT_FIELDS).size);
  assert.ok(Object.isFrozen(S.AGENT_FIELDS));
});

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupLogs, log, logError } from '../src/log.mjs';

test('log: добавляет отметку времени и обрезает длинные строки', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const calls = { log: [], error: [] };
  console.log = (...args) => calls.log.push(args);
  console.error = (...args) => calls.error.push(args);
  try {
    log('коротка строчка', { a: 1 });
    logError('x'.repeat(5000));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.match(calls.log[0][0], /^\d{4}-\d{2}-\d{2}T/);
  assert.match(calls.log[0][1], /коротка строчка \{ a: 1 \}/);
  assert.ok(calls.error[0][1].includes('обрезано'));
  assert.ok(calls.error[0][1].length < 2200);
});

test('cleanupLogs: удаляет только старые архивы debug.log и только при включённом сроке', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-logs-'));
  const old = join(dir, 'debug.log.1');
  const fresh = join(dir, 'debug.log.2');
  writeFileSync(old, 'old');
  writeFileSync(fresh, 'fresh');
  writeFileSync(join(dir, 'debug.log'), 'current');
  const longAgo = new Date(Date.now() - 10 * 86400_000);
  utimesSync(old, longAgo, longAgo);
  try {
    assert.equal(cleanupLogs(dir, 0), 0);
    assert.equal(cleanupLogs(dir, 7), 1);
    assert.equal(cleanupLogs(dir, 7), 0);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(join(dir, 'debug.log')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

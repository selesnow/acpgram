import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openVerified, readStable, updateNoFollow } from '../src/agentFiles.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'acpgram-agent-files-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('readStable: возвращает проверенный буфер', () => {
  const file = join(tmp, 'stable.txt');
  writeFileSync(file, 'данные');
  const r = readStable(file);
  assert.equal(r.ok, true);
  assert.equal(r.buffer.toString(), 'данные');
  assert.equal(r.size, Buffer.byteLength('данные'));
});

test('readStable: файл, подменённый между проверками, не отправляется', () => {
  const file = join(tmp, 'race.txt');
  writeFileSync(file, 'safe');
  let checks = 0;
  const r = readStable(file, {
    allowed: () => {
      checks++;
      if (checks === 2) writeFileSync(file, 'EVILX');
      return true;
    },
  });
  assert.deepEqual(r, { ok: false, reason: 'changed' });
});

test('openVerified: noFollow отвергает ссылку', () => {
  const outside = join(tmp, 'outside.txt');
  const link = join(tmp, 'link.txt');
  writeFileSync(outside, 'секрет');
  try {
    symlinkSync(outside, link);
  } catch (e) {
    if (e.code === 'EPERM') return;
    throw e;
  }
  try {
    assert.throws(() => openVerified(link, { noFollow: true }), (e) => e.code === 'link');
  } finally {
    unlinkSync(link);
  }
});

test('updateNoFollow: пишет обычный файл и не ходит по ссылке', () => {
  const repo = join(tmp, 'repo');
  mkdirSync(repo, { recursive: true });
  const file = join(repo, '.gitignore');
  writeFileSync(file, 'a');
  assert.equal(updateNoFollow(file, repo, (have) => `${have}${have && !have.endsWith('\n') ? '\n' : ''}/secret\n`), true);
  assert.equal(readFileSync(file, 'utf8'), 'a\n/secret\n');
  assert.equal(updateNoFollow(file, repo, () => 'a\n/secret\n'), false);

  const outside = join(tmp, 'outside.gitignore');
  writeFileSync(outside, 'TARGET');
  unlinkSync(file);
  try {
    symlinkSync(outside, file);
  } catch (e) {
    if (e.code === 'EPERM') return;
    throw e;
  }
  assert.throws(() => updateNoFollow(file, repo, () => 'evil'), (e) => e.code === 'link');
  assert.equal(readFileSync(outside, 'utf8'), 'TARGET');
});

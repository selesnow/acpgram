import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipLogLine, clipText } from '../src/clip.mjs';

test('clipText: короткий текст не меняется, длинный сохраняет начало и конец', () => {
  assert.equal(clipText('abc', 2, 2), 'abc');
  assert.equal(clipText('abcdefghij', 3, 2, '…'), 'abc…ij');
  assert.equal(clipText('abcdefghij', 4, 0, ' >>> '), 'abcd >>> ');
  assert.equal(clipText(null, 3, 3), 'null');
});

test('clipLogLine: длинные строки обрезаются, переводы строк сохраняются', () => {
  const long = 'x'.repeat(5000);
  const result = clipLogLine(`first\n${long}\nlast`, 100);
  const lines = result.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'first');
  assert.equal(lines[2], 'last');
  assert.ok(lines[1].includes('обрезано'));
  assert.ok(lines[1].startsWith('x'.repeat(50)));
  assert.ok(lines[1].endsWith('x'.repeat(50)));
});

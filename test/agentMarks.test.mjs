import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'acpgram-marks-'));
process.env.ACPGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

const F = await import('../src/files.mjs');
const A = await import('../src/asks.mjs');
const G = await import('../src/gitMarks.mjs');
const T = await import('../src/topics.mjs');

after(() => rmSync(home, { recursive: true, force: true }));

const FENCE = '`'.repeat(3);
const code = [
  'Примеры в коде:',
  '`[[send:/code.txt]]` `[[ask: Код]]` `[[git:pull]]` `[[title: Код]]`',
  FENCE,
  '[[send:/fenced.txt]]',
  '[[ask: Один]]',
  '[[git:push]]',
  '[[title: В блоке]]',
  FENCE,
].join('\n');

test('все четыре метки: порядок вызовов как в turn.mjs, код не трогается', () => {
  const answer = ['[[title: Отчёт за ноябрь]]', 'Вопрос:', '[[ask: Да | Нет]]', '[[git:push]]', '[[send:/o/report.pdf]]', code].join('\n');
  const titled = T.extractTitle(answer);
  assert.equal(titled.title, 'Отчёт за ноябрь');
  const gitted = G.extractGitMarks(titled.text);
  assert.deepEqual(gitted.actions, ['push']);
  const asked = A.extractAsks(gitted.text);
  assert.deepEqual(asked.asks, [['Да', 'Нет']]);
  const sent = F.extractSendMarks(asked.text, { placeholders: true });
  assert.deepEqual(sent.paths, ['/o/report.pdf']);
  for (const kept of ['`[[send:/code.txt]]`', '`[[ask: Код]]`', '`[[git:pull]]`', '`[[title: Код]]`', '[[send:/fenced.txt]]', '[[ask: Один]]', '[[git:push]]', '[[title: В блоке]]']) {
    assert.ok(sent.text.includes(kept), kept);
  }
});

test('несколько меток и дубликаты: send/git без повторов, ask без повторов вариантов, title только первый', () => {
  const send = F.extractSendMarks('[[send:/a]]\n[[send:/a]]\n[[send:/b]]', { placeholders: true });
  assert.deepEqual(send.paths, ['/a', '/b']);
  assert.equal(send.text.split('\u00000\u0000').length - 1, 1);
  assert.equal(send.text.split('\u00001\u0000').length - 1, 1);

  const ask = A.extractAsks('[[ask: A | A | B]]\n[[ask: C | D]]');
  assert.deepEqual(ask.asks, [['A', 'B'], ['C', 'D']]);
  assert.equal(ask.text.split('\u0001').length - 1, 4);

  const git = G.extractGitMarks('[[git:push]]\n[[GIT:PUSH]]\n[[git:pull]]');
  assert.deepEqual(git.actions, ['push', 'pull']);
  assert.equal(git.text, '');

  const title = T.extractTitle('[[title: А]]\nтекст [[title: Б]]');
  assert.equal(title.title, 'А');
  assert.ok(title.text.includes('[[title: Б]]'));
});

test('незавершённый хвост черновика убирается у всех четырёх меток, код не трогается', () => {
  for (const tail of ['[[send:/x', '[[send:/x]', '[[se', '[']) assert.equal(F.stripSendMarks(`Текст ${tail}`), 'Текст ', tail);
  for (const tail of ['[[ask: Да | Н', '[[as', '[']) assert.equal(A.stripAskMarks(`Текст ${tail}`), 'Текст ', tail);
  for (const [tail, shown] of [['[[git:pu', 'Текст '], ['[[g', 'Текст '], ['[[', 'Текст [[']]) assert.equal(G.stripGitMarks(`Текст ${tail}`), shown, tail);
  for (const tail of ['[', '[[', '[[tit', '[[title:', '[[title: Отчёт по']) assert.equal(T.stripTitle(tail), '', tail);
  assert.equal(F.stripSendMarks(`${FENCE}\n[[se`), `${FENCE}\n[[se`);
  assert.equal(A.stripAskMarks(`${FENCE}\n[[ask: a]]\n${FENCE}`), `${FENCE}\n[[ask: a]]\n${FENCE}`);
  assert.equal(G.stripGitMarks(`${FENCE}\n[[git:pu`), `${FENCE}\n[[git:pu`);
});

test('плейсхолдеры остаются \\u0000N\\u0000 и \\u0001N\\u0001', () => {
  assert.equal(F.filePlaceholder(3), '\u00003\u0000');
  assert.equal(F.extractSendMarks('[[send:/x]]', { placeholders: true }).text, '\u00000\u0000');
  assert.equal(A.extractAsks('[[ask: Да]]').text, '\u00010\u0001');
  assert.deepEqual(F.extractSendMarks('без меток'), { text: 'без меток', paths: [] });
});

test('порядок вызовов в turn.mjs не изменён', () => {
  const src = readFileSync(new URL('../src/turn.mjs', import.meta.url), 'utf8');
  const calls = ['extractTitle(', 'extractGitMarks(', 'extractAsks(', 'extractSendMarks('];
  const at = calls.map((name) => src.indexOf(name));
  assert.ok(at.every((i) => i >= 0));
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
});

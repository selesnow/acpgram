import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  IMAGE_BLOCK_MAX,
  buildPromptBlocks,
  cleanupOldFiles,
  describeAttachment,
  extractSendMarks,
  imageMimeOf,
  isImageMime,
  outboxDir,
  resolveSendable,
  safeFileName,
  saveUpload,
  attachFiles,
  filePlaceholder,
  isSecret,
  splitCode,
  stripSendMarks,
  uploadsDir,
} from '../src/files.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'acpgram-files-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('safeFileName: без путей, запрещённых символов и зарезервированных имён', () => {
  assert.equal(safeFileName('отчёт Q3.pdf'), 'отчёт Q3.pdf');
  assert.equal(safeFileName('..\\..\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a<b>c:d"e|f?g*.txt'), 'a_b_c_d_e_f_g_.txt');
  assert.equal(safeFileName('.env'), 'env');
  assert.equal(safeFileName('con.txt'), '_con.txt');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName(undefined, 'photo'), 'photo');
  const long = safeFileName('x'.repeat(300) + '.pdf');
  assert.ok(long.length <= 100 && long.endsWith('.pdf'));
});

test('типы изображений', () => {
  assert.equal(imageMimeOf('a.PNG'), 'image/png');
  assert.equal(imageMimeOf('a.pdf'), null);
  assert.ok(isImageMime('image/jpeg') && !isImageMime('application/pdf') && !isImageMime(undefined));
});

test('saveUpload: сохраняет с отметкой времени и не перезаписывает существующие файлы', () => {
  const dir = join(tmp, 'up');
  const d = new Date(2026, 10, 13, 9, 5, 7);
  const a = saveUpload(dir, 'a.txt', Buffer.from('1'), d);
  const b = saveUpload(dir, 'a.txt', Buffer.from('2'), d);
  assert.match(a, /20261113-090507_a\.txt$/);
  assert.notEqual(a, b);
  assert.equal(readFileSync(a, 'utf8'), '1');
  assert.equal(readFileSync(b, 'utf8'), '2');
  assert.ok(saveUpload(dir, '../../x.txt', Buffer.from('x'), d).startsWith(dir), 'путь в имени не выводит за каталог');
});

test('пути каталогов файлов по пользователям', () => {
  assert.equal(uploadsDir(42, tmp), join(tmp, 'uploads', '42'));
  assert.equal(outboxDir(42, tmp), join(tmp, 'outbox', '42'));
});

test('cleanupOldFiles: удаляет только старые файлы', () => {
  const root = join(tmp, 'clean');
  mkdirSync(join(root, '1'), { recursive: true });
  const oldF = join(root, '1', 'old.txt');
  const newF = join(root, '1', 'new.txt');
  writeFileSync(oldF, 'o');
  writeFileSync(newF, 'n');
  const past = new Date(Date.now() - 10 * 24 * 3600_000);
  utimesSync(oldF, past, past);
  assert.equal(cleanupOldFiles(root, 7 * 24 * 3600_000), 1);
  assert.ok(!existsSync(oldF) && existsSync(newF));
  assert.equal(cleanupOldFiles(join(tmp, 'нет-такой'), 1), 0);
});

test('buildPromptBlocks: текст, изображение (если агент умеет), заметка о файлах и отправке', () => {
  const img = { path: '/u/p.jpg', name: 'p.jpg', mime: 'image/jpeg', size: 10, data: Buffer.from('abc') };
  const pdf = { path: '/u/r.pdf', name: 'r.pdf', mime: 'application/pdf', size: 2048 };
  const withImg = buildPromptBlocks({ text: 'что тут?', files: [img, pdf], caps: { promptCapabilities: { image: true } }, outbox: '/o' });
  assert.deepEqual(withImg.map((b) => b.type), ['text', 'image', 'text']);
  assert.equal(withImg[0].text, 'что тут?');
  assert.equal(withImg[1].data, Buffer.from('abc').toString('base64'));
  assert.equal(withImg[1].mimeType, 'image/jpeg');
  assert.match(withImg[2].text, /\/u\/p\.jpg .*also shown inline/);
  assert.match(withImg[2].text, /\/u\/r\.pdf \(application\/pdf, 2 KB\)/);
  assert.match(withImg[2].text, /\[\[send:<absolute path>\]\]/);

  // агент без поддержки image: только путь
  const noImg = buildPromptBlocks({ text: 'x', files: [img], caps: {}, outbox: '/o' });
  assert.deepEqual(noImg.map((b) => b.type), ['text', 'text']);
  assert.ok(!/inline/.test(noImg[1].text));

  // слишком большая картинка — без блока image
  const big = { ...img, size: IMAGE_BLOCK_MAX + 1 };
  assert.deepEqual(buildPromptBlocks({ text: 'x', files: [big], caps: { promptCapabilities: { image: true } } }).map((b) => b.type), ['text', 'text']);

  // файл без подписи — запрос по умолчанию; обычный запрос без файлов — только текст и подсказка про отправку
  assert.match(buildPromptBlocks({ text: '', files: [pdf], caps: {} })[0].text, /without a message/);
  const plain = buildPromptBlocks({ text: 'привет', outbox: '/o' });
  assert.equal(plain.length, 2);
  assert.ok(!/attached files/.test(plain[1].text));
  assert.equal(buildPromptBlocks({ text: 'привет' }).length, 1);
});

test('extractSendMarks: метки убираются из текста, пути без повторов; ответ без меток не меняется', () => {
  const r = extractSendMarks('Готово.\n[[send:C:\\out\\report.pdf]]\n\n\n[[send:"/tmp/a b.csv"]]\n[[send:C:\\out\\report.pdf]]');
  assert.deepEqual(r.paths, ['C:\\out\\report.pdf', '/tmp/a b.csv']);
  assert.equal(r.text, 'Готово.');
  const plain = 'код:\n\n\n\n  x\n';
  assert.deepEqual(extractSendMarks(plain), { text: plain, paths: [] });
});

test('stripSendMarks: убирает целые и недописанные метки в потоке', () => {
  assert.equal(stripSendMarks('a [[send:/x/y.txt]] b'), 'a  b');
  assert.equal(stripSendMarks('a [[send:/x/y'), 'a ');
  assert.equal(stripSendMarks('a [[send:/x/y]'), 'a ');
  assert.equal(stripSendMarks('a [[se'), 'a ');
  assert.equal(stripSendMarks('a ['), 'a ');
  assert.equal(stripSendMarks('массив [1] и [[2]]'), 'массив [1] и [[2]]');
});

const FENCE = '`'.repeat(3);

test('extractSendMarks: метки в коде (строчном, блоках ``` и ~~~) не считаются отправкой и остаются в тексте', () => {
  const md = [
    'Отправить можно через `[[send:...]]`, или ``a ` [[send:…]]``.',
    '',
    `${FENCE}md`,
    '[[send:C:\\x.txt]]',
    FENCE,
    '~~~',
    '[[send:/y]]',
    '~~~',
    '[[send:C:\\out\\r.pdf]]',
  ].join('\n');
  const r = extractSendMarks(md);
  assert.deepEqual(r.paths, ['C:\\out\\r.pdf']);
  for (const kept of ['`[[send:...]]`', '[[send:…]]', '[[send:C:\\x.txt]]', '[[send:/y]]']) assert.ok(r.text.includes(kept), kept);
  assert.ok(!r.text.includes('r.pdf'));
  // незакрытая кавычка — обычный текст, метка после неё работает; незакрытый блок кода — код до конца
  assert.deepEqual(extractSendMarks('цена ` 5\n[[send:/a.txt]]').paths, ['/a.txt']);
  assert.deepEqual(extractSendMarks(`${FENCE}\n[[send:/a.txt]]`).paths, []);
  // пробелы и пустые строки внутри кода не схлопываются
  const code = `x\n[[send:/a]]\n${FENCE}\na  \n\n\n\nb\n${FENCE}`;
  assert.equal(extractSendMarks(code).text, `x\n\n${FENCE}\na  \n\n\n\nb\n${FENCE}`);
});

test('stripSendMarks: в коде метки не трогает, недописанную метку в конце текста убирает', () => {
  assert.equal(stripSendMarks('см. `[[send:...]]` и [[send:/x]] ok'), 'см. `[[send:...]]` и  ok');
  assert.equal(stripSendMarks(`${FENCE}\n[[send:/x]]\n${FENCE}\nтекст [[se`), `${FENCE}\n[[send:/x]]\n${FENCE}\nтекст `);
  assert.equal(stripSendMarks(`${FENCE}\n[[se`), `${FENCE}\n[[se`); // внутри незакрытого блока кода
});

test('splitCode: куски текста и кода склеиваются обратно в исходный текст', () => {
  const four = '`'.repeat(4);
  const md = `a \`b\` c\n${FENCE}js\nx \`y\`\n${FENCE}\n${four}\n${FENCE}\n${four}\nd \`\`e\`\` f \` g`;
  const parts = splitCode(md);
  assert.equal(parts.map((p) => p.s).join(''), md);
  assert.deepEqual(
    parts.filter((p) => p.code).map((p) => p.s),
    ['`b`', `${FENCE}js\nx \`y\`\n${FENCE}\n`, `${four}\n${FENCE}\n${four}\n`, '``e``'],
  );
});

test('resolveSendable: разрешены каталог исходящих и проект; секреты, чужие папки и ссылки наружу — нет', () => {
  const project = join(tmp, 'proj');
  const outbox = join(tmp, 'outbox', '1');
  const other = join(tmp, 'other');
  for (const d of [project, outbox, other, join(project, '.git')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'data');
  writeFileSync(join(project, '.env'), 'TOKEN=1');
  writeFileSync(join(project, '.git', 'config'), 'url');
  writeFileSync(join(project, 'empty.txt'), '');
  writeFileSync(join(outbox, 'o.txt'), 'out');
  writeFileSync(join(other, 's.txt'), 'secret');
  const ctx = { cwd: project, outbox };

  assert.equal(resolveSendable(join(project, 'a.txt'), ctx).ok, true);
  assert.equal(resolveSendable('a.txt', ctx).ok, true, 'относительный путь — от папки проекта');
  assert.equal(resolveSendable(join(outbox, 'o.txt'), ctx).ok, true);
  assert.equal(resolveSendable(join(project, 'нет.txt'), ctx).reason, 'missing');
  assert.equal(resolveSendable(project, ctx).reason, 'notfile');
  assert.equal(resolveSendable(join(project, 'empty.txt'), ctx).reason, 'empty');
  assert.equal(resolveSendable(join(project, 'a.txt'), { ...ctx, maxBytes: 2 }).reason, 'big');
  assert.equal(resolveSendable(join(other, 's.txt'), ctx).reason, 'denied');
  assert.equal(resolveSendable(join(project, '..', 'other', 's.txt'), ctx).reason, 'denied');
  assert.equal(resolveSendable(join(project, '.env'), ctx).reason, 'denied');
  assert.equal(resolveSendable(join(project, '.git', 'config'), ctx).reason, 'denied');

  // ссылка из проекта на файл вне разрешённых папок — отказ (проверяется реальный путь)
  try {
    symlinkSync(join(other, 's.txt'), join(project, 'link.txt'));
    assert.equal(resolveSendable(join(project, 'link.txt'), ctx).reason, 'denied');
  } catch (e) {
    if (e.code !== 'EPERM') throw e; // на Windows без прав создать ссылку нельзя — проверку пропускаем
  }
});

test('describeAttachment: фото (самый большой размер), документ, прочее', () => {
  const photo = describeAttachment({ photo: [{ file_id: 's', file_unique_id: 'u1', file_size: 1 }, { file_id: 'L', file_unique_id: 'u2', file_size: 9 }] });
  assert.deepEqual(photo, { id: 'L', name: 'photo_u2.jpg', mime: 'image/jpeg', size: 9 });
  const doc = describeAttachment({ document: { file_id: 'd', file_unique_id: 'u3', file_name: 'a.pdf', mime_type: 'application/pdf', file_size: 5 } });
  assert.deepEqual(doc, { id: 'd', name: 'a.pdf', mime: 'application/pdf', size: 5 });
  assert.equal(describeAttachment({ document: { file_id: 'd', file_unique_id: 'u4', file_name: 'x.png' } }).mime, 'image/png', 'mime по расширению');
  assert.equal(describeAttachment({ document: { file_id: 'd', file_unique_id: 'u5' } }).name, 'file_u5');
  assert.equal(describeAttachment({ text: 'привет' }), null);
});

test('buildPromptBlocks: распакованный архив — папка и список файлов (первые 50)', () => {
  const inner = Array.from({ length: 53 }, (_, i) => ({ path: `d/f${i}.txt`, size: 2048 }));
  const zip = { path: '/u/a.zip', name: 'a.zip', mime: 'application/zip', size: 4096, unpacked: { dir: '/u/a.zip_unpacked', files: inner, skipped: 2 } };
  const note = buildPromptBlocks({ text: 'что внутри?', files: [zip] })[1].text;
  assert.match(note, /unpacked to "\/u\/a\.zip_unpacked" \(53 files, 2 unsafe or unsupported entries skipped\)/);
  assert.match(note, /d\/f49\.txt/);
  assert.ok(!/d\/f50\.txt/.test(note));
  assert.match(note, /and 3 more/);
  // архив без распаковки — обычный файл
  const plain = buildPromptBlocks({ text: 'x', files: [{ ...zip, unpacked: undefined }] })[1].text;
  assert.ok(!/unpacked/.test(plain));
});

test('extractSendMarks с заглушками: файл встаёт на место метки, повтор того же файла — без второй заглушки', () => {
  const r = extractSendMarks('График:\n[[send:/o/a.png]]\nИ снова [[send:/o/a.png]], отчёт:\n[[send:/o/b.csv]]', { placeholders: true });
  assert.deepEqual(r.paths, ['/o/a.png', '/o/b.csv']);
  assert.equal(r.text, `График:\n${filePlaceholder(0)}\nИ снова , отчёт:\n${filePlaceholder(1)}`);
});

test('attachFiles: файлы — блоками на месте меток, недоступные — строкой с причиной, сверх лимита — отдельно', () => {
  const outbox = join(tmp, 'attach', 'outbox');
  const project = join(tmp, 'attach', 'proj');
  mkdirSync(outbox, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(outbox, 'chart.png'), 'png');
  writeFileSync(join(outbox, 'pic.webp'), 'webp');
  writeFileSync(join(project, 'report.csv'), 'a,b\n1,2\n');
  writeFileSync(join(project, 'big.bin'), Buffer.alloc(100));
  const paths = [join(outbox, 'chart.png'), 'report.csv', join(outbox, 'nope.txt'), join(outbox, 'pic.webp'), join(project, 'big.bin')];
  const text = ['Итог:', filePlaceholder(0), 'Отчёт ниже.', `${filePlaceholder(1)} ${filePlaceholder(2)}`, filePlaceholder(3), filePlaceholder(4), 'Конец.'].join('\n');
  const skipped = [];
  const r = attachFiles(text, paths, { cwd: project, outbox, failText: (name, why) => `⚠️ ${name}: ${why}`, onSkip: (p, why) => skipped.push(why), maxBytes: 50 });

  assert.equal(
    r.text,
    ['Итог:', '', '![](tg://photo?id=f0)', '', 'Отчёт ниже.', '', '![](tg://document?id=f1)', '', '⚠️ nope.txt: missing', '', '![](tg://document?id=f3)', '', 'Конец.'].join('\n'),
  );
  assert.deepEqual(Object.keys(r.media), ['f0', 'f1', 'f3']);
  assert.equal(r.media.f0.photo, true); // png — фото
  assert.equal(r.media.f3.photo, false); // webp — документом
  assert.equal(r.media.f1.name, 'report.csv');
  assert.deepEqual(r.extra.map((f) => f.name), ['big.bin']); // 100 байт сверх лимита 50 — отдельно
  assert.deepEqual(skipped, ['missing']);
});

test('attachFiles: не больше 10 файлов за ответ; текст без заглушек и код не меняются', () => {
  const fence = '`'.repeat(3);
  const code = `${fence}\na  \n\n\n\nb\n${fence}`;
  assert.deepEqual(attachFiles(code, [], { cwd: tmp, outbox: tmp, failText: () => '' }), { text: code, media: {}, extra: [] });
  const paths = Array.from({ length: 12 }, (_, i) => `/x/${i}.txt`);
  const skipped = [];
  attachFiles(paths.map((_, i) => filePlaceholder(i)).join('\n'), paths, { cwd: tmp, outbox: tmp, failText: () => '', onSkip: (p, why) => skipped.push(why) });
  assert.deepEqual(skipped.slice(-2), ['limit', 'limit']);
});

test('isSecret: ключи, входы и папки агентов закрыты, обычные файлы проекта — нет', () => {
  const p = (...parts) => join('C:', 'proj', ...parts);
  for (const secret of [
    p('.env'), p('.env.local'), p('.Renviron'), p('.npmrc'), p('.netrc'), p('.git-credentials'),
    p('id_rsa'), p('id_ed25519'), p('server.pem'), p('cert.p12'), p('my.key'), p('client_secret_123.json'), p('credentials.json'),
    p('.ssh', 'config'), p('.aws', 'config'), p('.claude', '.credentials.json'), p('.gemini', 'oauth_creds.json'),
    p('.codex', 'auth.json'), p('.config', 'gh', 'hosts.yml'), p('.git', 'config'),
  ]) assert.equal(isSecret(secret), true, secret);
  for (const ok of [p('report.csv'), p('id_rsa.pub'), p('keys.md'), p('env.R'), p('R', 'credentials_check.R'), p('.github', 'ci.yml'), p('chart.png')]) {
    assert.equal(isSecret(ok), false, ok);
  }
});

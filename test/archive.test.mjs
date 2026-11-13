import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { ArchiveError, archiveKind, extractArchive, extractArchiveAsync, safeEntryPath } from '../src/archive.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'acpgram-archive-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dest = () => join(tmp, `d${n++}`);

/** Минимальный zip-писатель для тестов: entries = [{name, data, method?: 0|8, flags?, madeBy?, attr?}]. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data ?? '');
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE((e.flags ?? 0) | 0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, body]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(((e.madeBy ?? 0) << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE((e.flags ?? 0) | 0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.attr ?? 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Минимальный tar-писатель: entries = [{name, data, type?}]. */
function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 'utf8');
    h.write('0000644\0', 100);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h[156] = (e.type ?? '0').charCodeAt(0);
    h.write('ustar\0', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('archiveKind: по имени файла', () => {
  assert.equal(archiveKind('a.ZIP'), 'zip');
  assert.equal(archiveKind('a.tar.gz'), 'tgz');
  assert.equal(archiveKind('a.TGZ'), 'tgz');
  assert.equal(archiveKind('a.tar'), 'tar');
  for (const x of ['a.7z', 'a.rar', 'a.gz', 'a.pdf', '', undefined]) assert.equal(archiveKind(x), null);
});

test('safeEntryPath: выход за папку, абсолютные пути и диски отвергаются', () => {
  assert.deepEqual(safeEntryPath('a/b/c.txt'), ['a', 'b', 'c.txt']);
  assert.deepEqual(safeEntryPath('a\\b.txt'), ['a', 'b.txt']);
  assert.deepEqual(safeEntryPath('./a.txt'), ['a.txt']);
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'C:x', '', '..', 'a\0b']) assert.equal(safeEntryPath(bad), null, bad);
});

test('zip: файлы с вложенными папками, кириллицей и без сжатия', () => {
  const zip = makeZip([
    { name: 'readme.txt', data: 'привет' },
    { name: 'папка/данные.csv', data: 'a;b\n1;2\n' },
    { name: 'stored.bin', data: 'xyz', method: 0 },
    { name: 'пустая/', data: '' },
  ]);
  const d = dest();
  const r = extractArchive(zip, 'zip', d);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['readme.txt', 'stored.bin', 'папка/данные.csv']);
  assert.equal(readFileSync(join(d, 'папка', 'данные.csv'), 'utf8'), 'a;b\n1;2\n');
  assert.equal(readFileSync(join(d, 'stored.bin'), 'utf8'), 'xyz');
  assert.equal(r.skipped, 0);
});

test('zip: zip-slip, абсолютные пути, ссылки и зашифрованные записи пропускаются', () => {
  const zip = makeZip([
    { name: '../evil.txt', data: 'x' },
    { name: '/abs.txt', data: 'x' },
    { name: 'C:\\win.txt', data: 'x' },
    { name: 'link', data: 'target', madeBy: 3, attr: (0xa1ff << 16) >>> 0 },
    { name: 'secret.bin', data: 'x', flags: 1 },
    { name: 'ok.txt', data: 'ok' },
  ]);
  const d = dest();
  const r = extractArchive(zip, 'zip', d);
  assert.deepEqual(r.files.map((f) => f.path), ['ok.txt']);
  assert.equal(r.skipped, 5);
  assert.ok(!existsSync(join(d, '..', 'evil.txt')) && !existsSync(join(tmp, 'evil.txt')));
});

test('zip: лимиты числа файлов и размера, папка назначения удаляется', () => {
  const many = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  const d1 = dest();
  assert.throws(() => extractArchive(many, 'zip', d1, { maxFiles: 5 }), (e) => e instanceof ArchiveError && e.reason === 'limit');
  const big = makeZip([{ name: 'big.txt', data: 'a'.repeat(10_000) }]); // хорошо сжимается: «бомба» в миниатюре
  const d2 = dest();
  assert.throws(() => extractArchive(big, 'zip', d2, { maxBytes: 1000 }), (e) => e.reason === 'limit');
  assert.ok(!existsSync(d1) && !existsSync(d2), 'при отказе ничего не остаётся');
});

test('zip: объявленный размер занижен, а реальный больше лимита — распаковка прерывается', () => {
  const zip = makeZip([{ name: 'lie.txt', data: 'a'.repeat(10_000) }]);
  // подменяем объявленный размер в центральном каталоге на 5 байт
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(5, cd + 24);
  const d = dest();
  assert.throws(() => extractArchive(zip, 'zip', d, { maxBytes: 1000 }), (e) => e.reason === 'limit');
  assert.ok(!existsSync(d));
});

test('повреждённые данные: не zip, обрезанный архив', () => {
  assert.throws(() => extractArchive(Buffer.from('это не архив'), 'zip', dest()), (e) => e.reason === 'corrupt');
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
  assert.throws(() => extractArchive(zip.subarray(0, 20), 'zip', dest()), (e) => e.reason === 'corrupt');
  assert.throws(() => extractArchive(Buffer.from('не gzip'), 'tgz', dest()), (e) => e.reason === 'corrupt');
});

test('tar и tar.gz: файлы, папки, ссылки пропускаются', () => {
  const tar = makeTar([
    { name: 'dir/', type: '5' },
    { name: 'dir/a.txt', data: 'alpha' },
    { name: 'b.txt', data: 'b'.repeat(700) },
    { name: 'sym', type: '2' },
    { name: '../out.txt', data: 'x' },
  ]);
  for (const [kind, buf] of [['tar', tar], ['tgz', gzipSync(tar)]]) {
    const d = dest();
    const r = extractArchive(buf, kind, d);
    assert.deepEqual(r.files.map((f) => f.path).sort(), ['b.txt', 'dir/a.txt'], kind);
    assert.equal(readFileSync(join(d, 'dir', 'a.txt'), 'utf8'), 'alpha');
    assert.equal(readFileSync(join(d, 'b.txt'), 'utf8').length, 700);
    assert.equal(r.skipped, 2, kind); // ссылка и «../»
  }
});

test('tgz: распакованный размер больше лимита — отказ без распаковки в память', () => {
  const tar = makeTar([{ name: 'big.txt', data: 'a'.repeat(200_000) }]);
  assert.throws(() => extractArchive(gzipSync(tar), 'tgz', dest(), { maxBytes: 1000 }), (e) => e.reason === 'limit');
});

test('extractArchiveAsync: распаковка в отдельном потоке — тот же результат и те же ошибки', async () => {
  const zip = makeZip([{ name: 'a/b.txt', data: 'привет' }, { name: '../evil.txt', data: 'x' }]);
  const d = dest();
  const r = await extractArchiveAsync(zip, 'zip', d);
  assert.deepEqual(r.files, [{ path: 'a/b.txt', size: Buffer.byteLength('привет') }]);
  assert.equal(r.skipped, 1);
  assert.equal(readFileSync(join(d, 'a', 'b.txt'), 'utf8'), 'привет');

  await assert.rejects(extractArchiveAsync(Buffer.from('не gzip'), 'tgz', dest()), (e) => e instanceof ArchiveError && e.reason === 'corrupt');
  const many = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  const d2 = dest();
  await assert.rejects(extractArchiveAsync(many, 'zip', d2, { maxFiles: 5 }), (e) => e instanceof ArchiveError && e.reason === 'limit');
  assert.equal(existsSync(d2), false);
});

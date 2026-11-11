import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { after, test } from 'node:test';

// структура: <tmp>/root/{a/b, file.txt, link-out -> outside}, <tmp>/root2, <tmp>/outside
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'gcb-test-')));
const root = join(base, 'root');
mkdirSync(join(root, 'a', 'b'), { recursive: true });
mkdirSync(join(base, 'root2'));
mkdirSync(join(base, 'outside'));
writeFileSync(join(root, 'file.txt'), 'x');
let hasLink = true;
try {
  symlinkSync(join(base, 'outside'), join(root, 'link-out'), 'junction'); // на Windows junction не требует прав администратора
} catch {
  hasLink = false;
}

process.env.PROJECTS_ROOT = root;
const P = await import('../src/projects.mjs');

after(() => rmSync(base, { recursive: true, force: true }));

test('resolveRoot: необязательная переменная и понятные ошибки', () => {
  assert.equal(P.resolveRoot(''), null, 'не задана — режим без корня');
  assert.equal(P.resolveRoot('   '), null);
  assert.throws(() => P.resolveRoot(join(base, 'nope')), /не найдена/);
  assert.throws(() => P.resolveRoot(join(root, 'file.txt')), /не папка/);
  assert.equal(P.resolveRoot(root), root);
});

test('insideRoot: папки внутри корня', () => {
  assert.equal(P.insideRoot(root), root);
  assert.equal(P.insideRoot(join(root, 'a', 'b')), join(root, 'a', 'b'));
  assert.equal(P.resolveAsPath('a/b'), join(root, 'a', 'b'));
});

test('insideRoot: выход за корень запрещён', () => {
  assert.equal(P.insideRoot(join(root, '..')), null, '..');
  assert.equal(P.insideRoot(join(root, 'a', '..', '..', 'outside')), null, 'a/../../outside');
  assert.equal(P.insideRoot(join(base, 'root2')), null, 'соседняя папка с тем же префиксом');
  assert.equal(P.insideRoot(join(root, 'file.txt')), null, 'файл, а не папка');
  assert.equal(P.insideRoot(join(root, 'nope')), null, 'несуществующая папка');
  assert.equal(P.resolveAsPath('../outside'), null);
});

test('insideRoot: ссылка наружу из корня не пропускается', { skip: !hasLink && 'не удалось создать ссылку' }, () => {
  assert.equal(P.insideRoot(join(root, 'link-out')), null);
  assert.ok(!P.listDirs(root).includes('link-out'), 'ссылки не показываются в навигации');
});

test('isWithin / samePath: регистр по правилам ОС', () => {
  const upper = root.toUpperCase();
  assert.equal(P.isWithin(join(upper, 'A'), root), P.CASE_INSENSITIVE_FS);
  assert.equal(P.samePath(upper, root), P.CASE_INSENSITIVE_FS || upper === root);
  // префикс без разделителя — не вложенность
  assert.equal(P.isWithin(root + '2', root), false);
});

test('findDirs: поиск без учёта регистра', () => {
  const { results } = P.findDirs('A B');
  assert.deepEqual(results, [join(root, 'a', 'b')]);
});

test('режим без корня: любая существующая папка, ~ и относительные пути от домашней', () => {
  const home = root; // считаем «домашней» папку root
  assert.equal(P.insideRoot(join(base, 'outside'), null), join(base, 'outside'), 'папка вне любого корня');
  assert.equal(P.insideRoot(join(root, 'file.txt'), null), null, 'файл — не папка');
  assert.equal(P.insideRoot(join(base, 'nope'), null), null, 'несуществующая');
  assert.equal(P.resolveAsPath('a/b', null, home), join(root, 'a', 'b'), 'относительный — от домашней');
  assert.equal(P.resolveAsPath(join(base, 'outside'), null, home), join(base, 'outside'), 'абсолютный');
  assert.equal(P.resolveAsPath('../outside', null, home), join(base, 'outside'), 'без корня выход выше разрешён');
  // с корнем тот же путь запрещён
  assert.equal(P.resolveAsPath('../outside', root, home), null);
});

test('expandHome и display в режиме без корня', () => {
  const h = homedir();
  assert.equal(P.expandHome('~'), h);
  assert.equal(P.expandHome('~/x/y'), join(h, 'x', 'y'));
  assert.equal(P.expandHome(String.raw`~\x`), join(h, 'x'), 'разделитель Windows');
  assert.equal(P.expandHome('~user/x'), '~user/x', 'чужая домашняя не раскрывается');
  assert.equal(P.expandHome('/abs/~/x'), '/abs/~/x');

  assert.equal(P.display(root, null, root), '~');
  assert.equal(P.display(join(root, 'a', 'b'), null, root), `~${sep}${join('a', 'b')}`);
  assert.equal(P.display(join(base, 'outside'), null, root), join(base, 'outside'), 'вне домашней — полный путь');
  // с корнем — как раньше
  assert.equal(P.display(root, root), `${root} (корень)`);
  assert.equal(P.display(join(root, 'a'), root), 'a');
});

test('навигация: «Вверх» до корня проектов или до корня диска', () => {
  assert.equal(P.canGoUp(root, root), false);
  assert.equal(P.canGoUp(join(root, 'a'), root), true);
  assert.equal(P.canGoUp(root, null), true, 'без корня можно выше');
  assert.equal(P.canGoUp(parse(root).root, null), false, 'корень диска');
  assert.equal(P.navStart(root, root), root);
  assert.equal(P.navStart(join(root, 'a', 'b'), root), join(root, 'a'));
  assert.equal(P.navStart(parse(root).root, null), parse(root).root);
});

test('findDirs: поиск от заданной папки (без корня — от домашней)', () => {
  assert.deepEqual(P.findDirs('outside', { base }).results, [join(base, 'outside')]);
});

test('pushRecent: прежний проект — первым, без текущего и повторов, не больше лимита', () => {
  const up = (p) => (P.CASE_INSENSITIVE_FS ? p.toUpperCase() : p);
  assert.deepEqual(P.pushRecent([], '/p/a', '/p/b'), ['/p/a']);
  assert.deepEqual(P.pushRecent(['/p/c', '/p/a'], '/p/a', '/p/b'), ['/p/a', '/p/c'], 'повтор схлопнут');
  assert.deepEqual(P.pushRecent(['/p/b', '/p/c'], '/p/a', '/p/b'), ['/p/a', '/p/c'], 'новый текущий убран');
  assert.deepEqual(P.pushRecent([up('/p/a')], '/p/a', '/p/z').length, P.CASE_INSENSITIVE_FS ? 1 : 2);
  assert.deepEqual(P.pushRecent(['/1', '/2', '/3', '/4', '/5', '/6'], '/0', '/x', 6), ['/0', '/1', '/2', '/3', '/4', '/5']);
  assert.deepEqual(P.pushRecent([null, 5, '/q'], null, '/x'), ['/q'], 'мусор из базы отбрасывается');
});

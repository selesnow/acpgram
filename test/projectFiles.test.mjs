// Файлы проекта в обход агента (/files): безопасная запись и удаление, сценарии экрана.
// Модули открывают базу бота и читают настройки при загрузке, поэтому каталог данных и корень проектов — временные.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-files-')));
const root = join(home, 'projects');
mkdirSync(root);
mkdirSync(join(home, 'outside'));
writeFileSync(join(home, 'outside', 'bot.env'), 'BOT=1');
process.env.ACPGRAM_HOME = home;
process.env.PROJECTS_ROOT = root;
process.env.USER_WORKSPACES = '1';
delete process.env.AGENT_SANDBOX;
process.env.TELEGRAM_BOT_TOKEN ??= 'test';
process.env.ALLOWED_USER_ID ??= '1';

// Telegram в тестах не вызывается: запросы складываются в sent, скачивание файла отдаёт DOWNLOAD
const sent = [];
let DOWNLOAD = Buffer.from('UPLOADED=1\n');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!init?.body) return { ok: true, arrayBuffer: async () => DOWNLOAD }; // скачивание файла
  const method = String(url).split('/').pop();
  sent.push({ method, body: JSON.parse(init.body) });
  return { json: async () => ({ ok: true, result: method === 'getFile' ? { file_path: 'documents/f' } : { message_id: sent.length } }) };
};
const take = () => sent.splice(0);
const texts = (calls) => calls.map((c) => c.body.text ?? '').join('\n');
const buttons = (calls) => calls.flatMap((c) => c.body.reply_markup?.inline_keyboard ?? []).flat();
const press = (id, data) => ({ id: 'cb', data, message: { chat: { id }, message_id: 5 } });

const ctx = await import('../src/ctx.mjs');
const F = await import('../src/projectFiles.mjs');
const S = await import('../src/state.mjs');
const U = await import('../src/filesUi.mjs');
const { SECRETS_NOTE } = await import('../src/files.mjs');

const ADMIN = ctx.ADMIN_ID;
const [ANN, BOB] = [3001, 3002].map((id) => (id === ADMIN ? id + 100 : id));
for (const id of [ANN, BOB, ADMIN]) ctx.setLang(id, 'ru');
ctx.db.upsertUser({ user_id: ANN, username: 'ann', level: 'read', added_by: ADMIN });
ctx.db.upsertUser({ user_id: BOB, username: 'bob', level: 'read', added_by: ADMIN });
S.topicsSupport.enabled = false;
const ann = S.getState(ANN, ANN);
const bob = S.getState(BOB, BOB);
const proj = ann.project; // личное пространство — оно же проект

after(() => {
  globalThis.fetch = realFetch;
  ctx.db.close();
  rmSync(home, { recursive: true, force: true });
});

test('relPath: имя файла или путь с подпапками; имена с точки разрешены, выход из проекта — нет', () => {
  assert.deepEqual(F.relPath('.env'), ['.env']);
  assert.deepEqual(F.relPath('  config/.env '), ['config', '.env']);
  assert.deepEqual(F.relPath(String.raw`docs\notes.txt`), ['docs', 'notes.txt'], 'разделитель Windows');
  assert.deepEqual(F.relPath('a / b.txt'), ['a', 'b.txt']);
  const bad = ['', '   ', '/etc/passwd', String.raw`C:\x`, 'c:/x', '~/x', '../x', 'a/../b', 'a//b', './x', '.git/config', 'node_modules/x.js', 'a:b', 'a*b', 'x.', 'con', 'NUL.txt', 'a\tb', 'x'.repeat(F.NAME_MAX + 1), Array(F.DEPTH_MAX + 1).fill('d').join('/')];
  for (const b of bad) assert.equal(F.relPath(b), null, JSON.stringify(b));
});

test('writeProjectFile: создаёт подпапки, существующий файл без замены не трогает, временных файлов не оставляет', () => {
  const r = F.writeProjectFile(proj, proj, ['conf', 'deep', '.env'], 'A=1\n');
  assert.equal(r.path, join(proj, 'conf', 'deep', '.env'));
  assert.deepEqual({ size: r.size, replaced: r.replaced }, { size: 4, replaced: false });
  assert.throws(() => F.writeProjectFile(proj, proj, ['conf', 'deep', '.env'], 'B=2\n'), (e) => e instanceof F.FileError && e.code === 'exists');
  assert.equal(readFileSync(r.path, 'utf8'), 'A=1\n', 'содержимое не изменилось');
  assert.equal(F.writeProjectFile(proj, proj, ['conf', 'deep', '.env'], Buffer.from('B=2\n'), { replace: true }).replaced, true);
  assert.equal(readFileSync(r.path, 'utf8'), 'B=2\n');
  assert.deepEqual(readdirSync(join(proj, 'conf', 'deep')), ['.env'], 'временный файл переименован');
  // папка, от которой задан путь, обязана лежать в проекте
  assert.throws(() => F.writeProjectFile(proj, join(home, 'outside'), ['x'], '1'), (e) => e.code === 'outside');
  assert.throws(() => F.writeProjectFile(proj, root, ['x'], '1'), (e) => e.code === 'outside', 'корень проектов — не проект сотрудника');
  // на месте папки файл, на месте файла папка
  assert.throws(() => F.writeProjectFile(proj, proj, ['conf', 'deep', '.env', 'x'], '1'), (e) => e.code === 'notdir');
  assert.throws(() => F.writeProjectFile(proj, proj, ['conf'], '1', { replace: true }), (e) => e.code === 'isdir');
});

test('ссылки: бот не пишет и не удаляет сквозь ссылку, подложенную в проект', (t) => {
  const outside = join(home, 'outside');
  try {
    symlinkSync(outside, join(proj, 'linkdir'), 'junction'); // на Windows junction не требует прав администратора
  } catch {
    return t.skip('не удалось создать ссылку');
  }
  assert.throws(() => F.writeProjectFile(proj, proj, ['linkdir', 'new.txt'], 'x'), (e) => e.code === 'link');
  assert.equal(existsSync(join(outside, 'new.txt')), false, 'вне проекта ничего не появилось');
  assert.throws(() => F.writeProjectFile(proj, join(proj, 'linkdir'), ['new.txt'], 'x'), (e) => e.code === 'outside', 'папка-ссылка как место записи');
  assert.throws(() => F.deleteProjectFile(proj, join(proj, 'linkdir', 'bot.env')), (e) => e.code === 'outside');
  assert.equal(readFileSync(join(outside, 'bot.env'), 'utf8'), 'BOT=1', 'чужой файл цел');
  assert.ok(!F.listProjectDir(proj, proj).dirs.includes('linkdir'), 'ссылки в списке не показываются');
  assert.equal(F.projectFileInfo(proj, join(proj, 'linkdir', 'bot.env')), null);
  // ссылка на файл (на Windows нужны права — тогда эта часть пропускается)
  try {
    symlinkSync(join(outside, 'bot.env'), join(proj, 'link.env'));
  } catch {
    return t.diagnostic('ссылку на файл создать не удалось — проверка пропущена');
  }
  assert.throws(() => F.writeProjectFile(proj, proj, ['link.env'], 'ЗАХВАТ', { replace: true }), (e) => e.code === 'link');
  assert.throws(() => F.deleteProjectFile(proj, join(proj, 'link.env')), (e) => e.code === 'link');
  assert.equal(readFileSync(join(outside, 'bot.env'), 'utf8'), 'BOT=1');
});

test('listProjectDir, projectFileInfo, deleteProjectFile, fmtSize', () => {
  mkdirSync(join(proj, 'node_modules'));
  mkdirSync(join(proj, '.git'));
  writeFileSync(join(proj, 'b.txt'), 'bb');
  writeFileSync(join(proj, '.Renviron'), 'K=1');
  const l = F.listProjectDir(proj, proj);
  assert.ok(l.dirs.includes('conf') && !l.dirs.includes('node_modules') && !l.dirs.includes('.git'));
  assert.deepEqual(l.files.map((f) => f.name).filter((n) => !n.startsWith('link')), ['.Renviron', 'b.txt'], 'скрытые файлы видны');
  assert.equal(F.projectFileInfo(proj, join(proj, 'b.txt')).size, 2);
  assert.equal(F.projectFileInfo(proj, join(home, 'outside', 'bot.env')), null);
  F.deleteProjectFile(proj, join(proj, 'b.txt'));
  assert.equal(existsSync(join(proj, 'b.txt')), false);
  assert.throws(() => F.deleteProjectFile(proj, join(proj, 'b.txt')), (e) => e.code === 'missing');
  assert.throws(() => F.deleteProjectFile(proj, join(proj, 'conf')), (e) => e.code === 'isdir');
  assert.throws(() => F.deleteProjectFile(proj, join(home, 'outside', 'bot.env')), (e) => e.code === 'outside');
  assert.deepEqual([F.fmtSize(812), F.fmtSize(3482), F.fmtSize(1258291)], ['812 B', '3.4 KB', '1.2 MB']);
});

test('/files: создание файла — имя, затем содержимое; агенту оно не уходит, сообщение удаляется из чата', async () => {
  assert.equal(U.canManageFiles(ANN), true, 'в личном пространстве — при любом уровне');
  assert.equal(U.canManageFiles(ADMIN), true);
  await U.handleFiles(ann);
  const screen = take();
  assert.match(texts(screen), /Файлы проекта: <code>Моё пространство<\/code>/);
  const create = buttons(screen).find((b) => b.callback_data.startsWith('fl:n:'));
  assert.equal(create.text, '📝 Создать файл');

  assert.equal(await U.onFileInput(ann, 'обычный запрос'), false, 'без ожидания текст — запрос агенту');
  await U.onFilesCallback(ann, press(ANN, create.callback_data));
  assert.equal(ann.pendingInput.kind, 'fileName');
  take();
  assert.equal(await U.onFileInput(ann, '../../outside/x'), true);
  assert.match(texts(take()), /не подойдёт/);
  assert.equal(ann.pendingInput.kind, 'fileName', 'после неподходящего имени бот ждёт другое');

  assert.equal(await U.onFileInput(ann, 'app/.env'), true);
  assert.equal(ann.pendingInput.kind, 'fileContent');
  assert.match(texts(take()), /содержимое файла <code>app\/\.env<\/code>/);

  assert.equal(await U.onFileInput(ann, 'TOKEN=sekret-123', { messageId: 77 }), true);
  assert.equal(readFileSync(join(proj, 'app', '.env'), 'utf8'), 'TOKEN=sekret-123\n');
  const calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 77), 'сообщение с секретом удалено из чата');
  assert.match(texts(calls), /Сохранено в проект: <code>app\/\.env<\/code>/);
  assert.ok(!JSON.stringify(calls).includes('sekret-123'), 'секрет не повторяется в сообщениях бота');
  assert.equal(ann.pendingInput, null);
  assert.equal(ctx.db.listSessions(ANN, proj).length, 0, 'запросов агенту не было');
});

test('/files: существующий файл заменяется только после подтверждения', async () => {
  await U.handleFiles(ann);
  const create = buttons(take()).find((b) => b.callback_data.startsWith('fl:n:'));
  await U.onFilesCallback(ann, press(ANN, create.callback_data));
  await U.onFileInput(ann, 'app/.env');
  const ask = take();
  assert.match(texts(ask), /уже есть\. Заменить/);
  assert.equal(ann.pendingInput, null, 'до подтверждения содержимое не ждём');
  await U.onFilesCallback(ann, press(ANN, buttons(ask).find((b) => b.callback_data.startsWith('fl:r:')).callback_data));
  assert.equal(ann.pendingInput.kind, 'fileContent');
  await U.onFileInput(ann, 'TOKEN=new', { messageId: 78 });
  assert.equal(readFileSync(join(proj, 'app', '.env'), 'utf8'), 'TOKEN=new\n');
  // отмена
  await U.onFilesCallback(ann, press(ANN, create.callback_data));
  await U.onFilesCallback(ann, press(ANN, 'fl:x'));
  assert.equal(ann.pendingInput, null);
  take();
});

test('/files: слишком длинное и запоздавшее содержимое не сохраняется и агенту не уходит', async () => {
  const waitContent = (at = Date.now()) => (ann.pendingInput = { kind: 'fileContent', dir: proj, parts: ['long.txt'], replace: false, at });
  waitContent();
  const now = Date.now();
  assert.equal(await U.onFileInput(ann, 'x'.repeat(U.INLINE_MAX + 1), { messageId: 90, now }), true);
  assert.equal(existsSync(join(proj, 'long.txt')), false);
  let calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 90));
  assert.ok(buttons(calls).some((b) => b.callback_data.startsWith('fl:u:')), 'предложена загрузка файлом');
  // вторая часть разбитого Telegram сообщения приходит следом — тоже не агенту
  assert.equal(await U.onFileInput(ann, 'хвост секрета', { messageId: 91, now: now + 1000 }), true);
  assert.ok(take().some((c) => c.method === 'deleteMessage' && c.body.message_id === 91));
  assert.equal(await U.onFileInput(ann, 'обычный запрос', { messageId: 92, now: now + 60_000 }), false, 'позже текст снова идёт агенту');

  ann.swallowUntil = 0; // окно после длинного сообщения прошло
  waitContent(Date.now() - U.FILE_WAIT_MS - 1);
  assert.equal(await U.onFileInput(ann, 'SECRET=late', { messageId: 93 }), true, 'истёкшее ожидание содержимого не превращает секрет в запрос агенту');
  calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 93));
  assert.match(texts(calls), /Ожидание содержимого файла закончилось/);
  assert.equal(existsSync(join(proj, 'long.txt')), false);
});

test('/files: загрузка файла — только после кнопки; без неё файл предназначен агенту', async () => {
  const doc = (id, name, extra = {}) => ({ message_id: id, document: { file_id: `F${id}`, file_unique_id: `U${id}`, file_name: name, file_size: 11 }, ...extra });
  assert.equal(await U.onFileUpload(ann, doc(100, 'report.pdf')), false, 'обычная отправка — агенту');
  assert.equal(existsSync(join(proj, 'report.pdf')), false);

  await U.handleFiles(ann);
  const upload = buttons(take()).find((b) => b.callback_data.startsWith('fl:u:'));
  await U.onFilesCallback(ann, press(ANN, upload.callback_data));
  assert.equal(ann.pendingInput.kind, 'fileUpload');
  take();
  assert.equal(await U.onFileUpload(ann, doc(101, '.env.production', { caption: 'подпись не важна' })), true);
  assert.equal(readFileSync(join(proj, '.env.production'), 'utf8'), 'UPLOADED=1\n', 'имя с точкой сохранено как есть');
  const calls = take();
  assert.ok(calls.some((c) => c.method === 'deleteMessage' && c.body.message_id === 101));
  assert.match(texts(calls), /Сохранено в проект: <code>\.env\.production<\/code>/);
  assert.equal(await U.onFileUpload(ann, doc(102, 'next.txt')), false, 'ожидание одноразовое');

  // альбом: несколько файлов одной отправкой
  await U.onFilesCallback(ann, press(ANN, upload.callback_data));
  assert.equal(await U.onFileUpload(ann, doc(103, 'a.txt', { media_group_id: 'g1' })), true);
  assert.equal(await U.onFileUpload(ann, doc(104, 'b.txt', { media_group_id: 'g1' })), true);
  assert.ok(existsSync(join(proj, 'a.txt')) && existsSync(join(proj, 'b.txt')));
  take();

  // существующий файл — вопрос о замене, скачивание только после «Заменить»
  DOWNLOAD = Buffer.from('UPLOADED=2\n');
  await U.onFilesCallback(ann, press(ANN, upload.callback_data));
  assert.equal(await U.onFileUpload(ann, doc(105, 'a.txt')), true);
  const ask = take();
  assert.match(texts(ask), /уже есть/);
  assert.equal(readFileSync(join(proj, 'a.txt'), 'utf8'), 'UPLOADED=1\n', 'пока не заменён');
  await U.onFilesCallback(ann, press(ANN, buttons(ask).find((b) => b.callback_data.startsWith('fl:r:')).callback_data));
  assert.equal(readFileSync(join(proj, 'a.txt'), 'utf8'), 'UPLOADED=2\n');
  take();
});

test('/files: список по папкам, карточка файла, удаление с подтверждением', async () => {
  await U.handleFiles(ann);
  const top = buttons(take());
  const folder = top.find((b) => b.text === '📁 app');
  assert.ok(folder && top.some((b) => b.text.startsWith('📄 .env.production · ')));
  await U.onFilesCallback(ann, press(ANN, folder.callback_data));
  const inside = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(inside), /Папка: <code>app<\/code>/);
  const file = buttons(inside).find((b) => b.text.startsWith('📄 .env · '));
  assert.ok(buttons(inside).some((b) => b.text === '⬆️ Вверх'));

  await U.onFilesCallback(ann, press(ANN, file.callback_data));
  const card = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(card), /<code>app\/\.env<\/code>\nРазмер: 10 B/);
  const del = buttons(card).find((b) => b.callback_data.startsWith('fl:d:'));
  await U.onFilesCallback(ann, press(ANN, del.callback_data));
  const confirm = take().filter((c) => c.method === 'editMessageText');
  assert.match(texts(confirm), /Удалить файл <code>app\/\.env<\/code>/);
  assert.ok(existsSync(join(proj, 'app', '.env')), 'до подтверждения файл на месте');
  await U.onFilesCallback(ann, press(ANN, buttons(confirm).find((b) => b.callback_data.startsWith('fl:D:')).callback_data));
  assert.equal(existsSync(join(proj, 'app', '.env')), false);
  take();
});

test('/files: чужая кнопка не открывает, не удаляет и не принимает файлы в чужой проект', async () => {
  F.writeProjectFile(proj, proj, ['keep.env'], 'K=1\n');
  await U.handleFiles(ann);
  const annButtons = buttons(take());
  const fileTok = annButtons.find((b) => b.text.startsWith('📄 keep.env')).callback_data.split(':')[2];
  const dirTok = annButtons.find((b) => b.callback_data.startsWith('fl:n:')).callback_data.split(':')[2];
  for (const data of [`fl:f:${fileTok}`, `fl:d:${fileTok}`, `fl:D:${fileTok}`, `fl:o:${dirTok}:0`, `fl:n:${dirTok}`, `fl:u:${dirTok}`]) {
    await U.onFilesCallback(bob, press(BOB, data));
    assert.deepEqual(take().map((c) => c.method), ['answerCallbackQuery'], `${data}: только отказ`);
  }
  assert.ok(existsSync(join(proj, 'keep.env')), 'файл другого сотрудника цел');
  assert.equal(bob.pendingInput ?? null, null);
});

test('подсказка агенту о секретах: не открывать и не выводить, а значения просить класть через /files', () => {
  assert.match(SECRETS_NOTE, /\.env/);
  assert.match(SECRETS_NOTE, /\/files/);
  assert.match(SECRETS_NOTE, /never show/);
  assert.match(SECRETS_NOTE, /may load them at run time/, 'приложениям доступ к секретам не закрыт');
});

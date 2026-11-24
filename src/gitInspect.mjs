// Git: что изменилось и какие есть ветки — для экранов «Изменения» и «Ветки» в /git.
// Только чтение репозитория, кроме переключения и создания ветки. Команды запускает runGit (git.mjs) — с теми же
// безопасными настройками и, при включённой песочнице, внутри неё.
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertPlainConfig, GitError, runGit } from './git.mjs';
import { samePath } from './projects.mjs';

/** Сколько изменённых файлов показывать (в большом несобранном проекте их могут быть тысячи). */
const CHANGES_MAX = 300;
/** Файлы крупнее этого не читаются ради подсчёта строк. */
const COUNT_MAX_BYTES = 512 * 1024;

const kindOf = (xy) => {
  if (xy === '??') return 'new';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'conflict';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'new';
  return 'modified';
};

/**
 * Разбор `git status --porcelain=v1 -z`: [{path, kind, from?}], kind — new | modified | deleted | renamed | conflict.
 * У переименованного файла следующая запись — прежнее имя.
 */
export function parseChanges(text) {
  const parts = String(text ?? '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const item = { path: rec.slice(3), kind: kindOf(xy) };
    if (xy.includes('R') || xy.includes('C')) item.from = parts[++i];
    out.push(item);
  }
  return out;
}

/** Разбор `git diff --numstat -z`: Map путь → {added, deleted} (у двоичных файлов — null). */
export function parseNumstat(text) {
  const parts = String(text ?? '').split('\0');
  const map = new Map();
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (!path) {
      path = parts[i + 2]; // переименование: далее — прежнее и новое имя
      i += 2;
    }
    if (path) map.set(path, { added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }
  return map;
}

/** Число строк нового файла (которого git ещё не знает) или null, если он велик, двоичный или не читается. */
async function countLines(file) {
  try {
    // файл лежит в папке, куда пишет агент: ссылку не читаем (она может вести на любой файл сервера)
    const st = await lstat(file);
    if (!st.isFile() || st.size > COUNT_MAX_BYTES) return null;
    const buf = await readFile(file);
    if (buf.includes(0)) return null;
    if (!buf.length) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}

/**
 * Несохранённые изменения рабочей папки относительно последнего коммита: [{path, kind, added, deleted, from?}].
 * added / deleted — число строк (null, если неизвестно). total — сколько всего изменённых файлов (список обрезается).
 */
export async function changedFiles(cwd, opts = {}) {
  const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd, ...opts })).trim();
  const all = parseChanges(await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, ...opts }));
  // в репозитории без коммитов сравнивать не с чем — тогда без числа строк
  const counts = await runGit(['diff', '--numstat', '-z', 'HEAD'], { cwd, ...opts }).then(parseNumstat, () => new Map());
  const files = await Promise.all(all.slice(0, CHANGES_MAX).map(async (f) => {
    const c = counts.get(f.path);
    if (c) return { ...f, ...c };
    return { ...f, added: f.kind === 'new' ? await countLines(join(top, f.path)) : null, deleted: f.kind === 'new' ? 0 : null };
  }));
  return { files, total: all.length };
}

/**
 * Изменения одного файла текстом (unified diff, без служебного начала). Новый файл показывается целиком как добавленный.
 * @param {{path: string, kind: string}} file запись из changedFiles (путь — от корня репозитория)
 */
export async function fileDiff(cwd, file, opts = {}) {
  const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd, ...opts })).trim();
  const base = { cwd: top, maxOut: 300_000, ...opts };
  const raw = file.kind === 'new'
    ? await runGit(['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file.path], { ...base, okCodes: [0, 1] })
    : await runGit(['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file.path], base);
  // «diff --git…», «index…» и подобные строки до первого «---» пользователю ничего не говорят
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('--- ') || l.startsWith('Binary files') || l.startsWith('@@'));
  return (start > 0 ? lines.slice(start) : lines).join('\n').trimEnd();
}

/**
 * Коммиты: которые ещё не отправлены ('out') или которые есть на сервере, а локально нет ('in').
 * Без ветки на сервере «не отправлено» — последние коммиты ветки, «на сервере» — пусто.
 * @returns {Promise<{hash: string, author: string, date: string, subject: string}[]>}
 */
export async function commitList(cwd, dir, opts = {}, limit = 20) {
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '@{u}'], { cwd, ...opts }).then((s) => s.trim(), () => null);
  if (!upstream && dir === 'in') return [];
  const range = !upstream ? 'HEAD' : dir === 'in' ? 'HEAD..@{u}' : '@{u}..HEAD';
  const out = await runGit(['log', `-n${limit}`, '--format=%h%x09%an%x09%ad%x09%s', '--date=short', range], { cwd, ...opts }).catch(() => '');
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash, author, date, ...rest] = l.split('\t');
    return { hash, author, date, subject: rest.join('\t') };
  });
}

/**
 * Ветки: локальные и ветки сервера (origin) одним списком — [{name, local, remote, date, current}], текущая первой,
 * дальше по дате последнего коммита.
 */
export async function listBranches(cwd, opts = {}) {
  const current = await runGit(['branch', '--show-current'], { cwd, ...opts }).then((s) => s.trim() || null, () => null);
  const out = await runGit(['for-each-ref', '--format=%(refname)%09%(committerdate:iso-strict)', 'refs/heads', 'refs/remotes/origin'], { cwd, ...opts });
  const map = new Map();
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [ref, date] = line.split('\t');
    const local = ref.startsWith('refs/heads/');
    const name = local ? ref.slice('refs/heads/'.length) : ref.slice('refs/remotes/origin/'.length);
    if (!name || name === 'HEAD') continue;
    const b = map.get(name) ?? { name, local: false, remote: false, date: '' };
    if (local) b.local = true;
    else b.remote = true;
    if (date > b.date) b.date = date;
    map.set(name, b);
  }
  const list = [...map.values()].map((b) => ({ ...b, current: b.name === current }));
  list.sort((a, b) => Number(b.current) - Number(a.current) || b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { current, branches: list };
}

/** Название ветки из текста пользователя: пробелы — в «-»; не подходит — null (проверку формата делает сам git). */
export async function branchName(input, { cwd, ...opts }) {
  const name = String(input ?? '').trim().replace(/\s+/g, '-');
  if (!name || name.length > 100 || name.startsWith('-')) return null;
  return runGit(['check-ref-format', '--branch', name], { cwd, ...opts }).then(() => name, () => null);
}

/**
 * Переключается на ветку: локальную — как есть, существующую только на сервере — создаёт локальную, связанную с ней.
 * Вызывающий отвечает за то, что в рабочей папке нет несохранённых изменений.
 */
export async function switchBranch(cwd, branch, opts = {}) {
  if (!branch?.name || branch.name.startsWith('-')) throw new GitError('некорректное название ветки', { i18n: { key: 'err.gitBadBranch' } });
  await assertPlainConfig(cwd, opts);
  if (branch.local) return runGit(['switch', '--quiet', branch.name], { cwd, ...opts });
  return runGit(['switch', '--quiet', '--track', `origin/${branch.name}`], { cwd, ...opts });
}

/** Создаёт ветку от текущего коммита и переключается на неё (несохранённые изменения остаются в рабочей папке). */
export async function createBranch(cwd, name, opts = {}) {
  await assertPlainConfig(cwd, opts);
  return runGit(['switch', '--quiet', '-c', name], { cwd, ...opts });
}

/**
 * Отменяет несохранённые изменения файлов (записи из changedFiles): изменённые и удалённые возвращаются к последнему
 * коммиту, новые — удаляются. Действие необратимо; что отменять, решает вызывающий (секреты сюда не передаются).
 * @returns {Promise<number>} сколько файлов обработано
 */
export async function discardFiles(cwd, files, opts = {}) {
  if (!files.length) return 0;
  await assertPlainConfig(cwd, opts);
  const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd, ...opts })).trim();
  const at = { cwd: top, ...opts };
  const paths = [...new Set(files.flatMap((f) => [f.path, f.from]).filter(Boolean))];
  // какие пути есть в последнем коммите: их возвращаем, остальные (новые файлы) убираем. Коммитов ещё нет — все файлы
  // новые; любой другой сбой git — ошибка: иначе изменённые файлы были бы приняты за новые и удалены
  const tracked = new Set((await hasCommits(top, opts)) ? (await runGit(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths], at)).split('\0').filter(Boolean) : []);
  const restore = paths.filter((p) => tracked.has(p));
  const remove = paths.filter((p) => !tracked.has(p));
  await runGit(['reset', '-q', '--', ...paths], at).catch(() => {}); // убрать из подготовленного к коммиту
  if (restore.length) await runGit(['checkout', '-q', 'HEAD', '--', ...restore], at);
  if (remove.length) await runGit(['clean', '-f', '-q', '--', ...remove], at);
  return files.length;
}

/** Является ли сама папка cwd корнем репозитория (а не просто лежит внутри чужого, выше по дереву). */
export async function isRepoRoot(cwd, opts = {}) {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd, ...opts }).then((s) => s.trim(), () => null);
  return Boolean(top) && samePath(resolve(top), resolve(cwd));
}

/** Делает папку репозиторием с веткой main, если она им ещё не была (чужой репозиторий выше по дереву не трогается). */
export async function ensureRepo(cwd, opts = {}) {
  if (!(await isRepoRoot(cwd, opts))) await runGit(['init', '-q', '-b', 'main'], { cwd, ...opts });
}

/** Есть ли в репозитории хотя бы один коммит. */
export const hasCommits = (cwd, opts = {}) => runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, ...opts }).then(() => true, () => false);

/** Описание последнего коммита (первая строка) или пусто. */
export const lastSubject = (cwd, opts = {}) => runGit(['log', '-1', '--format=%s'], { cwd, ...opts }).then((s) => s.trim(), () => '');

/** Записывает адрес сервера (origin). Адрес — без входа: он передаётся отдельно, на время отправки. */
export async function setRemote(cwd, url, opts = {}) {
  const has = await runGit(['config', '--get', 'remote.origin.url'], { cwd, ...opts }).then((s) => s.trim(), () => '');
  await runGit(has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url], { cwd, ...opts });
}

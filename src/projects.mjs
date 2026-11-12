// Выбор проекта (рабочей папки агента): пути, список подпапок, поиск.
// Два режима:
// - PROJECTS_ROOT задан (командный сервер): проект — только папка внутри корня, выход за него запрещён;
// - PROJECTS_ROOT не задан (личная установка): проект — любая существующая папка, по умолчанию домашняя.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LANG, t } from './i18n.mjs';

/**
 * Корень проектов (PROJECTS_ROOT, необязательная): реальный путь к существующей папке или null, если не задан.
 * Бросает понятную ошибку, если переменная задана, но папки нет.
 */
export function resolveRoot(value = process.env.PROJECTS_ROOT) {
  if (!value?.trim()) return null;
  let real;
  try {
    real = realpathSync.native(expandHome(value.trim()));
  } catch {
    throw new Error(`PROJECTS_ROOT: папка не найдена: ${value}`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`PROJECTS_ROOT: это не папка: ${value}`);
  return real;
}

/** «~», «~/x», «~\x» → домашняя папка пользователя, от имени которого запущен бот. */
export function expandHome(p) {
  if (p === '~') return homedir();
  if (/^~[\\/]/.test(p)) return join(homedir(), p.slice(2));
  return p;
}

/** Домашняя папка (реальный путь). */
export const HOME = (() => {
  try {
    return realpathSync.native(homedir());
  } catch {
    return homedir();
  }
})();

/** Корень проектов или null (режим без корня). */
export const ROOT = (() => {
  try {
    return resolveRoot();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();

/** Папка по умолчанию для нового пользователя: корень проектов, а без него — домашняя папка. */
export const DEFAULT_DIR = ROOT ?? HOME;

// служебные и тяжёлые папки в навигации и поиске не показываем
const EXCLUDE = new Set(['node_modules', 'renv', '.git', '__pycache__', '$recycle.bin', 'system volume information', '.venv', 'venv', 'packrat', 'site-packages']);

const lc = (s) => s.toLowerCase(); // для поиска и фильтров по имени: регистр не важен на любой ОС

/** Регистр в путях не важен на Windows и macOS (файловые системы по умолчанию), важен на Linux. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

/** Один и тот же путь с учётом правил регистра текущей ОС. */
export const samePath = (a, b) => norm(a) === norm(b);

/** Лежит ли путь `p` внутри `root` или совпадает с ним (оба пути уже реальные). */
export function isWithin(p, root) {
  const r = norm(p);
  const base = norm(root);
  return r === base || r.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Возвращает реальный путь, если он существует, является папкой и (при заданном корне) лежит внутри него
 * после разрешения «..» и ссылок, иначе null. С корнем — защита от выхода за пределы корня проектов;
 * без корня (root = null) подходит любая существующая папка.
 */
export function insideRoot(p, root = ROOT) {
  if (typeof p !== 'string' || !p) return null;
  let real;
  try {
    real = realpathSync.native(p);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return !root || isWithin(real, root) ? real : null;
}

/**
 * Человекочитаемый путь. С корнем — относительно корня; без корня — полный путь, домашняя папка сокращается до «~».
 */
export function display(p, root = ROOT, home = HOME, lang = DEFAULT_LANG) {
  if (root) return samePath(p, root) ? t('proj.root', lang, { root }) : relative(root, p);
  if (samePath(p, home)) return '~';
  return isWithin(p, home) ? `~${sep}${relative(home, p)}` : p;
}

/** Путь проекта для пользователя на его языке (подпись корня). */
export const showPath = (p, lang = DEFAULT_LANG) => display(p, ROOT, HOME, lang);

/**
 * Список недавних проектов после смены проекта prev → next: прежний проект — в начало, новый (текущий) из списка
 * убирается, повторы (с учётом регистра по правилам ОС) схлопываются, не больше limit.
 */
export function pushRecent(list, prev, next, limit = 6) {
  const out = [];
  for (const p of [prev, ...list]) {
    if (typeof p !== 'string' || !p || samePath(p, next) || out.some((q) => samePath(q, p))) continue;
    out.push(p);
  }
  return out.slice(0, limit);
}

/** Можно ли подняться из папки выше: с корнем — пока не дошли до корня, без корня — до корня диска. */
export const canGoUp = (dir, root = ROOT) => (root ? !samePath(dir, root) : dirname(dir) !== dir);

/** С какой папки начинать навигацию в /project: с родителя текущего проекта (или с корня). */
export const navStart = (project, root = ROOT) => (root && samePath(project, root) ? root : canGoUp(project, root) ? dirname(project) : project);

/** Подпапки (имена). Ссылки и junction не показываем — по ним можно выйти за пределы корня. */
export function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink() && !d.name.startsWith('.') && !EXCLUDE.has(lc(d.name)))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'ru'));
  } catch {
    return [];
  }
}

/**
 * Пытается трактовать запрос как путь: абсолютный, «~/…» или относительный — от корня, а без корня от домашней папки.
 */
export function resolveAsPath(query, root = ROOT, home = HOME) {
  const q = expandHome(query.trim().replace(/^["']|["']$/g, ''));
  return insideRoot(isAbsolute(q) ? q : resolve(root ?? home, q), root);
}

/**
 * Поиск папок по частям названия (все слова должны встретиться в относительном пути).
 * @returns {{results: string[], truncated: boolean}}
 */
export function findDirs(query, { maxDepth = 6, limit = 20, maxVisited = 30000, base = ROOT ?? HOME } = {}) {
  const tokens = lc(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return { results: [], truncated: false };
  const found = [];
  let visited = 0;
  let queue = [{ dir: base, depth: 0 }];
  while (queue.length && visited < maxVisited) {
    const next = [];
    for (const { dir, depth } of queue) {
      if (depth >= maxDepth) continue;
      for (const name of listDirs(dir)) {
        visited++;
        const full = join(dir, name);
        const rel = lc(relative(base, full));
        if (tokens.every((t) => rel.includes(t))) {
          const base = lc(basename(full));
          const score = base === lc(query.trim()) ? 0 : tokens.every((t) => base.includes(t)) ? 1 : 2;
          found.push({ full, score, depth: depth + 1 });
        }
        next.push({ dir: full, depth: depth + 1 });
      }
    }
    queue = next;
  }
  found.sort((a, b) => a.score - b.score || a.depth - b.depth || a.full.localeCompare(b.full, 'ru'));
  return { results: found.slice(0, limit).map((f) => f.full), truncated: found.length > limit || visited >= maxVisited };
}

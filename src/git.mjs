// Команды git, которые бот выполняет сам (/git): клонирование, состояние, получение и отправка изменений, коммит.
// Git — системная программа, не зависимость бота: нет её на сервере — раздел /git не показывается.
//
// Безопасность. Репозиторий лежит в папке, куда пишет агент, а настройки и хуки репозитория умеют запускать программы.
// Поэтому: хуки отключены, общий и системный конфиги не читаются (где это возможно), вход передаётся только через
// окружение процесса, а при включённой песочнице (AGENT_SANDBOX) git запускается в песочнице того же сотрудника.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { checkCommand, killTree } from './acp.mjs';
import { agentEnv } from './engines.mjs';
import { isSecretName } from './files.mjs';

const IS_WIN = process.platform === 'win32';

/** Команда git: из GIT_COMMAND или из PATH. */
export const gitCommand = (env = process.env) => env.GIT_COMMAND?.trim() || 'git';

let available = false;
/** Проверка при старте: есть ли git на сервере. */
export async function checkGit() {
  const r = await checkCommand(gitCommand(), ['--version'], 20_000);
  available = r.ok;
  return r;
}
/** Доступен ли git (по проверке при старте). */
export const gitAvailable = () => available;
/** Для тестов и повторной проверки. */
export const setGitAvailable = (on) => {
  available = Boolean(on);
};

/**
 * Настройки git через окружение (GIT_CONFIG_COUNT / KEY_n / VALUE_n): действуют как «-c ключ=значение», но не видны
 * в списке процессов. Добавляются к уже заданным в env.
 * @param {[string, string][]} entries
 */
export function configEnv(entries, env = {}) {
  const out = { ...env };
  let n = Number(out.GIT_CONFIG_COUNT) || 0;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Настройки безопасного запуска: без хуков, без наблюдателя файлов, без помощников входа и внешних транспортов. */
export const SAFE_CONFIG = [
  ['core.hooksPath', devNull],
  ['core.fsmonitor', 'false'],
  ['credential.helper', ''],
  ['protocol.ext.allow', 'never'],
  ['advice.detachedHead', 'false'],
  ['core.quotePath', 'false'], // имена файлов не латиницей — как есть, а не восьмеричными кодами
];

/**
 * Окружение процесса git, который запускает бот: без токена бота и ключей API, без вопросов в терминале, с безопасными
 * настройками; identity — автор коммитов {name, email}; auth — настройки входа (gitHosts.authConfig).
 * На Linux и macOS общий и системный конфиги не читаются: в песочнице общий конфиг лежит в папке, куда пишет агент.
 */
export function gitEnv({ identity = null, auth = [], base = process.env } = {}) {
  const env = { ...agentEnv({ apiKeys: [] }, base), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_PAGER: 'cat', LC_ALL: 'C' };
  if (!IS_WIN) Object.assign(env, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' });
  if (identity?.name && identity?.email) {
    Object.assign(env, { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email });
  }
  return configEnv([...SAFE_CONFIG, ...auth], env);
}

/** Команда git завершилась с ошибкой: code — код выхода, stderr — её вывод (без секретов). */
export class GitError extends Error {
  constructor(message, { code = null, stderr = '', timeout = false } = {}) {
    super(message);
    this.code = code;
    this.stderr = stderr;
    this.timeout = timeout;
  }
}

/**
 * Запускает git. Без оболочки: аргументы (описание коммита, имена файлов) передаются как есть.
 * @param {string[]} args
 * @param {{cwd: string, env?: object, wrap?: {command: string, args: string[], env: Function}|null, timeoutMs?: number, hide?: string[]}} o
 *   wrap — песочница (sandbox.agentSandbox с командой git); hide — строки, которые нужно вычистить из вывода (токены)
 * @returns {Promise<string>} stdout
 */
export function runGit(args, { cwd, env = gitEnv(), wrap = null, timeoutMs = 120_000, hide = [] } = {}) {
  const command = wrap ? wrap.command : gitCommand();
  const argv = wrap ? [...wrap.args, ...args] : args;
  const clean = (s) => hide.filter(Boolean).reduce((acc, h) => acc.replaceAll(h, '***'), s);
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, argv, { cwd, env: wrap ? wrap.env(env) : env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !IS_WIN });
    } catch (e) {
      return reject(new GitError(e.message));
    }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc, 1000);
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new GitError(e.message));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new GitError(`git ${args[0]}: нет ответа за ${Math.round(timeoutMs / 1000)} с`, { timeout: true }));
      if (code !== 0) {
        const stderr = clean(err.trim());
        // подсказки git («hint: …») пользователю не нужны — в сообщение идут последние содержательные строки
        const lines = stderr.split(/\r?\n/).filter((l) => l.trim() && !/^hint:/i.test(l));
        return reject(new GitError(lines.slice(-3).join(' | ') || `git ${args[0]}: код ${code}`, { code, stderr }));
      }
      resolve(clean(out));
    });
  });
}

/**
 * Разбор `git status --porcelain=v2 --branch`.
 * @returns {{branch: string|null, upstream: string|null, ahead: number, behind: number, changed: number}}
 */
export function parseStatus(text) {
  const st = { branch: null, upstream: null, ahead: 0, behind: 0, changed: 0 };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) st.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (line && !line.startsWith('#')) st.changed++;
  }
  return st;
}

/**
 * Состояние репозитория в папке cwd или null, если это не репозиторий git.
 * @returns {Promise<null | {top: string, remote: string|null, branch: string|null, upstream: string|null, ahead: number, behind: number, changed: number}>}
 */
export async function repoState(cwd, opts = {}) {
  let top;
  try {
    top = (await runGit(['rev-parse', '--show-toplevel'], { cwd, ...opts })).trim();
  } catch {
    return null;
  }
  // адрес как записан в настройках репозитория (без подстановок url.*.insteadOf): по нему определяется сервис
  const remote = await runGit(['config', '--get', 'remote.origin.url'], { cwd, ...opts }).then((s) => s.trim() || null, () => null);
  const status = parseStatus(await runGit(['status', '--porcelain=v2', '--branch'], { cwd, ...opts }));
  return { top, remote, ...status };
}

/** Клонирует репозиторий url в папку dest (её ещё нет), запускается из её родительской папки cwd. Подмодули не тянутся. */
export const cloneRepo = (url, dest, { cwd, ...opts }) => runGit(['clone', '--no-recurse-submodules', '--', url, dest], { cwd, timeoutMs: 10 * 60_000, ...opts });

/** Сверяется с сервером (git fetch): рабочие файлы не трогает, обновляет сведения о ветках сервера. */
export const fetchRepo = (cwd, opts = {}) => runGit(['fetch', '--prune', 'origin'], { cwd, timeoutMs: 60_000, ...opts });

/**
 * Получает изменения с сервера: fetch и перемотка вперёд, если это возможно без слияния.
 * @returns {Promise<'updated'|'uptodate'|'diverged'|'noupstream'>} diverged — истории разошлись, нужно слияние (его делает агент)
 */
export async function pullRepo(cwd, opts = {}) {
  await fetchRepo(cwd, opts);
  const before = parseStatus(await runGit(['status', '--porcelain=v2', '--branch'], { cwd, ...opts }));
  if (!before.upstream) return 'noupstream';
  if (!before.behind) return 'uptodate';
  if (before.ahead) return 'diverged';
  await runGit(['merge', '--ff-only', '@{u}'], { cwd, ...opts });
  return 'updated';
}

/** Файлы с секретами среди коммитов, которые ещё не отправлены на сервер (по именам: .env, ключи, учётные данные). */
export async function unpushedSecrets(cwd, opts = {}) {
  const st = parseStatus(await runGit(['status', '--porcelain=v2', '--branch'], { cwd, ...opts }));
  // без ветки на сервере сравнивать не с чем — смотрим все файлы текущего коммита
  const args = st.upstream ? ['diff', '--name-only', '--diff-filter=AM', '@{u}', 'HEAD'] : ['ls-tree', '-r', '--name-only', 'HEAD'];
  const names = await runGit(args, { cwd, ...opts }).then((s) => s.split(/\r?\n/).filter(Boolean), () => []);
  return names.filter((n) => isSecretName(`/${n}`));
}

/** Отправляет текущую ветку на сервер (и связывает её с веткой сервера). */
export const pushRepo = (cwd, opts = {}) => runGit(['push', '-u', 'origin', 'HEAD'], { cwd, ...opts });

/**
 * Коммитит все изменения, кроме файлов с секретами: их из коммита убирает, новые — дописывает в .gitignore.
 * @returns {Promise<{committed: boolean, skipped: string[], tracked: string[]}>} committed — коммит создан (было что
 *   коммитить); skipped — новые файлы с секретами, внесённые в .gitignore; tracked — файлы с секретами, которые уже
 *   были в репозитории: их изменения в коммит не вошли
 */
export async function commitAll(cwd, message, opts = {}) {
  await runGit(['add', '-A'], { cwd, ...opts });
  const staged = (await runGit(['diff', '--cached', '--name-status'], { cwd, ...opts }))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => ({ status: l[0], name: l.split('\t').pop() }));
  const secrets = staged.filter((f) => f.status !== 'D' && isSecretName(`/${f.name}`));
  const skipped = secrets.filter((f) => f.status === 'A').map((f) => f.name);
  const tracked = secrets.filter((f) => f.status !== 'A').map((f) => f.name);
  if (secrets.length) {
    await runGit(['reset', '-q', '--', ...secrets.map((f) => f.name)], { cwd, ...opts });
    if (skipped.length) {
      const top = (await runGit(['rev-parse', '--show-toplevel'], { cwd, ...opts })).trim();
      const file = join(top, '.gitignore');
      const have = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const lines = skipped.map((n) => `/${n}`).filter((l) => !have.split(/\r?\n/).includes(l));
      if (lines.length) appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
      await runGit(['add', '--', '.gitignore'], { cwd: top, ...opts });
    }
  }
  const left = (await runGit(['diff', '--cached', '--name-only'], { cwd, ...opts })).trim();
  if (!left) return { committed: false, skipped, tracked };
  await runGit(['commit', '-q', '-m', message], { cwd, ...opts });
  return { committed: true, skipped, tracked };
}

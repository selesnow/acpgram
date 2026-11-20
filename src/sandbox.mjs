// Песочница процесса агента: необязательная изоляция на уровне ОС (AGENT_SANDBOX=bwrap, только Linux).
//
// Уровни доступа и корень проектов ограничивают, что агенту разрешено и где он начинает работу, но сам процесс
// работает с правами учётной записи бота: по просьбе пользователя он прочитал бы .env бота, базу и чужие папки.
// С песочницей агент сотрудника запускается через bubblewrap (системная утилита, не зависимость бота) и видит только:
//   - систему на чтение (/usr, /etc и т. п.) и программы движка и Node;
//   - на запись: свой корень проектов (личное пространство), свою домашнюю папку и каталог исходящих файлов;
//   - на чтение: каталог своих загрузок.
// Всё остальное (.env и данные бота, домашняя папка учётной записи, чужие пространства, чужие процессы) в песочнице
// отсутствует. Пути внутри совпадают с путями на сервере, поэтому остальной бот о песочнице не знает.
// Сеть не изолируется: агенту нужен доступ к моделям. Администратор работает без песочницы.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { checkCommand } from './acp.mjs';
import { DATA_DIR, ENV_PATH } from './app.mjs';
import { outboxDir, uploadsDir } from './files.mjs';
import { isWithin } from './projects.mjs';

/**
 * Режим песочницы из AGENT_SANDBOX: 'bwrap' или null (выключена). Неизвестное значение и не Linux — ошибка: бот не
 * должен молча работать без песочницы, когда её просили.
 */
export function sandboxMode(value = process.env.AGENT_SANDBOX, platform = process.platform) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'off') return null;
  if (v !== 'bwrap') throw new Error(`AGENT_SANDBOX=${value}: неизвестное значение (допустимо: bwrap)`);
  if (platform !== 'linux') throw new Error('AGENT_SANDBOX=bwrap работает только на Linux. На этой системе уберите настройку — агенты будут работать без песочницы');
  return v;
}

/** Включённая песочница ('bwrap') или null. Ошибка в настройке — бот не запускается. */
export const SANDBOX = (() => {
  try {
    return sandboxMode();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();

/** Команда bubblewrap: из BWRAP_COMMAND или из PATH. */
export const bwrapCommand = (env = process.env) => env.BWRAP_COMMAND?.trim() || 'bwrap';

/** Системные папки, которые песочница видит на чтение (каких нет — пропускаются). */
export const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc'];

/** Список путей из переменной окружения (разделитель — как в PATH). */
export const pathList = (value) => String(value ?? '').split(delimiter).map((s) => s.trim()).filter(Boolean);

/** Домашняя папка сотрудника в песочнице: настройки, вход и история сессий движков — у каждого свои. */
export const sandboxHome = (userId, base = DATA_DIR) => join(base, 'homes', String(userId));

/** Полный путь к команде: абсолютный как есть, иначе поиск исполняемого файла по PATH. Не нашлась — null. */
export function findCommand(cmd, pathEnv = process.env.PATH) {
  const runnable = (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(cmd)) return runnable(cmd) ? cmd : null;
  if (cmd.includes('/') || cmd.includes(sep)) return null; // относительный путь: от какой папки — неизвестно
  for (const dir of pathList(pathEnv)) if (isAbsolute(dir) && runnable(join(dir, cmd))) return join(dir, cmd);
  return null;
}

/**
 * Какие папки нужны, чтобы команда запустилась в песочнице: папка, где она лежит (обычно это ссылка), и место, куда
 * ссылка ведёт. Для npm-пакета — весь каталог node_modules, в котором он установлен (пакет подгружает соседние:
 * у OpenCode исполняемый файл лежит в отдельном пакете платформы).
 */
export function commandBinds(cmdPath) {
  const out = [dirname(cmdPath)];
  let real;
  try {
    real = realpathSync.native(cmdPath);
  } catch {
    return out;
  }
  const parts = real.split(sep);
  const i = parts.indexOf('node_modules');
  out.push(i > 0 ? parts.slice(0, i + 1).join(sep) : dirname(real));
  return [...new Set(out)];
}

/**
 * Секрет, который открыла бы песочнице папка `path` (секрет лежит в ней или совпадает с ней), или null.
 * Такую папку подключать нельзя: агент прочитал бы .env или базу бота, либо чужие пространства.
 */
export const exposedSecret = (path, secrets) => secrets.find((s) => s && isWithin(s, path)) ?? null;

/** Папку нельзя открыть песочнице: внутри неё секреты бота или чужие данные. */
export class SandboxError extends Error {
  code = 'SANDBOX';
}

/**
 * Аргументы bubblewrap. Корень песочницы пуст; в него подключается только перечисленное (пути те же, что на сервере).
 * Порядок важен: более поздние подключения перекрывают ранние — сначала система, затем «только чтение», затем «запись».
 * @param {{cwd: string, rw: string[], ro?: string[], system?: string[]}} o
 */
export function bwrapArgs({ cwd, rw, ro = [], system = SYSTEM_DIRS }) {
  const inSystem = (p) => system.some((d) => isWithin(p, d));
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  const args = [
    '--die-with-parent', // бот завершился — агент не остаётся работать
    '--unshare-pid', // свои процессы: чужих не видно и не убить; завершение bwrap завершает всё дерево агента
    '--unshare-ipc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];
  for (const d of system) args.push('--ro-bind-try', d, d);
  for (const p of uniq(ro).filter((p) => !inSystem(p))) args.push('--ro-bind-try', p, p);
  for (const p of uniq(rw)) args.push('--bind', p, p);
  args.push('--chdir', cwd);
  return args;
}

// Переменные, указывающие на домашнюю папку и службы учётной записи бота: в песочнице их нет
const HOST_ONLY_ENV = /^(XDG_(CONFIG|DATA|CACHE|STATE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|ACPGRAM_HOME)$/;

/** Окружение процесса в песочнице: своя домашняя папка, временные файлы в /tmp, Node бота — в PATH. */
export function sandboxEnv(env, { home, nodeDir = dirname(process.execPath) } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!HOST_ONLY_ENV.test(k)) out[k] = v;
  const path = pathList(out.PATH);
  if (nodeDir && !path.includes(nodeDir)) path.push(nodeDir);
  return { ...out, HOME: home, TMPDIR: '/tmp', PATH: path.join(delimiter) };
}

/** Куда ведёт /etc/resolv.conf, если за пределы системных папок (systemd-resolved, WSL): без этого файла не работает DNS. */
function resolvConf() {
  try {
    const real = realpathSync.native('/etc/resolv.conf');
    return SYSTEM_DIRS.some((d) => isWithin(real, d)) ? null : real;
  } catch {
    return null;
  }
}

/** Папки Node, на котором работает бот: движки — скрипты Node («#!/usr/bin/env node»). */
function nodeBinds() {
  const out = [dirname(process.execPath)];
  try {
    out.push(dirname(realpathSync.native(process.execPath)));
  } catch {
    /* ссылка сломана — остаётся папка из execPath */
  }
  return out;
}

/**
 * Что песочнице нельзя открывать ни при каких настройках: папка, внутри которой лежит .env или каталог данных бота.
 * Свои каталоги сотрудника (домашняя папка, загрузки, исходящие) лежат внутри каталога данных — это не утечка.
 */
export const botSecrets = () => [ENV_PATH, DATA_DIR];

/** Файлы, которых изнутри песочницы не должно быть видно (проверка при старте). */
export const botSecretFiles = () => [ENV_PATH, join(DATA_DIR, 'bot.db')];

/** Каталоги служебного «пользователя» для проверок при старте. */
const checkDirs = (base = DATA_DIR) => {
  const dir = join(base, 'homes', '_check');
  return { userId: '_check', cwd: dir, home: dir, uploads: join(dir, 'in'), outbox: join(dir, 'out') };
};

/**
 * Запуск команды в песочнице сотрудника: {command, args, env} — bwrap и его аргументы, после которых идут аргументы
 * самой команды; env(окружение) — окружение процесса. Каталоги сотрудника создаются, если их нет.
 * Бросает SandboxError, если подключаемая папка открыла бы секреты бота или (protect) чужие данные.
 * @param {object} o
 * @param {number|string} o.userId
 * @param {string} o.cwd       рабочая папка агента (проект)
 * @param {string|null} o.root корень пользователя: вся эта папка доступна на запись; null — только cwd
 * @param {string} o.command   команда движка (имя из PATH или полный путь)
 * @param {string[]} [o.protect]  что ещё нельзя открывать (корень проектов, если у сотрудника личное пространство)
 * @param {string[]} [o.extraRo]  дополнительные папки на чтение (SANDBOX_RO_PATHS)
 */
export function agentSandbox({
  userId,
  cwd,
  root = null,
  command,
  protect = [],
  extraRo = pathList(process.env.SANDBOX_RO_PATHS),
  home = sandboxHome(userId),
  uploads = uploadsDir(userId),
  outbox = outboxDir(userId),
  secrets = botSecrets(),
  bwrap = bwrapCommand(),
}) {
  const inner = findCommand(command);
  if (!inner) throw new SandboxError(`команда не найдена: ${command}`);
  const rw = [root ?? cwd, home, outbox];
  const ro = [uploads, ...commandBinds(inner), ...nodeBinds(), ...extraRo, resolvConf()].filter(Boolean);
  // свои каталоги сотрудника лежат внутри данных бота — это не утечка; опасна только папка, внутри которой лежит секрет
  for (const p of [...rw, ...ro]) {
    const secret = exposedSecret(p, [...secrets, ...protect]);
    if (secret) throw new SandboxError(`папку ${p} нельзя открыть песочнице: внутри неё ${secret}`);
  }
  for (const d of [home, uploads, outbox]) mkdirSync(d, { recursive: true });
  return { command: bwrap, args: [...bwrapArgs({ cwd, rw, ro }), '--', inner], env: (base) => sandboxEnv(base, { home }) };
}

/** Подсказка по тексту ошибки bwrap: чаще всего запрещены пространства имён пользователя. */
export const sandboxHint = (error) =>
  /namespace|uid map|Operation not permitted|Permission denied/i.test(String(error ?? ''))
    ? 'Системе запрещены непривилегированные пространства имён пользователя. Ubuntu 24.04+: sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 (или профиль AppArmor для bwrap); в Docker песочница не поддерживается'
    : 'Установите пакет bubblewrap (apt install bubblewrap, dnf install bubblewrap) или укажите путь в BWRAP_COMMAND';

/**
 * Проверка при старте: bwrap запускается, внутри видна рабочая папка и не видны секреты бота.
 * @returns {{ok: true} | {ok: false, error: string, hint: string}}
 */
export function probeSandbox({ base = DATA_DIR, secrets = botSecrets(), files = botSecretFiles(), bwrap = bwrapCommand(), timeoutMs = 20_000 } = {}) {
  const fail = (error) => ({ ok: false, error, hint: sandboxHint(error) });
  if (!findCommand(bwrap)) return fail(`команда ${bwrap} не найдена`);
  const sh = findCommand('sh');
  if (!sh) return fail('команда sh не найдена');
  let sb;
  try {
    sb = agentSandbox({ ...checkDirs(base), command: sh, secrets, bwrap });
  } catch (e) {
    return fail(e.message);
  }
  // 3 — секрет виден изнутри; 4 — в рабочую папку нельзя писать
  const script = 'for f in "$@"; do [ -e "$f" ] && exit 3; done; : > .probe || exit 4; rm -f .probe';
  const r = spawnSync(sb.command, [...sb.args, '-c', script, 'sh', ...files], { env: sb.env(process.env), encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return fail(r.error.message);
  if (r.status === 3) return fail('секреты бота видны изнутри песочницы');
  if (r.status === 4) return fail('в рабочую папку внутри песочницы нельзя писать');
  if (r.status !== 0) return fail((r.stderr || '').trim().split(/\r?\n/).slice(-2).join(' | ') || `код ${r.status}`);
  return { ok: true };
}

/**
 * Запускается ли команда движка внутри песочницы (`<команда> --version`): так при старте видно, что программы движка
 * песочнице доступны. Не запустилась — обычно движок установлен в месте, которое нужно добавить в SANDBOX_RO_PATHS.
 * @returns {Promise<{ok: boolean, version?: string, error?: string, timeout?: boolean}>}
 */
export async function checkInSandbox(command, args, env, { timeoutMs = 60_000, base = DATA_DIR } = {}) {
  let sb;
  try {
    sb = agentSandbox({ ...checkDirs(base), command });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return checkCommand(sb.command, [...sb.args, ...args], timeoutMs, sb.env(env));
}

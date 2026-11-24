// Аккаунты Git пользователей и то, что из них получает агент.
//
// Токен доступа хранится в базе бота и по умолчанию агенту не передаётся: клонирование, получение и отправку делает
// бот по кнопкам в /git, а агент работает с репозиторием локально. Администратор может выбрать другой режим —
// GIT_AGENT_AUTH=1: тогда вход передаётся и процессу агента (через его окружение), и агент сам тянет и отправляет
// изменения. Это удобнее, но токен становится виден агенту, а значит может попасть в запрос к модели.
import { db, log } from './ctx.mjs';
import { DeviceError, deviceLogin, refreshLogin } from './gitDevice.mjs';
import { configEnv, gitAvailable } from './git.mjs';
import { authConfig, customHost, gitHosts, hostById, hostOfUrl } from './gitHosts.mjs';

/** Режим «вход у агента»: токены пользователя передаются процессу его агента. По умолчанию выключен. */
export const GIT_AGENT_AUTH = process.env.GIT_AGENT_AUTH?.trim() === '1';

// ---- свои серверы (GitLab, GitHub Enterprise), добавленные администратором в /git ----

const HOSTS_KEY = 'git:hosts';

/** Свои серверы, добавленные администратором: [{kind, url, name}]. */
function customHosts() {
  try {
    const list = JSON.parse(db.getSetting(HOSTS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && typeof x.url === 'string') : [];
  } catch {
    return [];
  }
}

/** Все сервисы этой установки: GitHub, GitLab.com, серверы из настроек и добавленные администратором. */
export const hosts = () => gitHosts(process.env, customHosts());
/** Сервис по id или null. */
export const findHost = (id) => hostById(id, hosts());
/** Сервис, которому принадлежит адрес репозитория, или null. */
export const hostFor = (url) => hostOfUrl(url, hosts());

/**
 * Добавляет свой сервер. @returns {{host: object} | {error: 'bad'|'exists'}} bad — адрес не подходит (нужен https,
 * не github.com и не gitlab.com), exists — такой сервер уже есть.
 */
export function addCustomHost(kind, url, name = '') {
  const host = customHost(kind, url, name);
  if (!host) return { error: 'bad' };
  if (hosts().some((h) => h.web === host.web)) return { error: 'exists' };
  db.setSetting(HOSTS_KEY, JSON.stringify([...customHosts(), { kind, url: host.web, name: String(name ?? '').trim() }]));
  return { host };
}

/** Меняет название своего сервера (для кнопок). Возвращает false, если сервера нет или он задан в настройках. */
export function renameCustomHost(id, name) {
  const list = customHosts();
  const i = list.findIndex((x) => customHost(x.kind, x.url)?.id === id);
  if (i < 0) return false;
  list[i] = { ...list[i], name: String(name ?? '').trim().slice(0, 40) };
  db.setSetting(HOSTS_KEY, JSON.stringify(list));
  return true;
}

/**
 * Убирает свой сервер вместе с подключёнными к нему аккаунтами всех пользователей (их токены удаляются).
 * @returns {number|null} сколько аккаунтов удалено; null — сервера нет или он задан в настройках
 */
export function removeCustomHost(id) {
  const list = customHosts();
  const rest = list.filter((x) => customHost(x.kind, x.url)?.id !== id);
  if (rest.length === list.length) return null;
  db.setSetting(HOSTS_KEY, JSON.stringify(rest));
  return db.deleteGitAccountsByHost(id);
}

/** Подключённые аккаунты пользователя вместе с их сервисами: [{host, account}] (аккаунты убранных сервисов пропускаются). */
export function accountsOf(userId, list = hosts()) {
  return db.listGitAccounts(userId).map((account) => ({ host: hostById(account.host, list), account })).filter((x) => x.host);
}

/** Автор коммитов по аккаунту: {name, email}. */
export const identityOf = (account) => (account ? { name: account.name || account.login, email: account.email } : null);

/**
 * Переменные окружения процесса агента: автор коммитов (чтобы коммиты агента были от имени пользователя) и, в режиме
 * GIT_AGENT_AUTH, вход в сервисы. Без подключённых аккаунтов — пусто: агент работает с git как раньше.
 */
export function agentGitEnv(userId, { agentAuth = GIT_AGENT_AUTH, base = process.env } = {}) {
  const list = accountsOf(userId);
  if (!list.length) return {};
  const who = identityOf(list[0].account);
  // Автор — настройкой git (user.name / user.email), а не переменными GIT_AUTHOR_*: она действует как значение по
  // умолчанию и уступает явному выбору автора (ключ -c, переменные GIT_AUTHOR_*), которым пользуются скрипты коммитов.
  const entries = [['user.name', who.name], ['user.email', who.email]];
  if (agentAuth) entries.push(...list.flatMap(({ host, account }) => authConfig(host, account.token)));
  // нумерация продолжает настройки, уже заданные в окружении бота: они тоже достаются агенту
  const env = configEnv(entries, base.GIT_CONFIG_COUNT ? { GIT_CONFIG_COUNT: base.GIT_CONFIG_COUNT } : {});
  return agentAuth ? { ...env, GIT_TERMINAL_PROMPT: '0' } : env;
}

// ---- обновление входа, полученного по ссылке и коду (GitLab: токен живёт 2 часа) ----

/** За сколько до истечения токен обновляется заранее: операция (клонирование, отправка) должна успеть с ним закончиться. */
const REFRESH_AHEAD_MS = 15 * 60_000;
const refreshing = new Map(); // «пользователь:сервис» → идущее обновление (второе не запускаем: токен обновления одноразовый)

/**
 * Обновляет токены аккаунтов пользователя, которым пора (вход по коду с истекающим токеном). Вызывается перед любой
 * операцией /git: дальше код читает из базы уже свежий токен. Токен обновления одноразовый, поэтому одновременные
 * вызовы ждут одно и то же обновление.
 * @returns {Promise<{host: object, login: string}[]>} аккаунты, вход в которые больше не действует — они отключены,
 *   пользователю нужно подключить их заново
 */
export async function refreshAccounts(userId, { now = Date.now(), refresh = refreshLogin } = {}) {
  const lost = [];
  for (const { host, account } of accountsOf(userId)) {
    if (!account.refresh_token || !account.access_until || Date.parse(account.access_until) - now > REFRESH_AHEAD_MS) continue;
    const cfg = deviceLogin(host);
    const key = `${userId}:${host.id}`;
    if (!refreshing.has(key)) {
      const run = (async () => {
        if (!cfg) throw new DeviceError('expired', 'вход по коду для сервиса выключен');
        const g = await refresh(cfg, account.refresh_token);
        db.setGitTokens(userId, host.id, { token: g.token, refreshToken: g.refreshToken ?? account.refresh_token, accessUntil: g.expiresIn ? new Date(Date.now() + g.expiresIn * 1000).toISOString() : null });
        log('git: вход обновлён:', userId, host.id);
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, run);
    }
    try {
      await refreshing.get(key);
    } catch (e) {
      log('git: вход не обновлён:', userId, host.id, '|', e.code ?? '', e.message);
      // сервис больше не принимает токен обновления: аккаунт бесполезен — отключаем, пользователь подключит заново.
      // Сбой сети — не повод отключать: попробуем при следующей операции
      if (e instanceof DeviceError && e.code === 'expired') {
        db.deleteGitAccount(userId, host.id);
        lost.push({ host, login: account.login });
      }
    }
  }
  return lost;
}

const DAY_MS = 24 * 3600_000;

/**
 * Кому пора напомнить об истекающем токене: за 7 дней, за день и когда срок вышел. Каждое напоминание — один раз
 * (отметка в настройках: срок токена и ступень); новый токен с другим сроком начинает отсчёт заново.
 * @returns {{userId: number, host: object, account: object, stage: '7'|'1'|'expired', days: number}[]}
 */
export function tokenReminders(now = Date.now()) {
  const out = [];
  for (const account of db.allGitAccounts()) {
    const host = account.expires_at ? findHost(account.host) : null;
    if (!host) continue;
    const days = Math.ceil((Date.parse(account.expires_at) - now) / DAY_MS);
    const stage = days <= 0 ? 'expired' : days <= 1 ? '1' : days <= 7 ? '7' : null;
    if (!stage) continue;
    const key = `gitexp:${account.user_id}:${account.host}`;
    const mark = `${account.expires_at}|${stage}`;
    if (db.getSetting(key) === mark) continue;
    db.setSetting(key, mark);
    out.push({ userId: account.user_id, host, account, stage, days });
  }
  return out;
}

/**
 * Подсказка агенту о git (служебный текст — на английском). Без входа: не пытаться получать и отправлять, а направлять
 * пользователя в /git. Со входом (GIT_AGENT_AUTH): работать можно, показывать вход нельзя. Нет git на сервере — null.
 */
export function gitNote(userId, { agentAuth = GIT_AGENT_AUTH } = {}) {
  if (!gitAvailable()) return null;
  const connected = db.listGitAccounts(userId).length > 0;
  if (agentAuth && connected) {
    return (
      '[AcpGram] Git: the user\'s sign-in for their Git hosting is provided to git through your environment, so fetch, pull and push work. ' +
      'Never print, echo or store these credentials (do not show `env` or `git config --list` output). Never commit files with secrets (.env, keys).'
    );
  }
  return (
    '[AcpGram] Git: use git locally as usual (status, diff, add, commit, branches, merge). You have no credentials for the remote: ' +
    'do not try to fetch, pull, push or clone private repositories and do not ask the user for tokens or passwords. ' +
    'When changes must be sent to or received from the server, put [[git:push]] or [[git:pull]] on its own line at the end of your reply: ' +
    'the bot then shows the user a button that does it (commit first — the button only pushes). The user can also open /git. Never commit files with secrets (.env, keys).'
  );
}

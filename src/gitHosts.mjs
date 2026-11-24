// Сервисы Git: GitHub, GitLab.com и свои серверы — GitLab и GitHub Enterprise, которые добавляет администратор в /git
// (или задаёт в настройках: GITLAB_URL, GITHUB_URL). Профиль и репозитории пользователя по его токену доступа и вход
// для команд git. Только встроенный fetch — без зависимостей.
//
// Вход git не пишется ни в настройки репозитория, ни в адрес: он передаётся процессу git через окружение
// (GIT_CONFIG_*: заголовок Authorization только для адреса своего сервиса) на время одной операции.

const TIMEOUT_MS = 15_000;

/**
 * Адрес своего сервера из текста администратора: «https://git.example.com» или с путём («https://host/gitlab»).
 * Только https; завершающие «/», запрос и якорь отбрасываются. Не подходит — null.
 */
function normalizeHostUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null;
  return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

/** Id своего сервера: вид и адрес («gitlab-git-example-com») — одинаковый, откуда бы сервер ни был задан. */
const hostId = (kind, web) => `${kind}-${web.replace(/^https:\/\//, '')}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').slice(0, 40);

const githubHost = (id, label, web, api) => ({ id, kind: 'github', label, web, api, tokenUrl: `${web}/settings/tokens`, user: 'x-access-token', scopes: 'repo, read:org' });
const gitlabHost = (id, label, web) => ({ id, kind: 'gitlab', label, web, api: `${web}/api/v4`, tokenUrl: `${web}/-/user_settings/personal_access_tokens`, user: 'oauth2', scopes: 'api, read_repository, write_repository' });

/**
 * Свой сервер: GitLab или GitHub Enterprise по адресу. name — название для кнопок (по умолчанию — имя сервера).
 * @param {'gitlab'|'github'} kind
 * @returns {object|null} null — адрес не подходит или это общий сервис (github.com, gitlab.com)
 */
export function customHost(kind, url, name = '') {
  const web = normalizeHostUrl(url);
  if (!web || (kind !== 'gitlab' && kind !== 'github') || /^https:\/\/(www\.)?(github|gitlab)\.com$/.test(web)) return null;
  const label = String(name ?? '').trim().slice(0, 40) || new URL(web).host;
  const host = kind === 'gitlab' ? gitlabHost(hostId(kind, web), label, web) : githubHost(hostId(kind, web), label, web, `${web}/api/v3`);
  return { ...host, custom: true };
}

/**
 * Сервисы, к которым можно подключиться: GitHub и GitLab.com — всегда; свои серверы — из настроек (GITLAB_URL и
 * GITLAB_NAME, GITHUB_URL и GITHUB_NAME) и добавленные администратором (extra: [{kind, url, name}]). Один и тот же
 * адрес дважды не попадает. kind — чей API; user — имя пользователя для входа git по токену; fromEnv — задан в настройках.
 * @returns {{id: string, kind: 'github'|'gitlab', label: string, web: string, api: string, tokenUrl: string, user: string, scopes: string, custom?: boolean, fromEnv?: boolean}[]}
 */
export function gitHosts(env = process.env, extra = []) {
  const hosts = [githubHost('github', 'GitHub', 'https://github.com', 'https://api.github.com'), gitlabHost('gitlab', 'GitLab.com', 'https://gitlab.com')];
  const add = (h, fromEnv) => {
    if (h && !hosts.some((x) => x.web === h.web)) hosts.push(fromEnv ? { ...h, fromEnv: true } : h);
  };
  add(customHost('gitlab', env.GITLAB_URL, env.GITLAB_NAME), true);
  add(customHost('github', env.GITHUB_URL, env.GITHUB_NAME), true);
  for (const x of Array.isArray(extra) ? extra : []) add(customHost(x?.kind, x?.url, x?.name), false);
  return hosts;
}

/** Сервис по id или null. */
export const hostById = (id, hosts = gitHosts()) => hosts.find((h) => h.id === id) ?? null;

/** Сервис, которому принадлежит адрес репозитория (только https), или null. */
export function hostOfUrl(url, hosts = gitHosts()) {
  const u = String(url ?? '').trim().toLowerCase();
  return hosts.find((h) => u === h.web.toLowerCase() || u.startsWith(`${h.web.toLowerCase()}/`)) ?? null;
}

/**
 * Похож ли адрес на сервер своего вида: его API отвечает JSON (без токена — обычно отказом 401, это тоже ответ API).
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function probeHost(host, { fetchImpl = fetch } = {}) {
  const url = host.kind === 'gitlab' ? `${host.api}/version` : `${host.api}/meta`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'acpgram' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const isJson = /json/i.test(res.headers?.get?.('content-type') ?? '');
  return [200, 401, 403].includes(res.status) && isJson ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
}

/** Адрес репозитория для показа: «github.com/owner/repo» (без схемы, входа и «.git»). */
export const showRemote = (url) => String(url ?? '').trim().replace(/^https?:\/\/([^@/]*@)?/i, '').replace(/\.git$/i, '');

/** Имя папки по адресу репозитория: «https://host/group/my-app.git» → «my-app». */
export const repoFolder = (url) => showRemote(url).split('/').filter(Boolean).pop() ?? '';

/**
 * Настройка git для входа по токену: заголовок Authorization только для адресов этого сервиса (на другой адрес —
 * например, после перенаправления или подмены origin — токен не уйдёт). Пары [ключ, значение] для configEnv.
 */
export const authConfig = (host, token) => [[`http.${host.web}/.extraheader`, `Authorization: Basic ${Buffer.from(`${host.user}:${token}`).toString('base64')}`]];

/** Ошибка обращения к сервису: code — 'auth' (токен не подошёл), 'http' или 'network'. */
export class HostError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Что сервис написал в ответе с ошибкой: у GitLab — message (строка, список или {поле: [причины]}), у GitHub — message и errors. */
function errorDetail(data) {
  const m = data?.message ?? data?.error_description ?? data?.error;
  const flat = (v) => (v == null ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flat) : Object.entries(v).flatMap(([k, x]) => flat(x).map((s) => `${k} ${s}`)));
  const extra = Array.isArray(data?.errors) ? data.errors.map((e) => (typeof e === 'string' ? e : e?.message || [e?.field, e?.code].filter(Boolean).join(' '))).filter(Boolean) : [];
  return [...flat(m), ...extra].join('; ').slice(0, 300);
}

/**
 * Запрос к API сервиса от имени владельца токена. body — объект: отправляется JSON методом POST (или method).
 * Ошибки — HostError: 'auth' (401), 'forbidden' (403: токену не хватает прав), 'http' (с текстом сервиса), 'network'.
 */
export async function api(host, token, path, { fetchImpl = fetch, method = null, body = null } = {}) {
  const headers = host.kind === 'github'
    ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'acpgram' }
    : { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'acpgram' }; // так GitLab принимает и токен доступа, и токен входа по коду
  const init = { headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body) Object.assign(init, { method: method ?? 'POST', body: JSON.stringify(body), headers: { ...headers, 'content-type': 'application/json' } });
  else if (method) init.method = method;
  let res;
  try {
    res = await fetchImpl(`${host.api}${path}`, init);
  } catch (e) {
    throw new HostError('network', `${host.label}: ${e.message}`);
  }
  if (res.status === 401) throw new HostError('auth', `${host.label}: HTTP 401`, 401);
  if (!res.ok) {
    const detail = errorDetail(await res.json().catch(() => null));
    // 403 при чтении профиля — тоже «токен не подошёл»; при остальном — не хватает прав
    throw new HostError(res.status === 403 ? 'forbidden' : 'http', `${host.label}: ${detail || `HTTP ${res.status}`}`, res.status);
  }
  return { data: res.status === 204 ? null : await res.json(), headers: res.headers };
}

const isoDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

/**
 * Профиль владельца токена: {login, name, email, expiresAt, scopes}. email — адрес для коммитов (у GitHub без
 * открытого адреса — служебный noreply). scopes — права токена, если сервис их сообщил (иначе null).
 */
export async function fetchProfile(host, token, opts) {
  if (host.kind === 'github') {
    const { data, headers } = await api(host, token, '/user', opts);
    const scopes = headers?.get?.('x-oauth-scopes');
    return {
      login: data.login,
      name: data.name || data.login,
      email: data.email || `${data.id}+${data.login}@users.noreply.${new URL(host.web).host}`,
      // «2026-12-01 00:00:00 UTC» — в привычный Date формат
      expiresAt: isoDate(headers?.get?.('github-authentication-token-expiration')?.replace(' UTC', 'Z').replace(' ', 'T')),
      scopes: scopes == null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }
  const { data } = await api(host, token, '/user', opts);
  // срок и права токена — отдельным запросом; старый GitLab его не знает — тогда без них
  const self = await api(host, token, '/personal_access_tokens/self', opts).then((r) => r.data, () => null);
  return {
    login: data.username,
    name: data.name || data.username,
    email: data.commit_email || data.email || data.public_email || `${data.username}@users.noreply.${new URL(host.web).host}`,
    expiresAt: isoDate(self?.expires_at),
    scopes: Array.isArray(self?.scopes) ? self.scopes : null,
  };
}

/** Каких прав токену не хватает для работы с репозиториями (по сообщённым сервисом правам); неизвестно — пусто. */
export function missingScopes(host, scopes) {
  if (!Array.isArray(scopes)) return [];
  const has = (s) => scopes.includes(s);
  if (host.kind === 'github') return has('repo') || !scopes.length ? [] : ['repo']; // у fine-grained токенов список пуст
  // api — создание репозиториев и запросов на слияние; с ним работают и клонирование, и отправка
  return has('api') ? [] : ['api'];
}

const REPOS_PAGE = 10;

/**
 * Репозитории пользователя, недавно менявшиеся первыми: {items: [{name, url, private}], more}.
 * search — часть названия. У GitHub поиска по своим репозиториям в API нет: берутся первые 300 и отбираются здесь.
 */
export async function listRepos(host, token, { search = '', page = 0, perPage = REPOS_PAGE, ...opts } = {}) {
  const q = search.trim().toLowerCase();
  if (host.kind === 'gitlab') {
    const query = `membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=${perPage}&page=${page + 1}${q ? `&search=${encodeURIComponent(q)}` : ''}`;
    const { data, headers } = await api(host, token, `/projects?${query}`, opts);
    const items = data.map((p) => ({ name: p.path_with_namespace, url: p.http_url_to_repo, private: p.visibility !== 'public' }));
    // есть ли следующая страница, GitLab сообщает заголовком; без него — по заполненности страницы
    const next = headers?.get?.('x-next-page');
    return { items, more: next == null ? items.length === perPage : Boolean(next) };
  }
  const gh = (p) => api(host, token, `/user/repos?sort=pushed&per_page=100&page=${p}`, opts).then((r) => r.data);
  const map = (r) => ({ name: r.full_name, url: r.clone_url, private: Boolean(r.private) });
  if (!q) {
    const { data } = await api(host, token, `/user/repos?sort=pushed&per_page=${perPage}&page=${page + 1}`, opts);
    return { items: data.map(map), more: data.length === perPage };
  }
  const all = [];
  for (let p = 1; p <= 3; p++) {
    const chunk = await gh(p);
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  const found = all.filter((r) => r.full_name.toLowerCase().includes(q)).map(map);
  return { items: found.slice(page * perPage, (page + 1) * perPage), more: found.length > (page + 1) * perPage };
}

// GitHub и GitLab: создание репозитория (публикация проекта) и запрос на слияние — действия, которым нужен API
// сервиса, а не git. Запросы идут от имени владельца токена (gitHosts.api); у GitLab для них нужно право api.
import { api, showRemote } from './gitHosts.mjs';

/**
 * Где пользователь может создать репозиторий: личное пространство и группы (GitLab, вместе с подгруппами) или
 * организации (GitHub). search — часть названия группы.
 * @returns {Promise<{id: string|number|null, path: string, kind: 'user'|'group'}[]>} id — для createRepo (у личного — null)
 */
export async function listNamespaces(host, token, login, { search = '', ...opts } = {}) {
  const q = search.trim().toLowerCase();
  const own = { id: null, path: login, kind: 'user' };
  if (host.kind === 'gitlab') {
    // 30 — уровень Developer: с него группа может разрешать создание проектов
    const { data } = await api(host, token, `/groups?min_access_level=30&order_by=path&per_page=50${q ? `&search=${encodeURIComponent(q)}` : ''}`, opts);
    return [...(!q || login.toLowerCase().includes(q) ? [own] : []), ...data.map((g) => ({ id: g.id, path: g.full_path, kind: 'group' }))];
  }
  const { data } = await api(host, token, '/user/orgs?per_page=100', opts);
  const orgs = data.map((o) => ({ id: o.login, path: o.login, kind: 'group' })).filter((o) => !q || o.path.toLowerCase().includes(q));
  return [...(!q || login.toLowerCase().includes(q) ? [own] : []), ...orgs];
}

/** Видимость нового репозитория, которую умеет сервис: «внутренний» (виден всем пользователям сервера) — только GitLab. */
export const visibilities = (host) => (host.kind === 'gitlab' ? ['private', 'internal', 'public'] : ['private', 'public']);

/**
 * Имя репозитория в адресе из названия папки: латиница, цифры, «.», «-», «_»; остальное — в «-». Не получилось
 * (например, название целиком кириллицей) — null: имя нужно спросить у пользователя.
 */
export function repoSlug(name) {
  const slug = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.git$/, '').slice(0, 100);
  return slug && /[a-z0-9]/.test(slug) ? slug : null;
}

/**
 * Создаёт пустой репозиторий. namespace — запись из listNamespaces; visibility — private | internal | public.
 * @returns {Promise<{url: string, web: string, path: string}>} url — адрес для git (https), web — страница репозитория
 */
export async function createRepo(host, token, { name, slug, namespace = null, visibility = 'private' }, opts = {}) {
  if (host.kind === 'gitlab') {
    const body = { name, path: slug, visibility, initialize_with_readme: false, ...(namespace?.id ? { namespace_id: namespace.id } : {}) };
    const { data } = await api(host, token, '/projects', { ...opts, body });
    return { url: data.http_url_to_repo, web: data.web_url, path: data.path_with_namespace };
  }
  const body = { name: slug, private: visibility !== 'public', auto_init: false };
  const { data } = await api(host, token, namespace?.id ? `/orgs/${encodeURIComponent(namespace.id)}/repos` : '/user/repos', { ...opts, body });
  return { url: data.clone_url, web: data.html_url, path: data.full_name };
}

/** Путь репозитория на сервисе по адресу origin: «group/sub/app» (у GitHub — «owner/repo»). */
export const repoPath = (host, remote) => showRemote(remote).slice(showRemote(host.web).length).replace(/^\/+|\/+$/g, '');

const projectRef = (host, remote) => (host.kind === 'gitlab' ? `/projects/${encodeURIComponent(repoPath(host, remote))}` : `/repos/${repoPath(host, remote).split('/').map(encodeURIComponent).join('/')}`);

/** Основная ветка репозитория на сервере и адрес его страницы. */
export async function repoInfo(host, token, remote, opts = {}) {
  const { data } = await api(host, token, projectRef(host, remote), opts);
  return { defaultBranch: data.default_branch ?? null, web: data.web_url ?? data.html_url ?? null };
}

/**
 * Запрос на слияние ветки branch в ветку target (у GitHub — pull request). Если открытый запрос из этой ветки уже есть,
 * возвращает его, а не создаёт второй.
 * @returns {Promise<{url: string, number: number, existed: boolean}>}
 */
export async function openMergeRequest(host, token, remote, { branch, target, title }, opts = {}) {
  const ref = projectRef(host, remote);
  if (host.kind === 'gitlab') {
    const found = await api(host, token, `${ref}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}&target_branch=${encodeURIComponent(target)}`, opts);
    if (found.data[0]) return { url: found.data[0].web_url, number: found.data[0].iid, existed: true };
    const { data } = await api(host, token, `${ref}/merge_requests`, { ...opts, body: { source_branch: branch, target_branch: target, title } });
    return { url: data.web_url, number: data.iid, existed: false };
  }
  const owner = repoPath(host, remote).split('/')[0];
  const found = await api(host, token, `${ref}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(target)}`, opts);
  if (found.data[0]) return { url: found.data[0].html_url, number: found.data[0].number, existed: true };
  const { data } = await api(host, token, `${ref}/pulls`, { ...opts, body: { title, head: branch, base: target } });
  return { url: data.html_url, number: data.number, existed: false };
}

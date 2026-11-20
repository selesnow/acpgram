// Вход в сервис Git без токена доступа — «по ссылке и коду» (OAuth 2.0 Device Authorization Grant).
// Пользователь открывает страницу сервиса, вводит короткий код и подтверждает доступ; бот в это время опрашивает
// сервис и получает токен сам. Ничего секретного в чат не попадает вовсе.
//
// Для этого у сервиса должно быть зарегистрировано приложение. Его идентификатор (client_id) — открытый, секрета
// приложения для такого входа не нужно. Идентификаторы приложений AcpGram на GitHub.com и GitLab.com встроены: вход
// работает в любой установке без настройки. GITHUB_CLIENT_ID и GITLAB_CLIENT_ID задают свои приложения, значение
// «0» выключает вход по коду для сервиса. У своих серверов такого входа нет — только токен доступа.
//
// У GitLab токен, полученный так, живёт 2 часа и обновляется токеном обновления (refreshLogin); у GitHub — бессрочный.

const TIMEOUT_MS = 15_000;
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Приложения AcpGram в общих сервисах. Идентификаторы открытые, не секреты. */
const APPS = {
  // github.com: OAuth App с включённым Device Flow
  github: { clientId: 'Ov23linzwgdPFp8u76Qq', env: 'GITHUB_CLIENT_ID', code: '/login/device/code', token: '/login/oauth/access_token', scope: 'repo read:org' },
  // gitlab.com: приложение с включённым Device authorization grant, не конфиденциальное
  gitlab: { clientId: 'da562dbf4a08da1dc4f0b1fcc52259edb60ebb7aaa0a158e36c76dbe3b07f41d', env: 'GITLAB_CLIENT_ID', code: '/oauth/authorize_device', token: '/oauth/token', scope: 'api read_repository write_repository' },
};

/**
 * Настройки входа по коду для сервиса или null, если такого входа у него нет (тогда — только токен доступа).
 * @returns {{clientId: string, codeUrl: string, tokenUrl: string, scope: string} | null}
 */
export function deviceLogin(host, env = process.env) {
  const app = host && Object.hasOwn(APPS, host.id) ? APPS[host.id] : null; // свои серверы — только по токену
  if (!app) return null;
  const id = (env[app.env] ?? '').trim() || app.clientId;
  if (id === '0' || id.toLowerCase() === 'off') return null;
  return { clientId: id, codeUrl: `${host.web}${app.code}`, tokenUrl: `${host.web}${app.token}`, scope: app.scope };
}

/** Вход не состоялся: code — 'expired' (код или вход устарел), 'denied' (пользователь отказал), 'cancelled', 'failed'. */
export class DeviceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

async function post(url, body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'acpgram' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new DeviceError('failed', e.message);
  }
  // сервисы отвечают JSON и при отказе (GitLab — с кодом 400): разбираем тело при любом коде ответа
  const data = await res.json().catch(() => null);
  if (!data) throw new DeviceError('failed', `HTTP ${res.status}`);
  return data;
}

/** Вход из ответа сервиса: {token, refreshToken, expiresIn} (refreshToken и expiresIn — null у бессрочного токена). */
const grantOf = (d) => ({ token: d.access_token, refreshToken: d.refresh_token || null, expiresIn: Number(d.expires_in) > 0 ? Number(d.expires_in) : null });

/**
 * Начинает вход: сервис выдаёт код для пользователя и код для опроса.
 * @returns {Promise<{deviceCode: string, userCode: string, url: string, interval: number, expiresIn: number}>}
 *   url — страница, где вводится код (у GitLab — уже с кодом); interval — как часто можно опрашивать (с); expiresIn — срок кода (с)
 */
export async function startDeviceLogin(cfg, { fetchImpl = fetch } = {}) {
  const d = await post(cfg.codeUrl, { client_id: cfg.clientId, scope: cfg.scope }, fetchImpl);
  if (!d.device_code || !d.user_code) throw new DeviceError('failed', d.error_description || d.error || 'сервис не выдал код');
  return { deviceCode: d.device_code, userCode: d.user_code, url: d.verification_uri_complete || d.verification_uri, interval: Number(d.interval) || 5, expiresIn: Number(d.expires_in) || 900 };
}

/**
 * Один опрос: подтвердил ли пользователь вход.
 * @returns {Promise<{token: string, refreshToken: string|null, expiresIn: number|null} | {pending: true, slowDown: boolean}>}
 *   бросает DeviceError, если вход не состоится
 */
export async function pollDeviceLogin(cfg, deviceCode, { fetchImpl = fetch } = {}) {
  const d = await post(cfg.tokenUrl, { client_id: cfg.clientId, device_code: deviceCode, grant_type: GRANT }, fetchImpl);
  if (d.access_token) return grantOf(d);
  if (d.error === 'authorization_pending') return { pending: true, slowDown: false };
  if (d.error === 'slow_down') return { pending: true, slowDown: true };
  if (d.error === 'expired_token') throw new DeviceError('expired');
  if (d.error === 'access_denied') throw new DeviceError('denied');
  throw new DeviceError('failed', d.error_description || d.error || 'неизвестный ответ сервиса');
}

/** Пауза между опросами; в тестах подменяется, чтобы не ждать. */
export const deviceTiming = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Ждёт подтверждения входа: опрашивает сервис с его интервалом, пока код действует.
 * @param {() => boolean} cancelled вход отменён пользователем — опрос прекращается (DeviceError 'cancelled')
 * @returns {Promise<{token: string, refreshToken: string|null, expiresIn: number|null}>}
 */
export async function waitDeviceLogin(cfg, login, { cancelled = () => false, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const deadline = now() + login.expiresIn * 1000;
  let interval = login.interval;
  while (now() < deadline) {
    await deviceTiming.sleep(interval * 1000);
    if (cancelled()) throw new DeviceError('cancelled');
    const r = await pollDeviceLogin(cfg, login.deviceCode, { fetchImpl });
    if (r.token) return r;
    if (r.slowDown) interval += 5; // сервис просит опрашивать реже
  }
  throw new DeviceError('expired');
}

/**
 * Обновляет вход токеном обновления: сервис выдаёт новую пару (прежние токены после этого недействительны).
 * @returns {Promise<{token: string, refreshToken: string|null, expiresIn: number|null}>}
 *   DeviceError 'expired' — токен обновления больше не принимается: аккаунт нужно подключить заново
 */
export async function refreshLogin(cfg, refreshToken, { fetchImpl = fetch } = {}) {
  const d = await post(cfg.tokenUrl, { client_id: cfg.clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl);
  if (d.access_token) return grantOf(d);
  if (d.error === 'invalid_grant' || d.error === 'invalid_token') throw new DeviceError('expired', d.error_description || d.error);
  throw new DeviceError('failed', d.error_description || d.error || 'неизвестный ответ сервиса');
}

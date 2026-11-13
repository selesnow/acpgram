// Права сотрудников на движки и модели, каталоги моделей движков и выбор модели / уровня рассуждений пользователя.
//
// - Движки: сотруднику по умолчанию доступен только движок по умолчанию (DEFAULT_ENGINE), остальные выдаёт администратор.
// - Модели: по умолчанию все модели движка; администратор может оставить сотруднику только часть (отдельно по движкам).
// - Администратору доступно всё.
// - Каталог (список моделей и уровней рассуждений) присылает сам агент в ответе session/new; бот хранит его в settings.
import { tmpdir } from 'node:os';
import { ADMIN_ID, db, langOf, log } from './ctx.mjs';
import { DEFAULT_ENGINE, ENGINES, autoValue, createAgent, engineVersion, isAuthError, isAvailable, parseCatalog, selectionRequest, setNeedsLogin } from './engines.mjs';
import { t } from './i18n.mjs';

const parseJson = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const isEngineId = (id) => typeof id === 'string' && Object.hasOwn(ENGINES, id);

// ---------- каталоги ----------

// Каталог читается часто (экран /start, подвал ответа, /model) — держим разобранным в памяти; меняет его только saveCatalog.
const catalogCache = new Map();

/** @returns {{models: {id,name}[], efforts: {id,name}[], defaultModel: string|null, defaultEffort: string|null, at: string, version?: string|null}|null} */
export function getCatalog(engineId) {
  if (!isEngineId(engineId)) return null;
  if (!catalogCache.has(engineId)) catalogCache.set(engineId, parseJson(db.getSetting(`catalog:${engineId}`), null));
  return catalogCache.get(engineId);
}

/** Каталог считается свежим сутки, если движок с тех пор не обновлялся. */
export const CATALOG_TTL_MS = 24 * 3600_000;

/** Можно ли не запускать агента за списком моделей: каталог есть, моложе CATALOG_TTL_MS и версия движка та же. */
export function catalogFresh(catalog, version, now = Date.now()) {
  if (!catalog || !(catalog.models?.length || catalog.efforts?.length)) return false;
  const age = now - Date.parse(catalog.at);
  return age >= 0 && age < CATALOG_TTL_MS && (catalog.version ?? null) === (version ?? null);
}

/**
 * Сохраняет каталог из ответа session/new чистой сессии (probeCatalog). Пустой список не затирает ранее полученный:
 * агент мог ответить урезанно (сбой, другая модель с другим набором уровней рассуждений).
 */
export function saveCatalog(engine, res) {
  const c = parseCatalog(engine, res);
  const old = getCatalog(engine.id);
  if (!c.models.length && !c.efforts.length) return old;
  const catalog = {
    models: c.models.length ? c.models : old?.models ?? [],
    efforts: c.efforts.length ? c.efforts : old?.efforts ?? [],
    defaultModel: c.defaultModel ?? old?.defaultModel ?? null,
    defaultEffort: c.defaultEffort ?? old?.defaultEffort ?? null,
    at: new Date().toISOString(),
    version: engineVersion(engine.id), // обновился движок — каталог запрашивается заново (catalogFresh)
  };
  db.setSetting(`catalog:${engine.id}`, JSON.stringify(catalog));
  catalogCache.set(engine.id, catalog);
  return catalog;
}

const probes = new Map(); // движок → идущий запрос каталога (не запускаем агента повторно)
const probeAgents = new Set(); // запущенные для этого агенты — при остановке бота завершаются вместе с ним

/** Завершает агентов, запущенных за списком моделей (при остановке бота: зависший движок не должен держать службу). */
export function killProbes() {
  for (const a of probeAgents) a.close();
  probeAgents.clear();
}
const probeFailedAt = new Map(); // движок → время неудачи (пауза перед повтором)
const PROBE_RETRY_MS = 5 * 60_000;

/**
 * Короткий запуск агента без запроса (в tmpdir, с настройками по умолчанию) — только чтобы узнать его модели и уровни
 * рассуждений. Одновременно не больше одного запуска на движок; после неудачи — пауза PROBE_RETRY_MS.
 */
export function probeCatalog(engine, timeoutMs = 120_000) {
  if (probes.has(engine.id)) return probes.get(engine.id);
  if (Date.now() - (probeFailedAt.get(engine.id) ?? 0) < PROBE_RETRY_MS) return Promise.reject(new Error('недавняя попытка не удалась, повтор позже'));
  const run = (async () => {
    const a = createAgent(engine, { cwd: tmpdir(), onPermission: async () => ({ outcome: 'cancelled' }) });
    probeAgents.add(a);
    try {
      const res = await a.init(null, { timeoutMs });
      probeFailedAt.delete(engine.id);
      setNeedsLogin(engine.id, false);
      return saveCatalog(engine, res);
    } catch (e) {
      probeFailedAt.set(engine.id, Date.now());
      setNeedsLogin(engine.id, isAuthError(e)); // нужен вход или ключ API — движок виден, но с предупреждением в /engine
      throw e;
    } finally {
      a.close(); // завершает агента вместе с дочерними процессами — и при ответе, и при тайм-ауте
      probeAgents.delete(a);
      probes.delete(engine.id);
    }
  })();
  probes.set(engine.id, run);
  return run;
}

/**
 * Обновляет каталоги доступных движков по очереди (в фоне: при старте бота и раз в сутки). Свежий каталог
 * (catalogFresh) не запрашивается: раньше каждый перезапуск поднимал по процессу на каждый движок (~25 с).
 */
export async function refreshCatalogs({ force = false } = {}) {
  for (const e of Object.values(ENGINES).filter((x) => isAvailable(x.id))) {
    if (!force && catalogFresh(getCatalog(e.id), engineVersion(e.id))) {
      log(`${e.label}: список моделей свежий (${getCatalog(e.id).at}), агент не запускается`);
      continue;
    }
    try {
      const c = await probeCatalog(e);
      log(`${e.label}: моделей ${c?.models.length ?? 0}, уровней рассуждений ${c?.efforts.length ?? 0}`);
    } catch (err) {
      log(`⚠️ ${e.label}: не удалось получить список моделей — ${err.message}`);
    }
  }
}

// ---------- права ----------

/** Движки, выданные сотруднику (всегда с движком по умолчанию); администратору — все. Без учёта доступности на сервере. */
export function grantedEngines(userId) {
  if (userId === ADMIN_ID) return Object.keys(ENGINES);
  const extra = parseJson(db.getUser(userId)?.engines, []);
  return [DEFAULT_ENGINE, ...Object.keys(ENGINES).filter((id) => id !== DEFAULT_ENGINE && Array.isArray(extra) && extra.includes(id))];
}

/** Можно ли пользователю работать в движке сейчас: выдан и запускается на сервере. */
export const canUseEngine = (userId, id) => isEngineId(id) && isAvailable(id) && grantedEngines(userId).includes(id);

/** Движки, которые пользователь может выбрать в /engine. */
export const userEngines = (userId) => grantedEngines(userId).filter((id) => isAvailable(id)).map((id) => ENGINES[id]);

/** Выдаёт или забирает у сотрудника движок (кроме движка по умолчанию). Возвращает новый список выданных. */
export function setEngineGrant(userId, engineId, on) {
  if (!isEngineId(engineId) || engineId === DEFAULT_ENGINE) return grantedEngines(userId);
  const extra = new Set(grantedEngines(userId).filter((id) => id !== DEFAULT_ENGINE));
  if (on) extra.add(engineId);
  else extra.delete(engineId);
  db.setUserEngines(userId, [...extra]);
  return grantedEngines(userId);
}

/** Ограничение моделей сотрудника в движке: список разрешённых id или null (разрешены все). */
export function modelRestriction(userId, engineId) {
  if (userId === ADMIN_ID) return null;
  const list = parseJson(db.getUser(userId)?.models, {})?.[engineId];
  return Array.isArray(list) ? list : null;
}

/** Сколько моделей каталога разрешено сотруднику (модели, исчезнувшие из каталога, не считаются); null — все. */
export const allowedCount = (userId, engineId) => (modelRestriction(userId, engineId) ? allowedModels(userId, engineId).length : null);

/** Модели движка, доступные пользователю (из каталога). */
export function allowedModels(userId, engineId) {
  const models = getCatalog(engineId)?.models ?? [];
  const r = modelRestriction(userId, engineId);
  return r ? models.filter((m) => r.includes(m.id)) : models;
}

/**
 * Включает или выключает модель в ограничении сотрудника. Если включены все — ограничение снимается.
 * Последнюю разрешённую модель выключить нельзя. Возвращает {ok, restriction}.
 */
export function toggleModel(userId, engineId, modelId) {
  const all = (getCatalog(engineId)?.models ?? []).map((m) => m.id);
  if (!all.includes(modelId)) return { ok: false, restriction: modelRestriction(userId, engineId) };
  // считаем только модели из каталога: исчезнувшие id не должны мешать проверке «последней модели»
  const set = new Set((modelRestriction(userId, engineId) ?? all).filter((id) => all.includes(id)));
  if (set.has(modelId)) {
    if (set.size === 1) return { ok: false, restriction: [...set] };
    set.delete(modelId);
  } else set.add(modelId);
  const map = parseJson(db.getUser(userId)?.models, {}) || {};
  const list = all.filter((id) => set.has(id));
  if (list.length === all.length) delete map[engineId];
  else map[engineId] = list;
  db.setUserModels(userId, map);
  return { ok: true, restriction: modelRestriction(userId, engineId) };
}

/** Снимает ограничение моделей сотрудника в движке. */
export function allowAllModels(userId, engineId) {
  const map = parseJson(db.getUser(userId)?.models, {}) || {};
  delete map[engineId];
  db.setUserModels(userId, map);
}

// ---------- выбор пользователя ----------

const choiceKey = (userId, engineId, kind) => `${kind}:${userId}:${engineId}`;

/** Запоминает выбор модели или уровня рассуждений; null — «Авто» (как у агента по умолчанию). */
export const saveChoice = (userId, engineId, kind, value) => db.setSetting(choiceKey(userId, engineId, kind), value ?? null);

/**
 * Модель и уровень рассуждений, с которыми пользователь должен работать в движке.
 * null — настройка агента по умолчанию. Недоступный (запрещённый, исчезнувший из каталога) выбор не применяется;
 * при ограничении моделей «Авто» недоступно — берётся первая разрешённая модель.
 */
export function effectiveSelection(userId, engine) {
  const catalog = getCatalog(engine.id);
  const models = allowedModels(userId, engine.id);
  let model = db.getSetting(choiceKey(userId, engine.id, 'model'));
  if (model && !models.some((m) => m.id === model)) model = null;
  if (!model && modelRestriction(userId, engine.id)) model = models[0]?.id ?? null;
  let effort = db.getSetting(choiceKey(userId, engine.id, 'effort'));
  if (effort && !(catalog?.efforts ?? []).some((e) => e.id === effort)) effort = null;
  return { model, effort };
}

/** Название модели / уровня по каталогу. */
export function choiceName(engine, kind, value) {
  const catalog = getCatalog(engine.id);
  const list = kind === 'model' ? catalog?.models : catalog?.efforts;
  return list?.find((x) => x.id === value)?.name ?? value;
}

/** Запрос нельзя выполнить в разрешённой модели — его не отправляем (ограничение моделей не должно «протекать»). */
export class ModelAccessError extends Error {
  code = 'MODEL_ACCESS';
}

/**
 * Приводит модель и уровень рассуждений живой сессии к выбору пользователя (перед каждым запросом).
 * a.applied — что бот уже выставил в этой сессии (undefined — ничего, у агента его значение по умолчанию; '?' — неизвестно).
 * При ограничении моделей сбой не прощается: бросает ModelAccessError, и запрос не отправляется.
 */
export async function syncSelection(userId, a) {
  const engine = a.engine;
  const restricted = Boolean(modelRestriction(userId, engine.id));
  const want = effectiveSelection(userId, engine);
  if (restricted && !want.model) {
    throw new ModelAccessError(t('access.noModels', langOf(userId), { engine: engine.label }));
  }
  a.applied ??= {};
  for (const kind of ['model', 'effort']) {
    if (kind === 'effort' && !engine.effortConfig) continue;
    const target = want[kind];
    const current = a.applied[kind];
    if (target === (current ?? null)) continue;
    // вернуться к «Авто» нужно, только если бот раньше выставлял своё значение
    const value = target ?? (current != null ? autoValue(engine, getCatalog(engine.id), kind) : null);
    if (value == null) continue;
    try {
      await a.request(...selectionRequest(engine, a.sessionId, kind, value));
      a.applied[kind] = target;
      // у новой модели может быть свой уровень рассуждений по умолчанию — выставляем его заново в этом же проходе
      if (kind === 'model' && engine.effortConfig) a.applied.effort = '?';
    } catch (e) {
      log(`⚠️ ${engine.label}: не удалось выставить ${kind} = ${value}: ${e.message}`);
      a.applied[kind] = '?'; // что сейчас в сессии — неизвестно, в следующий раз выставим снова
      if (kind === 'model' && restricted) {
        throw new ModelAccessError(t('access.switchFail', langOf(userId), { engine: engine.label, model: choiceName(engine, 'model', value) }));
      }
    }
  }
}

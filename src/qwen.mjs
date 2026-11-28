// Qwen Code в режиме ACP работает через OpenAI-совместимый API. Модели и адрес API задаются файлом настроек в каталоге
// QWEN_HOME: один каталог на сотрудника (внутри песочницы data/homes/<id>/.qwen), чтобы агент мог писать туда сессии.
//
// Ключ API в файл не пишется: Qwen берёт его из переменной, имя которой указано в настройках (envKey). Бот передаёт
// ключ процессу агента в OPENAI_API_KEY, а адрес API — в OPENAI_BASE_URL.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './app.mjs';

/** Адрес OpenAI-совместимого API OpenRouter: бесплатные модели с поддержкой инструментов. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Модели Qwen Code по умолчанию — бесплатные модели OpenRouter, которые умеют вызывать инструменты.
 * Список меняется: свой задаётся переменной QWEN_MODELS (id|Название;id|Название).
 */
export const DEFAULT_QWEN_MODELS = Object.freeze([
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning (free)' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B (free)' },
  { id: 'baidu/ernie-5.5-flash-preview:free', name: 'ERNIE 5.5 Flash Preview (free)' },
]);

/**
 * Список моделей из QWEN_MODELS: «id|Название» через точку с запятой или перевод строки. Без названия — id.
 * Пустое или некорректное значение — модели по умолчанию.
 * @returns {{id: string, name: string}[]}
 */
export function parseQwenModels(value) {
  const models = [];
  for (const part of String(value ?? '').split(/[;\n]+/)) {
    const item = part.trim();
    if (!item) continue;
    const bar = item.indexOf('|');
    const id = (bar < 0 ? item : item.slice(0, bar)).trim();
    const name = (bar < 0 ? id : item.slice(bar + 1).trim()) || id;
    if (id && !models.some((m) => m.id === id)) models.push({ id, name });
  }
  return models.length ? models : DEFAULT_QWEN_MODELS.map((m) => ({ ...m }));
}

/**
 * Адрес API для моделей: QWEN_BASE_URL, иначе OpenRouter, если есть OPENROUTER_API_KEY. Если есть только OPENAI_API_KEY,
 * адрес не задаётся: Qwen использует API OpenAI по умолчанию (нужны модели OpenAI в QWEN_MODELS).
 */
export function qwenBaseUrl(env = process.env) {
  const own = env.QWEN_BASE_URL?.trim();
  if (own) return own;
  if (env.OPENROUTER_API_KEY) return OPENROUTER_BASE_URL;
  return '';
}

/** Каталог Qwen для сотрудника: внутри его домашней папки в песочнице (она доступна агенту на запись). */
export const qwenHome = (userId, base = DATA_DIR) => join(base, 'homes', String(userId ?? 0), '.qwen');

/** Путь к глобальному settings.json Qwen Code: явный QWEN_SETTINGS_FILE, иначе ~/.qwen/settings.json. */
export function globalQwenSettingsPath(env = process.env) {
  const explicit = env.QWEN_SETTINGS_FILE?.trim();
  if (explicit) return explicit;
  return join(homedir(), '.qwen', 'settings.json');
}

/** Безопасно читает JSON-объект из файла; при ошибке — null. */
export function readQwenSettingsFile(file) {
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Извлекает модели из modelProviders.openai настроек Qwen Code. Секреты не возвращаются.
 * @returns {{id: string, name: string}[]}
 */
export function extractQwenModels(settings) {
  const openai = settings?.modelProviders?.openai;
  if (!Array.isArray(openai)) return [];
  const models = [];
  for (const item of openai) {
    const id = String(item?.id ?? '').trim();
    if (!id) continue;
    const name = String(item?.name ?? id).trim() || id;
    if (!models.some((m) => m.id === id)) models.push({ id, name });
  }
  return models;
}

/**
 * Настройки Qwen Code: модели одного провайдера openai, вход по ключу API (без интерактивного входа).
 * Ключа в файле нет — только имя переменной окружения (OPENAI_API_KEY).
 * @param {{models?: {id:string,name:string}[], baseUrl?: string, selectedModel?: string|null}} opts
 */
export function qwenSettings({ models = DEFAULT_QWEN_MODELS, baseUrl = '', selectedModel = null } = {}) {
  const list = (models?.length ? models : DEFAULT_QWEN_MODELS).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    envKey: 'OPENAI_API_KEY',
    ...(baseUrl ? { baseUrl } : {}),
  }));
  const selected = selectedModel && list.some((m) => m.id === selectedModel) ? selectedModel : list[0]?.id;
  const settings = {
    modelProviders: { openai: list },
    security: { auth: { selectedType: 'openai' } },
  };
  if (selected) settings.model = { name: selected };
  return settings;
}

/**
 * Записывает settings.json в каталог Qwen (атомарно, права 0600). Возвращает путь к файлу.
 * Каталог создаётся, если его нет; существующие сессии Qwen в нём сохраняются.
 */
export function ensureQwenSettings(dir, settings) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

function settingsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Окружение процесса Qwen Code: каталог настроек сотрудника (с готовым settings.json), ключ API в OPENAI_API_KEY
 * и адрес API в OPENAI_BASE_URL.
 *
 * Приоритет моделей: QWEN_MODELS > существующий per-user settings.json > глобальный ~/.qwen/settings.json > дефолт.
 * Это позволяет использовать уже настроенный на машине Qwen Code без ручной копии моделей.
 * @param {{userId?: number|string}} who
 */
export function qwenProcessEnv(who = {}, env = process.env, base = DATA_DIR) {
  const home = qwenHome(who.userId, base);
  const file = join(home, 'settings.json');
  const baseUrl = qwenBaseUrl(env);
  const key = baseUrl === OPENROUTER_BASE_URL && env.OPENROUTER_API_KEY ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY || env.OPENROUTER_API_KEY;

  const explicitModels = env.QWEN_MODELS?.trim() ? parseQwenModels(env.QWEN_MODELS) : null;
  const existing = readQwenSettingsFile(file);
  const global = explicitModels || existing ? null : readQwenSettingsFile(globalQwenSettingsPath(env));

  const models = explicitModels
    || (existing ? extractQwenModels(existing) : [])
    || [];
  const seeded = models.length ? models : extractQwenModels(global);
  // Дефолтные бесплатные OpenRouter-модели подставляем только для OpenRouter. Для OpenAI/другого
  // OpenAI-compatible API без явных моделей оставляем импортированные/существующие, иначе список не угадываем.
  const finalModels = seeded.length
    ? seeded
    : (baseUrl === OPENROUTER_BASE_URL ? DEFAULT_QWEN_MODELS.map((m) => ({ ...m })) : []);
  const selectedModel = String(existing?.model?.name ?? '').trim() || null;

  const settings = qwenSettings({ models: finalModels, baseUrl, selectedModel });
  if (!existing || !settingsEqual(existing, settings)) ensureQwenSettings(home, settings);

  return {
    QWEN_HOME: home,
    ...(key ? { OPENAI_API_KEY: key } : {}),
    ...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
  };
}

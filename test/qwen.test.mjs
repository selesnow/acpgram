import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENGINES, parseCatalog } from '../src/engines.mjs';
import {
  DEFAULT_QWEN_MODELS,
  OPENROUTER_BASE_URL,
  ensureQwenSettings,
  extractQwenModels,
  globalQwenSettingsPath,
  parseQwenModels,
  qwenBaseUrl,
  qwenHome,
  qwenProcessEnv,
  qwenSettings,
  readQwenSettingsFile,
} from '../src/qwen.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'acpgram-qwen-'));

test('parseQwenModels: список по умолчанию, свой список, дубликаты и пустое значение', () => {
  assert.deepEqual(parseQwenModels(''), DEFAULT_QWEN_MODELS.map((m) => ({ ...m })));
  assert.deepEqual(parseQwenModels(undefined), DEFAULT_QWEN_MODELS.map((m) => ({ ...m })));
  assert.deepEqual(parseQwenModels('a/model|Модель A; b/model'), [
    { id: 'a/model', name: 'Модель A' },
    { id: 'b/model', name: 'b/model' },
  ]);
  assert.deepEqual(parseQwenModels('a/model|A\na/model|Дубль;'), [{ id: 'a/model', name: 'A' }]);
  assert.deepEqual(parseQwenModels('  ;  '), DEFAULT_QWEN_MODELS.map((m) => ({ ...m })), 'пустые пункты не считаются моделью');
});

test('qwenBaseUrl: QWEN_BASE_URL важнее; OpenRouter при наличии OPENROUTER_API_KEY; OpenAI — только если ключ OpenAI один', () => {
  assert.equal(qwenBaseUrl({}), '');
  assert.equal(qwenBaseUrl({ OPENAI_API_KEY: 'k' }), '');
  assert.equal(qwenBaseUrl({ OPENROUTER_API_KEY: 'k' }), OPENROUTER_BASE_URL);
  assert.equal(qwenBaseUrl({ OPENAI_API_KEY: 'k', OPENROUTER_API_KEY: 'o' }), OPENROUTER_BASE_URL);
  assert.equal(qwenBaseUrl({ OPENROUTER_API_KEY: 'o', QWEN_BASE_URL: 'https://api.example/v1' }), 'https://api.example/v1');
});

test('qwenSettings: модели одного провайдера openai, ключа в настройках нет', () => {
  const s = qwenSettings({ baseUrl: OPENROUTER_BASE_URL });
  assert.deepEqual(s.security, { auth: { selectedType: 'openai' } });
  assert.equal(s.modelProviders.openai.length, DEFAULT_QWEN_MODELS.length);
  for (const m of s.modelProviders.openai) {
    assert.equal(m.envKey, 'OPENAI_API_KEY');
    assert.equal(m.baseUrl, OPENROUTER_BASE_URL);
  }
  assert.equal(s.model.name, DEFAULT_QWEN_MODELS[0].id);
  assert.ok(!JSON.stringify(s).includes('sk-'), 'в настройках нет значения ключа');
  const own = qwenSettings({ models: [{ id: 'x/y', name: 'Y' }] });
  assert.deepEqual(own.modelProviders.openai, [{ id: 'x/y', name: 'Y', envKey: 'OPENAI_API_KEY', baseUrl: undefined }].map((m) => { const o = { id: m.id, name: m.name, envKey: m.envKey }; return o; }));
  assert.deepEqual(own.model, { name: 'x/y' });
});

test('qwenSettings: сохраняет выбранную модель, если она есть в списке', () => {
  const s = qwenSettings({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], selectedModel: 'b' });
  assert.equal(s.model.name, 'b');
  const fallback = qwenSettings({ models: [{ id: 'a', name: 'A' }], selectedModel: 'missing' });
  assert.equal(fallback.model.name, 'a');
});

test('ensureQwenSettings: атомарная запись settings.json с правами только владельца', () => {
  const dir = temp();
  try {
    const file = ensureQwenSettings(dir, qwenSettings({ baseUrl: OPENROUTER_BASE_URL }));
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).security.auth.selectedType, 'openai');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extractQwenModels/readQwenSettingsFile/globalQwenSettingsPath: импорт только openai-моделей, без секретов', () => {
  const dir = temp();
  try {
    const file = join(dir, 'settings.json');
    ensureQwenSettings(dir, {
      modelProviders: {
        openai: [{ id: 'openai/gpt-4o', name: 'GPT-4o', envKey: 'OPENAI_API_KEY' }, { id: 'openai/gpt-4o', name: 'dup' }],
        anthropic: [{ id: 'claude', name: 'Claude' }],
      },
      env: { OPENAI_API_KEY: 'secret' },
    });
    assert.deepEqual(extractQwenModels(readQwenSettingsFile(file)), [{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    assert.equal(readQwenSettingsFile(join(dir, 'missing.json')), null);
    assert.equal(globalQwenSettingsPath({ QWEN_SETTINGS_FILE: file }), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('qwenProcessEnv: QWEN_HOME сотрудника, ключ OpenRouter в OPENAI_API_KEY, адрес в OPENAI_BASE_URL', () => {
  const base = temp();
  try {
    const env = qwenProcessEnv({ userId: 42 }, { OPENROUTER_API_KEY: 'or-key' }, base);
    const home = qwenHome(42, base);
    assert.equal(env.QWEN_HOME, home);
    assert.equal(env.OPENAI_API_KEY, 'or-key');
    assert.equal(env.OPENAI_BASE_URL, OPENROUTER_BASE_URL);
    const file = join(home, 'settings.json');
    assert.ok(existsSync(file));
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('or-key'), 'ключ API не попадает в файл настроек');
    assert.equal(JSON.parse(text).modelProviders.openai[0].baseUrl, OPENROUTER_BASE_URL);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('qwenProcessEnv: с ключом OpenAI без QWEN_BASE_URL адрес API не задаётся', () => {
  const base = temp();
  try {
    const env = qwenProcessEnv({ userId: 7 }, { OPENAI_API_KEY: 'oa-key' }, base);
    assert.equal(env.OPENAI_API_KEY, 'oa-key');
    assert.equal(env.OPENAI_BASE_URL, undefined);
    const settings = JSON.parse(readFileSync(join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    assert.equal(settings.modelProviders.openai[0].baseUrl, undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('qwenProcessEnv: импортирует модели из глобального settings.json, если per-user файла нет', () => {
  const base = temp();
  try {
    const globalFile = join(base, 'global-qwen-settings.json');
    ensureQwenSettings(base, { modelProviders: { openai: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }] } });
    // ensureQwenSettings wrote to base/settings.json
    rmSync(globalFile, { force: true });
    const env = qwenProcessEnv({ userId: 5 }, { QWEN_SETTINGS_FILE: join(base, 'settings.json'), OPENAI_API_KEY: 'k' }, base);
    const settings = JSON.parse(readFileSync(join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.modelProviders.openai.map((m) => m.id), ['openai/gpt-4o-mini']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('qwenProcessEnv: не перезаписывает per-user settings и сохраняет выбранную модель', () => {
  const base = temp();
  try {
    const home = qwenHome(9, base);
    ensureQwenSettings(home, qwenSettings({ models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], selectedModel: 'b' }));
    const env = qwenProcessEnv({ userId: 9 }, { OPENAI_API_KEY: 'k' }, base);
    const settings = JSON.parse(readFileSync(join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    assert.equal(settings.model.name, 'b');
    assert.deepEqual(settings.modelProviders.openai.map((m) => m.id), ['a', 'b']);
    assert.equal(env.OPENAI_API_KEY, 'k');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('qwenProcessEnv: QWEN_MODELS имеет приоритет и обновляет per-user settings', () => {
  const base = temp();
  try {
    const home = qwenHome(11, base);
    ensureQwenSettings(home, qwenSettings({ models: [{ id: 'old', name: 'Old' }], selectedModel: 'old' }));
    const env = qwenProcessEnv({ userId: 11 }, { QWEN_MODELS: 'new/model|New', OPENAI_API_KEY: 'k' }, base);
    const settings = JSON.parse(readFileSync(join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.modelProviders.openai.map((m) => m.id), ['new/model']);
    assert.equal(settings.model.name, 'new/model');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('parseCatalog Qwen: модели и режим из configOptions, «Авто» вне списка, уровня рассуждений нет', () => {
  const res = {
    configOptions: [
      {
        id: 'model',
        currentValue: 'nvidia/nemotron-3.5-lightning:free',
        options: [
          { value: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning' },
          { value: 'baidu/ernie-5.5-flash-preview:free', name: 'ERNIE 5.5 Flash' },
        ],
      },
      { id: 'mode', currentValue: 'default', options: [{ value: 'plan', name: 'Plan' }, { value: 'default', name: 'Default' }] },
    ],
  };
  const catalog = parseCatalog(ENGINES.qwen, res);
  assert.deepEqual(catalog.models.map((m) => m.id), ['nvidia/nemotron-3.5-lightning:free', 'baidu/ernie-5.5-flash-preview:free']);
  assert.deepEqual(catalog.efforts, []);
  assert.equal(catalog.defaultModel, 'nvidia/nemotron-3.5-lightning:free');
  assert.equal(catalog.defaultEffort, null);
});

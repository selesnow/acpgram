// Реестр движков (AI-агентов разработки). Все движки говорят по Agent Client Protocol (ACP),
// поэтому клиент один — AcpAgent; движок задаёт команду запуска, режимы по уровням доступа и особенности вывода.
//
// Контракт клиента агента (AgentClient), которым пользуется остальной бот:
//   init(mode, {resume?}) → Promise   запуск процесса и сессии (новой или возобновлённой)
//   prompt(text)          → Promise<{stopReason}>
//   cancel()                          прервать текущий запрос
//   close()                           завершить процесс вместе с потомками
//   sessionId, cwd, mode, closed, engine
//   события: onUpdate(update ACP session/update), onPermission(params) → outcome, onExit(code)
// Если появится движок без ACP, ему достаточно реализовать этот же контракт отдельным классом.
//
// Ключи API (GEMINI_API_KEY, ANTHROPIC_API_KEY) процессы агентов получают из окружения бота.
import { AcpAgent, checkCommand } from './acp.mjs';

/** Служебная строка Gemini «[MODE_UPDATE] <режим>» приходит как текст ответа — убираем её из начала. */
const stripGeminiModeUpdate = (s) => s.replace(/^\s*\[MODE_UPDATE\]\s*(?:default|autoEdit|auto_edit|yolo|plan)/, '');

/**
 * @typedef {object} Engine
 * @property {string} id
 * @property {string} label            название для пользователя
 * @property {string} short            короткая метка для кнопок и списков
 * @property {string} envVar           переменная окружения с путём к команде
 * @property {string} defaultCommand   команда по умолчанию (если envVar не задана)
 * @property {string[]} args           аргументы запуска в режиме ACP
 * @property {string[]} versionArgs    аргументы проверки при старте
 * @property {string} install          подсказка по установке
 * @property {Record<string,string>} modes  уровень доступа сотрудника → режим сессии ACP
 * @property {string} adminMode        режим для главного администратора
 * @property {(s:string)=>string} cleanText            очистка текста ответа от служебных вставок
 * @property {(u:object)=>string} toolName             имя инструмента из события tool_call / tool_call_update
 * @property {(u:object)=>string} [toolDescription]    описание действия от агента (если движок присылает его отдельно)
 * @property {RegExp} [quietStderr]    служебные строки stderr агента, которые не пишутся в лог бота
 */

/** Имя инструмента по умолчанию: метаданные Claude Code, имя или вид действия. */
const genericToolName = (u) => u._meta?.claudeCode?.toolName || u.name || u.kind || u.toolCallId || 'tool';

// Варианты разрешений Claude Code (мост claude-agent-acp, permissions/options/shared.js)
/** Постоянные правила: мост записывает их в .claude/settings.local.json проекта — для всех будущих сессий и всех сотрудников. */
const CLAUDE_PERSISTENT = new Set(['allow-with-updates', 'allow-skill-exact', 'allow-skill-prefix']);
/** Выход из режима плана переключает сессию в другой режим. */
const CLAUDE_EXIT_PLAN = {
  'exit-plan-default': 'default',
  'exit-plan-accept-edits': 'acceptEdits',
  'exit-plan-clear-accept-edits': 'acceptEdits',
  'exit-plan-auto': 'auto',
  'exit-plan-clear-auto': 'auto',
  'exit-plan-bypass': 'bypassPermissions',
  'exit-plan-clear-bypass': 'bypassPermissions',
};

/** @type {Record<string, Engine>} Без прототипа: id из кнопки (eng:constructor и т.п.) не находит унаследованных свойств. */
export const ENGINES = Object.assign(Object.create(null), {
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    short: 'Gemini',
    envVar: 'GEMINI_COMMAND',
    defaultCommand: 'gemini',
    args: ['--acp'],
    versionArgs: ['--version'],
    install: 'npm i -g @google/gemini-cli',
    modes: { read: 'plan', normal: 'default', full: 'autoEdit' },
    modeRank: ['plan', 'default', 'autoEdit', 'yolo'],
    // модели — в ответе session/new (models.availableModels), смена — session/set_model; уровня рассуждений нет
    modelSource: 'models',
    autoModel: 'auto',
    effortConfig: null,
    adminMode: process.env.GEMINI_ADMIN_MODE || process.env.ACP_MODE || 'autoEdit',
    // «навсегда» (сохранение в политику агента) из удалённого чата не даём
    permanentOption: (o) => /_and_save$/.test(o.optionId),
    cleanText: stripGeminiModeUpdate,
    // у Gemini имя инструмента зашито в toolCallId: «read_file__call_…»
    toolName: (u) => {
      const id = u.toolCallId || '';
      return id.includes('__call_') ? id.split('__call_')[0] : u.name || id || 'tool';
    },
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    short: 'Claude',
    envVar: 'CLAUDE_COMMAND',
    defaultCommand: 'claude-agent-acp', // мост ACP: npm i -g @agentclientprotocol/claude-agent-acp
    args: [],
    versionArgs: ['--version'],
    install: 'npm i -g @agentclientprotocol/claude-agent-acp',
    // «Полный» — без подтверждений вообще (bypassPermissions); по умолчанию мост стартует в режиме auto, поэтому режим задаём всегда
    modes: { read: 'plan', normal: 'default', full: 'bypassPermissions' },
    modeRank: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
    // модель и уровень рассуждений — настройки сессии (configOptions model / effort), смена — session/set_config_option
    modelSource: 'config',
    autoModel: 'default',
    effortConfig: 'effort',
    autoEffort: 'default',
    adminMode: process.env.CLAUDE_ADMIN_MODE || 'bypassPermissions',
    permanentOption: (o) => CLAUDE_PERSISTENT.has(o.optionId),
    optionMode: (o) => CLAUDE_EXIT_PLAN[o.optionId] ?? null,
    cleanText: (s) => s,
    toolName: genericToolName,
    toolDescription: (u) => u.rawInput?.description || '',
    // мост пишет в stderr трассировку каждого этапа сессии — в лог бота её не пускаем, ошибки и предупреждения остаются
    quietStderr: /^\[(session\/[\w-]+|idle-compaction)\]|^\(Use `node --trace-warnings|CLAUDE_SDK_CAN_USE_TOOL_SHADOWED/,
  },
  agy: {
    id: 'agy',
    label: 'Antigravity CLI',
    short: 'Antigravity',
    envVar: 'AGY_COMMAND',
    defaultCommand: 'agy',
    args: ['acp'],
    versionArgs: ['--version'],
    install: 'Antigravity CLI 1.5+ (с подкомандой acp); войдите один раз: agy acp --login',
    // подкоманда `agy acp` появилась в 1.5: более старая версия запускается, но работать с ботом не может
    minVersion: '1.5.0',
    update: 'agy update',
    // режима без подтверждений в ACP у agy нет, «Полный» — правки файлов без подтверждений
    modes: { read: 'plan', normal: 'default', full: 'accept-edits' },
    modeRank: ['plan', 'default', 'accept-edits'],
    // модель и уровень рассуждений — configOptions model / thought_level; режима «авто» нет — по умолчанию модель агента
    modelSource: 'config',
    effortConfig: 'thought_level',
    adminMode: process.env.AGY_ADMIN_MODE || 'accept-edits',
    cleanText: (s) => s,
    toolName: genericToolName,
    toolDescription: (u) => u.rawInput?.toolSummary || u.args?.toolSummary || '',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex',
    short: 'Codex',
    envVar: 'CODEX_COMMAND',
    defaultCommand: 'codex-acp', // мост ACP: npm i -g @agentclientprotocol/codex-acp
    args: [],
    versionArgs: ['--version'],
    install: 'npm i -g @agentclientprotocol/codex-acp (нужен установленный Codex CLI и вход: codex login)',
    // «Полный» — доступ ко всему без подтверждений; «workspace-write» — правки в рабочей папке, остальное по запросу
    modes: { read: 'read-only', normal: 'workspace-write', full: 'agent-full-access' },
    modeRank: ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
    // модель и уровень рассуждений — configOptions model / reasoning_effort, смена — session/set_config_option
    modelSource: 'config',
    effortConfig: 'reasoning_effort',
    adminMode: process.env.CODEX_ADMIN_MODE || 'agent-full-access',
    cleanText: (s) => s,
    toolName: genericToolName,
    toolDescription: (u) => u.rawInput?.description || '',
  },
});
Object.freeze(ENGINES);

/** Движок по умолчанию: DEFAULT_ENGINE из .env (gemini | claude | agy | codex), иначе Gemini. */
export const DEFAULT_ENGINE = ENGINES[process.env.DEFAULT_ENGINE?.trim().toLowerCase()] ? process.env.DEFAULT_ENGINE.trim().toLowerCase() : 'gemini';

/** Движок по умолчанию обязателен: без него бот не запускается. Остальные — по возможности. */
export const isRequired = (engine) => engine.id === DEFAULT_ENGINE;

/** Движок по id; неизвестный id — движок по умолчанию. */
export const getEngine = (id) => ENGINES[id] ?? ENGINES[DEFAULT_ENGINE];

// ---- доступность движков (заполняется проверкой при старте) ----
const unavailable = new Set();

/** Отмечает движки, которые не запустились при старте; таймаут проверки считаем доступным (медленный, но есть). */
export function setAvailability(results) {
  unavailable.clear();
  for (const r of results) if (!r.ok && !r.timeout) unavailable.add(r.engine.id);
}

export const isAvailable = (id) => Boolean(ENGINES[id]) && !unavailable.has(id);

// ---- вход и ключи API (определяется по ошибке запуска сессии при получении каталога моделей) ----
const loginNeeded = new Set();

/** Ошибка запуска агента из-за отсутствия входа или ключа API («Authentication required», «API key is missing», 401…). */
export const isAuthError = (err) => /auth(?!or\b)|api[ _-]?key|log ?in|sign ?in|unauthori[sz]ed|credential|\b401\b/i.test(String(err?.message ?? err ?? ''));

/** Отмечает движок, которому нужен вход или ключ API (on = true), или снимает отметку. */
export function setNeedsLogin(id, on) {
  if (on) loginNeeded.add(id);
  else loginNeeded.delete(id);
}

/** Движок запускается, но не авторизован: выбор не блокируется, пользователю показывается предупреждение. */
export const needsLogin = (id) => loginNeeded.has(id);

/** Движки, которые можно выбрать в /engine. */
export const availableEngines = () => Object.values(ENGINES).filter((e) => isAvailable(e.id));

/**
 * Движок, в котором работает пользователь: его выбор, если такой движок есть и доступен, иначе движок по умолчанию.
 * @param {string|null|undefined} preferred
 */
export const resolveEngine = (preferred) => (preferred && isAvailable(preferred) ? ENGINES[preferred] : ENGINES[DEFAULT_ENGINE]);

/** Команда запуска движка: из переменной окружения или по умолчанию. */
export const engineCommand = (engine) => process.env[engine.envVar] || engine.defaultCommand;

/** Режим сессии для уровня доступа. Администратор — adminMode; неизвестный уровень — самый безопасный (чтение). */
export function engineMode(engine, { admin = false, level } = {}) {
  if (admin) return engine.adminMode;
  return (Object.hasOwn(engine.modes, level ?? '') && engine.modes[level]) || engine.modes.read;
}

/**
 * Режим не выше разрешённого (по порядку modeRank движка). Неизвестный режим допустим только если совпадает с разрешённым.
 * @param {Engine} engine
 */
export function modeAllowed(engine, mode, allowed) {
  if (mode === allowed) return true;
  const r = engine.modeRank ?? [];
  const i = r.indexOf(mode);
  const max = r.indexOf(allowed);
  return i >= 0 && max >= 0 && i <= max;
}

/**
 * Какие варианты ответа на запрос разрешения показать пользователю. Убираем:
 * - постоянные правила (сохраняются в настройках агента или проекта для всех будущих сессий);
 * - варианты, которые переключают сессию в режим выше разрешённого уровнем доступа (выход из плана у Claude Code).
 * @param {Engine} engine
 * @param {{optionId: string, kind: string, name: string}[]} options
 * @param {string} allowed режим, разрешённый пользователю (engineMode)
 */
export function permissionOptions(engine, options, allowed) {
  return options.filter((o) => {
    if (engine.permanentOption?.(o)) return false;
    const target = engine.optionMode?.(o);
    return !target || modeAllowed(engine, target, allowed);
  });
}

// ---- модели, уровень рассуждений, расход ----

/** Варианты настройки сессии (плоский список; группы вариантов разворачиваются). */
const configValues = (opt) =>
  (opt?.options ?? [])
    .flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]))
    .filter((o) => o && o.value != null)
    .map((o) => ({ id: String(o.value), name: o.name || String(o.value) }));

/**
 * Каталог движка из ответа session/new: модели, уровни рассуждений и значения агента по умолчанию.
 * «Авто» агента (auto у Gemini, default у Claude Code) в списки не входит — это отдельная кнопка «Авто».
 * @returns {{models: {id,name}[], efforts: {id,name}[], defaultModel: string|null, defaultEffort: string|null}}
 */
export function parseCatalog(engine, res) {
  const cfg = (id) => res?.configOptions?.find((o) => o.id === id);
  let models;
  let defaultModel;
  if (engine.modelSource === 'models') {
    models = (res?.models?.availableModels ?? []).map((m) => ({ id: String(m.modelId), name: m.name || String(m.modelId) }));
    defaultModel = res?.models?.currentModelId ?? null;
  } else {
    models = configValues(cfg('model'));
    defaultModel = cfg('model')?.currentValue ?? null;
  }
  const effort = engine.effortConfig ? cfg(engine.effortConfig) : null;
  return {
    models: models.filter((m) => m.id !== engine.autoModel),
    efforts: configValues(effort).filter((e) => e.id !== engine.autoEffort),
    defaultModel: defaultModel == null ? null : String(defaultModel),
    defaultEffort: effort?.currentValue == null ? null : String(effort.currentValue),
  };
}

/** Значение «Авто» для возврата к настройке агента по умолчанию: auto/default движка или то, что агент выставил сам. */
export const autoValue = (engine, catalog, kind) => (kind === 'model' ? engine.autoModel ?? catalog?.defaultModel : engine.autoEffort ?? catalog?.defaultEffort) ?? null;

/**
 * Запрос ACP для смены модели или уровня рассуждений: [метод, параметры].
 * @param {'model'|'effort'} kind
 */
export function selectionRequest(engine, sessionId, kind, value) {
  if (kind === 'model' && engine.modelSource === 'models') return ['session/set_model', { sessionId, modelId: value }];
  return ['session/set_config_option', { sessionId, configId: kind === 'model' ? 'model' : engine.effortConfig, value }];
}

/**
 * Расход запроса из ответа session/prompt и последнего usage_update.
 * Реальная модель: _meta.quota.model_usage (Gemini CLI, Claude Code) или _meta._claude/model.
 * costTotal — стоимость в $ нарастающим итогом за процесс агента (присылает только Claude Code).
 */
export function parseUsage(res, usageUpdate) {
  const u = res?.usage ?? {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  const usageModels = res?._meta?.quota?.model_usage;
  // у Claude Code в model_usage бывают и модели субагентов — основная модель сессии в _claude/model
  const model = usageUpdate?._meta?.['_claude/model'] || (Array.isArray(usageModels) && usageModels[0]?.model) || null;
  const cost = usageUpdate?.cost;
  return {
    model,
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cachedRead: num(u.cachedReadTokens),
    thought: num(u.thoughtTokens),
    total: num(u.totalTokens),
    costTotal: cost && (cost.currency ?? 'USD') === 'USD' ? num(cost.amount) : null,
  };
}

/**
 * Создаёт клиент агента (AgentClient) для движка.
 * @param {Engine} engine
 * @param {{cwd: string, onUpdate?: Function, onPermission?: Function, onExit?: Function}} opts
 */
export function createAgent(engine, opts) {
  const agent = new AcpAgent({ ...opts, command: engineCommand(engine), args: engine.args, name: engine.label, quietStderr: engine.quietStderr ?? null });
  agent.engine = engine;
  return agent;
}

/** Номер версии x.y.z из вывода `--version` («1.5.5», «agy 1.0.13», «v24.1.0») или null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** a >= b для версий x.y.z (строки или массивы). Неизвестная версия считается подходящей — не мешаем запуску. */
export function versionAtLeast(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a);
  const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/**
 * Проверяет при старте, какие движки запускаются (`<команда> --version`), параллельно.
 * Движок с версией ниже minVersion — недоступен (ok: false, tooOld: true): он запускается, но по ACP работать не может.
 * @returns {Promise<Array<{engine: Engine, command: string, tooOld?: boolean} & Awaited<ReturnType<typeof checkCommand>>>>}
 */
export function checkEngines(engines = Object.values(ENGINES), timeoutMs) {
  return Promise.all(
    engines.map(async (engine) => {
      const command = engineCommand(engine);
      const r = { engine, command, ...(await checkCommand(command, engine.versionArgs, timeoutMs)) };
      if (r.ok && engine.minVersion && !versionAtLeast(r.version, engine.minVersion)) {
        return { ...r, ok: false, tooOld: true, error: `версия ${r.version}, нужна ${engine.minVersion}+${engine.update ? ` — обновите: ${engine.update}` : ''}` };
      }
      return r;
    }),
  );
}

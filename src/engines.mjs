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
// Окружение процесса агента (agentEnv) — окружение бота без токена бота и без ключей API чужих провайдеров
// (apiKeys движка); движок может добавить свои переменные (processEnv) — например, конфиг прав OpenCode по уровню доступа.
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
 * @property {(who:{admin?:boolean, level?:string})=>Record<string,string>} [processEnv]  свои переменные окружения процесса агента
 * @property {string[]|null} apiKeys    ключи API провайдеров, которые видит процесс агента; null — все (OpenCode)
 * @property {boolean} [modelGroups]    модели «провайдер/модель»: в /model — по группам (бесплатные, провайдеры)
 * @property {{args: string[], parse: (out:string)=>Map<string,{free:boolean,tools:boolean}>}} [modelMeta]  команда со сведениями о моделях
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

// Права OpenCode по уровням доступа. Режима ACP «без подтверждений» у OpenCode нет (build / plan), права задаются
// конфигом: бот передаёт его процессу агента в OPENCODE_CONFIG_CONTENT. Без него в build правки и команды идут без вопросов,
// а в plan запрещены только правки (bash остаётся) — поэтому конфиг передаётся всегда, на любом уровне.
// deny — инструмент вообще не доступен модели; ask — запрос разрешения кнопками в Telegram.
const OPENCODE_PERMISSIONS = {
  read: { edit: 'deny', bash: 'deny', webfetch: 'ask' },
  normal: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
  full: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
};

/** Конфиг прав OpenCode для уровня доступа (администратор — «Полный»; неизвестный уровень — «Чтение»). */
export function opencodeConfig({ admin = false, level } = {}) {
  const key = admin ? 'full' : Object.hasOwn(OPENCODE_PERMISSIONS, level ?? '') ? level : 'read';
  return { permission: OPENCODE_PERMISSIONS[key] };
}

/**
 * Ключ Google для OpenCode. Провайдера Google OpenCode находит по GEMINI_API_KEY / GOOGLE_API_KEY и показывает его модели,
 * но запросы его библиотека шлёт только с GOOGLE_GENERATIVE_AI_API_KEY — без неё «provider authentication required»
 * (проверено на 1.19.5). Если эта переменная не задана, передаём в неё имеющийся ключ.
 */
export function opencodeGoogleKey(env = process.env) {
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) return {};
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  return key ? { GOOGLE_GENERATIVE_AI_API_KEY: key } : {};
}

/**
 * Сведения о моделях из `opencode models --verbose`: блоки «провайдер/модель» + JSON с ценой и возможностями.
 * free — нулевая цена ввода и вывода; tools — модель умеет вызывать инструменты (без этого агент работать не может:
 * так отсеиваются модели генерации картинок и музыки, у которых цена тоже 0).
 * @returns {Map<string, {free: boolean, tools: boolean}>}
 */
export function parseOpencodeModels(text) {
  const meta = new Map();
  let id = null;
  let buf = [];
  const flush = () => {
    if (!id) return;
    try {
      const j = JSON.parse(buf.join('\n'));
      const c = j.cost ?? {};
      meta.set(id, {
        free: Number(c.input) === 0 && Number(c.output) === 0 && c.input != null && c.output != null,
        tools: j.capabilities?.toolcall !== false && j.status !== 'deprecated',
      });
    } catch {
      /* блок не разобрался — о модели ничего не знаем, она остаётся без пометок */
    }
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^[^\s{}"[\]]+\/[^\s{}"[\]]+$/.test(line)) {
      flush();
      id = line;
      buf = [];
    } else if (id) buf.push(line);
  }
  flush();
  return meta;
}

const GOOGLE_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];

/** Ключи API провайдеров моделей. Процесс агента получает из них только ключи своего движка (Engine.apiKeys). */
export const PROVIDER_KEYS = new Set([...GOOGLE_KEYS, 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY']);

/** Переменные самого бота: процессу агента не нужны, а токен даёт полный контроль над ботом. */
const BOT_ONLY_ENV = new Set(['TELEGRAM_BOT_TOKEN', 'ALLOWED_USER_ID', 'ALLOWED_USERNAME']);
const SECRET_ENV = /(?:^|_)(TOKEN|SECRET|PASSWORD|PWD|PAT|KEY)$/i;
const envList = (value) => new Set(String(value ?? '').split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));

/**
 * Окружение процесса агента: окружение бота без переменных самого бота (BOT_ONLY_ENV) и без ключей API чужих
 * провайдеров. Агент выполняет команды пользователя, и раньше любой сотрудник мог попросить его показать
 * TELEGRAM_BOT_TOKEN или ключ провайдера, к движку которого у него нет доступа. Остальные переменные (PATH, прокси,
 * переменные скриптов проекта) передаются как есть. Имена сравниваются без учёта регистра (Windows).
 * @param {{apiKeys?: string[]|null}} engine
 */
export function agentEnv(engine, env = process.env) {
  const own = engine.apiKeys ? new Set(engine.apiKeys) : null;
  const hide = envList(env.AGENT_ENV_HIDE);
  const pass = envList(env.AGENT_ENV_PASS);
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    const key = name.toUpperCase();
    if (BOT_ONLY_ENV.has(key) || hide.has(key) || key === 'AGENT_ENV_HIDE' || key === 'AGENT_ENV_PASS') continue;
    const provider = PROVIDER_KEYS.has(key);
    if (provider && own && !own.has(key)) continue;
    if (!provider && !pass.has(key) && SECRET_ENV.test(key)) continue;
    out[name] = value;
  }
  return out;
}

/** @type {Record<string, Engine>} Без прототипа: id из кнопки (eng:constructor и т.п.) не находит унаследованных свойств. */
export const ENGINES = Object.assign(Object.create(null), {
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    short: 'Gemini',
    envVar: 'GEMINI_COMMAND',
    apiKeys: GOOGLE_KEYS,
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
    // Под службой (без консоли) вспомогательный процесс node-pty внутри Gemini CLI падает с «AttachConsole failed»
    // после каждой команды оболочки — на работу не влияет (команды выполняются), но засоряет журнал трассировкой
    // на ~16 строк. Пропускаем этот блок целиком: от строки с conpty_console_list_agent.js до «Node.js vXX».
    quietStderrBlock: { start: /conpty_console_list_agent\.js/, end: /^Node\.js v\d/ },
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
    apiKeys: ['ANTHROPIC_API_KEY'],
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
    apiKeys: GOOGLE_KEYS, // вход Google или ключ Gemini API
    defaultCommand: 'agy',
    args: ['acp'],
    versionArgs: ['--version'],
    install: 'Antigravity CLI 1.5+ (с подкомандой acp); войдите один раз (agy acp --login) или задайте ключ Gemini API (GEMINI_API_KEY и "modelProvider": "gemini" в settings.json)',
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
    apiKeys: ['OPENAI_API_KEY'],
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
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    short: 'OpenCode',
    envVar: 'OPENCODE_COMMAND',
    apiKeys: null, // модели любых провайдеров, чьи ключи заданы
    defaultCommand: 'opencode',
    args: ['acp'],
    versionArgs: ['--version'],
    install: 'npm i -g opencode-ai (модели: ключи API провайдеров в окружении или opencode auth login; бесплатные модели OpenCode Zen — без ключа)',
    update: 'npm i -g opencode-ai@latest',
    // режимы ACP — build и plan; разница между «Обычным» и «Полным» — в конфиге прав (processEnv)
    modes: { read: 'plan', normal: 'build', full: 'build' },
    modeRank: ['plan', 'build'],
    // модели — configOptions model («провайдер/модель», только подключённые провайдеры); уровня рассуждений в ACP нет
    modelSource: 'config',
    effortConfig: null,
    // моделей много (сотни у подключённых провайдеров): в /model — по группам «Бесплатные» и провайдеры
    modelGroups: true,
    // цена и возможности моделей — отдельной командой (в ACP их нет)
    modelMeta: { args: ['models', '--verbose'], parse: parseOpencodeModels },
    adminMode: process.env.OPENCODE_ADMIN_MODE || 'build',
    processEnv: (who) => ({ OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(who)), ...opencodeGoogleKey() }),
    cleanText: (s) => s,
    // имя инструмента (bash, todowrite, webfetch…) — в title начального tool_call; в обновлениях и запросах разрешения
    // title — уже путь к файлу или команда, там — вид действия
    toolName: (u) => (u.sessionUpdate === 'tool_call' && u.title) || u.kind || u.toolCallId || 'tool',
    toolDescription: (u) => u.rawInput?.description || '',
  },
});
Object.freeze(ENGINES);

/** Движок по умолчанию: DEFAULT_ENGINE из .env (gemini | claude | agy | codex | opencode), иначе Gemini. */
export const DEFAULT_ENGINE = ENGINES[process.env.DEFAULT_ENGINE?.trim().toLowerCase()] ? process.env.DEFAULT_ENGINE.trim().toLowerCase() : 'gemini';

/** Движок по умолчанию обязателен: без него бот не запускается. Остальные — по возможности. */
export const isRequired = (engine) => engine.id === DEFAULT_ENGINE;

/** Движок по id; неизвестный id — движок по умолчанию. */
export const getEngine = (id) => ENGINES[id] ?? ENGINES[DEFAULT_ENGINE];

// ---- доступность движков (заполняется проверкой при старте) ----
const unavailable = new Set();
const versions = new Map(); // движок → версия из проверки при старте

/** Отмечает движки, которые не запустились при старте; таймаут проверки считаем доступным (медленный, но есть). */
export function setAvailability(results) {
  unavailable.clear();
  versions.clear();
  for (const r of results) {
    if (!r.ok && !r.timeout) unavailable.add(r.engine.id);
    if (r.ok && r.version) versions.set(r.engine.id, r.version);
  }
}

/** Версия движка по проверке при старте (вывод `--version`) или null. */
export const engineVersion = (id) => versions.get(id) ?? null;

export const isAvailable = (id) => Boolean(ENGINES[id]) && !unavailable.has(id);

// ---- песочница (AGENT_SANDBOX): движки, которые при проверке на старте не запустились внутри неё ----
const sandboxBroken = new Set();

/** Отмечает движки, не запустившиеся в песочнице: сотрудникам (их агенты работают в ней) они не предлагаются. */
export function setSandboxBroken(ids) {
  sandboxBroken.clear();
  for (const id of ids) sandboxBroken.add(id);
}

/** Движок не запускается в песочнице (администратору, работающему без неё, он доступен). */
export const brokenInSandbox = (id) => sandboxBroken.has(id);

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

/** Названия вендоров OpenRouter, которые не получаются из id простой заглавной буквой. */
const VENDOR_NAMES = {
  openai: 'OpenAI', 'z-ai': 'Z.ai', 'x-ai': 'xAI', mistralai: 'Mistral AI', deepseek: 'DeepSeek', nvidia: 'NVIDIA', meta: 'Meta',
  'meta-llama': 'Meta Llama', moonshotai: 'Moonshot AI', minimax: 'MiniMax', 'bytedance-seed': 'ByteDance Seed', stepfun: 'StepFun',
  'aion-labs': 'Aion Labs', inclusionai: 'inclusionAI', thinkingmachines: 'Thinking Machines', ai21: 'AI21', 'arcee-ai': 'Arcee AI',
  baidu: 'Baidu', ibm: 'IBM', microsoft: 'Microsoft', nousresearch: 'Nous Research',
};

/** Название вендора по id: известное или с заглавной буквы («qwen» → «Qwen»). */
export const vendorName = (id) => VENDOR_NAMES[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

/**
 * Модель с группой (движки с modelGroups): id «провайдер/модель», название «Провайдер/Модель».
 * group — id провайдера, groupLabel — его название, short — название модели без провайдера (для кнопок внутри группы).
 * У агрегаторов (OpenRouter: «openrouter/anthropic/claude-…») ещё и вендор: sub — его id, subLabel — название
 * (из «Anthropic: Claude …» в названии модели, иначе id).
 * meta — сведения из modelMeta: free (бесплатная). Модели, которые не умеют вызывать инструменты (tools: false), отсеиваются.
 */
function groupModels(models, meta) {
  return models
    .filter((m) => meta?.get(m.id)?.tools !== false)
    .map((m) => {
      const slash = m.id.indexOf('/');
      if (slash < 1) return { ...m, ...(meta?.get(m.id)?.free ? { free: true } : {}) };
      const group = m.id.slice(0, slash);
      const nameSlash = m.name.indexOf('/');
      const short = nameSlash > 0 ? m.name.slice(nameSlash + 1) : m.name;
      const rest = m.id.slice(slash + 1);
      // «~openai/gpt-latest» — псевдоним OpenRouter «последняя версия»: тот же вендор
      const sub = rest.includes('/') ? rest.slice(0, rest.indexOf('/')).replace(/^~/, '') || null : null;
      return {
        ...m,
        group,
        groupLabel: nameSlash > 0 ? m.name.slice(0, nameSlash) : group,
        short,
        ...(sub ? { sub, subLabel: /^([^:/]{1,40}):\s/.exec(short)?.[1] ?? vendorName(sub) } : {}),
        ...(meta?.get(m.id)?.free ? { free: true } : {}),
      };
    });
}

/**
 * Каталог движка из ответа session/new: модели, уровни рассуждений и значения агента по умолчанию.
 * «Авто» агента (auto у Gemini, default у Claude Code) в списки не входит — это отдельная кнопка «Авто».
 * @param {Map<string,{free:boolean,tools:boolean}>} [meta] сведения о моделях (modelMeta движка), если удалось получить
 * @returns {{models: {id,name,group?,groupLabel?,short?,free?}[], efforts: {id,name}[], defaultModel: string|null, defaultEffort: string|null}}
 */
export function parseCatalog(engine, res, meta = null) {
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
  models = models.filter((m) => m.id !== engine.autoModel);
  return {
    models: engine.modelGroups ? groupModels(models, meta) : models,
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

export function actualModelFromUpdate(update) {
  const meta = update?._meta;
  return meta?.['_claude/model'] || (Array.isArray(meta?.quota?.model_usage) && meta.quota.model_usage[0]?.model) || null;
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
  const model = actualModelFromUpdate(usageUpdate) || (Array.isArray(usageModels) && usageModels[0]?.model) || null;
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
 * @param {{cwd: string, who?: {admin?: boolean, level?: string}, onUpdate?: Function, onPermission?: Function, onExit?: Function}} opts
 *   who — кто работает в сессии: от этого зависят переменные окружения движка (processEnv; у OpenCode — конфиг прав).
 *   Без who (запуск за списком моделей) — только общее окружение агента (agentEnv).
 *   wrap — запуск через программу-обёртку (песочница, sandbox.agentSandbox): {command, args, env}; её аргументы уже
 *   заканчиваются командой движка, аргументы движка добавляются следом, а окружение проходит через wrap.env.
 */
export function createAgent(engine, { who, wrap = null, extraEnv = null, ...opts }) {
  // extraEnv — переменные пользователя сверх общих (автор коммитов и вход git, gitAccess.agentGitEnv)
  const base = { ...agentEnv(engine), ...(who && engine.processEnv ? engine.processEnv(who) : {}), ...(extraEnv ?? {}) };
  const env = wrap ? wrap.env(base) : base;
  const command = wrap ? wrap.command : engineCommand(engine);
  const args = wrap ? [...wrap.args, ...engine.args] : engine.args;
  const agent = new AcpAgent({ ...opts, env, command, args, name: engine.label, quietStderr: engine.quietStderr ?? null, quietStderrBlock: engine.quietStderrBlock ?? null });
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
      const r = { engine, command, ...(await checkCommand(command, engine.versionArgs, timeoutMs, agentEnv(engine))) };
      if (r.ok && engine.minVersion && !versionAtLeast(r.version, engine.minVersion)) {
        return { ...r, ok: false, tooOld: true, error: `версия ${r.version}, нужна ${engine.minVersion}+${engine.update ? ` — обновите: ${engine.update}` : ''}` };
      }
      return r;
    }),
  );
}

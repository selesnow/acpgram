// Оформление сообщений бота в Telegram: ход работы агента, черновик со стримингом, итоговое сообщение, /start.
import { RICH_LIMIT, balanceMarkdown, escHtml } from './telegram.mjs';

/**
 * Анимированные иконки в черновике. Отключаются ANIMATED_ICONS=0 — например, если клиент Telegram
 * показывает вместо них 🙂 (в постоянных сообщениях бота без username с Fragment так и происходит).
 */
export const ANIMATED = process.env.ANIMATED_ICONS !== '0';

/**
 * Анимированные эмодзи набора AI Actions (https://t.me/addemoji/AIActions), который Telegram рекомендует
 * для блока размышлений в черновиках. Используются только в черновиках.
 */
export const ANIM = {
  thinking: '5535034915403333642', // облако мысли
  folder: '5537230721728380949', // документы с лупой
  read: '5535039193190760468', // файл с лупой
  write: '5537203062138994712', // файл с искрой
  shell: '5535251334510411788', // терминал
  search: '5537511986251694100', // лупа
  web: '5535365052359507996', // глобус
  skill: '5573389291184193551', // искры
  memory: '5537676191441354763', // мозг
  plan: '5535458420653555733', // шестерёнки
  tool: '5537581341383589905', // гаечный ключ
};

const T = {
  folder: { label: 'Просмотр папки', icon: '📂', anim: 'folder' },
  read: { label: 'Чтение файла', icon: '📖', anim: 'read' },
  write: { label: 'Запись файла', icon: '✏️', anim: 'write' },
  edit: { label: 'Правка файла', icon: '✏️', anim: 'write' },
  shell: { label: 'Команда', icon: '⚙️', anim: 'shell' },
  grep: { label: 'Поиск по файлам', icon: '🔍', anim: 'search' },
  find: { label: 'Поиск файлов', icon: '🔍', anim: 'search' },
  fetch: { label: 'Загрузка страницы', icon: '🌐', anim: 'web' },
  web: { label: 'Поиск в интернете', icon: '🌐', anim: 'web' },
  skill: { label: 'Навык', icon: '🧩', anim: 'skill' },
  todo: { label: 'План работы', icon: '📝', anim: 'plan' },
};

/** Инструменты Gemini CLI, Claude Code и Antigravity CLI: название, обычный эмодзи и анимированная иконка. */
const TOOLS = {
  // Claude Code
  Read: T.read,
  Write: T.write,
  Edit: T.edit,
  MultiEdit: T.edit,
  NotebookEdit: T.edit,
  Bash: T.shell,
  PowerShell: T.shell,
  BashOutput: { label: 'Вывод команды', icon: '⚙️', anim: 'shell' },
  Grep: T.grep,
  Glob: T.find,
  LS: T.folder,
  WebFetch: T.fetch,
  WebSearch: T.web,
  TodoWrite: T.todo,
  Skill: T.skill,
  Task: { label: 'Подагент', icon: '🤖', anim: 'tool' },
  Agent: { label: 'Подагент', icon: '🤖', anim: 'tool' },
  // Antigravity CLI
  run_command: T.shell,
  view_file: T.read,
  list_dir: T.folder,
  find_by_name: T.find,
  write_to_file: T.write,
  replace_file_content: T.edit,
  multi_replace_file_content: T.edit,
  search_web: T.web,
  read_url_content: T.fetch,
  // Gemini CLI
  list_directory: { label: 'Просмотр папки', icon: '📂', anim: 'folder' },
  read_file: { label: 'Чтение файла', icon: '📖', anim: 'read' },
  read_many_files: { label: 'Чтение файлов', icon: '📖', anim: 'read' },
  write_file: { label: 'Запись файла', icon: '✏️', anim: 'write' },
  replace: { label: 'Правка файла', icon: '✏️', anim: 'write' },
  run_shell_command: { label: 'Команда', icon: '⚙️', anim: 'shell' },
  search_file_content: { label: 'Поиск по файлам', icon: '🔍', anim: 'search' },
  grep_search: { label: 'Поиск по файлам', icon: '🔍', anim: 'search' },
  glob: { label: 'Поиск файлов', icon: '🔍', anim: 'search' },
  web_fetch: { label: 'Загрузка страницы', icon: '🌐', anim: 'web' },
  google_web_search: { label: 'Поиск в интернете', icon: '🌐', anim: 'web' },
  activate_skill: { label: 'Навык', icon: '🧩', anim: 'skill' },
  save_memory: { label: 'Запись в память', icon: '🧠', anim: 'memory' },
  write_todos: { label: 'План работы', icon: '📝', anim: 'plan' },
};

/** Неизвестный инструмент — по виду действия ACP (read, edit, execute…), иначе гаечный ключ с именем инструмента. */
const KINDS = { read: T.read, edit: T.edit, delete: { label: 'Удаление', icon: '🗑', anim: 'write' }, move: { label: 'Перемещение', icon: '📦', anim: 'write' }, search: T.grep, execute: T.shell, fetch: T.fetch };

export const toolMeta = (tool, kind) => TOOLS[tool] || KINDS[kind] || { label: tool, icon: '🔧', anim: 'tool' };

/**
 * Анимированный эмодзи (или обычный, если анимация отключена). Только HTML-тег <tg-emoji>:
 * Markdown-запись ![](tg://emoji?id=…) внутри HTML-блоков (<tg-thinking>, <details>) не разбирается и видна как текст.
 */
export const anim = (key, fallback) => (ANIMATED && ANIM[key] ? `<tg-emoji emoji-id="${ANIM[key]}">${fallback}</tg-emoji>` : fallback);

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 1 шаг, 2 шага, 5 шагов. */
export function plural(n, one = 'шаг', few = 'шага', many = 'шагов') {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

/** 42 с, 1 мин 24 с, 3 мин. */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} мин ${r} с` : `${m} мин`;
}

/** Имя навыка из заголовка вызова activate_skill: `"windows-failed-tasks": Checks …` → windows-failed-tasks. */
export const skillName = (title) => /^\s*"?([^":]+?)"?\s*(?::|$)/.exec(title || '')?.[1] ?? title;

/**
 * Одна строка хода работы (rich Markdown/HTML). Саму команду не показываем — только суть.
 * live: строка черновика — у выполняющегося шага анимированная иконка.
 */
export function stepLine(step, { live = false } = {}) {
  const t = toolMeta(step.tool, step.kind);
  let mark;
  if (step.status === 'completed') mark = `✅ ${t.icon}`;
  else if (step.status === 'failed') mark = `❌ ${t.icon}`;
  else mark = live && ANIMATED ? anim(t.anim, t.icon) : `⏳ ${t.icon}`;

  let detail = '';
  if (step.kind === 'execute') detail = escHtml(trunc(step.description || 'выполнение команды', 90));
  else if (step.tool === 'activate_skill' && step.title) detail = `<code>${escHtml(trunc(skillName(step.title), 60))}</code>`;
  else if (step.title) detail = `<code>${escHtml(trunc(step.title, 70))}</code>`;
  return `${mark} **${escHtml(t.label)}**${detail ? ' — ' + detail : ''}`;
}

export const MAX_STEPS_SHOWN = 5;
const MAX_STEPS_FINAL = 60;
const SHOW_ELAPSED_AFTER_MS = 10_000;

/**
 * Черновик запроса.
 * - Агент ещё ничего не прислал → { plain: true }: простой пустой черновик, Telegram показывает свои анимированные точки.
 * - Размышления и шаги → блок размышлений (последний заголовок мыслей агента), последние шаги и время.
 * - Пошёл ответ → последний шаг и сам ответ (с закрытием незавершённой разметки).
 * @returns {{plain: true} | {markdown: string}}
 */
export function composeDraft({ thought = '', steps = [], answer = '', elapsedMs = 0 }) {
  if (answer.trim()) {
    const body = balanceMarkdown(answer.replace(/^\s+/, '')).slice(-RICH_LIMIT);
    const last = steps[steps.length - 1];
    return { markdown: last ? `${stepLine(last, { live: true })}\n\n${body}` : body };
  }
  if (!thought && !steps.length) return { plain: true };

  const parts = [];
  if (thought) parts.push(`<tg-thinking>${anim('thinking', '💭')} ${escHtml(thought)}</tg-thinking>`);
  const hidden = steps.length - MAX_STEPS_SHOWN;
  if (hidden > 0) parts.push(`_… и ещё ${plural(hidden)} выше_`);
  parts.push(...steps.slice(-MAX_STEPS_SHOWN).map((s) => stepLine(s, { live: true })));
  if (elapsedMs >= SHOW_ELAPSED_AFTER_MS) parts.push(`<footer>⏱ ${fmtDuration(elapsedMs)}</footer>`);
  return { markdown: parts.join('\n\n') };
}

/** 950 → «950», 36 785 → «36.8k», 1 250 000 → «1.25M». */
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  // граница по округлённому значению: 999 950 — это «1M», а не «1000k»
  if (Math.round(n / 100) < 10_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** Стоимость в $: мелкие суммы — с 4 знаками («0.0047»), остальные — с 2 («0.46»). */
export const fmtCost = (usd) => (Number.isFinite(usd) ? (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)) : '');

/**
 * Дополнение к итоговому ответу: свёрнутый ход работы и подвал: движок, модель, расход, проект, время.
 * @param {{steps: object[], elapsedMs: number, project?: string, engine?: string,
 *   usage?: {model?: string|null, effort?: string|null, total?: number|null, cost?: number|null}|null}} o
 */
export function finalExtras({ steps = [], elapsedMs = 0, project, engine, usage }) {
  const parts = [];
  if (steps.length) {
    const lines = steps.slice(0, MAX_STEPS_FINAL).map((s) => `- ${stepLine(s)}`);
    if (steps.length > MAX_STEPS_FINAL) lines.push(`- … и ещё ${plural(steps.length - MAX_STEPS_FINAL)}`);
    parts.push(`<details><summary>Ход работы · ${plural(steps.length)}</summary>\n\n${lines.join('\n')}\n\n</details>`);
  }
  const who = [engine, usage?.model, usage?.effort].filter(Boolean).map(escHtml).join(' · ');
  const meta = [
    who ? `🤖 ${who}` : null,
    Number.isFinite(usage?.total) ? `🔢 ${fmtTokens(usage.total)} ток.` : null,
    Number.isFinite(usage?.cost) ? `💲${fmtCost(usage.cost)}` : null,
    project ? `📁 ${escHtml(project)}` : null,
    `⏱ ${fmtDuration(elapsedMs)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  parts.push(`<footer>${meta}</footer>`);
  return parts.join('\n\n');
}

/** Ответ и дополнения одним сообщением, если помещаются; иначе дополнения отдельным сообщением. */
export function finalMessages(answer, extras) {
  if (!extras) return [answer];
  const joined = `${answer}\n\n${extras}`;
  return joined.length <= RICH_LIMIT ? [joined] : [answer, extras];
}

/**
 * Статус сессии сотрудника для карточки в /users.
 * @param {{project: string, startedAt: number, busy: boolean}|undefined} s активная сессия или undefined
 * @param {(p:string)=>string} projectOf как показывать путь проекта
 */
export function sessionStatus(s, projectOf = (p) => p, now = Date.now()) {
  return s ? `🟢 Сессия активна (${sessionDetails(s, projectOf, now)})` : '⚪ Неактивен';
}

/** Движок, проект, время работы и занятость сессии: «Claude · team/proj, 12 мин, выполняет запрос». */
const sessionDetails = (s, projectOf, now) => `${s.engine ? `${s.engine} · ` : ''}${projectOf(s.project)}, ${fmtDuration(now - s.startedAt)}${s.busy ? ', выполняет запрос' : ''}`;

/**
 * Экран /active: все работающие сессии и кнопки завершения сессий сотрудников (adm:k:<id>:a).
 * Администратор в списке есть, но в лимит слотов не входит и кнопки завершения не получает.
 */
export function activeSessionsView({ sessions, adminId, maxAgents, nameOf, projectOf = (p) => p, now = Date.now() }) {
  const employees = sessions.filter((s) => s.userId !== adminId);
  const text = sessions.length
    ? `🟢 Активные сессии (${sessions.length}), слотов сотрудников занято ${employees.length} из ${maxAgents}:\n` +
      sessions.map((s) => `• ${nameOf(s.userId)} — ${sessionDetails(s, projectOf, now)}`).join('\n')
    : `⚪ Активных сессий нет, все ${maxAgents} слота сотрудников свободны.`;
  return {
    text,
    markup: {
      inline_keyboard: [
        ...employees.map((s) => [{ text: `🛑 Завершить: ${nameOf(s.userId)}`, callback_data: `adm:k:${s.userId}:a` }]),
        [{ text: '🔄 Обновить', callback_data: 'adm:act' }],
      ],
    },
  };
}

/**
 * Экран /engine: текущий движок и кнопки выбора (eng:<id>).
 * @param {{engines: {id:string,label:string}[], current: string, defaultId: string, unavailable?: string[]}} o
 *   engines — доступные движки; unavailable — названия движков, которые не запустились на сервере
 */
export function engineMenu({ engines, current, defaultId, unavailable = [] }) {
  const cur = engines.find((e) => e.id === current);
  const text = [
    `🤖 Движок: ${cur?.label ?? current}`,
    'Выберите AI-агента. Выбор запоминается, смена движка начинает новую сессию.',
    ...(unavailable.length ? [`Недоступны на сервере: ${unavailable.join(', ')}`] : []),
  ].join('\n');
  return {
    text,
    markup: { inline_keyboard: engines.map((e) => [{ text: `${e.id === current ? '✓ ' : ''}${e.label}${e.id === defaultId ? ' · по умолчанию' : ''}`, callback_data: `eng:${e.id}` }]) },
  };
}

/** callback_data не длиннее 64 байт: длинный id заменяем номером в списке (#3). */
const cbValue = (prefix, id, index) => (Buffer.byteLength(`${prefix}${id}`) <= 64 ? `${prefix}${id}` : `${prefix}#${index}`);

/** Раскладка кнопок по n в ряд. */
const rowsOf = (buttons, n) => Array.from({ length: Math.ceil(buttons.length / n) }, (_, i) => buttons.slice(i * n, i * n + n));

/**
 * Экран /model: модели и уровни рассуждений движка. Кнопки: mdl:<движок>:m:<id> / mdl:<движок>:e:<id>, «Авто» — ~.
 * @param {{engine: {id:string,label:string}, models: {id,name}[], efforts: {id,name}[], model: string|null, effort: string|null,
 *   restricted?: boolean}} o  model/effort — текущий выбор (null — «Авто»); restricted — модели ограничены администратором (без «Авто»)
 */
export function modelMenu({ engine, models, efforts = [], model, effort, restricted = false }) {
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  const text = [
    `🧠 Модель — ${engine.label}`,
    `Сейчас: ${model ? nameOf(models, model) : 'Авто (как у агента по умолчанию)'}`,
    ...(efforts.length ? [`Рассуждения: ${effort ? nameOf(efforts, effort) : 'Авто'}`] : []),
    ...(restricted ? ['Список моделей ограничен администратором.'] : []),
    'Выбор запоминается для этого движка и применяется со следующего запроса.',
  ].join('\n');
  const mark = (on, label) => `${on ? '✓ ' : ''}${label}`;
  const modelButtons = [
    ...(restricted ? [] : [{ text: mark(!model, 'Авто'), callback_data: `mdl:${engine.id}:m:~` }]),
    ...models.map((m, i) => ({ text: mark(m.id === model, m.name), callback_data: cbValue(`mdl:${engine.id}:m:`, m.id, i) })),
  ];
  const effortButtons = efforts.length
    ? [{ text: mark(!effort, '🧠 Авто'), callback_data: `mdl:${engine.id}:e:~` }, ...efforts.map((x, i) => ({ text: mark(x.id === effort, `🧠 ${x.name}`), callback_data: cbValue(`mdl:${engine.id}:e:`, x.id, i) }))]
    : [];
  return { text, markup: { inline_keyboard: [...rowsOf(modelButtons, 2), ...rowsOf(effortButtons, 3)] } };
}

// ---------- права сотрудника в карточке /users (кнопки adm:*) ----------

/**
 * Строка «Движки: …» и кнопки-переключатели движков (adm:et:<id>:<движок>); движок по умолчанию выключить нельзя.
 * @param {{userId: number, engines: {id:string,label:string,granted:boolean,isDefault:boolean}[]}} o
 */
export function engineGrants({ userId, engines }) {
  const line = `Движки: ${engines.filter((e) => e.granted).map((e) => e.label + (e.isDefault ? ' (по умолчанию)' : '')).join(', ')}`;
  const toggles = engines.filter((e) => !e.isDefault).map((e) => ({ text: `${e.granted ? '✅' : '⬜'} ${e.label}`, callback_data: `adm:et:${userId}:${e.id}` }));
  return { line, rows: [...rowsOf(toggles, 2), [{ text: '🧠 Модели сотрудника', callback_data: `adm:mm:${userId}` }]] };
}

/**
 * Экран «Модели сотрудника»: по каждому выданному движку — сколько моделей разрешено (adm:me:<id>:<движок>).
 * @param {{userId: number, name: string, engines: {id:string,label:string,total:number,allowed:number|null}[]}} o  allowed: null — все
 */
export function modelGrantsOverview({ userId, name, engines }) {
  const text = [
    `🧠 Модели — ${name}`,
    ...engines.map((e) => `• ${e.label}: ${e.total === 0 ? 'список моделей ещё не получен' : e.allowed == null ? 'все модели' : `${e.allowed} из ${e.total}`}`),
    'Выберите движок, чтобы ограничить модели.',
  ].join('\n');
  return {
    text,
    markup: { inline_keyboard: [...engines.map((e) => [{ text: e.label, callback_data: `adm:me:${userId}:${e.id}` }]), [{ text: '← К сотруднику', callback_data: `adm:u:${userId}` }]] },
  };
}

/**
 * Переключатели моделей сотрудника в движке (adm:mt:<id>:<движок>:<id модели> или :#<номер> для длинных id),
 * «Разрешить все» (adm:ma:<id>:<движок>).
 * @param {{userId: number, name: string, engine: {id:string,label:string}, models: {id,name}[], allowed: string[]|null}} o
 */
export function modelGrantsView({ userId, name, engine, models, allowed }) {
  const on = (id) => allowed == null || allowed.includes(id);
  const text = [
    `🧠 ${engine.label} — ${name}`,
    allowed == null ? 'Разрешены все модели (по умолчанию).' : `Разрешено моделей: ${allowed.length} из ${models.length}. «Авто» при ограничении недоступно — по умолчанию первая разрешённая.`,
    'Нажмите на модель, чтобы разрешить или запретить её.',
  ].join('\n');
  // id модели, а не номер: если список моделей изменится, кнопка не переключит чужую модель
  const toggles = models.map((m, i) => ({ text: `${on(m.id) ? '✅' : '⬜'} ${m.name}`, callback_data: cbValue(`adm:mt:${userId}:${engine.id}:`, m.id, i) }));
  return {
    text,
    markup: {
      inline_keyboard: [
        ...rowsOf(toggles, 2),
        ...(allowed == null ? [] : [[{ text: '✅ Разрешить все', callback_data: `adm:ma:${userId}:${engine.id}` }]]),
        [{ text: '← Назад', callback_data: `adm:mm:${userId}` }],
      ],
    },
  };
}

const button = (text, data) => `<tg-button type="callback_data" data="${data}">${text}</tg-button>`;

/**
 * Экран /start: rich-сообщение с кнопками. Кнопки присылают callback_data ui:<команда>.
 * @param {{level: string, project: string, engine: string, model?: string, isAdmin: boolean, note?: string}} o
 *   engine — название текущего движка, model — выбранная модель (по умолчанию «Авто»)
 */
export function startView({ level, project, engine, model = 'Авто', isAdmin, note }) {
  const commands = [
    '- /project — выбрать проект (папку), в которой работает агент',
    '- /engine — выбрать движок: Gemini CLI, Claude Code, Antigravity CLI',
    '- /model — выбрать модель и уровень рассуждений',
    '- /new — новая сессия',
    '- /sessions — вернуться к прошлой сессии в этом проекте',
    '- /stop — остановить запрос',
    '- /close — закрыть сессию и освободить память сервера',
    ...(isAdmin ? ['- /users — сотрудники с доступом', '- /active — активные сессии', '- /invite — пригласить сотрудника'] : []),
  ];
  const rows = [`<tg-button-row>${button('📁 Проект', 'ui:project')}${button('🆕 Новая сессия', 'ui:new')}${button('↩️ Сессии', 'ui:sessions')}</tg-button-row>`, `<tg-button-row>${button('🤖 Движок', 'ui:engine')}${button('🧠 Модель', 'ui:model')}${button('🛑 Завершить сессию', 'ui:close')}</tg-button-row>`];
  if (isAdmin) rows.push(`<tg-button-row>${button('👥 Сотрудники', 'ui:users')}${button('🔗 Пригласить', 'ui:invite')}${button('🟢 Активные', 'ui:active')}</tg-button-row>`);
  return [
    '### 👋 AI-агент в Telegram',
    `Пишите запрос обычным сообщением — я передам его ${escHtml(engine)} и покажу, как идёт работа.`,
    `**🤖 Движок:** ${escHtml(engine)}\n**🧠 Модель:** ${escHtml(model)}\n**👤 Доступ:** ${escHtml(level)}\n**📁 Проект:** \`${project}\``,
    ...rows,
    `<details><summary>Команды</summary>\n\n${commands.join('\n')}\n\n</details>`,
    ...(note ? [`<footer>${escHtml(note)}</footer>`] : []),
  ].join('\n\n');
}

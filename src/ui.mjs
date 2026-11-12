// Оформление сообщений бота в Telegram: ход работы агента, черновик со стримингом, итоговое сообщение, /start.
// Все пользовательские строки — из i18n.mjs; функции получают язык пользователя (по умолчанию — DEFAULT_LANG).
import { DEFAULT_LANG, LOCALES, plural, t } from './i18n.mjs';
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

// Подпись инструмента — ключ перевода (tool.*), обычный эмодзи и анимированная иконка.
const T = {
  folder: { label: 'tool.folder', icon: '📂', anim: 'folder' },
  read: { label: 'tool.read', icon: '📖', anim: 'read' },
  write: { label: 'tool.write', icon: '✏️', anim: 'write' },
  edit: { label: 'tool.edit', icon: '✏️', anim: 'write' },
  shell: { label: 'tool.shell', icon: '⚙️', anim: 'shell' },
  grep: { label: 'tool.grep', icon: '🔍', anim: 'search' },
  find: { label: 'tool.find', icon: '🔍', anim: 'search' },
  fetch: { label: 'tool.fetch', icon: '🌐', anim: 'web' },
  web: { label: 'tool.web', icon: '🌐', anim: 'web' },
  skill: { label: 'tool.skill', icon: '🧩', anim: 'skill' },
  todo: { label: 'tool.plan', icon: '📝', anim: 'plan' },
};

/** Инструменты Gemini CLI, Claude Code и Antigravity CLI: подпись, обычный эмодзи и анимированная иконка. */
const TOOLS = {
  // Claude Code
  Read: T.read,
  Write: T.write,
  Edit: T.edit,
  MultiEdit: T.edit,
  NotebookEdit: T.edit,
  Bash: T.shell,
  PowerShell: T.shell,
  BashOutput: { label: 'tool.shellOutput', icon: '⚙️', anim: 'shell' },
  Grep: T.grep,
  Glob: T.find,
  LS: T.folder,
  WebFetch: T.fetch,
  WebSearch: T.web,
  TodoWrite: T.todo,
  Skill: T.skill,
  Task: { label: 'tool.subagent', icon: '🤖', anim: 'tool' },
  Agent: { label: 'tool.subagent', icon: '🤖', anim: 'tool' },
  // Antigravity CLI
  run_command: T.shell,
  // Codex
  exec_command: T.shell,
  view_file: T.read,
  list_dir: T.folder,
  find_by_name: T.find,
  write_to_file: T.write,
  replace_file_content: T.edit,
  multi_replace_file_content: T.edit,
  search_web: T.web,
  read_url_content: T.fetch,
  // Gemini CLI
  list_directory: T.folder,
  read_file: T.read,
  read_many_files: { label: 'tool.readMany', icon: '📖', anim: 'read' },
  write_file: T.write,
  replace: T.edit,
  run_shell_command: T.shell,
  search_file_content: T.grep,
  grep_search: T.grep,
  glob: T.find,
  web_fetch: T.fetch,
  google_web_search: T.web,
  activate_skill: T.skill,
  save_memory: { label: 'tool.memory', icon: '🧠', anim: 'memory' },
  write_todos: T.todo,
};

/** Неизвестный инструмент — по виду действия ACP (read, edit, execute…), иначе гаечный ключ с именем инструмента. */
const KINDS = {
  read: T.read,
  edit: T.edit,
  delete: { label: 'tool.delete', icon: '🗑', anim: 'write' },
  move: { label: 'tool.move', icon: '📦', anim: 'write' },
  search: T.grep,
  execute: T.shell,
  fetch: T.fetch,
};

/** Подпись, эмодзи и анимация инструмента на языке lang. Неизвестное имя инструмента показываем как есть. */
export const toolMeta = (tool, kind, lang = DEFAULT_LANG) => {
  const m = TOOLS[tool] || KINDS[kind];
  if (!m) return { label: tool, icon: '🔧', anim: 'tool' };
  return { label: t(m.label, lang), icon: m.icon, anim: m.anim };
};

/**
 * Анимированный эмодзи (или обычный, если анимация отключена). Только HTML-тег <tg-emoji>:
 * Markdown-запись ![](tg://emoji?id=…) внутри HTML-блоков (<tg-thinking>, <details>) не разбирается и видна как текст.
 */
export const anim = (key, fallback) => (ANIMATED && ANIM[key] ? `<tg-emoji emoji-id="${ANIM[key]}">${fallback}</tg-emoji>` : fallback);

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 42 с / 42 s, 1 мин 24 с / 1 min 24 s, 3 мин / 3 min. */
export function fmtDuration(ms, lang = DEFAULT_LANG) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('dur.s', lang, { n: s });
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? t('dur.ms', lang, { m, s: r }) : t('dur.m', lang, { n: m });
}

/** Имя навыка из заголовка вызова activate_skill: `"windows-failed-tasks": Checks …` → windows-failed-tasks. */
export const skillName = (title) => /^\s*"?([^":]+?)"?\s*(?::|$)/.exec(title || '')?.[1] ?? title;

/**
 * Одна строка хода работы (rich Markdown/HTML). Саму команду не показываем — только суть.
 * live: строка черновика — у выполняющегося шага анимированная иконка.
 */
export function stepLine(step, { live = false, lang = DEFAULT_LANG } = {}) {
  const tm = toolMeta(step.tool, step.kind, lang);
  let mark;
  if (step.status === 'completed') mark = `✅ ${tm.icon}`;
  else if (step.status === 'failed') mark = `❌ ${tm.icon}`;
  else mark = live && ANIMATED ? anim(tm.anim, tm.icon) : `⏳ ${tm.icon}`;

  let detail = '';
  if (step.kind === 'execute') detail = escHtml(trunc(step.description || t('step.command', lang), 90));
  else if (step.tool === 'activate_skill' && step.title) detail = `<code>${escHtml(trunc(skillName(step.title), 60))}</code>`;
  else if (step.title) detail = `<code>${escHtml(trunc(step.title, 70))}</code>`;
  return `${mark} **${escHtml(tm.label)}**${detail ? ' — ' + detail : ''}`;
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
export function composeDraft({ thought = '', steps = [], answer = '', elapsedMs = 0, lang = DEFAULT_LANG }) {
  if (answer.trim()) {
    const body = balanceMarkdown(answer.replace(/^\s+/, '')).slice(-RICH_LIMIT);
    const last = steps[steps.length - 1];
    return { markdown: last ? `${stepLine(last, { live: true, lang })}\n\n${body}` : body };
  }
  if (!thought && !steps.length) return { plain: true };

  const parts = [];
  if (thought) parts.push(`<tg-thinking>${anim('thinking', '💭')} ${escHtml(thought)}</tg-thinking>`);
  const hidden = steps.length - MAX_STEPS_SHOWN;
  if (hidden > 0) parts.push(t('draft.more', lang, { n: plural(hidden, 'step', lang) }));
  parts.push(...steps.slice(-MAX_STEPS_SHOWN).map((s) => stepLine(s, { live: true, lang })));
  if (elapsedMs >= SHOW_ELAPSED_AFTER_MS) parts.push(`<footer>⏱ ${fmtDuration(elapsedMs, lang)}</footer>`);
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
 *   usage?: {model?: string|null, effort?: string|null, total?: number|null, cost?: number|null}|null, lang?: string}} o
 */
export function finalExtras({ steps = [], elapsedMs = 0, project, engine, usage, lang = DEFAULT_LANG }) {
  const parts = [];
  if (steps.length) {
    const lines = steps.slice(0, MAX_STEPS_FINAL).map((s) => `- ${stepLine(s, { lang })}`);
    if (steps.length > MAX_STEPS_FINAL) lines.push(`- ${t('final.more', lang, { n: steps.length - MAX_STEPS_FINAL })}`);
    parts.push(`<details><summary>${t('final.work', lang, { n: plural(steps.length, 'step', lang) })}</summary>\n\n${lines.join('\n')}\n\n</details>`);
  }
  const who = [engine, usage?.model, usage?.effort].filter(Boolean).map(escHtml).join(' · ');
  const meta = [
    who ? `🤖 ${who}` : null,
    Number.isFinite(usage?.total) ? t('final.tokens', lang, { n: fmtTokens(usage.total) }) : null,
    Number.isFinite(usage?.cost) ? `💲${fmtCost(usage.cost)}` : null,
    project ? `📁 ${escHtml(project)}` : null,
    `⏱ ${fmtDuration(elapsedMs, lang)}`,
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

/** Движок, проект, время работы и занятость сессии: «Claude · team/proj, 12 мин, выполняет запрос». */
const sessionDetails = (s, projectOf, now, lang) => `${s.engine ? `${s.engine} · ` : ''}${projectOf(s.project)}, ${fmtDuration(now - s.startedAt, lang)}${s.busy ? t('session.busy', lang) : ''}`;

/**
 * Статус сессии сотрудника для карточки в /users.
 * @param {{project: string, startedAt: number, busy: boolean}|undefined} s активная сессия или undefined
 * @param {(p:string)=>string} projectOf как показывать путь проекта
 */
export function sessionStatus(s, projectOf = (p) => p, now = Date.now(), lang = DEFAULT_LANG) {
  return s ? t('session.active', lang, { details: sessionDetails(s, projectOf, now, lang) }) : t('session.idle', lang);
}

/**
 * Экран /active: все работающие сессии и кнопки завершения сессий сотрудников (adm:k:<id>:a).
 * Администратор в списке есть, но в лимит слотов не входит и кнопки завершения не получает.
 */
export function activeSessionsView({ sessions, adminId, maxAgents, nameOf, projectOf = (p) => p, now = Date.now(), lang = DEFAULT_LANG }) {
  const employees = sessions.filter((s) => s.userId !== adminId);
  const text = sessions.length
    ? `${t('active.summary', lang, { n: sessions.length, busy: employees.length, max: maxAgents })}\n` +
      sessions.map((s) => t('adm.session.line', lang, { name: nameOf(s.userId), details: sessionDetails(s, projectOf, now, lang) })).join('\n')
    : t('active.none', lang, { max: maxAgents });
  return {
    text,
    markup: {
      inline_keyboard: [
        ...employees.map((s) => [{ text: t('active.kill', lang, { name: nameOf(s.userId) }), callback_data: `adm:k:${s.userId}:a` }]),
        [{ text: t('btn.refresh', lang), callback_data: 'adm:act' }],
      ],
    },
  };
}

/**
 * Экран /engine: текущий движок и кнопки выбора (eng:<id>).
 * @param {{engines: {id:string,label:string}[], current: string, defaultId: string, unavailable?: string[], needLogin?: string[], lang?: string}} o
 *   engines — доступные движки; unavailable — названия движков, которые не запустились на сервере
 */
export function engineMenu({ engines, current, defaultId, unavailable = [], needLogin = [], lang = DEFAULT_LANG }) {
  const cur = engines.find((e) => e.id === current);
  const text = [
    t('engine.current', lang, { engine: cur?.label ?? current }),
    t('engine.pick', lang),
    ...(unavailable.length ? [t('engine.unavailable', lang, { list: unavailable.join(', ') })] : []),
    ...(needLogin.length ? [t('engine.needLogin', lang, { list: engines.filter((e) => needLogin.includes(e.id)).map((e) => e.label).join(', ') })] : []),
  ].join('\n');
  return {
    text,
    markup: {
      inline_keyboard: engines.map((e) => [
        {
          text: `${e.id === current ? '✓ ' : ''}${e.label}${e.id === defaultId ? t('engine.default', lang) : ''}${needLogin.includes(e.id) ? t('engine.needLoginTag', lang) : ''}`,
          callback_data: `eng:${e.id}`,
        },
      ]),
    },
  };
}

/** callback_data не длиннее 64 байт: длинный id заменяем номером в списке (#3). */
const cbValue = (prefix, id, index) => (Buffer.byteLength(`${prefix}${id}`) <= 64 ? `${prefix}${id}` : `${prefix}#${index}`);

/** Раскладка кнопок по n в ряд. */
const rowsOf = (buttons, n) => Array.from({ length: Math.ceil(buttons.length / n) }, (_, i) => buttons.slice(i * n, i * n + n));

/**
 * Экран /model: модели и уровни рассуждений движка. Кнопки: mdl:<движок>:m:<id> / mdl:<движок>:e:<id>, «Авто» — ~.
 * @param {{engine: {id:string,label:string}, models: {id,name}[], efforts: {id,name}[], model: string|null, effort: string|null,
 *   restricted?: boolean, lang?: string}} o  model/effort — текущий выбор (null — «Авто»); restricted — модели ограничены администратором (без «Авто»)
 */
export function modelMenu({ engine, models, efforts = [], model, effort, restricted = false, lang = DEFAULT_LANG }) {
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  const auto = t('auto', lang);
  const text = [
    t('model.title', lang, { engine: engine.label }),
    t('model.now', lang, { name: model ? nameOf(models, model) : t('model.autoDesc', lang) }),
    ...(efforts.length ? [t('model.effort', lang, { name: effort ? nameOf(efforts, effort) : auto })] : []),
    ...(restricted ? [t('model.restricted', lang)] : []),
    t('model.saved', lang),
  ].join('\n');
  const mark = (on, label) => `${on ? '✓ ' : ''}${label}`;
  const modelButtons = [
    ...(restricted ? [] : [{ text: mark(!model, auto), callback_data: `mdl:${engine.id}:m:~` }]),
    ...models.map((m, i) => ({ text: mark(m.id === model, m.name), callback_data: cbValue(`mdl:${engine.id}:m:`, m.id, i) })),
  ];
  const effortButtons = efforts.length
    ? [{ text: mark(!effort, `🧠 ${auto}`), callback_data: `mdl:${engine.id}:e:~` }, ...efforts.map((x, i) => ({ text: mark(x.id === effort, `🧠 ${x.name}`), callback_data: cbValue(`mdl:${engine.id}:e:`, x.id, i) }))]
    : [];
  return { text, markup: { inline_keyboard: [...rowsOf(modelButtons, 2), ...rowsOf(effortButtons, 3)] } };
}

/** Итог выбора в /model: вместо меню — какой движок и какая модель (и уровень рассуждений) теперь выбраны. */
export function modelChosen({ engine, models, efforts = [], model, effort, lang = DEFAULT_LANG }) {
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  return [
    t('model.chosenEngine', lang, { engine: engine.label }),
    t('model.chosenModel', lang, { name: model ? nameOf(models, model) : t('model.autoDesc', lang) }),
    ...(efforts.length ? [t('model.chosenEffort', lang, { name: effort ? nameOf(efforts, effort) : t('auto', lang) })] : []),
    t('model.saved', lang),
  ].join('\n');
}

// ---------- права сотрудника в карточке /users (кнопки adm:*) ----------

/**
 * Строка «Движки: …» и кнопки-переключатели движков (adm:et:<id>:<движок>); движок по умолчанию выключить нельзя.
 * @param {{userId: number, engines: {id:string,label:string,granted:boolean,isDefault:boolean}[], lang?: string}} o
 */
export function engineGrants({ userId, engines, lang = DEFAULT_LANG }) {
  const list = engines
    .filter((e) => e.granted)
    .map((e) => e.label + (e.isDefault ? t('adm.engineDefault', lang) : ''))
    .join(', ');
  const line = t('adm.engines', lang, { list });
  const toggles = engines.filter((e) => !e.isDefault).map((e) => ({ text: `${e.granted ? '✅' : '⬜'} ${e.label}`, callback_data: `adm:et:${userId}:${e.id}` }));
  return { line, rows: [...rowsOf(toggles, 2), [{ text: t('adm.modelsBtn', lang), callback_data: `adm:mm:${userId}` }]] };
}

/**
 * Экран «Модели сотрудника»: по каждому выданному движку — сколько моделей разрешено (adm:me:<id>:<движок>).
 * @param {{userId: number, name: string, engines: {id:string,label:string,total:number,allowed:number|null}[], lang?: string}} o  allowed: null — все
 */
export function modelGrantsOverview({ userId, name, engines, lang = DEFAULT_LANG }) {
  const text = [
    t('adm.modelsTitle', lang, { name }),
    ...engines.map((e) => {
      const status = e.total === 0 ? t('adm.modelsNoCatalog', lang) : e.allowed == null ? t('adm.modelsAll', lang) : t('adm.modelsCount', lang, { a: e.allowed, t: e.total });
      return `• ${e.label}: ${status}`;
    }),
    t('adm.modelsPick', lang),
  ].join('\n');
  return {
    text,
    markup: { inline_keyboard: [...engines.map((e) => [{ text: e.label, callback_data: `adm:me:${userId}:${e.id}` }]), [{ text: t('adm.toUser', lang), callback_data: `adm:u:${userId}` }]] },
  };
}

/**
 * Переключатели моделей сотрудника в движке (adm:mt:<id>:<движок>:<id модели> или :#<номер> для длинных id),
 * «Разрешить все» (adm:ma:<id>:<движок>).
 * @param {{userId: number, name: string, engine: {id:string,label:string}, models: {id,name}[], allowed: string[]|null, lang?: string}} o
 */
export function modelGrantsView({ userId, name, engine, models, allowed, lang = DEFAULT_LANG }) {
  const on = (id) => allowed == null || allowed.includes(id);
  const text = [
    t('adm.engineModelsTitle', lang, { engine: engine.label, name }),
    allowed == null ? t('adm.modelsAllAllowed', lang) : t('adm.modelsSome', lang, { a: allowed.length, t: models.length }),
    t('adm.modelsHint', lang),
  ].join('\n');
  // id модели, а не номер: если список моделей изменится, кнопка не переключит чужую модель
  const toggles = models.map((m, i) => ({ text: `${on(m.id) ? '✅' : '⬜'} ${m.name}`, callback_data: cbValue(`adm:mt:${userId}:${engine.id}:`, m.id, i) }));
  return {
    text,
    markup: {
      inline_keyboard: [
        ...rowsOf(toggles, 2),
        ...(allowed == null ? [] : [[{ text: t('adm.allowAllBtn', lang), callback_data: `adm:ma:${userId}:${engine.id}` }]]),
        [{ text: t('btn.back', lang), callback_data: `adm:mm:${userId}` }],
      ],
    },
  };
}

const button = (text, data) => `<tg-button type="callback_data" data="${data}">${text}</tg-button>`;

/**
 * Экран /start: rich-сообщение с кнопками. Кнопки присылают callback_data ui:<команда>.
 * @param {{level: string, project: string, engine: string, model?: string, isAdmin: boolean, note?: string, lang?: string}} o
 *   level, engine, model — уже переведённые названия (уровень доступа, движок, модель; по умолчанию «Авто»)
 */
export function startView({ level, project, engine, model, isAdmin, note, lang = DEFAULT_LANG }) {
  const cmd = (key) => t(`help.${key}`, lang);
  const commands = [
    cmd('project'),
    cmd('engine'),
    cmd('model'),
    cmd('new'),
    cmd('sessions'),
    cmd('stop'),
    cmd('close'),
    cmd('language'),
    ...(isAdmin ? [cmd('users'), cmd('active'), cmd('invite')] : []),
  ];
  const rows = [
    `<tg-button-row>${button(t('start.btn.project', lang), 'ui:project')}${button(t('start.btn.new', lang), 'ui:new')}${button(t('start.btn.sessions', lang), 'ui:sessions')}</tg-button-row>`,
    `<tg-button-row>${button(t('start.btn.engine', lang), 'ui:engine')}${button(t('start.btn.model', lang), 'ui:model')}${button(t('start.btn.close', lang), 'ui:close')}</tg-button-row>`,
    `<tg-button-row>${button(t('btn.language', lang), 'ui:language')}</tg-button-row>`,
  ];
  if (isAdmin) rows.push(`<tg-button-row>${button(t('start.btn.users', lang), 'ui:users')}${button(t('start.btn.invite', lang), 'ui:invite')}${button(t('start.btn.active', lang), 'ui:active')}</tg-button-row>`);
  return [
    t('start.title', lang),
    t('start.intro', lang, { engine: escHtml(engine) }),
    t('start.info', lang, { engine: escHtml(engine), model: escHtml(model ?? t('auto', lang)), level: escHtml(level), project }),
    ...rows,
    `<details><summary>${t('start.commands', lang)}</summary>\n\n${commands.map((c) => `- ${c}`).join('\n')}\n\n</details>`,
    ...(note ? [`<footer>${escHtml(note)}</footer>`] : []),
  ].join('\n\n');
}

/** Дата и время для списков сессий на языке пользователя. */
export const localeOf = (lang) => LOCALES[lang] ?? LOCALES[DEFAULT_LANG];

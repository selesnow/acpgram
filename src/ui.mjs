// Оформление сообщений бота в Telegram: ход работы агента, черновик со стримингом, итоговое сообщение, /start.
// Все пользовательские строки — из i18n.mjs; функции получают язык пользователя (по умолчанию — DEFAULT_LANG).
import { DEFAULT_LANG, LOCALES, plural, t } from './i18n.mjs';
import { RICH_LIMIT, balanceMarkdown, escHtml } from './telegram.mjs';
import { splitCode } from './files.mjs';

// Rich-разметка Telegram превращает теги <tg-button> в настоящие кнопки с callback_data — в любом месте текста,
// в любом регистре, и без <tg-button-row>. Текст агента (а в него попадает содержимое файлов и веб-страниц) не должен
// уметь рисовать кнопки бота: иначе нажатие «Продолжить» в ответе могло бы выполнить adm:… от имени администратора.
const TG_TAG = /<(?=\/?tg-)/gi;
const WORD_JOINER = '\u2060';

/**
 * Обезвреживает теги <tg-…> в строке, которая встаёт внутрь кода или готовой разметки: после «<» — невидимый
 * символ (word joiner), тег перестаёт быть тегом, а на вид текст тот же.
 */
export const defuseTgTags = (s) => String(s ?? '').replace(TG_TAG, `<${WORD_JOINER}`);

/**
 * Обезвреживает теги <tg-…> в Markdown от агента. В тексте «<» заменяется на &lt; (Telegram покажет его как «<»).
 * В коде сущности не разбираются, поэтому там — невидимый символ: границы кода бот и Telegram определяют по-разному
 * (блочный тег посреди строчного кода Telegram разбирает как тег), и «код» по мнению бота может оказаться текстом.
 */
export function neutralizeTgTags(md) {
  const src = String(md ?? '');
  if (!/<\/?tg-/i.test(src)) return src; // обычный ответ не трогаем
  return splitCode(src)
    .map(({ code, s }) => (code ? defuseTgTags(s) : s.replace(TG_TAG, '&lt;')))
    .join('');
}

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

/** Инструменты Gemini CLI, Claude Code, Antigravity CLI, Codex и OpenCode: подпись, обычный эмодзи и анимированная иконка. */
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
  // OpenCode (read, edit — по виду действия; glob — как у Gemini CLI)
  bash: T.shell,
  write: T.write,
  patch: T.edit,
  multiedit: T.edit,
  grep: T.grep,
  list: T.folder,
  webfetch: T.fetch,
  websearch: T.web,
  codesearch: T.web,
  todowrite: T.todo,
  todoread: T.todo,
  skill: T.skill,
  task: { label: 'tool.subagent', icon: '🤖', anim: 'tool' },
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

/** Обрезает строку до n символов, в конце «…». */
export const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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
/**
 * Последний заголовок мыслей агента («**Проверяю тесты**») в куске текста и остаток для следующего фрагмента —
 * незаконченная последняя строка (заголовок не переносится на новую строку, поэтому раньше её ничего не нужно).
 * @returns {{title: string|null, rest: string}}
 */
export function lastThoughtTitle(text) {
  let title = null;
  for (const m of text.matchAll(/\*\*([^*\n]+)\*\*/g)) title = m[1].trim();
  return { title, rest: text.slice(text.lastIndexOf('\n') + 1) };
}

const PLAN_SHOWN = 7;

/**
 * План агента (ACP: session/update plan, пункты {content, status}) для черновика: «План: 3/7» и пункты вокруг текущего
 * (не больше PLAN_SHOWN). Пустая строка — плана нет.
 */
export function planBlock(plan, lang = DEFAULT_LANG) {
  const entries = (Array.isArray(plan) ? plan : []).filter((e) => e?.content);
  if (!entries.length) return '';
  const done = entries.filter((e) => e.status === 'completed').length;
  let cur = entries.findIndex((e) => e.status === 'in_progress');
  if (cur < 0) cur = entries.findIndex((e) => e.status !== 'completed');
  if (cur < 0) cur = entries.length - 1;
  const from = Math.max(0, Math.min(cur - 2, entries.length - PLAN_SHOWN));
  const mark = (s) => (s === 'completed' ? '✅' : s === 'in_progress' ? '▶️' : '▫️');
  const lines = entries.slice(from, from + PLAN_SHOWN).map((e) => `- ${mark(e.status)} ${escHtml(trunc(String(e.content).replace(/\s+/g, ' ').trim(), 80))}`);
  return [`**${t('draft.plan', lang, { done, total: entries.length })}**`, ...lines].join('\n');
}

export function composeDraft({ thought = '', steps = [], plan = [], answer = '', elapsedMs = 0, lang = DEFAULT_LANG }) {
  if (answer.trim()) {
    const body = balanceMarkdown(answer.replace(/^\s+/, '')).slice(-RICH_LIMIT);
    const last = steps[steps.length - 1];
    return { markdown: last ? `${stepLine(last, { live: true, lang })}\n\n${body}` : body };
  }
  const planned = planBlock(plan, lang);
  if (!thought && !steps.length && !planned) return { plain: true };

  const parts = [];
  if (thought) parts.push(`<tg-thinking>${anim('thinking', '💭')} ${escHtml(thought)}</tg-thinking>`);
  if (planned) parts.push(planned);
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
const sessionDetails = (s, projectOf, now, lang) =>
  `${s.topic ? `💬 ${s.topic} · ` : ''}${s.engine ? `${s.engine} · ` : ''}${projectOf(s.project)}, ${fmtDuration(now - s.startedAt, lang)}${s.busy ? t('session.busy', lang) : ''}`;

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

export const USAGE_PERIODS = [1, 7, 30];

/**
 * Экран /usage администратора: кто сколько запросов сделал и токенов потратил за период; стоимость — если агент её присылал.
 * @param {{rows: {user_id:number, requests:number, tokens:number, cost:number|null}[], days: number, nameOf: (id:number)=>string, lang?: string}} o
 */
export function usageView({ rows, days, nameOf, lang = DEFAULT_LANG }) {
  const period = t(`usage.d${days}`, lang);
  const line = (name, r) =>
    t('usage.line', lang, { name, requests: plural(r.requests, 'request', lang), tokens: fmtTokens(r.tokens), cost: Number.isFinite(r.cost) && r.cost > 0 ? ` · $${fmtCost(r.cost)}` : '' });
  const total = rows.reduce((s, r) => ({ requests: s.requests + r.requests, tokens: s.tokens + r.tokens, cost: s.cost + (r.cost ?? 0) }), { requests: 0, tokens: 0, cost: 0 });
  const text = rows.length
    ? [t('usage.head', lang, { period }), ...rows.map((r) => `• ${line(nameOf(r.user_id), r)}`), '', line(t('usage.total', lang), total)].join('\n')
    : t('usage.none', lang, { period });
  return {
    text,
    markup: { inline_keyboard: [USAGE_PERIODS.map((d) => ({ text: `${d === days ? '✓ ' : ''}${t(`usage.d${d}`, lang)}`, callback_data: `adm:us:${d}` }))] },
  };
}

// ---------- HTML-экраны (сообщения с parse_mode: 'HTML') ----------

/** Значение параметра, которое вставляется в текст как готовый HTML (остальные параметры th экранирует). */
export const hRaw = (html) => ({ html });
/** Путь, имя, id — моноширинным. */
export const hCode = (s) => hRaw(`<code>${escHtml(s)}</code>`);
/** Главное в строке — жирным. */
export const hBold = (s) => hRaw(`<b>${escHtml(s)}</b>`);

const H_MARK = String.fromCharCode(1); // обрамляет номер вставки, пока текст экранируется
const H_MARK_RE = new RegExp(`${H_MARK}([0-9]+)${H_MARK}`, 'g');

/**
 * Текст i18n для сообщения в HTML: и шаблон, и параметры экранируются; параметры hCode / hBold / hRaw вставляются
 * разметкой. Так путь папки или запрос пользователя с «<» не ломает сообщение и не становится тегом.
 */
export function th(key, lang, params = {}) {
  const marks = [];
  const safe = {};
  for (const [k, v] of Object.entries(params)) {
    if (v && typeof v === 'object' && 'html' in v) {
      safe[k] = `${H_MARK}${marks.length}${H_MARK}`;
      marks.push(v.html);
    } else safe[k] = typeof v === 'string' ? v.replaceAll(H_MARK, '') : v;
  }
  return escHtml(t(key, lang, safe)).replace(H_MARK_RE, (_, i) => marks[Number(i)]);
}

/**
 * Экран /engine: текущий движок и кнопки выбора (eng:<id>). Текст — HTML.
 * @param {{engines: {id:string,label:string}[], current: string, defaultId: string, unavailable?: string[], needLogin?: string[], lang?: string}} o
 *   engines — доступные движки; unavailable — названия движков, которые не запустились на сервере
 */
export function engineMenu({ engines, current, defaultId, unavailable = [], needLogin = [], lang = DEFAULT_LANG }) {
  const cur = engines.find((e) => e.id === current);
  const text = [
    th('engine.current', lang, { engine: hBold(cur?.label ?? current) }),
    '',
    `<i>${th('engine.pick', lang)}</i>`,
    ...(unavailable.length ? ['', th('engine.unavailable', lang, { list: unavailable.join(', ') })] : []),
    ...(needLogin.length ? ['', th('engine.needLogin', lang, { list: engines.filter((e) => needLogin.includes(e.id)).map((e) => e.label).join(', ') })] : []),
  ].join('\n');
  return {
    text,
    markup: {
      inline_keyboard: engines.map((e) => [
        {
          text: `${e.id === current ? '✓ ' : ''}${e.label}${e.id === defaultId ? t('engine.default', lang) : ''}${needLogin.includes(e.id) ? t('engine.needLoginTag', lang) : ''}`,
          callback_data: `eng:${e.id}`,
          ...(e.id === current ? { style: 'primary' } : {}), // текущий движок выделен цветом
        },
      ]),
    },
  };
}

/** callback_data не длиннее 64 байт: длинный id заменяем номером в списке (#3). */
const cbValue = (prefix, id, index) => (Buffer.byteLength(`${prefix}${id}`) <= 64 ? `${prefix}${id}` : `${prefix}#${index}`);

/** Раскладка кнопок по n в ряд. */
const rowsOf = (buttons, n) => Array.from({ length: Math.ceil(buttons.length / n) }, (_, i) => buttons.slice(i * n, i * n + n));

// ---------- группы моделей (движки с modelGroups: OpenCode) ----------

/** Моделей на странице группы (по 2 в ряд). */
export const MODEL_PAGE = 20;
/** id группы бесплатных моделей (id провайдеров — латиница без «+»). */
export const FREE_GROUP = '+free';

/** Входит ли модель в группу. */
export const inModelGroup = (m, group) => (group === FREE_GROUP ? Boolean(m.free) : m.group === group);

/**
 * Группы моделей: сначала «Бесплатные» (если есть), затем провайдеры в порядке каталога. Пусто — моделей без групп.
 * @param {{group?:string, groupLabel?:string, free?:boolean}[]} models
 * @returns {{id:string, label:string|null, count:number}[]}  label null — «Бесплатные» (название на языке пользователя)
 */
export function modelGroupsOf(models) {
  if (!models.some((m) => m.group)) return [];
  const free = models.filter((m) => m.free).length;
  const by = new Map();
  for (const m of models) {
    if (!m.group) continue;
    const g = by.get(m.group) ?? { id: m.group, label: m.groupLabel || m.group, count: 0 };
    g.count++;
    by.set(m.group, g);
  }
  return [...(free ? [{ id: FREE_GROUP, label: null, count: free }] : []), ...by.values()];
}

const groupTitle = (g, lang) => (g.id === FREE_GROUP ? `🆓 ${t('model.freeGroup', lang)}` : g.label);

/** id подгруппы «Прочие»: вендоры с 1–2 моделями (id вендоров — латиница без «+»). */
export const OTHER_SUB = '+other';
/** Вендоров на странице подгрупп. */
const SUB_PAGE = 30;
/** Вендор с таким числом моделей и меньше уходит в «Прочие». */
const SMALL_SUB = 2;

const clampPage = (page, total, size) => {
  const pages = Math.max(1, Math.ceil(total / size));
  return { page: Math.min(Math.max(Number(page) || 0, 0), pages - 1), pages };
};

/**
 * Подгруппы (вендоры) группы-агрегатора — OpenRouter: «openrouter/anthropic/…». Самые большие первыми, вендоры
 * с 1–2 моделями — в «Прочие» (если таких хотя бы два). Пусто — подгрупп нет.
 * @param {{sub?:string, subLabel?:string}[]} list модели группы
 * @returns {{subs: {id:string, label:string|null, count:number}[], small: Set<string>}}  label null — «Прочие»
 */
export function modelSubgroupsOf(list) {
  if (!list.some((m) => m.sub)) return { subs: [], small: new Set() };
  const by = new Map();
  for (const m of list) {
    const id = m.sub ?? OTHER_SUB;
    const s = by.get(id) ?? { id, label: m.subLabel || m.sub || null, count: 0 };
    s.count++;
    by.set(id, s);
  }
  const all = [...by.values()].filter((s) => s.id !== OTHER_SUB);
  const smallList = all.filter((s) => s.count <= SMALL_SUB);
  const small = new Set(smallList.length >= 2 ? smallList.map((s) => s.id) : []);
  const other = (by.get(OTHER_SUB)?.count ?? 0) + smallList.filter((s) => small.has(s.id)).reduce((n, s) => n + s.count, 0);
  const subs = all.filter((s) => !small.has(s.id)).sort((a, b) => b.count - a.count);
  return { subs: [...subs, ...(other ? [{ id: OTHER_SUB, label: null, count: other }] : [])].map((x, index) => ({ ...x, index })), small };
}

const subTitle = (s, lang) => (s.id === OTHER_SUB ? t('model.otherSub', lang) : s.label);

/**
 * Что показать в группе: подгруппы (вендоры, если группа большая и они есть) или модели постранично
 * (с их номером во всём списке — для кнопок с длинным id). sub — открытая подгруппа.
 */
export function browseGroup(models, group, sub = null, page = 0) {
  const inGroup = models.map((m, i) => ({ m, i })).filter(({ m }) => inModelGroup(m, group));
  const { subs, small } = group === FREE_GROUP ? { subs: [], small: new Set() } : modelSubgroupsOf(inGroup.map(({ m }) => m));
  // «#номер» — вендор с длинным id, не поместившимся в callback_data (subRef)
  if (typeof sub === 'string' && sub.startsWith('#')) sub = subs[Number(sub.slice(1))]?.id ?? null;
  if (subs.length > 1 && inGroup.length > MODEL_PAGE && sub == null) {
    const pg = clampPage(page, subs.length, SUB_PAGE);
    return { mode: 'subs', subs: subs.slice(pg.page * SUB_PAGE, (pg.page + 1) * SUB_PAGE), small, total: inGroup.length, ...pg };
  }
  const inSub = (m) => sub == null || (sub === OTHER_SUB ? !m.sub || small.has(m.sub) : m.sub === sub);
  const items = inGroup.filter(({ m }) => inSub(m));
  const pg = clampPage(page, items.length, MODEL_PAGE);
  const subInfo = sub == null ? null : subs.find((s) => s.id === sub) ?? { id: sub, label: sub, count: items.length, index: -1 };
  return { mode: 'models', items: items.slice(pg.page * MODEL_PAGE, (pg.page + 1) * MODEL_PAGE), total: items.length, sub: subInfo, ...pg };
}

/** Ряд навигации ◀ n/m ▶ (пусто, если страница одна). */
function pageNav(page, pages, data) {
  if (pages < 2) return [];
  const r = [];
  if (page > 0) r.push({ text: '◀', callback_data: data(page - 1) });
  r.push({ text: `${page + 1}/${pages}`, callback_data: 'nav:n' });
  if (page < pages - 1) r.push({ text: '▶', callback_data: data(page + 1) });
  return [r];
}

/**
 * Вендор в callback_data: его id или «#номер» среди вендоров группы, если с id кнопка (prefix + вендор + «:страница»)
 * не влезает в 64 байта Telegram.
 */
const subRef = (prefix, s) => (Buffer.byteLength(`${prefix}${s.id}:999`) <= 64 ? s.id : `#${s.index}`);

/**
 * Название модели внутри группы: без провайдера; внутри вендора — и без вендора («Anthropic: Claude…» → «Claude…»),
 * а в «Прочих» — с вендором впереди, иначе непонятно, чья модель; в группе провайдера бесплатные — с 🆓.
 * @param {string|null} sub открытая подгруппа (вендор)
 */
const shortName = (m, group, sub = null) => {
  let name = (group === FREE_GROUP ? m.name : m.short) || m.name;
  if (sub && sub !== OTHER_SUB && m.subLabel && name.startsWith(`${m.subLabel}: `)) name = name.slice(m.subLabel.length + 2);
  if (sub === OTHER_SUB && m.subLabel && !name.startsWith(m.subLabel)) name = `${m.subLabel} · ${name}`;
  return `${group !== FREE_GROUP && m.free ? '🆓 ' : ''}${name}`;
};

/** Кнопки моделей: ✓ у выбранной, callback — mdl:<движок>:m:<id или #номер во всём списке>. */
const modelButtonsOf = (engine, items, model, label) => items.map(({ m, i }) => ({ text: `${m.id === model ? '✓ ' : ''}${label(m)}`, callback_data: cbValue(`mdl:${engine.id}:m:`, m.id, i) }));

/** Поиск моделей: все слова запроса есть в id или названии (без учёта регистра). */
export function searchModels(models, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return models.map((m, i) => ({ m, i })).filter(({ m }) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Экран /model: модели и уровни рассуждений движка. Кнопки: mdl:<движок>:m:<id> / mdl:<движок>:e:<id>, «Авто» — ~.
 * Если у моделей есть группы (OpenCode: сотни моделей подключённых провайдеров) — вместо списка кнопки групп
 * mdl:<движок>:g:<группа>:<страница>, модели — на экране группы (modelGroupMenu).
 * @param {{engine: {id:string,label:string}, models: {id,name}[], efforts: {id,name}[], model: string|null, effort: string|null,
 *   restricted?: boolean, lang?: string}} o  model/effort — текущий выбор (null — «Авто»); restricted — модели ограничены администратором (без «Авто»)
 */
export function modelMenu({ engine, models, efforts = [], model, effort, restricted = false, recent = [], lang = DEFAULT_LANG }) {
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  const auto = t('auto', lang);
  const groups = modelGroupsOf(models);
  const text = [
    t('model.title', lang, { engine: engine.label }),
    t('model.now', lang, { name: model ? nameOf(models, model) : t('model.autoDesc', lang) }),
    ...(efforts.length ? [t('model.effort', lang, { name: effort ? nameOf(efforts, effort) : auto })] : []),
    ...(restricted ? [t('model.restricted', lang)] : []),
    ...(groups.length ? [t('model.pickGroup', lang), t('model.searchHint', lang)] : []),
    t('model.saved', lang),
  ].join('\n');
  const mark = (on, label) => `${on ? '✓ ' : ''}${label}`;
  const current = models.find((m) => m.id === model);
  // недавние модели (движки с группами): переключиться между любимыми — в одно нажатие
  const recentItems = groups.length ? recent.map((id) => ({ m: models.find((x) => x.id === id), i: models.findIndex((x) => x.id === id) })).filter(({ m }) => m) : [];
  const recentButtons = modelButtonsOf(engine, recentItems, model, (m) => `🕘 ${m.name}`);
  const modelButtons = [
    ...(restricted ? [] : [{ text: mark(!model, auto), callback_data: `mdl:${engine.id}:m:~` }]),
    ...(groups.length
      ? groups.map((g) => ({ text: mark(Boolean(current) && inModelGroup(current, g.id), `${groupTitle(g, lang)} (${g.count})`), callback_data: `mdl:${engine.id}:g:${g.id}:0` }))
      : models.map((m, i) => ({ text: mark(m.id === model, m.name), callback_data: cbValue(`mdl:${engine.id}:m:`, m.id, i) }))),
  ];
  const effortButtons = efforts.length
    ? [{ text: mark(!effort, `🧠 ${auto}`), callback_data: `mdl:${engine.id}:e:~` }, ...efforts.map((x, i) => ({ text: mark(x.id === effort, `🧠 ${x.name}`), callback_data: cbValue(`mdl:${engine.id}:e:`, x.id, i) }))]
    : [];
  return { text, markup: { inline_keyboard: [...rowsOf(recentButtons, 2), ...rowsOf(modelButtons, 2), ...rowsOf(effortButtons, 3)] } };
}

/**
 * Экран группы моделей в /model. Большая группа с вендорами (OpenRouter) — сначала вендоры (mdl:<движок>:s:<группа>:<вендор>:0),
 * иначе модели постранично (mdl:<движок>:m:<id>). Навигация — mdl:<движок>:g:<группа>:<стр> или mdl:<движок>:s:…:<стр>;
 * «Назад» из вендора — к вендорам группы, из группы — к группам (mdl:<движок>:g:~). У бесплатных — предупреждение о данных.
 */
export function modelGroupMenu({ engine, models, group, sub = null, page = 0, model, lang = DEFAULT_LANG }) {
  const g = modelGroupsOf(models).find((x) => x.id === group);
  const v = browseGroup(models, group, sub, page);
  const nameOf = (id) => models.find((x) => x.id === id)?.name ?? id;
  const title = `${g ? groupTitle(g, lang) : group}${v.sub ? ` › ${subTitle(v.sub, lang)}` : ''}: ${v.total}`;
  const text = [
    t('model.title', lang, { engine: engine.label }),
    t('model.now', lang, { name: model ? nameOf(model) : t('model.autoDesc', lang) }),
    '',
    title,
    ...(group === FREE_GROUP ? [t('model.freeNote', lang)] : []),
    ...(v.mode === 'subs' ? [t('model.pickSub', lang)] : []),
  ].join('\n');
  const current = models.find((m) => m.id === model);
  const buttons =
    v.mode === 'subs'
      ? v.subs.map((s) => ({ text: `${current && inModelGroup(current, group) && (!current.sub || v.small.has(current.sub) ? OTHER_SUB : current.sub) === s.id ? '✓ ' : ''}${subTitle(s, lang)} (${s.count})`, callback_data: `mdl:${engine.id}:s:${group}:${subRef(`mdl:${engine.id}:s:${group}:`, s)}:0` }))
      : modelButtonsOf(engine, v.items, model, (m) => shortName(m, group, v.sub?.id ?? null));
  const nav = v.mode === 'models' && v.sub ? (p) => `mdl:${engine.id}:s:${group}:${subRef(`mdl:${engine.id}:s:${group}:`, v.sub)}:${p}` : (p) => `mdl:${engine.id}:g:${group}:${p}`;
  return {
    text,
    markup: {
      inline_keyboard: [
        ...rowsOf(buttons, 2),
        ...pageNav(v.page, v.pages, nav),
        [{ text: t('btn.back', lang), callback_data: v.sub ? `mdl:${engine.id}:g:${group}:0` : `mdl:${engine.id}:g:~` }],
      ],
    },
  };
}

/** Результаты поиска /model <запрос>: до MODEL_PAGE моделей кнопками и «К группам» (mdl:<движок>:g:~). */
export function modelSearchMenu({ engine, models, query, model, lang = DEFAULT_LANG }) {
  const found = searchModels(models, query);
  const shown = found.slice(0, MODEL_PAGE);
  const text = [
    t('model.title', lang, { engine: engine.label }),
    found.length ? t('model.found', lang, { q: query, n: found.length }) : t('model.notFound', lang, { q: query }),
    ...(found.length > shown.length ? [t('model.foundMore', lang, { n: shown.length })] : []),
  ].join('\n');
  return {
    text,
    markup: { inline_keyboard: [...rowsOf(modelButtonsOf(engine, shown, model, (m) => `${m.free ? '🆓 ' : ''}${m.name}`), 1), [{ text: t('model.toGroups', lang), callback_data: `mdl:${engine.id}:g:~` }]] },
  };
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
export function modelGrantsView({ userId, name, engine, models, allowed, group = null, sub = null, page = 0, lang = DEFAULT_LANG }) {
  const on = (id) => allowed == null || allowed.includes(id);
  const groups = modelGroupsOf(models);
  const inGroup = groups.length && group != null && groups.some((g) => g.id === group);
  const text = [
    t('adm.engineModelsTitle', lang, { engine: engine.label, name }),
    allowed == null ? t('adm.modelsAllAllowed', lang) : t('adm.modelsSome', lang, { a: allowed.length, t: models.length }),
    groups.length && !inGroup ? t('adm.modelsPickGroup', lang) : t('adm.modelsHint', lang),
  ].join('\n');
  const v = inGroup ? browseGroup(models, group, sub, page) : null;
  // из вендора — к вендорам группы, из группы — к списку групп движка, из списка — к движкам
  const back = v?.sub ? `adm:mg:${userId}:${engine.id}:${group}:0` : inGroup ? `adm:me:${userId}:${engine.id}` : `adm:mm:${userId}`;
  const footer = [
    ...(allowed == null ? [] : [[{ text: t('adm.allowAllBtn', lang), callback_data: `adm:ma:${userId}:${engine.id}` }]]),
    [{ text: t('btn.back', lang), callback_data: back }],
  ];
  if (groups.length && !inGroup) {
    // моделей много: сначала группы (у каждой — сколько разрешено), переключатели — внутри группы
    const buttons = groups.map((g) => {
      const list = models.filter((m) => inModelGroup(m, g.id));
      const n = list.filter((m) => on(m.id)).length;
      return { text: `${groupTitle(g, lang)} ${n}/${list.length}`, callback_data: `adm:mg:${userId}:${engine.id}:${g.id}:0` };
    });
    return { text, markup: { inline_keyboard: [...rowsOf(buttons, 2), ...footer] } };
  }
  // id модели, а не номер: если список моделей изменится, кнопка не переключит чужую модель
  const toggle = (m, i, label) => ({ text: `${on(m.id) ? '✅' : '⬜'} ${label}`, callback_data: cbValue(`adm:mt:${userId}:${engine.id}:`, m.id, i) });
  if (inGroup) {
    const title = `${groupTitle(groups.find((g) => g.id === group), lang)}${v.sub ? ` › ${subTitle(v.sub, lang)}` : ''}`;
    if (v.mode === 'subs') {
      // вендоры группы (OpenRouter): у каждого — сколько разрешено
      const inGroupModels = models.filter((m) => inModelGroup(m, group));
      const { small } = modelSubgroupsOf(inGroupModels);
      const ofSub = (s) => inGroupModels.filter((m) => (s.id === OTHER_SUB ? !m.sub || small.has(m.sub) : m.sub === s.id));
      const buttons = v.subs.map((s) => {
        const list = ofSub(s);
        return { text: `${subTitle(s, lang)} ${list.filter((m) => on(m.id)).length}/${list.length}`, callback_data: `adm:ms:${userId}:${engine.id}:${group}:${subRef(`adm:ms:${userId}:${engine.id}:${group}:`, s)}:0` };
      });
      return {
        text: `${text}\n\n${title}`,
        markup: { inline_keyboard: [...rowsOf(buttons, 2), ...pageNav(v.page, v.pages, (p) => `adm:mg:${userId}:${engine.id}:${group}:${p}`), ...footer] },
      };
    }
    const toggles = v.items.map(({ m, i }) => toggle(m, i, shortName(m, group, v.sub?.id ?? null)));
    const nav = v.sub ? (p) => `adm:ms:${userId}:${engine.id}:${group}:${subRef(`adm:ms:${userId}:${engine.id}:${group}:`, v.sub)}:${p}` : (p) => `adm:mg:${userId}:${engine.id}:${group}:${p}`;
    return {
      text: `${text}\n\n${title}`,
      markup: { inline_keyboard: [...rowsOf(toggles, 2), ...pageNav(v.page, v.pages, nav), ...footer] },
    };
  }
  const toggles = models.map((m, i) => toggle(m, i, m.name));
  return { text, markup: { inline_keyboard: [...rowsOf(toggles, 2), ...footer] } };
}

const button = (text, data) => `<tg-button type="callback_data" data="${data}">${text}</tg-button>`;

/**
 * Экран /start: rich-сообщение с кнопками. Кнопки присылают callback_data ui:<команда>.
 * @param {{level: string, project: string, engine: string, model?: string, isAdmin: boolean, note?: string, lang?: string}} o
 *   level, engine, model — уже переведённые названия (уровень доступа, движок, модель; по умолчанию «Авто»)
 */
export function startView({ level, project, engine, model, isAdmin, note, topics = null, lang = DEFAULT_LANG }) {
  const cmd = (key) => t(`help.${key}`, lang);
  const commands = [
    cmd('project'),
    cmd('engine'),
    cmd('model'),
    cmd('new'),
    cmd('sessions'),
    cmd('stop'),
    cmd('close'),
    ...(topics ? [cmd('topics')] : []),
    cmd('language'),
    ...(isAdmin ? [cmd('users'), cmd('active'), cmd('invite'), cmd('usage')] : []),
  ];
  const rows = [
    `<tg-button-row>${button(t('start.btn.project', lang), 'ui:project')}${button(t('start.btn.new', lang), 'ui:new')}${button(t('start.btn.sessions', lang), 'ui:sessions')}</tg-button-row>`,
    `<tg-button-row>${button(t('start.btn.engine', lang), 'ui:engine')}${button(t('start.btn.model', lang), 'ui:model')}${button(t('start.btn.close', lang), 'ui:close')}</tg-button-row>`,
    // topics: 'on' | 'off' — режим «диалоги» (если у бота включены темы), null — кнопки нет
    `<tg-button-row>${button(t('btn.language', lang), 'ui:language')}${topics ? button(t(topics === 'on' ? 'start.btn.topicsOn' : 'start.btn.topicsOff', lang), 'ui:topics') : ''}</tg-button-row>`,
  ];
  if (isAdmin) rows.push(`<tg-button-row>${button(t('start.btn.users', lang), 'ui:users')}${button(t('start.btn.invite', lang), 'ui:invite')}${button(t('start.btn.active', lang), 'ui:active')}</tg-button-row>`);
  return [
    t('start.title', lang),
    t('start.intro', lang, { engine: escHtml(engine) }),
    t('start.info', lang, { engine: escHtml(engine), model: escHtml(model ?? t('auto', lang)), level: escHtml(level), project: defuseTgTags(project) }), // путь — внутри кода
    ...(topics === 'on' ? [t('start.topics', lang)] : []),
    ...rows,
    `<details><summary>${t('start.commands', lang)}</summary>\n\n${commands.map((c) => `- ${c}`).join('\n')}\n\n</details>`,
    ...(note ? [`<footer>${escHtml(note)}</footer>`] : []),
  ].join('\n\n');
}

/** Дата и время для списков сессий на языке пользователя. */
export const localeOf = (lang) => LOCALES[lang] ?? LOCALES[DEFAULT_LANG];

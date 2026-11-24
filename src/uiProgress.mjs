import { DEFAULT_LANG, plural, t } from './i18n.mjs';
import { RICH_LIMIT, balanceMarkdown, escHtml } from './telegram.mjs';
import { fmtDuration, skillName, trunc } from './uiShared.mjs';

/**
 * Анимированные иконки в черновике. Отключаются ANIMATED_ICONS=0 — например, если клиент Telegram
 * показывает вместо них 🙂 (в постоянных сообщениях бота без username с Fragment так и происходит).
 */
const ANIMATED = process.env.ANIMATED_ICONS !== '0';

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
const anim = (key, fallback) => (ANIMATED && ANIM[key] ? `<tg-emoji emoji-id="${ANIM[key]}">${fallback}</tg-emoji>` : fallback);

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

const MAX_STEPS_SHOWN = 5;
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

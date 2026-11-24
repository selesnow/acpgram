// Разбор событий tool_call / tool_call_update от ACP-агента. Оформление шагов — в ui.mjs.
import { DEFAULT_ENGINE, getEngine } from './engines.mjs';

/** Текст из content[] обновления. */
function contentText(u) {
  return (u.content || [])
    .map((c) => (c?.type === 'content' && c.content?.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Что агент собирается изменить в файле: блок diff из content[] (ACP) или поля правки Claude Code (old_string / new_string).
 * @returns {{path: string|null, oldText: string, newText: string}|null}
 */
export function diffOf(u) {
  const d = (u?.content || []).find((c) => c?.type === 'diff');
  if (d) return { path: d.path ?? null, oldText: d.oldText ?? '', newText: d.newText ?? '' };
  const r = u?.rawInput;
  if (r && typeof r.new_string === 'string') return { path: r.file_path ?? null, oldText: String(r.old_string ?? ''), newText: r.new_string };
  return null;
}

/** Описание действия: для команд — то, что агент сам написал в скобках, иначе весь текст. */
function describe(text) {
  const t = text.replace(/^\[current working directory [^\]]*\]\s*/i, '').trim();
  const m = /^\((.*)\)$/s.exec(t);
  return (m ? m[1] : t).trim();
}

/** @returns {{toolCallId:string, tool:string, kind:string|null, title:string|null, description:string, output:string, status:string|null}} */
export function parseTool(u, engine = getEngine(DEFAULT_ENGINE)) {
  const toolCallId = u.toolCallId || '';
  const tool = engine.toolName(u);
  const text = contentText(u);
  // Описание действия приходит только с начальным вызовом; в событии завершения content — это результат или ошибка
  const initial = !u.status || u.status === 'in_progress' || u.status === 'pending';
  const isDescription = u.kind === 'execute' && initial;
  // Claude Code и Antigravity присылают описание отдельным полем (rawInput.description / toolSummary)
  const own = engine.toolDescription?.(u) || '';
  return {
    toolCallId,
    tool,
    kind: u.kind ?? null,
    title: u.title ?? null,
    description: own || (isDescription ? describe(text) : ''),
    output: isDescription || (own && text.trim() === own) ? '' : text,
    status: u.status ?? null,
  };
}

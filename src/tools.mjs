// Разбор событий tool_call / tool_call_update от ACP-агента. Оформление шагов — в ui.mjs.
import { DEFAULT_ENGINE, getEngine } from './engines.mjs';

/** Текст из content[] обновления. */
export function contentText(u) {
  return (u.content || [])
    .map((c) => (c?.type === 'content' && c.content?.type === 'text' ? c.content.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** Описание действия: для команд — то, что агент сам написал в скобках, иначе весь текст. */
function describe(kind, text) {
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
    description: own || (isDescription ? describe(u.kind, text) : ''),
    output: isDescription || (own && text.trim() === own) ? '' : text,
    status: u.status ?? null,
  };
}

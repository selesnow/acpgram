import { splitCode } from './files.mjs';

export const SEND_MARK = /\[\[send:([^\]\r\n]+)\]\]/g;
export const ASK_MARK = /\[\[ask:([^\]\r\n]*)\]\]/gi;
export const GIT_MARK = /\[\[git:(push|pull)\]\]/gi;
export const TITLE_MARK = /\[\[title:([^\]\r\n]*)\]\][ \t]*\r?\n?/i;
export const TOPIC_MARK = /\[\[topic:([^\]\r\n]*)\]\][ \t]*\r?\n?/gi;

export const SEND_DRAFT = { mark: /\[\[send:[^\]\r\n]*(?:\]\]?)?/g, tail: /\[{1,2}(?:s(?:e(?:n(?:d)?)?)?)?$/ };
export const ASK_DRAFT = { mark: /\[\[ask:[^\]\r\n]*(?:\]\]?)?/gi, tail: /\[{1,2}(?:a(?:s(?:k)?)?)?$/i };
export const GIT_DRAFT = { mark: GIT_MARK, tail: /\[\[g(?:i(?:t(?::(?:p(?:u(?:s(?:h(?:\]\]?)?)?|l(?:l(?:\]\]?)?)?)?)?)?)?)?)?$/i };
export const TITLE_HEAD = /^\[(\[(t(i(t(l(e(:[^\]\r\n]*(\](\])?)?)?)?)?)?)?)?)?$/i;
export const TOPIC_DRAFT = { mark: /\[\[topic:[^\]\r\n]*(?:\]\]?)?/gi, tail: /\[{1,2}(?:t(?:o(?:p(?:i(?:c(?::[^\]\r\n]*)?)?)?)?)?)?$/i };

export const markPlaceholder = (char, i) => `${char}${i}${char}`;

export function extractAgentMarks(text, { present, mark, state, onMatch, tidy = (s) => s, tidyOnlyOnMatch = false, finish = (s) => s }) {
  const src = String(text ?? '');
  if (present && !present(src)) return { ...state, text: src };
  const probe = new RegExp(mark.source, mark.flags.replace('g', ''));
  const out = splitCode(src)
    .map(({ code, s }) => {
      if (code) return s;
      const hit = probe.test(s);
      const replaced = hit ? s.replace(mark, (...args) => onMatch(state, ...args)) : s;
      return hit || !tidyOnlyOnMatch ? tidy(replaced) : replaced;
    })
    .join('');
  return { ...state, text: finish(out) };
}

export function stripAgentMarks(text, { mark, tail = null, present, finish = (s) => s }) {
  const src = String(text ?? '');
  if (present && !present(src)) return src;
  const parts = splitCode(src);
  const out = parts
    .map(({ code, s }, i) => {
      if (code) return s;
      const r = s.replace(mark, '');
      return i === parts.length - 1 && tail ? r.replace(tail, '') : r;
    })
    .join('');
  return finish(out);
}

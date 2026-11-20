// Метки агента [[git:push]] и [[git:pull]]: у агента нет входа на сервер Git, поэтому отправить или получить изменения
// он просит бота. Бот убирает метку из ответа и показывает под ним кнопку — без нажатия пользователя ничего не уходит.
import { splitCode } from './files.mjs';

const MARK = /\[\[git:(push|pull)\]\]/gi;
/** После вырезанной метки: пробелы в конце строки и двойные пробелы внутри неё. */
const tidy = (s) => s.replace(/[ \t]+(\r?\n)/g, '$1').replace(/([^ \n]) {2,}/g, '$1 ');

/**
 * Достаёт из ответа агента метки [[git:push]] и [[git:pull]] (вне кода) и убирает их из текста.
 * @returns {{text: string, actions: ('push'|'pull')[]}} actions — без повторов, в порядке появления
 */
export function extractGitMarks(text) {
  const src = String(text ?? '');
  if (!/\[\[git:/i.test(src)) return { text: src, actions: [] };
  const actions = [];
  const out = splitCode(src)
    .map(({ code, s }) => {
      if (code) return s;
      return tidy(
        s.replace(MARK, (_, a) => {
          const action = a.toLowerCase();
          if (!actions.includes(action)) actions.push(action);
          return '';
        }),
      );
    })
    .join('');
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), actions };
}

/** Для черновика: убирает целые метки и ещё не дописанную в конце («[[git:pu», «[[gi»). Код не трогает. */
export function stripGitMarks(text) {
  const parts = splitCode(String(text ?? ''));
  return parts
    .map(({ code, s }, i) => {
      if (code) return s;
      const r = s.replace(MARK, '');
      return i === parts.length - 1 ? r.replace(/\[\[g(?:i(?:t(?::(?:p(?:u(?:s(?:h(?:\]\]?)?)?|l(?:l(?:\]\]?)?)?)?)?)?)?)?)?$/i, '') : r;
    })
    .join('');
}

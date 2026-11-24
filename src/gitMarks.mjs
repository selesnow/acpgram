// Метки агента [[git:push]] и [[git:pull]]: у агента нет входа на сервер Git, поэтому отправить или получить изменения
// он просит бота. Бот убирает метку из ответа и показывает под ним кнопку — без нажатия пользователя ничего не уходит.
import { GIT_DRAFT, GIT_MARK, extractAgentMarks, stripAgentMarks } from './agentMarks.mjs';

const tidy = (s) => s.replace(/[ \t]+(\r?\n)/g, '$1').replace(/([^ \n]) {2,}/g, '$1 ');

/**
 * Достаёт из ответа агента метки [[git:push]] и [[git:pull]] (вне кода) и убирает их из текста.
 * @returns {{text: string, actions: ('push'|'pull')[]}} actions — без повторов, в порядке появления
 */
export function extractGitMarks(text) {
  const actions = [];
  return extractAgentMarks(text, {
    present: (s) => /\[\[git:/i.test(s),
    mark: GIT_MARK,
    state: { actions },
    onMatch: ({ actions: found }, _, a) => {
      const action = a.toLowerCase();
      if (!found.includes(action)) found.push(action);
      return '';
    },
    tidy,
    finish: (s) => s.replace(/\n{3,}/g, '\n\n').trim(),
  });
}

/** Для черновика: убирает целые метки и ещё не дописанную в конце («[[git:pu», «[[gi»). Код не трогает. */
export const stripGitMarks = (text) => stripAgentMarks(text, GIT_DRAFT);

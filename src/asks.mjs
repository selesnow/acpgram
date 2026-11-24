// Кнопки быстрого ответа от агента. Агент не может рисовать кнопки сам (теги <tg-button> в его тексте обезвреживаются,
// ui.neutralizeTgTags): он пишет метку [[ask: Вариант А | Вариант Б]], а кнопки строит бот. Нажатие отправляет текст
// варианта агенту как следующее сообщение пользователя — ничего, кроме этого, такая кнопка сделать не может.
import { escHtml } from './telegram.mjs';
import { ASK_DRAFT, ASK_MARK, extractAgentMarks, markPlaceholder, stripAgentMarks } from './agentMarks.mjs';
import { createKeyRegistry } from './keyRegistry.mjs';

/** Сколько вариантов в одной метке и меток в одном ответе; длина подписи кнопки. */
export const MAX_OPTIONS = 6;
export const MAX_ASKS = 3;
export const MAX_LABEL = 48;
/** Сколько наборов вариантов помнит диалог (кнопки более старых ответов — «устарели»). */
const KEEP_ASKS = 20;

/** Подсказка агенту (служебный текст — на английском), уходит вместе с подсказкой об отправке файлов. */
export const ASK_NOTE =
  '[AcpGram] To offer the user quick-reply buttons, put [[ask: Option A | Option B]] on its own line in your reply ' +
  `(2-${MAX_OPTIONS} short options, in the language of the conversation). A tap sends the option text as the user's next message. ` +
  'Use it when you ask the user to choose or confirm something; do not add it to every reply.';

/** Заглушка на месте метки: туда встанут кнопки. Символ \u0001 в ответе агента не встречается. */
// eslint-disable-next-line no-control-regex -- \u0001 — служебная метка места кнопок в тексте ответа
export const ASK_PLACEHOLDER = /\u0001(\d+)\u0001/g;

const cleanOption = (s) => {
  const one = s.replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL - 1).join('')}…` : one;
};

/**
 * Достаёт из ответа агента метки [[ask: …]] (вне кода): на их месте остаются заглушки, варианты возвращаются списком.
 * Метка без вариантов или сверх MAX_ASKS просто убирается.
 * @returns {{text: string, asks: string[][]}}
 */
export function extractAsks(text) {
  const asks = [];
  return extractAgentMarks(text, {
    present: (s) => /\[\[ask:/i.test(s),
    mark: ASK_MARK,
    state: { asks },
    onMatch: ({ asks: found }, _, body) => {
      const options = [...new Set(body.split('|').map(cleanOption).filter(Boolean))].slice(0, MAX_OPTIONS);
      if (!options.length || found.length >= MAX_ASKS) return '';
      found.push(options);
      return markPlaceholder('\u0001', found.length - 1);
    },
  });
}

/** Для черновика: убирает метки, в том числе ещё не дописанные в потоке («[[ask: Да | Н», «[[as»). Код не трогает. */
export function stripAskMarks(text) {
  return stripAgentMarks(text, { ...ASK_DRAFT, present: (s) => s.includes('[') });
}

/**
 * Разметка кнопок набора вариантов: callback_data — ask:<id набора>:<номер варианта>, текст варианта в неё не попадает.
 * Короткие варианты — до трёх в ряд, длинные — по одному.
 */
export function askButtons(id, options) {
  const perRow = options.every((o) => [...o].length <= 16) ? 3 : 1;
  const rows = [];
  for (let i = 0; i < options.length; i += perRow) {
    const buttons = options.slice(i, i + perRow).map((o, k) => `<tg-button type="callback_data" data="ask:${id}:${i + k}">${escHtml(o)}</tg-button>`);
    rows.push(`<tg-button-row>${buttons.join('')}</tg-button-row>`);
  }
  return rows.join('\n');
}

const askKeys = createKeyRegistry({ scope: 'state', field: 'asks', limit: KEEP_ASKS, eviction: 'oldest' });

/**
 * Ставит кнопки на место заглушек и запоминает варианты в диалоге (st.asks: id → варианты).
 * @param {{asks?: Map<number, string[]>}} st состояние диалога
 */
export function placeAsks(st, text, asks) {
  if (!asks.length) return String(text ?? '').replace(ASK_PLACEHOLDER, '');
  const out = String(text ?? '').replace(ASK_PLACEHOLDER, (_, n) => {
    const options = asks[Number(n)];
    if (!options) return '';
    const id = askKeys.add(options, st);
    return `\n\n${askButtons(id, options)}\n\n`;
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Текст варианта по данным кнопки (ask:<id>:<номер>) или null, если кнопка устарела. */
export function askChoice(st, data) {
  const m = /^ask:(\d+):(\d+)$/.exec(data || '');
  return (m && askKeys.get(m[1], st)?.[Number(m[2])]) || null;
}

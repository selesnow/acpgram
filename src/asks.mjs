// Кнопки быстрого ответа от агента. Агент не может рисовать кнопки сам (теги <tg-button> в его тексте обезвреживаются,
// ui.neutralizeTgTags): он пишет метку [[ask: Вариант А | Вариант Б]], а кнопки строит бот. Нажатие отправляет текст
// варианта агенту как следующее сообщение пользователя — ничего, кроме этого, такая кнопка сделать не может.
import { splitCode } from './files.mjs';
import { escHtml } from './telegram.mjs';

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

const MARK = /\[\[ask:([^\]\r\n]*)\]\]/gi;

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
  const src = String(text ?? '');
  if (!/\[\[ask:/i.test(src)) return { text: src, asks: [] };
  const asks = [];
  const out = splitCode(src)
    .map(({ code, s }) => {
      if (code) return s;
      return s.replace(MARK, (_, body) => {
        const options = [...new Set(body.split('|').map(cleanOption).filter(Boolean))].slice(0, MAX_OPTIONS);
        if (!options.length || asks.length >= MAX_ASKS) return '';
        asks.push(options);
        return `\u0001${asks.length - 1}\u0001`;
      });
    })
    .join('');
  return { text: out, asks };
}

/** Для черновика: убирает метки, в том числе ещё не дописанные в потоке («[[ask: Да | Н», «[[as»). Код не трогает. */
export function stripAskMarks(text) {
  const src = String(text ?? '');
  if (!src.includes('[')) return src;
  const parts = splitCode(src);
  return parts
    .map(({ code, s }, i) => {
      if (code) return s;
      const r = s.replace(/\[\[ask:[^\]\r\n]*(?:\]\]?)?/gi, '');
      return i === parts.length - 1 ? r.replace(/\[{1,2}(?:a(?:s(?:k)?)?)?$/i, '') : r;
    })
    .join('');
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

let askSeq = 0;

/**
 * Ставит кнопки на место заглушек и запоминает варианты в диалоге (st.asks: id → варианты).
 * @param {{asks?: Map<number, string[]>}} st состояние диалога
 */
export function placeAsks(st, text, asks) {
  if (!asks.length) return String(text ?? '').replace(ASK_PLACEHOLDER, '');
  st.asks ??= new Map();
  const out = String(text ?? '').replace(ASK_PLACEHOLDER, (_, n) => {
    const options = asks[Number(n)];
    if (!options) return '';
    const id = ++askSeq;
    st.asks.set(id, options);
    return `\n\n${askButtons(id, options)}\n\n`;
  });
  while (st.asks.size > KEEP_ASKS) st.asks.delete(st.asks.keys().next().value);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Текст варианта по данным кнопки (ask:<id>:<номер>) или null, если кнопка устарела. */
export function askChoice(st, data) {
  const m = /^ask:(\d+):(\d+)$/.exec(data || '');
  return (m && st.asks?.get(Number(m[1]))?.[Number(m[2])]) || null;
}

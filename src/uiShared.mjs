import { DEFAULT_LANG, t } from './i18n.mjs';
import { splitCode } from './files.mjs';
import { escHtml } from './telegram.mjs';

export const DOCS_URL = 'https://alexey-seleznev.pro/acpgram/docs/';

export const helpMarkup = (lang = DEFAULT_LANG) => ({
  inline_keyboard: [[{ text: t('help.btn.browser', lang), url: DOCS_URL }, { text: t('help.btn.app', lang), web_app: { url: DOCS_URL } }]],
});

export const docsMenuButton = () => ({ type: 'web_app', text: '📖 Docs', web_app: { url: DOCS_URL } });

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

/** callback_data не длиннее 64 байт: длинный id заменяем номером в списке (#3). */
export const cbValue = (prefix, id, index) => (Buffer.byteLength(`${prefix}${id}`) <= 64 ? `${prefix}${id}` : `${prefix}#${index}`);

/** Раскладка кнопок по n в ряд. */
export const rowsOf = (buttons, n) => Array.from({ length: Math.ceil(buttons.length / n) }, (_, i) => buttons.slice(i * n, i * n + n));

// Темы в личном чате с ботом (Bot API 9.3+): в режиме «диалоги» каждая тема — отдельный диалог с агентом.
// Здесь — работа с темами в Telegram и название темы от агента; состояние диалогов — в state.mjs.
import { tg } from './telegram.mjs';
import { TITLE_HEAD, TITLE_MARK, extractAgentMarks } from './agentMarks.mjs';

/** Название темы в Telegram: 1–128 символов. */
const NAME_MAX = 128;
/** Своё название темы — коротким: длинное обрезается в списке тем. */
const TITLE_MAX = 60;

/** Длина короткого имени проекта в названии темы. */
const PROJECT_LABEL_MAX = 16;

/**
 * Короткое имя проекта для названия темы («rpup_reports · Отчёт по списаниям»): последняя папка пути,
 * длинное — обрезается с «…». Корень диска — сам путь.
 */
export function projectLabel(path) {
  const p = String(path ?? '').replace(/[\\/]+$/, '');
  const name = p.split(/[\\/]/).pop() || String(path ?? '');
  const chars = [...name];
  return chars.length > PROJECT_LABEL_MAX ? `${chars.slice(0, PROJECT_LABEL_MAX - 1).join('')}…` : name;
}

/** Название темы с проектом: «проект · название». */
export const topicName = (project, title) => (project ? `${projectLabel(project)} · ${title}` : title);

/** Ссылка, открывающая тему в личном чате с ботом (только для этого пользователя, Bot API 10.4). */
export const topicLink = (botUsername, threadId) => (botUsername && threadId ? `https://t.me/${botUsername}/${threadId}` : null);

/** Чистит название: одна строка, без кавычек и markdown по краям, не длиннее TITLE_MAX. */
export function cleanTitle(s) {
  const one = String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'«»“”„]+|["'«»“”„.]+$/g, '')
    .trim();
  const chars = [...one]; // по символам, а не UTF-16: половинка эмодзи сделала бы название невалидным
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…` : one;
}

/** Запасное название из текста запроса — первые слова (если агент своего не дал). */
export function titleFromRequest(text) {
  const words = cleanTitle(text).split(' ').filter(Boolean);
  let out = '';
  for (const w of words) {
    if ([...`${out} ${w}`.trim()].length > 40) break;
    out = `${out} ${w}`.trim();
  }
  return out || cleanTitle(text);
}

/**
 * Подсказка агенту в первом запросе новой темы: начать ответ строкой с названием. Строку бот убирает из ответа
 * и называет так тему. Служебный текст для агента — на английском.
 */
export const TITLE_NOTE =
  '[AcpGram] This conversation is a separate topic in the Telegram chat. Start your reply with one line ' +
  '[[title: <short topic title, 2-5 words, in the language of the user\'s message, no emoji>]] — it becomes the topic name ' +
  'and is hidden from the user. Do it only in this reply.';

/** Достаёт из ответа агента название темы (метка вне кода) и убирает метку из текста. */
export function extractTitle(text) {
  const state = { title: null };
  return extractAgentMarks(text, {
    present: (s) => /\[\[title:/i.test(s),
    mark: TITLE_MARK,
    state,
    onMatch: (s, full, t) => {
      if (s.title != null) return full;
      s.title = cleanTitle(t) || null;
      return '';
    },
    finish: (s) => s.replace(/^\s+/, ''),
  });
}

/** Для черновика: убирает метку названия, в том числе ещё не дописанную в начале ответа («[[tit», «[[title: Отч»). */
export function stripTitle(text) {
  const s = String(text ?? '');
  const head = s.replace(/^\s+/, '');
  if (TITLE_HEAD.test(head)) return ''; // начало метки ещё пишется
  return extractTitle(s).text;
}

/** Имя команды бота из текста («/model@bot arg» → «model») или null. */
export const commandName = (text) => /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(String(text ?? ''))?.[1]?.toLowerCase() ?? null;

/**
 * Служебная команда, ради которой Telegram сам создал тему: пользователь отправил её из общего вида чата, а не изнутри
 * темы, и Telegram (если пользователям разрешено создавать темы) завёл новую тему с названием по тексту сообщения.
 * Признаки: тема боту ещё не известна, название дано неявно (is_name_implicit) и это известная боту команда.
 * @param {object} msg сообщение из темы
 * @param {boolean} known тема уже была известна боту до этого сообщения
 * @param {Set<string>} commands команды бота
 */
export function isAutoTopicCommand(msg, known, commands) {
  if (known || !msg?.text) return false;
  const name = commandName(msg.text);
  if (!name || !commands.has(name)) return false;
  return Boolean(topicInfoOf(msg)?.implicit);
}

/** Удаляет тему в личном чате вместе с сообщениями (Bot API 9.4). */
export const deleteTopic = (chatId, threadId) => tg('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId });

/** Создаёт тему в личном чате с пользователем (Bot API 9.4). Возвращает message_thread_id. */
export async function createTopic(chatId, name) {
  const r = await tg('createForumTopic', { chat_id: chatId, name: [...String(name)].slice(0, NAME_MAX).join('') });
  return r.message_thread_id;
}

/** Переименовывает тему. */
export const renameTopic = (chatId, threadId, name) =>
  tg('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name: [...String(name)].slice(0, NAME_MAX).join('') });

/**
 * Что известно о теме по сообщению из неё: Telegram прикладывает к сообщениям темы служебное сообщение о её создании
 * (reply_to_message.forum_topic_created), а само создание приходит отдельным сообщением с forum_topic_created.
 * @returns {{name: string, implicit: boolean} | null}
 */
export function topicInfoOf(msg) {
  const c = msg?.forum_topic_created ?? msg?.reply_to_message?.forum_topic_created;
  return c ? { name: c.name, implicit: Boolean(c.is_name_implicit) } : null;
}

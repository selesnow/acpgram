import { LANG_CODES, t } from './i18n.mjs';

const LABELS = {
  project: 'start.btn.project',
  files: 'start.btn.files',
  git: 'start.btn.git',
  engine: 'start.btn.engine',
  model: 'start.btn.model',
  sessions: 'start.btn.sessions',
  new: 'start.btn.new',
  stop: 'btn.stop',
  close: 'reply.close',
  language: 'btn.language',
  users: 'start.btn.users',
  active: 'start.btn.active',
  invite: 'start.btn.invite',
  usage: 'reply.usage',
  help: 'reply.help',
};

const LAYOUT = [
  ['project', 'files', 'git'],
  ['engine', 'model', 'sessions'],
  ['new', 'stop', 'close'],
  ['language', 'help'],
];

const ADMIN_ROWS = [
  ['users', 'active'],
  ['invite', 'usage'],
];

const LEGACY_LABELS = [['close', 'start.btn.close']];

function buttonOf(name, lang, topics) {
  if (name === 'new' && topics === 'on') return { name, text: t('reply.topic', lang) };
  if (name === 'topics') return { name, text: t(topics === 'on' ? 'start.btn.topicsOn' : 'start.btn.topicsOff', lang) };
  return { name, text: t(LABELS[name], lang) };
}

export function replyButtons(lang, { admin = false, topics = null } = {}) {
  const rows = LAYOUT.map((row) => row.map((name) => buttonOf(name, lang, topics)));
  if (topics) rows[rows.length - 1].push(buttonOf('topics', lang, topics));
  if (admin) {
    for (const row of ADMIN_ROWS) rows.push(row.map((name) => buttonOf(name, lang, topics)));
  }
  return rows;
}

export const replyKeyboard = (lang, opts) => ({
  keyboard: replyButtons(lang, opts).map((row) => row.map(({ text }) => ({ text }))),
  resize_keyboard: true,
  one_time_keyboard: true,
});

export const removeReplyKeyboard = () => ({ remove_keyboard: true });

export const replyKeyboardKey = (userId, topic = 0) => `replyKb:${userId}:${topic || 0}`;
export const replyKeyboardOffKey = (userId) => `replyKbOff:${userId}`;

// Все подписи кнопок на всех языках и во всех режимах тем: смена языка или /topics не ломает старую клавиатуру.
const COMMAND_BY_LABEL = new Map();
for (const code of LANG_CODES) {
  for (const topics of [null, 'on', 'off']) {
    for (const { name, text } of replyButtons(code, { admin: true, topics }).flat()) {
      COMMAND_BY_LABEL.set(text, name);
    }
  }
  for (const [name, key] of LEGACY_LABELS) COMMAND_BY_LABEL.set(t(key, code), name);
}

export function replyCommandOf(text) {
  const name = COMMAND_BY_LABEL.get(text);
  return name ? { name } : null;
}

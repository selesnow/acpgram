import { t } from './i18n.mjs';

const LABELS = {
  project: 'start.btn.project',
  files: 'start.btn.files',
  git: 'start.btn.git',
  engine: 'start.btn.engine',
  model: 'start.btn.model',
  sessions: 'start.btn.sessions',
  new: 'start.btn.new',
  stop: 'btn.stop',
  close: 'start.btn.close',
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

function buttonOf(name, lang, topics) {
  if (name === 'new' && topics) return { name, text: t('reply.topic', lang) };
  if (name === 'topics') return { name, text: t(topics === 'on' ? 'start.btn.topicsOn' : 'start.btn.topicsOff', lang) };
  return { name, text: t(LABELS[name], lang) };
}

export function replyButtons(lang, { admin = false, topics = null } = {}) {
  const rows = LAYOUT.map((row) => row.map((name) => buttonOf(name, lang, topics)));
  if (topics) rows.push([buttonOf('topics', lang, topics)]);
  if (admin) rows.push(['users', 'active', 'invite', 'usage'].map((name) => buttonOf(name, lang, topics)));
  return rows;
}

export const replyKeyboard = (lang, opts) => ({
  keyboard: replyButtons(lang, opts).map((row) => row.map(({ text }) => ({ text }))),
  resize_keyboard: true,
});

export function replyCommandOf(text, lang, opts) {
  const hit = replyButtons(lang, opts).flat().find((button) => button.text === text);
  if (!hit) return null;
  return { name: hit.name };
}

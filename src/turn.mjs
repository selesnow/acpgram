import { askChoice, ASK_PLACEHOLDER, extractAsks } from './asks.mjs';
import { db, langOf, log, say } from './ctx.mjs';
import { FILE_PLACEHOLDER, extractSendMarks } from './files.mjs';
import { clearStopTimer } from './forceStop.mjs';
import { extractGitMarks } from './gitMarks.mjs';
import { t } from './i18n.mjs';
import { onPermissionCallback } from './permission.mjs';
import { dest, tg } from './telegram.mjs';
import { extractTitle, extractTopicMarks } from './topics.mjs';
import { callAgent } from './turnAgent.mjs';
import { deliverTurn } from './turnDelivery.mjs';
import { createTurnStream } from './turnStream.mjs';
import { neutralizeTgTags } from './ui.mjs';
import { cbCtx } from './uiActions.mjs';
import { dropPermissions, engineOf } from './state.mjs';

export { onPermissionCallback };

export async function runTurn(st, text, { files = [], quote = null } = {}) {
  const to = st.to;
  const dbText = files.length ? [text, `📎 ${files.map((f) => f.name).join(', ')}`].filter(Boolean).join('\n') : text;
  const lang = langOf(st.userId);
  const engine = engineOf(st);
  const topicRow = st.topic ? db.getTopic(st.userId, st.topic) : null;
  const naming = Boolean(topicRow && !topicRow.named);
  if (topicRow) db.saveTopic(st.userId, st.topic, { hidden: false });
  const clean = engine.cleanText;
  st.busy = true;
  st.suppress = false;
  st.lastActive = Date.now();
  st.turnId = Symbol('turn');

  let requestId = null;
  const getRequestId = () => requestId;
  const beginRequest = (sessionId) => (st.requestId = requestId = db.startRequest(sessionId, dbText));
  const startedAt = Date.now();
  const stream = createTurnStream({ st, to, clean, engine, lang, startedAt, getRequestId });
  st.onUpdate = stream.onUpdate;

  let outcome;
  try {
    outcome = await callAgent({ st, text, files, quote, lang, naming, stream, beginRequest, getRequestId });
  } finally {
    stream.stop();
    clearStopTimer(st);
    st.turnId = null;
    st.onUpdate = null;
    dropPermissions(st);
    st.requestId = null;
    st.busy = false;
    st.lastActive = Date.now();
  }

  await stream.waitDraft();

  const titled = extractTitle(neutralizeTgTags(clean(stream.answer)));
  const topical = extractTopicMarks(titled.text);
  const gitted = extractGitMarks(topical.text);
  const asked = extractAsks(gitted.text);
  const sent = extractSendMarks(asked.text, { placeholders: true });
  const answerText = sent.text.replace(FILE_PLACEHOLDER, '').replace(ASK_PLACEHOLDER, '').trim();
  const delivered = await deliverTurn({ st, to, text, dbText, lang, engine, naming, ...outcome, startedAt, steps: stream.steps, sent, asked, gitted, titled, topical, answerText, truncated: stream.truncated, requestId });
  if (!delivered) return;
  return drainQueue(st);
}

const settleNotice = (chatId, messageId, text) =>
  tg('editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] } }).catch(() => {});

export async function enqueue(st, text, { quote = null } = {}) {
  const lang = langOf(st.userId);
  const prev = st.queued;
  const item = { text, quote, messageId: null };
  st.queued = item;
  if (prev?.messageId) settleNotice(st.chatId, prev.messageId, t('queue.replaced', lang));
  const msg = await tg('sendMessage', {
    ...dest(st.to),
    text: t('queue.added', lang),
    reply_markup: { inline_keyboard: [[{ text: t('queue.stopSend', lang), callback_data: 'q:s' }], [{ text: t('queue.cancel', lang), callback_data: 'q:x' }]] },
  }).catch((e) => log('очередь:', e.message));
  if (msg) item.messageId = msg.message_id;
  if (!st.busy && st.queued === item) return drainQueue(st);
}

export function dropQueue(st) {
  const q = st.queued;
  if (!q) return false;
  st.queued = null;
  if (q.messageId) settleNotice(st.chatId, q.messageId, t('queue.cancelled', langOf(st.userId)));
  return true;
}

export async function drainQueue(st) {
  const q = st.queued;
  if (!q || st.busy) return;
  st.queued = null;
  if (q.messageId) settleNotice(st.chatId, q.messageId, t('queue.sending', langOf(st.userId)));
  return runTurn(st, q.text, { quote: q.quote });
}

export async function onQueueCallback(st, cb) {
  const lang = langOf(st.userId);
  const { ack } = cbCtx(st, cb);
  if (!st.queued || st.queued.messageId !== cb.message?.message_id) return ack(t('queue.stale', lang));
  await ack();
  if (cb.data === 'q:x') return void dropQueue(st);
  if (!st.busy) return drainQueue(st);
  st.agent?.cancel();
  dropPermissions(st);
}

export async function onAskCallback(st, cb) {
  const lang = langOf(st.userId);
  const { ack } = cbCtx(st, cb);
  const text = askChoice(st, cb.data);
  if (!text) return ack(t('ask.stale', lang));
  await ack();
  await say(st.to, t('ask.chosen', lang, { text }));
  log('кнопка ответа агенту', st.userId, JSON.stringify(text));
  return st.busy ? enqueue(st, text) : runTurn(st, text);
}

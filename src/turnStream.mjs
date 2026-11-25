import { positiveEnv } from './app.mjs';
import { stripAskMarks } from './asks.mjs';
import { db, dbg, log } from './ctx.mjs';
import { stripGitMarks } from './gitMarks.mjs';
import { forceStopAfter } from './forceStop.mjs';
import { stripSendMarks } from './files.mjs';
import { sendRichDraft, sendThinkingDraft } from './telegram.mjs';
import { stripTitle, stripTopicMarks } from './topics.mjs';
import { parseTool } from './tools.mjs';
import { composeDraft, lastThoughtTitle, neutralizeTgTags } from './ui.mjs';

const DRAFT_INTERVAL_MS = 1000;
const DRAFT_WAIT_MS = 3000;
const HEARTBEAT_MS = 8000;
const TURN_IDLE_MS = positiveEnv('TURN_IDLE_MINUTES', 0) * 60_000;
const MAX_ANSWER_CHARS = 1024 * 1024;
const MAX_THOUGHT_BUF = 4096;
const MAX_STEPS = 5000;

export function createTurnStream({ st, to, clean, engine, lang, startedAt, getRequestId }) {
  let answer = '';
  let answerTruncated = false;
  let thoughtBuf = '';
  let thought = '';
  const steps = [];
  let stepsTruncated = false;
  let plan = [];
  let breakBeforeText = false;
  let dirty = true;
  let lastSent = 0;
  let lastText = '';
  let lastUsage = null;
  let lastEvent = Date.now();

  const draftId = (Date.now() % 2_000_000_000) + 1;
  const addAnswer = (part) => {
    if (!part) return;
    const room = MAX_ANSWER_CHARS - answer.length;
    if (part.length <= room) return void (answer += part);
    answer += part.slice(0, Math.max(0, room));
    answerTruncated = true;
  };

  const idleTimer = TURN_IDLE_MS
    ? setInterval(() => {
        if (Date.now() - lastEvent <= TURN_IDLE_MS) return;
        log('ход без событий дольше', TURN_IDLE_MS / 60_000, 'мин — завершаем процесс | пользователь', st.userId);
        lastEvent = Date.now();
        forceStopAfter(st, { ms: 0, kill: (a) => a.close() });
      }, Math.min(TURN_IDLE_MS, 30_000))
    : null;

  const sendDraft = async () => {
    if (!dirty && Date.now() - lastSent < HEARTBEAT_MS) return;
    dirty = false;
    lastSent = Date.now();
    const d = composeDraft({ thought, steps, plan, answer: stripAskMarks(stripGitMarks(stripTitle(stripTopicMarks(stripSendMarks(neutralizeTgTags(clean(answer))))))), elapsedMs: Date.now() - startedAt, lang });
    const draft = d.plain ? '(точки Telegram)' : d.markdown;
    if (draft !== lastText) dbg(`draft u${st.userId}`, draft);
    lastText = draft;
    const send = d.plain ? sendThinkingDraft(to, draftId, { can_stop: true }) : sendRichDraft(to, draftId, d.markdown, { can_stop: true, keep_on_stop: true });
    await send.catch((e) => {
      log('draft:', e.message);
      dbg('draft-error ' + e.message, draft);
    });
  };

  let inFlight = null;
  const pushDraft = () => {
    if (!inFlight) inFlight = sendDraft().finally(() => (inFlight = null));
    return inFlight;
  };
  const timer = setInterval(pushDraft, DRAFT_INTERVAL_MS);

  const onUpdate = (u) => {
    lastEvent = Date.now();
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
      if (breakBeforeText && answer.trim()) addAnswer('\n\n');
      breakBeforeText = false;
      addAnswer(u.content.text);
      dirty = true;
    } else if (kind === 'agent_thought_chunk' && u.content?.type === 'text') {
      const last = lastThoughtTitle(thoughtBuf + u.content.text);
      if (last.title) thought = last.title;
      thoughtBuf = last.rest.slice(-MAX_THOUGHT_BUF);
      dirty = true;
    } else if (kind === 'tool_call') {
      const tool = parseTool(u, engine);
      breakBeforeText = true;
      if (steps.length < MAX_STEPS) steps.push(tool);
      else if (!stepsTruncated) {
        stepsTruncated = true;
        log(`ход работы урезан до ${MAX_STEPS} шагов u${st.userId}`);
      }
      db.toolStarted(getRequestId(), tool);
      dirty = true;
    } else if (kind === 'plan' && Array.isArray(u.entries)) {
      plan = u.entries;
      dirty = true;
    } else if (kind === 'usage_update') {
      lastUsage = u;
    } else if (kind === 'tool_call_update') {
      const tool = parseTool(u, engine);
      const step = steps.find((s) => s.toolCallId === tool.toolCallId);
      if (step) {
        if (tool.status) step.status = tool.status;
        if (tool.title) step.title = tool.title;
        if (tool.description) step.description = tool.description;
      }
      db.toolUpdated(getRequestId(), tool);
      dirty = true;
    }
  };

  return {
    onUpdate,
    pushDraft,
    addAnswer,
    get answer() {
      return answer;
    },
    set answer(value) {
      answer = value;
    },
    get truncated() {
      return answerTruncated;
    },
    get steps() {
      return steps;
    },
    get lastUsage() {
      return lastUsage;
    },
    async waitDraft() {
      if (inFlight) await Promise.race([inFlight, new Promise((r) => setTimeout(r, DRAFT_WAIT_MS).unref())]);
    },
    stop() {
      clearInterval(timer);
      if (idleTimer) clearInterval(idleTimer);
    },
  };
}

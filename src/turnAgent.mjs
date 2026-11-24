import { mkdirSync } from 'node:fs';
import { ASK_NOTE } from './asks.mjs';
import { ModelAccessError, choiceName, getCatalog, syncSelection } from './access.mjs';
import { dbg, log } from './ctx.mjs';
import { parseUsage } from './engines.mjs';
import { errText, t } from './i18n.mjs';
import { SECRETS_NOTE, buildPromptBlocks, outboxDir } from './files.mjs';
import { gitNote } from './gitAccess.mjs';
import { ClosedError, LimitError, ProjectError, ensureAgent, errorRootOf } from './state.mjs';
import { TITLE_NOTE } from './topics.mjs';

const OUTBOX_NOTE_EVERY = 10;

function turnUsage(a, res, lastUsage) {
  const u = parseUsage(res, lastUsage);
  let cost = null;
  if (Number.isFinite(a.lastCostTotal)) {
    if (a.costBaseUnknown) a.costBaseUnknown = false;
    else cost = Math.max(0, a.lastCostTotal - (a.costSoFar ?? 0));
    a.costSoFar = a.lastCostTotal;
  }
  const applied = a.applied ?? {};
  const known = (v) => (v && v !== '?' ? v : null);
  const model = a.lastModel ?? u.model ?? choiceName(a.engine, 'model', known(applied.model) ?? getCatalog(a.engine.id)?.defaultModel) ?? null;
  const effort = known(applied.effort) ? choiceName(a.engine, 'effort', applied.effort) : null;
  return { ...u, model, effort, cost };
}

export async function callAgent({ st, text, files, quote, lang, naming, stream, beginRequest, getRequestId }) {
  let stopReason = 'error';
  let error = null;
  let limited = false;
  let usage = null;
  let agent = null;
  try {
    await stream.pushDraft();
    if (st.suppress) throw new ClosedError();
    const a = (agent = await ensureAgent(st));
    await syncSelection(st.userId, a);
    beginRequest(a.dbSessionId);
    const outbox = outboxDir(st.userId);
    mkdirSync(outbox, { recursive: true });
    const noteNow = (a.promptCount ?? 0) % OUTBOX_NOTE_EVERY === 0;
    a.promptCount = (a.promptCount ?? 0) + 1;
    const blocks = buildPromptBlocks({ text, files, caps: a.caps, outbox: noteNow ? outbox : null, quote, notes: noteNow ? [ASK_NOTE, SECRETS_NOTE, gitNote(st.userId)].filter(Boolean) : [] });
    if (naming) blocks.push({ type: 'text', text: TITLE_NOTE });
    const res = await a.prompt(blocks);
    stopReason = res.stopReason;
    usage = turnUsage(a, res, stream.lastUsage);
  } catch (e) {
    error = e.message;
    if (agent && getRequestId()) usage = turnUsage(agent, null, stream.lastUsage);
    if (e instanceof ModelAccessError || e instanceof ProjectError) {
      limited = true;
      stream.answer = e.message;
    } else if (e instanceof ClosedError) {
      stopReason = 'cancelled';
      log('запрос прерван закрытием сессии, пользователь', st.userId);
    } else if (e instanceof LimitError) {
      log('лимит агентов, пользователь', st.userId);
      limited = true;
      stream.answer = e.message;
    } else {
      log('ошибка запроса:', e.message, '| пользователь', st.userId, '| stopReason', stopReason);
      dbg('ошибка запроса, стек:', e.stack);
      stream.addAnswer(`\n\n${t('turn.error', lang, { msg: errText(e, lang, errorRootOf(st.userId)) })}`);
    }
    if (!getRequestId()) beginRequest(st.agent?.dbSessionId ?? null);
  }
  return { stopReason, error, limited, usage, agent };
}

// Один запрос пользователя: черновик со стримингом, ход работы, запросы разрешений, итоговый ответ.
import { db, dbg, log, say } from './ctx.mjs';
import { display } from './projects.mjs';
import { ModelAccessError, choiceName, getCatalog, syncSelection } from './access.mjs';
import { parseUsage, permissionOptions } from './engines.mjs';
import { ClosedError, LimitError, dropPermissions, engineOf, ensureAgent, modeFor, setPermissionHandler } from './state.mjs';
import { parseTool } from './tools.mjs';
import { tg, sendRich, sendRichDraft, sendThinkingDraft, escHtml } from './telegram.mjs';
import { composeDraft, finalExtras, finalMessages, toolMeta } from './ui.mjs';

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const DRAFT_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 8000; // черновик живёт 30 с — обновляем и без изменений

// ---- запрос разрешения: inline-кнопки (приходят самому пользователю, чей это запрос) ----
const OPTION_LABELS = { allow_once: '✅ Разрешить', allow_always: '✅ Разрешить на эту сессию', reject_once: '⛔ Отклонить', reject_always: '⛔ Отклонять всегда' };
const RESULT_LABELS = { allow_once: '✅ Разрешено', allow_always: '✅ Разрешено на эту сессию', reject_once: '⛔ Отклонено', reject_always: '⛔ Отклонено' };
let permSeq = 0;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Подпись кнопки: варианты, меняющие режим сессии (выход из плана у Claude Code), — своим текстом агента. */
const optionLabel = (engine, o) => (engine.optionMode?.(o) ? `▶️ ${o.name}` : OPTION_LABELS[o.kind] || o.name);
const resultLabel = (engine, o) => (engine.optionMode?.(o) ? `▶️ ${o.name}` : RESULT_LABELS[o.kind] || o.name);

async function askPermission(st, params) {
  const seq = ++permSeq;
  const tc = params.toolCall || {};
  const engine = engineOf(st);
  const info = parseTool(tc, engine);
  // ни постоянных правил, ни выхода в режим выше уровня доступа пользователя из чата не даём
  const options = permissionOptions(engine, params.options || [], modeFor(st.userId, engine));
  const what = info.description || info.title || info.tool;
  const meta = toolMeta(info.tool, info.kind);
  const head = `${meta.icon} ${meta.label}`;
  const dbId = () => db.permissionAsked(st.requestId, tc.toolCallId, info.title || what, params.options);

  // разрешать на этом уровне нечего (например, выход из режима плана при доступе «Чтение») — отклоняем сами
  if (!options.some((o) => o.kind.startsWith('allow'))) {
    const reject = options.find((o) => o.kind.startsWith('reject'));
    const id = dbId();
    db.permissionAnswered(id, reject?.optionId ?? null, reject ? 'auto-rejected' : 'cancelled');
    say(st.chatId, `🔒 Агент запросил действие, недоступное на вашем уровне доступа, — отклонено.\n${head}: ${trunc(what, 300)}`);
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  }
  // команда — блоком кода, для остального (путь к файлу и т.п.) — моноширинный текст
  const isCmd = info.kind === 'execute' && info.title;
  const body = isCmd
    ? `${escHtml(trunc(info.description || 'выполнение команды', 400))}\n\n<pre>${escHtml(trunc(info.title, 1200))}</pre>`
    : `<code>${escHtml(trunc(what, 600))}</code>`;
  const text = `🔐 <b>Агент просит разрешение</b>\n\n<b>${escHtml(head)}</b>: ${body}`;

  const permId = dbId();
  // индекс кнопки — в списке показанных вариантов: скрытый вариант подменой callback_data не выбрать
  const msg = await tg('sendMessage', {
    chat_id: st.chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: options.map((o, i) => [{ text: optionLabel(engine, o), callback_data: `perm:${seq}:${i}` }]),
    },
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!st.perms.delete(seq)) return;
      db.permissionAnswered(permId, null, 'timeout');
      tg('editMessageText', { chat_id: st.chatId, message_id: msg.message_id, text: `⌛ Время вышло, отклонено\n${head}: ${what}`.slice(0, 4000) }).catch(() => {});
      resolve({ outcome: 'cancelled' });
    }, PERMISSION_TIMEOUT_MS);
    st.perms.set(seq, {
      options, // только показанные варианты
      engine,
      title: `${head}: ${what}`,
      dbId: permId,
      messageId: msg.message_id,
      chatId: st.chatId,
      resolve: (o) => {
        clearTimeout(timer);
        resolve(o);
      },
    });
  });
}
setPermissionHandler(askPermission);

/** Нажатие кнопки разрешения. Ищем только среди разрешений самого нажавшего — чужие запросы недоступны. */
export async function onPermissionCallback(st, cb) {
  const m = /^perm:(\d+):(\d+)$/.exec(cb.data || '');
  const p = m && st.perms.get(Number(m[1]));
  if (!p) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Запрос уже неактуален' }).catch(() => {});
  const opt = p.options[Number(m[2])];
  if (!opt) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет такого варианта' }).catch(() => {});
  st.perms.delete(Number(m[1]));
  db.permissionAnswered(p.dbId, opt.optionId, 'selected');
  p.resolve({ outcome: 'selected', optionId: opt.optionId });
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  await tg('editMessageText', { chat_id: p.chatId, message_id: p.messageId, text: `${resultLabel(p.engine, opt)}\n${p.title}`.slice(0, 4000) }).catch(() => {});
}

/**
 * Расход одного запроса: токены, реальная модель, уровень рассуждений и стоимость.
 * Claude Code присылает стоимость нарастающим итогом за процесс — стоимость запроса считаем как разницу.
 */
function turnUsage(a, res, lastUsage) {
  const u = parseUsage(res, lastUsage);
  // стоимость: последний итог агента (a.lastCostTotal обновляется при каждом usage_update, state.mjs) минус итог
  // на конец прошлого запроса; считается при любом исходе — упавший или отменённый запрос тоже стоит денег
  let cost = null;
  if (Number.isFinite(a.lastCostTotal)) {
    if (a.costBaseUnknown) a.costBaseUnknown = false; // первый запрос после возобновления: база неизвестна
    else cost = Math.max(0, a.lastCostTotal - (a.costSoFar ?? 0));
    a.costSoFar = a.lastCostTotal;
  }
  const applied = a.applied ?? {};
  const known = (v) => (v && v !== '?' ? v : null);
  // реальную модель присылают Gemini CLI и Claude Code; иначе — выбранная или модель агента по умолчанию
  const model = a.lastModel ?? u.model ?? choiceName(a.engine, 'model', known(applied.model) ?? getCatalog(a.engine.id)?.defaultModel) ?? null;
  const effort = known(applied.effort) ? choiceName(a.engine, 'effort', applied.effort) : null;
  return { ...u, model, effort, cost };
}

/** Выполняет запрос пользователя к агенту и отправляет результат. */
export async function runTurn(st, text) {
  const chatId = st.chatId;
  const engine = engineOf(st);
  const clean = engine.cleanText; // служебные вставки движка в тексте ответа
  st.busy = true;
  st.suppress = false;
  st.lastActive = Date.now();
  const draftId = (Date.now() % 2_000_000_000) + 1;
  const startedAt = Date.now();
  let answer = '';
  let thoughtBuf = '';
  let thought = '';
  const steps = []; // ход работы: инструменты агента
  let breakBeforeText = false;
  let dirty = true;
  let lastSent = 0;
  let lastText = '';
  let lastUsage = null; // последнее событие usage_update

  // Черновик (оформление в ui.mjs): пока агент молчит — родные анимированные точки Telegram,
  // затем заголовок мыслей и ход работы, а как пошёл ответ — последний шаг и сам ответ.
  const sendDraft = async () => {
    if (!dirty && Date.now() - lastSent < HEARTBEAT_MS) return;
    dirty = false;
    lastSent = Date.now();
    const d = composeDraft({ thought, steps, answer: clean(answer), elapsedMs: Date.now() - startedAt });
    const draft = d.plain ? '(точки Telegram)' : d.markdown;
    if (draft !== lastText) dbg(`draft u${st.userId}`, draft);
    lastText = draft;
    const send = d.plain ? sendThinkingDraft(chatId, draftId, { can_stop: true }) : sendRichDraft(chatId, draftId, d.markdown, { can_stop: true });
    await send.catch((e) => {
      log('draft:', e.message);
      dbg('draft-error ' + e.message, draft);
    });
  };
  const timer = setInterval(sendDraft, DRAFT_INTERVAL_MS);

  st.onUpdate = (u) => {
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
      // текст после вызова инструмента — новый абзац, иначе фразы склеиваются («…test.Команда…»)
      if (breakBeforeText && answer.trim()) answer += '\n\n';
      breakBeforeText = false;
      answer += u.content.text;
      dirty = true;
    } else if (kind === 'agent_thought_chunk' && u.content?.type === 'text') {
      thoughtBuf += u.content.text;
      const titles = [...thoughtBuf.matchAll(/\*\*([^*\n]+)\*\*/g)];
      if (titles.length) thought = titles[titles.length - 1][1].trim();
      dirty = true;
    } else if (kind === 'tool_call') {
      const t = parseTool(u, engine);
      breakBeforeText = true;
      steps.push(t);
      db.toolStarted(st.requestId, t);
      dirty = true;
    } else if (kind === 'usage_update') {
      lastUsage = u; // у Claude Code здесь стоимость и реальная модель
    } else if (kind === 'tool_call_update') {
      const t = parseTool(u, engine);
      const step = steps.find((s) => s.toolCallId === t.toolCallId);
      if (step) {
        if (t.status) step.status = t.status;
        if (t.title) step.title = t.title;
        if (t.description) step.description = t.description;
      }
      db.toolUpdated(st.requestId, t);
      dirty = true;
    }
  };

  let stopReason = 'error';
  let error = null;
  let limited = false;
  let usage = null;
  let agent = null;
  try {
    await sendDraft();
    // пока отправлялся черновик, сессию могли закрыть (/close, администратор) — агента не поднимаем
    if (st.suppress) throw new ClosedError();
    const a = (agent = await ensureAgent(st));
    // модель и уровень рассуждений — как выбрал пользователь (/model) и разрешил администратор
    await syncSelection(st.userId, a);
    st.requestId = db.startRequest(a.dbSessionId, text);
    const res = await a.prompt(text);
    stopReason = res.stopReason;
    usage = turnUsage(a, res, lastUsage);
  } catch (e) {
    error = e.message;
    // запрос упал или прерван, но агент мог успеть потратить токены — учитываем стоимость этому запросу
    if (agent && st.requestId) usage = turnUsage(agent, null, lastUsage);
    if (e instanceof ModelAccessError) {
      limited = true; // понятное сообщение без пометки «Ошибка» и без подвала
      answer = e.message;
    } else if (e instanceof ClosedError) {
      stopReason = 'cancelled';
      log('запрос прерван закрытием сессии, пользователь', st.userId);
    } else if (e instanceof LimitError) {
      log('лимит агентов, пользователь', st.userId);
      limited = true;
      answer = e.message; // понятное сообщение без пометки «Ошибка»
    } else {
      log('ошибка запроса:', e.message);
      answer += `\n\n⚠️ Ошибка: ${e.message}`;
    }
    if (!st.requestId) st.requestId = db.startRequest(st.agent?.dbSessionId ?? null, text);
  } finally {
    clearInterval(timer);
    st.onUpdate = null;
    dropPermissions(st);
    st.busy = false;
    st.lastActive = Date.now();
  }

  answer = clean(answer);
  let final = answer.trim() || '(пустой ответ)';
  db.finishRequest(st.requestId, { stopReason, answer: answer.trim(), error, usage: usage ?? {} });
  st.requestId = null;
  if (st.suppress) {
    // администратор отозвал доступ или сменил уровень — результат пользователю не отправляем
    st.suppress = false;
    return;
  }
  if (stopReason === 'cancelled') final += '\n\n⏹ Остановлено.';
  // свёрнутый ход работы и подвал (движок, модель, расход, проект, время); для «все слоты заняты» не нужны
  const extras = limited ? '' : finalExtras({ steps, elapsedMs: Date.now() - startedAt, project: display(st.project), engine: engine.short, usage });
  for (const msg of finalMessages(final, extras)) {
    dbg(`final u${st.userId} stop=${stopReason}`, msg);
    await sendRich(chatId, msg).catch((e) => log('sendRich:', e.message));
  }
}

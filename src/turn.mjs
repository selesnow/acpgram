// Один запрос пользователя: черновик со стримингом, ход работы, запросы разрешений, итоговый ответ.
import { mkdirSync } from 'node:fs';
import { db, dbg, langOf, log, say } from './ctx.mjs';
import { FILE_PLACEHOLDER, attachFiles, buildPromptBlocks, extractSendMarks, outboxDir, stripSendMarks } from './files.mjs';
import { showPath } from './projects.mjs';
import { ModelAccessError, choiceName, getCatalog, syncSelection } from './access.mjs';
import { parseUsage, permissionOptions } from './engines.mjs';
import { t } from './i18n.mjs';
import { ClosedError, LimitError, dropPermissions, engineOf, ensureAgent, modeFor, setPermissionHandler } from './state.mjs';
import { parseTool } from './tools.mjs';
import { dest, tg, mediaIdsOf, sendFile, sendRich, sendRichDraft, sendThinkingDraft, escHtml } from './telegram.mjs';
import { composeDraft, finalExtras, finalMessages, lastThoughtTitle, toolMeta } from './ui.mjs';
import { TITLE_NOTE, extractTitle, renameTopic, stripTitle, titleFromRequest, topicName } from './topics.mjs';

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const DRAFT_INTERVAL_MS = 1000;
const DRAFT_WAIT_MS = 3000; // сколько итоговый ответ ждёт последний черновик
const OUTBOX_NOTE_EVERY = 10; // подсказка об отправке файлов — в первом запросе сессии и затем раз в столько запросов
const HEARTBEAT_MS = 8000; // черновик живёт 30 с — обновляем и без изменений

// ---- запрос разрешения: inline-кнопки (приходят самому пользователю, чей это запрос) ----
const PERM_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
let permSeq = 0;

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Подпись кнопки: варианты, меняющие режим сессии (выход из плана у Claude Code), — своим текстом агента. */
const optionLabel = (engine, o, lang) => (engine.optionMode?.(o) ? `▶️ ${o.name}` : PERM_KINDS.includes(o.kind) ? t(`perm.opt.${o.kind}`, lang) : o.name);
/** Подпись после ответа: отклонённые варианты — одной формулировкой. */
const resultLabel = (engine, o, lang) =>
  engine.optionMode?.(o) ? `▶️ ${o.name}` : o.kind.startsWith('reject') && PERM_KINDS.includes(o.kind) ? t('perm.res.reject', lang) : PERM_KINDS.includes(o.kind) ? t(`perm.res.${o.kind}`, lang) : o.name;
/** Цвет кнопки (Bot API): разрешить — зелёная, отклонить — красная, смена режима — синяя. */
export const optionStyle = (engine, o) => (engine.optionMode?.(o) ? 'primary' : o.kind.startsWith('allow') ? 'success' : o.kind.startsWith('reject') ? 'danger' : undefined);

/**
 * Итог запроса разрешения: текст запроса (команда, файл) остаётся, а вместо вариантов — одна неактивная кнопка
 * с результатом (Bot API 10.3, disabled). Если Telegram такую кнопку не принял — прежний вид: итог текстом.
 */
function settlePermissionMessage(chatId, messageId, label, style, fallbackText) {
  const button = { text: label, disabled: {}, ...(style ? { style } : {}) };
  return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[button]] } }).catch((e) => {
    log('кнопка итога разрешения:', e.message);
    return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: fallbackText.slice(0, 4000) }).catch(() => {});
  });
}

async function askPermission(st, params) {
  const seq = ++permSeq;
  const lang = langOf(st.userId);
  const tc = params.toolCall || {};
  const engine = engineOf(st);
  const info = parseTool(tc, engine);
  // ни постоянных правил, ни выхода в режим выше уровня доступа пользователя из чата не даём
  const options = permissionOptions(engine, params.options || [], modeFor(st.userId, engine));
  const what = info.description || info.title || info.tool;
  const meta = toolMeta(info.tool, info.kind, lang);
  const head = `${meta.icon} ${meta.label}`;
  const dbId = () => db.permissionAsked(st.requestId, tc.toolCallId, info.title || what, params.options);

  // разрешать на этом уровне нечего (например, выход из режима плана при доступе «Чтение») — отклоняем сами
  if (!options.some((o) => o.kind.startsWith('allow'))) {
    const reject = options.find((o) => o.kind.startsWith('reject'));
    const id = dbId();
    db.permissionAnswered(id, reject?.optionId ?? null, reject ? 'auto-rejected' : 'cancelled');
    say(st.to, t('perm.blocked', lang, { head, what: trunc(what, 300) }));
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  }
  // команда — блоком кода, для остального (путь к файлу и т.п.) — моноширинный текст
  const isCmd = info.kind === 'execute' && info.title;
  const body = isCmd
    ? `${escHtml(trunc(info.description || t('step.command', lang), 400))}\n\n<pre>${escHtml(trunc(info.title, 1200))}</pre>`
    : `<code>${escHtml(trunc(what, 600))}</code>`;
  const text = `${t('perm.ask', lang)}\n\n<b>${escHtml(head)}</b>: ${body}`;

  const permId = dbId();
  // индекс кнопки — в списке показанных вариантов: скрытый вариант подменой callback_data не выбрать
  const msg = await tg('sendMessage', {
    ...dest(st.to),
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: options.map((o, i) => {
        const style = optionStyle(engine, o);
        return [{ text: optionLabel(engine, o, lang), callback_data: `perm:${seq}:${i}`, ...(style ? { style } : {}) }];
      }),
    },
  });
  const chatId = st.chatId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!st.perms.delete(seq)) return;
      db.permissionAnswered(permId, null, 'timeout');
      settlePermissionMessage(chatId, msg.message_id, t('perm.res.timeout', lang), 'danger', t('perm.timeout', lang, { head, what }));
      resolve({ outcome: 'cancelled' });
    }, PERMISSION_TIMEOUT_MS);
    st.perms.set(seq, {
      options, // только показанные варианты
      engine,
      title: `${head}: ${what}`,
      dbId: permId,
      messageId: msg.message_id,
      chatId,
      resolve: (o) => {
        clearTimeout(timer);
        resolve(o);
      },
      // запрос снят без ответа (/stop, /close, конец запроса) — кнопки больше не нужны
      onDrop: () => settlePermissionMessage(chatId, msg.message_id, t('perm.res.cancelled', lang), undefined, `${t('perm.res.cancelled', lang)}\n${head}: ${what}`),
    });
  });
}
setPermissionHandler(askPermission);

/** Нажатие кнопки разрешения. Ищем только среди разрешений самого нажавшего — чужие запросы недоступны. */
export async function onPermissionCallback(st, cb) {
  const m = /^perm:(\d+):(\d+)$/.exec(cb.data || '');
  const p = m && st.perms.get(Number(m[1]));
  const lang = langOf(st.userId);
  if (!p) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: t('perm.stale', lang) }).catch(() => {});
  const opt = p.options[Number(m[2])];
  if (!opt) return tg('answerCallbackQuery', { callback_query_id: cb.id, text: t('perm.badOption', lang) }).catch(() => {});
  st.perms.delete(Number(m[1]));
  db.permissionAnswered(p.dbId, opt.optionId, 'selected');
  p.resolve({ outcome: 'selected', optionId: opt.optionId });
  await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  const label = resultLabel(p.engine, opt, lang);
  await settlePermissionMessage(p.chatId, p.messageId, label, optionStyle(p.engine, opt), `${label}\n${p.title}`);
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

/** Называет тему диалога (названием от агента или по запросу) — один раз: дальше название не трогаем. */
async function nameTopic(st, title) {
  if (!title) return;
  const name = topicName(st.project, title); // «проект · название»: в общем списке тем видно, к чему тема относится
  try {
    await renameTopic(st.chatId, st.topic, name);
    db.saveTopic(st.userId, st.topic, { name, named: true });
    log('тема названа', st.userId, st.topic, name);
  } catch (e) {
    log('название темы:', e.message);
  }
}

/** Файлы отдельными сообщениями (не поместились в ответ или Telegram не принял их внутри ответа). */
async function sendLooseFiles(st, files, lang) {
  for (const f of files) {
    try {
      await sendFile(st.to, f.path, { photo: f.photo, size: f.size });
      log('файл отправлен пользователю отдельно', st.userId, f.path);
    } catch (e) {
      log('отправка файла:', e.message);
      await say(st.to, t('file.sendFail', lang, { name: f.name, why: t('file.why.error', lang, { msg: e.message }) }));
    }
  }
}

/**
 * Выполняет запрос пользователя к агенту и отправляет результат.
 * @param {{files?: {path: string, name: string, mime: string, size: number, data?: Buffer}[]}} [opts] вложения запроса
 */
export async function runTurn(st, text, { files = [] } = {}) {
  const to = st.to; // куда отвечать (тема, из которой пришёл запрос)
  // в базу — текст запроса и имена приложенных файлов, иначе запрос только с файлом выглядел бы пустым
  const dbText = files.length ? [text, `📎 ${files.map((f) => f.name).join(', ')}`].filter(Boolean).join('\n') : text;
  const lang = langOf(st.userId);
  const engine = engineOf(st);
  // новая тема (создал бот по /new или пользователь без названия): назовём её по первому ответу агента
  const topicRow = st.topic ? db.getTopic(st.userId, st.topic) : null;
  const naming = Boolean(topicRow && !topicRow.named);
  // активность темы — порядок в списке тем проекта; написали в убранную из списка тему — она возвращается в список
  if (topicRow) db.saveTopic(st.userId, st.topic, { hidden: false });
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
    const d = composeDraft({ thought, steps, answer: stripTitle(stripSendMarks(clean(answer))), elapsedMs: Date.now() - startedAt, lang });
    const draft = d.plain ? '(точки Telegram)' : d.markdown;
    if (draft !== lastText) dbg(`draft u${st.userId}`, draft);
    lastText = draft;
    // keep_on_stop: после «стоп» написанное остаётся на экране, пока не придёт итоговый ответ (Bot API 10.3)
    const send = d.plain ? sendThinkingDraft(to, draftId, { can_stop: true }) : sendRichDraft(to, draftId, d.markdown, { can_stop: true, keep_on_stop: true });
    await send.catch((e) => {
      log('draft:', e.message);
      dbg('draft-error ' + e.message, draft);
    });
  };
  // Черновики строго по одному: если Telegram отвечает дольше секунды, следующий не уходит параллельно
  // (иначе они приходят не по порядку и старое состояние затирает новое), а пропускается до следующего тика.
  let inFlight = null;
  const pushDraft = () => {
    if (!inFlight) inFlight = sendDraft().finally(() => (inFlight = null));
    return inFlight;
  };
  const timer = setInterval(pushDraft, DRAFT_INTERVAL_MS);

  st.onUpdate = (u) => {
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
      // текст после вызова инструмента — новый абзац, иначе фразы склеиваются («…test.Команда…»)
      if (breakBeforeText && answer.trim()) answer += '\n\n';
      breakBeforeText = false;
      answer += u.content.text;
      dirty = true;
    } else if (kind === 'agent_thought_chunk' && u.content?.type === 'text') {
      // заголовок — **строка** без переводов строки, поэтому храним только незаконченную строку: раньше на каждом
      // фрагменте заново разбирались все рассуждения целиком (на длинных — квадратичная работа)
      const last = lastThoughtTitle(thoughtBuf + u.content.text);
      if (last.title) thought = last.title;
      thoughtBuf = last.rest;
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
    await pushDraft();
    // пока отправлялся черновик, сессию могли закрыть (/close, администратор) — агента не поднимаем
    if (st.suppress) throw new ClosedError();
    const a = (agent = await ensureAgent(st));
    // модель и уровень рассуждений — как выбрал пользователь (/model) и разрешил администратор
    await syncSelection(st.userId, a);
    st.requestId = db.startRequest(a.dbSessionId, dbText);
    const outbox = outboxDir(st.userId);
    mkdirSync(outbox, { recursive: true });
    // подсказка агенту, как прислать файл: в первом запросе сессии и затем раз в OUTBOX_NOTE_EVERY запросов
    // (агент мог сжать контекст и забыть её), а не в каждом — она попадает в историю и тратит токены
    const noteNow = (a.promptCount ?? 0) % OUTBOX_NOTE_EVERY === 0;
    a.promptCount = (a.promptCount ?? 0) + 1;
    const blocks = buildPromptBlocks({ text, files, caps: a.caps, outbox: noteNow ? outbox : null });
    // новая тема без названия: агент начинает ответ строкой с названием, бот называет так тему
    if (naming) blocks.push({ type: 'text', text: TITLE_NOTE });
    const res = await a.prompt(blocks);
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
      answer += `\n\n${t('turn.error', lang, { msg: e.message })}`;
    }
    if (!st.requestId) st.requestId = db.startRequest(st.agent?.dbSessionId ?? null, dbText);
  } finally {
    clearInterval(timer);
    st.onUpdate = null;
    dropPermissions(st);
    st.busy = false;
    st.lastActive = Date.now();
  }
  // последний черновик должен дойти раньше итогового ответа, иначе он «оживёт» поверх ответа;
  // но зависший запрос к Telegram не должен задерживать сам ответ — ждём не дольше DRAFT_WAIT_MS
  if (inFlight) await Promise.race([inFlight, new Promise((r) => setTimeout(r, DRAFT_WAIT_MS).unref())]);

  // метки [[send:путь]] (вне кода) → заглушки: на их место встанут сами файлы
  const titled = extractTitle(clean(answer)); // строка с названием темы — в название, а не в ответ
  const sent = extractSendMarks(titled.text, { placeholders: true });
  const answerText = sent.text.replace(FILE_PLACEHOLDER, '').trim(); // ответ без файлов: для базы и проверки «пустой ли»
  db.finishRequest(st.requestId, { stopReason, answer: answerText, error, usage: usage ?? {} });
  st.requestId = null;
  if (st.suppress) {
    // администратор отозвал доступ или сменил уровень — результат пользователю не отправляем
    st.suppress = false;
    return;
  }
  let final = answerText ? sent.text.trim() : sent.paths.length && !limited ? `${t('turn.files', lang)}\n\n${sent.text.trim()}` : t('turn.empty', lang);
  if (stopReason === 'cancelled') final += `\n\n${t('turn.stopped', lang)}`;
  // файлы — прямо в ответе, на месте меток (Bot API 10.3); не поместившиеся по размеру — отдельно после ответа
  const placed = limited
    ? { text: final.replace(FILE_PLACEHOLDER, ''), media: {}, extra: [] }
    : attachFiles(final, sent.paths, {
        cwd: agent?.cwd ?? st.project,
        outbox: outboxDir(st.userId),
        failText: (name, reason) => t('file.sendFail', lang, { name, why: t(`file.why.${reason}`, lang) }),
        onSkip: (p, reason) => log(`файл агента не отправлен (${reason}):`, p, '| пользователь', st.userId),
      });
  // свёрнутый ход работы и подвал (движок, модель, расход, проект, время); для «все слоты заняты» не нужны
  const extras = limited ? '' : finalExtras({ steps, elapsedMs: Date.now() - startedAt, project: showPath(st.project, lang), engine: engine.short, usage, lang });
  const loose = []; // файлы, которые Telegram не принял внутри ответа
  for (const msg of finalMessages(placed.text, extras)) {
    dbg(`final u${st.userId} stop=${stopReason}`, msg);
    const left = await sendRich(to, msg, { media: placed.media }).catch((e) => {
      log('sendRich:', e.message);
      return mediaIdsOf(msg).map((id) => placed.media[id]).filter(Boolean);
    });
    loose.push(...left);
  }
  const inAnswer = Object.keys(placed.media).length - loose.length;
  if (inAnswer > 0) log('файлы в ответе:', inAnswer, '| пользователь', st.userId);
  if (loose.length || placed.extra.length) await sendLooseFiles(st, [...loose, ...placed.extra], lang);
  if (naming && !limited && stopReason !== 'error') await nameTopic(st, titled.title || titleFromRequest(text || dbText));
}

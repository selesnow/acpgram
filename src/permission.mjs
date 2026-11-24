import { db, langOf, log, say } from './ctx.mjs';
import { clipText } from './clip.mjs';
import { permissionOptions } from './engines.mjs';
import { SESSION_OPTION_ID, allowOnceOption, describeRule, permissionKeys, rulesAllow, withSessionOption } from './permRules.mjs';
import { t } from './i18n.mjs';
import { engineOf, modeFor, setPermissionHandler } from './state.mjs';
import { diffOf, parseTool } from './tools.mjs';
import { lineDiff } from './diff.mjs';
import { dest, escHtml, tg } from './telegram.mjs';
import { trunc } from './ui.mjs';
import { cbCtx } from './uiActions.mjs';
import { toolMeta } from './ui.mjs';

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const PERM_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
let permSeq = 0;

/**
 * Подпись варианта бота «на эту сессию»: что именно будет разрешено дальше без вопроса («git status …», только эта
 * команда, все действия этого вида) — чтобы пользователь видел широту правила до нажатия.
 */
function sessionRuleLabel(keys, what, lang) {
  const rule = describeRule(keys);
  if (!rule) return t('perm.opt.allow_always', lang);
  const text = rule.type === 'exec' ? t('perm.opt.session.exec', lang, { what: rule.what }) : rule.type === 'exact' ? t('perm.opt.session.exact', lang) : t('perm.opt.session.all', lang, { what });
  return trunc(text, 60);
}

/** Подпись кнопки: варианты, меняющие режим сессии (выход из плана у Claude Code), — своим текстом агента. */
function optionLabel(engine, o, lang, rule = null) {
  if (engine.optionMode?.(o)) return `▶️ ${o.name}`;
  if (o.synthetic && rule) return sessionRuleLabel(rule.keys, rule.what, lang);
  if (PERM_KINDS.includes(o.kind)) return t(`perm.opt.${o.kind}`, lang);
  return o.name;
}

const seenOptions = new Set();
function noteOptions(engine, options) {
  for (const o of options) {
    const key = `${engine.id}|${o.optionId}|${o.kind}`;
    if (seenOptions.has(key)) continue;
    seenOptions.add(key);
    log('вариант разрешения агента:', engine.id, '| id', o.optionId, '| вид', o.kind, '|', JSON.stringify(o.name ?? ''));
  }
}

const resultLabel = (engine, o, lang) =>
  engine.optionMode?.(o) ? `▶️ ${o.name}` : o.kind.startsWith('reject') && PERM_KINDS.includes(o.kind) ? t('perm.res.reject', lang) : PERM_KINDS.includes(o.kind) ? t(`perm.res.${o.kind}`, lang) : o.name;

const optionStyle = (engine, o) => (engine.optionMode?.(o) ? 'primary' : o.kind.startsWith('allow') ? 'success' : o.kind.startsWith('reject') ? 'danger' : undefined);

function settlePermissionMessage(chatId, messageId, label, style, fallbackText) {
  const button = { text: label, disabled: {}, ...(style ? { style } : {}) };
  return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [[button]] } }).catch((e) => {
    log('кнопка итога разрешения:', e.message);
    return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: fallbackText.slice(0, 4000) }).catch(() => {});
  });
}

export async function askPermission(st, params) {
  const seq = ++permSeq;
  const lang = langOf(st.userId);
  const clipped = (value, max) => {
    const s = String(value ?? '');
    return s.length <= max ? s : clipText(s, Math.ceil(max / 2), Math.floor(max / 2), t('perm.trimmed', lang, { shown: max, total: s.length }));
  };
  const tc = params.toolCall || {};
  const engine = engineOf(st);
  const info = parseTool(tc, engine);
  noteOptions(engine, params.options || []);
  const allowed = permissionOptions(engine, params.options || [], modeFor(st.userId, engine));
  const what = info.description || info.title || info.tool;
  const meta = toolMeta(info.tool, info.kind, lang);
  const head = `${meta.icon} ${meta.label}`;
  const dbId = () => db.permissionAsked(st.requestId, tc.toolCallId, info.title || what, params.options);

  const agent = st.agent;
  const keys = permissionKeys({ kind: info.kind, tool: info.tool, command: info.kind === 'execute' ? tc.rawInput?.command || info.title : null });
  const once = allowOnceOption(allowed, engine.optionMode);
  if (once && rulesAllow(agent?.sessionRules, keys)) {
    db.permissionAnswered(dbId(), once.optionId, 'auto-allowed');
    log('разрешено правилом сессии', st.userId, keys.join(' '));
    return { outcome: 'selected', optionId: once.optionId };
  }
  const options = withSessionOption(allowed, keys, engine.optionMode);

  if (!options.some((o) => o.kind.startsWith('allow'))) {
    const reject = options.find((o) => o.kind.startsWith('reject'));
    const id = dbId();
    db.permissionAnswered(id, reject?.optionId ?? null, reject ? 'auto-rejected' : 'cancelled');
    say(st.to, t('perm.blocked', lang, { head, what: clipped(what, 300) }));
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  }
  const isCmd = info.kind === 'execute' && info.title;
  const body = isCmd
    ? `${escHtml(clipped(info.description || t('step.command', lang), 400))}\n\n<pre>${escHtml(clipped(info.title, 1200))}</pre>`
    : `<code>${escHtml(clipped(what, 600))}</code>`;
  const change = isCmd ? null : diffOf(tc);
  const diff = change ? lineDiff(change.oldText, change.newText, { maxLines: 30 }).text : '';
  const diffBlock = diff ? `\n\n<pre><code class="language-diff">${escHtml(clipped(diff, 1800))}</code></pre>` : '';
  const text = `${t('perm.ask', lang)}\n\n<b>${escHtml(head)}</b>: ${body}${diffBlock}`;

  const permId = dbId();
  const msg = await tg('sendMessage', {
    ...dest(st.to),
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: options.map((o, i) => {
        const style = optionStyle(engine, o);
        return [{ text: optionLabel(engine, o, lang, { keys, what: meta.label }), callback_data: `perm:${seq}:${i}`, ...(style ? { style } : {}) }];
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
      options,
      engine,
      agent,
      keys,
      once,
      title: `${head}: ${what}`,
      dbId: permId,
      messageId: msg.message_id,
      chatId,
      resolve: (o) => {
        clearTimeout(timer);
        resolve(o);
      },
      onDrop: () => settlePermissionMessage(chatId, msg.message_id, t('perm.res.cancelled', lang), undefined, `${t('perm.res.cancelled', lang)}\n${head}: ${what}`),
    });
  });
}

setPermissionHandler(askPermission);

export async function onPermissionCallback(st, cb) {
  const m = /^perm:(\d+):(\d+)$/.exec(cb.data || '');
  const p = m && st.perms.get(Number(m[1]));
  const lang = langOf(st.userId);
  const { ack } = cbCtx(st, cb);
  if (!p) return ack(t('perm.stale', lang));
  const opt = p.options[Number(m[2])];
  if (!opt) return ack(t('perm.badOption', lang));
  st.perms.delete(Number(m[1]));
  db.permissionAnswered(p.dbId, opt.optionId, 'selected');
  if (opt.optionId === SESSION_OPTION_ID) {
    if (p.agent) {
      p.agent.sessionRules ??= new Set();
      for (const k of p.keys) p.agent.sessionRules.add(k);
      log('правило сессии добавлено', st.userId, p.keys.join(' '));
    }
    p.resolve({ outcome: 'selected', optionId: p.once.optionId });
  } else p.resolve({ outcome: 'selected', optionId: opt.optionId });
  await ack();
  const label = resultLabel(p.engine, opt, lang);
  await settlePermissionMessage(p.chatId, p.messageId, label, optionStyle(p.engine, opt), `${label}\n${p.title}`);
}

// Команда /sessions: возврат к прошлой сессии в текущем проекте (сессия возобновляется в том движке, где была создана).
// Экран — виджет с карточками сессий (widgets.mjs); если виджеты выключены или не поместились — сообщение с кнопками.
import { db, langOf, log, say } from './ctx.mjs';
import { canUseEngine } from './access.mjs';
import { ENGINES, getEngine, isAvailable } from './engines.mjs';
import { LOCALES, errText, t } from './i18n.mjs';
import { ClosedError, LimitError, ProjectError, endAgent, engineOf, ensureAgent, saveEngine, userPath } from './state.mjs';
import { dest, escHtml, tg } from './telegram.mjs';
import { drainQueue } from './turn.mjs';
import { trunc } from './ui.mjs';
import { sendWidgetMessage } from './widgetHost.mjs';
import { sessionsWidget, widgetFits } from './widgets.mjs';

const LIST_LIMIT = 10;
/** В виджете сессии листаются страницами, поэтому их больше, чем кнопок в обычном списке. */
const WIDGET_LIMIT = 30;

const when = (iso, lang) => new Date(iso).toLocaleString(LOCALES[lang] ?? LOCALES.en, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** «12.11, 14:30 · Claude · 5 запр.» — подпись сессии в списке и в виджете. */
const sessionLabel = (s, lang) => `${when(s.last_at, lang)} · ${getEngine(s.engine).short} · ${t('ses.reqs', lang, { n: s.n })}`;

/**
 * HTML виджета сессий проекта: столько сессий, сколько помещается в лимит Telegram (начала запросов сжимаются плохо,
 * поэтому при переполнении список укорачивается). null — не поместилось даже несколько.
 */
export function sessionsWidgetHtml({ list, current = null, project, lang }) {
  const sessions = list.map((s) => ({ id: s.acp_id, label: sessionLabel(s, lang), text: trunc(oneLine(s.first_text), 110) }));
  for (let n = sessions.length; n >= 3; n -= 3) {
    const html = sessionsWidget({ sessions: sessions.slice(0, n), current, title: t('ses.widTitle', lang, { p: project, n }), texts: { err: t('wid.err', lang) } });
    if (widgetFits(html)) return html;
  }
  return null;
}

/** @param {{classic?: boolean}} [opts] classic — обычный список с кнопками (кнопка «Обычное меню» под виджетом) */
export async function handleSessions(st, { classic = false } = {}) {
  const lang = langOf(st.userId);
  const project = userPath(st.userId, st.project, lang);
  const list = db.listSessions(st.userId, st.project, classic ? LIST_LIMIT : WIDGET_LIMIT);
  if (!list.length) return say(st.to, t('ses.none', lang, { p: project }));
  const current = st.agent?.sessionId ?? null;
  if (!classic) {
    const html = sessionsWidgetHtml({ list, current, project, lang });
    if (html && (await sendWidgetMessage(st, { html, caption: t('ses.widCaption', lang), kind: 'sessions' }))) return;
  }
  const v = sessionsView({ list: list.slice(0, LIST_LIMIT), current, project, lang });
  return tg('sendMessage', { ...dest(st.to), text: v.text, parse_mode: 'HTML', reply_markup: v.markup }).catch((e) => log('sessions:', e.message));
}

/**
 * Экран /sessions без виджета: подробности сессий — в тексте (дата, движок, число запросов, начало первого запроса),
 * а кнопки короткие, с номером. Раньше всё это втискивалось в подпись кнопки на 60 символов.
 * @param {{list: {acp_id:string, engine:string, last_at:string, n:number, first_text:string}[], current?: string|null, project: string, lang?: string}} o
 */
export function sessionsView({ list, current = null, project, lang }) {
  const lines = list.map((s, i) => {
    const head = `<b>${i + 1}.</b> ${s.acp_id === current ? '▶️ ' : ''}${escHtml(sessionLabel(s, lang))}`;
    return `${head}\n<i>${escHtml(trunc(oneLine(s.first_text), 120))}</i>`;
  });
  const buttons = list.map((s, i) => ({ text: `${s.acp_id === current ? '▶ ' : ''}${i + 1} · ${when(s.last_at, lang)}`, callback_data: `ses:${s.acp_id}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { text: `${escHtml(t('ses.list', lang, { p: project }))}\n\n${lines.join('\n\n')}`, markup: { inline_keyboard: rows } };
}

/**
 * Можно ли возобновить сессию item (строка db.listSessions этого пользователя и проекта — id из кнопки или виджета
 * на веру не берём). Возвращает {error} с текстом для пользователя или {engine} — движок сессии.
 */
export function checkResumable(st, item) {
  const lang = langOf(st.userId);
  if (!item) return { error: t('ses.notFound', lang) };
  if (st.agent?.sessionId === item.acp_id) return { error: t('ses.alreadyActive', lang) };
  const engine = ENGINES[item.engine] ?? getEngine(null);
  if (!isAvailable(engine.id)) return { error: t('ses.engineDown', lang, { engine: engine.label }) };
  if (!canUseEngine(st.userId, engine.id)) return { error: t('ses.engineOff', lang, { engine: engine.label }) };
  return { engine };
}

/**
 * Возобновляет сессию: закрывает текущий процесс и поднимает новый с загрузкой истории.
 * @param {(text: string) => Promise<unknown>} report куда показывать ход и итог (правка сообщения с кнопками или новое сообщение)
 */
export async function resumeSession(st, item, engine, report) {
  const lang = langOf(st.userId);
  const label = trunc(oneLine(item.first_text), 80);
  await report(t('ses.resuming', lang, { when: when(item.last_at, lang), label }));
  st.busy = true; // пока идёт загрузка, новые запросы не принимаем
  const prevEngine = st.engine; // выбор пользователя до возобновления — вернём, если не получится
  let switched = false;
  try {
    endAgent(st, 'resume');
    // сессия живёт в своём движке: при необходимости переключаем выбор пользователя на него
    switched = engineOf(st).id !== engine.id;
    if (switched) saveEngine(st, engine.id);
    await ensureAgent(st, { resume: item.acp_id });
    st.lastActive = Date.now();
    await report(t('ses.resumed', lang, { label, engine: engine.label, switched: switched ? t('ses.switched', lang, { engine: engine.label }) : '' }));
  } catch (e) {
    log('ошибка возобновления сессии:', e.message);
    if (switched) saveEngine(st, prevEngine); // не удалось — движок пользователя не меняем
    await report(
      e instanceof LimitError || e instanceof ProjectError ? e.message
      : e instanceof ClosedError ? t('ses.cancelled', lang)
      : t('ses.failed', lang, { msg: errText(e, lang) }),
    );
  } finally {
    st.busy = false;
  }
  return drainQueue(st); // сообщение, присланное во время загрузки, уходит в возобновлённую сессию
}

/** Кнопка ses:<id> обычного списка. */
export async function onSessionCallback(st, cb) {
  const id = (cb.data || '').slice('ses:'.length);
  const lang = langOf(st.userId);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text, show_alert: true } : {}) }).catch(() => {});
  const edit = (text) =>
    tg('editMessageText', { chat_id: cb.message?.chat?.id, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch((e) => log('sessions edit:', e.message));

  if (st.busy) return ack(t('busy.stop', lang));
  const item = db.listSessions(st.userId, st.project, 50).find((s) => s.acp_id === id);
  const check = checkResumable(st, item);
  if (check.error) return ack(check.error);
  await ack();
  return resumeSession(st, item, check.engine, edit);
}

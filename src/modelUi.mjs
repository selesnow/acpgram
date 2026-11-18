// Команда /model: модель и уровень рассуждений текущего движка. Выбор запоминается для пользователя отдельно по движкам
// и применяется к живой сессии перед следующим запросом (turn.mjs → syncSelection).
// /model <запрос> — поиск модели по названию (при большом каталоге, как у OpenCode, — самый быстрый путь).
import { allowedModels, catalogStaleReason, effectiveSelection, getCatalog, modelRestriction, probeCatalog, pushRecentModel, recentModels, saveChoice } from './access.mjs';
import { langOf, log, say } from './ctx.mjs';
import { engineVersion } from './engines.mjs';
import { t } from './i18n.mjs';
import { engineOf } from './state.mjs';
import { tg } from './telegram.mjs';
import { modelChosen, modelGroupMenu, modelMenu, modelSearchMenu } from './ui.mjs';

/**
 * Каталог движка. Нет каталога — запрашиваем у агента в фоне, пользователю «ещё загружается». Каталог устарел (сутки,
 * новая версия движка, другой набор ключей API) — запрашиваем заново и ждём, чтобы список был актуальным; не получилось —
 * показываем прежний. Один запуск на движок, после неудачи пауза.
 */
async function catalogOf(engine, lang, to) {
  const c = getCatalog(engine.id);
  const reason = catalogStaleReason(c, engineVersion(engine.id));
  if (reason === null) return c;
  const run = probeCatalog(engine);
  if (!c) {
    run.catch((e) => log(`${engine.label}: список моделей не получен — ${e.message}`));
    return c;
  }
  log(`${engine.label}: список моделей обновляется по запросу /model — ${reason}`);
  await say(to, t('model.refreshing', lang, { engine: engine.label }));
  try {
    return (await run) ?? c;
  } catch (e) {
    log(`${engine.label}: список моделей не обновлён, показан прежний — ${e.message}`);
    return c;
  }
}

function view(st, engine, catalog) {
  const sel = effectiveSelection(st.userId, engine);
  return modelMenu({
    engine,
    models: allowedModels(st.userId, engine.id),
    efforts: engine.effortConfig ? catalog.efforts : [],
    model: sel.model,
    effort: sel.effort,
    restricted: Boolean(modelRestriction(st.userId, engine.id)),
    recent: recentModels(st.userId, engine.id),
    lang: langOf(st.userId),
  });
}

/** /model — экран выбора; /model <запрос> — модели, в названии или id которых есть все слова запроса. */
export async function handleModel(st, query = '') {
  const engine = engineOf(st);
  const lang = langOf(st.userId);
  const catalog = await catalogOf(engine, lang, st.to);
  if (!catalog) return say(st.to, t('model.loading', lang, { engine: engine.label }));
  const q = String(query ?? '').trim();
  const v = q
    ? modelSearchMenu({ engine, models: allowedModels(st.userId, engine.id), query: q, model: effectiveSelection(st.userId, engine).model, lang })
    : view(st, engine, catalog);
  return say(st.to, v.text, { reply_markup: v.markup });
}

/**
 * Кнопки /model:
 *   mdl:<движок>:<m|e>:<id | #номер | ~>        — выбор модели или уровня рассуждений (~ — «Авто»);
 *   mdl:<движок>:g:<группа>:<страница> | g:~     — экран группы моделей или «Назад» к группам;
 *   mdl:<движок>:s:<группа>:<вендор>:<страница>  — модели вендора внутри группы (OpenRouter).
 */
export async function onModelCallback(st, cb) {
  const m = /^mdl:([a-z]+):([megs]):(.+)$/.exec(cb.data || '');
  const lang = langOf(st.userId);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const engine = engineOf(st);
  if (!m || m[1] !== engine.id) return ack(t('model.engineChanged', lang));
  const catalog = getCatalog(engine.id);
  if (!catalog) return ack(t('model.noCatalog', lang));
  if (m[2] === 'g' || m[2] === 's') {
    // группа или вендор (или «Назад» к группам, ~): меню меняется на месте, выбор не сохраняется
    await ack();
    const parts = m[3].split(':');
    const [group, sub, page] = m[2] === 'g' ? [parts[0], null, parts[1]] : parts;
    const sel = effectiveSelection(st.userId, engine);
    const v = group === '~' ? view(st, engine, catalog) : modelGroupMenu({ engine, models: allowedModels(st.userId, engine.id), group, sub, page: Number(page) || 0, model: sel.model, lang });
    return tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text: v.text, reply_markup: v.markup }).catch((e) => log('model menu:', e.message));
  }
  const kind = m[2] === 'm' ? 'model' : 'effort';
  // выбирать можно только из того, что показали: разрешённые модели или уровни рассуждений движка
  const list = kind === 'model' ? allowedModels(st.userId, engine.id) : engine.effortConfig ? catalog.efforts : [];
  let value = null;
  if (m[3] !== '~') {
    value = m[3].startsWith('#') ? list[Number(m[3].slice(1))]?.id : list.find((x) => x.id === m[3])?.id;
    if (!value) return ack(t('model.badOption', lang));
  } else if (kind === 'model' && modelRestriction(st.userId, engine.id)) {
    return ack(t('model.noAuto', lang));
  }
  saveChoice(st.userId, engine.id, kind, value);
  if (kind === 'model' && value) pushRecentModel(st.userId, engine.id, value); // кнопки «🕘» на экране /model
  log(`${kind} выбран:`, st.userId, engine.id, value ?? 'auto');
  await ack(t(kind === 'model' ? 'model.set' : 'effort.set', lang));
  // как в /engine: меню заменяется итогом выбора, кнопки убираются
  const sel = effectiveSelection(st.userId, engine);
  const text = modelChosen({ engine, models: allowedModels(st.userId, engine.id), efforts: engine.effortConfig ? catalog.efforts : [], model: sel.model, effort: sel.effort, lang });
  return tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(st.to, text));
}

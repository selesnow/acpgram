// Команда /model: модель и уровень рассуждений текущего движка. Выбор запоминается для пользователя отдельно по движкам
// и применяется к живой сессии перед следующим запросом (turn.mjs → syncSelection).
import { allowedModels, effectiveSelection, getCatalog, modelRestriction, probeCatalog, saveChoice } from './access.mjs';
import { langOf, log, say } from './ctx.mjs';
import { t } from './i18n.mjs';
import { engineOf } from './state.mjs';
import { tg } from './telegram.mjs';
import { modelChosen, modelMenu } from './ui.mjs';

/** Каталог движка; если его ещё нет — запрашиваем у агента в фоне (один запуск на движок, с паузой после неудачи). */
function catalogOf(engine) {
  const c = getCatalog(engine.id);
  if (!c) probeCatalog(engine).catch((e) => log(`${engine.label}: список моделей не получен — ${e.message}`));
  return c;
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
    lang: langOf(st.userId),
  });
}

export async function handleModel(st) {
  const engine = engineOf(st);
  const catalog = catalogOf(engine);
  if (!catalog) return say(st.to, t('model.loading', langOf(st.userId), { engine: engine.label }));
  const v = view(st, engine, catalog);
  return say(st.to, v.text, { reply_markup: v.markup });
}

/** Кнопка mdl:<движок>:<m|e>:<id | #номер | ~>. */
export async function onModelCallback(st, cb) {
  const m = /^mdl:([a-z]+):([me]):(.+)$/.exec(cb.data || '');
  const lang = langOf(st.userId);
  const ack = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const engine = engineOf(st);
  if (!m || m[1] !== engine.id) return ack(t('model.engineChanged', lang));
  const catalog = getCatalog(engine.id);
  if (!catalog) return ack(t('model.noCatalog', lang));
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
  log(`${kind} выбран:`, st.userId, engine.id, value ?? 'auto');
  await ack(t(kind === 'model' ? 'model.set' : 'effort.set', lang));
  // как в /engine: меню заменяется итогом выбора, кнопки убираются
  const sel = effectiveSelection(st.userId, engine);
  const text = modelChosen({ engine, models: allowedModels(st.userId, engine.id), efforts: engine.effortConfig ? catalog.efforts : [], model: sel.model, effort: sel.effort, lang });
  return tg('editMessageText', { chat_id: cb.message?.chat?.id ?? st.chatId, message_id: cb.message?.message_id, text, reply_markup: { inline_keyboard: [] } }).catch(() => say(st.to, text));
}

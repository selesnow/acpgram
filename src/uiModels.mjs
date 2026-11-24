import { DEFAULT_LANG, t } from './i18n.mjs';
import { clampPage, pageNav } from './pagination.mjs';
import { cbValue, rowsOf } from './uiShared.mjs';

// ---------- группы моделей (движки с modelGroups: OpenCode) ----------

/** Моделей на странице группы (по 2 в ряд). */
export const MODEL_PAGE = 20;
/** id группы бесплатных моделей (id провайдеров — латиница без «+»). */
export const FREE_GROUP = '+free';

/** Входит ли модель в группу. */
export const inModelGroup = (m, group) => (group === FREE_GROUP ? Boolean(m.free) : m.group === group);

/**
 * Группы моделей: сначала «Бесплатные» (если есть), затем провайдеры в порядке каталога. Пусто — моделей без групп.
 * @param {{group?:string, groupLabel?:string, free?:boolean}[]} models
 * @returns {{id:string, label:string|null, count:number}[]}  label null — «Бесплатные» (название на языке пользователя)
 */
export function modelGroupsOf(models) {
  if (!models.some((m) => m.group)) return [];
  const free = models.filter((m) => m.free).length;
  const by = new Map();
  for (const m of models) {
    if (!m.group) continue;
    const g = by.get(m.group) ?? { id: m.group, label: m.groupLabel || m.group, count: 0 };
    g.count++;
    by.set(m.group, g);
  }
  return [...(free ? [{ id: FREE_GROUP, label: null, count: free }] : []), ...by.values()];
}

export const groupTitle = (g, lang) => (g.id === FREE_GROUP ? `🆓 ${t('model.freeGroup', lang)}` : g.label);

/** id подгруппы «Прочие»: вендоры с 1–2 моделями (id вендоров — латиница без «+»). */
export const OTHER_SUB = '+other';
/** Вендоров на странице подгрупп. */
const SUB_PAGE = 30;
/** Вендор с таким числом моделей и меньше уходит в «Прочие». */
const SMALL_SUB = 2;

/**
 * Подгруппы (вендоры) группы-агрегатора — OpenRouter: «openrouter/anthropic/…». Самые большие первыми, вендоры
 * с 1–2 моделями — в «Прочие» (если таких хотя бы два). Пусто — подгрупп нет.
 * @param {{sub?:string, subLabel?:string}[]} list модели группы
 * @returns {{subs: {id:string, label:string|null, count:number}[], small: Set<string>}}  label null — «Прочие»
 */
export function modelSubgroupsOf(list) {
  if (!list.some((m) => m.sub)) return { subs: [], small: new Set() };
  const by = new Map();
  for (const m of list) {
    const id = m.sub ?? OTHER_SUB;
    const s = by.get(id) ?? { id, label: m.subLabel || m.sub || null, count: 0 };
    s.count++;
    by.set(id, s);
  }
  const all = [...by.values()].filter((s) => s.id !== OTHER_SUB);
  const smallList = all.filter((s) => s.count <= SMALL_SUB);
  const small = new Set(smallList.length >= 2 ? smallList.map((s) => s.id) : []);
  const other = (by.get(OTHER_SUB)?.count ?? 0) + smallList.filter((s) => small.has(s.id)).reduce((n, s) => n + s.count, 0);
  const subs = all.filter((s) => !small.has(s.id)).sort((a, b) => b.count - a.count);
  return { subs: [...subs, ...(other ? [{ id: OTHER_SUB, label: null, count: other }] : [])].map((x, index) => ({ ...x, index })), small };
}

export const subTitle = (s, lang) => (s.id === OTHER_SUB ? t('model.otherSub', lang) : s.label);

/**
 * Что показать в группе: подгруппы (вендоры, если группа большая и они есть) или модели постранично
 * (с их номером во всём списке — для кнопок с длинным id). sub — открытая подгруппа.
 */
export function browseGroup(models, group, sub = null, page = 0) {
  const inGroup = models.map((m, i) => ({ m, i })).filter(({ m }) => inModelGroup(m, group));
  const { subs, small } = group === FREE_GROUP ? { subs: [], small: new Set() } : modelSubgroupsOf(inGroup.map(({ m }) => m));
  // «#номер» — вендор с длинным id, не поместившимся в callback_data (subRef)
  if (typeof sub === 'string' && sub.startsWith('#')) sub = subs[Number(sub.slice(1))]?.id ?? null;
  if (subs.length > 1 && inGroup.length > MODEL_PAGE && sub == null) {
    const pg = clampPage(page, subs.length, SUB_PAGE);
    return { mode: 'subs', subs: subs.slice(pg.page * SUB_PAGE, (pg.page + 1) * SUB_PAGE), small, total: inGroup.length, ...pg };
  }
  const inSub = (m) => sub == null || (sub === OTHER_SUB ? !m.sub || small.has(m.sub) : m.sub === sub);
  const items = inGroup.filter(({ m }) => inSub(m));
  const pg = clampPage(page, items.length, MODEL_PAGE);
  const subInfo = sub == null ? null : subs.find((s) => s.id === sub) ?? { id: sub, label: sub, count: items.length, index: -1 };
  return { mode: 'models', items: items.slice(pg.page * MODEL_PAGE, (pg.page + 1) * MODEL_PAGE), total: items.length, sub: subInfo, ...pg };
}

/**
 * Вендор в callback_data: его id или «#номер» среди вендоров группы, если с id кнопка (prefix + вендор + «:страница»)
 * не влезает в 64 байта Telegram.
 */
export const subRef = (prefix, s) => (Buffer.byteLength(`${prefix}${s.id}:999`) <= 64 ? s.id : `#${s.index}`);

/**
 * Название модели внутри группы: без провайдера; внутри вендора — и без вендора («Anthropic: Claude…» → «Claude…»),
 * а в «Прочих» — с вендором впереди, иначе непонятно, чья модель; в группе провайдера бесплатные — с 🆓.
 * @param {string|null} sub открытая подгруппа (вендор)
 */
export const shortName = (m, group, sub = null) => {
  let name = (group === FREE_GROUP ? m.name : m.short) || m.name;
  if (sub && sub !== OTHER_SUB && m.subLabel && name.startsWith(`${m.subLabel}: `)) name = name.slice(m.subLabel.length + 2);
  if (sub === OTHER_SUB && m.subLabel && !name.startsWith(m.subLabel)) name = `${m.subLabel} · ${name}`;
  return `${group !== FREE_GROUP && m.free ? '🆓 ' : ''}${name}`;
};

/** Кнопки моделей: ✓ у выбранной, callback — mdl:<движок>:m:<id или #номер во всём списке>. */
const modelButtonsOf = (engine, items, model, label) => items.map(({ m, i }) => ({ text: `${m.id === model ? '✓ ' : ''}${label(m)}`, callback_data: cbValue(`mdl:${engine.id}:m:`, m.id, i) }));

/** Поиск моделей: все слова запроса есть в id или названии (без учёта регистра). */
export function searchModels(models, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return models.map((m, i) => ({ m, i })).filter(({ m }) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Экран /model: модели и уровни рассуждений движка. Кнопки: mdl:<движок>:m:<id> / mdl:<движок>:e:<id>, «Авто» — ~.
 * Если у моделей есть группы (OpenCode: сотни моделей подключённых провайдеров) — вместо списка кнопки групп
 * mdl:<движок>:g:<группа>:<страница>, модели — на экране группы (modelGroupMenu).
 * @param {{engine: {id:string,label:string}, models: {id,name}[], efforts: {id,name}[], model: string|null, effort: string|null,
 *   restricted?: boolean, lang?: string}} o  model/effort — текущий выбор (null — «Авто»); restricted — модели ограничены администратором (без «Авто»)
 */
export function modelMenu({ engine, models, efforts = [], model, effort, restricted = false, recent = [], lang = DEFAULT_LANG }) {
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  const auto = t('auto', lang);
  const groups = modelGroupsOf(models);
  const text = [
    t('model.title', lang, { engine: engine.label }),
    t('model.now', lang, { name: model ? nameOf(models, model) : t('model.autoDesc', lang) }),
    ...(efforts.length ? [t('model.effort', lang, { name: effort ? nameOf(efforts, effort) : auto })] : []),
    ...(restricted ? [t('model.restricted', lang)] : []),
    ...(groups.length ? [t('model.pickGroup', lang), t('model.searchHint', lang)] : []),
    t('model.saved', lang),
  ].join('\n');
  const mark = (on, label) => `${on ? '✓ ' : ''}${label}`;
  const current = models.find((m) => m.id === model);
  // недавние модели (движки с группами): переключиться между любимыми — в одно нажатие
  const recentItems = groups.length ? recent.map((id) => ({ m: models.find((x) => x.id === id), i: models.findIndex((x) => x.id === id) })).filter(({ m }) => m) : [];
  const recentButtons = modelButtonsOf(engine, recentItems, model, (m) => `🕘 ${m.name}`);
  const modelButtons = [
    ...(restricted ? [] : [{ text: mark(!model, auto), callback_data: `mdl:${engine.id}:m:~` }]),
    ...(groups.length
      ? groups.map((g) => ({ text: mark(Boolean(current) && inModelGroup(current, g.id), `${groupTitle(g, lang)} (${g.count})`), callback_data: `mdl:${engine.id}:g:${g.id}:0` }))
      : models.map((m, i) => ({ text: mark(m.id === model, m.name), callback_data: cbValue(`mdl:${engine.id}:m:`, m.id, i) }))),
  ];
  const effortButtons = efforts.length
    ? [{ text: mark(!effort, `🧠 ${auto}`), callback_data: `mdl:${engine.id}:e:~` }, ...efforts.map((x, i) => ({ text: mark(x.id === effort, `🧠 ${x.name}`), callback_data: cbValue(`mdl:${engine.id}:e:`, x.id, i) }))]
    : [];
  return { text, markup: { inline_keyboard: [...rowsOf(recentButtons, 2), ...rowsOf(modelButtons, 2), ...rowsOf(effortButtons, 3)] } };
}

/**
 * Экран группы моделей в /model. Большая группа с вендорами (OpenRouter) — сначала вендоры (mdl:<движок>:s:<группа>:<вендор>:0),
 * иначе модели постранично (mdl:<движок>:m:<id>). Навигация — mdl:<движок>:g:<группа>:<стр> или mdl:<движок>:s:…:<стр>;
 * «Назад» из вендора — к вендорам группы, из группы — к группам (mdl:<движок>:g:~). У бесплатных — предупреждение о данных.
 */
export function modelGroupMenu({ engine, models, group, sub = null, page = 0, model, lang = DEFAULT_LANG }) {
  const g = modelGroupsOf(models).find((x) => x.id === group);
  const v = browseGroup(models, group, sub, page);
  const nameOf = (id) => models.find((x) => x.id === id)?.name ?? id;
  const title = `${g ? groupTitle(g, lang) : group}${v.sub ? ` › ${subTitle(v.sub, lang)}` : ''}: ${v.total}`;
  const text = [
    t('model.title', lang, { engine: engine.label }),
    t('model.now', lang, { name: model ? nameOf(model) : t('model.autoDesc', lang) }),
    '',
    title,
    ...(group === FREE_GROUP ? [t('model.freeNote', lang)] : []),
    ...(v.mode === 'subs' ? [t('model.pickSub', lang)] : []),
  ].join('\n');
  const current = models.find((m) => m.id === model);
  const subPrefix = `mdl:${engine.id}:s:${group}:`;
  const subButton = (s) => ({
    text: `${current && inModelGroup(current, group) && (!current.sub || v.small.has(current.sub) ? OTHER_SUB : current.sub) === s.id ? '✓ ' : ''}${subTitle(s, lang)} (${s.count})`,
    callback_data: `${subPrefix}${subRef(subPrefix, s)}:0`,
  });
  const buttons = v.mode === 'subs' ? v.subs.map(subButton) : modelButtonsOf(engine, v.items, model, (m) => shortName(m, group, v.sub?.id ?? null));
  const nav = v.mode === 'models' && v.sub ? (p) => `${subPrefix}${subRef(subPrefix, v.sub)}:${p}` : (p) => `mdl:${engine.id}:g:${group}:${p}`;
  return {
    text,
    markup: {
      inline_keyboard: [
        ...rowsOf(buttons, 2),
        ...pageNav(v.page, v.pages, nav),
        [{ text: t('btn.back', lang), callback_data: v.sub ? `mdl:${engine.id}:g:${group}:0` : `mdl:${engine.id}:g:~` }],
      ],
    },
  };
}

/** Результаты поиска /model <запрос>: до MODEL_PAGE моделей кнопками и «К группам» (mdl:<движок>:g:~). */
export function modelSearchMenu({ engine, models, query, model, lang = DEFAULT_LANG }) {
  const found = searchModels(models, query);
  const shown = found.slice(0, MODEL_PAGE);
  const text = [
    t('model.title', lang, { engine: engine.label }),
    found.length ? t('model.found', lang, { q: query, n: found.length }) : t('model.notFound', lang, { q: query }),
    ...(found.length > shown.length ? [t('model.foundMore', lang, { n: shown.length })] : []),
  ].join('\n');
  return {
    text,
    markup: { inline_keyboard: [...rowsOf(modelButtonsOf(engine, shown, model, (m) => `${m.free ? '🆓 ' : ''}${m.name}`), 1), [{ text: t('model.toGroups', lang), callback_data: `mdl:${engine.id}:g:~` }]] },
  };
}

/** Итог выбора в /model: вместо меню — какой движок и какая модель (и уровень рассуждений) теперь выбраны. */
export function modelChosen({ engine, models, efforts = [], model, effort, lang = DEFAULT_LANG }) {
  const nameOf = (list, id) => list.find((x) => x.id === id)?.name ?? id;
  return [
    t('model.chosenEngine', lang, { engine: engine.label }),
    t('model.chosenModel', lang, { name: model ? nameOf(models, model) : t('model.autoDesc', lang) }),
    ...(efforts.length ? [t('model.chosenEffort', lang, { name: effort ? nameOf(efforts, effort) : t('auto', lang) })] : []),
    t('model.saved', lang),
  ].join('\n');
}

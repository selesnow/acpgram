import { DEFAULT_LANG, plural, t } from './i18n.mjs';
import { pageNav } from './pagination.mjs';
import { fmtCost, fmtTokens } from './uiProgress.mjs';
import { cbValue, fmtDuration, rowsOf } from './uiShared.mjs';
import { browseGroup, groupTitle, inModelGroup, modelGroupsOf, modelSubgroupsOf, OTHER_SUB, shortName, subRef, subTitle } from './uiModels.mjs';

/** Движок, проект, время работы и занятость сессии: «Claude · team/proj, 12 мин, выполняет запрос». */
const sessionDetails = (s, projectOf, now, lang) =>
  `${s.topic ? `💬 ${s.topic} · ` : ''}${s.engine ? `${s.engine} · ` : ''}${projectOf(s.project)}, ${fmtDuration(now - s.startedAt, lang)}${s.busy ? t('session.busy', lang) : ''}`;

/**
 * Статус сессии сотрудника для карточки в /users.
 * @param {{project: string, startedAt: number, busy: boolean}|undefined} s активная сессия или undefined
 * @param {(p:string)=>string} projectOf как показывать путь проекта
 */
export function sessionStatus(s, projectOf = (p) => p, now = Date.now(), lang = DEFAULT_LANG) {
  return s ? t('session.active', lang, { details: sessionDetails(s, projectOf, now, lang) }) : t('session.idle', lang);
}

/**
 * Экран /active: все работающие сессии и кнопки завершения сессий сотрудников (adm:k:<id>:a).
 * Администратор в списке есть, но в лимит слотов не входит и кнопки завершения не получает.
 */
export function activeSessionsView({ sessions, adminId, maxAgents, nameOf, projectOf = (p) => p, now = Date.now(), lang = DEFAULT_LANG }) {
  const employees = sessions.filter((s) => s.userId !== adminId);
  const text = sessions.length
    ? `${t('active.summary', lang, { n: sessions.length, busy: employees.length, max: maxAgents })}\n` +
      sessions.map((s) => t('adm.session.line', lang, { name: nameOf(s.userId), details: sessionDetails(s, projectOf, now, lang) })).join('\n')
    : t('active.none', lang, { max: maxAgents });
  return {
    text,
    markup: {
      inline_keyboard: [
        ...employees.map((s) => [{ text: t('active.kill', lang, { name: nameOf(s.userId) }), callback_data: `adm:k:${s.userId}:a` }]),
        [{ text: t('btn.refresh', lang), callback_data: 'adm:act' }],
      ],
    },
  };
}

const USAGE_PERIODS = [1, 7, 30];

/**
 * Экран /usage администратора: кто сколько запросов сделал и токенов потратил за период; стоимость — если агент её присылал.
 * @param {{rows: {user_id:number, requests:number, tokens:number, cost:number|null}[], days: number, nameOf: (id:number)=>string, lang?: string}} o
 */
export function usageView({ rows, days, nameOf, lang = DEFAULT_LANG }) {
  const period = t(`usage.d${days}`, lang);
  const line = (name, r) =>
    t('usage.line', lang, { name, requests: plural(r.requests, 'request', lang), tokens: fmtTokens(r.tokens), cost: Number.isFinite(r.cost) && r.cost > 0 ? ` · $${fmtCost(r.cost)}` : '' });
  const total = rows.reduce((s, r) => ({ requests: s.requests + r.requests, tokens: s.tokens + r.tokens, cost: s.cost + (r.cost ?? 0) }), { requests: 0, tokens: 0, cost: 0 });
  const text = rows.length
    ? [t('usage.head', lang, { period }), ...rows.map((r) => `• ${line(nameOf(r.user_id), r)}`), '', line(t('usage.total', lang), total)].join('\n')
    : t('usage.none', lang, { period });
  return {
    text,
    markup: { inline_keyboard: [USAGE_PERIODS.map((d) => ({ text: `${d === days ? '✓ ' : ''}${t(`usage.d${d}`, lang)}`, callback_data: `adm:us:${d}` }))] },
  };
}

// ---------- права сотрудника в карточке /users (кнопки adm:*) ----------

/**
 * Строка «Движки: …» и кнопки-переключатели движков (adm:et:<id>:<движок>); движок по умолчанию выключить нельзя.
 * @param {{userId: number, engines: {id:string,label:string,granted:boolean,isDefault:boolean}[], lang?: string}} o
 */
export function engineGrants({ userId, engines, lang = DEFAULT_LANG }) {
  const list = engines
    .filter((e) => e.granted)
    .map((e) => e.label + (e.isDefault ? t('adm.engineDefault', lang) : ''))
    .join(', ');
  const line = t('adm.engines', lang, { list });
  const toggles = engines.filter((e) => !e.isDefault).map((e) => ({ text: `${e.granted ? '✅' : '⬜'} ${e.label}`, callback_data: `adm:et:${userId}:${e.id}` }));
  return { line, rows: [...rowsOf(toggles, 2), [{ text: t('adm.modelsBtn', lang), callback_data: `adm:mm:${userId}` }]] };
}

/**
 * Экран «Модели сотрудника»: по каждому выданному движку — сколько моделей разрешено (adm:me:<id>:<движок>).
 * @param {{userId: number, name: string, engines: {id:string,label:string,total:number,allowed:number|null}[], lang?: string}} o  allowed: null — все
 */
export function modelGrantsOverview({ userId, name, engines, lang = DEFAULT_LANG }) {
  const text = [
    t('adm.modelsTitle', lang, { name }),
    ...engines.map((e) => {
      const status = e.total === 0 ? t('adm.modelsNoCatalog', lang) : e.allowed == null ? t('adm.modelsAll', lang) : t('adm.modelsCount', lang, { a: e.allowed, t: e.total });
      return `• ${e.label}: ${status}`;
    }),
    t('adm.modelsPick', lang),
  ].join('\n');
  return {
    text,
    markup: { inline_keyboard: [...engines.map((e) => [{ text: e.label, callback_data: `adm:me:${userId}:${e.id}` }]), [{ text: t('adm.toUser', lang), callback_data: `adm:u:${userId}` }]] },
  };
}

/**
 * Переключатели моделей сотрудника в движке (adm:mt:<id>:<движок>:<id модели> или :#<номер> для длинных id),
 * «Разрешить все» (adm:ma:<id>:<движок>).
 * @param {{userId: number, name: string, engine: {id:string,label:string}, models: {id,name}[], allowed: string[]|null, lang?: string}} o
 */
export function modelGrantsView({ userId, name, engine, models, allowed, group = null, sub = null, page = 0, lang = DEFAULT_LANG }) {
  const on = (id) => allowed == null || allowed.includes(id);
  const groups = modelGroupsOf(models);
  const inGroup = groups.length && group != null && groups.some((g) => g.id === group);
  const text = [
    t('adm.engineModelsTitle', lang, { engine: engine.label, name }),
    allowed == null ? t('adm.modelsAllAllowed', lang) : t('adm.modelsSome', lang, { a: allowed.length, t: models.length }),
    groups.length && !inGroup ? t('adm.modelsPickGroup', lang) : t('adm.modelsHint', lang),
  ].join('\n');
  const v = inGroup ? browseGroup(models, group, sub, page) : null;
  // из вендора — к вендорам группы, из группы — к списку групп движка, из списка — к движкам
  const back = v?.sub ? `adm:mg:${userId}:${engine.id}:${group}:0` : inGroup ? `adm:me:${userId}:${engine.id}` : `adm:mm:${userId}`;
  const footer = [
    ...(allowed == null ? [] : [[{ text: t('adm.allowAllBtn', lang), callback_data: `adm:ma:${userId}:${engine.id}` }]]),
    [{ text: t('btn.back', lang), callback_data: back }],
  ];
  if (groups.length && !inGroup) {
    // моделей много: сначала группы (у каждой — сколько разрешено), переключатели — внутри группы
    const buttons = groups.map((g) => {
      const list = models.filter((m) => inModelGroup(m, g.id));
      const n = list.filter((m) => on(m.id)).length;
      return { text: `${groupTitle(g, lang)} ${n}/${list.length}`, callback_data: `adm:mg:${userId}:${engine.id}:${g.id}:0` };
    });
    return { text, markup: { inline_keyboard: [...rowsOf(buttons, 2), ...footer] } };
  }
  // id модели, а не номер: если список моделей изменится, кнопка не переключит чужую модель
  const toggle = (m, i, label) => ({ text: `${on(m.id) ? '✅' : '⬜'} ${label}`, callback_data: cbValue(`adm:mt:${userId}:${engine.id}:`, m.id, i) });
  if (inGroup) {
    const title = `${groupTitle(groups.find((g) => g.id === group), lang)}${v.sub ? ` › ${subTitle(v.sub, lang)}` : ''}`;
    if (v.mode === 'subs') {
      // вендоры группы (OpenRouter): у каждого — сколько разрешено
      const inGroupModels = models.filter((m) => inModelGroup(m, group));
      const { small } = modelSubgroupsOf(inGroupModels);
      const ofSub = (s) => inGroupModels.filter((m) => (s.id === OTHER_SUB ? !m.sub || small.has(m.sub) : m.sub === s.id));
      const buttons = v.subs.map((s) => {
        const list = ofSub(s);
        return { text: `${subTitle(s, lang)} ${list.filter((m) => on(m.id)).length}/${list.length}`, callback_data: `adm:ms:${userId}:${engine.id}:${group}:${subRef(`adm:ms:${userId}:${engine.id}:${group}:`, s)}:0` };
      });
      return {
        text: `${text}\n\n${title}`,
        markup: { inline_keyboard: [...rowsOf(buttons, 2), ...pageNav(v.page, v.pages, (p) => `adm:mg:${userId}:${engine.id}:${group}:${p}`), ...footer] },
      };
    }
    const toggles = v.items.map(({ m, i }) => toggle(m, i, shortName(m, group, v.sub?.id ?? null)));
    const nav = v.sub ? (p) => `adm:ms:${userId}:${engine.id}:${group}:${subRef(`adm:ms:${userId}:${engine.id}:${group}:`, v.sub)}:${p}` : (p) => `adm:mg:${userId}:${engine.id}:${group}:${p}`;
    return {
      text: `${text}\n\n${title}`,
      markup: { inline_keyboard: [...rowsOf(toggles, 2), ...pageNav(v.page, v.pages, nav), ...footer] },
    };
  }
  const toggles = models.map((m, i) => toggle(m, i, m.name));
  return { text, markup: { inline_keyboard: [...rowsOf(toggles, 2), ...footer] } };
}

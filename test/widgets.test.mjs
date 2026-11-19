// Виджеты: сборка HTML, лимиты Telegram и сам скрипт виджета — он исполняется здесь на заглушке страницы
// (в Telegram его запускает QuickJS без сети: проверить поведение иначе можно только глазами в приложении).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_ROWS, SESSION_ROWS, WIDGET_MAX_ZLIB, findByRef, modelWidget, parseWidgetQuery, queryRef, sessionsWidget, shortKey, widgetAnswer, widgetFits, zlibSize } from '../src/widgets.mjs';

const TEXTS = { cur: 'Модель', auto: 'Авто', free: 'Бесплатные', other: 'Другие', back: 'Назад', err: 'Не отправлено' };

/** Минимальная страница: элементы по id, кнопки с onclick, replaceChildren / append; запросы виджета собираются в requests. */
function run(html, { chatData = null, answer = () => ({ t: 'ok' }) } = {}) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const make = (tag) => ({ tag, className: '', textContent: '', children: [], disabled: false, onclick: null, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } });
  const byId = new Map();
  const document = { getElementById: (id) => byId.get(id) ?? byId.set(id, make('div')).get(id), createElement: make };
  const requests = [];
  const events = {};
  const pending = [];
  const TelegramWidget = {
    chatData,
    onEvent: (type, fn) => (events[type] = fn),
    request: (data) => {
      requests.push(data);
      const p = Promise.resolve({ result: JSON.stringify(answer(data)) });
      pending.push(p);
      return p;
    },
  };
  new Function('window', 'document', script)({ TelegramWidget }, document);
  const $ = (id) => document.getElementById(id);
  const text = (el) => el.textContent + el.children.map(text).join('');
  return {
    $, requests, events, TelegramWidget,
    rows: () => $('l').children.map(text),
    tap: (id, match) => {
      const b = $(id).children.find((c) => c.tag === 'button' && text(c).includes(match));
      assert.ok(b, `нет кнопки «${match}» в #${id}: ${$(id).children.map(text).join(' | ')}`);
      assert.equal(b.disabled, false, `кнопка «${match}» выключена`);
      b.onclick();
    },
    settle: async () => {
      await Promise.all(pending);
      await new Promise((r) => setImmediate(r));
    },
  };
}

/** Каталог вроде OpenCode: бесплатные, несколько провайдеров, агрегатор с вендорами. */
function bigCatalog() {
  const models = [];
  for (let i = 0; i < 6; i++) models.push({ id: `opencode/free-model-${i}`, name: `OpenCode Zen/Free Model ${i}`, short: `Free Model ${i}`, group: 'opencode', groupLabel: 'OpenCode Zen', free: true });
  for (const [g, label, n] of [['anthropic', 'Anthropic', 9], ['openai', 'OpenAI', 14], ['google', 'Google', 12]]) {
    for (let i = 0; i < n; i++) models.push({ id: `${g}/${g}-model-${i}-preview`, name: `${label}/${label} Model ${i} Preview`, short: `${label} Model ${i} Preview`, group: g, groupLabel: label });
  }
  for (const v of ['anthropic', 'openai', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai', 'nvidia']) {
    for (let i = 0; i < 14; i++) models.push({ id: `openrouter/${v}/${v}-model-${i}`, name: `OpenRouter/${v}: Model ${i}`, short: `${v}: Model ${i}`, group: 'openrouter', groupLabel: 'OpenRouter', sub: v });
  }
  return models;
}
const groupsOf = (models) => Object.fromEntries(models.filter((m) => m.group).map((m) => [m.group, m.groupLabel]));

test('виджет моделей: каталог на полторы сотни моделей помещается в лимит Telegram', () => {
  const models = bigCatalog();
  assert.ok(models.length >= 150, String(models.length));
  const html = modelWidget({ models, model: models[20].id, recent: [models[20].id, models[40].id], groups: groupsOf(models), texts: TEXTS });
  assert.ok(widgetFits(html), `zlib ${zlibSize(html)} > ${WIDGET_MAX_ZLIB}`);
  // без названий — заметно меньше: запасной вариант, если каталог ещё вырастет
  assert.ok(zlibSize(modelWidget({ models, groups: groupsOf(models), texts: TEXTS, names: false })) < zlibSize(html));
  assert.equal(widgetFits('x'.repeat(40_000)), false, 'больше 32768 байт');
});

test('виджет моделей: группы → вендоры → модели, страницы, выбор уходит боту запросом', async () => {
  const models = bigCatalog();
  const cur = 'openrouter/qwen/qwen-model-3';
  const w = run(modelWidget({ models, model: cur, recent: [cur], groups: groupsOf(models), texts: TEXTS }), { answer: (q) => ({ t: 'Модель выбрана', s: { m: q.slice(2), e: null } }) });
  assert.equal(w.$('cur').textContent, 'Модель: qwen: Model 3');
  // верхний уровень: «Авто», недавние, бесплатные, провайдеры с числом моделей; группа текущей модели отмечена
  assert.deepEqual(w.rows(), ['✨ Авто', '🕘 qwen: Model 3', '🆓 Бесплатные (6) ›', 'OpenCode Zen (6) ›', 'Anthropic (9) ›', 'OpenAI (14) ›', 'Google (12) ›', 'OpenRouter (112) ›']);
  assert.match(w.$('l').children.at(-1).className, /\bon\b/);
  // группа с вендорами: сначала вендоры, потом модели вендора, страницы по MODEL_ROWS
  w.tap('l', 'OpenRouter');
  assert.equal(w.rows().length, 8);
  assert.ok(w.rows().includes('qwen (14) ›'));
  w.tap('l', 'qwen');
  assert.equal(w.rows().length, MODEL_ROWS);
  assert.equal(w.$('b').children[1].textContent, 'OpenRouter › qwen');
  assert.equal(w.$('p').children[1].textContent, '1/2');
  assert.equal(w.$('p').children[0].disabled, true, 'назад с первой страницы нельзя');
  w.tap('p', '›');
  assert.equal(w.rows().length, 14 - MODEL_ROWS);
  // выбор модели — запрос боту; ответ бота меняет отметку
  w.tap('l', 'qwen: Model 9');
  assert.deepEqual(w.requests, ['m:openrouter/qwen/qwen-model-9']);
  await w.settle();
  assert.equal(w.$('msg').textContent, 'Модель выбрана');
  assert.equal(w.$('cur').textContent, 'Модель: qwen: Model 9');
  // «назад» по уровням
  w.tap('b', 'Назад');
  w.tap('b', 'Назад');
  assert.equal(w.rows()[0], '✨ Авто');
  w.tap('l', 'Бесплатные');
  assert.deepEqual(w.rows()[0], '🆓 Free Model 0');
  w.tap('b', 'Назад');
  w.tap('l', 'Авто');
  assert.equal(w.requests.at(-1), 'm:~');
});

test('виджет моделей: движок без групп — сразу модели; уровни рассуждений; состояние от бота (chatData)', async () => {
  const models = [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'haiku', name: 'Haiku' }];
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }];
  const html = modelWidget({ models, efforts, model: null, effort: null, texts: TEXTS });
  const w = run(html, { chatData: JSON.stringify({ m: 'sonnet', e: 'high' }), answer: () => ({ t: 'Уровень выбран', s: { m: 'sonnet', e: 'low' } }) });
  assert.deepEqual(w.rows(), ['✨ Авто', 'Opus', 'Sonnet', 'Haiku']);
  assert.equal(w.$('cur').textContent, 'Модель: Sonnet', 'состояние из chatData важнее данных на момент отправки');
  assert.match(w.$('e').children.find((c) => c.textContent === 'High').className, /\bon\b/);
  w.tap('e', 'Low');
  assert.deepEqual(w.requests, ['e:low']);
  await w.settle();
  assert.match(w.$('e').children.find((c) => c.textContent === 'Low').className, /\bon\b/);
  // бот поменял состояние (выбор с другого устройства) — виджет перерисовывается
  w.TelegramWidget.chatData = JSON.stringify({ m: 'haiku', e: null });
  w.events.chatDataChanged();
  assert.equal(w.$('cur').textContent, 'Модель: Haiku');
  // при ограничении моделей «Авто» нет
  assert.deepEqual(run(modelWidget({ models, model: 'opus', auto: false, texts: TEXTS })).rows(), ['Opus', 'Sonnet', 'Haiku']);
});

test('виджет моделей: длинный id уходит коротким ключом; название не может закрыть скрипт', () => {
  const long = `openrouter/vendor/${'x'.repeat(70)}`;
  const evil = { id: 'a/evil', name: 'A/</script><script>alert(1)</script>', short: '</script><b>x' };
  const html = modelWidget({ models: [{ id: long, name: 'Long' }, evil], model: null, groups: {}, texts: TEXTS });
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'единственный закрывающий тег — настоящий');
  const w = run(html);
  w.tap('l', 'openrouter');
  w.tap('l', 'Long');
  assert.equal(w.requests[0], `m:${shortKey(long)}`);
  assert.ok(Buffer.byteLength(w.requests[0]) <= 64);
  assert.equal(findByRef([{ id: long }, { id: 'b' }], shortKey(long)).id, long);
  assert.equal(findByRef([{ id: long }, { id: 'b' }], 'b').id, 'b');
  assert.equal(findByRef([{ id: 'b' }], '@000000000000'), null);
  assert.equal(queryRef('m:', 'short/id'), 'short/id');
});

test('виджет сессий: карточки по страницам, текущая отмечена, нажатие — запрос боту', async () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `0199a7c2-5d1e-7f33-9a51-${String(i).padStart(12, '0')}`, label: `1${i}.11, 14:00 · Claude · ${i + 1} запр.`, text: `Запрос номер ${i} <b>` }));
  const html = sessionsWidget({ sessions, current: sessions[1].id, title: 'Сессии проекта reports: 12', texts: TEXTS });
  assert.ok(widgetFits(html));
  const w = run(html, { answer: () => ({ t: '⏳ Возобновляю сессию…' }) });
  assert.equal(w.$('cur').textContent, 'Сессии проекта reports: 12');
  assert.equal(w.rows().length, SESSION_ROWS);
  assert.equal(w.rows()[1], '▶ 11.11, 14:00 · Claude · 2 запр.Запрос номер 1 <b>', 'текст — как текст, не разметка');
  assert.match(w.$('l').children[1].className, /\bon\b/);
  assert.equal(w.$('p').children[1].textContent, '1/3');
  w.tap('p', '›');
  w.tap('l', 'Запрос номер 7');
  assert.deepEqual(w.requests, [`s:${sessions[7].id}`]);
  await w.settle();
  assert.equal(w.$('msg').textContent, '⏳ Возобновляю сессию…');
});

test('parseWidgetQuery и widgetAnswer: разбор запроса и ответ не длиннее 1024 байт', () => {
  assert.deepEqual(parseWidgetQuery('m:openrouter/a/b'), { kind: 'model', ref: 'openrouter/a/b' });
  assert.deepEqual(parseWidgetQuery('m:~'), { kind: 'model', ref: '~' });
  assert.deepEqual(parseWidgetQuery('e:high'), { kind: 'effort', ref: 'high' });
  assert.deepEqual(parseWidgetQuery('s:@0123456789ab'), { kind: 'session', ref: '@0123456789ab' });
  for (const bad of ['', 'x:1', 'adm:ro:1', 'm:', null]) assert.equal(parseWidgetQuery(bad), null, String(bad));
  assert.deepEqual(JSON.parse(widgetAnswer('ok', { m: 'a', e: null })), { t: 'ok', s: { m: 'a', e: null } });
  assert.deepEqual(JSON.parse(widgetAnswer('ok')), { t: 'ok' });
  assert.ok(Buffer.byteLength(widgetAnswer('я'.repeat(5000), { m: 'a' })) <= 1024);
});

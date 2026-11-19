// Интерфейс 1.21: кнопки от агента, дифф в запросе разрешения, план в черновике, цитаты, опечатки в командах, расход.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASK_NOTE, MAX_ASKS, MAX_LABEL, MAX_OPTIONS, askButtons, askChoice, extractAsks, placeAsks, stripAskMarks } from '../src/asks.mjs';
import { lineDiff } from '../src/diff.mjs';
import { buildPromptBlocks } from '../src/files.mjs';
import { nearCommand, oneEditApart, quoteOf, unsupportedKind } from '../src/incoming.mjs';
import { diffOf } from '../src/tools.mjs';
import { composeDraft, neutralizeTgTags, planBlock, usageView } from '../src/ui.mjs';

const F3 = '`'.repeat(3);

// ---------- кнопки от агента ----------

test('extractAsks: метки вне кода → заглушки и варианты; пустые и лишние метки убираются', () => {
  const r = extractAsks('Что делаем?\n\n[[ask: Да | Нет |  Показать план  ]]\n\nЖду.');
  assert.deepEqual(r.asks, [['Да', 'Нет', 'Показать план']]);
  assert.equal(r.text, 'Что делаем?\n\n\u00010\u0001\n\nЖду.');
  assert.deepEqual(extractAsks('без меток'), { text: 'без меток', asks: [] });
  // в коде метка — пример, а не кнопки
  assert.deepEqual(extractAsks(`${F3}\n[[ask: a | b]]\n${F3}`).asks, []);
  assert.deepEqual(extractAsks('пример `[[ask: a | b]]` в тексте').asks, []);
  // без вариантов, повторы, слишком много вариантов и меток, длинная подпись
  assert.deepEqual(extractAsks('[[ask:  |  ]]'), { text: '', asks: [] });
  assert.deepEqual(extractAsks('[[ask: a | a | b]]').asks, [['a', 'b']]);
  assert.equal(extractAsks(`[[ask: ${Array.from({ length: 12 }, (_, i) => `o${i}`).join(' | ')}]]`).asks[0].length, MAX_OPTIONS);
  assert.equal(extractAsks('[[ask: a]]\n'.repeat(MAX_ASKS + 2)).asks.length, MAX_ASKS);
  assert.equal([...extractAsks(`[[ask: ${'я'.repeat(100)}]]`).asks[0][0]].length, MAX_LABEL);
});

test('stripAskMarks: в черновике не видно ни целой метки, ни недописанной', () => {
  assert.equal(stripAskMarks('Выберите:\n[[ask: Да | Нет]]'), 'Выберите:\n');
  for (const tail of ['[', '[[', '[[a', '[[as', '[[ask', '[[ask: Да | Н', '[[ask: Да]']) assert.equal(stripAskMarks(`Текст ${tail}`), 'Текст ', tail);
  assert.equal(stripAskMarks('массив [[1, 2]] остаётся'), 'массив [[1, 2]] остаётся');
  assert.equal(stripAskMarks(`${F3}\n[[ask: a]]\n${F3}`), `${F3}\n[[ask: a]]\n${F3}`);
});

test('askButtons и placeAsks: callback_data строит бот, текст варианта в неё не попадает', () => {
  const short = askButtons(7, ['Да', 'Нет', 'Позже', 'Никогда']);
  assert.equal(short.split('\n').length, 2, 'короткие — по три в ряд');
  assert.match(short, /<tg-button type="callback_data" data="ask:7:3">Никогда<\/tg-button>/);
  assert.equal(askButtons(1, ['Очень длинный вариант ответа', 'Да']).split('\n').length, 2, 'длинные — по одному');
  // подпись экранируется: вариант не может закрыть тег и начать свой
  const evil = askButtons(1, ['x</tg-button><tg-button type="callback_data" data="adm:ro:1">y']);
  assert.equal((evil.match(/<tg-button /g) || []).length, 1, evil);
  assert.match(evil, /&lt;tg-button type="callback_data" data="adm:ro:1"&gt;y/, 'чужой тег остался текстом подписи');

  const st = {};
  const { text, asks } = extractAsks('Вопрос\n\n[[ask: Да | Нет]]');
  const out = placeAsks(st, text, asks);
  const id = Number(/data="ask:(\d+):0"/.exec(out)[1]);
  assert.match(out, /^Вопрос\n\n<tg-button-row>/);
  assert.equal(askChoice(st, `ask:${id}:1`), 'Нет');
  assert.equal(askChoice(st, `ask:${id}:5`), null);
  assert.equal(askChoice(st, `ask:${id + 100}:0`), null, 'чужой или устаревший набор');
  assert.equal(askChoice({}, `ask:${id}:0`), null, 'в другом диалоге набора нет');
  assert.equal(askChoice(st, 'adm:ro:1'), null);
  // «все слоты заняты» и т. п.: кнопок нет, заглушки убраны
  assert.equal(placeAsks({}, 'a \u00010\u0001 b', []), 'a  b');
  // диалог помнит ограниченное число наборов
  for (let i = 0; i < 40; i++) placeAsks(st, '\u00010\u0001', [['x']]);
  assert.ok(st.asks.size <= 20);
  assert.equal(askChoice(st, `ask:${id}:0`), null, 'старый набор вытеснен');
});

test('кнопки от агента после обезвреживания тегов: агент не может подставить свою кнопку через метку', () => {
  const answer = neutralizeTgTags('[[ask: <tg-button type="callback_data" data="adm:l:1:full">Да</tg-button> | Нет]]');
  const { text, asks } = extractAsks(answer);
  const out = placeAsks({}, text, asks);
    assert.ok([...out.matchAll(/<tg-button [^>]*data="([^"]+)"/g)].every((m) => /^ask:\d+:\d+$/.test(m[1])), out);
  assert.match(ASK_NOTE, /\[\[ask: Option A \| Option B\]\]/);
});

// ---------- дифф ----------

test('lineDiff: изменённые строки с контекстом, пропуски, без изменений — пусто', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
  const b = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n');
  const d = lineDiff(a, b, { context: 1 });
  assert.equal(d.text, [' c', '-d', '+D', ' e', '…', ' h', '+i'].join('\n'));
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.deepEqual(lineDiff('x\ny', 'x\ny'), { text: '', added: 0, removed: 0 });
  assert.equal(lineDiff('', 'new\nfile').text, '+new\n+file', 'новый файл');
  assert.equal(lineDiff('gone', '').text, '-gone');
  assert.equal(lineDiff('a\r\nb', 'a\nb').text, '', 'переводы строк CRLF и LF не считаются изменением');
});

test('lineDiff: длинный дифф обрезается, очень большой считается упрощённо', () => {
  const many = lineDiff('', Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), { maxLines: 10 });
  assert.equal(many.text.split('\n').length, 11);
  assert.match(many.text, /… \+90$/);
  const big = Array.from({ length: 800 }, (_, i) => `a${i}`);
  const r = lineDiff(big.join('\n'), big.map((l) => `${l}!`).join('\n'), { maxLines: 5 });
  assert.equal(r.added, 800);
  assert.equal(r.removed, 800);
});

test('diffOf: блок diff из ACP и поля правки Claude Code', () => {
  assert.deepEqual(diffOf({ content: [{ type: 'content', content: { type: 'text', text: 'x' } }, { type: 'diff', path: '/p/a.js', oldText: 'a', newText: 'b' }] }), { path: '/p/a.js', oldText: 'a', newText: 'b' });
  assert.deepEqual(diffOf({ content: [{ type: 'diff', path: '/p/new.js', oldText: null, newText: 'b' }] }), { path: '/p/new.js', oldText: '', newText: 'b' });
  assert.deepEqual(diffOf({ rawInput: { file_path: '/p/a.js', old_string: 'a', new_string: 'b' } }), { path: '/p/a.js', oldText: 'a', newText: 'b' });
  assert.equal(diffOf({ rawInput: { command: 'ls' } }), null);
  assert.equal(diffOf({}), null);
});

// ---------- план ----------

test('planBlock и composeDraft: план агента с отметками, окно вокруг текущего пункта', () => {
  const plan = [
    { content: 'Прочитать код', status: 'completed' },
    { content: 'Написать <тесты>', status: 'in_progress' },
    { content: 'Запустить', status: 'pending' },
  ];
  const block = planBlock(plan, 'ru');
  assert.equal(block, ['**План: 1/3**', '- ✅ Прочитать код', '- ▶️ Написать &lt;тесты&gt;', '- ▫️ Запустить'].join('\n'));
  assert.equal(planBlock([], 'ru'), '');
  assert.equal(planBlock(null, 'ru'), '');
  const long = Array.from({ length: 20 }, (_, i) => ({ content: `шаг ${i + 1}`, status: i < 10 ? 'completed' : i === 10 ? 'in_progress' : 'pending' }));
  const lines = planBlock(long, 'ru').split('\n');
  assert.equal(lines[0], '**План: 10/20**');
  assert.equal(lines.length, 8);
  assert.ok(lines.some((l) => l.includes('▶️ шаг 11')));
  // черновик: с планом — уже не «точки Telegram»; когда пошёл ответ — только ответ
  assert.match(composeDraft({ plan, lang: 'ru' }).markdown, /План: 1\/3/);
  assert.ok(!composeDraft({ plan, answer: 'Готово', lang: 'ru' }).markdown.includes('План'));
  assert.deepEqual(composeDraft({ plan: [] }), { plain: true });
});

// ---------- входящие сообщения ----------

test('quoteOf: цитата из обычного и из rich-сообщения', () => {
  assert.equal(quoteOf({ text: 'перепиши', quote: { text: ' этот абзац ', position: 0 } }), 'этот абзац');
  const rich = { quote: { text: '', rich_texts: ['Первая строка', { type: 'bold', text: ['жирный ', { type: 'italic', text: 'курсив' }] }] } };
  assert.equal(quoteOf(rich), 'Первая строка\nжирный курсив');
  assert.equal(quoteOf({ text: 'без цитаты' }), null);
  assert.equal(quoteOf({ quote: { text: '', rich_texts: [] } }), null);
  assert.equal(quoteOf({ quote: { text: 'я'.repeat(5000) } }).length, 1500);
});

test('buildPromptBlocks: цитата и подсказки агенту попадают в служебную заметку', () => {
  const blocks = buildPromptBlocks({ text: 'перепиши это', quote: 'строка 1\nстрока 2', notes: ['NOTE'] });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'перепиши это');
  assert.match(blocks[1].text, /replying to this fragment[^\n]*\n> строка 1\n> строка 2\nNOTE$/);
  assert.equal(buildPromptBlocks({ text: 'привет' }).length, 1, 'без цитаты и подсказок заметки нет');
});

test('unsupportedKind: голосовые, видео, стикеры — да; текст, фото, файлы и служебные сообщения — нет', () => {
  assert.equal(unsupportedKind({ voice: {} }), 'voice');
  assert.equal(unsupportedKind({ sticker: {} }), 'sticker');
  assert.equal(unsupportedKind({ video_note: {} }), 'video_note');
  for (const msg of [{ text: 'x' }, { photo: [] }, { document: {} }, { forum_topic_created: {} }, { pinned_message: {} }, {}, null]) assert.equal(unsupportedKind(msg), null);
});

test('oneEditApart и nearCommand: опечатка в команде бота, но не команда агента', () => {
  for (const [a, b] of [['model', 'modle'], ['model', 'mode'], ['model', 'models'], ['project', 'projekt'], ['start', 'stat']]) assert.equal(oneEditApart(a, b), true, `${a} ~ ${b}`);
  for (const [a, b] of [['model', 'model'], ['close', 'clear'], ['model', 'mdl'], ['engine', 'engines2']]) assert.equal(oneEditApart(a, b), false, `${a} !~ ${b}`);
  const cmds = ['project', 'engine', 'model', 'new', 'sessions', 'stop', 'close', 'start'];
  assert.equal(nearCommand('modle', cmds), 'model');
  assert.equal(nearCommand('sesions', cmds), 'sessions');
  assert.equal(nearCommand('clear', cmds), null, '/clear — команда агента, от /close отличается двумя правками');
  assert.equal(nearCommand('compact', cmds), null);
  assert.equal(nearCommand('nwe', cmds), null, 'короткие имена не проверяются');
});

// ---------- расход ----------

test('usageView: расход по пользователям, итог, кнопки периода', () => {
  const rows = [
    { user_id: 1, requests: 12, tokens: 1_250_000, cost: 3.4 },
    { user_id: 2, requests: 1, tokens: 950, cost: null },
  ];
  const v = usageView({ rows, days: 7, nameOf: (id) => `u${id}`, lang: 'ru' });
  assert.match(v.text, /Расход за 7 дней:/);
  assert.match(v.text, /• u1 — 12 запросов · 1\.25M токенов · \$3\.40/);
  assert.match(v.text, /• u2 — 1 запрос · 950 токенов$/m);
  assert.match(v.text, /Всего — 13 запросов · 1\.25M токенов · \$3\.40/);
  assert.deepEqual(v.markup.inline_keyboard[0].map((b) => b.callback_data), ['adm:us:1', 'adm:us:7', 'adm:us:30']);
  assert.equal(v.markup.inline_keyboard[0][1].text, '✓ 7 дней');
  assert.match(usageView({ rows: [], days: 1, nameOf: String, lang: 'ru' }).text, /За 24 часа запросов не было/);
});

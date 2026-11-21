import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plural, t } from '../src/i18n.mjs';
import { fixTables, mediaBlock, mediaIdsOf, richToPlain, splitRich, stripMedia } from '../src/telegram.mjs';
import { ANIM, DOCS_URL, FREE_GROUP, MODEL_PAGE, OTHER_SUB, activeSessionsView, browseGroup, docsMenuButton, helpMarkup, modelSearchMenu, modelSubgroupsOf, searchModels, composeDraft, defuseTgTags, engineMenu, hBold, hCode, hRaw, neutralizeTgTags, th, sessionStatus, finalExtras, finalMessages, fmtDuration, lastThoughtTitle, modelGrantsView, modelGroupMenu, modelGroupsOf, modelMenu, skillName, startView, stepLine } from '../src/ui.mjs';

const step = (o) => ({ toolCallId: 'x', tool: 'read_file', kind: 'read', title: 'src/a.mjs', description: '', status: null, ...o });
const RU = { lang: 'ru' };

test('plural и fmtDuration', () => {
  assert.equal(plural(1, 'step', 'ru'), '1 шаг');
  assert.equal(plural(3, 'step', 'ru'), '3 шага');
  assert.equal(plural(5, 'step', 'ru'), '5 шагов');
  assert.equal(plural(11, 'step', 'ru'), '11 шагов');
  assert.equal(plural(21, 'step', 'ru'), '21 шаг');
  assert.equal(plural(112, 'step', 'ru'), '112 шагов');
  assert.equal(fmtDuration(42_400, 'ru'), '42 с');
  assert.equal(fmtDuration(84_000, 'ru'), '1 мин 24 с');
  assert.equal(fmtDuration(180_000, 'ru'), '3 мин');
  // украинский: те же правила множественного числа
  assert.equal(plural(2, 'step', 'uk'), '2 кроки');
  assert.equal(plural(5, 'step', 'uk'), '5 кроків');
  // английский
  assert.equal(plural(1), '1 step');
  assert.equal(plural(3), '3 steps');
  assert.equal(fmtDuration(84_000), '1 min 24 s');
});

test('skillName: только имя навыка', () => {
  assert.equal(skillName('"windows-failed-tasks": Checks Windows Task Scheduler…'), 'windows-failed-tasks');
  assert.equal(skillName('windows-task-logs'), 'windows-task-logs');
});

test('stepLine: выполняющийся шаг в черновике анимирован, завершённый — со статусом', () => {
  const running = stepLine(step({ status: 'in_progress' }), { live: true, ...RU });
  assert.ok(running.includes(`<tg-emoji emoji-id="${ANIM.read}">📖</tg-emoji>`), running);
  assert.ok(running.includes('**Чтение файла**') && running.includes('<code>src/a.mjs</code>'));

  assert.equal(stepLine(step({ status: 'completed' }), RU), '✅ 📖 **Чтение файла** — <code>src/a.mjs</code>');
  assert.ok(stepLine(step({ status: 'failed' }), RU).startsWith('❌'));
  // в итоговом сообщении анимации нет (Telegram заменил бы её на 🙂)
  assert.ok(!stepLine(step({ status: 'in_progress' }), RU).includes('tg-emoji'));
  // английский — по умолчанию
  assert.equal(stepLine(step({ status: 'completed' })), '✅ 📖 **Reading file** — <code>src/a.mjs</code>');
});

test('stepLine: команда — описание, навык — имя, неизвестный инструмент, экранирование', () => {
  const cmd = stepLine(step({ tool: 'run_shell_command', kind: 'execute', title: 'rm -rf x', description: 'Проверка <логов>', status: 'completed' }), RU);
  assert.equal(cmd, '✅ ⚙️ **Команда** — Проверка &lt;логов&gt;');
  const skill = stepLine(step({ tool: 'activate_skill', kind: 'other', title: '"windows-failed-tasks": Checks …', status: 'completed' }), RU);
  assert.ok(skill.includes('<code>windows-failed-tasks</code>'), skill);
  // неизвестный инструмент: по виду действия ACP, а если вид не подсказывает — гаечный ключ с именем
  assert.ok(stepLine(step({ tool: 'mcp_x', kind: 'other', status: 'completed' }), RU).includes('🔧 **mcp_x**'));
  assert.ok(stepLine(step({ tool: 'mcp_x', kind: 'execute', status: 'completed' }), RU).includes('⚙️ **Команда**'));
  // инструменты Claude Code и Antigravity CLI
  assert.ok(stepLine(step({ tool: 'PowerShell', kind: 'execute', description: 'Print hello', status: 'completed' }), RU).includes('⚙️ **Команда** — Print hello'));
  assert.ok(stepLine(step({ tool: 'run_command', kind: 'execute', status: 'completed' }), RU).includes('**Команда**'));
  assert.ok(stepLine(step({ tool: 'Grep', kind: 'search', status: 'completed' }), RU).includes('🔍 **Поиск по файлам**'));
  // без описания команда на английском
  assert.ok(stepLine(step({ tool: 'run_command', kind: 'execute', status: 'completed' })).includes('**Command** — running a command'));
});

test('composeDraft: пока агент молчит — родные точки Telegram', () => {
  assert.deepEqual(composeDraft({}), { plain: true });
});

test('composeDraft: размышления, шаги, счётчик скрытых шагов, время', () => {
  const steps = Array.from({ length: 7 }, (_, i) => step({ toolCallId: String(i), status: 'completed', title: `f${i}` }));
  const { markdown } = composeDraft({ thought: 'Assessing <Task>', steps, elapsedMs: 84_000, ...RU });
  assert.match(markdown, /^<tg-thinking>.*Assessing &lt;Task&gt;<\/tg-thinking>/);
  assert.ok(markdown.includes(`<tg-thinking><tg-emoji emoji-id="${ANIM.thinking}">💭</tg-emoji> `) && !markdown.includes("tg://emoji"));
  assert.ok(markdown.includes('… и ещё 2 шага выше'));
  assert.ok(!markdown.includes('<code>f1</code>') && markdown.includes('<code>f6</code>'), 'показаны последние 5');
  assert.ok(markdown.endsWith('<footer>⏱ 1 мин 24 с</footer>'));
  // короткий запрос — без времени
  assert.ok(!composeDraft({ thought: 'x', elapsedMs: 3000, ...RU }).markdown.includes('footer'));
  // английский
  const en = composeDraft({ steps, elapsedMs: 84_000 }).markdown;
  assert.ok(en.includes('_… 2 steps earlier_') && en.endsWith('<footer>⏱ 1 min 24 s</footer>'), en);
});

test('composeDraft: пошёл ответ — последний шаг и ответ, незакрытая разметка закрывается', () => {
  const { markdown } = composeDraft({ steps: [step({ status: 'completed' })], answer: 'Итог **важно', ...RU });
  assert.ok(markdown.startsWith('✅ 📖 **Чтение файла**'));
  assert.ok(markdown.endsWith('Итог **важно**'));
  // ответ после вызова инструмента начинается с переносов — без лишних пустых строк
  const d = composeDraft({ steps: [step({ status: 'completed' })], answer: '\n\nОтвет', ...RU });
  assert.ok(d.markdown.endsWith('</code>\n\nОтвет'), JSON.stringify(d.markdown));
});

test('finalExtras и finalMessages: свёрнутый ход работы и подвал', () => {
  const steps = [step({ status: 'completed' }), step({ toolCallId: 'y', tool: 'run_shell_command', kind: 'execute', description: 'тест', status: 'failed' })];
  const ex = finalExtras({ steps, elapsedMs: 12_000, project: 'team/proj', ...RU });
  assert.match(ex, /^<details><summary>Ход работы · 2 шага<\/summary>/);
  assert.ok(ex.includes('- ✅ 📖 **Чтение файла**') && ex.includes('- ❌ ⚙️ **Команда** — тест'));
  assert.ok(ex.endsWith('<footer>📁 team/proj · ⏱ 12 с</footer>'));
  assert.ok(!finalExtras({ steps: [], elapsedMs: 1000, ...RU }).includes('details'), 'без шагов — только подвал');
  // английский
  const enEx = finalExtras({ steps, elapsedMs: 12_000, project: 'team/proj' });
  assert.match(enEx, /<summary>Work log · 2 steps<\/summary>/);

  assert.deepEqual(finalMessages('ответ', ex), [`ответ\n\n${ex}`]);
  const long = 'x'.repeat(29_990);
  assert.deepEqual(finalMessages(long, ex), [long, ex], 'не помещается — дополнения отдельным сообщением');
});

test('startView: кнопки и команды; для администратора — свои', () => {
  const user = startView({ level: 'Чтение', project: 'team/proj', isAdmin: false, note: 'Запросы журналируются', ...RU });
  assert.ok(user.includes('data="ui:project"') && user.includes('data="ui:sessions"'));
  assert.ok(user.includes('data="ui:close"') && user.includes('/close'));
  assert.ok(user.includes('data="ui:language"') && user.includes('/language'), 'кнопка и команда языка');
  assert.ok(!user.includes('ui:users') && !user.includes('/invite') && !user.includes('ui:active'));
  assert.ok(user.includes('<footer>Запросы журналируются</footer>'));
  const admin = startView({ level: 'Администратор', project: 'C:\\scripts (корень)', isAdmin: true, ...RU });
  assert.ok(admin.includes('data="ui:users"') && admin.includes('/invite') && admin.includes('data="ui:active"') && admin.includes('/active'));
  // английский по умолчанию: подписи и команды на английском
  const en = startView({ level: 'Read-only', project: 'p', engine: 'Claude Code', isAdmin: false });
  assert.ok(en.includes('**🤖 Engine:** Claude Code') && en.includes('data="ui:engine"') && en.includes('/engine — choose the engine'), en);
});

test('sessionStatus и activeSessionsView: статус в карточке и экран /active', () => {
  const now = 1_000_000;
  const s = { userId: 2, project: '/p/web', startedAt: now - 12 * 60_000, busy: true };
  assert.equal(sessionStatus(undefined, undefined, undefined, 'ru'), '⚪ Неактивен');
  assert.equal(sessionStatus(s, (p) => p.slice(3), now, 'ru'), '🟢 Сессия активна (web, 12 мин, выполняет запрос)');
  assert.equal(sessionStatus(s, (p) => p.slice(3), now), '🟢 Session active (web, 12 min, running a request)');

  const nameOf = (id) => (id === 1 ? 'Админ' : `@u${id}`);
  const v = activeSessionsView({ sessions: [{ ...s, userId: 1, busy: false }, s], adminId: 1, maxAgents: 3, nameOf, now, ...RU });
  assert.ok(v.text.includes('Активные сессии (2), слотов сотрудников занято 1 из 3'), v.text);
  assert.ok(v.text.includes('• Админ — /p/web, 12 мин') && v.text.includes('• @u2 — /p/web, 12 мин, выполняет запрос'), v.text);
  const data = v.markup.inline_keyboard.flat().map((b) => b.callback_data);
  // кнопка завершения только у сотрудника, у администратора — нет; «Обновить» — всегда
  assert.deepEqual(data, ['adm:k:2:a', 'adm:act']);

  const empty = activeSessionsView({ sessions: [], adminId: 1, maxAgents: 3, nameOf, now, ...RU });
  assert.match(empty.text, /Активных сессий нет/);
  assert.deepEqual(empty.markup.inline_keyboard.flat().map((b) => b.callback_data), ['adm:act']);
  const enEmpty = activeSessionsView({ sessions: [], adminId: 1, maxAgents: 3, nameOf, now });
  assert.match(enEmpty.text, /No active sessions, all 3 employee slots are free/);
});

test('engineMenu и движок на экранах /start и /active', () => {
  const engines = [{ id: 'gemini', label: 'Gemini CLI' }, { id: 'claude', label: 'Claude Code' }];
  const m = engineMenu({ engines, current: 'claude', defaultId: 'gemini', unavailable: ['Antigravity CLI'], ...RU });
  assert.ok(m.text.startsWith('🤖 Движок: <b>Claude Code</b>') && m.text.includes('Недоступны на сервере: Antigravity CLI'), m.text);
  assert.deepEqual(m.markup.inline_keyboard.flat().map((b) => b.style), [undefined, 'primary'], 'текущий движок выделен цветом');
  // название движка с «<» не становится тегом
  assert.ok(engineMenu({ engines: [{ id: 'x', label: '<b>X & Y' }], current: 'x', defaultId: 'x', ...RU }).text.startsWith('🤖 Движок: <b>&lt;b&gt;X &amp; Y</b>'));
  assert.deepEqual(m.markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]), [['Gemini CLI · по умолчанию', 'eng:gemini'], ['✓ Claude Code', 'eng:claude']]);
  assert.ok(!engineMenu({ engines, current: 'gemini', defaultId: 'gemini', ...RU }).text.includes('Недоступны'));
  const lm = engineMenu({ engines, current: 'gemini', defaultId: 'gemini', needLogin: ['claude'], ...RU });
  assert.ok(lm.text.includes('⚠️ Нужен вход или ключ API: Claude Code'), lm.text);
  assert.deepEqual(lm.markup.inline_keyboard.flat().map((b) => b.text), ['✓ Gemini CLI · по умолчанию', 'Claude Code · ⚠️ нужен вход']);
  assert.ok(!engineMenu({ engines, current: 'gemini', defaultId: 'gemini', ...RU }).text.includes('Нужен вход'));
  // английский
  const enLm = engineMenu({ engines, current: 'gemini', defaultId: 'gemini', needLogin: ['claude'] });
  assert.deepEqual(enLm.markup.inline_keyboard.flat().map((b) => b.text), ['✓ Gemini CLI · default', 'Claude Code · ⚠️ sign-in needed']);

  const start = startView({ level: 'Чтение', project: 'p', engine: 'Claude Code', isAdmin: false, ...RU });
  assert.ok(start.includes('**🤖 Движок:** Claude Code') && start.includes('передам его Claude Code') && start.includes('data="ui:engine"') && start.includes('/engine'), start);

  const v = activeSessionsView({ sessions: [{ userId: 2, engine: 'Claude', project: '/p', startedAt: 0, busy: false }], adminId: 1, maxAgents: 3, nameOf: () => '@u', now: 60_000, ...RU });
  assert.ok(v.text.includes('• @u — Claude · /p, 1 мин'), v.text);
});

test('украинский интерфейс: подписи и словарь', () => {
  assert.equal(t('start.btn.project', 'uk'), '📁 Проєкт');
  assert.equal(t('level.read.label', 'uk'), 'Читання');
  const uk = startView({ level: 'Читання', project: 'p', engine: 'Claude Code', isAdmin: false, lang: 'uk' });
  assert.ok(uk.includes('**🤖 Рушій:** Claude Code') && uk.includes('/project — обрати проєкт'), uk);
});

test('richToPlain: запасной обычный текст без служебной разметки', () => {
  const md = startView({ level: 'Чтение', project: 'p', isAdmin: false, note: 'n', ...RU }) + '\n\n' + finalExtras({ steps: [step({ status: 'completed' })], elapsedMs: 5000, project: 'p', ...RU });
  const plain = richToPlain(md);
  assert.ok(!/<\/?(details|summary|footer|tg-button)/.test(plain), plain);
  assert.ok(plain.includes('/project') && plain.includes('Ход работы'));
  assert.equal(richToPlain(`a ![💭](tg://emoji?id=${ANIM.thinking}) b`), 'a 💭 b');
  assert.equal(richToPlain(`a <tg-emoji emoji-id="${ANIM.thinking}">💭</tg-emoji> b`), 'a 💭 b');
});

test('fixTables: пустая строка перед таблицей после абзаца или пункта списка, код и готовые таблицы не трогает', () => {
  const tbl = ['| A | B |', '|---|:-:|', '| 1 | 2 |'].join('\n');
  const fence = '`'.repeat(3);
  assert.equal(fixTables(`**Стоит взять:**\n${tbl}`), `**Стоит взять:**\n\n${tbl}`);
  assert.equal(fixTables(`- пункт\n${tbl}`), `- пункт\n\n${tbl}`);
  assert.equal(fixTables(`Текст\n\n${tbl}`), `Текст\n\n${tbl}`);
  assert.equal(fixTables(tbl), tbl);
  assert.equal(fixTables(`${tbl}\n| 3 | 4 |`), `${tbl}\n| 3 | 4 |`);
  const code = `${fence}\nТекст\n${tbl}\n${fence}`;
  assert.equal(fixTables(code), code);
  assert.equal(fixTables('a | b\nc'), 'a | b\nc');
  assert.equal(fixTables('Заголовок\n---'), 'Заголовок\n---');
});

test('splitRich: продолжение таблицы в следующей части получает её шапку', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `| строка ${i} | значение ${i} |`).join('\n');
  const parts = splitRich(`Итог:\n| Имя | Значение |\n|---|---|\n${rows}`, 400);
  assert.ok(parts.length > 1);
  assert.ok(parts[0].startsWith('Итог:\n\n| Имя |'));
  for (const p of parts.slice(1)) assert.ok(p.startsWith('| Имя | Значение |\n|---|---|\n| строка'), p.slice(0, 80));
  assert.deepEqual(splitRich('коротко'), ['коротко']);
});

test('mediaIdsOf и stripMedia: блоки файлов в rich-разметке', () => {
  const md = `Итог:${mediaBlock('photo', 'f0')}текст${mediaBlock('document', 'f1')}${mediaBlock('photo', 'f0')}конец`;
  assert.deepEqual(mediaIdsOf(md), ['f0', 'f1']);
  assert.equal(stripMedia(md), 'Итог:\n\nтекст\n\nконец');
  assert.deepEqual(mediaIdsOf('текст ![](tg://photo?id=f0) внутри строки'), []); // только отдельным блоком
  assert.ok(!richToPlain(`a${mediaBlock('document', 'f2')}b`).includes('tg://'));
});

test('lastThoughtTitle: заголовок мыслей по фрагментам, в буфере только незаконченная строка', () => {
  let buf = '';
  let thought = null;
  for (const chunk of ['**Читаю ко', 'д**\nДлинное рассуждение...\n', 'ещё текст **Запуска', 'ю тесты**', ' и дальше']) {
    const r = lastThoughtTitle(buf + chunk);
    if (r.title) thought = r.title;
    buf = r.rest;
  }
  assert.equal(thought, 'Запускаю тесты');
  assert.equal(buf, 'ещё текст **Запускаю тесты** и дальше');
  assert.deepEqual(lastThoughtTitle('без заголовка\nхвост'), { title: null, rest: 'хвост' });
});

// ---------- группы моделей (OpenCode) ----------

const OC = { id: 'opencode', label: 'OpenCode' };
const ocModels = () => [
  { id: 'anthropic/claude-haiku-4-5', name: 'Anthropic/Claude Haiku 4.5', group: 'anthropic', groupLabel: 'Anthropic', short: 'Claude Haiku 4.5' },
  ...Array.from({ length: 25 }, (_, i) => ({ id: `google/m${i}`, name: `Google/M${i}`, group: 'google', groupLabel: 'Google', short: `M${i}`, ...(i === 0 ? { free: true } : {}) })),
  { id: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle', group: 'opencode', groupLabel: 'OpenCode Zen', short: 'Big Pickle', free: true },
];
const buttons = (markup) => markup.inline_keyboard.flat();

test('modelGroupsOf: бесплатные первыми, затем провайдеры; без групп — пусто', () => {
  assert.deepEqual(modelGroupsOf(ocModels()), [
    { id: FREE_GROUP, label: null, count: 2 },
    { id: 'anthropic', label: 'Anthropic', count: 1 },
    { id: 'google', label: 'Google', count: 25 },
    { id: 'opencode', label: 'OpenCode Zen', count: 1 },
  ]);
  assert.deepEqual(modelGroupsOf([{ id: 'opus', name: 'Opus' }]), []);
});

test('modelMenu: у OpenCode — кнопки групп с количеством, группа текущей модели отмечена', () => {
  const v = modelMenu({ engine: OC, models: ocModels(), model: 'anthropic/claude-haiku-4-5', effort: null, ...RU });
  const b = buttons(v.markup);
  assert.deepEqual(b.map((x) => x.text), ['Авто', '🆓 Бесплатные (2)', '✓ Anthropic (1)', 'Google (25)', 'OpenCode Zen (1)']);
  assert.equal(b[1].callback_data, `mdl:opencode:g:${FREE_GROUP}:0`);
  assert.match(v.text, /Сейчас: Anthropic\/Claude Haiku 4\.5/);
  assert.match(v.text, /Выберите группу/);
  // у движков без групп — список моделей, как раньше
  const flat = modelMenu({ engine: { id: 'claude', label: 'Claude Code' }, models: [{ id: 'opus', name: 'Opus' }], model: null, effort: null, ...RU });
  assert.deepEqual(buttons(flat.markup).map((x) => x.callback_data), ['mdl:claude:m:~', 'mdl:claude:m:opus']);
});

test('modelGroupMenu: страницы по MODEL_PAGE, короткие названия, номер модели — во всём списке', () => {
  const models = ocModels();
  const p0 = modelGroupMenu({ engine: OC, models, group: 'google', page: 0, model: 'google/m1', ...RU });
  const b0 = buttons(p0.markup);
  const modelBtns = b0.filter((x) => x.callback_data.startsWith('mdl:opencode:m:'));
  assert.equal(modelBtns.length, MODEL_PAGE);
  assert.equal(modelBtns[0].text, '🆓 M0', 'бесплатная в группе провайдера — с пометкой');
  assert.equal(modelBtns[1].text, '✓ M1');
  assert.ok(b0.some((x) => x.text === '1/2') && b0.some((x) => x.callback_data === 'mdl:opencode:g:google:1'));
  assert.equal(b0.at(-1).callback_data, 'mdl:opencode:g:~');
  const p1 = buttons(modelGroupMenu({ engine: OC, models, group: 'google', page: 1, model: null, ...RU }).markup);
  assert.equal(p1.filter((x) => x.callback_data.startsWith('mdl:opencode:m:')).length, 5);
  assert.ok(p1.some((x) => x.callback_data === 'mdl:opencode:g:google:0'));
  // страница за пределами — последняя
  assert.ok(buttons(modelGroupMenu({ engine: OC, models, group: 'google', page: 99, model: null, ...RU }).markup).some((x) => x.text === '2/2'));
  // бесплатные: полное название с провайдером и предупреждение о данных
  const free = modelGroupMenu({ engine: OC, models, group: FREE_GROUP, model: null, ...RU });
  assert.deepEqual(buttons(free.markup).filter((x) => x.callback_data.startsWith('mdl:opencode:m:')).map((x) => x.text), ['Google/M0', 'OpenCode Zen/Big Pickle']);
  assert.match(free.text, /могут использовать запросы для обучения/);
  // длинный id — номер модели во всём списке, а не на странице
  const long = [...models, { id: `google/${'x'.repeat(60)}`, name: 'Google/X', group: 'google', groupLabel: 'Google', short: 'X' }];
  const p = buttons(modelGroupMenu({ engine: OC, models: long, group: 'google', page: 1, model: null, ...RU }).markup);
  assert.ok(p.some((x) => x.callback_data === `mdl:opencode:m:#${long.length - 1}`));
});

test('modelGrantsView: у OpenCode — группы «разрешено/всего», внутри группы — переключатели постранично', () => {
  const models = ocModels();
  const top = modelGrantsView({ userId: 7, name: 'Ник', engine: OC, models, allowed: ['opencode/big-pickle', 'google/m0'], ...RU });
  assert.deepEqual(buttons(top.markup).map((x) => x.text).slice(0, 4), ['🆓 Бесплатные 2/2', 'Anthropic 0/1', 'Google 1/25', 'OpenCode Zen 1/1']);
  assert.equal(buttons(top.markup)[2].callback_data, 'adm:mg:7:opencode:google:0');
  assert.equal(buttons(top.markup).at(-1).callback_data, 'adm:mm:7');
  const g = modelGrantsView({ userId: 7, name: 'Ник', engine: OC, models, allowed: null, group: 'google', page: 1, ...RU });
  const gb = buttons(g.markup);
  assert.equal(gb.filter((x) => x.callback_data.startsWith('adm:mt:')).length, 5);
  assert.equal(gb.find((x) => x.callback_data.startsWith('adm:mt:')).text, '✅ M20');
  assert.ok(gb.some((x) => x.callback_data === 'adm:mg:7:opencode:google:0'));
  assert.equal(gb.at(-1).callback_data, 'adm:me:7:opencode', 'из группы — назад к группам');
  // неизвестная группа (каталог обновился) — снова список групп
  assert.ok(buttons(modelGrantsView({ userId: 7, name: 'Ник', engine: OC, models, allowed: null, group: 'gone', ...RU }).markup).some((x) => x.callback_data.startsWith('adm:mg:')));
});

// ---------- OpenRouter: вендоры, поиск, недавние ----------

const orModels = () => {
  const list = [];
  const add = (vendor, label, n) => {
    for (let i = 0; i < n; i++) list.push({ id: `openrouter/${vendor}/m${i}`, name: `OpenRouter/${label}: M${i}`, group: 'openrouter', groupLabel: 'OpenRouter', short: `${label}: M${i}`, sub: vendor, subLabel: label });
  };
  add('openai', 'OpenAI', 12);
  add('anthropic', 'Anthropic', 8);
  add('tiny1', 'Tiny1', 1);
  add('tiny2', 'Tiny2', 2);
  list.push({ id: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle', group: 'opencode', groupLabel: 'OpenCode Zen', short: 'Big Pickle', free: true });
  return list;
};

test('modelSubgroupsOf: вендоры по числу моделей, вендоры с 1–2 моделями — в «Прочие»', () => {
  const { subs, small } = modelSubgroupsOf(orModels().filter((m) => m.group === 'openrouter'));
  assert.deepEqual(subs.map((s) => `${s.id}:${s.count}`), ['openai:12', 'anthropic:8', `${OTHER_SUB}:3`]);
  assert.deepEqual([...small].sort(), ['tiny1', 'tiny2']);
  // один мелкий вендор в «Прочие» не прячем
  assert.deepEqual(modelSubgroupsOf(orModels().filter((m) => m.group === 'openrouter' && m.sub !== 'tiny2')).subs.map((s) => s.id), ['openai', 'anthropic', 'tiny1']);
  assert.deepEqual(modelSubgroupsOf([{ id: 'a', name: 'A' }]).subs, []);
});

test('modelGroupMenu: большая группа OpenRouter — вендоры, внутри вендора — модели без названия вендора', () => {
  const models = orModels();
  const top = modelGroupMenu({ engine: OC, models, group: 'openrouter', model: 'openrouter/anthropic/m1', ...RU });
  const tb = buttons(top.markup);
  assert.deepEqual(tb.map((x) => x.text).slice(0, 3), ['OpenAI (12)', '✓ Anthropic (8)', 'Прочие (3)']);
  assert.equal(tb[1].callback_data, 'mdl:opencode:s:openrouter:anthropic:0');
  assert.equal(tb.at(-1).callback_data, 'mdl:opencode:g:~');
  assert.match(top.text, /Выберите разработчика/);
  const sub = modelGroupMenu({ engine: OC, models, group: 'openrouter', sub: 'anthropic', model: 'openrouter/anthropic/m1', ...RU });
  const sb = buttons(sub.markup);
  assert.equal(sb.filter((x) => x.callback_data.startsWith('mdl:opencode:m:')).length, 8);
  assert.equal(sb[1].text, '✓ M1', 'без «Anthropic: »');
  assert.equal(sb.at(-1).callback_data, 'mdl:opencode:g:openrouter:0', 'назад — к вендорам');
  assert.match(sub.text, /OpenRouter › Anthropic: 8/);
  const other = buttons(modelGroupMenu({ engine: OC, models, group: 'openrouter', sub: OTHER_SUB, model: null, ...RU }).markup);
  assert.deepEqual(other.filter((x) => x.callback_data.startsWith('mdl:opencode:m:')).map((x) => x.text), ['Tiny1: M0', 'Tiny2: M0', 'Tiny2: M1'], 'в «Прочих» — с названием вендора');
  // маленькая группа без вендоров — сразу модели
  assert.equal(browseGroup(models, 'opencode').mode, 'models');
});

test('searchModels / modelSearchMenu: все слова запроса, без учёта регистра, не больше страницы', () => {
  const models = orModels();
  assert.deepEqual(searchModels(models, 'anthropic m1').map(({ m }) => m.id), ['openrouter/anthropic/m1']);
  assert.equal(searchModels(models, 'PICKLE').length, 1);
  assert.equal(searchModels(models, '   ').length, 0);
  const v = modelSearchMenu({ engine: OC, models, query: 'openrouter', model: 'openrouter/openai/m0', ...RU });
  const b = buttons(v.markup);
  assert.match(v.text, /найдено 23/);
  assert.match(v.text, /Показаны первые 20/);
  assert.equal(b.filter((x) => x.callback_data.startsWith('mdl:opencode:m:')).length, MODEL_PAGE);
  assert.equal(b[0].text, '✓ OpenRouter/OpenAI: M0');
  assert.equal(b.at(-1).callback_data, 'mdl:opencode:g:~');
  assert.match(modelSearchMenu({ engine: OC, models, query: 'нет такой', model: null, ...RU }).text, /ничего не найдено/);
  assert.equal(buttons(modelSearchMenu({ engine: OC, models, query: 'pickle', model: null, ...RU }).markup)[0].text, '🆓 OpenCode Zen/Big Pickle');
});

test('modelMenu: недавние модели кнопками «🕘» сверху, исчезнувшие — не показываются', () => {
  const v = modelMenu({ engine: OC, models: orModels(), model: 'openrouter/openai/m0', effort: null, recent: ['openrouter/openai/m0', 'gone/model', 'opencode/big-pickle'], ...RU });
  const b = buttons(v.markup);
  assert.deepEqual(b.slice(0, 2).map((x) => x.text), ['✓ 🕘 OpenRouter/OpenAI: M0', '🕘 OpenCode Zen/Big Pickle']);
  assert.equal(b[1].callback_data, 'mdl:opencode:m:opencode/big-pickle');
  assert.match(v.text, /Поиск по названию: \/model sonnet/);
  // у движков без групп недавних нет: все модели и так на экране
  assert.equal(buttons(modelMenu({ engine: { id: 'claude', label: 'Claude' }, models: [{ id: 'opus', name: 'Opus' }], model: null, effort: null, recent: ['opus'], ...RU }).markup).length, 2);
});

test('modelGrantsView: вендоры OpenRouter с «разрешено / всего», внутри вендора — переключатели', () => {
  const models = orModels();
  const v = modelGrantsView({ userId: 7, name: 'Ник', engine: OC, models, allowed: ['openrouter/anthropic/m0', 'openrouter/tiny1/m0'], group: 'openrouter', ...RU });
  const b = buttons(v.markup);
  assert.deepEqual(b.slice(0, 3).map((x) => x.text), ['OpenAI 0/12', 'Anthropic 1/8', 'Прочие 1/3']);
  assert.equal(b[1].callback_data, 'adm:ms:7:opencode:openrouter:anthropic:0');
  assert.equal(b.at(-1).callback_data, 'adm:me:7:opencode');
  const s = buttons(modelGrantsView({ userId: 7, name: 'Ник', engine: OC, models, allowed: null, group: 'openrouter', sub: 'anthropic', ...RU }).markup);
  assert.equal(s.filter((x) => x.callback_data.startsWith('adm:mt:')).length, 8);
  assert.equal(s.at(-1).callback_data, 'adm:mg:7:opencode:openrouter:0', 'назад — к вендорам');
});

test('OpenRouter: в «Прочих» вендор перед названием, длинный id вендора — номером в callback_data', () => {
  const models = orModels().map((m) => (m.sub === 'tiny1' ? { ...m, short: 'Ember-1' } : m));
  const other = buttons(modelGroupMenu({ engine: OC, models, group: 'openrouter', sub: OTHER_SUB, model: null, ...RU }).markup);
  assert.equal(other.find((x) => x.callback_data.startsWith('mdl:opencode:m:')).text, 'Tiny1 · Ember-1');
  // вендор с очень длинным id: кнопка — «#номер», и по номеру открывается тот же вендор
  const long = 'v'.repeat(50);
  const many = [...orModels(), ...Array.from({ length: 5 }, (_, i) => ({ id: `openrouter/${long}/x${i}`, name: `OpenRouter/X${i}`, group: 'openrouter', groupLabel: 'OpenRouter', short: `X${i}`, sub: long, subLabel: 'Long' }))];
  const top = buttons(modelGroupMenu({ engine: OC, models: many, group: 'openrouter', model: null, ...RU }).markup);
  const btn = top.find((x) => x.text.startsWith('Long'));
  assert.match(btn.callback_data, /^mdl:opencode:s:openrouter:#\d+:0$/);
  for (const b of top) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  const ref = btn.callback_data.split(':')[4];
  const opened = modelGroupMenu({ engine: OC, models: many, group: 'openrouter', sub: ref, model: null, ...RU });
  assert.equal(buttons(opened.markup).filter((x) => x.callback_data.startsWith('mdl:opencode:m:')).length, 5);
  assert.match(opened.text, /OpenRouter › Long: 5/);
});

const TG_BTN = '<tg-button-row><tg-button type="callback_data" data="adm:l:1:full">Продолжить</tg-button></tg-button-row>';
const F3 = '`'.repeat(3);

test('neutralizeTgTags: кнопки из текста агента не становятся кнопками бота', () => {
  const plain = 'Обычный ответ с <b>тегами</b> и `кодом`.';
  assert.equal(neutralizeTgTags(plain), plain, 'ответ без тегов tg- не меняется');
  const out = neutralizeTgTags(`Готово.\n\n${TG_BTN}\n\nКонец.`);
  assert.ok(!/<\/?tg-/i.test(out), out);
  assert.match(out, /&lt;tg-button-row>&lt;tg-button type="callback_data"/);
  assert.match(out, /&lt;\/tg-button>&lt;\/tg-button-row>/);
  // регистр, одиночная кнопка без ряда, тег посреди строки — Telegram принимает всё это
  for (const md of ['<TG-BUTTON type="callback_data" data="x">a</TG-BUTTON>', 'до <tg-button type="callback_data" data="x">a</tg-button> после', '<tg-emoji emoji-id="1">x</tg-emoji>']) {
    assert.ok(!/<\/?tg-/i.test(neutralizeTgTags(md)), md);
  }
});

test('neutralizeTgTags: в коде тег тоже обезврежен (границы кода бот и Telegram видят по-разному), а на вид не меняется', () => {
  const cases = [`${F3}\n${TG_BTN}\n${F3}`, `текст \`${TG_BTN}\` текст`, `a \`b\n${TG_BTN}\nc\` d`, `${F3}\n${TG_BTN}`];
  for (const md of cases) {
    const out = neutralizeTgTags(md);
    assert.ok(!/<\/?tg-/i.test(out), md);
    assert.ok(!out.includes('&lt;'), 'в коде сущности не разбираются — там невидимый символ');
    assert.equal(out.replaceAll('\u2060', ''), md, 'кроме невидимого символа ничего не изменилось');
  }
});

test('defuseTgTags и startView: путь проекта с тегом кнопки не рисует кнопку', () => {
  assert.equal(defuseTgTags('C:\\p\\<tg-button>').replaceAll('\u2060', ''), 'C:\\p\\<tg-button>');
  assert.ok(!/<tg-button>/.test(defuseTgTags('C:\\p\\<tg-button>')));
  const evil = 'p`<tg-button type="callback_data" data="adm:ro:1">x</tg-button>';
  const view = startView({ level: 'Полный', project: evil, engine: 'Gemini', isAdmin: true, lang: 'ru' });
  assert.ok(!/<tg-button type="callback_data" data="adm:ro:1">/.test(view), view);
  assert.match(view, /<tg-button type="callback_data" data="ui:project">/, 'свои кнопки бота на месте');
});

test('th: шаблон и параметры экранируются, hCode / hBold / hRaw вставляются разметкой', () => {
  assert.equal(th('proj.set', 'ru', { p: hCode('C:/a<b>&c') }).split('\n')[0], '📁 Проект: <code>C:/a&lt;b&gt;&amp;c</code>');
  assert.equal(th('eng.badArg', 'ru', { q: '<i>x</i>', list: 'gemini' }), '⚠️ Неизвестный движок «&lt;i&gt;x&lt;/i&gt;». Доступны: gemini');
  assert.ok(th('eng.already', 'en', { engine: hBold('Codex'), warn: hRaw('\n<i>w</i>') }).endsWith('<b>Codex</b>\n<i>w</i>'));
  // служебный знак вставки в обычном параметре не превращается в разметку
  const mark = String.fromCharCode(1);
  assert.equal(th('proj.same', 'ru', { p: `${mark}0${mark}` }), '📁 Проект уже выбран: 0');
});

test('help: кнопки ведут на страницу справки и открывают её мини-приложением', () => {
  assert.equal(DOCS_URL, 'https://alexey-seleznev.pro/acpgram/docs/');
  assert.deepEqual(docsMenuButton(), { type: 'web_app', text: '📖 Docs', web_app: { url: DOCS_URL } });
  for (const lang of ['en', 'ru', 'uk']) {
    const kb = helpMarkup(lang);
    assert.deepEqual(Object.keys(kb.inline_keyboard[0][0]), ['text', 'url']);
    assert.equal(kb.inline_keyboard[0][0].url, DOCS_URL);
    assert.deepEqual(Object.keys(kb.inline_keyboard[0][1]), ['text', 'web_app']);
    assert.equal(kb.inline_keyboard[0][1].web_app.url, DOCS_URL);
    assert.ok(t('help.text', lang, { url: DOCS_URL }).includes(DOCS_URL));
    assert.ok(t('menu.help', lang).trim());
    assert.ok(startView({ level: 'Full', project: 'p', engine: 'Gemini', isAdmin: false, lang }).includes(t('help.help', lang)));
  }
});

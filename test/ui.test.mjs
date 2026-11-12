import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plural, t } from '../src/i18n.mjs';
import { richToPlain } from '../src/telegram.mjs';
import { ANIM, activeSessionsView, composeDraft, engineMenu, sessionStatus, finalExtras, finalMessages, fmtDuration, skillName, startView, stepLine } from '../src/ui.mjs';

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
  assert.ok(m.text.startsWith('🤖 Движок: Claude Code') && m.text.includes('Недоступны на сервере: Antigravity CLI'), m.text);
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

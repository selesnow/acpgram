// Модели, уровни рассуждений и расход: разбор ответов агентов (сняты с живых Gemini CLI 0.68, claude-agent-acp 0.106, agy 1.5.5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINES, autoValue, parseCatalog, parseUsage, selectionRequest } from '../src/engines.mjs';
import { engineGrants, finalExtras, fmtCost, fmtTokens, modelGrantsOverview, modelChosen, modelGrantsView, modelMenu, startView } from '../src/ui.mjs';

const GEMINI_NEW = {
  sessionId: 's',
  modes: { currentModeId: 'autoEdit', availableModes: [] },
  models: {
    currentModelId: 'auto',
    availableModels: [
      { modelId: 'auto', name: 'Auto' },
      { modelId: 'gemini-3.1-pro-preview-customtools', name: 'gemini-3.1-pro-preview' },
      { modelId: 'gemini-3.8-flash', name: 'gemini-3.8-flash' },
    ],
  },
};
const CLAUDE_NEW = {
  sessionId: 's',
  configOptions: [
    { id: 'mode', currentValue: 'auto', options: [{ value: 'plan', name: 'Plan' }] },
    { id: 'model', currentValue: 'opus', options: [{ value: 'default', name: 'Default (recommended)' }, { value: 'opus', name: 'Opus' }, { value: 'claude-fable-5-1[1m]', name: 'Fable 5.1 (1M)' }, { value: 'haiku', name: 'Haiku' }] },
    { id: 'effort', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'max', name: 'Max' }] },
  ],
};
const AGY_NEW = {
  sessionId: 's',
  models: { currentModelId: 'gemini-4-carbon-medium', availableModels: [{ modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' }] },
  configOptions: [
    { id: 'model', currentValue: 'gemini-4-carbon', options: [{ value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }, { value: 'gemini-4-argon', name: 'Gemini 4 Argon' }] },
    { id: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  ],
};

test('parseCatalog: Codex (codex-acp 2.6.0) — модель и reasoning_effort из configOptions', () => {
  const res = { configOptions: [
    { id: 'model', currentValue: 'gpt-6.1-sol', options: [{ value: 'gpt-6.1-sol', name: '6.1 Sol' }, { value: 'gpt-6-luna', name: '6 Luna' }] },
    { id: 'reasoning_effort', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ] };
  const c = parseCatalog(ENGINES.codex, res);
  assert.deepEqual(c.models.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.deepEqual(c.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(c.defaultModel, 'gpt-6.1-sol');
  assert.equal(autoValue(ENGINES.codex, c, 'model'), 'gpt-6.1-sol');
  assert.deepEqual(selectionRequest(ENGINES.codex, 's1', 'effort', 'high'), ['session/set_config_option', { sessionId: 's1', configId: 'reasoning_effort', value: 'high' }]);
});

test('parseCatalog: модели и уровни рассуждений каждого движка, «Авто» агента — не в списке', () => {
  const g = parseCatalog(ENGINES.gemini, GEMINI_NEW);
  assert.deepEqual(g.models.map((m) => m.id), ['gemini-3.1-pro-preview-customtools', 'gemini-3.8-flash']);
  assert.deepEqual(g.efforts, []);
  assert.equal(g.defaultModel, 'auto');

  const c = parseCatalog(ENGINES.claude, CLAUDE_NEW);
  assert.deepEqual(c.models.map((m) => m.id), ['opus', 'claude-fable-5-1[1m]', 'haiku']);
  assert.deepEqual(c.efforts.map((e) => e.id), ['low', 'max']);
  assert.equal(c.models[1].name, 'Fable 5.1 (1M)');

  // у Antigravity модели берутся из настроек сессии (6 моделей), а не из списка «модель × уровень»
  const a = parseCatalog(ENGINES.agy, AGY_NEW);
  assert.deepEqual(a.models.map((m) => m.id), ['gemini-4-carbon', 'gemini-4-argon']);
  assert.deepEqual(a.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(a.defaultModel, 'gemini-4-carbon');
  assert.equal(a.defaultEffort, 'medium');

  // группы вариантов разворачиваются, пустой ответ — пустой каталог
  const grouped = parseCatalog(ENGINES.claude, { configOptions: [{ id: 'model', options: [{ group: 'g', options: [{ value: 'sonnet', name: 'Sonnet' }] }] }] });
  assert.deepEqual(grouped.models, [{ id: 'sonnet', name: 'Sonnet' }]);
  assert.deepEqual(parseCatalog(ENGINES.agy, {}), { models: [], efforts: [], defaultModel: null, defaultEffort: null });
});

test('autoValue и selectionRequest: как вернуть «Авто» и каким методом ACP менять', () => {
  assert.equal(autoValue(ENGINES.gemini, {}, 'model'), 'auto');
  assert.equal(autoValue(ENGINES.claude, {}, 'model'), 'default');
  assert.equal(autoValue(ENGINES.claude, {}, 'effort'), 'default');
  assert.equal(autoValue(ENGINES.agy, { defaultModel: 'gemini-4-carbon', defaultEffort: 'medium' }, 'model'), 'gemini-4-carbon');
  assert.equal(autoValue(ENGINES.agy, { defaultModel: 'gemini-4-carbon', defaultEffort: 'medium' }, 'effort'), 'medium');

  assert.deepEqual(selectionRequest(ENGINES.gemini, 's1', 'model', 'gemini-3.8-flash'), ['session/set_model', { sessionId: 's1', modelId: 'gemini-3.8-flash' }]);
  assert.deepEqual(selectionRequest(ENGINES.claude, 's1', 'model', 'haiku'), ['session/set_config_option', { sessionId: 's1', configId: 'model', value: 'haiku' }]);
  assert.deepEqual(selectionRequest(ENGINES.claude, 's1', 'effort', 'max'), ['session/set_config_option', { sessionId: 's1', configId: 'effort', value: 'max' }]);
  assert.deepEqual(selectionRequest(ENGINES.agy, 's1', 'effort', 'high'), ['session/set_config_option', { sessionId: 's1', configId: 'thought_level', value: 'high' }]);
});

test('parseUsage: токены, реальная модель и стоимость', () => {
  const claude = parseUsage(
    { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 5, cachedReadTokens: 25697, cachedWriteTokens: 11121, totalTokens: 36825 }, _meta: { quota: { model_usage: [{ model: 'claude-haiku-5-5' }] } } },
    { sessionUpdate: 'usage_update', used: 36825, size: 1000000, cost: { amount: 0.006374, currency: 'USD' }, _meta: { '_claude/model': 'claude-haiku-5-5' } },
  );
  assert.deepEqual(claude, { model: 'claude-haiku-5-5', input: 2, output: 5, cachedRead: 25697, thought: null, total: 36825, costTotal: 0.006374 });

  // у Claude Code в model_usage могут быть субагенты — основная модель берётся из _claude/model
  const sub = parseUsage({ _meta: { quota: { model_usage: [{ model: 'claude-haiku-5-5' }, { model: 'claude-opus-5-5' }] } } }, { _meta: { '_claude/model': 'claude-opus-5-5' } });
  assert.equal(sub.model, 'claude-opus-5-5');

  const gemini = parseUsage({ usage: { inputTokens: 36561, outputTokens: 1, thoughtTokens: 166, totalTokens: 36562 }, _meta: { quota: { model_usage: [{ model: 'gemini-3.8-flash' }] } } }, { used: 36562, size: 1048576 });
  assert.equal(gemini.model, 'gemini-3.8-flash');
  assert.equal(gemini.thought, 166);
  assert.equal(gemini.costTotal, null);

  // Antigravity: только токены, модель берётся из выбора
  const agy = parseUsage({ usage: { inputTokens: 16807, outputTokens: 77, totalTokens: 16884 } }, null);
  assert.equal(agy.model, null);
  assert.equal(agy.total, 16884);
  assert.deepEqual(parseUsage(undefined, undefined), { model: null, input: null, output: null, cachedRead: null, thought: null, total: null, costTotal: null });
});

test('подвал ответа: движок, модель, уровень рассуждений, токены, стоимость', () => {
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(1500), '1.5k');
  assert.equal(fmtTokens(36785), '36.8k');
  assert.equal(fmtTokens(1_250_000), '1.25M');
  assert.equal(fmtTokens(999_950), '1M', 'граница: не «1000k»');
  assert.equal(fmtTokens(999_940), '999.9k');
  assert.equal(fmtTokens(9_999), '10k');
  assert.equal(fmtCost(0.0047242), '0.0047');
  assert.equal(fmtCost(0.46016), '0.46');

  const full = finalExtras({ lang: 'ru', elapsedMs: 4000, project: 'p', engine: 'Claude', usage: { model: 'claude-haiku-5-5', effort: 'Max', total: 36825, cost: 0.0016 } });
  assert.equal(full, '<footer>🤖 Claude · claude-haiku-5-5 · Max · 🔢 36.8k ток. · 💲0.0016 · 📁 p · ⏱ 4 с</footer>');
  // без расхода (ошибка, прерывание) — как раньше, плюс движок
  assert.equal(finalExtras({ lang: 'ru', elapsedMs: 1000, project: 'p', engine: 'Gemini', usage: null }), '<footer>🤖 Gemini · 📁 p · ⏱ 1 с</footer>');
  assert.equal(finalExtras({ lang: 'ru', elapsedMs: 1000, project: 'p' }), '<footer>📁 p · ⏱ 1 с</footer>');
});

test('modelMenu: «Авто», выбор, уровни рассуждений, ограничение администратора, длинные id', () => {
  const engine = { id: 'claude', label: 'Claude Code' };
  const models = [{ id: 'opus', name: 'Opus' }, { id: 'haiku', name: 'Haiku' }];
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }];
  const v = modelMenu({ lang: 'ru', engine, models, efforts, model: 'haiku', effort: null });
  assert.ok(v.text.includes('Сейчас: Haiku') && v.text.includes('Рассуждения: Авто'), v.text);
  const btns = v.markup.inline_keyboard.flat();
  assert.deepEqual(btns.map((b) => b.callback_data), ['mdl:claude:m:~', 'mdl:claude:m:opus', 'mdl:claude:m:haiku', 'mdl:claude:e:~', 'mdl:claude:e:low', 'mdl:claude:e:max']);
  assert.equal(btns.find((b) => b.callback_data === 'mdl:claude:m:haiku').text, '✓ Haiku');
  assert.equal(btns.find((b) => b.callback_data === 'mdl:claude:e:~').text, '✓ 🧠 Авто');

  // ограничение: без «Авто», с пометкой
  const r = modelMenu({ lang: 'ru', engine, models, model: 'opus', effort: null, restricted: true });
  assert.ok(!r.markup.inline_keyboard.flat().some((b) => b.callback_data.endsWith(':m:~')));
  assert.ok(r.text.includes('ограничен администратором'));

  // Gemini: без уровня рассуждений; id длиннее лимита callback_data — номер в списке
  const long = 'x'.repeat(80);
  const g = modelMenu({ lang: 'ru', engine: { id: 'gemini', label: 'Gemini CLI' }, models: [{ id: long, name: 'Long' }], model: null, effort: null });
  assert.ok(!g.text.includes('Рассуждения'));
  const data = g.markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(data, ['mdl:gemini:m:~', 'mdl:gemini:m:#0']);
  assert.ok(data.every((d) => Buffer.byteLength(d) <= 64));
});

test('права в карточке сотрудника: движки и модели', () => {
  const eg = engineGrants({
    lang: 'ru',
    userId: 5,
    engines: [
      { id: 'gemini', label: 'Gemini CLI', granted: true, isDefault: true },
      { id: 'claude', label: 'Claude Code', granted: true, isDefault: false },
      { id: 'agy', label: 'Antigravity CLI', granted: false, isDefault: false },
    ],
  });
  assert.equal(eg.line, 'Движки: Gemini CLI (по умолчанию), Claude Code');
  // движок по умолчанию переключателя не имеет
  assert.deepEqual(eg.rows.flat().map((b) => [b.text, b.callback_data]), [['✅ Claude Code', 'adm:et:5:claude'], ['⬜ Antigravity CLI', 'adm:et:5:agy'], ['🧠 Модели сотрудника', 'adm:mm:5']]);

  const o = modelGrantsOverview({ lang: 'ru', userId: 5, name: '@u', engines: [{ id: 'gemini', label: 'Gemini CLI', total: 5, allowed: null }, { id: 'claude', label: 'Claude Code', total: 4, allowed: 2 }, { id: 'agy', label: 'Antigravity CLI', total: 0, allowed: null }] });
  assert.ok(o.text.includes('Gemini CLI: все модели') && o.text.includes('Claude Code: 2 из 4') && o.text.includes('ещё не получен'), o.text);

  const models = [{ id: 'opus', name: 'Opus' }, { id: 'haiku', name: 'Haiku' }];
  const all = modelGrantsView({ lang: 'ru', userId: 5, name: '@u', engine: { id: 'claude', label: 'Claude Code' }, models, allowed: null });
  assert.deepEqual(all.markup.inline_keyboard.flat().map((b) => b.text), ['✅ Opus', '✅ Haiku', '← Назад']);
  const part = modelGrantsView({ lang: 'ru', userId: 5, name: '@u', engine: { id: 'claude', label: 'Claude Code' }, models, allowed: ['haiku'] });
  // кнопка несёт id модели, а не номер: обновление списка моделей не переключит чужую модель
  assert.deepEqual(part.markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data]), [['⬜ Opus', 'adm:mt:5:claude:opus'], ['✅ Haiku', 'adm:mt:5:claude:haiku'], ['✅ Разрешить все', 'adm:ma:5:claude'], ['← Назад', 'adm:mm:5']]);
  assert.ok(part.markup.inline_keyboard.flat().every((b) => Buffer.byteLength(b.callback_data) <= 64));
});

test('startView: модель и кнопка /model', () => {
  const s = startView({ lang: 'ru', level: 'Чтение', project: 'p', engine: 'Claude Code', model: 'Haiku', isAdmin: false });
  assert.ok(s.includes('**🧠 Модель:** Haiku') && s.includes('data="ui:model"') && s.includes('/model'), s);
  assert.ok(startView({ lang: 'ru', level: 'x', project: 'p', engine: 'Gemini CLI', isAdmin: false }).includes('**🧠 Модель:** Авто'));
});

test('modelChosen: итог выбора вместо меню — движок, модель, уровень рассуждений', () => {
  const engine = { id: 'claude', label: 'Claude Code' };
  const models = [{ id: 'opus', name: 'Opus' }, { id: 'haiku', name: 'Haiku' }];
  const efforts = [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }];
  const ru = modelChosen({ lang: 'ru', engine, models, efforts, model: 'haiku', effort: 'max' });
  assert.ok(ru.includes('Выбран движок: Claude Code') && ru.includes('Выбрана модель: Haiku') && ru.includes('Рассуждения: Max'), ru);
  assert.ok(!ru.includes('Сейчас:'), 'это итог, а не меню');
  // «Авто» для модели и уровня
  const auto = modelChosen({ lang: 'ru', engine, models, efforts, model: null, effort: null });
  assert.ok(auto.includes('Выбрана модель: Авто') && auto.includes('Рассуждения: Авто'), auto);
  // Gemini: без уровня рассуждений; другие языки
  const g = modelChosen({ lang: 'en', engine: { id: 'gemini', label: 'Gemini CLI' }, models: [{ id: 'g', name: 'Gem' }], model: 'g', effort: null });
  assert.ok(g.includes('Engine selected: Gemini CLI') && g.includes('Model selected: Gem') && !g.includes('Reasoning'), g);
  assert.ok(modelChosen({ lang: 'uk', engine, models, model: 'opus' }).includes('Обрано модель: Opus'));
});

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_LANG, LANGS, LANG_CODES, MESSAGES, maskErrorPaths, normLang, pickLang, plural, t, errText, i18nError } from '../src/i18n.mjs';

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('каждый ключ переведён на все языки и содержит одинаковые подстановки', () => {
  for (const [key, entry] of Object.entries(MESSAGES)) {
    for (const code of LANG_CODES) {
      assert.ok(typeof entry[code] === 'string' && entry[code].trim(), `${key}: нет перевода «${code}»`);
    }
    const ref = placeholders(entry.en);
    for (const code of LANG_CODES) assert.equal(placeholders(entry[code]), ref, `${key}: разные подстановки в «${code}»`);
  }
});

test('язык по умолчанию — английский, языки интерфейса — английский, русский, украинский', () => {
  assert.equal(DEFAULT_LANG, 'en');
  assert.deepEqual(LANG_CODES, ['en', 'ru', 'uk']);
  assert.equal(LANGS.uk, 'Українська');
});

test('normLang: код языка из строки, неизвестное — null', () => {
  assert.equal(normLang('ru'), 'ru');
  assert.equal(normLang(' RU-ru '), 'ru');
  assert.equal(normLang('uk'), 'uk');
  assert.equal(normLang('de'), null);
  assert.equal(normLang(undefined), null);
  assert.equal(normLang(''), null);
});

test('t: подстановки, язык без перевода — английский', () => {
  assert.equal(t('lang.set', 'ru', { name: 'Русский' }), '🌐 Язык: Русский. Сменить можно в любой момент: /language');
  assert.equal(t('lang.set', 'uk', { name: 'Українська' }), '🌐 Мову обрано: Українська. Змінити можна будь-коли: /language');
  assert.equal(t('auto', 'de'), 'Auto');
  assert.equal(t('auto'), 'Auto', 'без языка — английский');
  // подстановка не трогает тексты, которые пришли как значения
  assert.equal(t('engine.current', 'en', { engine: '{name}' }), '🤖 Engine: {name}');
  assert.throws(() => t('no.such.key', 'en'), /нет ключа/);
});

test('plural: английский и славянские формы', () => {
  assert.equal(plural(1, 'step', 'en'), '1 step');
  assert.equal(plural(2, 'step', 'en'), '2 steps');
  assert.equal(plural(0, 'step', 'en'), '0 steps');
  assert.equal(plural(1, 'step', 'ru'), '1 шаг');
  assert.equal(plural(4, 'step', 'ru'), '4 шага');
  assert.equal(plural(12, 'step', 'ru'), '12 шагов');
  assert.equal(plural(1, 'step', 'uk'), '1 крок');
  assert.equal(plural(3, 'step', 'uk'), '3 кроки');
  assert.equal(plural(13, 'step', 'uk'), '13 кроків');
});

test('pickLang: выбор в боте важнее языка Telegram, неподдерживаемый язык — по умолчанию', () => {
  assert.equal(pickLang('uk', 'ru'), 'uk', 'выбранный в /language важнее');
  assert.equal(pickLang(null, 'ru-RU'), 'ru', 'язык Telegram с регионом');
  assert.equal(pickLang(undefined, 'UK'), 'uk');
  assert.equal(pickLang('', 'en'), 'en');
  assert.equal(pickLang(null, 'de'), DEFAULT_LANG, 'немецкий не поддерживается');
  assert.equal(pickLang(null, null), DEFAULT_LANG);
  assert.equal(pickLang(), DEFAULT_LANG);
});

test('errText: ошибка нижнего слоя показывается на языке пользователя, прочие — своим текстом', () => {
  const e = i18nError('Gemini CLI завершился (код 1)', 'err.agentExit', { engine: 'Gemini CLI', code: 1 }, { code: 'X' });
  assert.equal(e.message, 'Gemini CLI завершился (код 1)', 'в журнал — как раньше');
  assert.equal(e.code, 'X');
  assert.equal(errText(e, 'en'), 'Gemini CLI exited (code 1)');
  assert.equal(errText(e, 'uk'), 'Gemini CLI завершився (код 1)');
  assert.equal(errText(e, 'ru'), e.message);
  assert.equal(errText(new Error('ACP -32000: boom'), 'en'), 'ACP -32000: boom');
  const git = Object.assign(new Error('фатально'), { i18n: { key: 'err.gitExit', vars: { cmd: 'status', code: 128 } } });
  assert.equal(errText(git, 'en'), 'git status: exit code 128');
  assert.equal(errText(git, 'ru'), 'git status: код 128');
  assert.equal(errText(Object.assign(new Error('x'), { i18n: { key: 'no.such.key' } }), 'en'), 'x', 'неизвестный ключ не роняет показ ошибки');
  const withCause = i18nError('m', 'err.tgNoFilePath', {}, {}, { cause: new Error('c') });
  assert.equal(withCause.cause.message, 'c');
});

test('errText: пути в ошибке сотрудника с личным пространством маскируются', () => {
  const root = resolve(tmpdir(), 'acpgram-root', '4001');
  const inside = join(root, 'app', 'a.py');
  const outside = resolve(tmpdir(), 'Windows', 'system32.dll');
  const raw = `git: ${inside}: ошибка ${outside}.`;
  const out = errText(new Error(raw), 'ru', root);
  assert.ok(!out.includes(root), 'путь на сервере не показан');
  assert.ok(out.includes(`app${sep}a.py`), 'путь внутри личного пространства показан от его папки');
  assert.ok(out.includes(t('err.serverPath', 'ru')), 'чужой путь заменён подстановкой');
  assert.equal(maskErrorPaths(raw, null, 'ru'), raw, 'без корня текст не меняется');
});

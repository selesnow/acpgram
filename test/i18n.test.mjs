import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LANG, LANGS, LANG_CODES, MESSAGES, normLang, pickLang, plural, t } from '../src/i18n.mjs';

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

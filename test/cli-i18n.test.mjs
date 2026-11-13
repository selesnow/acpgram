import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_LANGS, CLI_MESSAGES, detectLang, langFromLocale, parseRegValue, setCliLang, tc } from '../src/cli-i18n.mjs';
import { help, route } from '../src/cli.mjs';
import { serializeEnv } from '../src/setup.mjs';
import { diagnoseCreate } from '../src/winsvc.mjs';

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('словарь терминала: у каждого ключа есть перевод на все языки и совпадают подстановки', () => {
  assert.deepEqual(CLI_LANGS, ['en', 'ru', 'uk']);
  for (const [key, entry] of Object.entries(CLI_MESSAGES)) {
    for (const code of CLI_LANGS) assert.ok(typeof entry[code] === 'string' && entry[code].trim(), `${key}: нет перевода «${code}»`);
    const ref = placeholders(entry.en);
    for (const code of CLI_LANGS) assert.equal(placeholders(entry[code]), ref, `${key}: разные подстановки в «${code}»`);
  }
});

test('langFromLocale: русский, украинский, остальное — английский, служебные значения — null', () => {
  for (const v of ['ru', 'ru_RU.UTF-8', 'ru-RU', 'RU', 'ru:en', '0x0419', '0419']) assert.equal(langFromLocale(v), 'ru', v);
  for (const v of ['uk', 'uk_UA.UTF-8', 'uk-UA', '0x0422', '0422']) assert.equal(langFromLocale(v), 'uk', v);
  for (const v of ['en_US.UTF-8', 'en-GB', 'de_DE', 'pl-PL', '0409', 'zh_CN.UTF-8']) assert.equal(langFromLocale(v), 'en', v);
  for (const v of ['C', 'POSIX', 'c', '', '  ', undefined, null]) assert.equal(langFromLocale(v), null, String(v));
});

test('parseRegValue: значение из вывода reg query', () => {
  assert.equal(parseRegValue('\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    PreferredUILanguages    REG_MULTI_SZ    ru-RU\\0en-US\r\n'), 'ru-RU\\0en-US');
  assert.equal(parseRegValue('    InstallLanguage    REG_SZ    0419\r\n'), '0419');
  assert.equal(parseRegValue('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.equal(parseRegValue(undefined), null);
});

test('detectLang: ACPGRAM_LANG важнее всего', () => {
  assert.equal(detectLang({ env: { ACPGRAM_LANG: 'uk', LANG: 'ru_RU.UTF-8' }, platform: 'linux' }), 'uk');
  assert.equal(detectLang({ env: { ACPGRAM_LANG: 'EN', LANG: 'ru_RU.UTF-8' }, platform: 'linux' }), 'en');
  assert.equal(detectLang({ env: { ACPGRAM_LANG: 'de', LANG: 'ru_RU.UTF-8' }, platform: 'linux' }), 'ru', 'неподдерживаемое значение игнорируется');
});

test('detectLang (Linux, macOS): LC_ALL, LC_MESSAGES, LANGUAGE, LANG; «C» пропускается; без данных — Intl', () => {
  const d = (env, intl = () => 'en-US') => detectLang({ env, platform: 'linux', intl });
  assert.equal(d({ LANG: 'ru_RU.UTF-8' }), 'ru');
  assert.equal(d({ LANG: 'uk_UA.UTF-8' }), 'uk');
  assert.equal(d({ LANG: 'de_DE.UTF-8' }), 'en', 'другой язык — английский');
  assert.equal(d({ LC_ALL: 'uk_UA.UTF-8', LANG: 'ru_RU.UTF-8' }), 'uk', 'LC_ALL приоритетнее LANG');
  assert.equal(d({ LC_ALL: 'C', LANG: 'ru_RU.UTF-8' }), 'ru', '«C» не язык, берём следующую переменную');
  assert.equal(d({ LANGUAGE: 'ru:en' }), 'ru');
  assert.equal(d({}, () => 'uk-UA'), 'uk', 'без переменных — локаль Intl');
  assert.equal(d({}, () => { throw new Error('нет ICU'); }), 'en');
});

test('detectLang (Windows): язык интерфейса из реестра, а не региональные настройки', () => {
  const reg = (values) => (key, name) => values[`${key}|${name}`] ?? null;
  const UI = 'HKCU\\Control Panel\\Desktop|PreferredUILanguages';
  const MUI = 'HKCU\\Control Panel\\Desktop\\MuiCached|MachinePreferredUILanguages';
  const INSTALL = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\Language|InstallLanguage';
  const d = (values, intl = () => 'ru-RU') => detectLang({ env: {}, platform: 'win32', reg: reg(values), intl });
  assert.equal(d({ [UI]: 'uk-UA\\0en-US' }), 'uk', 'язык, выбранный пользователем');
  assert.equal(d({ [MUI]: 'ru-RU' }), 'ru');
  assert.equal(d({ [INSTALL]: '0419' }), 'ru', 'язык установки системы');
  assert.equal(d({ [UI]: 'en-US', [MUI]: 'ru-RU' }), 'en', 'английский интерфейс при русском формате дат — английский');
  assert.equal(d({}, () => 'uk-UA'), 'uk', 'реестр недоступен — Intl');
  assert.equal(d({}, () => 'fr-FR'), 'en');
  assert.equal(detectLang({ env: {}, platform: 'win32', reg: () => { throw new Error('reg запрещён'); }, intl: () => 'ru-RU' }), 'ru', 'ошибка reg не роняет определение языка');
});

test('tc: язык по умолчанию и явный, подстановки, неизвестный ключ — ошибка', () => {
  setCliLang('en');
  assert.match(tc('cli.updating', { before: '1.0.0' }), /^Updating AcpGram \(currently 1\.0\.0\)/);
  assert.match(tc('cli.updating', { before: '1.0.0' }, 'ru'), /^Обновляю AcpGram \(сейчас 1\.0\.0\)/);
  assert.match(tc('cli.updating', { before: '1.0.0' }, 'uk'), /^Оновлюю AcpGram \(зараз 1\.0\.0\)/);
  assert.equal(tc('svc.notInstalledOk', { name: 'x' }, 'de'), '  The service x is not installed.', 'неизвестный язык — английский');
  assert.throws(() => tc('no.such.key'), /нет ключа/);
});

test('справка, ошибка команды, .env и диагностика службы говорят на языке терминала', () => {
  setCliLang('en');
  assert.match(help(), /start the bot/);
  assert.match(route(['nope']).error, /^Unknown command: nope/);
  assert.match(serializeEnv({ TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1' }, { date: '2026-11-13' }), /Bot token from @BotFather/);
  assert.match(diagnoseCreate({ exists: true, name: 'acpgram', nssmStatus: 1 }).text, /already exists/);
  setCliLang('ru');
  assert.match(help(), /запустить бота/);
  assert.match(route(['nope']).error, /^Неизвестная команда: nope/);
  assert.match(serializeEnv({ TELEGRAM_BOT_TOKEN: 't', ALLOWED_USER_ID: '1' }, { date: '2026-11-13' }), /Токен бота от @BotFather/);
  setCliLang('uk');
  assert.match(help(), /запустити бота/);
  assert.match(route(['nope']).error, /^Невідома команда: nope/);
  assert.match(serializeEnv({ TELEGRAM_BOT_TOKEN: 't' }, { date: '2026-11-13', lang: 'en' }), /Bot token from @BotFather/, 'явный язык важнее');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t } from '../src/i18n.mjs';
import { removeReplyKeyboard, replyCommandOf, replyKeyboard } from '../src/ui.mjs';

const LANGS = ['en', 'ru', 'uk'];

test('replyKeyboard: четыре базовых ряда, one_time_keyboard и подписи на языке пользователя', () => {
  for (const lang of LANGS) {
    const kb = replyKeyboard(lang);
    assert.equal(kb.resize_keyboard, true);
    assert.equal(kb.one_time_keyboard, true, 'после нажатия клавиатура сворачивается в иконку');
    assert.equal(kb.is_persistent, undefined, 'родное скрытие/показ клавиатуры Telegram должно работать без is_persistent');
    assert.deepEqual(kb.keyboard.map((row) => row.length), [3, 3, 3, 2]);
    assert.deepEqual(kb.keyboard.flat().map((b) => b.text), [
      t('start.btn.project', lang),
      t('start.btn.files', lang),
      t('start.btn.git', lang),
      t('start.btn.engine', lang),
      t('start.btn.model', lang),
      t('start.btn.sessions', lang),
      t('start.btn.new', lang),
      t('btn.stop', lang),
      t('reply.close', lang),
      t('btn.language', lang),
      t('reply.help', lang),
    ]);
  }
  assert.deepEqual(removeReplyKeyboard(), { remove_keyboard: true });
});

test('replyKeyboard: переключатель тем в 4-м ряду, кнопка /new зависит от topics === on, админские — 2x2', () => {
  const off = replyKeyboard('ru', { admin: true, topics: 'off' });
  assert.deepEqual(off.keyboard.map((row) => row.length), [3, 3, 3, 3, 2, 2]);
  assert.equal(off.keyboard[2][0].text, t('start.btn.new', 'ru'), 'при topics: off кнопка /new — Новая сессия');
  assert.equal(off.keyboard[3][2].text, t('start.btn.topicsOff', 'ru'));
  assert.deepEqual(off.keyboard[4].map((b) => b.text), [t('start.btn.users', 'ru'), t('start.btn.active', 'ru')]);
  assert.deepEqual(off.keyboard[5].map((b) => b.text), [t('start.btn.invite', 'ru'), t('reply.usage', 'ru')]);

  const on = replyKeyboard('ru', { admin: false, topics: 'on' });
  assert.deepEqual(on.keyboard.map((row) => row.length), [3, 3, 3, 3]);
  assert.equal(on.keyboard[2][0].text, t('reply.topic', 'ru'), 'при topics: on кнопка /new — Новая тема');
  assert.equal(on.keyboard[3][2].text, t('start.btn.topicsOn', 'ru'));
});

test('replyCommandOf: узнаёт любую кнопку на любом поддерживаемом языке, в любом режиме тем и старую подпись close', () => {
  const commands = {
    'start.btn.project': 'project',
    'start.btn.files': 'files',
    'start.btn.git': 'git',
    'start.btn.engine': 'engine',
    'start.btn.model': 'model',
    'start.btn.sessions': 'sessions',
    'start.btn.new': 'new',
    'reply.topic': 'new',
    'btn.stop': 'stop',
    'reply.close': 'close',
    'start.btn.close': 'close',
    'btn.language': 'language',
    'reply.help': 'help',
    'start.btn.topicsOn': 'topics',
    'start.btn.topicsOff': 'topics',
    'start.btn.users': 'users',
    'start.btn.active': 'active',
    'start.btn.invite': 'invite',
    'reply.usage': 'usage',
  };
  for (const lang of LANGS) {
    for (const [key, name] of Object.entries(commands)) {
      assert.deepEqual(replyCommandOf(t(key, lang)), { name }, `${lang}: ${key}`);
    }
  }
});

test('replyCommandOf: обычный текст и текст с пробелами по краям не распознаются как команда', () => {
  assert.equal(replyCommandOf('просто запрос агенту'), null);
  assert.equal(replyCommandOf(` ${t('btn.stop', 'en')} `), null, 'пробелы вокруг подписи не превращают её в команду');
});

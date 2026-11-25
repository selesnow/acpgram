import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t } from '../src/i18n.mjs';
import { replyCommandOf, replyKeyboard } from '../src/ui.mjs';

const LANGS = ['en', 'ru', 'uk'];

test('replyKeyboard: четыре базовых ряда с подписями на языке пользователя', () => {
  for (const lang of LANGS) {
    const kb = replyKeyboard(lang);
    assert.equal(kb.resize_keyboard, true);
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
      t('start.btn.close', lang),
      t('btn.language', lang),
      t('reply.help', lang),
    ]);
  }
});

test('replyKeyboard: административные кнопки и режим диалогов — отдельные ряды', () => {
  const kb = replyKeyboard('ru', { admin: true, topics: 'off' });
  assert.deepEqual(kb.keyboard.map((row) => row.length), [3, 3, 3, 2, 1, 4]);
  assert.deepEqual(kb.keyboard[4].map((b) => b.text), [t('start.btn.topicsOff', 'ru')]);
  assert.deepEqual(kb.keyboard[5].map((b) => b.text), [t('start.btn.users', 'ru'), t('start.btn.active', 'ru'), t('start.btn.invite', 'ru'), t('reply.usage', 'ru')]);
});

test('replyCommandOf: каждая кнопка узнаётся на своём языке', () => {
  const commands = {
    'start.btn.project': 'project',
    'start.btn.files': 'files',
    'start.btn.git': 'git',
    'start.btn.engine': 'engine',
    'start.btn.model': 'model',
    'start.btn.sessions': 'sessions',
    'start.btn.new': 'new',
    'btn.stop': 'stop',
    'start.btn.close': 'close',
    'btn.language': 'language',
    'reply.help': 'help',
    'start.btn.users': 'users',
    'start.btn.active': 'active',
    'start.btn.invite': 'invite',
    'reply.usage': 'usage',
  };
  for (const lang of LANGS) {
    for (const [key, name] of Object.entries(commands)) {
      assert.deepEqual(replyCommandOf(t(key, lang), lang, { admin: true }), { name }, `${lang}: ${key}`);
    }
    assert.deepEqual(replyCommandOf(t('reply.topic', lang), lang, { admin: true, topics: 'off' }), { name: 'new' }, `${lang}: reply.topic`);
    assert.deepEqual(replyCommandOf(t('start.btn.topicsOff', lang), lang, { admin: true, topics: 'off' }), { name: 'topics' }, `${lang}: topicsOff`);
    assert.deepEqual(replyCommandOf(t('reply.topic', lang), lang, { admin: true, topics: 'on' }), { name: 'new' }, `${lang}: reply.topic`);
    assert.deepEqual(replyCommandOf(t('start.btn.topicsOn', lang), lang, { admin: true, topics: 'on' }), { name: 'topics' }, `${lang}: topicsOn`);
  }
});

test('replyCommandOf: обычный текст не команда и не совпадает с подписями кнопок', () => {
  assert.equal(replyCommandOf('просто запрос агенту', 'ru'), null);
  assert.equal(replyCommandOf(t('reply.usage', 'ru'), 'ru'), null);
  assert.equal(replyCommandOf(t('reply.topic', 'ru'), 'ru'), null);
  assert.equal(replyCommandOf(` ${t('btn.stop', 'en')} `, 'en'), null, 'пробелы вокруг подписи не превращают её в команду');
});

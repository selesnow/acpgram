import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTitle, extractTitle, projectLabel, stripTitle, titleFromRequest, topicInfoOf, topicLink, topicName } from '../src/topics.mjs';
import { dest } from '../src/telegram.mjs';

const FENCE = '`'.repeat(3);

test('extractTitle: метка названия убирается из ответа, название чистится', () => {
  assert.deepEqual(extractTitle('[[title: Отчёт по списаниям]]\nГотово, вот отчёт.'), { title: 'Отчёт по списаниям', text: 'Готово, вот отчёт.' });
  assert.deepEqual(extractTitle('  [[title: "**Фикс бота**".]]  \n\nТекст'), { title: 'Фикс бота', text: 'Текст' });
  assert.deepEqual(extractTitle('Без метки'), { title: null, text: 'Без метки' });
  // в коде метка — не команда
  const code = `Пример:\n${FENCE}\n[[title: x]]\n${FENCE}`;
  assert.deepEqual(extractTitle(code), { title: null, text: code });
  // только первая метка
  assert.equal(extractTitle('[[title: А]]\nтекст [[title: Б]]').title, 'А');
});

test('stripTitle: в черновике не видно ни целой, ни недописанной метки', () => {
  for (const partial of ['[', '[[', '[[tit', '[[title:', '[[title: Отчёт по', '[[title: Отчёт]', '  [[title: Отчёт]]']) {
    assert.equal(stripTitle(partial), '', partial);
  }
  assert.equal(stripTitle('[[title: Отчёт]]\nПишу ответ'), 'Пишу ответ');
  assert.equal(stripTitle('Обычный ответ [1]'), 'Обычный ответ [1]');
});

test('cleanTitle и titleFromRequest: одна строка, без разметки, коротко', () => {
  assert.equal(cleanTitle('  # Отчёт\nпо ПУП  '), 'Отчёт по ПУП');
  assert.ok([...cleanTitle('слово '.repeat(30))].length <= 60);
  assert.equal(titleFromRequest('Сделай отчёт по списаниям за октябрь и отправь его в докс команды аналитики'), 'Сделай отчёт по списаниям за октябрь и');
  assert.equal(titleFromRequest('Привет'), 'Привет');
});

test('topicLink, topicInfoOf и dest: ссылка на тему, сведения о теме, адрес отправки', () => {
  assert.equal(topicLink('my_bot', 42), 'https://t.me/my_bot/42');
  assert.equal(topicLink(null, 42), null);
  assert.deepEqual(topicInfoOf({ forum_topic_created: { name: 'New Topic', is_name_implicit: true } }), { name: 'New Topic', implicit: true });
  assert.deepEqual(topicInfoOf({ reply_to_message: { forum_topic_created: { name: 'Отчёт' } } }), { name: 'Отчёт', implicit: false });
  assert.equal(topicInfoOf({ text: 'x' }), null);
  assert.deepEqual(dest(5), { chat_id: 5 });
  assert.deepEqual(dest({ chat_id: 5, message_thread_id: 7 }), { chat_id: 5, message_thread_id: 7 });
  assert.deepEqual(dest({ chat_id: 5, message_thread_id: null }), { chat_id: 5 });
});

test('projectLabel и topicName: короткое имя проекта в названии темы', () => {
  assert.equal(projectLabel('C:\\work\\team\\sales_reports'), 'sales_reports');
  assert.equal(projectLabel('/home/u/proj/'), 'proj');
  assert.equal(projectLabel('C:\\work\\telegram_gateway (dev)'), 'telegram_gatewa…', 'длинное — с многоточием, 16 символов');
  assert.equal([...projectLabel('C:\\x\\очень_длинное_название_проекта')].length, 16);
  assert.equal(topicName('C:\\work\\sales_reports', 'Отчёт по списаниям'), 'sales_reports · Отчёт по списаниям');
  assert.equal(topicName(null, 'Отчёт'), 'Отчёт');
});

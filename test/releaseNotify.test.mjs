import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, buildPayload, escapeHtml, parseNotes } from '../.github/scripts/notify-release.mjs';

test('release notify: escaping and inline markup', () => {
  assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.deepEqual(parseNotes('- **Главное** — `fix`\r\n\r\nnot a bullet\r\n- второе'), [
    '• <b>Главное</b> — <code>fix</code>',
    '• второе'
  ]);
});

test('release notify: localized rich payload', () => {
  const payload = buildPayload('ua', 'v1.2.3', ['• щось нове'], '@acpgram_ua');
  assert.equal(payload.chat_id, '@acpgram_ua');
  assert.equal(payload.parse_mode, 'HTML');
  assert.equal(payload.disable_web_page_preview, true);
  assert.match(payload.text, /🚀 <b>AcpGram v1\.2\.3<\/b>/);
  assert.match(payload.text, /<b>Що нового<\/b>/);
  assert.deepEqual(payload.reply_markup, {
    inline_keyboard: [[
      { text: '🌐 Сайт', url: 'https://alexey-seleznev.pro/acpgram/' },
      { text: '📖 Документація', url: 'https://alexey-seleznev.pro/acpgram/docs' }
    ]]
  });
});

test('release notify: unknown locale', () => {
  assert.throws(() => buildMessage('de', 'v1', []), /Unknown locale/);
});

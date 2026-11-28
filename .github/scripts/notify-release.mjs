import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_URL = 'https://alexey-seleznev.pro/acpgram/';
const DOCS_URL = 'https://alexey-seleznev.pro/acpgram/docs';
const API_URL = 'https://api.telegram.org/bot';

const LOCALES = {
  en: {
    chatEnv: 'CHANNEL_EN',
    whatsNew: "What's new",
    site: 'Website',
    docs: 'Docs'
  },
  ru: {
    chatEnv: 'CHANNEL_RU',
    whatsNew: 'Что нового',
    site: 'Сайт',
    docs: 'Документация'
  },
  ua: {
    chatEnv: 'CHANNEL_UA',
    whatsNew: 'Що нового',
    site: 'Сайт',
    docs: 'Документація'
  }
};

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

export function parseNotes(raw) {
  return String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && line.length > 2)
    .map((line) => `• ${inline(line.slice(2))}`);
}

export function buildMessage(locale, version, bullets) {
  const text = LOCALES[locale];
  if (!text) throw new Error(`Unknown locale: ${locale}`);
  return [
    `🚀 <b>AcpGram ${escapeHtml(version)}</b>`,
    '',
    `<b>${text.whatsNew}</b>`,
    ...bullets
  ].join('\n');
}

export function buildPayload(locale, version, bullets, chatId) {
  const text = LOCALES[locale];
  if (!text) throw new Error(`Unknown locale: ${locale}`);
  return {
    chat_id: chatId,
    text: buildMessage(locale, version, bullets),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: `🌐 ${text.site}`, url: SITE_URL },
        { text: `📖 ${text.docs}`, url: DOCS_URL }
      ]]
    }
  };
}

async function readNotes(locale) {
  const path = fileURLToPath(new URL(`../release-notes/${locale}.md`, import.meta.url));
  const bullets = parseNotes(await readFile(path, 'utf8'));
  if (!bullets.length) throw new Error(`No bullets in .github/release-notes/${locale}.md`);
  return bullets;
}

async function send(payload, locale, chatId, token, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] ${locale} → ${chatId}`);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  let response;
  try {
    response = await fetch(`${API_URL}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {
    throw new Error(`${locale}: Telegram network error`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new Error(`${locale}: Telegram API error ${response.status}: ${result.description || 'unknown'}`);
  }
  console.log(`${locale}: sent to ${chatId}`);
}

export async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  const version = process.env.RELEASE_VERSION;
  if (!version) throw new Error('RELEASE_VERSION is not set');
  const target = process.env.TARGET_CHAT || 'all';
  const locales = target === 'all' ? Object.keys(LOCALES) : [target];
  if (locales.some((locale) => !LOCALES[locale])) throw new Error(`Unknown target chat: ${target}`);
  const dryRun = process.env.DRY_RUN === 'true';
  for (const locale of locales) {
    const chatId = process.env[LOCALES[locale].chatEnv];
    if (!chatId) throw new Error(`${LOCALES[locale].chatEnv} is not set`);
    const bullets = await readNotes(locale);
    await send(buildPayload(locale, version, bullets, chatId), locale, chatId, token, dryRun);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

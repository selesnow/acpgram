// Язык команд acpgram в терминале (справка, мастер настройки, служба, обновление): определяется по системе пользователя —
// русский, украинский, в любом другом случае английский. Выбора в мастере нет; ACPGRAM_LANG (ru | uk | en) — скрытая
// подмена для Docker, CI и проверки. Тексты бота в Telegram — отдельно (i18n.mjs, язык Telegram пользователя).
import { spawnSync } from 'node:child_process';

export const CLI_LANGS = ['en', 'ru', 'uk'];

/** Код локали («ru_RU.UTF-8», «uk-UA», «ru:en», 0x0419) → ru | uk | en, а для не распознанного — null. Служебные «C» и «POSIX» — null. */
export function langFromLocale(value) {
  let v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  v = v.split(':')[0].trim(); // LANGUAGE=ru:en — первый по приоритету
  if (v === 'c' || v === 'posix') return null;
  const lcid = /^(?:0x)?(0[0-9a-f]{3})$/.exec(v); // идентификатор языка Windows (InstallLanguage = 0419)
  if (lcid) {
    const id = parseInt(lcid[1], 16) & 0x3ff; // основной язык без региона
    return id === 0x19 ? 'ru' : id === 0x22 ? 'uk' : 'en';
  }
  const m = /^([a-z]{2,3})(?:[_@.\-]|$)/.exec(v);
  if (!m) return null;
  return m[1] === 'ru' ? 'ru' : m[1] === 'uk' ? 'uk' : 'en';
}

/** Значение из вывода `reg query … /v Имя`: «    Имя    REG_MULTI_SZ    ru-RU\0en-US» → «ru-RU\0en-US». */
export function parseRegValue(stdout) {
  const m = /REG_\w+\s+(.+?)\s*$/m.exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

const regQuery = (key, name) => {
  const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  return r.status === 0 ? parseRegValue(r.stdout) : null;
};

// где Windows хранит язык интерфейса: выбранный пользователем, язык по умолчанию системы, язык установки
const WIN_UI_KEYS = [
  ['HKCU\\Control Panel\\Desktop', 'PreferredUILanguages'],
  ['HKCU\\Control Panel\\Desktop\\MuiCached', 'MachinePreferredUILanguages'],
  ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\Language', 'InstallLanguage'],
];

/**
 * Язык терминала: ACPGRAM_LANG → (Windows) язык интерфейса системы из реестра, а не региональный формат →
 * (Linux, macOS) LC_ALL, LC_MESSAGES, LANGUAGE, LANG → локаль Intl → английский.
 * reg и intl подставляются в тестах.
 */
export function detectLang({ env = process.env, platform = process.platform, reg = regQuery, intl = () => Intl.DateTimeFormat().resolvedOptions().locale } = {}) {
  const forced = String(env.ACPGRAM_LANG ?? '').trim().toLowerCase();
  if (CLI_LANGS.includes(forced)) return forced;
  if (platform === 'win32') {
    for (const [key, name] of WIN_UI_KEYS) {
      let v = null;
      try {
        v = reg(key, name);
      } catch {}
      const lang = v && langFromLocale(v.split(/\\0|\s/)[0]);
      if (lang) return lang;
    }
  } else {
    for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANGUAGE', 'LANG']) {
      const lang = langFromLocale(env[name]);
      if (lang) return lang;
    }
  }
  try {
    return langFromLocale(intl()) ?? 'en';
  } catch {
    return 'en';
  }
}

let current = null;
/** Язык терминала (определяется один раз при первом обращении). */
export const getCliLang = () => (current ??= detectLang());
/** Задать язык явно (тесты). */
export const setCliLang = (lang) => {
  current = CLI_LANGS.includes(lang) ? lang : null;
};

/**
 * Тексты терминальных команд по ключам, на каждом языке. Подстановки — {имя}. Тест test/cli-i18n.test.mjs проверяет,
 * что у каждого ключа есть все переводы и одинаковые подстановки.
 */
export const CLI_MESSAGES = {
  // ---------- acpgram (cli.mjs) ----------
  'cli.help': {
    en: `AcpGram — Telegram gateway to AI coding agents (Gemini CLI, Claude Code, Antigravity CLI, Codex)

  acpgram [start]          start the bot (the first run without settings opens the wizard)
  acpgram setup            setup wizard
  acpgram service install  register the service (autostart, restart on failure)
  acpgram service restart  restart the service (after an update; a hung one is force-stopped)
  acpgram service stop     stop the service (it starts again after a reboot)
  acpgram service status | uninstall
  acpgram update           update to the latest version
  acpgram version          version

Service options: --name <name>, --dry-run, --system (Windows: run as LocalSystem, no terminal).
https://github.com/{repo}`,
    ru: `AcpGram — Telegram-шлюз к AI-агентам разработки (Gemini CLI, Claude Code, Antigravity CLI, Codex)

  acpgram [start]          запустить бота (первый запуск без настроек откроет мастер)
  acpgram setup            мастер настройки
  acpgram service install  зарегистрировать службу (автозапуск, перезапуск при сбое)
  acpgram service restart  перезапустить службу (после обновления; зависшую — добивает)
  acpgram service stop     остановить службу (после перезагрузки запустится снова)
  acpgram service status | uninstall
  acpgram update           обновить до последней версии
  acpgram version          версия

Параметры службы: --name <имя>, --dry-run, --system (Windows: от LocalSystem без терминала).
https://github.com/{repo}`,
    uk: `AcpGram — Telegram-шлюз до AI-агентів розробки (Gemini CLI, Claude Code, Antigravity CLI, Codex)

  acpgram [start]          запустити бота (перший запуск без налаштувань відкриє майстер)
  acpgram setup            майстер налаштування
  acpgram service install  зареєструвати службу (автозапуск, перезапуск при збої)
  acpgram service restart  перезапустити службу (після оновлення; завислу — добиває)
  acpgram service stop     зупинити службу (після перезавантаження запуститься знову)
  acpgram service status | uninstall
  acpgram update           оновити до останньої версії
  acpgram version          версія

Параметри служби: --name <ім’я>, --dry-run, --system (Windows: від LocalSystem без терміналу).
https://github.com/{repo}`,
  },
  'cli.unknown': { en: 'Unknown command: {cmd}\n\n{help}', ru: 'Неизвестная команда: {cmd}\n\n{help}', uk: 'Невідома команда: {cmd}\n\n{help}' },
  'cli.npmUpdate': {
    en: 'AcpGram is installed via npm.\nTo update to the latest version run:\n  npm install -g acpgram@latest',
    ru: 'AcpGram установлен через npm.\nДля обновления до последней версии выполните:\n  npm install -g acpgram@latest',
    uk: 'AcpGram встановлено через npm.\nЩоб оновити до останньої версії, виконайте:\n  npm install -g acpgram@latest',
  },
  'cli.updating': { en: 'Updating AcpGram (currently {before}) to the latest version…', ru: 'Обновляю AcpGram (сейчас {before}) до последней версии…', uk: 'Оновлюю AcpGram (зараз {before}) до останньої версії…' },
  'cli.psBlocked': { en: 'Could not start PowerShell from Node ({code}) — trying via cmd.exe…', ru: 'Не удалось запустить PowerShell из Node ({code}) — пробую через cmd.exe…', uk: 'Не вдалося запустити PowerShell з Node ({code}) — пробую через cmd.exe…' },
  'cli.spawnFail': { en: 'Could not start {cmd}: {msg}', ru: 'Не удалось запустить {cmd}: {msg}', uk: 'Не вдалося запустити {cmd}: {msg}' },
  'cli.blocked': {
    en: 'The launch seems to be blocked by Windows protection or an antivirus.',
    ru: 'Запуск, похоже, блокирует защита Windows или антивирус.',
    uk: 'Запуск, схоже, блокує захист Windows або антивірус.',
  },
  'cli.updateManual': { en: 'Update manually:\n  {cmd}', ru: 'Обновите вручную:\n  {cmd}', uk: 'Оновіть вручну:\n  {cmd}' },
  'cli.updated': { en: '\nAcpGram: {before} → {after}{same}', ru: '\nAcpGram: {before} → {after}{same}', uk: '\nAcpGram: {before} → {after}{same}' },
  'cli.alreadyLatest': { en: ' (already the latest version)', ru: ' (уже последняя версия)', uk: ' (вже остання версія)' },
  'cli.updateFailed': { en: '\nThe update did not finish (code {code}), version {after}', ru: '\nОбновление не завершилось (код {code}), версия {after}', uk: '\nОновлення не завершилося (код {code}), версія {after}' },

  // ---------- запуск (main.mjs) ----------
  'main.setupFailed': { en: '\nSetup did not finish: {msg}', ru: '\nНастройка не завершена: {msg}', uk: '\nНалаштування не завершено: {msg}' },
  'main.starting': { en: '\nStarting the bot…\n', ru: '\nЗапускаю бота…\n', uk: '\nЗапускаю бота…\n' },
  'main.notConfigured': {
    en: 'The bot is not configured: there is no {path} with TELEGRAM_BOT_TOKEN and ALLOWED_USER_ID. Run in a terminal: acpgram setup',
    ru: 'Бот не настроен: нет {path} с TELEGRAM_BOT_TOKEN и ALLOWED_USER_ID. Запустите в терминале: acpgram setup',
    uk: 'Бот не налаштований: немає {path} з TELEGRAM_BOT_TOKEN і ALLOWED_USER_ID. Запустіть у терміналі: acpgram setup',
  },

  // ---------- диалог (prompt.mjs) ----------
  'prompt.inputClosed': { en: 'no input: run the setup in a terminal — acpgram setup', ru: 'нет ввода: запустите настройку в терминале — acpgram setup', uk: 'немає вводу: запустіть налаштування в терміналі — acpgram setup' },

  // ---------- .env (setup.mjs) ----------
  'env.noNewline': { en: 'a value in .env cannot contain a line break', ru: 'значение в .env не может содержать перенос строки', uk: 'значення в .env не може містити розрив рядка' },
  'env.cannotQuote': {
    en: 'the value cannot be written to .env: it has “#” or edge spaces together with both an apostrophe and a backtick',
    ru: 'значение нельзя записать в .env: в нём одновременно «#»/пробел по краям, апостроф и обратная кавычка',
    uk: 'значення не можна записати в .env: у ньому одночасно «#»/пробіл по краях, апостроф і зворотна лапка',
  },
  'env.header': {
    en: '# Created by the {label} setup wizard (npm run setup), {date}. All variables are in .env.example',
    ru: '# Создано мастером настройки {label} (npm run setup), {date}. Все переменные — в .env.example',
    uk: '# Створено майстром налаштування {label} (npm run setup), {date}. Усі змінні — в .env.example',
  },
  'env.c.token': { en: 'Bot token from @BotFather (a secret: do not publish or commit the file)', ru: 'Токен бота от @BotFather (секрет: файл не публикуйте и не коммитьте)', uk: 'Токен бота від @BotFather (секрет: файл не публікуйте і не комітьте)' },
  'env.c.admin': { en: 'Telegram ID of the main administrator', ru: 'Telegram ID главного администратора', uk: 'Telegram ID головного адміністратора' },
  'env.c.root': {
    en: 'Projects root (optional): without it any folder can be a project, the home folder by default',
    ru: 'Корень проектов (необязательно): без него проектом может быть любая папка, по умолчанию домашняя',
    uk: 'Корінь проєктів (необов’язково): без нього проєктом може бути будь-яка тека, за замовчуванням домашня',
  },
  'env.c.engine': { en: 'Default engine: gemini | claude | agy | codex', ru: 'Движок по умолчанию: gemini | claude | agy | codex', uk: 'Рушій за замовчуванням: gemini | claude | agy | codex' },
  'env.c.keys': { en: 'API keys are passed to the agents through the bot environment', ru: 'Ключи API передаются агентам через окружение бота', uk: 'Ключі API передаються агентам через оточення бота' },
  'env.rest': { en: 'Other settings', ru: 'Прочие настройки', uk: 'Інші налаштування' },

  // ---------- мастер настройки (setup.mjs) ----------
  'setup.title': { en: '\n{label} — setup{hint}', ru: '\n{label} — настройка{hint}', uk: '\n{label} — налаштування{hint}' },
  'setup.titleHint': { en: ' (current values are in brackets, Enter keeps them)', ru: ' (текущие значения — в скобках, Enter оставляет их)', uk: ' (поточні значення — у дужках, Enter залишає їх)' },
  'setup.fromStart': { en: 'The bot is not configured yet — answer a few questions.', ru: 'Бот ещё не настроен — ответьте на несколько вопросов.', uk: 'Бот ще не налаштований — дайте відповідь на кілька запитань.' },
  'setup.legacyFound': { en: '\nA previous AcpGram installation was found: {dir}', ru: '\nНайдена прежняя установка AcpGram: {dir}', uk: '\nЗнайдено попередню інсталяцію AcpGram: {dir}' },
  'setup.legacyNote': {
    en: '  Its settings and bot database are not visible to this installation (the data is stored in a different folder).',
    ru: '  Её настройки и база бота не видны этой установке (данные хранятся в другом каталоге).',
    uk: '  Її налаштування і база бота не видимі цій інсталяції (дані зберігаються в іншому каталозі).',
  },
  'setup.legacyAsk': {
    en: '  Move the settings and the database (the old files are not deleted)? If a service is running there, stop it first: acpgram service stop',
    ru: '  Перенести настройки и базу (прежние файлы не удаляются)? Если там запущена служба, сначала остановите её: acpgram service stop',
    uk: '  Перенести налаштування і базу (попередні файли не видаляються)? Якщо там запущена служба, спершу зупиніть її: acpgram service stop',
  },
  'setup.legacyRead': { en: 'settings read from {path}', ru: 'настройки прочитаны из {path}', uk: 'налаштування прочитано з {path}' },
  'setup.legacyDb': { en: 'bot database copied to {dir}', ru: 'база бота скопирована в {dir}', uk: 'базу бота скопійовано в {dir}' },
  'setup.legacyDbFail': { en: 'could not copy the database: {msg}', ru: 'базу скопировать не удалось: {msg}', uk: 'базу скопіювати не вдалося: {msg}' },
  'setup.s1': { en: 'Bot token: create a bot at @BotFather (/newbot) and paste the token', ru: 'Токен бота: создайте бота у @BotFather (/newbot) и вставьте токен', uk: 'Токен бота: створіть бота в @BotFather (/newbot) і вставте токен' },
  'setup.tokenKeep': { en: 'Token (Enter — keep the current one)', ru: 'Токен (Enter — оставить текущий)', uk: 'Токен (Enter — залишити поточний)' },
  'setup.token': { en: 'Token', ru: 'Токен', uk: 'Токен' },
  'setup.botOk': { en: 'bot @{username} ({name})', ru: 'бот @{username} ({name})', uk: 'бот @{username} ({name})' },
  'setup.tokenBad': { en: 'the token did not work: {msg}', ru: 'токен не подошёл: {msg}', uk: 'токен не підійшов: {msg}' },
  'setup.s2': { en: 'Main administrator', ru: 'Главный администратор', uk: 'Головний адміністратор' },
  'setup.adminKeep': { en: 'Keep the administrator with ID {id}?', ru: 'Оставить администратора с ID {id}?', uk: 'Залишити адміністратора з ID {id}?' },
  'setup.adminOk': { en: 'administrator {id}', ru: 'администратор {id}', uk: 'адміністратор {id}' },
  'setup.adminWait': {
    en: '  Send the bot @{username} any message on Telegram (for example /start) from your account — waiting up to 3 minutes…',
    ru: '  Напишите боту @{username} в Telegram любое сообщение (например /start) с вашего аккаунта — жду до 3 минут…',
    uk: '  Напишіть боту @{username} у Telegram будь-яке повідомлення (наприклад /start) зі свого акаунта — чекаю до 3 хвилин…',
  },
  'setup.adminIsYou': { en: '  Is this you: {who} (ID {id})?', ru: '  Это вы: {who} (ID {id})?', uk: '  Це ви: {who} (ID {id})?' },
  'setup.adminFetchFail': { en: 'could not get the bot messages: {msg}{hint}', ru: 'не удалось получить сообщения бота: {msg}{hint}', uk: 'не вдалося отримати повідомлення бота: {msg}{hint}' },
  'setup.conflictHint': {
    en: ' — this token is already polled by another running bot (for example, the previous service: acpgram service stop); stop it or enter the ID manually',
    ru: ' — этот токен уже опрашивает другой запущенный бот (например, прежняя служба: acpgram service stop); остановите его или введите ID вручную',
    uk: ' — цей токен вже опитує інший запущений бот (наприклад, попередня служба: acpgram service stop); зупиніть його або введіть ID вручну',
  },
  'setup.adminAskId': {
    en: '  Enter your numeric Telegram ID (@userinfobot will show it)',
    ru: '  Введите ваш числовой Telegram ID (его покажет @userinfobot)',
    uk: '  Введіть ваш числовий Telegram ID (його покаже @userinfobot)',
  },
  'setup.s3': { en: 'Projects root (optional)', ru: 'Корень проектов (необязательно)', uk: 'Корінь проєктів (необов’язково)' },
  'setup.rootNote1': {
    en: '  Set it for a shared server where the bot works for several people: only a folder inside the root can be chosen as a project.',
    ru: '  Задайте для общего сервера, где бот работает у нескольких сотрудников: проектом можно будет выбрать только папку внутри корня.',
    uk: '  Задайте для спільного сервера, де бот працює в кількох співробітників: проєктом можна буде вибрати лише теку всередині кореня.',
  },
  'setup.rootNote2': {
    en: '  For a personal installation leave it empty — any folder can be a project, the home folder by default.',
    ru: '  Для личной установки оставьте пустым — проектом сможет быть любая папка, по умолчанию домашняя.',
    uk: '  Для особистої інсталяції залиште порожнім — проєктом зможе бути будь-яка тека, за замовчуванням домашня.',
  },
  'setup.rootAsk': { en: '  Folder (Enter — no root; “-” — remove)', ru: '  Папка (Enter — без корня; «-» — убрать)', uk: '  Тека (Enter — без кореня; «-» — прибрати)' },
  'setup.rootNone': { en: 'no root: any folder, the home folder by default', ru: 'без корня: любая папка, по умолчанию домашняя', uk: 'без кореня: будь-яка тека, за замовчуванням домашня' },
  'setup.rootOk': { en: 'root {root}', ru: 'корень {root}', uk: 'корінь {root}' },
  'setup.s4': { en: 'AI engines (checking what is installed)', ru: 'AI-движки (проверяю установленные)', uk: 'AI-рушії (перевіряю встановлені)' },
  'setup.engineOk': { en: '{label} {version} — {path}', ru: '{label} {version} — {path}', uk: '{label} {version} — {path}' },
  'setup.engineOld': {
    en: '{label}: {error}. Until you update it, the bot will not offer this engine',
    ru: '{label}: {error}. Пока не обновите, бот этот движок не предложит',
    uk: '{label}: {error}. Доки не оновите, бот цей рушій не запропонує',
  },
  'setup.engineMissing': { en: '  ❌ {label} not found. Install: {install}', ru: '  ❌ {label} не найден. Установка: {install}', uk: '  ❌ {label} не знайдено. Встановлення: {install}' },
  'setup.noEngine': {
    en: 'no engine found — install at least one and run npm run setup again',
    ru: 'ни один движок не найден — установите хотя бы один и запустите npm run setup ещё раз',
    uk: 'жодного рушія не знайдено — встановіть хоча б один і запустіть npm run setup ще раз',
  },
  'setup.engineAsk': { en: '  Default engine ({list})', ru: '  Движок по умолчанию ({list})', uk: '  Рушій за замовчуванням ({list})' },
  'setup.engineDefault': { en: 'default engine: {label}', ru: 'движок по умолчанию: {label}', uk: 'рушій за замовчуванням: {label}' },
  'setup.s5': {
    en: 'API keys (optional: Enter — skip or keep the current one)',
    ru: 'Ключи API (необязательно: Enter — пропустить или оставить текущий)',
    uk: 'Ключі API (необов’язково: Enter — пропустити або залишити поточний)',
  },
  'setup.keySet': { en: ' (set)', ru: ' (задан)', uk: ' (задано)' },
  'setup.keyEnv': { en: ' (found in the environment)', ru: ' (есть в окружении)', uk: ' (є в оточенні)' },
  'setup.keySave': {
    en: '    Save {name} from the environment to .env (the service does not see the user’s environment variables)?',
    ru: '    Сохранить {name} из окружения в .env (служба не видит переменные окружения пользователя)?',
    uk: '    Зберегти {name} з оточення в .env (служба не бачить змінні оточення користувача)?',
  },
  'setup.keyClaude': { en: ' — Claude Code via API, without it via subscription', ru: ' — Claude Code по API, без него по подписке', uk: ' — Claude Code через API, без нього за підпискою' },
  'setup.keyCodex': { en: ' — Codex via API, without it via ChatGPT sign-in (codex login)', ru: ' — Codex по API, без него по входу ChatGPT (codex login)', uk: ' — Codex через API, без нього за входом ChatGPT (codex login)' },
  'setup.agyNote': {
    en: '  Antigravity CLI: there is no API key — sign in once: agy acp --login',
    ru: '  Antigravity CLI: ключа API нет — войдите один раз: agy acp --login',
    uk: '  Antigravity CLI: ключа API немає — увійдіть один раз: agy acp --login',
  },
  'setup.s6': { en: 'Saving settings', ru: 'Сохраняю настройки', uk: 'Зберігаю налаштування' },
  'setup.saveFail': { en: 'settings were not saved: {msg}', ru: 'настройки не сохранены: {msg}', uk: 'налаштування не збережено: {msg}' },
  'setup.envOk': { en: '{path}{prev}', ru: '{path}{prev}', uk: '{path}{prev}' },
  'setup.envPrev': { en: ' (previous — {backup})', ru: ' (прежний — {backup})', uk: ' (попередній — {backup})' },
  'setup.dbOk': { en: 'database data/bot.db', ru: 'база data/bot.db', uk: 'база data/bot.db' },
  'setup.testText': {
    en: '✅ {label} is set up. You are the main administrator. After the bot starts, press /start.',
    ru: '✅ {label} настроен. Вы — главный администратор. После запуска бота нажмите /start.',
    uk: '✅ {label} налаштовано. Ви — головний адміністратор. Після запуску бота натисніть /start.',
  },
  'setup.testOk': { en: 'test message sent to you on Telegram', ru: 'тестовое сообщение отправлено вам в Telegram', uk: 'тестове повідомлення надіслано вам у Telegram' },
  'setup.testFail': {
    en: 'the test message was not sent: {msg} (message the bot /start and check the ID)',
    ru: 'тестовое сообщение не отправлено: {msg} (напишите боту /start и проверьте ID)',
    uk: 'тестове повідомлення не надіслано: {msg} (напишіть боту /start і перевірте ID)',
  },
  'setup.s7': { en: 'Launch', ru: 'Запуск', uk: 'Запуск' },
  'setup.serviceAsk': {
    en: '  Register the bot as a service (autostart with the system, restart on failure)?',
    ru: '  Зарегистрировать бота как службу (автозапуск с системой, перезапуск при сбое)?',
    uk: '  Зареєструвати бота як службу (автозапуск із системою, перезапуск при збої)?',
  },
  'setup.serviceStartFail': {
    en: 'the service is registered but did not start (see above) — you can start the bot manually: acpgram',
    ru: 'служба зарегистрирована, но не запустилась (см. выше) — бот можно запустить вручную: acpgram',
    uk: 'службу зареєстровано, але вона не запустилась (див. вище) — бота можна запустити вручну: acpgram',
  },
  'setup.serviceFail': {
    en: 'the service is not registered — you can start the bot manually: acpgram',
    ru: 'служба не зарегистрирована — бот можно запустить вручную: acpgram',
    uk: 'службу не зареєстровано — бота можна запустити вручну: acpgram',
  },
  'setup.manual': {
    en: '  Manual start: acpgram   ·   service later: acpgram service install',
    ru: '  Запуск вручную: acpgram   ·   служба позже: acpgram service install',
    uk: '  Запуск вручну: acpgram   ·   служба пізніше: acpgram service install',
  },

  // ---------- служба (service.mjs, winsvc.mjs) ----------
  'svc.noResponse': { en: 'no response', ru: 'нет ответа', uk: 'немає відповіді' },
  'svc.unknownHint': {
    en: '  ❌ Could not find out whether the service exists (sc.exe: {err}). Run the terminal as administrator; if Windows protection blocks sc.exe, check the service in Services (services.msc).',
    ru: '  ❌ Не удалось узнать, есть ли служба (sc.exe: {err}). Запустите терминал «от имени администратора»; если защита Windows блокирует sc.exe — проверьте службу в «Службах» (services.msc).',
    uk: '  ❌ Не вдалося дізнатися, чи є служба (sc.exe: {err}). Запустіть термінал «від імені адміністратора»; якщо захист Windows блокує sc.exe — перевірте службу в «Службах» (services.msc).',
  },
  'svc.garbled': {
    en: '(the Windows error text cannot be shown in this console encoding)',
    ru: '(текст ошибки Windows не отображается в этой кодировке консоли)',
    uk: '(текст помилки Windows не відображається в цьому кодуванні консолі)',
  },
  'svc.stopping': { en: '  Stopping the service {name}…', ru: '  Останавливаю службу {name}…', uk: '  Зупиняю службу {name}…' },
  'svc.nssmTimeout': {
    en: '  nssm did not return in 20 s ({secs} s since the start) — continuing on my own',
    ru: '  nssm не вернул управление за 20 с ({secs} с с начала) — продолжаю сам',
    uk: '  nssm не повернув керування за 20 с ({secs} с від початку) — продовжую сам',
  },
  'svc.stopped': { en: '  The service was stopped in {secs} s.', ru: '  Служба остановлена за {secs} с.', uk: '  Службу зупинено за {secs} с.' },
  'svc.waiting': { en: '  …waiting for it to stop ({secs} s, state: {state})', ru: '  …жду остановки ({secs} с, состояние: {state})', uk: '  …чекаю зупинки ({secs} с, стан: {state})' },
  'svc.unknown': { en: 'unknown', ru: 'неизвестно', uk: 'невідомо' },
  'svc.killing': {
    en: '  The service {name} does not stop — terminating its process (PID {pid}) together with its child processes',
    ru: '  Служба {name} не останавливается — завершаю её процесс (PID {pid}) вместе с дочерними',
    uk: '  Служба {name} не зупиняється — завершую її процес (PID {pid}) разом із дочірніми',
  },
  'svc.marked': {
    en: '  ❌ Windows has not removed the previous service {name} yet (error 1072 “the service is marked for deletion”).\n     Close Services (services.msc) and the Services tab of Task Manager and repeat: acpgram service install\n     If that does not help, restart the computer: Windows will finish the removal after the restart.',
    ru: '  ❌ Windows ещё не удалил прежнюю службу {name} (ошибка 1072 «служба помечена для удаления»).\n     Закройте «Службы» (services.msc) и вкладку «Службы» Диспетчера задач и повторите: acpgram service install\n     Если не поможет — перезагрузите компьютер: после перезагрузки Windows удалит её окончательно.',
    uk: '  ❌ Windows ще не видалив попередню службу {name} (помилка 1072 «службу позначено для видалення»).\n     Закрийте «Служби» (services.msc) і вкладку «Служби» Диспетчера завдань та повторіть: acpgram service install\n     Якщо не допоможе — перезавантажте комп’ютер: після перезавантаження Windows остаточно її видалить.',
  },
  'svc.log': { en: 'Log: {path}', ru: 'Лог: {path}', uk: 'Лог: {path}' },
  'svc.logPs': { en: ' (in PowerShell: Get-Content "{path}" -Tail 30 -Encoding UTF8)', ru: ' (в PowerShell: Get-Content "{path}" -Tail 30 -Encoding UTF8)', uk: ' (у PowerShell: Get-Content "{path}" -Tail 30 -Encoding UTF8)' },
  'svc.noNssm': { en: '  ❌ nssm not found.', ru: '  ❌ Не найден nssm.', uk: '  ❌ nssm не знайдено.' },
  'svc.needAdmin': {
    en: '  ❌ Administrator rights are required: run the terminal as administrator.',
    ru: '  ❌ Нужны права администратора: запустите терминал «от имени администратора».',
    uk: '  ❌ Потрібні права адміністратора: запустіть термінал «від імені адміністратора».',
  },
  'svc.notInstalled': { en: '  ❌ The service {name} is not installed: acpgram service install', ru: '  ❌ Служба {name} не установлена: acpgram service install', uk: '  ❌ Службу {name} не встановлено: acpgram service install' },
  'svc.notStopped': {
    en: '  ⚠️ The service {name} did not stop (the process or the service itself hung). If it does not start, restart the computer.',
    ru: '  ⚠️ Служба {name} не остановилась (завис процесс или сама служба). Если запуск не получится — перезагрузите компьютер.',
    uk: '  ⚠️ Служба {name} не зупинилась (завис процес або сама служба). Якщо запуск не вдасться — перезавантажте комп’ютер.',
  },
  'svc.restarted': { en: '  ✅ The service {name} was restarted. {log}', ru: '  ✅ Служба {name} перезапущена. {log}', uk: '  ✅ Службу {name} перезапущено. {log}' },
  'svc.logonRefused': {
    en: '  ❌ Windows did not let the service run under its account (wrong password; with a Microsoft account its password is required, not the PIN). Reinstall the service: acpgram service install',
    ru: '  ❌ Windows не пустил службу под её учётной записью (неверный пароль; при входе через учётную запись Microsoft нужен её пароль, а не PIN). Переустановите службу: acpgram service install',
    uk: '  ❌ Windows не пустив службу під її обліковим записом (невірний пароль; при вході через обліковий запис Microsoft потрібен його пароль, а не PIN). Перевстановіть службу: acpgram service install',
  },
  'svc.winCode': { en: ', Windows code {code}', ru: ', код Windows {code}', uk: ', код Windows {code}' },
  'svc.notStarted': { en: '  ❌ The service {name} did not start ({state}{code}). {log}', ru: '  ❌ Служба {name} не запустилась ({state}{code}). {log}', uk: '  ❌ Служба {name} не запустилась ({state}{code}). {log}' },
  'svc.noNssmFull': {
    en: '  ❌ nssm (the Windows service manager) not found. Install it: winget install --id NSSM.NSSM -e  (or choco install nssm, or https://nssm.cc) and repeat.',
    ru: '  ❌ Не найден nssm (менеджер служб Windows). Установите: winget install --id NSSM.NSSM -e  (или choco install nssm, или https://nssm.cc) и повторите.',
    uk: '  ❌ nssm (менеджер служб Windows) не знайдено. Встановіть: winget install --id NSSM.NSSM -e  (або choco install nssm, або https://nssm.cc) і повторіть.',
  },
  'svc.needAdminInstall': {
    en: '  ❌ Administrator rights are required: run the terminal as administrator and run acpgram service install.',
    ru: '  ❌ Нужны права администратора: запустите терминал «от имени администратора» и выполните acpgram service install.',
    uk: '  ❌ Потрібні права адміністратора: запустіть термінал «від імені адміністратора» і виконайте acpgram service install.',
  },
  'svc.markedKilling': {
    en: '  The service {name} is marked for deletion (Windows error 1072) — terminating its process so that Windows can finish the removal…',
    ru: '  Служба {name} помечена для удаления (ошибка Windows 1072) — завершаю её процесс, чтобы Windows закончил удаление…',
    uk: '  Службу {name} позначено для видалення (помилка Windows 1072) — завершую її процес, щоб Windows закінчив видалення…',
  },
  'svc.askRestart': {
    en: '  The service {name} is already installed. Restart it with the new settings?',
    ru: '  Служба {name} уже установлена. Перезапустить её с новыми настройками?',
    uk: '  Служба {name} вже встановлена. Перезапустити її з новими налаштуваннями?',
  },
  'svc.askReinstall': {
    en: '  Reinstall the service {name} from scratch (for example, to change the account)?',
    ru: '  Переустановить службу {name} заново (например, чтобы сменить учётную запись)?',
    uk: '  Перевстановити службу {name} заново (наприклад, щоб змінити обліковий запис)?',
  },
  'svc.leaveAsIs': {
    en: '  Leaving it as is. Restart: acpgram service restart; remove: acpgram service uninstall',
    ru: '  Оставляю как есть. Перезапуск: acpgram service restart; удалить: acpgram service uninstall',
    uk: '  Залишаю як є. Перезапуск: acpgram service restart; видалити: acpgram service uninstall',
  },
  'svc.askAccount': {
    en: '  Run the service under your account {user} (recommended: the agents are signed in there)?',
    ru: '  Запускать службу от вашей учётной записи {user} (рекомендуется: там авторизованы агенты)?',
    uk: '  Запускати службу від вашого облікового запису {user} (рекомендовано: там авторизовані агенти)?',
  },
  'svc.passwordNote': {
    en: '  The Windows account password is required. If you sign in with a Microsoft account, use its password (the one for your Microsoft email), not the PIN.',
    ru: '  Нужен пароль учётной записи Windows. Если вы входите через учётную запись Microsoft — пароль от неё (от почты Microsoft), а не PIN-код.',
    uk: '  Потрібен пароль облікового запису Windows. Якщо ви входите через обліковий запис Microsoft — пароль від нього (від пошти Microsoft), а не PIN-код.',
  },
  'svc.passwordAsk': { en: '  Windows password for {user} (input is hidden)', ru: '  Пароль Windows для {user} (ввод скрыт)', uk: '  Пароль Windows для {user} (введення приховано)' },
  'svc.noPassword': { en: '  ❌ No password entered — the service is not installed.', ru: '  ❌ Пароль не введён — служба не установлена.', uk: '  ❌ Пароль не введено — службу не встановлено.' },
  'svc.needTty': {
    en: '  ❌ Run it in a terminal (it will ask for the account) or add --system so that the service runs as LocalSystem.',
    ru: '  ❌ Запустите в терминале (спросит учётную запись) или добавьте --system, чтобы служба работала от LocalSystem.',
    uk: '  ❌ Запустіть у терміналі (запитає обліковий запис) або додайте --system, щоб служба працювала від LocalSystem.',
  },
  'svc.localSystem': {
    en: '  ⚠️ The service will run as LocalSystem: the agents must be signed in for this account (API keys in .env).',
    ru: '  ⚠️ Служба будет работать от LocalSystem: агенты должны быть авторизованы для этой учётной записи (ключи API в .env).',
    uk: '  ⚠️ Служба працюватиме від LocalSystem: агенти мають бути авторизовані для цього облікового запису (ключі API в .env).',
  },
  'svc.createFailed': { en: '  ❌ Could not create the service: {text}.', ru: '  ❌ Не удалось создать службу: {text}.', uk: '  ❌ Не вдалося створити службу: {text}.' },
  'svc.checkPassword': {
    en: '  The service is not installed: check the password (for a domain account — DOMAIN\\user).',
    ru: '  Служба не установлена: проверьте пароль (для доменной учётной записи — DOMAIN\\user).',
    uk: '  Службу не встановлено: перевірте пароль (для доменного облікового запису — DOMAIN\\user).',
  },
  'svc.dryRun': { en: '  (dry run: the commands are shown but not executed)', ru: '  (пробный прогон: команды показаны, но не выполнены)', uk: '  (пробний прогін: команди показано, але не виконано)' },
  'svc.logonDenied': {
    en: '  ❌ Windows did not let the service run under {user}: wrong user name or password.',
    ru: '  ❌ Windows не пустил службу под {user}: неверное имя пользователя или пароль.',
    uk: '  ❌ Windows не пустив службу під {user}: невірне ім’я користувача або пароль.',
  },
  'svc.msHint': {
    en: '     If you sign in with a Microsoft account: use its password (the one for your Microsoft email), not the Windows sign-in PIN.',
    ru: '     Если вы входите через учётную запись Microsoft: нужен пароль от неё (от почты Microsoft), а не PIN-код для входа в Windows.',
    uk: '     Якщо ви входите через обліковий запис Microsoft: потрібен пароль від нього (від пошти Microsoft), а не PIN-код для входу в Windows.',
  },
  'svc.localHint': {
    en: '     If the account is local: its password is required; the service cannot run under an account without a password — set one.',
    ru: '     Если учётная запись локальная: нужен её пароль; без пароля служба под ней работать не может — задайте пароль.',
    uk: '     Якщо обліковий запис локальний: потрібен його пароль; без пароля служба під ним працювати не може — задайте пароль.',
  },
  'svc.passwordAgain': { en: '  Password for {user} (Enter — do not retry)', ru: '  Пароль для {user} (Enter — не повторять)', uk: '  Пароль для {user} (Enter — не повторювати)' },
  'svc.installedNotRunning': {
    en: '  ❌ The service {name} is installed but not running ({state}{code}).',
    ru: '  ❌ Служба {name} установлена, но не запущена ({state}{code}).',
    uk: '  ❌ Службу {name} встановлено, але не запущено ({state}{code}).',
  },
  'svc.fixPassword': {
    en: '     Set the correct password and start it (terminal as administrator):\n       nssm set {name} ObjectName {user} "<password>"\n       acpgram service restart',
    ru: '     Задайте верный пароль и запустите (терминал от имени администратора):\n       nssm set {name} ObjectName {user} "<пароль>"\n       acpgram service restart',
    uk: '     Задайте правильний пароль і запустіть (термінал від імені адміністратора):\n       nssm set {name} ObjectName {user} "<пароль>"\n       acpgram service restart',
  },
  'svc.details': { en: '     Details — {log}', ru: '     Подробности — {log}', uk: '     Подробиці — {log}' },
  'svc.running': {
    en: '  ✅ The service {name} is running. {log}\n     Restart: acpgram service restart · status: acpgram service status',
    ru: '  ✅ Служба {name} работает. {log}\n     Перезапуск: acpgram service restart · состояние: acpgram service status',
    uk: '  ✅ Служба {name} працює. {log}\n     Перезапуск: acpgram service restart · стан: acpgram service status',
  },
  'svc.linuxRunning': {
    en: '  ✅ The service {name} is running. Log: journalctl --user -u {name} -f',
    ru: '  ✅ Служба {name} запущена. Лог: journalctl --user -u {name} -f',
    uk: '  ✅ Службу {name} запущено. Лог: journalctl --user -u {name} -f',
  },
  'svc.linger': {
    en: '  To keep the bot running without a login session: sudo loginctl enable-linger {user}',
    ru: '  Чтобы бот работал без входа в систему: sudo loginctl enable-linger {user}',
    uk: '  Щоб бот працював без входу в систему: sudo loginctl enable-linger {user}',
  },
  'svc.macRunning': { en: '  ✅ LaunchAgent {label} is running. Log: {path}', ru: '  ✅ LaunchAgent {label} запущен. Лог: {path}', uk: '  ✅ LaunchAgent {label} запущено. Лог: {path}' },
  'svc.unsupportedOs': {
    en: '  ❌ The OS {platform} is not supported: run the bot manually (npm start).',
    ru: '  ❌ ОС {platform} не поддерживается: запускайте бота вручную (npm start).',
    uk: '  ❌ ОС {platform} не підтримується: запускайте бота вручну (npm start).',
  },
  'svc.stopDone': {
    en: '  ✅ The service {name} was stopped. It starts again after a reboot; to start it now: acpgram service restart',
    ru: '  ✅ Служба {name} остановлена. После перезагрузки она запустится снова; запустить сейчас: acpgram service restart',
    uk: '  ✅ Службу {name} зупинено. Після перезавантаження вона запуститься знову; запустити зараз: acpgram service restart',
  },
  'svc.alreadyStopped': { en: '  The service {name} is already stopped.', ru: '  Служба {name} уже остановлена.', uk: '  Службу {name} вже зупинено.' },
  'svc.notInstalledOk': { en: '  The service {name} is not installed.', ru: '  Служба {name} не установлена.', uk: '  Службу {name} не встановлено.' },
  'svc.removed': { en: '  ✅ The service {name} was removed.', ru: '  ✅ Служба {name} удалена.', uk: '  ✅ Службу {name} видалено.' },
  'svc.nssmNotFound': { en: 'nssm not found', ru: 'nssm не найден', uk: 'nssm не знайдено' },
  'svc.unsupported': { en: 'not supported', ru: 'не поддерживается', uk: 'не підтримується' },
  'svc.usage': {
    en: 'Usage: node src/service.mjs install|restart|stop|status|uninstall [--name <name>] [--dry-run] [--system]',
    ru: 'Использование: node src/service.mjs install|restart|stop|status|uninstall [--name <имя>] [--dry-run] [--system]',
    uk: 'Використання: node src/service.mjs install|restart|stop|status|uninstall [--name <ім’я>] [--dry-run] [--system]',
  },
  'ws.marked': { en: 'the service {name} is marked for deletion (Windows error 1072)', ru: 'служба {name} помечена для удаления (ошибка Windows 1072)', uk: 'службу {name} позначено для видалення (помилка Windows 1072)' },
  'ws.exists': {
    en: 'the service {name} already exists (Windows error 1073): run acpgram service uninstall',
    ru: 'служба {name} уже существует (ошибка Windows 1073): выполните acpgram service uninstall',
    uk: 'служба {name} вже існує (помилка Windows 1073): виконайте acpgram service uninstall',
  },
  'ws.keyTaken': {
    en: 'the name {name} or the display name of the service is already taken by another service (Windows error 1078)',
    ru: 'имя {name} или отображаемое имя службы уже занято другой службой (ошибка Windows 1078)',
    uk: 'ім’я {name} або відображуване ім’я служби вже зайняте іншою службою (помилка Windows 1078)',
  },
  'ws.unknown': { en: 'could not determine the cause: sc.exe is unavailable{status}', ru: 'не удалось определить причину: sc.exe недоступен{status}', uk: 'не вдалося визначити причину: sc.exe недоступний{status}' },
  'ws.refused': { en: 'Windows refused to create the service{status}', ru: 'Windows отказал в создании службы{status}', uk: 'Windows відмовив у створенні служби{status}' },
  'ws.nssmCode': { en: ' (nssm returned code {code})', ru: ' (nssm вернул код {code})', uk: ' (nssm повернув код {code})' },
};

/** Подстановка {имя} в шаблоне. */
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

/** Текст для терминала на языке системы (или заданном lang). */
export function tc(key, vars = {}, lang = getCliLang()) {
  const entry = CLI_MESSAGES[key];
  if (!entry) throw new Error(`cli-i18n: нет ключа «${key}»`);
  return fill(entry[lang] ?? entry.en, vars);
}

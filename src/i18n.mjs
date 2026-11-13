// Языки интерфейса бота: английский (по умолчанию), русский и украинский.
// Все тексты, которые видит пользователь в Telegram, — здесь, по ключам: у каждого ключа есть перевод на каждый язык
// (test/i18n.test.mjs это проверяет). Логи и сообщения в консоли остаются на русском — их читает администратор сервера.

export const LANGS = { en: 'English', ru: 'Русский', uk: 'Українська' };
export const LANG_CODES = Object.keys(LANGS);

/** Код языка («ru», «ru-RU», «UK») → допустимый код из LANGS или null. */
export function normLang(v) {
  const code = String(v ?? '').trim().toLowerCase().slice(0, 2);
  return LANG_CODES.includes(code) ? code : null;
}

/** Язык по умолчанию: DEFAULT_LANG из .env, иначе английский. */
export const DEFAULT_LANG = normLang(process.env.DEFAULT_LANG) ?? 'en';

/** Первый поддерживаемый язык из списка кандидатов (код Telegram «ru-RU», выбор пользователя и т. п.), иначе язык по умолчанию. */
export const pickLang = (...candidates) => candidates.map(normLang).find(Boolean) ?? DEFAULT_LANG;

/** Локаль для дат (toLocaleString). */
export const LOCALES = { en: 'en-US', ru: 'ru-RU', uk: 'uk-UA' };

/** Единицы с множественным числом: en — ед./мн., ru и uk — три формы (1 / 2–4 / 5+). */
const UNITS = {
  step: { en: ['step', 'steps'], ru: ['шаг', 'шага', 'шагов'], uk: ['крок', 'кроки', 'кроків'] },
};

/** Славянская форма: 1, 2–4, 5+ (с исключением для 11–14). Одинакова для русского и украинского. */
const slavicForm = (n) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 0;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
  return 2;
};

/** «1 step», «3 steps» / «1 шаг», «2 шага», «5 шагов». */
export function plural(n, unit = 'step', lang = DEFAULT_LANG) {
  const forms = UNITS[unit][lang] ?? UNITS[unit].en;
  const idx = lang === 'en' ? (n === 1 ? 0 : 1) : slavicForm(n);
  return `${n} ${forms[idx]}`;
}

/** Текст по ключу и языку; {имя} подставляется из vars. Нет перевода — английский. */
export function t(key, lang = DEFAULT_LANG, vars = {}) {
  const entry = M[key];
  if (!entry) throw new Error(`i18n: нет ключа «${key}»`);
  const text = entry[lang] ?? entry.en;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Выбор языка до того, как он сохранён: показываем сразу на трёх языках. */
export const LANG_PICK = 'Choose your language:\nВыберите язык:\nОберіть мову:';

const M = {
  // ---------- общее ----------
  'btn.language': { en: '🌐 Language', ru: '🌐 Язык', uk: '🌐 Мова' },
  'btn.cancel': { en: 'Cancel', ru: 'Отмена', uk: 'Скасувати' },
  'btn.back': { en: '← Back', ru: '← Назад', uk: '← Назад' },
  'btn.reject': { en: '⛔ Reject', ru: '⛔ Отклонить', uk: '⛔ Відхилити' },
  'btn.refresh': { en: '🔄 Refresh', ru: '🔄 Обновить', uk: '🔄 Оновити' },
  'auto': { en: 'Auto', ru: 'Авто', uk: 'Авто' },
  'access.denied': { en: 'No access', ru: 'Нет доступа', uk: 'Немає доступу' },
  'busy.stop': { en: 'Stop the current request first: /stop', ru: 'Сначала остановите текущий запрос: /stop', uk: 'Спочатку зупиніть поточний запит: /stop' },
  'busy.running': { en: 'The previous request is still running. /stop — to stop it.', ru: 'Предыдущий запрос ещё выполняется. /stop — остановить.', uk: 'Попередній запит ще виконується. /stop — зупинити.' },
  'admin.only': { en: 'This command is for the administrator only.', ru: 'Команда доступна только администратору.', uk: 'Команда доступна лише адміністратору.' },
  'stop.none': { en: 'Nothing is running right now.', ru: 'Сейчас ничего не выполняется.', uk: 'Зараз нічого не виконується.' },
  'close.none': { en: 'There is no active session — the agent process is not running.', ru: 'Активной сессии нет — процесс агента не запущен.', uk: 'Активної сесії немає — процес агента не запущено.' },
  'close.slot': { en: ' Slot released.', ru: ' Слот освобождён.', uk: ' Слот звільнено.' },
  'close.done': { en: '🛑 Session closed, the process is unloaded from server memory.{slot}\nYou can return to the conversation via /sessions.', ru: '🛑 Сессия закрыта, процесс выгружен из памяти сервера.{slot}\nВернуться к диалогу можно через /sessions.', uk: '🛑 Сесію закрито, процес вивантажено з пам’яті сервера.{slot}\nПовернутися до діалогу можна через /sessions.' },
  'new.done': { en: '🆕 New session. {engine} will start the conversation from a clean slate.\n📁 Project: {project}', ru: '🆕 Новая сессия. {engine} начнёт диалог с чистого листа.\n📁 Проект: {project}', uk: '🆕 Нова сесія. {engine} почне діалог з чистого аркуша.\n📁 Проєкт: {project}' },
  'lang.set': { en: '🌐 Language: {name}. You can change it at any time with /language.', ru: '🌐 Язык: {name}. Сменить можно в любой момент: /language', uk: '🌐 Мову обрано: {name}. Змінити можна будь-коли: /language' },
  'proj.root': { en: '{root} (root)', ru: '{root} (корень)', uk: '{root} (корінь)' },
  'welcome.note': { en: 'ℹ️ Requests to the bot are logged by the administrator.', ru: 'ℹ️ Запросы к боту журналируются администратором.', uk: 'ℹ️ Запити до бота журналює адміністратор.' },

  // ---------- меню команд Telegram ----------
  'menu.project': { en: 'Choose the project (folder) the agent works in', ru: 'Выбрать проект (папку), в которой работает агент', uk: 'Обрати проєкт (папку), у якій працює агент' },
  'menu.engine': { en: 'Choose the engine: Gemini CLI, Claude Code, Antigravity CLI, Codex', ru: 'Выбрать движок: Gemini CLI, Claude Code, Antigravity CLI, Codex', uk: 'Обрати рушій: Gemini CLI, Claude Code, Antigravity CLI, Codex' },
  'menu.model': { en: 'Choose the model and reasoning level', ru: 'Выбрать модель и уровень рассуждений', uk: 'Обрати модель і рівень міркувань' },
  'menu.new': { en: 'Start a new conversation (new agent session)', ru: 'Начать новый диалог (новая сессия агента)', uk: 'Почати новий діалог (нова сесія агента)' },
  'menu.sessions': { en: 'Return to a previous session in this project', ru: 'Вернуться к прошлой сессии в этом проекте', uk: 'Повернутися до попередньої сесії в цьому проєкті' },
  'menu.stop': { en: 'Stop the running request', ru: 'Остановить выполняющийся запрос', uk: 'Зупинити запит, що виконується' },
  'menu.close': { en: 'Close the session and free the slot', ru: 'Закрыть сессию и освободить слот', uk: 'Закрити сесію та звільнити слот' },
  'menu.language': { en: 'Choose the interface language', ru: 'Выбрать язык интерфейса', uk: 'Обрати мову інтерфейсу' },
  'menu.start': { en: 'Welcome and the current project', ru: 'Приветствие и текущий проект', uk: 'Привітання та поточний проєкт' },
  'menu.active': { en: 'Active sessions: who holds the slots', ru: 'Активные сессии: кто занимает слоты', uk: 'Активні сесії: хто займає слоти' },
  'menu.users': { en: 'Users with access: levels and revocation', ru: 'Сотрудники с доступом: уровни и отзыв', uk: 'Співробітники з доступом: рівні та відкликання' },
  'menu.invite': { en: 'Invite a user with a link', ru: 'Пригласить сотрудника по ссылке', uk: 'Запросити співробітника за посиланням' },

  // ---------- экран /start ----------
  'start.title': { en: '### 👋 AI agent in Telegram', ru: '### 👋 AI-агент в Telegram', uk: '### 👋 AI-агент у Telegram' },
  'start.intro': { en: 'Send your request as a normal message — I will pass it to {engine} and show how the work is going.', ru: 'Пишите запрос обычным сообщением — я передам его {engine} и покажу, как идёт работа.', uk: 'Надсилайте запит звичайним повідомленням — я передам його {engine} і покажу, як іде робота.' },
  'start.info': { en: '**🤖 Engine:** {engine}\n**🧠 Model:** {model}\n**👤 Access:** {level}\n**📁 Project:** `{project}`', ru: '**🤖 Движок:** {engine}\n**🧠 Модель:** {model}\n**👤 Доступ:** {level}\n**📁 Проект:** `{project}`', uk: '**🤖 Рушій:** {engine}\n**🧠 Модель:** {model}\n**👤 Доступ:** {level}\n**📁 Проєкт:** `{project}`' },
  'start.commands': { en: 'Commands', ru: 'Команды', uk: 'Команди' },
  'start.btn.project': { en: '📁 Project', ru: '📁 Проект', uk: '📁 Проєкт' },
  'start.btn.new': { en: '🆕 New session', ru: '🆕 Новая сессия', uk: '🆕 Нова сесія' },
  'start.btn.sessions': { en: '↩️ Sessions', ru: '↩️ Сессии', uk: '↩️ Сесії' },
  'start.btn.engine': { en: '🤖 Engine', ru: '🤖 Движок', uk: '🤖 Рушій' },
  'start.btn.model': { en: '🧠 Model', ru: '🧠 Модель', uk: '🧠 Модель' },
  'start.btn.close': { en: '🛑 End session', ru: '🛑 Завершить сессию', uk: '🛑 Завершити сесію' },
  'start.btn.users': { en: '👥 Users', ru: '👥 Сотрудники', uk: '👥 Співробітники' },
  'start.btn.invite': { en: '🔗 Invite', ru: '🔗 Пригласить', uk: '🔗 Запросити' },
  'start.btn.active': { en: '🟢 Active', ru: '🟢 Активные', uk: '🟢 Активні' },
  'help.project': { en: '/project — choose the project (folder) the agent works in', ru: '/project — выбрать проект (папку), в которой работает агент', uk: '/project — обрати проєкт (папку), у якій працює агент' },
  'help.engine': { en: '/engine — choose the engine: Gemini CLI, Claude Code, Antigravity CLI, Codex', ru: '/engine — выбрать движок: Gemini CLI, Claude Code, Antigravity CLI, Codex', uk: '/engine — обрати рушій: Gemini CLI, Claude Code, Antigravity CLI, Codex' },
  'help.model': { en: '/model — choose the model and reasoning level', ru: '/model — выбрать модель и уровень рассуждений', uk: '/model — обрати модель і рівень міркувань' },
  'help.new': { en: '/new — new session', ru: '/new — новая сессия', uk: '/new — нова сесія' },
  'help.sessions': { en: '/sessions — return to a previous session in this project', ru: '/sessions — вернуться к прошлой сессии в этом проекте', uk: '/sessions — повернутися до попередньої сесії в цьому проєкті' },
  'help.stop': { en: '/stop — stop the running request', ru: '/stop — остановить запрос', uk: '/stop — зупинити запит' },
  'help.close': { en: '/close — close the session and free server memory', ru: '/close — закрыть сессию и освободить память сервера', uk: '/close — закрити сесію та звільнити пам’ять сервера' },
  'help.language': { en: '/language — interface language', ru: '/language — язык интерфейса', uk: '/language — мова інтерфейсу' },
  'help.users': { en: '/users — users with access', ru: '/users — сотрудники с доступом', uk: '/users — співробітники з доступом' },
  'help.active': { en: '/active — active sessions', ru: '/active — активные сессии', uk: '/active — активні сесії' },
  'help.invite': { en: '/invite — invite a user', ru: '/invite — пригласить сотрудника', uk: '/invite — запросити співробітника' },

  // ---------- уровни доступа ----------
  'level.read.label': { en: 'Read-only', ru: 'Чтение', uk: 'Читання' },
  'level.read.hint': { en: 'the agent only reads and analyzes, changes nothing', ru: 'агент только читает и анализирует, ничего не меняет', uk: 'агент лише читає та аналізує, нічого не змінює' },
  'level.normal.label': { en: 'Standard', ru: 'Обычный', uk: 'Звичайний' },
  'level.normal.hint': { en: 'the agent asks permission for changes', ru: 'агент спрашивает разрешение на изменения', uk: 'агент питає дозвіл на зміни' },
  'level.full.label': { en: 'Full', ru: 'Полный', uk: 'Повний' },
  'level.full.hint': { en: 'the agent edits files without confirmation', ru: 'агент правит файлы без подтверждений', uk: 'агент редагує файли без підтверджень' },
  'level.admin': { en: 'Administrator', ru: 'Администратор', uk: 'Адміністратор' },

  // ---------- черновик и ход работы (ui.mjs) ----------
  'tool.folder': { en: 'Browsing folder', ru: 'Просмотр папки', uk: 'Перегляд папки' },
  'tool.read': { en: 'Reading file', ru: 'Чтение файла', uk: 'Читання файлу' },
  'tool.readMany': { en: 'Reading files', ru: 'Чтение файлов', uk: 'Читання файлів' },
  'tool.write': { en: 'Writing file', ru: 'Запись файла', uk: 'Запис файлу' },
  'tool.edit': { en: 'Editing file', ru: 'Правка файла', uk: 'Редагування файлу' },
  'tool.shell': { en: 'Command', ru: 'Команда', uk: 'Команда' },
  'tool.shellOutput': { en: 'Command output', ru: 'Вывод команды', uk: 'Вивід команди' },
  'tool.grep': { en: 'Searching files', ru: 'Поиск по файлам', uk: 'Пошук у файлах' },
  'tool.find': { en: 'Finding files', ru: 'Поиск файлов', uk: 'Пошук файлів' },
  'tool.fetch': { en: 'Loading page', ru: 'Загрузка страницы', uk: 'Завантаження сторінки' },
  'tool.web': { en: 'Web search', ru: 'Поиск в интернете', uk: 'Пошук в інтернеті' },
  'tool.skill': { en: 'Skill', ru: 'Навык', uk: 'Навичка' },
  'tool.memory': { en: 'Saving to memory', ru: 'Запись в память', uk: 'Запис у пам’ять' },
  'tool.plan': { en: 'Work plan', ru: 'План работы', uk: 'План роботи' },
  'tool.subagent': { en: 'Subagent', ru: 'Подагент', uk: 'Субагент' },
  'tool.delete': { en: 'Deleting', ru: 'Удаление', uk: 'Видалення' },
  'tool.move': { en: 'Moving', ru: 'Перемещение', uk: 'Переміщення' },
  'step.command': { en: 'running a command', ru: 'выполнение команды', uk: 'виконання команди' },
  'draft.more': { en: '_… {n} earlier_', ru: '_… и ещё {n} выше_', uk: '_… ще {n} вище_' },
  'final.work': { en: 'Work log · {n}', ru: 'Ход работы · {n}', uk: 'Хід роботи · {n}' },
  'final.more': { en: '… and {n} more', ru: '… и ещё {n}', uk: '… ще {n}' },
  'final.tokens': { en: '🔢 {n} tok.', ru: '🔢 {n} ток.', uk: '🔢 {n} ток.' },
  'dur.s': { en: '{n} s', ru: '{n} с', uk: '{n} с' },
  'dur.m': { en: '{n} min', ru: '{n} мин', uk: '{n} хв' },
  'dur.ms': { en: '{m} min {s} s', ru: '{m} мин {s} с', uk: '{m} хв {s} с' },
  'session.active': { en: '🟢 Session active ({details})', ru: '🟢 Сессия активна ({details})', uk: '🟢 Сесія активна ({details})' },
  'session.idle': { en: '⚪ Inactive', ru: '⚪ Неактивен', uk: '⚪ Неактивна' },
  'session.busy': { en: ', running a request', ru: ', выполняет запрос', uk: ', виконує запит' },
  'active.summary': { en: 'Active sessions ({n}), employee slots in use: {busy} of {max}:', ru: 'Активные сессии ({n}), слотов сотрудников занято {busy} из {max}:', uk: 'Активні сесії ({n}), слотів співробітників зайнято {busy} з {max}:' },
  'active.none': { en: 'No active sessions, all {max} employee slots are free.', ru: 'Активных сессий нет, все {max} слота сотрудников свободны.', uk: 'Активних сесій немає, усі {max} слоти співробітників вільні.' },
  'active.kill': { en: '🛑 End: {name}', ru: '🛑 Завершить: {name}', uk: '🛑 Завершити: {name}' },
  'active.owner': { en: 'Administrator (you)', ru: 'Администратор (вы)', uk: 'Адміністратор (ви)' },

  // ---------- выбор движка (/engine) ----------
  'engine.current': { en: '🤖 Engine: {engine}', ru: '🤖 Движок: {engine}', uk: '🤖 Рушій: {engine}' },
  'engine.pick': { en: 'Choose an AI agent. The choice is remembered; switching the engine starts a new session.', ru: 'Выберите AI-агента. Выбор запоминается, смена движка начинает новую сессию.', uk: 'Оберіть AI-агента. Вибір запам’ятовується; зміна рушія починає нову сесію.' },
  'engine.unavailable': { en: 'Unavailable on the server: {list}', ru: 'Недоступны на сервере: {list}', uk: 'Недоступні на сервері: {list}' },
  'engine.needLogin': { en: '⚠️ Sign-in or API key needed: {list} — contact the administrator', ru: '⚠️ Нужен вход или ключ API: {list} — обратитесь к администратору', uk: '⚠️ Потрібен вхід або ключ API: {list} — зверніться до адміністратора' },
  'engine.default': { en: ' · default', ru: ' · по умолчанию', uk: ' · за замовчуванням' },
  'engine.needLoginTag': { en: ' · ⚠️ sign-in needed', ru: ' · ⚠️ нужен вход', uk: ' · ⚠️ потрібен вхід' },
  'engine.more': { en: 'Other engines are granted by the administrator.', ru: 'Другие движки выдаёт администратор.', uk: 'Інші рушії видає адміністратор.' },
  'eng.unknown': { en: '⚠️ Unknown engine.', ru: '⚠️ Неизвестный движок.', uk: '⚠️ Невідомий рушій.' },
  'eng.unavailable': { en: '⚠️ {engine} is unavailable on the server (not installed or not starting).', ru: '⚠️ {engine} недоступен на сервере (не установлен или не запускается).', uk: '⚠️ {engine} недоступний на сервері (не встановлено або не запускається).' },
  'eng.notGranted': { en: '🔒 The {engine} engine is not granted to you. The administrator grants engines.', ru: '🔒 Движок {engine} вам не выдан. Доступ к движкам выдаёт администратор.', uk: '🔒 Рушій {engine} вам не видано. Доступ до рушіїв видає адміністратор.' },
  'eng.needLogin': { en: '⚠️ {engine} is not signed in on the server (sign-in or API key needed) — requests may fail. Please tell the administrator.', ru: '⚠️ {engine} не авторизован на сервере (нужен вход или ключ API) — запросы могут завершаться ошибкой. Сообщите администратору.', uk: '⚠️ {engine} не авторизовано на сервері (потрібен вхід або ключ API) — запити можуть завершуватися помилкою. Повідомте адміністратора.' },
  'eng.already': { en: '🤖 Engine already selected: {engine}{warn}', ru: '🤖 Движок уже выбран: {engine}{warn}', uk: '🤖 Рушій уже обрано: {engine}{warn}' },
  'eng.switched': { en: '🤖 Engine: {engine}\nA new session starts with the next request. Earlier sessions of this project: /sessions.{warn}', ru: '🤖 Движок: {engine}\nНовая сессия начнётся со следующего запроса. Прошлые сессии этого проекта — /sessions.{warn}', uk: '🤖 Рушій: {engine}\nНова сесія почнеться з наступного запиту. Попередні сесії цього проєкту — /sessions.{warn}' },
  'eng.badArg': { en: '⚠️ Unknown engine «{q}». Available: {list}', ru: '⚠️ Неизвестный движок «{q}». Доступны: {list}', uk: '⚠️ Невідомий рушій «{q}». Доступні: {list}' },

  // ---------- выбор модели (/model) ----------
  'model.title': { en: '🧠 Model — {engine}', ru: '🧠 Модель — {engine}', uk: '🧠 Модель — {engine}' },
  'model.now': { en: 'Now: {name}', ru: 'Сейчас: {name}', uk: 'Зараз: {name}' },
  'model.autoDesc': { en: 'Auto (the agent’s default)', ru: 'Авто (как у агента по умолчанию)', uk: 'Авто (як у агента за замовчуванням)' },
  'model.effort': { en: 'Reasoning: {name}', ru: 'Рассуждения: {name}', uk: 'Міркування: {name}' },
  'model.restricted': { en: 'The model list is limited by the administrator.', ru: 'Список моделей ограничен администратором.', uk: 'Список моделей обмежено адміністратором.' },
  'model.saved': { en: 'The choice is remembered for this engine and applies from the next request.', ru: 'Выбор запоминается для этого движка и применяется со следующего запроса.', uk: 'Вибір запам’ятовується для цього рушія і діє з наступного запиту.' },
  'model.loading': { en: '⏳ The model list for {engine} is still loading. Try again in a minute.', ru: '⏳ Список моделей {engine} ещё загружается. Попробуйте через минуту.', uk: '⏳ Список моделей {engine} ще завантажується. Спробуйте за хвилину.' },
  'model.noAuto': { en: '“Auto” is unavailable: the model list is limited by the administrator', ru: '«Авто» недоступно: список моделей ограничен администратором', uk: '«Авто» недоступно: список моделей обмежено адміністратором' },
  'model.badOption': { en: 'This option is unavailable', ru: 'Этот вариант недоступен', uk: 'Цей варіант недоступний' },
  'model.engineChanged': { en: 'The engine has changed — open /model again', ru: 'Движок сменился — откройте /model заново', uk: 'Рушій змінився — відкрийте /model знову' },
  'model.noCatalog': { en: 'The model list is unavailable', ru: 'Список моделей недоступен', uk: 'Список моделей недоступний' },
  'model.chosenEngine': { en: '🤖 Engine selected: {engine}', ru: '🤖 Выбран движок: {engine}', uk: '🤖 Обрано рушій: {engine}' },
  'model.chosenModel': { en: '🧠 Model selected: {name}', ru: '🧠 Выбрана модель: {name}', uk: '🧠 Обрано модель: {name}' },
  'model.chosenEffort': { en: '💭 Reasoning: {name}', ru: '💭 Рассуждения: {name}', uk: '💭 Міркування: {name}' },
  'model.set': { en: 'Model selected', ru: 'Модель выбрана', uk: 'Модель обрано' },
  'effort.set': { en: 'Reasoning level selected', ru: 'Уровень рассуждений выбран', uk: 'Рівень міркувань обрано' },
  'access.noModels': { en: '🔒 No models are left for you in {engine}. Contact the administrator.', ru: '🔒 Для {engine} вам не осталось доступных моделей. Обратитесь к администратору.', uk: '🔒 Для {engine} у вас не лишилося доступних моделей. Зверніться до адміністратора.' },
  'access.switchFail': { en: '⚠️ Could not switch {engine} to the allowed model ({model}); the request was not sent. Try again or /new.', ru: '⚠️ Не удалось переключить {engine} на разрешённую модель ({model}), запрос не отправлен. Попробуйте ещё раз или /new.', uk: '⚠️ Не вдалося перемкнути {engine} на дозволену модель ({model}), запит не надіслано. Спробуйте ще раз або /new.' },

  // ---------- проекты (/project) ----------
  'proj.unavailableRoot': { en: '⚠️ The folder is unavailable or outside {root}', ru: '⚠️ Папка недоступна или лежит вне {root}', uk: '⚠️ Папка недоступна або розташована поза {root}' },
  'proj.notFound': { en: '⚠️ The folder was not found or is unavailable', ru: '⚠️ Папка не найдена или недоступна', uk: '⚠️ Папку не знайдено або вона недоступна' },
  'proj.same': { en: '📁 Project already selected: {p}', ru: '📁 Проект уже выбран: {p}', uk: '📁 Проєкт уже обрано: {p}' },
  'proj.set': { en: '📁 Project: {p}\nA new session starts with the next request.', ru: '📁 Проект: {p}\nНовая сессия начнётся со следующего запроса.', uk: '📁 Проєкт: {p}\nНова сесія почнеться з наступного запиту.' },
  'proj.nav': { en: '📂 {dir}\nCurrent project: {cur}', ru: '📂 {dir}\nТекущий проект: {cur}', uk: '📂 {dir}\nПоточний проєкт: {cur}' },
  'proj.noSub': { en: '(no subfolders)', ru: '(вложенных папок нет)', uk: '(вкладених папок немає)' },
  'proj.recentLegend': { en: '🕘 — recent projects', ru: '🕘 — недавние проекты', uk: '🕘 — нещодавні проєкти' },
  'proj.up': { en: '⬆️ Up', ru: '⬆️ Вверх', uk: '⬆️ Вгору' },
  'proj.choose': { en: '✅ Select this folder', ru: '✅ Выбрать эту папку', uk: '✅ Обрати цю папку' },
  'proj.stale': { en: 'The button is outdated, run /project again', ru: 'Кнопка устарела, вызовите /project заново', uk: 'Кнопка застаріла, викличте /project знову' },
  'proj.noFolder': { en: 'The folder is unavailable', ru: 'Папка недоступна', uk: 'Папка недоступна' },
  'proj.none': { en: 'Nothing found for «{q}». /project — choose with the buttons.', ru: 'Ничего не найдено по запросу «{q}». /project — выбрать кнопками.', uk: 'Нічого не знайдено за запитом «{q}». /project — обрати кнопками.' },
  'proj.found': { en: 'Folders found: {n}. Choose a project:{note}', ru: 'Найдено папок: {n}. Выберите проект:{note}', uk: 'Знайдено папок: {n}. Оберіть проєкт:{note}' },
  'proj.moreResults': { en: '\nThe first results are shown, refine your query.', ru: '\nПоказаны первые результаты, уточните запрос.', uk: '\nПоказано перші результати, уточніть запит.' },

  // ---------- сессии (/sessions) ----------
  'ses.none': { en: 'There are no saved sessions in project {p} yet. They appear after the first request.', ru: 'В проекте {p} пока нет сохранённых сессий. Они появятся после первого запроса.', uk: 'У проєкті {p} ще немає збережених сесій. Вони з’являться після першого запиту.' },
  'ses.list': { en: 'Sessions of project {p}.\nChoose which one to return to:', ru: 'Сессии проекта {p}.\nВыберите, к какой вернуться:', uk: 'Сесії проєкту {p}.\nОберіть, до якої повернутися:' },
  'ses.reqs': { en: '{n} req.', ru: '{n} запр.', uk: '{n} запит.' },
  'ses.alreadyActive': { en: 'This session is already active', ru: 'Эта сессия уже активна', uk: 'Ця сесія вже активна' },
  'ses.notFound': { en: 'The session was not found or belongs to another project. Run /sessions again.', ru: 'Сессия не найдена или относится к другому проекту. Вызовите /sessions заново.', uk: 'Сесію не знайдено або вона належить іншому проєкту. Викличте /sessions знову.' },
  'ses.engineDown': { en: '{engine} is unavailable on the server right now — the session cannot be resumed.', ru: '{engine} сейчас недоступен на сервере — сессию не возобновить.', uk: '{engine} зараз недоступний на сервері — сесію не відновити.' },
  'ses.engineOff': { en: 'The {engine} engine is not granted to you right now — the session cannot be resumed. Contact the administrator.', ru: 'Движок {engine} вам сейчас не выдан — сессию не возобновить. Обратитесь к администратору.', uk: 'Рушій {engine} вам зараз не видано — сесію не відновити. Зверніться до адміністратора.' },
  'ses.resuming': { en: '↩️ Returning to the session from {when}: «{label}»\nLoading takes about 15 seconds…', ru: '↩️ Возвращаюсь к сессии от {when}: «{label}»\nЗагрузка занимает около 15 секунд…', uk: '↩️ Повертаюся до сесії від {when}: «{label}»\nЗавантаження триває близько 15 секунд…' },
  'ses.resumed': { en: '✅ Session resumed: «{label}»\nContinue writing — {engine} remembers this conversation.{switched}', ru: '✅ Сессия возобновлена: «{label}»\nПишите продолжение — {engine} помнит этот диалог.{switched}', uk: '✅ Сесію відновлено: «{label}»\nПишіть продовження — {engine} пам’ятає цей діалог.{switched}' },
  'ses.switched': { en: '\n🤖 Engine switched to {engine}.', ru: '\n🤖 Движок переключён на {engine}.', uk: '\n🤖 Рушій перемкнено на {engine}.' },
  'ses.cancelled': { en: '🛑 Resume cancelled: the session was closed. You can return to it via /sessions.', ru: '🛑 Возобновление отменено: сессия закрыта. Вернуться к ней можно через /sessions.', uk: '🛑 Відновлення скасовано: сесію закрито. Повернутися до неї можна через /sessions.' },
  'ses.failed': { en: '⚠️ Could not resume the session: {msg}\nYou can start a new one with a regular request.', ru: '⚠️ Не удалось возобновить сессию: {msg}\nМожно начать новую обычным запросом.', uk: '⚠️ Не вдалося відновити сесію: {msg}\nМожна почати нову звичайним запитом.' },

  // ---------- запросы разрешений и ход запроса (turn.mjs) ----------
  'perm.opt.allow_once': { en: '✅ Allow', ru: '✅ Разрешить', uk: '✅ Дозволити' },
  'perm.opt.allow_always': { en: '✅ Allow for this session', ru: '✅ Разрешить на эту сессию', uk: '✅ Дозволити на цю сесію' },
  'perm.opt.reject_once': { en: '⛔ Reject', ru: '⛔ Отклонить', uk: '⛔ Відхилити' },
  'perm.opt.reject_always': { en: '⛔ Always reject', ru: '⛔ Отклонять всегда', uk: '⛔ Відхиляти завжди' },
  'perm.res.allow_once': { en: '✅ Allowed', ru: '✅ Разрешено', uk: '✅ Дозволено' },
  'perm.res.allow_always': { en: '✅ Allowed for this session', ru: '✅ Разрешено на эту сессию', uk: '✅ Дозволено на цю сесію' },
  'perm.res.reject': { en: '⛔ Rejected', ru: '⛔ Отклонено', uk: '⛔ Відхилено' },
  'perm.blocked': { en: '🔒 The agent requested an action that is not allowed at your access level — rejected.\n{head}: {what}', ru: '🔒 Агент запросил действие, недоступное на вашем уровне доступа, — отклонено.\n{head}: {what}', uk: '🔒 Агент запросив дію, недоступну на вашому рівні доступу, — відхилено.\n{head}: {what}' },
  'perm.ask': { en: '🔐 <b>The agent asks for permission</b>', ru: '🔐 <b>Агент просит разрешение</b>', uk: '🔐 <b>Агент просить дозвіл</b>' },
  'perm.timeout': { en: '⌛ Time is up, rejected\n{head}: {what}', ru: '⌛ Время вышло, отклонено\n{head}: {what}', uk: '⌛ Час минув, відхилено\n{head}: {what}' },
  'perm.stale': { en: 'This request is no longer active', ru: 'Запрос уже неактуален', uk: 'Запит уже неактуальний' },
  'perm.badOption': { en: 'No such option', ru: 'Нет такого варианта', uk: 'Такого варіанта немає' },
  'turn.stopped': { en: '⏹ Stopped.', ru: '⏹ Остановлено.', uk: '⏹ Зупинено.' },
  'turn.empty': { en: '(empty reply)', ru: '(пустой ответ)', uk: '(порожня відповідь)' },
  'turn.error': { en: '⚠️ Error: {msg}', ru: '⚠️ Ошибка: {msg}', uk: '⚠️ Помилка: {msg}' },
  'turn.filesBelow': { en: '📎 Files are attached below.', ru: '📎 Файлы приложены ниже.', uk: '📎 Файли додано нижче.' },
  'file.tooBig': { en: '⚠️ The file is too large: the limit is 20 MB.', ru: '⚠️ Файл слишком большой: лимит 20 МБ.', uk: '⚠️ Файл завеликий: ліміт 20 МБ.' },
  'file.downloadFail': { en: '⚠️ Could not download the file: {msg}', ru: '⚠️ Не удалось скачать файл: {msg}', uk: '⚠️ Не вдалося завантажити файл: {msg}' },
  'file.archiveSkipped': { en: '⚠️ The archive «{name}» was not unpacked: {why}. The agent gets it as a file.', ru: '⚠️ Архив «{name}» не распакован: {why}. Агент получит его как файл.', uk: '⚠️ Архів «{name}» не розпаковано: {why}. Агент отримає його як файл.' },
  'file.archiveWhy.limit': { en: 'more than 500 files or 100 MB after unpacking', ru: 'больше 500 файлов или 100 МБ после распаковки', uk: 'понад 500 файлів або 100 МБ після розпакування' },
  'file.archiveWhy.corrupt': { en: 'the archive is damaged', ru: 'архив повреждён', uk: 'архів пошкоджено' },
  'file.archiveWhy.unsupported': { en: 'this archive type is not supported (zip64)', ru: 'этот вид архива не поддерживается (zip64)', uk: 'цей вид архіву не підтримується (zip64)' },
  'file.sendFail': { en: '⚠️ Could not send the file «{name}»: {why}', ru: '⚠️ Не удалось отправить файл «{name}»: {why}', uk: '⚠️ Не вдалося надіслати файл «{name}»: {why}' },
  'file.why.missing': { en: 'the file does not exist', ru: 'файл не найден', uk: 'файл не знайдено' },
  'file.why.notfile': { en: 'this is not a regular file', ru: 'это не обычный файл', uk: 'це не звичайний файл' },
  'file.why.denied': { en: 'the file is outside the allowed folders or is protected', ru: 'файл вне разрешённых папок или защищён', uk: 'файл поза дозволеними теками або захищений' },
  'file.why.empty': { en: 'the file is empty', ru: 'файл пустой', uk: 'файл порожній' },
  'file.why.big': { en: 'the file is larger than 20 MB', ru: 'файл больше 20 МБ', uk: 'файл більший за 20 МБ' },
  'file.why.error': { en: 'Telegram rejected the file ({msg})', ru: 'Telegram не принял файл ({msg})', uk: 'Telegram не прийняв файл ({msg})' },
  'limit.slots': { en: '⏳ All {max} employee agent slots are busy right now. Try again in a minute.', ru: '⏳ Сейчас заняты все {max} слота агентов сотрудников. Попробуйте через минуту.', uk: '⏳ Зараз зайняті всі {max} слоти агентів співробітників. Спробуйте за хвилину.' },
  'state.modeViolation': { en: '⛔ The agent tried to switch to the «{mode}» mode, which is not available at your access level. The request was stopped and the session closed.', ru: '⛔ Агент попытался перейти в режим «{mode}», недоступный на вашем уровне доступа. Запрос остановлен, сессия закрыта.', uk: '⛔ Агент спробував перейти в режим «{mode}», недоступний на вашому рівні доступу. Запит зупинено, сесію закрито.' },
  'state.idle': { en: '💤 The session was closed due to inactivity ({min} min). The next request will start a new one.', ru: '💤 Сессия закрыта из-за неактивности ({min} мин). Следующий запрос начнёт новую.', uk: '💤 Сесію закрито через неактивність ({min} хв). Наступний запит почне нову.' },
  'state.closedByAdmin': { en: 'ℹ️ The administrator ended your current session on the server. The next request will start a new one.', ru: 'ℹ️ Администратор завершил вашу текущую сессию на сервере. Следующий запрос начнёт новую.', uk: 'ℹ️ Адміністратор завершив вашу поточну сесію на сервері. Наступний запит почне нову.' },

  // ---------- доступ и приглашения (admin.mjs, access.mjs) ----------
  'access.granted': { en: '✅ Access granted. Level: {level} — {hint}.\n\nSend your requests here and I will pass them to the AI agent on the server (you can choose the engine with /engine). Press /start to see the commands.\n\n{note}', ru: '✅ Доступ открыт. Уровень: {level} — {hint}.\n\nПишите запрос, я передам его AI-агенту на сервере (движок можно выбрать: /engine). Нажмите /start, чтобы увидеть команды.\n\n{note}', uk: '✅ Доступ відкрито. Рівень: {level} — {hint}.\n\nПишіть запит, я передам його AI-агенту на сервері (рушій можна обрати: /engine). Натисніть /start, щоб побачити команди.\n\n{note}' },
  'access.grantedByAdmin': { en: '✅ You have been granted access. Level: {level} — {hint}.\n\nSend your requests here and I will pass them to the AI agent on the server (you can choose the engine with /engine). Press /start to see the commands.\n\n{note}', ru: '✅ Вам выдан доступ. Уровень: {level} — {hint}.\n\nПишите запрос, я передам его AI-агенту на сервере (движок можно выбрать: /engine). Нажмите /start, чтобы увидеть команды.\n\n{note}', uk: '✅ Вам видано доступ. Рівень: {level} — {hint}.\n\nПишіть запит, я передам його AI-агенту на сервері (рушій можна обрати: /engine). Натисніть /start, щоб побачити команди.\n\n{note}' },
  'access.requestSent': { en: '🔒 You do not have access to this bot. The request has been sent to the administrator.', ru: '🔒 У вас нет доступа к этому боту. Запрос отправлен администратору.', uk: '🔒 У вас немає доступу до цього бота. Запит надіслано адміністратору.' },
  'access.pending': { en: 'Your request has already been sent to the administrator. Please wait for a decision.', ru: 'Запрос уже отправлен администратору, ожидайте решения.', uk: 'Запит уже надіслано адміністратору, очікуйте рішення.' },
  'access.inviteBad': { en: 'The invitation is invalid, expired or already used. Ask the administrator for a new one.', ru: 'Приглашение недействительно, просрочено или уже использовано. Попросите администратора создать новое.', uk: 'Запрошення недійсне, прострочене або вже використане. Попросіть адміністратора створити нове.' },
  'access.rejectedByAdmin': { en: '⛔ The administrator rejected your access request.', ru: '⛔ Администратор отклонил запрос доступа.', uk: '⛔ Адміністратор відхилив запит доступу.' },
  'access.revoked': { en: '⛔ The administrator revoked your access to the bot.', ru: '⛔ Администратор отозвал ваш доступ к боту.', uk: '⛔ Адміністратор відкликав ваш доступ до бота.' },
  'access.levelChanged': { en: 'ℹ️ The administrator changed your access level: {level} — {hint}. The new session starts with the next request.', ru: 'ℹ️ Администратор изменил ваш уровень доступа: {level} — {hint}. Новая сессия начнётся со следующего запроса.', uk: 'ℹ️ Адміністратор змінив ваш рівень доступу: {level} — {hint}. Нова сесія почнеться з наступного запиту.' },
  'access.engineGranted': { en: '✅ The administrator opened the {engine} engine for you. Choose it with /engine', ru: '✅ Администратор открыл вам движок {engine}. Выбрать: /engine', uk: '✅ Адміністратор відкрив вам рушій {engine}. Обрати: /engine' },
  'access.engineRevoked': { en: 'ℹ️ The administrator closed the {engine} engine for you. From now on you work in {default}.', ru: 'ℹ️ Администратор закрыл вам движок {engine}. Дальше вы работаете в {default}.', uk: 'ℹ️ Адміністратор закрив вам рушій {engine}. Далі ви працюєте в {default}.' },
  'adm.inviteAsk': { en: 'Choose the access level for the invitation. The link is single-use and valid for 24 hours.', ru: 'Выберите уровень доступа для приглашения. Ссылка одноразовая и действует 24 часа.', uk: 'Оберіть рівень доступу для запрошення. Посилання одноразове і діє 24 години.' },
  'adm.inviteMade': { en: '🔗 Invitation (level: {level})\n\nhttps://t.me/{bot}?start={code}\n\nSingle-use link, valid for 24 hours. Forward it to the employee.', ru: '🔗 Приглашение (уровень: {level})\n\nhttps://t.me/{bot}?start={code}\n\nОдноразовая ссылка, действует 24 часа. Перешлите её сотруднику.', uk: '🔗 Запрошення (рівень: {level})\n\nhttps://t.me/{bot}?start={code}\n\nОдноразове посилання, діє 24 години. Перешліть його співробітнику.' },
  'adm.joinedByInvite': { en: '✅ {who} joined by invitation. Level: {level}.', ru: '✅ {who} подключился по приглашению. Уровень: {level}.', uk: '✅ {who} приєднався за запрошенням. Рівень: {level}.' },
  'adm.reqNew': { en: '🔔 Access request to the bot\n{who}, id {id}{note}\nMessage: {msg}\n\nChoose an access level:', ru: '🔔 Запрос доступа к боту\n{who}, id {id}{note}\nСообщение: {msg}\n\nВыберите уровень доступа:', uk: '🔔 Запит доступу до бота\n{who}, id {id}{note}\nПовідомлення: {msg}\n\nОберіть рівень доступу:' },
  'adm.reqRevokedBefore': { en: '\n(access was revoked earlier)', ru: '\n(доступ ранее был отозван)', uk: '\n(доступ раніше було відкликано)' },
  'adm.reqGrant': { en: '✅ {level} — {hint}', ru: '✅ {level} — {hint}', uk: '✅ {level} — {hint}' },
  'adm.reqRejected': { en: '⛔ Request rejected: {name}', ru: '⛔ Запрос отклонён: {name}', uk: '⛔ Запит відхилено: {name}' },
  'adm.reqGranted': { en: '✅ Access granted: {name} — {level}', ru: '✅ Доступ выдан: {name} — {level}', uk: '✅ Доступ видано: {name} — {level}' },
  'adm.reqNotFound': { en: 'The request was not found or has already been handled.', ru: 'Запрос не найден или уже обработан.', uk: 'Запит не знайдено або його вже оброблено.' },
  'adm.reqHandled': { en: 'The request has already been handled ({status}).', ru: 'Запрос уже обработан ({status}).', uk: 'Запит вже оброблено ({status}).' },
  'adm.ackNotFound': { en: 'Request not found', ru: 'Запрос не найден', uk: 'Запит не знайдено' },
  'adm.ackNoLevel': { en: 'Level not found', ru: 'Уровень не найден', uk: 'Рівень не знайдено' },
  'adm.ackLevelChanged': { en: 'Level changed', ru: 'Уровень изменён', uk: 'Рівень змінено' },
  'adm.ackNoUser': { en: 'The employee was not found or access has already been revoked', ru: 'Сотрудник не найден или доступ уже отозван', uk: 'Співробітника не знайдено або доступ уже відкликано' },
  'adm.ackRevoked': { en: 'Access revoked', ru: 'Доступ отозван', uk: 'Доступ відкликано' },
  'adm.ackKilled': { en: 'Session ended, slot released', ru: 'Сессия завершена, слот освобождён', uk: 'Сесію завершено, слот звільнено' },
  'adm.ackNotActive': { en: 'The session is no longer active', ru: 'Сессия уже не активна', uk: 'Сесія вже неактивна' },
  'adm.ackEngineOn': { en: '{engine}: granted', ru: '{engine}: выдан', uk: '{engine}: видано' },
  'adm.ackEngineOff': { en: '{engine}: revoked', ru: '{engine}: отозван', uk: '{engine}: відкликано' },
  'adm.ackModelsAll': { en: 'All models allowed', ru: 'Разрешены все модели', uk: 'Дозволено всі моделі' },
  'adm.ackNoEngine': { en: 'The engine has not been granted to the employee', ru: 'Движок сотруднику не выдан', uk: 'Рушій співробітнику не видано' },
  'adm.ackNoCatalog': { en: 'The engine’s model list has not been received yet', ru: 'Список моделей движка ещё не получен', uk: 'Список моделей рушія ще не отримано' },
  'adm.ackKeepOne': { en: 'At least one model must remain', ru: 'Должна остаться хотя бы одна модель', uk: 'Має залишитися принаймні одна модель' },
  'adm.ackListChanged': { en: 'The model list has changed — check again', ru: 'Список моделей изменился — проверьте ещё раз', uk: 'Список моделей змінився — перевірте ще раз' },
  'adm.ackNoModelRight': { en: '“Auto” is not available for a limited list', ru: '«Авто» недоступно при ограниченном списке', uk: '«Авто» недоступно за обмеженим списком' },
  'adm.userLine': { en: '{name} (id {id})\nLevel: {level} — {hint}\n{engines}\nAdded: {date}\nStatus: {status}', ru: '{name} (id {id})\nУровень: {level} — {hint}\n{engines}\nДобавлен: {date}\nСтатус: {status}', uk: '{name} (id {id})\nРівень: {level} — {hint}\n{engines}\nДодано: {date}\nСтатус: {status}' },
  'adm.engines': { en: 'Engines: {list}', ru: 'Движки: {list}', uk: 'Рушії: {list}' },
  'adm.engineDefault': { en: ' (default)', ru: ' (по умолчанию)', uk: ' (за замовчуванням)' },
  'adm.usersHeader': { en: 'Users with access ({n}):', ru: 'Сотрудники с доступом ({n}):', uk: 'Співробітники з доступом ({n}):' },
  'adm.usersRevoked': { en: 'Access revoked for: {n}', ru: 'Доступ отозван у: {n}', uk: 'Доступ відкликано у: {n}' },
  'adm.usersEmpty': { en: 'No users with access yet. /invite — create an invitation.', ru: 'Сотрудников с доступом пока нет. /invite — создать приглашение.', uk: 'Співробітників з доступом поки немає. /invite — створити запрошення.' },
  'adm.killUserBtn': { en: '🛑 End the employee’s session', ru: '🛑 Завершить сессию сотрудника', uk: '🛑 Завершити сесію співробітника' },
  'adm.revokeBtn': { en: '🚫 Revoke access', ru: '🚫 Отозвать доступ', uk: '🚫 Відкликати доступ' },
  'adm.toList': { en: '← To the list', ru: '← К списку', uk: '← До списку' },
  'adm.toUser': { en: '← To the employee', ru: '← К сотруднику', uk: '← До співробітника' },
  'adm.modelsBtn': { en: '🧠 Employee models', ru: '🧠 Модели сотрудника', uk: '🧠 Моделі співробітника' },
  'adm.revokeAsk': { en: 'Revoke access for {name}?\nThe current request will be stopped and the session closed.', ru: 'Отозвать доступ у {name}?\nТекущий запрос будет остановлен, сессия закрыта.', uk: 'Відкликати доступ у {name}?\nПоточний запит буде зупинено, сесію закрито.' },
  'adm.revokeYes': { en: '🚫 Yes, revoke', ru: '🚫 Да, отозвать', uk: '🚫 Так, відкликати' },
  'adm.revokedMsg': { en: '🚫 Access revoked: {name}\n\n{list}', ru: '🚫 Доступ отозван: {name}\n\n{list}', uk: '🚫 Доступ відкликано: {name}\n\n{list}' },
  'adm.modelsTitle': { en: '🧠 Models — {name}', ru: '🧠 Модели — {name}', uk: '🧠 Моделі — {name}' },
  'adm.modelsNoCatalog': { en: 'model list not received yet', ru: 'список моделей ещё не получен', uk: 'список моделей ще не отримано' },
  'adm.modelsAll': { en: 'all models', ru: 'все модели', uk: 'усі моделі' },
  'adm.modelsCount': { en: '{a} of {t}', ru: '{a} из {t}', uk: '{a} з {t}' },
  'adm.modelsPick': { en: 'Choose an engine to limit its models.', ru: 'Выберите движок, чтобы ограничить модели.', uk: 'Оберіть рушій, щоб обмежити його моделі.' },
  'adm.engineModelsTitle': { en: '🧠 {engine} — {name}', ru: '🧠 {engine} — {name}', uk: '🧠 {engine} — {name}' },
  'adm.modelsAllAllowed': { en: 'All models are allowed (default).', ru: 'Разрешены все модели (по умолчанию).', uk: 'Дозволено всі моделі (за замовчуванням).' },
  'adm.modelsSome': { en: 'Models allowed: {a} of {t}. “Auto” is unavailable with a limit — the first allowed model is used by default.', ru: 'Разрешено моделей: {a} из {t}. «Авто» при ограничении недоступно — по умолчанию первая разрешённая.', uk: 'Дозволено моделей: {a} з {t}. «Авто» за обмеженням недоступне — за замовчуванням використовується перша дозволена.' },
  'adm.modelsHint': { en: 'Tap a model to allow or forbid it.', ru: 'Нажмите на модель, чтобы разрешить или запретить её.', uk: 'Натисніть на модель, щоб дозволити або заборонити її.' },
  'adm.allowAllBtn': { en: '✅ Allow all', ru: '✅ Разрешить все', uk: '✅ Дозволити всі' },
  'adm.session.line': { en: '• {name} — {details}', ru: '• {name} — {details}', uk: '• {name} — {details}' },
  'adm.killedByAdmin': { en: 'ℹ️ The administrator ended your current session on the server. The next request will start a new one.', ru: 'ℹ️ Администратор завершил вашу текущую сессию на сервере. Следующий запрос начнёт новую.', uk: 'ℹ️ Адміністратор завершив вашу поточну сесію на сервері. Наступний запит почне нову.' },
};

/** Весь словарь — для проверки полноты переводов (test/i18n.test.mjs). */
export const MESSAGES = M;

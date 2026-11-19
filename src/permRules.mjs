// «Разрешить на эту сессию» на стороне бота — для движков, у которых нет своего такого варианта (Claude Code:
// у него только «один раз» и постоянное правило в настройках проекта, которое действовало бы для всех сотрудников).
// Бот отвечает агенту «один раз», а сам запоминает правило в памяти процесса агента и дальше на такие же запросы
// отвечает без вопроса. Правила живут, пока жив процесс: /new, /close, простой и перезапуск бота их сбрасывают.
//
// «Такой же запрос»:
//   - правка, удаление, перенос файла — все действия этого вида в сессии;
//   - команда — по имени программы (ls → все ls …); у программ с подкомандами (git, npm, docker…) — по программе и
//     подкоманде (git status → все git status …, но не git push); составная (a && b | c) — только если разрешены все части;
//     команды через оболочку (bash -c, powershell, cmd /c, sudo …), интерпретаторы (python, node, Rscript, npx…),
//     команды с подстановками ($(…), `…`), перенаправлением в файл (>) и переменными перед программой (PATH=… git) —
//     только точное совпадение всей команды: иначе под «разрешённой» программой прошло бы что угодно;
//   - остальное (чтение, поиск, загрузка страницы, MCP-инструмент) — по виду действия и имени инструмента.

/** id варианта бота: агенту не уходит, вместо него — «один раз» самого агента. */
export const SESSION_OPTION_ID = 'acpgram:session';

/** Программы, внутри которых может выполняться что угодно: для них правило — только на точную команду. */
const WRAPPERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl', 'sudo', 'su', 'doas', 'env', 'xargs', 'eval', 'exec',
  'nohup', 'time', 'timeout', 'nice', 'start', 'call', 'runas', 'invoke-expression', 'iex', 'start-process',
]);

/**
 * Интерпретаторы и программы, которые выполняют произвольный код или чужую команду из своих аргументов: разрешение
 * «python script.py» не должно открывать «python -c "…"», а «find .» — «find . -exec …». Правило — только на точную команду.
 */
const INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'py', 'pythonw', 'node', 'nodejs', 'deno', 'bun', 'r', 'rscript', 'rterm', 'perl', 'ruby', 'php', 'lua',
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'find', 'awk', 'gawk', 'ssh', 'scp', 'osascript', 'wscript', 'cscript', 'mshta', 'rundll32',
]);

/**
 * Программы с подкомандами: правило — на программу вместе с подкомандой («git status» не разрешает «git push»).
 * Параметр перед подкомандой (git -c …, docker --host …) — только точная команда.
 */
const SUBCOMMAND_TOOLS = new Set([
  'git', 'gh', 'glab', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'cargo', 'go', 'dotnet', 'docker', 'podman', 'kubectl', 'helm',
  'terraform', 'winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'systemctl', 'sc', 'nssm', 'schtasks', 'gcloud', 'aws', 'az',
]);

/** Имя программы: без пути, кавычек и расширения исполняемого файла, в нижнем регистре («C:\R\bin\Rscript.exe» → «rscript»). */
function programName(token) {
  const bare = String(token ?? '').replace(/^["']+|["']+$/g, '');
  const base = bare.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

/**
 * Корни составной команды — имя программы или «программа подкоманда» (SUBCOMMAND_TOOLS) — или null, если правило
 * возможно только на точную команду (подстановки, перенаправление в файл, оболочки-обёртки, интерпретаторы,
 * переменные окружения перед программой, нераспознанная часть).
 */
export function commandRoots(command) {
  const s = String(command ?? '').trim();
  if (!s) return null;
  if (/\$\(|`|<\(|>\(/.test(s)) return null; // подстановки команд
  // 2>&1, >nul, >/dev/null — безвредны; любое другое перенаправление пишет в файл
  const noRedirects = s.replace(/\d*>&\d+/g, ' ').replace(/\d*>>?\s*(?:nul|\/dev\/null|\$null)\b/gi, ' ');
  if (/>/.test(noRedirects)) return null;
  const roots = [];
  for (const part of noRedirects.split(/&&|\|\||[;|&\r\n]/)) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    // FOO=bar cmd: переменная меняет то, что запустится (PATH, GIT_SSH_COMMAND, LD_PRELOAD) — только точная команда
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return null;
    const name = programName(tokens[0]);
    if (!name || WRAPPERS.has(name) || INTERPRETERS.has(name)) return null;
    let root = name;
    if (SUBCOMMAND_TOOLS.has(name)) {
      const sub = tokens[1] ?? '';
      if (!/^[A-Za-z][\w-]*$/.test(sub)) return null; // «git» без подкоманды или с параметром впереди
      root = `${name} ${sub.toLowerCase()}`;
    }
    if (!roots.includes(root)) roots.push(root);
  }
  return roots.length ? roots : null;
}

/** Виды действий, которые разрешаются целиком: «разрешить правку на сессию» — все правки в этой сессии. */
const WHOLE_KINDS = new Set(['edit', 'delete', 'move']);

/**
 * Ключи правил для запроса разрешения. null — правило на сессию для такого запроса не предлагаем (не из чего его составить).
 * @param {{kind?: string|null, tool?: string|null, command?: string|null}} req
 */
export function permissionKeys({ kind, tool, command } = {}) {
  if (kind === 'execute') {
    const cmd = String(command ?? '').trim();
    if (!cmd) return null;
    const roots = commandRoots(cmd);
    return roots ? roots.map((r) => `exec:${r}`) : [`exec=${cmd}`];
  }
  if (kind && WHOLE_KINDS.has(kind)) return [`kind:${kind}`];
  if (!kind && !tool) return null;
  return [`tool:${kind ?? ''}:${tool ?? ''}`];
}

/**
 * Что именно разрешит правило — для подписи кнопки «на эту сессию»:
 *   {type: 'exec', what: 'git status …, head …'} — все команды этих программ (подкоманд);
 *   {type: 'exact'} — только эта команда; {type: 'all'} — все действия этого вида или инструмента.
 * @param {string[]|null} keys ключи правила (permissionKeys)
 */
export function describeRule(keys) {
  if (!keys?.length) return null;
  if (keys.every((k) => k.startsWith('exec:'))) return { type: 'exec', what: keys.map((k) => `${k.slice('exec:'.length)} …`).join(', ') };
  if (keys.some((k) => k.startsWith('exec='))) return { type: 'exact' };
  return { type: 'all' };
}

/** Разрешён ли запрос правилами сессии: все его ключи уже разрешены. */
export const rulesAllow = (rules, keys) => Boolean(rules && keys?.length && keys.every((k) => rules.has(k)));

/**
 * Варианты для кнопок с вариантом бота «на эту сессию», если он нужен: у агента нет своего варианта «на сессию» (allow_always
 * среди показанных), есть «один раз», запрос можно описать правилом (keys) и это не смена режима (выход из плана у
 * Claude Code — там варианты переключают режим, автоматически их выбирать нельзя). Вариант встаёт сразу после «один раз».
 * @param {{optionId:string, kind:string, name:string}[]} options уже отфильтрованные варианты агента
 * @param {string[]|null} keys ключи правила (permissionKeys)
 * @param {(o:object)=>string|null} [optionMode] engine.optionMode
 */
export function withSessionOption(options, keys, optionMode = null) {
  if (!keys) return options;
  if (options.some((o) => o.kind === 'allow_always')) return options;
  if (optionMode && options.some((o) => optionMode(o))) return options;
  const i = options.findIndex((o) => o.kind === 'allow_once');
  if (i < 0) return options;
  const own = { optionId: SESSION_OPTION_ID, kind: 'allow_always', name: 'Allow for this session', synthetic: true };
  return [...options.slice(0, i + 1), own, ...options.slice(i + 1)];
}

/** «Один раз» агента — его бот отправляет вместо своего варианта и при автоматическом ответе по правилу. */
export const allowOnceOption = (options, optionMode = null) => options.find((o) => o.kind === 'allow_once' && !optionMode?.(o)) ?? null;

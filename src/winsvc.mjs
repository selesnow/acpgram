// Windows: разбор вывода sc.exe / tasklist / reg.exe и поиск программ — БЕЗ зависимости от языка системы и кодовой страницы консоли.
//
// Почему так. На русской Windows sc.exe печатает подписи по-русски («Состояние», «Код_выхода_Win32», …), в кодовой
// странице OEM (cp866), а `where` — пути в ней же. Регулярки по подписям не срабатывают, и AcpGram «не видел» уже
// существующую службу. Поэтому решения принимаются только по тому, что не переводится:
//   • код выхода sc.exe — это код ошибки Windows (0 — служба есть, 1060 — службы нет);
//   • значения состояний (RUNNING, STOP_PENDING…) и формат «число  (0xHEX)» зашиты в sc.exe;
//   • ключи и значения реестра (DeleteFlag), столбцы CSV tasklist.
// Текст вывода используется только для показа пользователю.
import { win32 } from 'node:path';

/** Код Windows «служба не существует» (ERROR_SERVICE_DOES_NOT_EXIST) — его возвращает sc.exe как код выхода. */
export const ERROR_SERVICE_DOES_NOT_EXIST = 1060;

/**
 * Есть ли служба — по коду выхода `sc.exe query`: true (0), false (1060) или null — не удалось узнать
 * (запуск sc.exe запрещён, нет прав — 5 и т.п.). null нельзя путать ни с «есть», ни с «нет».
 * @param {{status: number|null, error?: string}} r
 */
export function serviceExists(r) {
  if (r?.error || r?.status == null) return null;
  if (r.status === 0) return true;
  return r.status === ERROR_SERVICE_DOES_NOT_EXIST ? false : null;
}

const STATES = 'STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED';

/**
 * Состояние службы из `sc query`: по «: N  ЗНАЧЕНИЕ» из закрытого списка значений, подпись не нужна
 * («Состояние», «STATE», …). Строка «ТИП : 10  WIN32_OWN_PROCESS» под список не подходит. null — не нашли.
 */
export function serviceState(scQueryOutput) {
  const m = new RegExp(`:\\s*[1-7]\\s+(${STATES})\\b`).exec(scQueryOutput ?? '');
  return m ? m[1] : null;
}

/**
 * Код ошибки службы из вывода sc.exe:
 *   `sc start` → «[SC] StartService FAILED 1069:» (слово FAILED на другом языке — другое, число то же);
 *   `sc query` → первая пара «число  (0xHEX)» — WIN32_EXIT_CODE, вторая — SERVICE_EXIT_CODE (его берём при 1066).
 * Подписи не нужны. null — ошибки нет.
 */
export function serviceErrorCode(scOutput) {
  const text = scOutput ?? '';
  const start = /StartService\D{0,40}?(\d{3,5})\s*:/.exec(text);
  if (start) return Number(start[1]) || null;
  const pairs = [...text.matchAll(/:\s*(\d+)\s+\(0x[0-9a-fA-F]+\)/g)].map((m) => Number(m[1]));
  const code = pairs[0] === 1066 ? pairs[1] : pairs[0];
  return code || null;
}

/** PID процесса службы из `tasklist /svc /fi "SERVICES eq имя" /fo csv /nh`; строки без кавычек (сообщение «нет задач» на любом языке) пропускаются. */
export function parseTasklistPid(output) {
  const m = /^"[^"]*","(\d+)",/m.exec(output ?? '');
  return m && Number(m[1]) ? Number(m[1]) : null;
}

/** Аргументы `reg query` для флага «помечена для удаления». Путь собирается без String.raw: он не может заканчиваться на «\». */
export const deleteFlagArgs = (name) => ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${name}`, '/v', 'DeleteFlag'];

/** Служба помечена для удаления (DeleteFlag = 1): код выхода 0 и «REG_DWORD 0x1». Без значения reg.exe возвращает 1. */
export const parseDeleteFlag = (r) => r?.status === 0 && /DeleteFlag\s+REG_DWORD\s+0x0*1\b/i.test(r.stdout ?? '');

/**
 * Причина отказа `nssm install` (сам nssm пишет только «CreateService(): …» без номера, а текст на русской Windows
 * превращается в «????»). Определяется по состоянию службы, а не по сообщению nssm.
 * @param {{exists: boolean|null, marked: boolean, keyNameTaken: boolean, nssmStatus?: number|null, name: string}} d
 */
export function diagnoseCreate({ exists, marked, keyNameTaken, nssmStatus = null, name }) {
  if (exists && marked) return { code: 1072, text: `служба ${name} помечена для удаления (ошибка Windows 1072)` };
  if (exists) return { code: 1073, text: `служба ${name} уже существует (ошибка Windows 1073): выполните acpgram service uninstall` };
  if (keyNameTaken) return { code: 1078, text: `имя ${name} или отображаемое имя службы уже занято другой службой (ошибка Windows 1078)` };
  if (exists === null) return { code: null, text: `не удалось определить причину: sc.exe недоступен${nssmStatus != null ? ` (nssm вернул код ${nssmStatus})` : ''}` };
  return { code: null, text: `Windows отказал в создании службы${nssmStatus != null ? ` (nssm вернул код ${nssmStatus})` : ''}` };
}

/** Сообщение Windows, нечитаемое в этой кодировке: nssm выводит «?», а UTF-8-разбор OEM-текста даёт U+FFFD. */
export const isGarbled = (text) => /\?{4,}|�{3,}/.test(text ?? '');

/**
 * Текст вывода консольной программы Windows:
 *   UTF-16LE (нули между символами) → utf16le; корректный UTF-8 → как есть;
 *   иначе — кодовая страница OEM (cp866 на русской Windows; 437/850 браузерный TextDecoder не знает — latin1).
 */
export function decodeOutput(buf, oemcp = 0) {
  if (!buf?.length) return '';
  const b = Buffer.from(buf);
  let zeroOdd = 0;
  for (let i = 1; i < b.length; i += 2) if (b[i] === 0) zeroOdd++;
  if (b.length >= 4 && zeroOdd >= b.length / 4) return b.toString('utf16le').replace(/^﻿/, '');
  const plain = b.includes(0) ? Buffer.from(b.filter((x) => x !== 0)) : b;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    /* не UTF-8 — кодовая страница консоли */
  }
  for (const label of [`ibm${oemcp}`, `windows-${oemcp}`]) {
    try {
      return new TextDecoder(label).decode(plain);
    } catch {
      /* кодировка неизвестна */
    }
  }
  return plain.toString('latin1');
}

/** Кодовая страница OEM из вывода `reg query …\Nls\CodePage /v OEMCP` («OEMCP    REG_SZ    866»). */
export const parseOemCp = (output) => Number(/OEMCP\s+REG_SZ\s+(\d+)/.exec(output ?? '')?.[1]) || 0;

/**
 * Поиск программы по PATH средствами Node (строки без кодовых страниц, в отличие от `where`, который в профиле
 * с кириллицей выдаёт пути в cp866). Возвращает первый найденный файл или null.
 * @param {string} cmd имя без расширения
 * @param {{pathVar?: string, exts?: string[], exists: (p: string) => boolean, extra?: string[]}} o
 */
export function findOnPath(cmd, { pathVar = process.env.PATH ?? process.env.Path ?? '', exts = ['.exe', '.cmd', '.bat'], exists, extra = [] } = {}) {
  const dirs = [...pathVar.split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean), ...extra];
  for (const dir of dirs) for (const ext of exts) if (exists(win32.join(dir, cmd + ext))) return win32.join(dir, cmd + ext);
  return null;
}

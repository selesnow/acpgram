// Вывод в журнал бота (stdout и stderr службы → data/service.log): каждая строка с отметкой времени.
// Отдельный модуль без зависимостей: им пользуются и нижние слои (acp, telegram, db), которым нельзя импортировать ctx.mjs.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { clipLogLine } from './clip.mjs';

const stamp = () => new Date().toISOString();
const format = (args) => clipLogLine(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 3, breakLength: Infinity }))).join(' '));

export const log = (...a) => console.log(stamp(), format(a));

/** То же в stderr: ошибки и предупреждения. */
export const logError = (...a) => console.error(stamp(), format(a));

export function cleanupLogs(dir, days) {
  if (!(Number(days) > 0)) return 0;
  const before = Date.now() - Number(days) * 86400_000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!/^debug\.log\.\d+$/.test(name)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < before) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      continue;
    }
  }
  return removed;
}

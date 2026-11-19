// Вывод в журнал бота (stdout и stderr службы → data/service.log): каждая строка с отметкой времени.
// Отдельный модуль без зависимостей: им пользуются и нижние слои (acp, telegram, db), которым нельзя импортировать ctx.mjs.
const stamp = () => new Date().toISOString();

export const log = (...a) => console.log(stamp(), ...a);

/** То же в stderr: ошибки и предупреждения. */
export const logError = (...a) => console.error(stamp(), ...a);

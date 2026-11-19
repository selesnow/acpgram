// Построчный дифф для запроса разрешения на правку файла: пользователь видит, что именно изменит агент,
// а не только путь. Без зависимостей: наибольшая общая подпоследовательность строк, для больших текстов — упрощённо.

/** Произведение числа строк, выше которого точный дифф не считается (таблица LCS — память и время). */
const LCS_LIMIT = 250_000;

const linesOf = (s) => (s ? String(s).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);

/** Операции построчного сравнения: [' ' | '-' | '+', строка][]. */
function ops(a, b) {
  // общие начало и конец не участвуют в таблице: правка обычно в середине файла
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((l) => [' ', l]);
  const tail = a.slice(endA).map((l) => [' ', l]);
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let mid;
  if (x.length * y.length > LCS_LIMIT) {
    mid = [...x.map((l) => ['-', l]), ...y.map((l) => ['+', l])]; // слишком большой кусок: «всё удалено, всё добавлено»
  } else {
    const w = y.length + 1;
    const table = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        mid.push([' ', x[i]]);
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) mid.push(['-', x[i++]]);
      else mid.push(['+', y[j++]]);
    }
    while (i < x.length) mid.push(['-', x[i++]]);
    while (j < y.length) mid.push(['+', y[j++]]);
  }
  return [...head, ...mid, ...tail];
}

/**
 * Дифф двух текстов в привычном виде: строки с «-» и «+», вокруг изменений — context строк без изменений,
 * пропуски отмечены «…». Не длиннее maxLines строк (дальше — «… ещё N»). Пустая строка — изменений нет.
 * @returns {{text: string, added: number, removed: number}}
 */
export function lineDiff(oldText, newText, { context = 2, maxLines = 40 } = {}) {
  const all = ops(linesOf(oldText), linesOf(newText));
  const added = all.filter(([k]) => k === '+').length;
  const removed = all.filter(([k]) => k === '-').length;
  if (!added && !removed) return { text: '', added, removed };
  const keep = new Array(all.length).fill(false);
  all.forEach(([k], i) => {
    if (k === ' ') return;
    for (let d = Math.max(0, i - context); d <= Math.min(all.length - 1, i + context); d++) keep[d] = true;
  });
  const out = [];
  let gap = false;
  all.forEach(([k, line], i) => {
    if (!keep[i]) {
      gap = true;
      return;
    }
    if (gap && out.length) out.push('…');
    gap = false;
    out.push(`${k}${line}`);
  });
  const shown = out.slice(0, maxLines);
  if (out.length > maxLines) shown.push(`… +${out.length - maxLines}`);
  return { text: shown.join('\n'), added, removed };
}

export function clipText(value, head, tail, marker = '…') {
  const s = String(value);
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}${marker}${tail > 0 ? s.slice(-tail) : ''}`;
}

export function clipLogLine(value, max = 2000) {
  const s = String(value ?? '');
  const head = Math.floor(max / 2);
  const tail = max - head;
  return s
    .split(/\r?\n/)
    .map((line) => (line.length > max ? clipText(line, head, tail, ' … обрезано … ') : line))
    .join('\n');
}

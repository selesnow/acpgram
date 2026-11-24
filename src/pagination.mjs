export const pagesOf = (total, size) => Math.max(1, Math.ceil(Number(total) / size));

export const clamp = (page, pages) => Math.min(Math.max(Number(page) || 0, 0), Math.max(1, pages) - 1);

export function pageInfo(total, size, page = 0) {
  const pages = pagesOf(total, size);
  return { page: clamp(page, pages), pages };
}

export const clampPage = (page, total, size) => pageInfo(total, size, page);

export function pageRow(page, pages, data, options = {}) {
  const opts = typeof options === 'boolean' ? { center: options } : options;
  const center = opts.center !== false && pages >= 2;
  const prev = opts.prev ?? page > 0;
  const next = opts.next ?? page < pages - 1;
  const row = [];
  if (prev) row.push({ text: '◀', callback_data: data(page - 1) });
  if (center) row.push({ text: `${page + 1}/${pages}`, callback_data: 'nav:n' });
  if (next) row.push({ text: '▶', callback_data: data(page + 1) });
  return row;
}

export function pageNav(page, pages, data, options = {}) {
  const row = pageRow(page, pages, data, options);
  return row.length ? [row] : [];
}

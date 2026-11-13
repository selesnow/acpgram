// Альбомы Telegram: каждое фото альбома приходит отдельным сообщением с общим media_group_id.
// Копим сообщения по ключу и отдаём группу целиком, когда новых сообщений нет waitMs миллисекунд.

/** Задержка после последнего сообщения альбома. */
export const ALBUM_WAIT_MS = 1500;

/**
 * @param {{waitMs?: number, onFlush: (key: string, items: object[]) => void}} o
 * onFlush вызывается один раз на альбом со всеми накопленными элементами в порядке поступления.
 */
export function createAlbumBuffer({ waitMs = ALBUM_WAIT_MS, onFlush }) {
  const groups = new Map();
  return {
    add(key, item) {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { items: [], timer: null }));
      g.items.push(item);
      clearTimeout(g.timer);
      g.timer = setTimeout(() => {
        groups.delete(key);
        onFlush(key, g.items);
      }, waitMs);
    },
    /** Сколько альбомов ждёт отправки. */
    get size() {
      return groups.size;
    },
  };
}

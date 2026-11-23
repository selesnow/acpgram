const PREFIX = 'pending:';
const DEFAULT_TTL_MS = 24 * 3600_000;
const SECRET_PATTERNS = [
  /^gh[pousr]_[A-Za-z0-9]{16,}$/i,
  /^github_pat_[A-Za-z0-9_]{16,}$/i,
  /^glpat-[A-Za-z0-9_-]{16,}$/i,
  /^npm_[A-Za-z0-9]{20,}$/i,
  /^sk-[A-Za-z0-9_-]{20,}$/i,
  /^AKIA[A-Z0-9]{16}$/,
];

const parse = (value) => {
  if (!value) return null;
  try {
    const data = JSON.parse(value);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
};

export function looksLikeSecret(text) {
  const s = String(text ?? '').trim();
  return SECRET_PATTERNS.some((re) => re.test(s));
}

export function createPendingStore(db, { now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  const keyOf = (userId, topic = 0) => `${PREFIX}${userId}:${topic}`;
  return {
    set(userId, topic, value) {
      const data = { ...value, at: Number.isFinite(value?.at) ? value.at : now() };
      db.setSetting(keyOf(userId, topic), JSON.stringify(data));
      return data;
    },
    get(userId, topic = 0) {
      const key = keyOf(userId, topic);
      const data = parse(db.getSetting(key));
      if (!data) return null;
      if (!Number.isFinite(data.at) || now() - data.at > ttlMs) {
        db.setSetting(key, null);
        return null;
      }
      return data;
    },
    clear(userId, topic = 0) {
      db.setSetting(keyOf(userId, topic), null);
    },
    sweep() {
      const keys = db.allSettings ? db.allSettings() : [];
      let removed = 0;
      for (const { key, value } of keys) {
        if (!key?.startsWith(PREFIX) || !value) continue;
        const data = parse(value);
        if (!data || !Number.isFinite(data.at) || now() - data.at > ttlMs) {
          db.setSetting(key, null);
          removed++;
        }
      }
      return removed;
    },
  };
}

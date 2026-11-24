export function createKeyRegistry({
  scope = 'global',
  field = 'keys',
  limit = Infinity,
  eviction = 'oldest',
  stable = false,
  full = false,
  keyOf = (n) => String(n),
} = {}) {
  const globalStore = new Map();
  const reverse = new WeakMap();
  let seq = 0;

  const storeOf = (st) => (scope === 'state' ? (st[field] ??= new Map()) : globalStore);
  const indexOf = (store) => {
    let index = reverse.get(store);
    if (!index) reverse.set(store, (index = new Map()));
    return index;
  };
  const clearStore = (store) => {
    store.clear();
    reverse.get(store)?.clear();
  };
  const dropKey = (store, key) => {
    if (!store.has(key)) return;
    if (stable) {
      const index = indexOf(store);
      if (index.get(store.get(key)) === key) index.delete(store.get(key));
    }
    store.delete(key);
  };
  const trim = (store, before) => {
    if (eviction === 'clear') {
      if (store.size > limit || (full && store.size >= limit)) clearStore(store);
      return;
    }
    if (before) return;
    while (store.size > limit) dropKey(store, store.keys().next().value);
  };
  const rememberValue = (store, value, key) => {
    if (stable) indexOf(store).set(value, key);
  };
  const resolveKey = (store, key) => (store.has(key) ? key : String(key));

  function add(value, st) {
    const store = storeOf(st);
    if (stable) {
      const old = indexOf(store).get(value);
      if (old !== undefined && store.has(old)) return old;
    }
    trim(store, true);
    const key = keyOf(++seq);
    store.set(key, value);
    rememberValue(store, value, key);
    trim(store, false);
    return key;
  }

  function put(key, value, st) {
    const store = storeOf(st);
    trim(store, true);
    dropKey(store, key);
    store.set(key, value);
    rememberValue(store, value, key);
    trim(store, false);
    return key;
  }

  function get(key, st) {
    const store = storeOf(st);
    const found = resolveKey(store, key);
    return store.has(found) ? store.get(found) : undefined;
  }

  function drop(key, st) {
    const store = storeOf(st);
    dropKey(store, resolveKey(store, key));
  }

  function clear(st) {
    clearStore(storeOf(st));
  }

  const size = (st) => storeOf(st).size;

  return { add, put, get, drop, clear, size, store: storeOf };
}

export function createQueue(limit = 1) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  const waiting = [];
  let active = 0;
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    const finish = () => {
      active--;
      next();
    };
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          finish();
          resolve(value);
        },
        (error) => {
          finish();
          reject(error);
        },
      );
  };
  return {
    get size() {
      return waiting.length;
    },
    get active() {
      return active;
    },
    add(fn) {
      const promise = new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        next();
      });
      promise.catch(() => {});
      return promise;
    },
  };
}

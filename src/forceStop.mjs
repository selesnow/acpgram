export function clearStopTimer(st, { clearTimer = clearTimeout } = {}) {
  if (!st) return;
  if (st.stopTimer) clearTimer(st.stopTimer);
  st.stopTimer = null;
}

export function forceStopAfter(st, { ms = 5000, setTimer = setTimeout, clearTimer = clearTimeout, kill = (agent) => agent.close() } = {}) {
  clearStopTimer(st, { clearTimer });
  if (!st?.busy || !st.agent || st.agent.closed) return () => {};
  const turn = st.turnId;
  st.stopTimer = setTimer(() => {
    st.stopTimer = null;
    if (!st.busy || st.turnId !== turn || !st.agent || st.agent.closed) return;
    kill(st.agent);
  }, ms);
  if (typeof st.stopTimer?.unref === 'function') st.stopTimer.unref();
  return () => clearStopTimer(st, { clearTimer });
}

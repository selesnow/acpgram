import { resolve } from 'node:path';
import { db } from './ctx.mjs';
import { accountsOf, hostFor, identityOf } from './gitAccess.mjs';
import { authConfig, HostError } from './gitHosts.mjs';
import { gitCommand, gitEnv, GitConfigError, GitError, repoState } from './git.mjs';
import { errText, maskErrorPaths } from './i18n.mjs';
import { insideRoot, isPersonalRoot, ROOT } from './projects.mjs';
import { agentSandbox } from './sandbox.mjs';
import { rootOf, sandboxed } from './state.mjs';
import { th } from './ui.mjs';

export const projectOf = (st) => insideRoot(st.project, rootOf(st.userId));

const baseOpts = (st, cwd, account, auth, hide) => {
  const root = rootOf(st.userId);
  const wrap = sandboxed(st.userId, cwd)
    ? agentSandbox({ userId: st.userId, cwd, root, command: gitCommand(), protect: isPersonalRoot(root) ? [ROOT] : [] })
    : null;
  return { env: gitEnv({ identity: identityOf(account), auth }), wrap, hide };
};

export function gitOpts(st, cwd, account = null) {
  const who = account ?? accountsOf(st.userId)[0]?.account ?? null;
  return baseOpts(st, cwd, who, [], []);
}

export function gitNetOpts(st, cwd, { host, account }) {
  const auth = host && account ? authConfig(host, account.token) : [];
  const hide = account ? [account.token, auth[0]?.[1]?.split(' ').pop()] : [];
  return baseOpts(st, cwd, account, auth, hide);
}

export async function repoOf(st, project) {
  const state = await repoState(project, gitOpts(st, project));
  if (!state || !insideRoot(state.top, rootOf(st.userId))) return null;
  const host = hostFor(state.remote);
  const account = host ? db.getGitAccount(st.userId, host.id) : null;
  return { state, host, account };
}

export const failText = (e, lang, host = null, root = null) => {
  const mask = (s) => (root ? maskErrorPaths(s, root, lang) : s);
  if (e instanceof GitConfigError) return th('git.unsafeConfig', lang, { keys: e.keys.join(', ') });
  if (e instanceof HostError && e.code === 'forbidden') return th('git.needApi', lang, { host: host?.label ?? 'Git', msg: mask(e.message) });
  const msg = e?.i18n ? errText(e, lang, root) : e instanceof GitError || e instanceof HostError ? e.message : errText(e, lang, root);
  return th('git.opFail', lang, { msg: mask(msg) });
};

const gitLocks = new Map();
const lockKey = (cwd) => {
  const p = resolve(String(cwd ?? ''));
  return process.platform === 'win32' ? p.toLowerCase() : p;
};

export function acquireGitLock(st, cwd) {
  const key = lockKey(cwd);
  if (gitLocks.has(key)) return null;
  const token = Symbol('git');
  gitLocks.set(key, token);
  st.gitBusy = true;
  return { key, token };
}

export function releaseGitLock(st, lock) {
  if (!lock) return;
  if (gitLocks.get(lock.key) === lock.token) gitLocks.delete(lock.key);
  st.gitBusy = false;
}

export const GIT_BUSY = Symbol('git.busy');

export async function withGitLock(st, fn, cwd = st.project) {
  const lock = acquireGitLock(st, cwd);
  if (!lock) return GIT_BUSY;
  try {
    return await fn();
  } finally {
    releaseGitLock(st, lock);
  }
}

export const isGitLocked = (cwd) => gitLocks.has(lockKey(cwd));

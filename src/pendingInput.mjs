const WAIT_MS = 10 * 60_000;

export const GIT_WAIT_MS = WAIT_MS;
export const FILE_WAIT_MS = WAIT_MS;
export const NEW_PROJECT_WAIT_MS = WAIT_MS;

export const PENDING_INPUTS = Object.freeze({
  gitToken: { ttl: GIT_WAIT_MS, secret: true },
  gitSearch: { ttl: GIT_WAIT_MS, secret: false },
  gitMessage: { ttl: GIT_WAIT_MS, secret: false },
  gitHostUrl: { ttl: GIT_WAIT_MS, secret: false },
  gitHostName: { ttl: GIT_WAIT_MS, secret: false },
  gitBranch: { ttl: GIT_WAIT_MS, secret: false },
  gitNsSearch: { ttl: GIT_WAIT_MS, secret: false, group: 'publish' },
  gitRepoName: { ttl: GIT_WAIT_MS, secret: false, group: 'publish' },
  gitMrTitle: { ttl: GIT_WAIT_MS, secret: false, group: 'publish' },
  newProject: { ttl: NEW_PROJECT_WAIT_MS, secret: false },
  fileName: { ttl: FILE_WAIT_MS, secret: false },
  fileContent: { ttl: FILE_WAIT_MS, secret: false },
  fileUpload: { ttl: FILE_WAIT_MS, secret: false },
});

export const PENDING_INPUT_KINDS = Object.freeze(Object.keys(PENDING_INPUTS));

export const pendingKindsOf = (group) => PENDING_INPUT_KINDS.filter((kind) => PENDING_INPUTS[kind].group === group);

export const isPendingKind = (kind) => typeof kind === 'string' && Object.hasOwn(PENDING_INPUTS, kind);

export const isSecretPendingInput = (wait) => isPendingKind(wait?.kind) && PENDING_INPUTS[wait.kind].secret;

export const setPendingInput = (st, kind, fields = {}, now = Date.now()) => (st.pendingInput = { kind, ...fields, at: now });

export const clearPendingInput = (st) => {
  st.pendingInput = null;
};

export const renewPendingInput = (st, wait, now = Date.now()) => setPendingInput(st, wait.kind, wait, now);

export const pendingKindMatches = (wait, kinds) => (Array.isArray(kinds) ? kinds : [kinds]).includes(wait?.kind);

export const isPendingExpired = (wait, now = Date.now()) => {
  if (!wait || !Number.isFinite(wait.at)) return true;
  const ttl = isPendingKind(wait.kind) ? PENDING_INPUTS[wait.kind].ttl : WAIT_MS;
  return now - wait.at > ttl;
};

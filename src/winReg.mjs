import { spawnSync } from 'node:child_process';

export function regQuery(args, { exe = 'reg', encoding = 'latin1', timeout, spawn = spawnSync } = {}) {
  const options = { windowsHide: true };
  if (encoding != null) options.encoding = encoding;
  if (timeout != null) options.timeout = timeout;
  return spawn(exe, args, options);
}

import { spawnSync } from 'node:child_process';
import { broadAclFromOutput } from './safety.mjs';

export function protectWindowsPath(path, { directory = false, platform = process.platform, env = process.env, run = spawnSync } = {}) {
  if (platform !== 'win32') return null;
  const name = env.USERNAME ? (env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : `.\\${env.USERNAME}`) : null;
  const flags = directory ? '(OI)(CI)F' : 'F';
  const grants = [name && `${name}:${flags}`, `SYSTEM:${flags}`, `Administrators:${flags}`].filter(Boolean);
  const r = run('icacls', [path, '/inheritance:r', '/grant:r', ...grants], { encoding: 'utf8', windowsHide: true });
  return { status: r?.status ?? null, error: r?.error ?? null, output: `${r?.stdout ?? ''}\n${r?.stderr ?? ''}` };
}

export function envAclRisk(path, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') return false;
  const r = run('icacls', [path], { encoding: 'utf8', windowsHide: true });
  if (r?.error || r?.status !== 0) return false;
  return broadAclFromOutput(`${r?.stdout ?? ''}\n${r?.stderr ?? ''}`);
}

const BROAD_ACL = /(^|[\\/])(Users|Authenticated Users|Everyone|All Users)(\)|$|:)|S-1-5-32-545|S-1-5-11|S-1-1-0/i;

export const SAFETY_WARNING_IDS = ['noSandbox', 'adminNoSandbox', 'broadAcl'];

export function safetyWarningIds({ sandbox, activeUsers, adminSandbox, personalWorkspaces, aclRisk }) {
  const ids = [];
  if (!sandbox && activeUsers) ids.push('noSandbox');
  if (activeUsers && !adminSandbox && !personalWorkspaces) ids.push('adminNoSandbox');
  if (aclRisk) ids.push('broadAcl');
  return ids.filter((id) => SAFETY_WARNING_IDS.includes(id));
}

export function newWarningIds(ids, seen = []) {
  const known = new Set(Array.isArray(seen) ? seen : []);
  return [...new Set(ids)].filter((id) => !known.has(id));
}

export function broadAclFromOutput(output) {
  return BROAD_ACL.test(String(output ?? ''));
}

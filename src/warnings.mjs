import { ENV_PATH } from './app.mjs';
import { ADMIN_ID, db, langOf, log, say } from './ctx.mjs';
import { t } from './i18n.mjs';
import { envAclRisk } from './protect.mjs';
import { USER_WORKSPACES } from './projects.mjs';
import { SANDBOX } from './sandbox.mjs';
import { newWarningIds, SAFETY_WARNING_IDS, safetyWarningIds } from './safety.mjs';
import { ADMIN_SANDBOX } from './state.mjs';

const KEY = 'safetyWarnings';
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export function maybeNotifySafety({
  database = db,
  sandbox = SANDBOX,
  activeUsers = db.listUsers().some((u) => u.status === 'active'),
  adminSandbox = ADMIN_SANDBOX,
  personalWorkspaces = USER_WORKSPACES,
  aclRisk = envAclRisk(ENV_PATH),
  lang = langOf(ADMIN_ID),
  send = (text) => say(ADMIN_ID, text),
} = {}) {
  const raw = parse(database.getSetting(KEY));
  const seen = Array.isArray(raw) ? raw.filter((id) => SAFETY_WARNING_IDS.includes(id)) : [];
  const ids = safetyWarningIds({ sandbox, activeUsers, adminSandbox, personalWorkspaces, aclRisk });
  const fresh = newWarningIds(ids, seen);
  if (!fresh.length) return [];
  database.setSetting(KEY, JSON.stringify([...new Set([...seen, ...fresh])]));
  send(`${t('warn.title', lang)}\n\n${fresh.map((id) => t(`warn.${id}`, lang)).join('\n\n')}`);
  log('предупреждения администратору:', fresh.join(', '));
  return fresh;
}

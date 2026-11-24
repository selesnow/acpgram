import { log, say } from './ctx.mjs';
import { addCustomHost, findHost, hosts as allHosts, removeCustomHost, renameCustomHost } from './gitAccess.mjs';
import { customHost, probeHost } from './gitHosts.mjs';
import { t } from './i18n.mjs';
import { renewPendingInput, setPendingInput } from './pendingInput.mjs';
import { isAdmin } from './state.mjs';
import { th } from './ui.mjs';
import { cancelRow } from './uiActions.mjs';

export const KIND_LABEL = { gitlab: 'GitLab', github: 'GitHub Enterprise' };

/** Экран администратора «Свои серверы»: список, добавление GitLab или GitHub Enterprise, название, удаление. */
function hostsView(lang, note = '') {
  const own = allHosts().filter((h) => h.custom);
  const list = own.length
    ? own.map((h) => th('git.hosts.line', lang, { label: h.label, url: h.web, kind: KIND_LABEL[h.kind] }) + (h.fromEnv ? th('git.hosts.env', lang) : '')).join('\n')
    : `<i>${th('git.hosts.none', lang)}</i>`;
  const rows = own.filter((h) => !h.fromEnv).map((h) => [{ text: `✏️ ${h.label}`, callback_data: `gt:hn:${h.id}` }, { text: `🗑 ${t('git.hosts.remove', lang)}`, callback_data: `gt:hd:${h.id}` }]);
  rows.push([{ text: t('git.hosts.addGitlab', lang), callback_data: 'gt:ha:gitlab' }, { text: t('git.hosts.addGithub', lang), callback_data: 'gt:ha:github' }]);
  rows.push([{ text: t('btn.back', lang), callback_data: 'gt:v' }]);
  return { text: `${note ? `${note}\n\n` : ''}${th('git.hosts.head', lang)}\n\n${list}`, markup: { inline_keyboard: rows } };
}

export async function onHostCallback(st, h) {
  const { action, arg, lang, ack, edit } = h;
  if (!isAdmin(st.userId)) return ack(t('admin.only', lang));
  if (action === 'h') return (await ack(), edit(hostsView(lang)));
  if (action === 'ha' && KIND_LABEL[arg]) {
    await ack();
    setPendingInput(st, 'gitHostUrl', { hostKind: arg });
    return say(st.to, t('git.hosts.urlAsk', lang, { kind: KIND_LABEL[arg] }), { reply_markup: cancelRow('gt', lang) });
  }
  const own = findHost(arg);
  if (!own?.custom || own.fromEnv) return ack(t('proj.stale', lang));
  if (action === 'hn') {
    await ack();
    setPendingInput(st, 'gitHostName', { host: own.id });
    return say(st.to, t('git.hosts.nameAsk', lang), { reply_markup: cancelRow('gt', lang) });
  }
  if (action === 'hd') {
    await ack();
    return edit({ text: th('git.hosts.deleteAsk', lang, { label: own.label }), markup: { inline_keyboard: [[{ text: t('git.hosts.remove', lang), callback_data: `gt:hD:${own.id}` }, { text: t('btn.cancel', lang), callback_data: 'gt:h' }]] } });
  }
  const n = removeCustomHost(own.id);
  log('свой сервер git убран:', own.web, '| отключено аккаунтов', n);
  await ack();
  return edit(hostsView(lang, th('git.hosts.deleted', lang, { label: own.label, n: n ?? 0 })));
}

export async function onHostInput(st, text, h) {
  const { wait, now, lang, send } = h;
  if (!isAdmin(st.userId)) return false;
  if (wait.kind === 'gitHostName') {
    renameCustomHost(wait.host, text);
    return (await send(hostsView(lang)), true);
  }
  const again = () => renewPendingInput(st, wait, now); // адрес не подошёл — ждём другой
  const candidate = customHost(wait.hostKind, text);
  if (!candidate) return (again(), await say(st.to, t('git.hosts.badUrl', lang), { reply_markup: cancelRow('gt', lang) }), true);
  const probe = await probeHost(candidate);
  if (!probe.ok) {
    again();
    return (await say(st.to, t('git.hosts.probeFail', lang, { url: candidate.web, kind: KIND_LABEL[candidate.kind], msg: probe.error }), { reply_markup: cancelRow('gt', lang) }), true);
  }
  const added = addCustomHost(wait.hostKind, candidate.web);
  if (added.error) return (await send(hostsView(lang, th('git.hosts.exists', lang))), true);
  log('свой сервер git добавлен:', added.host.kind, added.host.web, '| администратор', st.userId);
  return (await send(hostsView(lang, th('git.hosts.added', lang, { label: added.host.label }))), true);
}

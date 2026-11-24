import { db, log, say } from './ctx.mjs';
import { findHost } from './gitAccess.mjs';
import { deviceLogin, DeviceError, startDeviceLogin, waitDeviceLogin } from './gitDevice.mjs';
import { fetchProfile, HostError, missingScopes } from './gitHosts.mjs';
import { errText, t } from './i18n.mjs';
import { clearPendingInput, setPendingInput } from './pendingInput.mjs';
import { cancelRow, dropMessage, fmtDate } from './uiActions.mjs';
import { dest, tg } from './telegram.mjs';
import { hCode, th } from './ui.mjs';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

/** Сохраняет подключённый аккаунт и сообщает об этом: кто подключён, срок токена, чего не хватает; затем — экран /git. */
async function finishConnect(st, host, grant, profile, lang, send, key, view) {
  // вход по коду с токеном, который истекает и не обновляется, через пару часов перестал бы работать — не подключаем
  if (grant.expiresIn && !grant.refreshToken) {
    log('⚠️ git: вход по коду без токена обновления — аккаунт не подключён:', st.userId, host.id, `| срок ${grant.expiresIn} с`);
    return send({ text: th('git.dv.noRefresh', lang, { host: host.label }) });
  }
  const accessUntil = grant.expiresIn ? new Date(Date.now() + grant.expiresIn * 1000).toISOString() : null;
  // срок, который сервис сообщает о продлеваемом входе, — это срок текущего токена, а не аккаунта: напоминать о нём незачем
  const expiresAt = grant.refreshToken ? null : profile.expiresAt;
  if (!db.saveGitAccount(st.userId, { host: host.id, login: profile.login, name: profile.name, email: profile.email, token: grant.token, expiresAt, refreshToken: grant.refreshToken ?? null, accessUntil })) {
    return send({ text: th('access.saveFail', lang) });
  }
  log('аккаунт git подключён:', st.userId, host.id, profile.login, grant.refreshToken ? `| вход обновляемый, срок токена ${grant.expiresIn} с` : '');
  const lack = missingScopes(host, profile.scopes);
  const parts = [
    th(key, lang, { host: host.label, login: profile.login, name: profile.name }),
    ...(expiresAt ? [th('git.expires', lang, { date: fmtDate(expiresAt, lang) })] : []),
    ...(lack.length ? [th('git.scopesWarn', lang, { scopes: lack.join(', ') })] : []),
  ];
  await send({ text: parts.join('\n') });
  return send(await view(st, lang));
}

/**
 * Вход по ссылке и коду: бот показывает страницу сервиса и код, а сам ждёт подтверждения и подключает аккаунт.
 * Ожидание идёт в фоне (до срока кода); «Отмена» или новый вход прекращают его.
 */
async function startCodeLogin(st, host, cfg, lang, edit, view) {
  let login;
  try {
    login = await startDeviceLogin(cfg);
  } catch (e) {
    log('git: вход по коду:', e.message, '| пользователь', st.userId);
    return edit({ text: th('git.dv.fail', lang, { msg: errText(e, lang) }) });
  }
  const attempt = { host: host.id };
  st.gitDevice = attempt; // новый вход или «Отмена» заменяют запись — прежнее ожидание это видит и прекращается
  await edit({
    text: th('git.dv.how', lang, { host: host.label, url: login.url, code: hCode(login.userCode), min: Math.round(login.expiresIn / 60) }),
    markup: { inline_keyboard: [[{ text: t('git.dv.open', lang, { host: host.label }), url: login.url }], [{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] },
  });
  const send = (v) => tg('sendMessage', { ...dest(st.to), text: v.text, ...HTML, reply_markup: v.markup ?? { inline_keyboard: [] } }).catch((e) => log('git:', e.message));
  // не ждём здесь: обработка нажатия заканчивается сразу, подтверждение придёт позже
  waitDeviceLogin(cfg, login, { cancelled: () => st.gitDevice !== attempt })
    .then(async (grant) => {
      st.gitDevice = null;
      const profile = await fetchProfile(host, grant.token);
      await edit({ text: th('git.dv.ok', lang, { host: host.label }) });
      await finishConnect(st, host, grant, profile, lang, send, 'git.connectedCode', view);
    })
    .catch((e) => {
      if (st.gitDevice === attempt) st.gitDevice = null;
      if (e instanceof DeviceError && e.code === 'cancelled') return null;
      log('git: вход по коду:', e.code ?? '', e.message, '| пользователь', st.userId);
      const key = e instanceof DeviceError && e.code === 'expired' ? 'git.dv.expired' : e instanceof DeviceError && e.code === 'denied' ? 'git.dv.denied' : 'git.dv.fail';
      return edit({ text: th(key, lang, { msg: errText(e, lang) }) });
    });
}

export async function onAccountCallback(st, h) {
  const { action, host, account, lang, ack, edit, view } = h;
  if (action === 'c' && host) {
    await ack();
    setPendingInput(st, 'gitToken', { host: host.id });
    // у сервиса с входом по коду токен не обязателен: кнопка «Войти без токена» (сам токен тоже можно прислать)
    const byCode = deviceLogin(host);
    const text = th('git.tokenAsk', lang, { host: host.label, url: host.tokenUrl, scopes: hCode(host.scopes) }) + (byCode ? `\n\n${th('git.dv.or', lang)}` : '');
    const rows = [...(byCode ? [[{ text: t('git.dv.btn', lang), callback_data: `gt:dv:${host.id}`, style: 'success' }]] : []), [{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]];
    return say(st.to, text, { ...HTML, reply_markup: { inline_keyboard: rows } });
  }
  if (action === 'dv' && host) {
    const cfg = deviceLogin(host);
    if (!cfg) return ack(t('proj.stale', lang));
    await ack();
    clearPendingInput(st); // токен больше не ждём: вход идёт по коду
    return startCodeLogin(st, host, cfg, lang, edit, view);
  }
  if ((action === 'a' || action === 'd') && account) {
    await ack();
    const text = th(action === 'd' ? 'git.disconnectAsk' : 'git.accCard', lang, { host: host.label, login: account.login, name: account.name ?? '', email: hCode(account.email ?? '—'), date: fmtDate(account.expires_at, lang) });
    const rows = action === 'd'
      ? [[{ text: t('git.disconnect', lang), callback_data: `gt:D:${host.id}` }, { text: t('btn.cancel', lang), callback_data: `gt:a:${host.id}` }]]
      : [[{ text: t('git.disconnect', lang), callback_data: `gt:d:${host.id}` }], [{ text: t('btn.back', lang), callback_data: 'gt:v' }]];
    return edit({ text, markup: { inline_keyboard: rows } });
  }
  if (action === 'D' && account) {
    db.deleteGitAccount(st.userId, host.id);
    log('аккаунт git отключён:', st.userId, host.id);
    await ack(t('git.disconnected', lang, { host: host.label }));
    return edit(await view(st, lang));
  }
  return ack(t('proj.stale', lang));
}

export async function onTokenInput(st, text, h) {
  const { wait, expired, lang, messageId, send, view } = h;
  await dropMessage(st, messageId, 'git: сообщение не удалено:');
  const host = findHost(wait.host);
  if (expired || !host) {
    clearPendingInput(st);
    return (await say(st.to, t('git.tokenExpired', lang)), true);
  }
  const token = text.trim();
  if (/\s/.test(token) || token.length < 10) return (await say(st.to, t('git.tokenBad', lang), { reply_markup: cancelRow('gt', lang) }), true);
  let profile;
  try {
    profile = await fetchProfile(host, token);
  } catch (e) {
    log('git: проверка токена:', e.message, '| пользователь', st.userId);
    const textFail = e instanceof HostError && ['auth', 'forbidden'].includes(e.code) ? t('git.tokenBad', lang) : t('git.tokenFail', lang, { msg: e.message });
    return (await say(st.to, textFail, { reply_markup: cancelRow('gt', lang) }), true); // ожидание остаётся: можно прислать ещё раз
  }
  clearPendingInput(st);
  await finishConnect(st, host, { token }, profile, lang, send, 'git.connected', view);
  return true;
}

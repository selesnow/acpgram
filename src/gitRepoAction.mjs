import { log, say } from './ctx.mjs';
import { canManageFiles } from './filesUi.mjs';
import { commitAll, pullRepo, pushRepo, repoState, unpushedSecrets } from './git.mjs';
import { GIT_BUSY, failText, gitNetOpts, gitOpts, projectOf, repoOf, withGitLock } from './gitCtx.mjs';
import { t } from './i18n.mjs';
import { clearPendingInput, setPendingInput } from './pendingInput.mjs';
import { errorRootOf } from './state.mjs';
import { dest, tg } from './telegram.mjs';
import { th } from './ui.mjs';
import { cbCtx, fmtDate } from './uiActions.mjs';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

/**
 * Операция с репозиторием проекта: 'pull', 'push', 'pushf' (отправить, несмотря на секреты в коммитах) или 'save'
 * (закоммитить всё с описанием message и отправить). Итог пишется в сообщение edit вместе с обновлённым экраном.
 */
async function repoAction(st, action, lang, edit, { message = null, view } = {}) {
  const project = projectOf(st);
  const done = async (text) => {
    const v = await view(st, lang);
    return edit({ text: `${text}\n\n${v.text}`, markup: v.markup });
  };
  const result = await withGitLock(st, async () => {
    try {
      const repo = project ? await repoOf(st, project) : null;
      if (!repo?.account) return edit(await view(st, lang));
      const opts = gitOpts(st, project, repo.account);
      const net = gitNetOpts(st, project, repo);
      if (action === 'pull') {
        await edit({ text: th('git.pulling', lang) });
        const result = await pullRepo(project, net);
        log('git: получено:', st.userId, project, '|', result);
        return await done(th(`git.pull.${result}`, lang));
      }
      let note = '';
      if (action === 'save') {
        await edit({ text: th('git.saving', lang) });
        const r = await commitAll(project, message, opts);
        if (r.skipped.length) note += `\n${th('git.skipped', lang, { files: r.skipped.join(', ') })}`;
        if (r.tracked.length) note += `\n${th('git.tracked', lang, { files: r.tracked.join(', ') })}`;
        if (r.ignoreWarning) note += `\n${th('git.ignoreLink', lang)}`;
        const after = await repoState(project, opts);
        if (!r.committed && !after?.ahead && after?.upstream) return await done(th('git.savedNothing', lang) + note);
      } else await edit({ text: th('git.pushing', lang) });
      // секреты в коммитах, которые сделал агент: перед отправкой — предупреждение и явное согласие
      if (action !== 'pushf') {
        const secrets = await unpushedSecrets(project, opts);
        if (secrets.length) {
          const markup = { inline_keyboard: [[{ text: t('git.pushAnyway', lang), callback_data: 'gt:pushf' }, { text: t('btn.cancel', lang), callback_data: 'gt:v' }]] };
          return await edit({ text: th('git.secretsWarn', lang, { files: secrets.slice(0, 20).join('\n') }) + note, markup });
        }
      }
      const state = await repoState(project, opts);
      if (state?.upstream && !state.ahead) return await done(th('git.nothingToPush', lang) + note);
      try {
        await pushRepo(project, net);
      } catch (e) {
        if (/rejected|non-fast-forward|fetch first/i.test(`${e.message} ${e.stderr ?? ''}`)) return await done(th('git.pushRejected', lang) + note);
        throw e;
      }
      log('git: отправлено:', st.userId, project);
      return await done(th(action === 'save' ? 'git.saved' : 'git.pushed', lang) + note);
    } catch (e) {
      log(`git: ${action}:`, e.message, '| пользователь', st.userId);
      return await done(failText(e, lang, null, errorRootOf(st.userId)));
    }
  }, project ?? st.userId);
  return result === GIT_BUSY ? edit({ text: t('git.busy', lang) }) : result;
}

export async function onRepoActionCallback(st, h) {
  const { action, lang, ack, edit, view } = h;
  if (!canManageFiles(st.userId)) return ack(t('files.noRights', lang));
  if (st.gitBusy) return ack(t('git.busy', lang));
  if (st.busy) return ack(t('git.agentBusy', lang));
  await ack();
  if (action === 'save') {
    setPendingInput(st, 'gitMessage');
    const markup = { inline_keyboard: [[{ text: t('git.noMessage', lang), callback_data: 'gt:savenow' }], [{ text: t('btn.cancel', lang), callback_data: 'gt:x' }]] };
    return say(st.to, t('git.messageAsk', lang), { reply_markup: markup });
  }
  if (action === 'savenow') {
    clearPendingInput(st);
    return repoAction(st, 'save', lang, edit, { message: t('git.autoMessage', lang, { date: fmtDate(new Date().toISOString(), lang) }), view });
  }
  return repoAction(st, action, lang, edit, { view });
}

export async function onMessageInput(st, text, h) {
  const { lang, send, view } = h;
  const message = [...text.trim().split(/\r?\n/)[0]].slice(0, 200).join('') || t('git.autoMessage', lang, { date: fmtDate(new Date().toISOString(), lang) });
  if (st.gitBusy || st.busy) return (await say(st.to, t(st.busy ? 'git.agentBusy' : 'git.busy', lang)), true);
  const progress = await tg('sendMessage', { ...dest(st.to), text: th('git.saving', lang), ...HTML }).catch(() => null);
  const edit = progress
    ? cbCtx(st, { message: { chat: { id: st.chatId }, message_id: progress.message_id } }, {
      html: true,
      notModified: 'loose',
      label: 'git:',
      fallback: (text, markup, view) => send(view ?? { text, markup }),
    }).edit
    : send;
  await repoAction(st, 'save', lang, edit, { message, view });
  return true;
}

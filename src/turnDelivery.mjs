import { placeAsks } from './asks.mjs';
import { db, dbg, log, say } from './ctx.mjs';
import { FILE_PLACEHOLDER, attachFiles, outboxDir } from './files.mjs';
import { offerGitActions } from './gitUi.mjs';
import { errText, t } from './i18n.mjs';
import { errorRootOf, topicProject, userPath } from './state.mjs';
import { mediaIdsOf, sendFile, sendRich } from './telegram.mjs';
import { renameTopic, titleFromRequest, topicName } from './topics.mjs';
import { finalExtras, finalMessages } from './ui.mjs';

async function nameTopic(st, title) {
  if (!title) return;
  const name = topicName(topicProject(st.userId, st.project), title);
  try {
    await renameTopic(st.chatId, st.topic, name);
    db.saveTopic(st.userId, st.topic, { name, named: true });
    log('тема названа', st.userId, st.topic, name);
  } catch (e) {
    log('название темы:', e.message);
  }
}

async function sendLooseFiles(st, files, lang) {
  for (const f of files) {
    try {
      await sendFile(st.to, f.buffer ? { buffer: f.buffer, name: f.name, size: f.size } : f.path, { photo: f.photo, size: f.size, retryTransient: true });
      log('файл отправлен пользователю отдельно', st.userId, f.path);
    } catch (e) {
      log('отправка файла:', e.message);
      await say(st.to, t('file.sendFail', lang, { name: f.name, why: t('file.why.error', lang, { msg: errText(e, lang, errorRootOf(st.userId)) }) }));
    }
  }
}

export async function deliverTurn({ st, to, text, dbText, lang, engine, naming, stopReason, error, usage, agent, startedAt, steps, sent, asked, gitted, titled, answerText, limited, truncated, requestId }) {
  db.finishRequest(requestId, { stopReason, answer: answerText, error, usage: usage ?? {} });
  if (st.suppress) {
    st.suppress = false;
    st.queued = null;
    return false;
  }
  let final = answerText ? sent.text.trim() : sent.paths.length && !limited ? `${t('turn.files', lang)}\n\n${sent.text.trim()}` : t('turn.empty', lang);
  if (stopReason === 'cancelled') final += `\n\n${t('turn.stopped', lang)}`;
  if (truncated) final += `\n\n${t('turn.truncated', lang)}`;
  const placed = limited
    ? { text: final.replace(FILE_PLACEHOLDER, ''), media: {}, extra: [] }
    : attachFiles(final, sent.paths, {
        cwd: agent?.cwd ?? st.project,
        outbox: outboxDir(st.userId),
        failText: (name, reason) => t('file.sendFail', lang, { name, why: t(`file.why.${reason}`, lang) }),
        onSkip: (p, reason) => log(`файл агента не отправлен (${reason}):`, p, '| пользователь', st.userId),
      });
  const extras = limited ? '' : finalExtras({ steps, elapsedMs: Date.now() - startedAt, project: userPath(st.userId, st.project, lang), engine: engine.short, usage, lang });
  const loose = [];
  const body = placeAsks(st, placed.text, limited ? [] : asked.asks);
  for (const msg of finalMessages(body, extras)) {
    dbg(`final u${st.userId} stop=${stopReason}`, msg);
    const left = await sendRich(to, msg, { media: placed.media }).catch((e) => {
      log('sendRich:', e.message);
      return mediaIdsOf(msg).map((id) => placed.media[id]).filter(Boolean);
    });
    loose.push(...left);
  }
  const inAnswer = Object.entries(placed.media).filter(([, f]) => !loose.includes(f)).map(([, f]) => f.name ?? f.path);
  if (inAnswer.length) log('файлы в ответе:', inAnswer.join(', '), '| пользователь', st.userId);
  if (loose.length || placed.extra.length) await sendLooseFiles(st, [...loose, ...placed.extra], lang);
  if (!limited && gitted.actions.length) await offerGitActions(st, gitted.actions).catch((e) => log('git: предложение агента:', e.message));
  if (naming && !limited && stopReason !== 'error') await nameTopic(st, titled.title || titleFromRequest(text || dbText));
  return true;
}

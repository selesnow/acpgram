import { DEFAULT_LANG, t } from './i18n.mjs';
import { escHtml } from './telegram.mjs';
import { defuseTgTags, hBold, th } from './uiShared.mjs';

/**
 * Экран /engine: текущий движок и кнопки выбора (eng:<id>). Текст — HTML.
 * @param {{engines: {id:string,label:string}[], current: string, defaultId: string, unavailable?: string[], needLogin?: string[], lang?: string}} o
 *   engines — доступные движки; unavailable — названия движков, которые не запустились на сервере
 */
export function engineMenu({ engines, current, defaultId, unavailable = [], needLogin = [], lang = DEFAULT_LANG }) {
  const cur = engines.find((e) => e.id === current);
  const text = [
    th('engine.current', lang, { engine: hBold(cur?.label ?? current) }),
    '',
    `<i>${th('engine.pick', lang)}</i>`,
    ...(unavailable.length ? ['', th('engine.unavailable', lang, { list: unavailable.join(', ') })] : []),
    ...(needLogin.length ? ['', th('engine.needLogin', lang, { list: engines.filter((e) => needLogin.includes(e.id)).map((e) => e.label).join(', ') })] : []),
  ].join('\n');
  return {
    text,
    markup: {
      inline_keyboard: engines.map((e) => [
        {
          text: `${e.id === current ? '✓ ' : ''}${e.label}${e.id === defaultId ? t('engine.default', lang) : ''}${needLogin.includes(e.id) ? t('engine.needLoginTag', lang) : ''}`,
          callback_data: `eng:${e.id}`,
          ...(e.id === current ? { style: 'primary' } : {}), // текущий движок выделен цветом
        },
      ]),
    },
  };
}

const button = (text, data) => `<tg-button type="callback_data" data="${data}">${text}</tg-button>`;

/**
 * Экран /start: rich-сообщение с кнопками. Кнопки присылают callback_data ui:<команда>.
 * @param {{level: string, project: string, engine: string, model?: string, isAdmin: boolean, note?: string, lang?: string}} o
 *   level, engine, model — уже переведённые названия (уровень доступа, движок, модель; по умолчанию «Авто»)
 */
export function startView({ level, project, engine, model, isAdmin, note, topics = null, lang = DEFAULT_LANG }) {
  const cmd = (key) => t(`help.${key}`, lang);
  const commands = [
    cmd('help'),
    cmd('project'),
    cmd('files'),
    cmd('git'),
    cmd('engine'),
    cmd('model'),
    cmd('new'),
    cmd('sessions'),
    cmd('stop'),
    cmd('close'),
    ...(topics ? [cmd('topics')] : []),
    cmd('language'),
    cmd('keyboard'),
    ...(isAdmin ? [cmd('users'), cmd('active'), cmd('invite'), cmd('usage')] : []),
  ];
  const row = (items) => `<tg-button-row>${items.join('')}</tg-button-row>`;
  const rows = [
    row([button(t('start.btn.project', lang), 'ui:project'), button(t('start.btn.new', lang), 'ui:new'), button(t('start.btn.sessions', lang), 'ui:sessions')]),
    row([button(t('start.btn.engine', lang), 'ui:engine'), button(t('start.btn.model', lang), 'ui:model'), button(t('start.btn.close', lang), 'ui:close')]),
    // topics: 'on' | 'off' — режим «диалоги» (если у бота включены темы), null — кнопки нет
    row([
      button(t('start.btn.files', lang), 'ui:files'),
      button(t('start.btn.git', lang), 'ui:git'),
      button(t('btn.language', lang), 'ui:language'),
      ...(topics ? [button(t(topics === 'on' ? 'start.btn.topicsOn' : 'start.btn.topicsOff', lang), 'ui:topics')] : []),
    ]),
  ];
  if (isAdmin) rows.push(row([button(t('start.btn.users', lang), 'ui:users'), button(t('start.btn.invite', lang), 'ui:invite'), button(t('start.btn.active', lang), 'ui:active')]));
  return [
    t('start.title', lang),
    t('start.intro', lang, { engine: escHtml(engine) }),
    t('start.info', lang, { engine: escHtml(engine), model: escHtml(model ?? t('auto', lang)), level: escHtml(level), project: defuseTgTags(project) }), // путь — внутри кода
    ...(topics === 'on' ? [t('start.topics', lang)] : []),
    ...rows,
    `<details><summary>${t('start.commands', lang)}</summary>\n\n${commands.map((c) => `- ${c}`).join('\n')}\n\n</details>`,
    ...(note ? [`<footer>${escHtml(note)}</footer>`] : []),
  ].join('\n\n');
}

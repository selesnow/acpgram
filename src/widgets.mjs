// HTML-виджеты Telegram (Bot API 10.4): выбор модели и навигация по сессиям проекта прямо в сообщении.
// Виджет — один HTML-документ с данными внутри: переходы по группам и страницам идут мгновенно, на устройстве,
// без обращения к боту; боту уходит только выбор (TelegramWidget.request, до 64 байт), ответ — до 1024 байт.
// Ограничения Telegram: HTML до 32768 байт и до 4096 байт после zlib (уровень 9); нет ввода с клавиатуры и прокрутки,
// высота до 600 px — поэтому списки листаются страницами. Здесь — только сборка HTML и разбор запросов (чистые функции).
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** Лимиты Telegram на HTML виджета. */
export const WIDGET_MAX_BYTES = 32768;
export const WIDGET_MAX_ZLIB = 4096;
/** Данные запроса виджета — до 64 байт. */
const QUERY_MAX = 64;

/** Размер HTML после сжатия — так же считает сервер Telegram (zlib, уровень 9). */
export const zlibSize = (html) => deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).length;

/** Помещается ли виджет в лимиты Telegram. */
export const widgetFits = (html) => Buffer.byteLength(html, 'utf8') <= WIDGET_MAX_BYTES && zlibSize(html) <= WIDGET_MAX_ZLIB;

/** Короткий ключ длинного идентификатора (модель, сессия), который не помещается в запрос виджета целиком. */
export const shortKey = (id) => `@${createHash('sha256').update(String(id)).digest('hex').slice(0, 12)}`;

/** Что виджет пришлёт боту вместо id: сам id, если помещается в запрос, иначе короткий ключ. */
export const queryRef = (prefix, id) => (Buffer.byteLength(`${prefix}${id}`) <= QUERY_MAX ? String(id) : shortKey(id));

/** Находит элемент по тому, что прислал виджет (id или короткий ключ). */
export const findByRef = (items, ref, idOf = (x) => x.id) => items.find((x) => idOf(x) === ref || (ref.startsWith('@') && shortKey(idOf(x)) === ref)) ?? null;

/** JSON для вставки в <script>: «<» экранируется, чтобы данные не могли закрыть тег. */
const inlineJson = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

// Общие стили: цвета — только из темы чата (переменные Telegram), чтобы виджет выглядел родным в светлой и тёмной теме.
const CSS =
  'body{margin:0;padding:10px 12px}' +
  '.r{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0}' +
  '.c{padding:5px 11px;border:0;border-radius:14px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);font-size:13px}' +
  '.c.on{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}' +
  '.c[disabled]{color:var(--tg-theme-hint-color)}' +
  '.m{display:block;width:100%;margin:4px 0;padding:8px 10px;text-align:left;border:0;border-radius:8px;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color);font-size:14px}' +
  '.m.on{outline:2px solid var(--tg-theme-button-color)}' +
  '.o{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.h{color:var(--tg-theme-hint-color);font-size:13px}' +
  '#msg{min-height:18px}';

// Общая часть скрипта: W — объект Telegram, $ — элемент по id, B — кнопка, S — подпись, P — страницы, Q — запрос боту.
// Запрос уходит синхронно из обработчика нажатия (иначе Telegram его отклонит); ответ бота — JSON {t: текст, s: состояние}.
const JS_COMMON =
  'const W=window.TelegramWidget,$=i=>document.getElementById(i),D=__DATA__,T=D.t;' +
  'const B=(t,c,f,d)=>{const b=document.createElement("button");b.className=c;b.textContent=t;b.onclick=f;if(d)b.disabled=true;return b};' +
  'const S=(t,c)=>{const s=document.createElement("span");s.className=c||"h";s.textContent=t;return s};' +
  'let page=0;' +
  'const P=(n)=>n>1?[B("‹","c",()=>{page--;draw()},page<1),S(page+1+"/"+n),B("›","c",()=>{page++;draw()},page>=n-1)]:[];' +
  'const Q=(q,ok)=>{if(!W)return;$("msg").textContent="…";W.request(q).then(a=>{let r={};try{r=JSON.parse(a.result)||{}}catch{}$("msg").textContent=r.t||"";ok(r);draw()},e=>{$("msg").textContent=T.err+" ("+e.code+")"})};';

const page = (body, script, data) => `<style>${CSS}</style>${body}<div class="h" id="msg"></div><script>${(JS_COMMON + script).replace('__DATA__', () => inlineJson(data))}</script>`;

/** Строк на странице списка: вместе с шапкой, страницами и уровнями рассуждений виджет остаётся ниже 600 px. */
export const MODEL_ROWS = 8;

// Выбор модели: уровни «группы → вендоры → модели» (у движков без групп — сразу модели), сверху «Авто» и недавние.
// Модель в данных: [id, название, бесплатная?, ссылка для запроса (если id длинный)].
const JS_MODELS =
  'const M=D.m,N=' + MODEL_ROWS + ';let cur=D.c,eff=D.e,path=[];' +
  'const st=()=>{try{const s=JSON.parse(W&&W.chatData);if(s){cur=s.m??null;eff=s.e??null}}catch{}};' +
  'const sg=m=>m[0].split("/"),gO=m=>sg(m).length>1?sg(m)[0]:"",sO=m=>sg(m).length>2?sg(m)[1].replace(/^~/,""):"";' +
  'const nm=m=>m[1]||sg(m).pop(),gl=x=>x==="+"?T.free:D.g[x]||x||T.other;' +
  'const mr=(m,p)=>({t:(p||(m[2]?"🆓 ":""))+nm(m),on:m[0]===cur,q:"m:"+(m[3]||m[0])});' +
  'const top=()=>(D.a?[{t:"✨ "+T.auto,on:!cur,q:"m:~"}]:[]).concat(D.r.map(i=>M.find(m=>m[0]===i)).filter(Boolean).map(m=>mr(m,"🕘 ")));' +
  'function rows(){const g=path[0],s=path[1];if(g==null){const gs=[...new Set(M.map(gO))];if(gs.length<2)return top().concat(M.map(m=>mr(m)));' +
  'const r=top(),f=M.filter(m=>m[2]);if(f.length)r.push({t:"🆓 "+T.free,n:f.length,go:["+"]});' +
  'gs.forEach(x=>r.push({t:gl(x),n:M.filter(m=>gO(m)===x).length,go:[x],on:!!cur&&gO([cur])===x}));return r}' +
  'const G=g==="+"?M.filter(m=>m[2]):M.filter(m=>gO(m)===g),ss=[...new Set(G.map(sO))];' +
  'if(s==null&&g!=="+"&&ss.length>1&&G.length>N)return ss.map(x=>({t:x||T.other,n:G.filter(m=>sO(m)===x).length,go:[g,x],on:!!cur&&gO([cur])===g&&sO([cur])===x}));' +
  'return(s==null?G:G.filter(m=>sO(m)===s)).map(m=>mr(m))}' +
  'function draw(){const r=rows(),n=Math.ceil(r.length/N)||1;page=Math.max(0,Math.min(page,n-1));const c=M.find(m=>m[0]===cur);' +
  '$("cur").textContent=T.cur+": "+(cur?c?nm(c):cur:T.auto);' +
  '$("b").replaceChildren(...(path.length?[B("‹ "+T.back,"c",()=>{path=path.slice(0,-1);page=0;draw()}),S(path.map(gl).join(" › "))]:[]));' +
  '$("l").replaceChildren(...r.slice(page*N,page*N+N).map(x=>B(x.t+(x.go?" ("+x.n+") ›":""),"m o"+(x.on?" on":""),()=>x.go?(path=x.go,page=0,draw()):Q(x.q,a=>{if(a.s){cur=a.s.m??null;eff=a.s.e??null}}))));' +
  '$("p").replaceChildren(...P(n));' +
  '$("e").replaceChildren(...(D.f.length?[S("🧠"),B(T.auto,"c"+(eff?"":" on"),()=>Q("e:~",a=>{if(a.s)eff=a.s.e??null})),...D.f.map(x=>B(x[1],"c"+(eff===x[0]?" on":""),()=>Q("e:"+x[0],a=>{if(a.s)eff=a.s.e??null})))]:[]))}' +
  'if(W)W.onEvent("chatDataChanged",()=>{st();draw()});st();draw();';

/**
 * Виджет выбора модели и уровня рассуждений.
 * @param {object} o
 * @param {{id:string, name?:string, short?:string, free?:boolean}[]} o.models разрешённые пользователю модели каталога
 * @param {{id:string, name:string}[]} [o.efforts] уровни рассуждений движка
 * @param {string|null} o.model текущая модель (null — «Авто»); o.effort — текущий уровень рассуждений
 * @param {boolean} [o.auto] доступен ли выбор «Авто» (при ограничении моделей — нет)
 * @param {string[]} [o.recent] недавние модели
 * @param {Record<string,string>} [o.groups] названия групп (id провайдера → название)
 * @param {{cur:string, auto:string, free:string, other:string, back:string, err:string}} o.texts подписи на языке пользователя
 * @param {boolean} [o.names] false — без названий моделей (в списке — конец id): так виджет меньше
 * @returns {string} HTML
 */
export function modelWidget({ models, efforts = [], model = null, effort = null, auto = true, recent = [], groups = {}, texts, names = true }) {
  const m = models.map((x) => {
    const tail = x.id.split('/').pop();
    const label = x.short || x.name || '';
    const ref = queryRef('m:', x.id);
    const row = [x.id, names && label && label !== tail ? label : 0, x.free ? 1 : 0];
    if (ref !== x.id) row.push(ref);
    else while (row.length > 1 && !row.at(-1)) row.pop(); // хвостовые нули не нужны: каждый байт на счету
    return row;
  });
  const data = { c: model, e: effort, a: auto ? 1 : 0, r: recent.filter((id) => models.some((x) => x.id === id)), m, g: groups, f: efforts.map((x) => [x.id, x.name]), t: texts };
  return page('<div id="cur"></div><div class="r" id="b"></div><div id="l"></div><div class="r" id="p"></div><div class="r" id="e"></div>', JS_MODELS, data);
}

/** Сессий на странице: карточка занимает две-три строки. */
export const SESSION_ROWS = 5;

// Сессии проекта: карточки (дата · движок · число запросов, ниже — начало первого запроса), текущая — в рамке.
// Сессия в данных: [ссылка для запроса, подпись, текст первого запроса, текущая?].
const JS_SESSIONS =
  'const L=D.s,N=' + SESSION_ROWS + ';' +
  'function draw(){const n=Math.ceil(L.length/N)||1;page=Math.max(0,Math.min(page,n-1));' +
  '$("l").replaceChildren(...L.slice(page*N,page*N+N).map(x=>{const b=B("","m"+(x[3]?" on":""),()=>Q("s:"+x[0],()=>{}));b.append(S((x[3]?"▶ ":"")+x[1]),document.createElement("br"),S(x[2],"x"));return b}));' +
  '$("p").replaceChildren(...P(n))}draw();';

/**
 * Виджет «сессии проекта»: все сессии пользователя в проекте, по SESSION_ROWS на страницу; нажатие возобновляет сессию.
 * @param {object} o
 * @param {{id:string, label:string, text:string}[]} o.sessions id — сессия ACP, label — «дата · движок · запросов», text — начало первого запроса
 * @param {string|null} [o.current] работающая сейчас сессия
 * @param {string} o.title заголовок («Сессии проекта …»)
 * @param {{err:string}} o.texts подписи
 */
export function sessionsWidget({ sessions, current = null, title, texts }) {
  const s = sessions.map((x) => [queryRef('s:', x.id), x.label, x.text, x.id === current ? 1 : 0]);
  return page(`<div class="h" id="cur"></div><div id="l"></div><div class="r" id="p"></div>`, `$("cur").textContent=D.h;${JS_SESSIONS}`, { h: title, s, t: texts });
}

/**
 * Разбор запроса виджета: {kind: 'model' | 'effort' | 'session', ref} — ref: id, короткий ключ (@…) или «~» («Авто»).
 * null — запрос не от виджетов бота.
 */
export function parseWidgetQuery(data) {
  const m = /^([mes]):(.+)$/s.exec(String(data ?? ''));
  return m ? { kind: { m: 'model', e: 'effort', s: 'session' }[m[1]], ref: m[2] } : null;
}

/** Ответ бота виджету: JSON {t: текст для строки состояния, s: новое состояние}, не длиннее 1024 байт. */
export function widgetAnswer(text, state = null) {
  let t = String(text ?? '');
  const make = () => JSON.stringify(state ? { t, s: state } : { t });
  while (Buffer.byteLength(make()) > 1024 && t.length) t = t.slice(0, -10);
  return make();
}

// Минимальный клиент Agent Client Protocol (JSON-RPC 2.0, построчный JSON по stdin/stdout)
// для запуска ACP-агента (Gemini CLI, Claude Code, Antigravity CLI) как подпроцесса. Движки — в engines.mjs.
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

const IS_WIN = process.platform === 'win32';

/** Запуск команды с учётом ОС. На Windows .cmd запускается только через оболочку. */
export function spawnCommand(command, args, opts = {}) {
  if (IS_WIN) {
    const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
    return spawn([command, ...args].map(q).join(' '), { ...opts, shell: true, windowsHide: true });
  }
  // своя группа процессов, чтобы при остановке завершить и всех потомков
  return spawn(command, args, { ...opts, detached: true });
}

// При остановке бота процессы агентов завершаются синхронно: бот сразу выходит, и асинхронный taskkill мог не успеть.
let syncKill = false;
/** Включает синхронное завершение процессов (вызывается перед остановкой бота). */
export const setSyncKill = (on = true) => {
  syncKill = on;
};

/**
 * Завершает процесс вместе со всеми дочерними. На Windows — taskkill /T; обычно асинхронно: синхронный вызов
 * занимает 0,1–0,5 с, и на это время замирал весь бот (закрытие сессии, простой, /close).
 */
export function killTree(proc, graceMs = 3000) {
  if (!proc?.pid) return;
  if (IS_WIN) {
    const args = ['/pid', String(proc.pid), '/T', '/F'];
    if (syncKill) spawnSync('taskkill', args, { windowsHide: true });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', (e) => console.error('[acp] taskkill:', e.message));
    return;
  }
  const signal = (sig) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {} // группа уже завершилась
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), graceMs).unref();
}

/**
 * Проверяет, что команда агента запускается: `<команда> --version`.
 * @returns {Promise<{ok: boolean, version?: string, error?: string, timeout?: boolean}>}
 */
export function checkCommand(command, args = ['--version'], timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let proc;
    try {
      proc = spawnCommand(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const timer = setTimeout(() => {
      killTree(proc, 0);
      resolve({ ok: false, timeout: true, error: `нет ответа за ${timeoutMs / 1000} с` });
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    // 'close', а не 'exit': к 'exit' вывод процесса может быть ещё не дочитан — версия оказалась бы пустой
    // (и проверка минимальной версии движка пропустила бы старый), так изредка случалось на Linux
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false, error: (err || out).trim().split(/\r?\n/).slice(-3).join(' | ') || `код ${code}` });
    });
  });
}

/**
 * Фильтр служебного вывода агента в stderr: строки по line (RegExp) и многострочные блоки block {start, end} —
 * от строки, где совпал start, до строки, где совпал end (включительно; не дольше 60 строк — на случай, если конца нет).
 * Возвращает функцию line → true, если строку в лог не писать.
 */
export function quietStderrFilter(line = null, block = null) {
  let inBlock = 0;
  return (l) => {
    if (inBlock) {
      inBlock = block.end.test(l) || inBlock >= 60 ? 0 : inBlock + 1;
      return true;
    }
    if (block?.start.test(l)) {
      inBlock = 1;
      return true;
    }
    return Boolean(line?.test(l));
  };
}

export class AcpAgent {
  /**
   * @param {object} o
   * @param {string} o.cwd             рабочая папка агента
   * @param {string} o.command         команда запуска агента
   * @param {string[]} [o.args]         аргументы режима ACP
   * @param {string} [o.name]           название агента для логов
   * @param {(p:object)=>Promise<object>} [o.onPermission]  обработчик session/request_permission, возвращает outcome
   * @param {(u:object)=>void} [o.onUpdate]                 обработчик session/update
   * @param {(code:number|null)=>void} [o.onExit]
   */
  constructor({ cwd, command, args = [], name = command, quietStderr = null, quietStderrBlock = null, onPermission, onUpdate, onExit }) {
    this.quietStderr = quietStderr; // RegExp служебных строк stderr, которые не пишем в лог бота
    this.quietStderrBlock = quietStderrBlock; // {start, end}: многострочный служебный блок stderr (трассировка), пропускается целиком
    this.cwd = cwd;
    this.name = name;
    this.command = command;
    this.args = args;
    this.onPermission = onPermission;
    this.onUpdate = onUpdate;
    this.onExit = onExit;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.proc = null;
    this.closed = false;
    this.caps = {}; // agentCapabilities из ответа initialize
  }

  start() {
    this.proc = spawnCommand(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => this.#onLine(l));
    const skip = quietStderrFilter(this.quietStderr, this.quietStderrBlock);
    readline.createInterface({ input: this.proc.stderr }).on('line', (l) => {
      if (!skip(l)) console.error(`[${this.name}:stderr]`, l);
    });
    // запись в уже завершившийся процесс (EPIPE) не должна ронять бота
    this.proc.stdin.on('error', (e) => console.error('[acp] stdin:', e.message));
    // команда не найдена и т.п.: без обработчика 'error' Node уронит весь бот, а 'exit' может не прийти
    this.proc.on('error', (e) => this.#finish(null, `не удалось запустить ${this.command}: ${e.message}`));
    this.proc.on('exit', (code) => this.#finish(code, `${this.name} завершился (код ${code})`));
  }

  #finished = false;
  #finish(code, reason) {
    if (this.#finished) return;
    this.#finished = true;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    this.onExit?.(code);
  }

  /**
   * @param {string} [mode] режим сессии ACP (у каждого движка свои, см. engines.mjs); если не задан — режим агента по умолчанию
   * @param {{resume?: string, timeoutMs?: number}} [opts] resume — id ранее созданной сессии ACP, которую нужно загрузить
   *   вместо новой; timeoutMs — сколько ждать запуска (агент мог зависнуть, например, на входе в аккаунт): по истечении
   *   процесс завершается, а ошибка получает code = 'START_TIMEOUT'. 0 — без ограничения.
   */
  async init(mode, { resume, timeoutMs = 0 } = {}) {
    if (!timeoutMs) return this.#init(mode, { resume });
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${this.name}: нет ответа за ${Math.round(timeoutMs / 1000)} с`), { code: 'START_TIMEOUT' })), timeoutMs);
    });
    try {
      return await Promise.race([this.#init(mode, { resume }), limit]);
    } catch (e) {
      if (e.code === 'START_TIMEOUT') this.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async #init(mode, { resume } = {}) {
    this.start();
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this.caps = init?.agentCapabilities ?? {}; // что принимает агент (promptCapabilities.image и др.)
    // При загрузке агент «проигрывает» историю диалога уведомлениями session/update до ответа на запрос
    const res = resume
      ? await this.request('session/load', { sessionId: resume, cwd: this.cwd, mcpServers: [] })
      : await this.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.sessionId = resume || res.sessionId;
    // Часть «проигрываемой» истории приходит уже после ответа на session/load — ждём затишья,
    // иначе старый текст попадёт в начало первого нового ответа
    if (resume) await this.#settle();
    this.mode = res?.modes?.currentModeId ?? null;
    if (mode && mode !== this.mode) {
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId: mode });
      this.mode = mode;
    }
    return res;
  }

  /** @param {string | object[]} input текст или готовые блоки содержимого ACP (text, image, ...) */
  prompt(input) {
    return this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: typeof input === 'string' ? [{ type: 'text', text: input }] : input,
    });
  }

  cancel() {
    if (this.sessionId) this.#write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
  }

  request(method, params) {
    // процесс уже закрыт или завершился: ответа не будет, иначе промис повиснет навсегда
    if (this.closed) return Promise.reject(new Error(`${this.name}: процесс агента уже завершён`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  close() {
    if (this.closed || !this.proc) return;
    this.closed = true;
    // завершаем всё дерево процессов (оболочка -> node -> агент)
    killTree(this.proc);
  }

  /** Ждёт, пока агент перестанет присылать session/update (не дольше maxMs). */
  async #settle(quietMs = 1000, maxMs = 8000) {
    const start = Date.now();
    this.lastUpdateAt = Date.now();
    while (!this.closed && Date.now() - this.lastUpdateAt < quietMs && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  #write(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  async #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // не JSON-RPC (например, служебный вывод) — игнорируем
    }
    // ответ на наш запрос
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`ACP ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    // запрос от агента
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'session/request_permission' && this.onPermission) {
        let outcome;
        try {
          outcome = await this.onPermission(msg.params);
        } catch {
          outcome = { outcome: 'cancelled' };
        }
        this.#write({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
      } else {
        this.#write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported' } });
      }
      return;
    }
    // уведомление
    if (msg.method === 'session/update') {
      this.lastUpdateAt = Date.now();
      try {
        this.onUpdate?.(msg.params.update);
      } catch (e) {
        console.error('[acp] ошибка в обработчике обновления:', e.message); // не роняем бота
      }
    }
  }
}

// Диалог в терминале для мастера настройки и установки службы: вопросы, да/нет и скрытый ввод секретов.
import { stdin, stdout } from 'node:process';
import readline from 'node:readline/promises';

/**
 * Секрет из терминала в raw-режиме: символы не отображаются (вместо них «*»), Backspace стирает, Ctrl+C прерывает.
 * Не через readline — у readline/promises нет способа скрыть эхо, а ещё он сохранил бы секрет в истории.
 */
function readSecretRaw(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          process.exit(130); // Ctrl+C
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = [...value].slice(0, -1).join('');
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue; // прочие управляющие символы (стрелки и т.п.) не принимаем
        value += ch;
        stdout.write('*');
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const finish = () => {
      cleanup();
      stdout.write('\n');
      resolve(value.trim());
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/**
 * Диалог. readline создаётся на каждый обычный вопрос и закрывается перед вводом секрета —
 * так секрет не попадает ни в эхо, ни в историю.
 */
export function prompter() {
  let rl = null;
  const open = () => (rl ??= readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY), historySize: 0 }));
  const closeRl = () => {
    rl?.close();
    rl = null;
  };
  return {
    ask: async (q, def) => ((await open().question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def || ''),
    /** Секрет: в терминале ввод скрыт; без терминала (ответы подаются конвейером) — обычное чтение строки. */
    secret: async (q) => {
      if (!stdin.isTTY) return (await open().question(`${q}: `)).trim();
      closeRl();
      return readSecretRaw(`${q}: `);
    },
    yes: async (q, def = true) => {
      const a = (await open().question(`${q} [${def ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      return a ? ['y', 'yes', 'д', 'да'].includes(a) : def;
    },
    close: closeRl,
  };
}

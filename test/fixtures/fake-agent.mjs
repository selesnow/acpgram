// Фиктивный ACP-агент для тестов: отвечает на initialize / session/new / session/prompt
// и запускает долгоживущий дочерний процесс, чтобы проверить завершение всего дерева процессов.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
process.stderr.write('fake-agent started\n');
console.log('не JSON: служебный вывод должен игнорироваться');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    case 'session/new':
      return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: { currentModeId: 'default' } } });
    case 'session/set_mode':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/prompt':
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `pids ${process.pid} ${child.pid}` } } },
      });
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
  }
});

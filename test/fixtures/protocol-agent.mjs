import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const scenario = process.env.FAKE_PROTOCOL ?? '';
const logPath = process.env.FAKE_LOG;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (msg) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), msg })}\n`);
};

let pendingPromptId = null;

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log(msg);

  if (msg.id !== undefined && !msg.method && pendingPromptId !== null && (msg.id === 9001 || msg.id === 9002)) {
    const promptId = pendingPromptId;
    pendingPromptId = null;
    return send({
      jsonrpc: '2.0',
      id: promptId,
      result: { stopReason: 'end_turn', outcome: msg.result?.outcome ?? null, botError: msg.error ?? null },
    });
  }

  switch (msg.method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    case 'session/new':
      return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: { currentModeId: 'default' } } });
    case 'session/load': {
      const update = (text) => ({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      });
      send(update('старая история'));
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId, modes: { currentModeId: 'default' } } });
      setTimeout(() => send(update('конец истории')), 20);
      return;
    }
    case 'session/set_mode':
      return send({ jsonrpc: '2.0', id: msg.id, result: {} });
    case 'session/prompt':
      pendingPromptId = msg.id;
      if (scenario === 'permission') {
        return send({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { title: 'Разрешить?', options: [{ optionId: 'allow', name: 'Allow' }] } });
      }
      if (scenario === 'unknown_method') {
        return send({ jsonrpc: '2.0', id: 9002, method: 'custom/ask', params: { question: '?' } });
      }
      if (scenario === 'prompt_error') {
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -42, message: 'boom' } });
      }
      if (scenario === 'update_throw') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'событие' } } },
        });
      }
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
  }
});

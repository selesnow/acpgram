import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const scenario = process.env.FAKE_PROBE ?? '';
const logPath = process.env.FAKE_PROBE_LOG;
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (msg) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(msg)}\n`);
};

if (process.argv.includes('meta')) {
  if (scenario === 'meta_fail') {
    process.stderr.write('models failed\n');
    process.exit(7);
  }
  process.stdout.write([
    'opencode/zen',
    '{"cost":{"input":0,"output":0},"capabilities":{"toolcall":true}}',
    'opencode/image',
    '{"cost":{"input":0,"output":0},"capabilities":{"toolcall":false}}',
  ].join('\n') + '\n');
  process.exit(0);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log(msg);
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  }
  if (msg.method === 'session/new') {
    if (scenario === 'hang') return;
    if (scenario === 'auth') {
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: '401 unauthorized' } });
    }
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId: 's1',
      modes: { currentModeId: 'default' },
      configOptions: [
        { id: 'model', currentValue: 'opencode/zen', options: [{ value: 'opencode/zen', name: 'Zen' }, { value: 'opencode/image', name: 'Image' }] },
      ],
    } });
  }
  if (msg.method === 'session/set_mode') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
});

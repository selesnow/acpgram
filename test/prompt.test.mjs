import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = (name) => pathToFileURL(join(root, 'src', name)).href;

function run(code, input = '', expectedStatus = 0) {
  const home = mkdtempSync(join(tmpdir(), 'acpgram-prompt-'));
  const resultFile = join(home, 'result.json');
  const script = `
    import { writeFileSync } from 'node:fs';
    const resultFile = ${JSON.stringify(resultFile)};
    ${code}
  `;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { ...process.env, ACPGRAM_LANG: 'en' },
      timeout: 10_000,
    });
    assert.equal(r.status, expectedStatus, r.stderr);
    return {
      result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null,
      stdout: r.stdout,
    };
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('prompter: ask/yes/secret читают ответы из потока и применяют значения по умолчанию', () => {
  const { result } = run(`
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    const { prompter } = await import(${JSON.stringify(target('prompt.mjs'))});
    const p = prompter();
    const q1 = p.ask('Name', 'Alex');
    input.write('  \\n');
    const name = await q1;
    const q2 = p.yes('Ok', true);
    input.write('N\\n');
    const ok = await q2;
    const q3 = p.secret('Code');
    input.write('  secret  \\n');
    const code = await q3;
    input.end();
    p.close();
    writeFileSync(resultFile, JSON.stringify({ name, ok, code }));
  `);
  assert.deepEqual(result, { name: 'Alex', ok: false, code: 'secret' });
});

test('prompter: закрытый ввод завершается ошибкой, а не зависанием', () => {
  const { result } = run(`
    const { prompter } = await import(${JSON.stringify(target('prompt.mjs'))});
    const p = prompter();
    try {
      await p.ask('Name');
      writeFileSync(resultFile, JSON.stringify({ message: null }));
    } catch (e) {
      writeFileSync(resultFile, JSON.stringify({ message: e.message }));
    }
  `);
  assert.ok(result.message.length > 0);
});

test('prompter: скрытый ввод в терминале прячет символы и стирает Backspace', () => {
  const { result } = run(`
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const raw = [];
    process.stdin.setRawMode = (v) => raw.push(v);
    const chunks = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    const { prompter } = await import(${JSON.stringify(target('prompt.mjs'))});
    const p = prompter();
    const value = await p.secret('Code');
    process.stdout.write = write;
    writeFileSync(resultFile, JSON.stringify({ value, out: chunks.join(''), raw }));
  `, 'ab\u0001c\u007fd\n');
  assert.deepEqual(result, { value: 'abd', out: 'Code: ***\b \b*\n', raw: [true, false] });
});

test('prompter: Ctrl+C при скрытом вводе прерывает процесс с кодом 130', () => {
  const { stdout } = run(`
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    process.stdin.setRawMode = () => {};
    const { prompter } = await import(${JSON.stringify(target('prompt.mjs'))});
    const p = prompter();
    p.secret('Code').catch(() => {});
    setTimeout(() => process.stdin.emit('data', Buffer.from('\u0003')), 20);
  `, '', 130);
  assert.equal(stdout, 'Code: \n');
});

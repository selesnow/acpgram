import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { setCliLang, tc } from '../src/cli-i18n.mjs';
import { applyNssmCommands } from '../src/service.mjs';
import { diagnoseCreate } from '../src/winsvc.mjs';

setCliLang('ru');

const SERVICE_FILE = fileURLToPath(new URL('../src/service.mjs', import.meta.url));
const SERVICE_URL = new URL('../src/service.mjs', import.meta.url).href;
const tempDirs = [];
after(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));

const SPAWN_MOCK = String.raw`
import { appendFileSync } from 'node:fs';
const rules = JSON.parse(process.env.FAKE_CMDS || '[]');
export function spawnSync(cmd, args, opts) {
  const base = String(cmd).split(/[\\/]/).pop().toLowerCase();
  const first = String(args?.[0] ?? '');
  let key = base + ' ' + first;
  if (base === 'reg' && args?.some((a) => String(a) === 'DeleteFlag')) key = 'reg delete';
  else if (base === 'reg' && args?.some((a) => String(a).includes('OEMCP'))) key = 'reg oem';
  appendFileSync(process.env.FAKE_OUT, key + ' ' + JSON.stringify(args ?? []) + '\n');
  const rule = rules.find((r) => r.key === key && (r.n == null || (r.used || 0) < r.n));
  if (!rule) return { status: 0, stdout: '', stderr: '' };
  rule.used = (rule.used || 0) + 1;
  if (rule.error) {
    const e = new Error(rule.error);
    e.code = rule.code;
    return { status: null, error: e, stdout: '', stderr: '' };
  }
  return { status: rule.status ?? 0, stdout: rule.stdout ?? '', stderr: rule.stderr ?? '' };
}
`;

const harness = ({ platform = 'win32', rules = [] } = {}) => {
  const tmp = mkdtempSync(join(tmpdir(), 'acpgram-service-'));
  tempDirs.push(tmp);
  const bin = join(tmp, 'bin');
  const home = join(tmp, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, 'nssm.exe'), '');
  const loader = join(tmp, 'loader.mjs');
  writeFileSync(loader, String.raw`
import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') return { url: ${JSON.stringify(pathToFileURL(join(tmp, 'spawn.mjs')).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`);
  writeFileSync(join(tmp, 'spawn.mjs'), SPAWN_MOCK);
  const prelude = join(tmp, 'prelude.mjs');
  writeFileSync(prelude, String.raw`
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
`);
  const out = join(tmp, 'calls.log');
  const env = {
    ...process.env,
    PATH: bin,
    HOME: home,
    USERPROFILE: home,
    ACPGRAM_HOME: home,
    ACPGRAM_LANG: 'ru',
    NSSM_PATH: join(bin, 'nssm.exe'),
    FAKE_OUT: out,
    FAKE_CMDS: JSON.stringify(rules),
  };
  const nodeArgs = ['--no-warnings', '--experimental-loader', pathToFileURL(loader).href, '--import', pathToFileURL(prelude).href];
  return {
    tmp,
    home,
    cli: (...args) => {
      const r = spawnSync(process.execPath, [...nodeArgs, SERVICE_FILE, ...args], { cwd: tmp, encoding: 'utf8', env, timeout: 30_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: existsSync(out) ? readFileSync(out, 'utf8') : '' };
    },
    call: (body) => {
      const script = join(tmp, 'case.mjs');
      writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const S = await import(${JSON.stringify(SERVICE_URL)});
const result = {};
${body}
writeFileSync(process.env.FAKE_RESULT, JSON.stringify(result));
`);
      const resultPath = join(tmp, 'result.json');
      const r = spawnSync(process.execPath, [...nodeArgs, script], { cwd: tmp, encoding: 'utf8', env: { ...env, FAKE_RESULT: resultPath }, timeout: 30_000 });
      assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
      return { result: JSON.parse(readFileSync(resultPath, 'utf8')), calls: existsSync(out) ? readFileSync(out, 'utf8') : '', stdout: r.stdout };
    },
  };
};

const adminRule = { key: 'net session', status: 0 };
const query = (stdout, status = 0, n) => ({ key: 'sc.exe query', stdout, status, ...(n ? { n } : {}) });
const STOPPED = 'STATE : 1 STOPPED';
const RUNNING = 'STATE : 4 RUNNING';
const PENDING = 'STATE : 3 STOP_PENDING';

test('restartService: код 1069 (ошибка входа) не ждёт RUNNING и печатает подсказку', () => {
  const h = harness({
    rules: [
      adminRule,
      query(RUNNING, 0, 2),
      { key: 'nssm.exe set', status: 0 },
      { key: 'nssm.exe stop', status: 0 },
      query(STOPPED),
      { key: 'sc.exe start', status: 1069, stdout: '[SC] StartService FAILED 1069:' },
    ],
  });
  const r = h.cli('restart', '--name', 'svc');
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.ok(r.stdout.includes(tc('svc.logonRefused')), r.stdout);
  assert.match(r.calls, /sc\.exe start \["start","svc"\]/);
  assert.doesNotMatch(r.calls, /nssm.exe status/);
});

test('restartService: код 1056 (уже запущена) ждёт RUNNING через nssm status', () => {
  const h = harness({
    rules: [
      adminRule,
      query(RUNNING, 0, 2),
      { key: 'nssm.exe set', status: 0 },
      { key: 'nssm.exe stop', status: 0 },
      query(STOPPED),
      { key: 'sc.exe start', status: 1056, stdout: '[SC] StartService FAILED 1056:' },
      { key: 'nssm.exe status', stdout: 'SERVICE_RUNNING' },
    ],
  });
  const r = h.cli('restart', '--name', 'svc');
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.ok(r.stdout.includes(tc('svc.restarted', { name: 'svc', log: '' })), r.stdout);
  assert.match(r.calls, /nssm.exe status/);
});

test('restartService: код 1072 предупреждает о службе, помеченной для удаления', () => {
  const h = harness({
    rules: [
      adminRule,
      query(RUNNING, 0, 2),
      { key: 'nssm.exe set', status: 0 },
      { key: 'nssm.exe stop', status: 0 },
      query(STOPPED),
      { key: 'sc.exe start', status: 1072, stdout: '[SC] StartService FAILED 1072:' },
      { key: 'nssm.exe status', stdout: 'SERVICE_STOPPED' },
    ],
  });
  const r = h.cli('restart', '--name', 'svc');
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.ok(r.stdout.includes(tc('svc.marked', { name: 'svc' })), r.stdout);
});

test('restartService: нулевой код запуска, но RUNNING появляется не сразу', () => {
  const h = harness({
    rules: [
      adminRule,
      query(RUNNING, 0, 2),
      { key: 'nssm.exe set', status: 0 },
      { key: 'nssm.exe stop', status: 0 },
      query(STOPPED),
      { key: 'sc.exe start', status: 0 },
      { key: 'nssm.exe status', stdout: 'SERVICE_STOPPED', n: 1 },
      { key: 'nssm.exe status', stdout: 'SERVICE_RUNNING' },
    ],
  });
  const r = h.cli('restart', '--name', 'svc');
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.equal((r.calls.match(/nssm.exe status/g) ?? []).length, 2);
});

test('stopService: зависшую службу добивает через taskkill по PID', () => {
  const h = harness({
    rules: [
      adminRule,
      query(PENDING, 0, 19),
      { key: 'nssm.exe stop', error: 'timed out', code: 'ETIMEDOUT' },
      { key: 'tasklist /svc', stdout: '"svc.exe","4242","N/A"\n' },
      { key: 'taskkill /PID', status: 0 },
      query(STOPPED),
    ],
  });
  const r = h.cli('stop', '--name', 'svc');
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.ok(r.stdout.includes(tc('svc.nssmTimeout', { secs: 0 })), r.stdout);
  assert.ok(r.stdout.includes(tc('svc.killing', { name: 'svc', pid: 4242 })), r.stdout);
  assert.match(r.calls, /taskkill \/PID \["\/PID","4242","\/T","\/F"\]/);
});

test('uninstall: отсутствующая служба считается удалённой и не удаляется повторно', () => {
  const h = harness({ rules: [adminRule, query('[SC] OpenService FAILED 1060:', 1060)] });
  const r = h.cli('uninstall', '--name', 'ghost');
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.doesNotMatch(r.calls, /nssm.exe remove/);
});

test('applyNssmCommands: помеченная служба и занятый ключ дают разные коды диагностики', () => {
  assert.equal(diagnoseCreate({ exists: true, marked: true, keyNameTaken: false, name: 'svc' }).code, 1072);
  assert.equal(diagnoseCreate({ exists: false, marked: false, keyNameTaken: true, name: 'svc' }).code, 1078);

  const diagnosis = (probe, keyNameTaken) => {
    const lines = [];
    const result = applyNssmCommands({
      nssm: 'nssm', name: 'svc', node: 'node',
      commands: () => [['install', 'svc', 'node']],
      run: (_cmd, args) => ({
        status: args[0] === 'install' ? 5 : keyNameTaken ? 0 : 1,
        stderr: args[0] === 'GetKeyName' ? '' : 'create failed',
      }),
      probe,
      marked: () => true,
      log: (s) => lines.push(s),
    });
    return { result, lines };
  };
  const marked = diagnosis(() => ({ exists: true }), false);
  assert.equal(marked.result.done, true);
  assert.ok(marked.lines.some((s) => s.includes(tc('svc.marked', { name: 'svc' }))));
  assert.ok(marked.lines.some((s) => s.includes(tc('svc.createFailed', { text: tc('ws.marked', { name: 'svc' }) }))));

  const taken = diagnosis(() => ({ exists: false }), true);
  assert.equal(taken.result.done, true);
  assert.ok(taken.lines.some((s) => s.includes(tc('ws.keyTaken', { name: 'svc' }))));
});

test('installService на Linux: systemd unit пишется в HOME, systemctl вызывается трижды', () => {
  const h = harness({ platform: 'linux', rules: [{ key: 'systemctl --user', status: 0 }] });
  const { result, calls } = h.call(`
result.installed = await S.installService({ name: 'svc', node: '/usr/bin/node' });
`);
  assert.deepEqual(result.installed, { ok: true });
  assert.equal((calls.match(/systemctl --user/g) ?? []).length, 3);
  const unit = join(h.home, '.config', 'systemd', 'user', 'svc.service');
  assert.ok(existsSync(unit));
  assert.match(readFileSync(unit, 'utf8'), /ExecStart=.*node/);
});

test('installService на macOS: launchd повторяет bootstrap после ошибки выгрузки', () => {
  const h = harness({
    platform: 'darwin',
    rules: [
      { key: 'launchctl bootout', status: 0 },
      { key: 'launchctl bootstrap', status: 1, stderr: 'input/output error', n: 1 },
      { key: 'launchctl bootstrap', status: 0 },
    ],
  });
  const { result, calls } = h.call(`
result.installed = await S.installService({ name: 'svc', node: '/usr/bin/node' });
`);
  assert.deepEqual(result.installed, { ok: true });
  assert.match(calls, /launchctl bootout/);
  assert.equal((calls.match(/launchctl bootstrap/g) ?? []).length, 2);
  const plist = join(h.home, 'Library', 'LaunchAgents', 'io.github.acpgram.plist');
  assert.ok(existsSync(plist));
  assert.match(readFileSync(plist, 'utf8'), /io.github.acpgram/);
});

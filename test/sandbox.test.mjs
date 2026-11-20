// Песочница агента (AGENT_SANDBOX=bwrap). Сборка аргументов и проверки путей — на любой ОС; запуск настоящего
// bubblewrap — только на Linux, где он установлен и разрешён (иначе эти тесты пропускаются; REQUIRE_SANDBOX_TEST=1
// делает пропуск ошибкой — так в CI видно, что они действительно выполнились).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'acpgram-sb-')));
process.env.ACPGRAM_HOME = base; // каталог данных бота — временный
delete process.env.AGENT_SANDBOX;
delete process.env.PROJECTS_ROOT;
delete process.env.SANDBOX_RO_PATHS;

const S = await import('../src/sandbox.mjs');
const { AcpAgent, killTree, spawnCommand } = await import('../src/acp.mjs');

const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));

// «сервер»: корень проектов с двумя личными папками, данные бота и его .env
const root = join(base, 'projects');
const ws1 = join(root, '1001');
const ws2 = join(root, '1002');
const data = join(base, 'data');
const envFile = join(base, '.env');
mkdirSync(join(ws1, 'site'), { recursive: true });
mkdirSync(ws2, { recursive: true });
mkdirSync(data, { recursive: true });
writeFileSync(join(ws2, 'secret2.txt'), 'чужое');
writeFileSync(join(data, 'bot.db'), 'база');
writeFileSync(envFile, 'TELEGRAM_BOT_TOKEN=x');
const secrets = [envFile, data];
const files = [envFile, join(data, 'bot.db')];
/** Песочница сотрудника id в «сервере» теста. */
const boxFor = (id, o = {}) =>
  S.agentSandbox({
    userId: id,
    cwd: join(root, String(id)),
    root: join(root, String(id)),
    command: process.execPath,
    protect: [root],
    home: join(data, 'homes', String(id)),
    uploads: join(data, 'uploads', String(id)),
    outbox: join(data, 'outbox', String(id)),
    secrets,
    extraRo: [],
    ...o,
  });

after(() => rmSync(base, { recursive: true, force: true }));

test('sandboxMode: выключена по умолчанию; неизвестное значение и не Linux — ошибка, а не работа без песочницы', () => {
  for (const off of [undefined, '', '  ', '0', 'off', 'OFF']) assert.equal(S.sandboxMode(off, 'linux'), null, String(off));
  assert.equal(S.sandboxMode('bwrap', 'linux'), 'bwrap');
  assert.equal(S.sandboxMode(' BWRAP ', 'linux'), 'bwrap');
  assert.throws(() => S.sandboxMode('docker', 'linux'), /неизвестное значение/);
  assert.throws(() => S.sandboxMode('1', 'linux'), /неизвестное значение/);
  for (const os of ['win32', 'darwin']) assert.throws(() => S.sandboxMode('bwrap', os), /только на Linux/, os);
  assert.equal(S.SANDBOX, null, 'в тестах песочница выключена');
});

test('bwrapArgs: пустой корень, система и «только чтение» раньше «записи», сеть не отключается', () => {
  const sys = [join(base, 'usr'), join(base, 'etc')];
  const a = S.bwrapArgs({ cwd: join(ws1, 'site'), rw: [ws1, join(data, 'homes', '1001')], ro: [join(data, 'uploads', '1001'), join(base, 'usr', 'lib', 'x'), ws1, null], system: sys });
  const pairs = (flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
  assert.ok(a.includes('--die-with-parent') && a.includes('--unshare-pid'));
  assert.ok(!a.includes('--unshare-net'), 'агенту нужна сеть');
  assert.ok(!a.includes('/') || a[a.indexOf('/') - 1] !== '--bind', 'корень сервера не подключается');
  assert.deepEqual(pairs('--ro-bind-try'), [...sys, join(data, 'uploads', '1001'), ws1], 'папка внутри системной повторно не подключается');
  assert.deepEqual(pairs('--bind'), [ws1, join(data, 'homes', '1001')]);
  assert.ok(a.lastIndexOf('--ro-bind-try') < a.indexOf('--bind'), '«запись» перекрывает «только чтение»');
  assert.ok(a.indexOf('--tmpfs') < a.indexOf('--ro-bind-try'), '/tmp — раньше подключений (папки могут лежать в нём)');
  assert.deepEqual(a.slice(-2), ['--chdir', join(ws1, 'site')]);
});

test('exposedSecret и agentSandbox: папку, внутри которой секреты бота или чужие данные, открыть нельзя', () => {
  assert.equal(S.exposedSecret(base, secrets), envFile, '.env лежит внутри');
  assert.equal(S.exposedSecret(data, secrets), data, 'сам каталог данных');
  assert.equal(S.exposedSecret(join(data, 'homes', '1001'), secrets), null, 'своя папка внутри каталога данных — не утечка');
  assert.equal(S.exposedSecret(ws1, [...secrets, root]), null);
  assert.equal(S.exposedSecret(root, [...secrets, root]), root, 'общий корень при личных пространствах');

  const sb = boxFor(1001);
  assert.equal(sb.command, 'bwrap');
  assert.deepEqual(sb.args.slice(-2), ['--', process.execPath], 'после аргументов bwrap — команда движка полным путём');
  for (const d of ['homes', 'uploads', 'outbox']) assert.ok(existsSync(join(data, d, '1001')), `${d} создан`);
  const rw = sb.args.flatMap((x, i) => (x === '--bind' ? [sb.args[i + 1]] : []));
  assert.deepEqual(rw, [ws1, join(data, 'homes', '1001'), join(data, 'outbox', '1001')]);
  assert.ok(!sb.args.includes(ws2) && !sb.args.includes(root) && !sb.args.includes(data) && !sb.args.includes(envFile));

  assert.throws(() => boxFor(1001, { root, cwd: ws1 }), (e) => e instanceof S.SandboxError, 'весь корень проектов сотруднику с личной папкой');
  assert.throws(() => boxFor(1001, { root: base, cwd: ws1, protect: [] }), /нельзя открыть песочнице/, 'папка с .env бота');
  assert.throws(() => boxFor(1001, { extraRo: [base] }), /нельзя открыть песочнице/, 'SANDBOX_RO_PATHS с секретами');
  assert.throws(() => boxFor(1001, { command: join(base, 'no-such-engine') }), /команда не найдена/);
  // без корня (личная установка) на запись — только папка проекта
  const solo = boxFor(1001, { root: null, cwd: join(ws1, 'site'), protect: [] });
  assert.ok(solo.args.includes(join(ws1, 'site')) && !solo.args.includes(ws1));
});

test('sandboxEnv: своя домашняя папка, без переменных учётной записи бота, Node — в PATH', () => {
  const env = S.sandboxEnv({ PATH: ['/a', '/b'].join(delimiter), HOME: '/home/bot', XDG_CONFIG_HOME: '/home/bot/.config', XDG_RUNTIME_DIR: '/run/user/1', SSH_AUTH_SOCK: '/s', ACPGRAM_HOME: '/x', OPENROUTER_API_KEY: 'k' }, { home: '/h/1', nodeDir: '/node/bin' });
  assert.equal(env.HOME, '/h/1');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.PATH, ['/a', '/b', '/node/bin'].join(delimiter));
  assert.equal(env.OPENROUTER_API_KEY, 'k', 'ключи движка остаются');
  for (const k of ['XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'ACPGRAM_HOME']) assert.equal(k in env, false, k);
  assert.equal(S.sandboxEnv({ PATH: '/node/bin' }, { home: '/h', nodeDir: '/node/bin' }).PATH, '/node/bin', 'без повтора');
});

test('findCommand, commandBinds, pathList', (t) => {
  assert.deepEqual(S.pathList(` /a ${delimiter}${delimiter}/b`), ['/a', '/b']);
  assert.equal(S.findCommand(process.execPath), process.execPath);
  assert.equal(S.findCommand(join(base, 'nope')), null);
  assert.equal(S.findCommand('sub/tool', base), null, 'относительный путь не ищется');
  // npm-пакет: <prefix>/bin/tool -> ../lib/node_modules/pkg/bin/tool
  const prefix = join(base, 'prefix');
  const real = join(prefix, 'lib', 'node_modules', 'pkg', 'bin', 'tool');
  mkdirSync(dirname(real), { recursive: true });
  mkdirSync(join(prefix, 'bin'));
  writeFileSync(real, '#!/bin/sh\n');
  chmodSync(real, 0o755);
  assert.deepEqual(S.commandBinds(real), [dirname(real), join(prefix, 'lib', 'node_modules')]);
  assert.equal(S.findCommand('tool', [join(base, 'none'), dirname(real)].join(delimiter)), real, 'поиск по PATH');
  try {
    symlinkSync(real, join(prefix, 'bin', 'tool'));
  } catch {
    return t.diagnostic('ссылку на файл создать не удалось — проверка ссылки пропущена');
  }
  assert.deepEqual(S.commandBinds(join(prefix, 'bin', 'tool')), [join(prefix, 'bin'), join(prefix, 'lib', 'node_modules')], 'папка ссылки и весь node_modules пакета');
  const plain = join(base, 'opt', 'engine');
  mkdirSync(dirname(plain), { recursive: true });
  writeFileSync(plain, '');
  assert.deepEqual(S.commandBinds(plain), [dirname(plain)], 'обычная программа — её папка');
});

test('createAgent: с обёрткой запускается bwrap, аргументы движка — после его команды, окружение — через обёртку', async () => {
  const E = await import('../src/engines.mjs');
  const wrap = { command: 'bwrap', args: ['--chdir', ws1, '--', '/opt/bin/opencode'], env: (b) => ({ ...b, HOME: '/h/1001' }) };
  const a = E.createAgent(E.ENGINES.opencode, { cwd: ws1, who: { level: 'read' }, wrap });
  assert.equal(a.command, 'bwrap');
  assert.deepEqual(a.args, ['--chdir', ws1, '--', '/opt/bin/opencode', 'acp']);
  assert.equal(a.env.HOME, '/h/1001');
  assert.match(a.env.OPENCODE_CONFIG_CONTENT, /"edit":"deny"/, 'права по уровню доступа передаются и в песочницу');
  assert.equal('TELEGRAM_BOT_TOKEN' in a.env, false, 'токен бота в песочницу не попадает');
  const plain = E.createAgent(E.ENGINES.opencode, { cwd: ws1, who: { level: 'read' } });
  assert.equal(plain.command, E.engineCommand(E.ENGINES.opencode), 'без обёртки — как раньше');
  assert.deepEqual(plain.args, ['acp']);
});

// ---------- настоящий bubblewrap (Linux) ----------

const probe = process.platform === 'linux' ? S.probeSandbox({ base: data, secrets, files }) : { ok: false, error: 'не Linux' };
if (!probe.ok && process.env.REQUIRE_SANDBOX_TEST === '1' && process.platform === 'linux') {
  test('bubblewrap обязателен в этом окружении', () => assert.fail(`песочница не работает: ${probe.error}`));
}
const real = { skip: probe.ok ? false : `bubblewrap недоступен: ${probe.error}` };

/** Выполняет сценарий sh в песочнице сотрудника; возвращает строки вывода. */
function inBox(id, script, o = {}) {
  const sb = boxFor(id, { command: 'sh', ...o });
  const r = spawnSync(sb.command, [...sb.args, '-c', script], { env: sb.env(process.env), encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, `сценарий завершился с кодом ${r.status}: ${r.stderr}`);
  return r.stdout.trim().split('\n');
}

test('песочница: сотрудник пишет в своё пространство и не видит чужое, .env и базу бота', real, () => {
  writeFileSync(join(data, 'uploads', '1001', 'in.txt'), 'загрузка');
  const yes = (cond) => `if ${cond}; then echo yes; else echo no; fi`;
  const out = inBox(
    1001,
    [
      'echo "$PWD"',
      'echo "$HOME"',
      'echo сделано > site/made.txt && echo ok',
      yes(`[ -e "${join(ws2, 'secret2.txt')}" ]`), // чужой файл
      `ls "${root}" | tr '\\n' ' '; echo`, // в корне проектов видна только своя папка
      yes(`[ -e "${envFile}" ]`),
      yes(`[ -e "${join(data, 'bot.db')}" ]`),
      'echo x > "$HOME/note" && cat "$HOME/note"',
      `cat "${join(data, 'uploads', '1001', 'in.txt')}"; echo`,
      yes(`echo x 2>/dev/null > "${join(data, 'uploads', '1001', 'w.txt')}"`), // загрузки — только чтение
      `echo файл > "${join(data, 'outbox', '1001', 'out.txt')}" && echo ok`,
      yes('touch /usr/x 2>/dev/null'), // система — только чтение
      yes('[ "$(ls /proc | grep -c "^[0-9]")" -lt 10 ]'), // процессы сервера не видны
    ].join('\n'),
  );
  assert.deepEqual(out, [ws1, join(data, 'homes', '1001'), 'ok', 'no', '1001 ', 'no', 'no', 'x', 'загрузка', 'no', 'ok', 'no', 'yes']);
  assert.equal(readFileSync(join(ws1, 'site', 'made.txt'), 'utf8').trim(), 'сделано', 'файл появился на сервере в папке сотрудника');
  assert.ok(existsSync(join(data, 'outbox', '1001', 'out.txt')), 'файл для отправки лежит в каталоге исходящих');
  // у другого сотрудника — зеркально: свой файл виден, папка первого — нет
  assert.deepEqual(inBox(1002, `cat secret2.txt; echo; ${yes(`[ -e "${ws1}/site" ]`)}`), ['чужое', 'no']);
});

test('песочница: агент ACP на Node работает внутри, остановка завершает всё дерево процессов', real, async () => {
  const sb = boxFor(1001, { extraRo: [dirname(FAKE)] });
  const updates = [];
  const agent = new AcpAgent({ cwd: ws1, command: sb.command, args: [...sb.args, FAKE], env: sb.env(process.env), onUpdate: (u) => updates.push(u) });
  await agent.init('plan', { timeoutMs: 20_000 });
  assert.equal(agent.sessionId, 's1');
  assert.equal((await agent.prompt('привет')).stopReason, 'end_turn');
  assert.ok(updates.some((u) => u.content?.text?.startsWith('pids')), 'обновления сессии доходят');
  agent.close();

  // фоновый процесс внутри песочницы не переживает её остановку
  const mark = `3${process.pid}`;
  const running = () => spawnSync('pgrep', ['-f', `sleep ${mark}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const box = boxFor(1001, { command: 'sh' });
  const proc = spawnCommand(box.command, [...box.args, '-c', `sleep ${mark} & wait`], { env: box.env(process.env), stdio: 'ignore' });
  const until = async (cond, ms = 8000) => {
    for (const start = Date.now(); Date.now() - start < ms; ) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return cond();
  };
  assert.ok(await until(() => running().length > 0), 'процесс в песочнице запущен');
  killTree(proc, 500);
  assert.ok(await until(() => running().length === 0), 'после остановки песочницы её процессов не осталось');
});

test('песочница: команды git бота выполняются внутри неё и чужую папку не видят', real, async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git не установлен');
  const G = await import('../src/git.mjs');
  const env = G.gitEnv({ identity: { name: 'Ann', email: 'ann@example.com' } });
  const repo = join(ws1, 'repo');
  const inWs = { env, wrap: boxFor(1001, { command: 'git' }) };
  const inRepo = { env, wrap: boxFor(1001, { command: 'git', cwd: repo }) };
  await G.runGit(['init', '-q', '-b', 'main', repo], { cwd: ws1, ...inWs });
  writeFileSync(join(repo, 'a.txt'), '1');
  writeFileSync(join(repo, '.env'), 'S=1');
  assert.deepEqual(await G.commitAll(repo, 'первый', { cwd: repo, ...inRepo }), { committed: true, skipped: ['.env'], tracked: [] });
  const st = await G.repoState(repo, inRepo);
  assert.deepEqual([st.top, st.branch, st.changed], [repo, 'main', 0]);
  assert.equal((await G.runGit(['log', '-1', '--format=%an <%ae>'], { cwd: repo, ...inRepo })).trim(), 'Ann <ann@example.com>');
  // репозиторий в чужой папке для git в песочнице не существует
  await assert.rejects(G.runGit(['-C', ws2, 'status'], { cwd: ws1, ...inWs }), (e) => e instanceof G.GitError);
});

test('проверка при старте: рабочая песочница проходит, видимый секрет — нет', real, () => {
  assert.deepEqual(S.probeSandbox({ base: data, secrets, files }), { ok: true });
  // «секретный» файл лежит в папке, которую песочница видит, — проверка обязана это заметить
  const leaked = S.probeSandbox({ base: data, secrets, files: ['/etc/hostname', '/etc/passwd'].filter(existsSync) });
  assert.equal(leaked.ok, false);
  assert.match(leaked.error, /видны изнутри песочницы/);
  const missing = S.probeSandbox({ base: data, secrets, files, bwrap: join(base, 'no-bwrap') });
  assert.equal(missing.ok, false);
  assert.match(missing.hint, /bubblewrap/);
});

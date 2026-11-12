// Разбор вывода Windows без зависимости от языка системы и кодовой страницы (баг: на русской Windows AcpGram
// «не видел» существующую службу, потому что искал английские подписи sc.exe).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeOutput, deleteFlagArgs, diagnoseCreate, findOnPath, isGarbled, parseDeleteFlag, parseOemCp, parseTasklistPid, serviceErrorCode, serviceExists, serviceState } from '../src/winsvc.mjs';
import { winMessage } from '../src/service.mjs';

// вывод `sc.exe query acpgram` с ноутбука на русской Windows (зависшая служба)
const RU_STOP_PENDING = [
  '',
  'Имя_службы: acpgram',
  '        Тип                : 10  WIN32_OWN_PROCESS',
  '        Состояние          : 3  STOP_PENDING',
  '                                (NOT_STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)',
  '        Код_выхода_Win32   : 0  (0x0)',
  '        Код_выхода_службы  : 0  (0x0)',
  '        Контрольная_точка  : 0x2',
  '        Ожидание           : 0xdac',
].join('\r\n');

test('serviceExists: по коду выхода sc.exe, а не по тексту', () => {
  assert.equal(serviceExists({ status: 0 }), true);
  assert.equal(serviceExists({ status: 1060 }), false, 'ERROR_SERVICE_DOES_NOT_EXIST');
  assert.equal(serviceExists({ status: 5 }), null, 'нет прав — не «нет службы»');
  assert.equal(serviceExists({ status: null, error: 'EPERM' }), null, 'sc.exe запретили запускать — не «нет службы»');
  assert.equal(serviceExists({ status: null }), null);
});

test('serviceState: русский и английский вывод, подпись не нужна', () => {
  assert.equal(serviceState(RU_STOP_PENDING), 'STOP_PENDING', 'тип «10  WIN32_OWN_PROCESS» не принимается за состояние');
  assert.equal(serviceState('SERVICE_NAME: acpgram\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 3  STOP_PENDING\r\n'), 'STOP_PENDING');
  assert.equal(serviceState('        STATE              : 4  RUNNING \r\n'), 'RUNNING');
  assert.equal(serviceState('        STATE              : 1  STOPPED\r\n'), 'STOPPED');
  // OEM-текст, прочитанный как UTF-8: подписи превратились в U+FFFD, значение осталось
  assert.equal(serviceState('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD          : 4  RUNNING'), 'RUNNING');
  assert.equal(serviceState('[SC] EnumQueryServicesStatus:OpenService FAILED 1060:'), null);
  assert.equal(serviceState(''), null);
});

test('serviceErrorCode: без подписей — по формату «число  (0xHEX)»', () => {
  assert.equal(serviceErrorCode(RU_STOP_PENDING), null, 'ноль — не ошибка');
  assert.equal(serviceErrorCode('        Состояние          : 1  STOPPED\r\n        Код_выхода_Win32   : 1077  (0x435)\r\n        Код_выхода_службы  : 0  (0x0)'), 1077);
  assert.equal(serviceErrorCode('        Код_выхода_Win32   : 1066  (0x42a)\r\n        Код_выхода_службы  : 7  (0x7)'), 7, '1066 — ошибка в коде службы');
  assert.equal(serviceErrorCode('[SC] StartService: ОШИБКА 1069:'), 1069);
});

test('parseDeleteFlag / deleteFlagArgs: служба помечена для удаления', () => {
  assert.equal(parseDeleteFlag({ status: 0, stdout: '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\acpgram\r\n    DeleteFlag    REG_DWORD    0x1\r\n' }), true);
  assert.equal(parseDeleteFlag({ status: 0, stdout: '    DeleteFlag    REG_DWORD    0x0' }), false);
  assert.equal(parseDeleteFlag({ status: 1, stdout: '' }), false, 'значения нет — reg.exe вернул 1');
  // путь — с одинарными обратными слэшами (неверный путь даёт тот же код 1, что и «значения нет»)
  assert.deepEqual(deleteFlagArgs('acpgram'), ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\acpgram', '/v', 'DeleteFlag']);
  assert.ok(!deleteFlagArgs('acpgram')[1].includes('\\\\'));
});

test('parseTasklistPid: столбцы CSV, сообщение «нет задач» на любом языке не мешает', () => {
  assert.equal(parseTasklistPid('"nssm.exe","5128","acpgram"\r\n'), 5128);
  assert.equal(parseTasklistPid('ИНФОРМАЦИЯ: задачи, соответствующие указанным критериям, не запущены.'), null);
  assert.equal(parseTasklistPid('INFO: No tasks are running which match the specified criteria.'), null);
  assert.equal(parseTasklistPid(''), null);
});

test('diagnoseCreate: причина отказа nssm install определяется по состоянию службы', () => {
  const base = { exists: false, marked: false, keyNameTaken: false, nssmStatus: 5, name: 'acpgram' };
  assert.equal(diagnoseCreate({ ...base, exists: true, marked: true }).code, 1072);
  assert.equal(diagnoseCreate({ ...base, exists: true }).code, 1073);
  assert.equal(diagnoseCreate({ ...base, keyNameTaken: true }).code, 1078);
  assert.equal(diagnoseCreate({ ...base, exists: null }).code, null);
  assert.match(diagnoseCreate(base).text, /код 5/, 'код nssm показывается, когда причина неизвестна');
});

test('decodeOutput: UTF-8, UTF-16LE и OEM-кодировка (cp866)', () => {
  assert.equal(decodeOutput(Buffer.from('Состояние', 'utf8'), 866), 'Состояние');
  assert.equal(decodeOutput(Buffer.from('SERVICE_RUNNING', 'utf16le'), 866), 'SERVICE_RUNNING');
  // «Состояние» в cp866: С=91 о=AE с=E1 т=E2 о=AE я=EF н=AD и=A8 е=A5
  assert.equal(decodeOutput(Buffer.from([0x91, 0xae, 0xe1, 0xe2, 0xae, 0xef, 0xad, 0xa8, 0xa5]), 866), 'Состояние');
  assert.equal(decodeOutput(Buffer.from([0x41, 0x42, 0xe9]), 437).slice(0, 2), 'AB', 'кодировка без поддержки (437) не бросает исключение');
  assert.equal(decodeOutput(null, 866), '');
  assert.equal(parseOemCp('    OEMCP    REG_SZ    866\r\n'), 866);
  assert.equal(parseOemCp(''), 0);
});

test('winMessage / isGarbled: нечитаемые сообщения (знаки «?» nssm и U+FFFD)', () => {
  assert.equal(isGarbled('CreateService(): ?????????'), true);
  assert.equal(isGarbled('\uFFFD\uFFFD\uFFFD\uFFFD'), true);
  assert.equal(isGarbled('Access is denied.'), false);
  assert.match(winMessage('\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD'), /не отображается в этой кодировке/);
});

test('findOnPath: поиск по PATH без where.exe (кириллица в путях сохраняется)', () => {
  const present = new Set([String.raw`C:\Users\Иван\AppData\Roaming\npm\gemini.cmd`, String.raw`C:\Tools\nssm.exe`]);
  const exists = (p) => present.has(p);
  const pathVar = String.raw`C:\Windows;"C:\Users\Иван\AppData\Roaming\npm";C:\Tools`;
  assert.equal(findOnPath('gemini', { pathVar, exists }), String.raw`C:\Users\Иван\AppData\Roaming\npm\gemini.cmd`);
  assert.equal(findOnPath('nssm', { pathVar, exists, exts: ['.exe'] }), String.raw`C:\Tools\nssm.exe`);
  assert.equal(findOnPath('nssm', { pathVar: 'C:\\Windows', exists, exts: ['.exe'], extra: ['C:\\Tools'] }), String.raw`C:\Tools\nssm.exe`, 'дополнительные папки (ссылки WinGet)');
  assert.equal(findOnPath('agy', { pathVar, exists }), null);

  // имя с расширением проверяется как есть (раньше искалось «codex-acp.cmd.cmd»)
  const npm = { pathVar: 'C:\\npm', exists: (p) => p === 'C:\\npm\\codex-acp.cmd' };
  assert.equal(findOnPath('codex-acp.cmd', npm), String.raw`C:\npm\codex-acp.cmd`);
  assert.equal(findOnPath('codex-acp', npm), String.raw`C:\npm\codex-acp.cmd`);
  assert.equal(findOnPath('codex-acp.bat', npm), null);
  // расширение определяется без учёта регистра, регистр имени сохраняется в пути
  assert.equal(findOnPath('GEMINI.CMD', { pathVar: 'C:\\npm', exists: (p) => p === 'C:\\npm\\GEMINI.CMD' }), String.raw`C:\npm\GEMINI.CMD`);
  assert.equal(findOnPath('GEMINI.CMD', npm), null);
});

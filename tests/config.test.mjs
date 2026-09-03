// config/defaults.json 校验测试：可解析、必备键齐全、数值域合法、
// orcaPlatformCap 恒为 8 且注明来源是 Orca 平台硬上限（非本仓可调优）。
// 断言中出现的 8/0.2/524288000/40/3/30 字面量是 SC 验收豁免区（config 与其测试断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMiniWatchConfig } from '../scripts/lib/mini-watch-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));
const miniWatch = loadMiniWatchConfig();

const REQUIRED_KEYS = [
  'routingPath',
  'orcaPlatformCap',
  'memReserveRatio',
  'perWorkerBytes',
  'workerTimeoutMinutes',
  'reviewMaxRounds',
  'budgetPauseUsd',
  'goalSkillRoot',
  'orcaFanoutScriptsRoot',
  'runLedgerDir',
  'skillTriggerScanPath',
];

test('defaults.json 可解析且为对象', () => {
  assert.ok(defaults && typeof defaults === 'object' && !Array.isArray(defaults),
    'config/defaults.json 顶层必须是 JSON 对象');
});

test('必备键齐全（11 键无缺漏）', () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(Object.hasOwn(defaults, key), `config/defaults.json 缺少必备键: ${key}`);
  }
});

test('路径类键为非空字符串', () => {
  for (const key of ['routingPath', 'goalSkillRoot', 'orcaFanoutScriptsRoot', 'runLedgerDir', 'skillTriggerScanPath']) {
    assert.equal(typeof defaults[key], 'string', `${key} 必须是字符串`);
    assert.ok(defaults[key].length > 0, `${key} 不能为空`);
  }
});

test('runLedgerDir 以 ~ 开头（HOME 由消费脚本展开，不写死用户主目录）', () => {
  assert.ok(defaults.runLedgerDir.startsWith('~/'), 'runLedgerDir 必须以 ~/ 开头，禁止硬编码绝对主目录');
  assert.ok(!defaults.runLedgerDir.includes('/Users/'), 'runLedgerDir 不得内嵌 /Users/<name> 具体路径');
});

test('skillTriggerScanPath 以 ~ 开头（HOME 由消费脚本展开，不写死用户主目录）', () => {
  assert.ok(defaults.skillTriggerScanPath.startsWith('~/'), 'skillTriggerScanPath 必须以 ~/ 开头，禁止硬编码绝对主目录');
  assert.ok(!defaults.skillTriggerScanPath.includes('/Users/'), 'skillTriggerScanPath 不得内嵌 /Users/<name> 具体路径');
  assert.ok(defaults.skillTriggerScanPath.endsWith('skill-trigger-scan.md'),
    `skillTriggerScanPath 应指向触发词规则文件，当前: ${defaults.skillTriggerScanPath}`);
});

test('数值域合法：0 < memReserveRatio < 1', () => {
  assert.ok(defaults.memReserveRatio > 0 && defaults.memReserveRatio < 1,
    `memReserveRatio 必须在 (0,1) 开区间，当前 ${defaults.memReserveRatio}`);
});

test('数值域合法：perWorkerBytes / workerTimeoutMinutes / reviewMaxRounds / budgetPauseUsd 均为正数', () => {
  for (const key of ['perWorkerBytes', 'workerTimeoutMinutes', 'reviewMaxRounds', 'budgetPauseUsd']) {
    assert.equal(typeof defaults[key], 'number', `${key} 必须是数字`);
    assert.ok(Number.isFinite(defaults[key]) && defaults[key] > 0, `${key} 必须为正数`);
  }
});

test('orcaPlatformCap 为 8 且注明来源为 Orca 平台硬上限（非本仓可调优）', () => {
  assert.equal(defaults.orcaPlatformCap, 8, 'orcaPlatformCap 必须为 8（Orca 平台硬上限）');
  const comment = defaults._comments?.orcaPlatformCap;
  assert.equal(typeof comment, 'string', '缺 orcaPlatformCap 的来源注释（_comments.orcaPlatformCap）');
  assert.ok(comment.length > 0, 'orcaPlatformCap 来源注释不能为空');
  assert.ok(comment.includes('硬上限'), `来源注释必须注明「平台硬上限」语义，当前: ${comment}`);
  assert.ok(comment.includes('可调优'), `来源注释必须注明「非本仓可调优」语义，当前: ${comment}`);
});

test('每个必备键都有来源注释', () => {
  assert.ok(defaults._comments && typeof defaults._comments === 'object', '缺 _comments 对象');
  for (const key of REQUIRED_KEYS) {
    assert.equal(typeof defaults._comments[key], 'string', `缺 ${key} 的来源注释`);
    assert.ok(defaults._comments[key].length > 0, `${key} 的来源注释不能为空`);
  }
});

test('mini-watch.json 分机器段 + 绝对路径 fail-closed', () => {
  assert.ok(isAbsolute(miniWatch.ssh_bin), 'ssh_bin 必须是绝对路径');
  assert.ok(isAbsolute(miniWatch.hosts.mini.state_dir), 'state_dir 必须是绝对路径');
  assert.ok(isAbsolute(miniWatch.hosts.mini.register_bin), 'register_bin 必须是绝对路径');
  assert.equal(typeof miniWatch.hosts.mini.ssh_host, 'string');
  assert.ok(miniWatch.hosts.mini.ssh_host.length > 0);
  assert.equal(typeof miniWatch.hosts.mini.provider_id, 'string');
  assert.ok(miniWatch.hosts.mini.provider_id.length > 0);
  assert.equal(typeof miniWatch.hosts.local.provider_id, 'string');
  assert.ok(miniWatch.hosts.local.provider_id.length > 0);
  assert.ok(Array.isArray(miniWatch.old_schedule_ids_blocklist) && miniWatch.old_schedule_ids_blocklist.length >= 2);
  assert.equal(miniWatch.auto_merge, false);
});

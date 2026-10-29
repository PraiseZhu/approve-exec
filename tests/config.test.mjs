// config/defaults.json 校验测试：可解析、必备键齐全、路径键非空、每键有来源注释；
// 旧入口的键已随 PraiseZhu/approve-exec#70 删除，不得再出现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));

// selfcheck 只读这两个键：goalSkillRoot（goal-skill-md 检查 + 推导 live 链接位置）、skillTriggerScanPath（--live 触发行）。
const REQUIRED_KEYS = ['goalSkillRoot', 'skillTriggerScanPath'];
const REMOVED_KEYS = ['routingPath', 'orcaPlatformCap', 'memReserveRatio', 'perWorkerBytes', 'workerTimeoutMinutes',
  'reviewMaxRounds', 'budgetPauseUsd', 'orcaFanoutScriptsRoot', 'runLedgerDir'];

test('defaults.json 可解析且为对象', () => {
  assert.ok(defaults && typeof defaults === 'object' && !Array.isArray(defaults),
    'config/defaults.json 顶层必须是 JSON 对象');
});

test('必备键齐全，且都是非空字符串', () => {
  for (const key of REQUIRED_KEYS) {
    assert.equal(typeof defaults[key], 'string', `config/defaults.json 缺少必备键或不是字符串: ${key}`);
    assert.ok(defaults[key].length > 0, `${key} 不能为空`);
  }
});

test('旧入口的键已删除（#70）', () => {
  const left = REMOVED_KEYS.filter((k) => Object.hasOwn(defaults, k) || Object.hasOwn(defaults._comments ?? {}, k));
  assert.deepEqual(left, [], `defaults.json 不应再有这些键: ${left.join(', ')}`);
});

test('skillTriggerScanPath 以 ~ 开头（HOME 由消费脚本展开，不写死用户主目录）', () => {
  assert.ok(defaults.skillTriggerScanPath.startsWith('~/'), 'skillTriggerScanPath 必须以 ~/ 开头，禁止硬编码绝对主目录');
  assert.ok(!defaults.skillTriggerScanPath.includes('/Users/'), 'skillTriggerScanPath 不得内嵌 /Users/<name> 具体路径');
  // 2026-09-23 触发表拆分：完整「批准执行」行在 rules-lib/skill-trigger-detail.md，入口表只留短行
  assert.ok(defaults.skillTriggerScanPath.endsWith('skill-trigger-scan.md') || defaults.skillTriggerScanPath.endsWith('skill-trigger-detail.md'),
    `skillTriggerScanPath 应指向触发词规则文件，当前: ${defaults.skillTriggerScanPath}`);
});

test('每个必备键都有来源注释', () => {
  assert.ok(defaults._comments && typeof defaults._comments === 'object', '缺 _comments 对象');
  for (const key of REQUIRED_KEYS) {
    assert.equal(typeof defaults._comments[key], 'string', `缺 ${key} 的来源注释`);
    assert.ok(defaults._comments[key].length > 0, `${key} 的来源注释不能为空`);
  }
});

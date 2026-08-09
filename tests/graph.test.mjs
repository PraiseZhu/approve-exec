// graph.json 席位表校验测试。
// graph.json 是本 skill 的席位真相源（先例 = submit-pr Phase 2 席位表），
// 只引「路由档名 + agent_pin」，永不内嵌具体模型 ID —— 模型在派工时现读
// config/defaults.json 的 routingPath 指向的真实 routing.json。
//
// 断言口径（sc-p2a）：
// 1. 每个 route 值 ∈ 现读 routing.json 的顶层 key 集（subset 判定）。
//    理由：graph 只消费 execute/review/e2e/pr_merge 四档中用到的档，不新增档；
//    routing.json 换值（换模型）不需要改 graph —— graph 只引档名。
// 2. E/R 两席的 agent_pin 必为 claude-code：
//    D0：goal skill 仅 claude-code 会话可加载（codex worker 加载不到 SKILL.md）；
//    D3：/code-review high --fix 是 claude-code 内置命令。
// 3. graph 内不出现任何具体模型 ID（deepseek/gpt-/claude- 之类字样，禁复述）。
//    agent_pin 字段豁免：其值恰为 "claude-code"，且已被断言 2 锁死 ——
//    agent_pin 只允许 claude-code，其它字段出现任何模型前缀即红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const graph = JSON.parse(readFileSync(join(root, 'graph.json'), 'utf8'));
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));

// 现读真实 routing.json（config 的 routingPath 指向，测试不缓存、不复述模型）
const routing = JSON.parse(readFileSync(defaults.routingPath, 'utf8'));
const routingKeys = Object.keys(routing);

// 模型 ID 禁复述检测模式：graph 内（agent_pin 字段除外）任何字符串值命中即红。
// 只检前缀类字样（deepseek/gpt-/claude-/gemini/grok/qwen/llama），
// route 档名（execute/e2e/pr_merge）与其它元数据字段不会命中。
const MODEL_ID_PATTERN = /deepseek|gpt-|claude-|gemini|grok|qwen|llama|kimi|glm-|doubao/i;

const SEATS = ['E', 'R', 'V', 'T', 'P'];

function validateGraph(g) {
  // 返回 { ok: true } 或 { ok: false, reason }
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    return { ok: false, reason: 'graph 顶层必须是 JSON 对象' };
  }
  if (g.schema_version == null) return { ok: false, reason: '缺 schema_version' };
  if (!g.phases || typeof g.phases !== 'object' || Array.isArray(g.phases)) {
    return { ok: false, reason: '缺 phases 对象' };
  }
  for (const seat of SEATS) {
    const s = g.phases[seat];
    if (!s || typeof s !== 'object') return { ok: false, reason: `缺席位 ${seat}` };
    if (typeof s.route !== 'string' || s.route.length === 0) {
      return { ok: false, reason: `${seat}.route 必须是非空字符串` };
    }
    if (!routingKeys.includes(s.route)) {
      return { ok: false, reason: `${seat}.route=${s.route} 不在 routing.json 顶层 key 集 ${routingKeys.join(',')} 内（subset 判定失败）` };
    }
    if (seat === 'E' || seat === 'R') {
      if (s.agent_pin !== 'claude-code') {
        return { ok: false, reason: `${seat}.agent_pin 必须为 claude-code（当前 ${s.agent_pin}）——goal skill 仅 claude-code 可加载 / /code-review 为 claude-code 内置` };
      }
    }
    for (const [field, value] of Object.entries(s)) {
      if (field === 'agent_pin') continue; // 豁免：值恰为 claude-code，由上面的专门断言锁死
      if (typeof value === 'string' && MODEL_ID_PATTERN.test(value)) {
        return { ok: false, reason: `${seat}.${field} 出现模型 ID 字样 "${value}"（禁复述，模型派工时现读 routing）` };
      }
    }
  }
  return { ok: true };
}

test('graph.json 可解析且含 schema_version 与五席 phases', () => {
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph), 'graph.json 顶层必须是 JSON 对象');
  assert.ok(graph.schema_version != null, '缺 schema_version');
  assert.ok(graph.phases && typeof graph.phases === 'object', '缺 phases');
  for (const seat of SEATS) {
    assert.ok(graph.phases[seat], `缺席位 ${seat}`);
  }
});

test('route 值均为 routing.json 顶层 key 集的子集（subset 判定）', () => {
  // graph 只消费 execute/review/e2e/pr_merge 四档中用到的档，不新增档：
  // routing.json 换值（含换模型）不需要改 graph，graph 只引档名。
  for (const seat of SEATS) {
    const route = graph.phases[seat].route;
    assert.ok(routingKeys.includes(route),
      `${seat}.route=${route} 不在 routing.json 顶层 key 集内（subset 判定失败），当前 key 集: ${routingKeys.join(', ')}`);
  }
});

test('E/R 两席 agent_pin 必为 claude-code（D0: goal skill 仅 claude-code 可加载；D3: /code-review 为 claude-code 内置）', () => {
  for (const seat of ['E', 'R']) {
    assert.equal(graph.phases[seat].agent_pin, 'claude-code',
      `${seat}.agent_pin 必须为 claude-code（当前 ${graph.phases[seat].agent_pin}）`);
  }
});

test('graph 内不出现任何具体模型 ID（禁复述，模型永远派工时现读 routing）', () => {
  const result = validateGraph(graph);
  assert.equal(result.ok, true, result.reason);
});

test('反证夹具：agent_pin 改 codex 的坏 graph → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.E.agent_pin = 'codex';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'agent_pin=codex 必须被拒');
  assert.ok(result.reason.includes('agent_pin'), `拒绝理由应指向 agent_pin，实际: ${result.reason}`);
});

test('反证夹具：graph 内出现 "deepseek" 字样 → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.V.model = 'deepseek/deepseek-v4-flash';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, '内嵌 deepseek 模型 ID 必须被拒');
  assert.ok(result.reason.includes('模型 ID'), `拒绝理由应指向禁复述，实际: ${result.reason}`);
});

test('反证夹具：graph 内出现 "gpt-" 字样 → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.T.model = 'gpt-5.6-luna';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, '内嵌 gpt- 模型 ID 必须被拒');
  assert.ok(result.reason.includes('模型 ID'), `拒绝理由应指向禁复述，实际: ${result.reason}`);
});

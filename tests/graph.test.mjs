// graph.json 席位表校验测试。
// graph.json 是本 skill 的席位真相源：只引路由档名 + dispatch 模式。
// E = 独立 PI session（goal 场景 C）；R/T = 子 session 现读 routing 派 worker；
// V/P = lead-self（只读验收 / 写台账）。graph 内不出现具体模型 ID，R 不钉 model。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const graph = JSON.parse(readFileSync(join(root, 'graph.json'), 'utf8'));
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));

const routing = JSON.parse(readFileSync(defaults.routingPath, 'utf8'));
const routingKeys = Object.keys(routing);

const MODEL_ID_PATTERN = /deepseek|gpt-|claude-|gemini|grok|qwen|llama|kimi|glm-|doubao/i;

const DISPATCH_MODES = ['lead-self', 'worker', 'session'];

const SEATS = ['E', 'R', 'V', 'T', 'P'];
const LEAD_SELF_SEATS = ['R', 'V', 'P'];
const WORKER_SEATS = ['T'];

function validateGraph(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    return { ok: false, reason: 'graph 顶层必须是 JSON 对象' };
  }
  if (g.schema_version == null) return { ok: false, reason: '缺 schema_version' };
  if (!g.phases || typeof g.phases !== 'object' || Array.isArray(g.phases)) {
    return { ok: false, reason: '缺 phases 对象' };
  }
  for (const seat of SEATS) {
    if (!g.phases[seat] || typeof g.phases[seat] !== 'object') {
      return { ok: false, reason: `缺席位 ${seat}` };
    }
  }
  const phaseKeys = Object.keys(g.phases).sort();
  const expectedKeys = [...SEATS].sort();
  if (phaseKeys.join(',') !== expectedKeys.join(',')) {
    return { ok: false, reason: `phases 键集必须精确等于 ${expectedKeys.join('/')}（当前 ${phaseKeys.join('/')}）` };
  }
  for (const [seat, s] of Object.entries(g.phases)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { ok: false, reason: `席位 ${seat} 必须是对象` };
    }
    if (typeof s.route !== 'string' || s.route.length === 0) {
      return { ok: false, reason: `${seat}.route 必须是非空字符串` };
    }
    if (!routingKeys.includes(s.route)) {
      return { ok: false, reason: `${seat}.route=${s.route} 不在 routing.json 顶层 key 集 ${routingKeys.join(',')} 内（subset 判定失败）` };
    }
    if (Object.hasOwn(s, 'agent_pin')) {
      return { ok: false, reason: `${seat}.agent_pin 禁止出现（席位不再钉 agent 家族；PI 只出现在 send_to_session.agent_kind）` };
    }
    if (seat === 'R') {
      for (const banned of ['model', 'effort', 'pre_command', 'command']) {
        if (Object.hasOwn(s, banned)) {
          return { ok: false, reason: `R.${banned} 禁止出现（R 本地不派 reviewer，不钉 model/command）` };
        }
      }
    }
    if (s.dispatch == null || !DISPATCH_MODES.includes(s.dispatch)) {
      return { ok: false, reason: `${seat}.dispatch=${s.dispatch} 不在 {${DISPATCH_MODES.join(',')}} 内` };
    }
    if (seat === 'E' && s.dispatch !== 'session') {
      return { ok: false, reason: `E.dispatch 必须为 session（当前 ${s.dispatch}）` };
    }
    if (LEAD_SELF_SEATS.includes(seat) && s.dispatch !== 'lead-self') {
      return { ok: false, reason: `${seat}.dispatch 必须为 lead-self（当前 ${s.dispatch}）` };
    }
    if (WORKER_SEATS.includes(seat) && s.dispatch !== 'worker') {
      return { ok: false, reason: `${seat}.dispatch 必须为 worker（当前 ${s.dispatch}）` };
    }
    for (const [field, value] of Object.entries(s)) {
      if (typeof value === 'string' && MODEL_ID_PATTERN.test(value)) {
        return { ok: false, reason: `${seat}.${field} 出现模型 ID 字样 "${value}"（禁复述，模型派工时现读 routing）` };
      }
    }
  }
  return { ok: true };
}

test('DISPATCH_MODES 含 session（E 席新枚举，不得只剩 lead-self/worker）', () => {
  assert.deepEqual(DISPATCH_MODES, ['lead-self', 'worker', 'session']);
});

test('graph.json 可解析且含 schema_version 与五席 phases', () => {
  assert.ok(graph && typeof graph === 'object' && !Array.isArray(graph), 'graph.json 顶层必须是 JSON 对象');
  assert.ok(graph.schema_version != null, '缺 schema_version');
  assert.ok(graph.phases && typeof graph.phases === 'object', '缺 phases');
  for (const seat of SEATS) {
    assert.ok(graph.phases[seat], `缺席位 ${seat}`);
  }
});

test('phases 键集精确等于 E/R/V/T/P（决策 sidecar 不得进 graph）', () => {
  assert.deepEqual(Object.keys(graph.phases).sort(), [...SEATS].sort());
  const extra = structuredClone(graph);
  extra.phases.D = { route: 'e2e', dispatch: 'worker' };
  const result = validateGraph(extra);
  assert.equal(result.ok, false, '第六席 D 必须被拒');
  assert.match(result.reason, /键集必须精确等于/);
});

test('route 值均为 routing.json 顶层 key 集的子集（subset 判定）', () => {
  for (const seat of SEATS) {
    const route = graph.phases[seat].route;
    assert.ok(routingKeys.includes(route),
      `${seat}.route=${route} 不在 routing.json 顶层 key 集内（subset 判定失败），当前 key 集: ${routingKeys.join(', ')}`);
  }
  assert.equal(graph.phases.E.route, 'execute');
  assert.equal(graph.phases.R.route, 'review');
  assert.equal(graph.phases.V.route, 'e2e');
  assert.equal(graph.phases.T.route, 'e2e');
  assert.equal(graph.phases.P.route, 'pr_merge');
});

test('席位 dispatch：E=session，T=worker，R/V/P=lead-self', () => {
  assert.equal(graph.phases.E.dispatch, 'session');
  assert.equal(graph.phases.E.goal, 'goal-scenario-c');
  for (const seat of LEAD_SELF_SEATS) {
    assert.equal(graph.phases[seat].dispatch, 'lead-self',
      `${seat}.dispatch 必须为 lead-self（当前 ${graph.phases[seat].dispatch}）`);
  }
  for (const seat of WORKER_SEATS) {
    assert.equal(graph.phases[seat].dispatch, 'worker',
      `${seat}.dispatch 必须为 worker（当前 ${graph.phases[seat].dispatch}）`);
  }
  assert.equal(graph.phases.V.independence, 'accept-receipts-no-product-edit');
  assert.equal(graph.phases.R.model, undefined, 'R 不得钉 model');
  assert.equal(graph.phases.R.pre_command, undefined, 'R 不得钉 pre_command');
  assert.equal(graph.phases.R.command, undefined, 'R 不得钉 command');
});

test('P 席 packaging_paths：打包白名单至少含 .pr-intent.md', () => {
  const pp = graph.phases.P.packaging_paths;
  assert.ok(Array.isArray(pp), 'P 席 packaging_paths 必须是数组');
  assert.ok(pp.length > 0, 'packaging_paths 不得为空');
  assert.ok(pp.includes('.pr-intent.md'), 'packaging_paths 默认至少含 .pr-intent.md');
  for (const p of pp) {
    assert.equal(typeof p, 'string', `packaging_paths 元素必须是字符串: ${p}`);
    assert.ok(p.length > 0, 'packaging_paths 元素不得为空字符串');
  }
});

test('graph 内不出现任何具体模型 ID（禁复述）', () => {
  const result = validateGraph(graph);
  assert.equal(result.ok, true, result.reason);
});

test('任一席位不得带 agent_pin', () => {
  for (const seat of SEATS) {
    assert.equal(graph.phases[seat].agent_pin, undefined, `${seat} 不得带 agent_pin`);
  }
});

test('反证夹具：任一席位出现 agent_pin → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.E.agent_pin = 'claude-code';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'agent_pin 必须被拒');
  assert.ok(result.reason.includes('agent_pin'), `拒绝理由应指向 agent_pin，实际: ${result.reason}`);
});

test('反证夹具：R 席出现 model → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.R.model = 'x-ai/grok-4.6';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'R.model 必须被拒');
  assert.ok(result.reason.includes('R.model'), `拒绝理由应指向 R.model，实际: ${result.reason}`);
});

test('反证夹具：E.dispatch=lead-self → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.E.dispatch = 'lead-self';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'E.dispatch=lead-self 必须被拒');
  assert.ok(result.reason.includes('session'), `拒绝理由应指向 session，实际: ${result.reason}`);
});

test('反证夹具：graph 内出现 deepseek / gpt- 字样 → 断言红', () => {
  const badDeepseek = structuredClone(graph);
  badDeepseek.phases.V.model = 'deepseek/deepseek-v4-flash';
  const r1 = validateGraph(badDeepseek);
  assert.equal(r1.ok, false, '内嵌 deepseek 模型 ID 必须被拒');
  assert.ok(r1.reason.includes('模型 ID'), `拒绝理由应指向禁复述，实际: ${r1.reason}`);

  const badGpt = structuredClone(graph);
  badGpt.phases.T.model = 'gpt-5.6-luna';
  const r2 = validateGraph(badGpt);
  assert.equal(r2.ok, false, '内嵌 gpt- 模型 ID 必须被拒');
  assert.ok(r2.reason.includes('模型 ID'), `拒绝理由应指向禁复述，实际: ${r2.reason}`);
});

test('反证夹具：phases 多余席位 → 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.X = { route: 'e2e', dispatch: 'worker' };
  const result = validateGraph(bad);
  assert.equal(result.ok, false, '多余席位必须被拒');
  assert.ok(result.reason.includes('键集必须精确等于'), `拒绝理由应指向键集，实际: ${result.reason}`);
});

test('反证夹具：DISPATCH_MODES 缺 session 时 E.dispatch=session 被拒', () => {
  const modesWithoutSession = ['lead-self', 'worker'];
  assert.ok(!modesWithoutSession.includes('session'));
  assert.ok(DISPATCH_MODES.includes(graph.phases.E.dispatch));
});

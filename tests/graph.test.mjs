// graph.json 席位表校验测试。
// graph.json 是本 skill 的席位真相源（先例 = submit-pr Phase 2 席位表），
// 只引「路由档名 + agent_pin」；唯一例外 = R 席 model/effort 由席位表显式钉死
// （D3，owner 2026-08-21 改钉：x-ai/grok-4.6 / high，不走 routing）。
// 其余席位的模型在派工时现读 config/defaults.json 的 routingPath 指向的真实 routing.json。
//
// 断言口径（sc-p2a）：
// 1. 每个 route 值 ∈ 现读 routing.json 的顶层 key 集（subset 判定）。
//    理由：graph 只消费 execute/review/e2e/pr_merge 四档中用到的档，不新增档；
//    routing.json 换值（换模型）不需要改 graph —— graph 只引档名。
// 2. E/R 两席的 agent_pin 必为 claude-code：
//    D0：goal skill 仅 claude-code 会话可加载（codex worker 加载不到 SKILL.md）；
//    D3：/code-review high --fix 是 claude-code 内置命令。
//    agent_pin 是 agent 家族钉：任何席位出现 agent_pin 都只允许 claude-code
//    （全表唯一合法值），且必须与所在席位 route 档的 agent 一致 ——
//    route=execute 的 E/R 席依赖 execute 档 agent=claude-code 的现状，
//    若 routing.json 把 execute 档 agent 改成 codex，agent_pin 即失效，必须红。
// 3. graph 内不出现任何具体模型 ID（deepseek/gpt-/claude- 之类字样，禁复述），
//    **R 席 model 字段除外**：该字段是 D3 钉死值（x-ai/grok-4.6），
//    豁免禁复述检测，其值绑定由独立 test 断言。
//    检测范围是 phases 全部席位（含未来新增席位），不是白名单五席 ——
//    多余席位带模型 ID 同样违反「graph 内不出现模型 ID」的禁复述意图。
// 4. R 席 model/effort 必须存在且格式合法：model 非空字符串、effort ∈ 六枚举
//    （low/medium/high/xhigh/max/ultra，与 scripts/selfcheck.mjs 的 EFFORTS 同一枚举）。
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

// 模型 ID 禁复述检测模式：graph 内（agent_pin 与 R 席 model 字段除外）任何字符串值命中即红。
// 只检前缀类字样（deepseek/gpt-/claude-/gemini/grok/qwen/llama），
// route 档名（execute/e2e/pr_merge）与其它元数据字段不会命中。
const MODEL_ID_PATTERN = /deepseek|gpt-|claude-|gemini|grok|qwen|llama|kimi|glm-|doubao/i;

// effort 六枚举：与 scripts/selfcheck.mjs 的 EFFORTS 同一枚举（create_worker 的 effort 合法值），
// 这里复用同一字面量清单，不另立一套。
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

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
  // 白名单五席必须全部存在（防删席/改名漂移）
  for (const seat of SEATS) {
    if (!g.phases[seat] || typeof g.phases[seat] !== 'object') {
      return { ok: false, reason: `缺席位 ${seat}` };
    }
  }
  // 全席位校验：遍历 phases 全部席位（含未来新增席位），不缩在白名单五席上 ——
  // 任何席位带模型 ID 都违反禁复述，多余席位同样必须满足席位约束。
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
    if (s.agent_pin != null && s.agent_pin !== 'claude-code') {
      return { ok: false, reason: `${seat}.agent_pin 必须为 claude-code（当前 ${s.agent_pin}）——agent_pin 是 agent 家族钉，全表唯一合法值` };
    }
    if (seat === 'E' || seat === 'R') {
      if (s.agent_pin !== 'claude-code') {
        return { ok: false, reason: `${seat}.agent_pin 必须为 claude-code（当前 ${s.agent_pin}）——goal skill 仅 claude-code 可加载 / /code-review 为 claude-code 内置` };
      }
      // agent_pin 钉的 agent 家族必须与 route 档的 agent 一致：
      // E/R 席走 execute 档依赖 execute 档 agent=claude-code，档 agent 一变 agent_pin 即失效。
      const routeAgent = routing[s.route]?.agent;
      if (routeAgent !== 'claude-code') {
        return { ok: false, reason: `${seat}.agent_pin=claude-code 与其 route=${s.route} 档的 agent=${routeAgent ?? '缺失'} 不一致——按档派工出的 agent 与 agent_pin 矛盾` };
      }
    }
    if (seat === 'R') {
      // D3（owner 2026-08-10 拍板）：R 席 model/effort 由席位表显式钉死，不走 routing 路由。
      // 这里只校验存在性与格式；值绑定（x-ai/grok-4.6 / high）在独立 test 断言。
      if (typeof s.model !== 'string' || s.model.length === 0) {
        return { ok: false, reason: `R.model 必须是非空字符串（当前 ${s.model}）——D3 席位表钉死字段` };
      }
      if (typeof s.effort !== 'string' || s.effort.length === 0) {
        return { ok: false, reason: `R.effort 必须是非空字符串（当前 ${s.effort}）——D3 席位表钉死字段` };
      }
      if (!EFFORTS.includes(s.effort)) {
        return { ok: false, reason: `R.effort=${s.effort} 不在 effort 六枚举 {${EFFORTS.join(',')}} 内` };
      }
    }
    for (const [field, value] of Object.entries(s)) {
      if (field === 'agent_pin') continue; // 已在上方锁死唯一合法值 claude-code，无需再过模型前缀
      if (seat === 'R' && field === 'model') continue; // R 席 model 是 D3 钉死值，豁免禁复述；值绑定在独立 test 断言
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

test('P 席 packaging_paths：打包白名单唯一真相源，默认至少含 .pr-intent.md（ready-check gate ③ 第 2 层消费）', () => {
  const pp = graph.phases.P.packaging_paths;
  assert.ok(Array.isArray(pp), 'P 席 packaging_paths 必须是数组');
  assert.ok(pp.length > 0, 'packaging_paths 不得为空（全树封闭性白名单缺打包路径即 fail-closed 拒）');
  assert.ok(pp.includes('.pr-intent.md'), 'packaging_paths 默认至少含 .pr-intent.md');
  for (const p of pp) {
    assert.equal(typeof p, 'string', `packaging_paths 元素必须是字符串: ${p}`);
    assert.ok(p.length > 0, 'packaging_paths 元素不得为空字符串');
  }
});

test('R 席 model/effort 显式钉死（D3：owner 2026-08-21 改钉，不走 routing 路由）', () => {
  assert.equal(graph.phases.R.model, 'x-ai/grok-4.6',
    `R.model 必须为 x-ai/grok-4.6（当前 ${graph.phases.R.model}）`);
  assert.equal(graph.phases.R.effort, 'high',
    `R.effort 必须为 high（当前 ${graph.phases.R.effort}）`);
  assert.ok(EFFORTS.includes(graph.phases.R.effort),
    `R.effort=${graph.phases.R.effort} 不在 effort 六枚举 {${EFFORTS.join(',')}} 内`);
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

test('反证夹具：非 E/R 席 agent_pin 出现坏值（codex）→ 断言红', () => {
  // 曾盲区：agent_pin 字段无条件豁免 + 断言 2 只锁 E/R 两席，
  // V 席 agent_pin="codex" 会同时绕过禁复述检测与专门断言。
  const bad = structuredClone(graph);
  bad.phases.V.agent_pin = 'codex';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, '非 E/R 席 agent_pin=codex 必须被拒');
  assert.ok(result.reason.includes('agent_pin'), `拒绝理由应指向 agent_pin，实际: ${result.reason}`);
});

test('反证夹具：phases 多余席位带模型 ID → 断言红', () => {
  // 曾盲区：禁复述检测只遍历 SEATS 白名单，多余席位（X）带模型 ID 会静默通过。
  const bad = structuredClone(graph);
  bad.phases.X = { route: 'e2e', model: 'gpt-5.6-luna' };
  const result = validateGraph(bad);
  assert.equal(result.ok, false, '多余席位内嵌模型 ID 必须被拒');
  assert.ok(result.reason.includes('模型 ID'), `拒绝理由应指向禁复述，实际: ${result.reason}`);
});

test('反证夹具：E 席 route 改到 agent=codex 的档（review）→ agent_pin 一致性红', () => {
  // agent_pin=claude-code 与 route 档 agent=codex 矛盾：按档派工出的 agent 不是 claude-code，
  // goal skill（E 席）根本加载不到。route 值本身在 subset 内，只有一致性断言能抓住。
  const bad = structuredClone(graph);
  bad.phases.E.route = 'review';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'E 席 route=review（档 agent=codex）与 agent_pin=claude-code 矛盾，必须被拒');
  assert.ok(result.reason.includes('不一致'), `拒绝理由应指向 agent_pin 与档 agent 不一致，实际: ${result.reason}`);
});

test('反证夹具：R 席删 model → 断言红', () => {
  // R 席 model 是 D3 钉死字段（非空字符串），删掉必须被 validateGraph 拒。
  const bad = structuredClone(graph);
  delete bad.phases.R.model;
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'R 席缺 model 必须被拒');
  assert.ok(result.reason.includes('R.model'), `拒绝理由应指向 R.model，实际: ${result.reason}`);
});

test('反证夹具：R 席 effort 越六枚举（turbo）→ 断言红', () => {
  const bad = structuredClone(graph);
  bad.phases.R.effort = 'turbo';
  const result = validateGraph(bad);
  assert.equal(result.ok, false, 'R.effort 越枚举必须被拒');
  assert.ok(result.reason.includes('枚举'), `拒绝理由应指向 effort 枚举，实际: ${result.reason}`);
});

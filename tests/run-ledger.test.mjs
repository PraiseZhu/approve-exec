// run-ledger.test.mjs — sc-p1c/p1d/p1e/p1h 四条 SC 的验收测试。
// 判据：exit 0 且 fail 0（由 scripts/run-tests.mjs 权威入口驱动）。
// CLI 层用 spawnSync 验 exit code（fail-closed 一律 exit 2）；
// 函数层（CAS/原子写）直接 import run-ledger.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, cpSync, rmSync,
  symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLedger, writeLedgerAtomic, writeTmp, renameTmp, initLedger,
  tmpPath, acquireLedgerLock, releaseLedgerLock, manifestCoreHash, LedgerError,
  identityDigest, expectedBase, staleness, assertMemSnapshot, renderPacket,
} from '../scripts/run-ledger.mjs';
// buildChildEnv：变异子套件自起子进程，git 隔离必须同一份实现（run-tests.mjs 是唯一权威）。
// 子套件在复制树里跑（含 ready-check/e2e-dryrun 的 git makeRepo），缺隔离会继承机器全局
// commit.gpgsign=true，负载下 gpg 失败让夹具 commit 红——失败集比对随之漂移。
import { buildChildEnv } from '../scripts/run-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'run-ledger.mjs');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'sample-manifest.json');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const SHA39 = 'd'.repeat(39);
const GATE_GOAL_SHA = '7d7b9d9b97c99b39de5cbbd6b20e4869afe4cb16dab1dc91833a94a29dca356e';
const GATE_ROUTING_SHA = 'e88009fec5d61472d41554b8c0238c6eedd1395d8b301cbc1524d121dc386c23';
const ROUTING_LIVE = '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json';
const GOAL_SKILL_PI = '/Users/praise/.agents/skills/goal/SKILL.md';

const T = '2026-08-09T00:00:00Z';

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function newTmpDir() {
  return mkdtempSync(join(tmpdir(), 'run-ledger-'));
}

/** 复制夹具到 tmp 目录并返回副本路径（manifest 改字节类测试不污染仓内夹具）。 */
function fixtureCopy(dir) {
  const p = join(dir, 'sample-manifest.json');
  copyFileSync(FIXTURE, p);
  return p;
}

/**
 * 构造「台账与不完整 manifest hash 自洽」的环境（init 输入门收紧后，不完整 manifest 已无法
 * 过 init——F-D 门禁下 init 后篡改又会被 HASH_MISMATCH 先行拦截，测不到下游行为）。
 * 做法：先用完整夹具 init（exit 0），再篡改 manifest 副本并重算 hash、直接同步台账的
 * manifest_core_hash——本组测试的意图是「render-packet/record-delivery 对不完整 packet 的
 * PACKET_INCOMPLETE 拒绝」，不是测 F-D 内容绑定（F-D 由专属测试覆盖）。
 */
function tamperManifestThenInit(dir, mutate) {
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mutate(m);
  m.manifest_core_hash = manifestCoreHash(m);
  writeFileSync(manifestPath, JSON.stringify(m));
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger.manifest_core_hash = m.manifest_core_hash;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { ledgerPath, manifestPath };
}

/** init 一个台账（CLI 层），返回 { ledgerPath, manifestPath }。
 *  sc-p0a 迁移：init 必传 --baseline SHA3（严格模式——基线闸/快照闸/凭证闸全强制）。 */
function initLedgerFor(dir) {
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'test-run', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 0, `init 应 exit 0: ${r.stderr}`);
  return { ledgerPath, manifestPath };
}

function initLedgerForClean(dir) {
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  initLedger({ ledgerPath, manifestPath, runId: 'test-run', now: T, baseline: SHA3 });
  return { ledgerPath, manifestPath };
}

/** 给组分配身份（worktree/branch/base + session_id）。base 默认 SHA3（= init 基线）；
 *  集成后派工的组必须显式传最新集成 tip（sc-p0a 基线闸）。
 *  session_id 默认 `sess-${group}`：pending→dispatched 前置要求 identity 已含 session_id。
 *  title 可选；标题格式含空格，不得套 no-whitespace。 */
function assignIdentity(ledgerPath, group, branch, base = SHA3, extras = {}) {
  const identity = {
    worktree: extras.worktree ?? `/wt/${group}`,
    branch,
    base,
    session_id: extras.session_id ?? `sess-${group}`,
  };
  if (extras.title !== undefined) identity.title = extras.title;
  const r = cli(
    'set-state', ledgerPath, '--group', group, '--identity',
    JSON.stringify(identity), '--now', T
  );
  assert.equal(r.status, 0, `set-state --identity 应 exit 0: ${r.stderr}`);
}

function gateGoalDetail() {
  return JSON.stringify({
    goal_skill_path: GOAL_SKILL_PI,
    goal_skill_sha256: GATE_GOAL_SHA,
  });
}

function gateRoutingDetail() {
  return JSON.stringify({
    route_source: ROUTING_LIVE,
    routing_sha256: GATE_ROUTING_SHA,
    e2e_model: 'codex/gpt-5.6-luna',
    review_model: 'codex/gpt-5.6-sol',
  });
}

function prHandoffPayload(group, extras = {}) {
  const manifestPath = extras.manifestPath
    ?? (extras.ledgerPath ? join(dirname(extras.ledgerPath), 'sample-manifest.json') : FIXTURE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const packet = manifest.dispatch.packets.find((p) => p.group_id === group);
  const tip = extras.tip_sha ?? SHA1;
  return {
    pr_url: extras.pr_url ?? `https://github.com/xindong/mivo-canvas-plugin/pull/${extras.pr_id ?? 1}`,
    branch: extras.branch ?? 'feat/run-ledger',
    tip_sha: tip,
    scs: packet.scs_inline.map((s) => ({ id: s.id, status: 'pass' })),
    goal_skill_path: extras.goal_skill_path ?? GOAL_SKILL_PI,
    e2e: {
      status: extras.e2e_status ?? 'pass',
      candidate_sha: tip,
      model: extras.e2e_model ?? 'codex/gpt-5.6-luna',
      route_source: extras.route_source ?? ROUTING_LIVE,
    },
    review: {
      unresolved: extras.unresolved ?? 0,
      candidate_sha: tip,
      model: extras.review_model ?? 'codex/gpt-5.6-sol',
      route_source: extras.route_source ?? ROUTING_LIVE,
    },
    size_gate: { result: extras.size_result ?? 'PASS', candidate_sha: tip },
  };
}

/** 合法 mem-snapshot（sc-p0b 四键 exact 契约的合法样例：全非负整数、concurrency<=cap、
 *  used_slots<=cap）。lead 从 mem-probe --json 提取四键构造。 */
function memSnapshotJson({ usedSlots = 0, platformCap = 8, concurrency = 8, availableBytes = 34359738368 } = {}) {
  return JSON.stringify({ used_slots: usedSlots, platform_cap: platformCap, concurrency, available_bytes: availableBytes });
}

/** render-packet 成功出包（断言 exit 0），返回 stdout。sc-p0c 凭证闸的前置步骤。 */
function renderGroup(ledgerPath, group) {
  const r = cli('render-packet', ledgerPath, '--group', group);
  assert.equal(r.status, 0, `render-packet ${group} 应 exit 0: ${r.stderr}`);
  return r.stdout;
}

/** F-H 后唯一合法通道：record-delivery 验收交卷写入 verify.status=pass + evidence_ref
 * （set-state --verify-status 手工入口已移除）。scs 取台账 manifest 里该组 packet 的 id。
 * candidate_sha 为 main VERIFY_DELIVERY_KEYS 必填契约字段（严格版）。 */
function grantVerifyPass(ledgerPath, group) {
  const manifest = JSON.parse(readFileSync(join(dirname(ledgerPath), 'sample-manifest.json'), 'utf8'));
  const packet = manifest.dispatch.packets.find((p) => p.group_id === group);
  const payload = {
    scs: packet.scs_inline.map((s) => ({ sc_id: s.id, status: 'pass', evidence: `verify 通过：${s.id}` })),
    integration_review: { status: 'pass', notes: '验收通过' },
    candidate_sha: SHA1,
  };
  const r = cli('record-delivery', ledgerPath, '--group', group, '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `验收交卷（grant verify pass）应 exit 0: ${r.stderr}`);
}

/** 把组 g4 走完到 accepted 的合法链。
 *  dispatched 前：身份含 session_id + render-packet + --mem-snapshot。
 *  executing 要 gate_goal；e2e 要 gate_routing；pr-open 要终态 pr-handoff 交卷。 */
function runG4ToAccepted(ledgerPath) {
  const g = 'g4';
  assignIdentity(ledgerPath, g, 'feat/run-ledger');
  renderGroup(ledgerPath, g);
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, `合法链 ${to} 应 exit 0: ${r.stderr}`);
  }
  const handoff = prHandoffPayload(g, { ledgerPath, branch: 'feat/run-ledger' });
  let r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(handoff), '--now', T);
  assert.equal(r.status, 0, `pr-handoff 交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, `→pr-open 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, `→accepted 应 exit 0: ${r.stderr}`);
}

function runG4ToVerified(ledgerPath) {
  return runG4ToAccepted(ledgerPath);
}

/** 手工构造 g4 为 verified 终态（绕过 CLI 长链）。专用于「终态只读」类测试——
 *  不依赖 dispatch/delivery 写路径，与 F1 变异（detail 写回字符串）解耦，
 *  使守卫类测试在既有变异套件下保持绿。 */
function forgeG4Verified(ledgerPath) {
  return forgeG4Accepted(ledgerPath);
}

function injectGateEvents(ledger, groupId) {
  const hasGoal = ledger.events.some((e) => e.type === 'gate_goal' && e.detail?.group_id === groupId);
  const hasRouting = ledger.events.some((e) => e.type === 'gate_routing' && e.detail?.group_id === groupId);
  if (!hasGoal) {
    ledger.events.push({
      type: 'gate_goal', at: T,
      detail: { group_id: groupId, goal_skill_path: GOAL_SKILL_PI, goal_skill_sha256: GATE_GOAL_SHA },
    });
  }
  if (!hasRouting) {
    ledger.events.push({
      type: 'gate_routing', at: T,
      detail: {
        group_id: groupId, route_source: ROUTING_LIVE, routing_sha256: GATE_ROUTING_SHA,
        e2e_model: 'codex/gpt-5.6-luna', review_model: 'codex/gpt-5.6-sol',
      },
    });
  }
}

function forgeG4Accepted(ledgerPath) {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const g = ledger.waves[0].groups[0];
  g.state = 'accepted';
  g.worker_label = 'w1';
  g.tip_sha = SHA1;
  g.review = { rounds: 0, unresolved: 0 };
  g.verify = { status: null, evidence_ref: null };
  g.worktree = '/wt/g4';
  g.branch = 'feat/run-ledger';
  g.base = SHA3;
  g.session_id = 'sess-g4';
  g.title = 'Skills-g4丨 0902';
  g.pr_url = 'https://github.com/xindong/mivo-canvas-plugin/pull/1';
  g.provider_id = 'art';
  injectGateEvents(ledger, 'g4');
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** 把 g4 手工构造为任意组状态（生命周期矩阵测试用）。字段按状态补齐必要部分，
 *  schema 允许其余为 null/初始值。不依赖 dispatch/delivery 写路径（与 F1 变异解耦）。 */
function forgeG4State(ledgerPath, state) {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const g = ledger.waves[0].groups[0];
  g.state = state;
  g.worktree = g.worktree ?? '/wt/g4';
  g.branch = g.branch ?? 'feat/run-ledger';
  g.base = g.base ?? SHA3;
  g.session_id = g.session_id ?? 'sess-g4';
  if (['dispatched', 'executing', 'blocked', 'e2e', 'review', 'pr-open', 'failed'].includes(state)) {
    g.worker_label = 'w1';
  }
  if (['e2e', 'review', 'pr-open', 'accepted', 'failed'].includes(state)) {
    g.tip_sha = SHA1;
  }
  if (state === 'pr-open' || state === 'accepted') {
    g.pr_url = 'https://github.com/xindong/mivo-canvas-plugin/pull/1';
    g.review = { rounds: 0, unresolved: 0 };
  }
  if (state === 'accepted') {
    g.provider_id = 'art';
    g.title = 'Skills-g4丨 0902';
  }
  if (['executing', 'e2e', 'review', 'pr-open', 'accepted'].includes(state)) {
    injectGateEvents(ledger, g.group_id);
  }
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** 完整合法链到 phase=packaging：两波全 verified + 集成 + 单向前进（→ready 测试的前置）。
 *  sc-p0a/b/c 迁移：v1（验收组）在 wave1 集成后派工——base 取最新集成点 SHA2（基线闸），
 *  render-packet 前置（凭证闸，验收组模板需严格更早的已集成波 = wave1） + --mem-snapshot。 */
function runGroupToAccepted(ledgerPath, group, branch, base = SHA3) {
  assignIdentity(ledgerPath, group, branch, base);
  renderGroup(ledgerPath, group);
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', `w-${group}`, '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', group, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, `${group} 合法链 ${to} 应 exit 0: ${r.stderr}`);
  }
  const handoff = prHandoffPayload(group, { ledgerPath, branch, pr_id: group === 'v1' ? 2 : 1 });
  let r = cli('record-delivery', ledgerPath, '--group', group, '--payload', JSON.stringify(handoff), '--now', T);
  assert.equal(r.status, 0, `${group} pr-handoff 交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', group, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, `${group} →pr-open 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', group, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, `${group} →accepted 应 exit 0: ${r.stderr}`);
}

function runFullChainToAccepting(ledgerPath) {
  runG4ToAccepted(ledgerPath);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  runGroupToAccepted(ledgerPath, 'v1', 'feat/verify', SHA2);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  for (const ph of ['dispatching', 'running', 'accepting']) {
    r = cli('set-state', ledgerPath, '--phase', ph, '--now', T);
    assert.equal(r.status, 0, `→${ph} 应 exit 0: ${r.stderr}`);
  }
}

function runFullChainToPackaging(ledgerPath) {
  return runFullChainToAccepting(ledgerPath);
}

/** g4 的合法 verify payload（sc_ids 取 manifest 该组 packet 的 id）。 */
function g4VerifyPayload() {
  const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const packet = manifest.dispatch.packets.find((p) => p.group_id === 'g4');
  return {
    scs: packet.scs_inline.map((s) => ({ sc_id: s.id, status: 'pass', evidence: `ev:${s.id}` })),
    integration_review: { status: 'pass', notes: 'ok' },
    candidate_sha: SHA1,
  };
}

// =====================================================================
// sc-p1c：init / validate
// =====================================================================
test('sc-p1c: init 产物过 validate（核心 hash 内容绑定自洽）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('validate', ledgerPath);
  assert.equal(r.status, 0, `validate 应 exit 0: ${r.stderr}`);
  assert.match(r.stdout, /OK/);
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.version, 0);
  assert.equal(ledger.phase, 'splitting');
  assert.equal(ledger.waves.length, 2);
  const w1 = ledger.waves.find((w) => w.wave === 1);
  assert.equal(w1.integrated_tip, null);
  const g4 = w1.groups.find((g) => g.group_id === 'g4');
  assert.deepEqual(g4.sc_ids, ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h']);
  assert.equal(g4.state, 'pending');
  assert.deepEqual(g4.review, { rounds: 0, unresolved: 0 });
  assert.deepEqual(g4.verify, { status: null, evidence_ref: null });
  assert.equal(ledger.manifest_core_hash, JSON.parse(readFileSync(ledger.manifest_path, 'utf8')).manifest_core_hash);
});

test('sc-p1c: manifest 改一字节后 validate exit 2 点名 hash 不匹配（旧台账配新 manifest 必拒）', () => {
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  // 改 manifest 一字节（content 绑定，不是路径/时间绑定）
  const text = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, text.replace('夹具 manifest', '夹具 manifest2'));
  const r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, 'hash 不匹配必须 exit 2');
  assert.match(r.stderr, /HASH_MISMATCH/);
  assert.match(r.stderr, /不匹配/);
});

// =====================================================================
// F-D（high）：manifest core-hash 只在 validate 检查——消费命令入口内容绑定
// =====================================================================
test('F-D: 篡改 manifest 后 render-packet exit 2 点名 HASH_MISMATCH（禁止拿旧 manifest 出包）', () => {
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  // init 后篡改台账指向的 manifest（同一路径，非 --manifest 覆盖）
  const text = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, text.replace('夹具 manifest', '夹具 manifest2'));
  const r = cli('render-packet', ledgerPath, '--group', 'g4');
  assert.equal(r.status, 2, '篡改 manifest 后 render-packet 必须 exit 2');
  assert.match(r.stderr, /HASH_MISMATCH/);
  assert.match(r.stderr, /manifest core hash 不匹配/);
  assert.equal(r.stdout, '', '不得出包（无正文输出）');
});

test('F-D: 篡改 manifest 后 record-delivery exit 2——同一 ledger 的合法交卷也不得入账', () => {
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  const text = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, text.replace('夹具 manifest', '夹具 manifest2'));
  const before = readFileSync(ledgerPath, 'utf8');
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(execDeliveryPayload()), '--now', T);
  assert.equal(r.status, 2, '篡改 manifest 后 record-delivery 必须 exit 2（内容绑定，禁止拿旧 manifest 干活）');
  assert.match(r.stderr, /HASH_MISMATCH/);
  assert.match(r.stderr, /record-delivery/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒收后台账字节必须不变');
});

test('F-D: --manifest 指向异本且 hash 不符 → 拒；同 hash 异本 → 放行', () => {
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  // 异本：复制后改一字节 → hash 不符 → 拒（resolve 后 != manifest_path 且不通过 hash 校验）
  const altPath = join(dir, 'alt-manifest.json');
  copyFileSync(manifestPath, altPath);
  const text = readFileSync(altPath, 'utf8');
  writeFileSync(altPath, text.replace('夹具 manifest', '夹具 manifest3'));
  let r = cli('render-packet', ledgerPath, '--group', 'g4', '--manifest', altPath);
  assert.equal(r.status, 2, '异本且 hash 不符必须 exit 2');
  assert.match(r.stderr, /HASH_MISMATCH/);
  // 同 hash 异本（字节相同的副本路径）→ 通过同一 hash 校验 → 放行
  const samePath = join(dir, 'same-manifest.json');
  copyFileSync(manifestPath, samePath);
  r = cli('render-packet', ledgerPath, '--group', 'g4', '--manifest', samePath);
  assert.equal(r.status, 0, `同 hash 异本应放行: ${r.stderr}`);
  assert.match(r.stdout, /用 goal skill 执行。/);
});

test('F-D: →ready 绑定 manifest 内容——最后一次 hash 绑定后篡改，receipt 驱动必须 exit 2 HASH_MISMATCH（台账 phase 不前进）', () => {
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  runFullChainToPackaging(ledgerPath);
  // 篡改 manifest（改 goal，保留 scs/packets 结构；台账 manifest_core_hash 记录的还是原内容）。
  // 时序 = 真实漏洞窗口：最后一次 hash 绑定写入（验收 record-delivery）之后、驱动 →ready 之前。
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.goal = '篡改后的 goal——台账 manifest_core_hash 记录的是原内容';
  writeFileSync(manifestPath, JSON.stringify(m));
  // 合法 receipt（version 绑定当前台账 + candidate_sha=wave2 集成树 SHA1）——唯一不满足的是 manifest 内容
  const curVer = readLedger(ledgerPath).version;
  const receiptPath = join(dir, 'ready-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ candidate_sha: SHA1, ledger_version: curVer, checked_at: T }));
  const r = cli('set-state', ledgerPath, '--phase', 'ready', '--ready-receipt', receiptPath, '--now', T);
  assert.equal(r.status, 2, '→ready 遇篡改 manifest 必须 exit 2（内容绑定拒，receipt 只绑 candidate_sha + ledger_version）');
  assert.match(r.stderr, /HASH_MISMATCH/);
  assert.match(r.stderr, /set-state →ready/);
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.phase, 'accepting', '被拒后台账 phase 必须仍为 accepting（ready 未达成，台账内可纠正）');
  assert.equal(ledger.version, curVer, '被拒后 version 不得前进（hash 拒绝在锁外直接 throw，不落事件）');
});

test('F-D: →ready manifest 绑定不误伤合法链——三重校验（manifest 内容/ledger_version/candidate_sha）各自独立成立', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  runFullChainToPackaging(ledgerPath);
  const writeReceipt = (content) => {
    const p = join(dir, 'ready-receipt.json');
    writeFileSync(p, JSON.stringify(content));
    return p;
  };
  // ① manifest 对 + receipt version 错 → 版本不匹配拒（receipt 校验独立生效，manifest 绑定不干扰）
  let r = cli('set-state', ledgerPath, '--phase', 'ready',
    '--ready-receipt', writeReceipt({ candidate_sha: SHA1, ledger_version: 0, checked_at: T }), '--now', T);
  assert.equal(r.status, 2, 'receipt ledger_version 不符必须 exit 2（防重放）');
  assert.match(r.stderr, /版本不匹配|ledger_version/);
  // ② manifest 对 + receipt candidate_sha 错 → 集成树不符拒（被拒尝试各落事件，version 已前进）
  let curVer = readLedger(ledgerPath).version;
  r = cli('set-state', ledgerPath, '--phase', 'ready',
    '--ready-receipt', writeReceipt({ candidate_sha: SHA3, ledger_version: curVer, checked_at: T }), '--now', T);
  assert.equal(r.status, 2, 'receipt candidate_sha 与集成树不符必须 exit 2（伪造拒）');
  assert.match(r.stderr, /candidate_sha|集成树/);
  // ③ 三者全对（manifest 未篡改 + 最新 version + candidate_sha=wave2 集成树）→ 放行
  curVer = readLedger(ledgerPath).version;
  r = cli('set-state', ledgerPath, '--phase', 'ready',
    '--ready-receipt', writeReceipt({ candidate_sha: SHA1, ledger_version: curVer, checked_at: T }), '--now', T);
  assert.equal(r.status, 0, `→ready 三重校验全对应 exit 0: ${r.stderr}`);
  const readyLedger = readLedger(ledgerPath);
  assert.equal(readyLedger.phase, 'ready');
  assert.equal(readyLedger.phase_at, T, 'phase→ready 凭据路径必须写 phase_at（F2 契约）');
});

// receipts 在场契约（缺陷 #2 回归守卫）：receipts 在 core hash 黑名单之外（append-only 追加不破坏
// 绑定），删它 hash 字节不变——init 后删除的通道只有「在场契约」能拦。判据收口于 readManifest
// （唯一入口），全部消费命令（init/validate/render-packet/record-delivery/set-state→ready）
// 自动继承，任何消费方不得另写一份存在性检查。
test('receipts 在场契约: →ready 前删 manifest.receipts 键（其余合法）→ 被点名拒绝，不得 phase=ready（在场契约非仅 init 校验）', (t) => {
  if (process.env.RL_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 F1/F2 变异无关，防污染其失败集契约）'); return; }
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  runFullChainToPackaging(ledgerPath);
  // 变异 = 删 receipts 键（替代 F-D →ready 测试的 goal 篡改）：receipts 被 core hash 黑名单剔除，
  // 删它 hash 一个字节都不变——这是缺陷机理里唯一能蒙混 →ready 的通道，必须由在场契约拦截。
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.receipts;
  writeFileSync(manifestPath, JSON.stringify(m));
  // 合法 receipt（version 绑定当前台账 + candidate_sha=wave2 集成树 SHA1）——唯一不满足的是 receipts 在场
  const curVer = readLedger(ledgerPath).version;
  const receiptPath = join(dir, 'ready-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ candidate_sha: SHA1, ledger_version: curVer, checked_at: T }));
  const r = cli('set-state', ledgerPath, '--phase', 'ready', '--ready-receipt', receiptPath, '--now', T);
  assert.equal(r.status, 2, '→ready 遇删 receipts 的 manifest 必须 exit 2（在场契约在 readManifest 收口，全部消费入口同判据）');
  assert.match(r.stderr, /MANIFEST/, '必须走 MANIFEST 拒绝路径（点名，不是下游 TypeError 兜底）');
  assert.match(r.stderr, /receipts/, '必须点名 receipts');
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.phase, 'accepting', '被拒后台账 phase 必须仍为 accepting（ready 未达成，台账内可纠正）');
  assert.equal(ledger.version, curVer, '被拒后 version 不得前进（在场拒绝在锁外直接 throw，不落事件）');
});

test('sc-p1c: 未列键注入 exit 2（exact 契约，schema 之外键出现即拒）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 直接往台账注入未知顶层键
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger._evil = 1;
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  let r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, '未知顶层键必须 exit 2');
  assert.match(r.stderr, /未列键/);
  assert.match(r.stderr, /_evil/);
  // 组级未知键同样拒
  const { ledgerPath: lp2 } = initLedgerFor(newTmpDir());
  const l2 = JSON.parse(readFileSync(lp2, 'utf8'));
  l2.waves[0].groups[0].hack = 'x';
  writeFileSync(lp2, JSON.stringify(l2));
  r = cli('set-state', lp2, '--group', 'g4', '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 2, '组级未知键必须 exit 2');
  assert.match(r.stderr, /未列键/);
});

test('sc-p1c: detail 契约——字符串 detail / 缺 group_id 键 / 组事件 group_id 空 各 exit 2 点名（F1 修复守卫）', () => {
  // 字符串 detail（旧形状）：ready-check 读 e.detail?.group_id 恒 undefined，分区对账形同虚设 → 拒
  let dir = newTmpDir();
  let { ledgerPath } = initLedgerFor(dir);
  let l = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  l.events.push({ type: 'dispatch', at: T, detail: 'group=g4 worker_label=w1' });
  writeFileSync(ledgerPath, JSON.stringify(l));
  let r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, '字符串 detail 必须 exit 2（写入即拒的守卫）');
  assert.match(r.stderr, /detail 必须是对象/);
  // 对象但缺 group_id 键
  dir = newTmpDir();
  ({ ledgerPath } = initLedgerFor(dir));
  l = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  l.events.push({ type: 'integrate', at: T, detail: { wave: 1, integrated_tip: SHA1 } });
  writeFileSync(ledgerPath, JSON.stringify(l));
  r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, 'detail 缺 group_id 键必须 exit 2');
  assert.match(r.stderr, /缺 group_id 键/);
  // 组上下文事件（delivery）group_id 为空 → ready-check ① 的 tip_sha 对账读不到组归属 → 拒
  dir = newTmpDir();
  ({ ledgerPath } = initLedgerFor(dir));
  l = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  l.events.push({ type: 'delivery', at: T, detail: { group_id: null, tip_sha: SHA1 } });
  writeFileSync(ledgerPath, JSON.stringify(l));
  r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, '组事件 group_id 空必须 exit 2');
  assert.match(r.stderr, /group_id 必须是非空字符串/);
});

test('CLI 参数错误统一 fail-closed：已移除 flag 点名 + 缺 ledger exit 2 + 无裸栈', () => {
  // F-F：--ready-check-exit0（布尔凭据已移除）——无 ledger 时 flag 顶位成位置参数，
  // 旧行为把值 `1` 当独立 token 报「非法参数: 1」裸栈 exit 1；现在必须点名 flag 名 + exit 2
  let r = cli('set-state', '--ready-check-exit0', '1');
  assert.equal(r.status, 2, '--ready-check-exit0 必须 exit 2（fail-closed 用码）');
  assert.match(r.stderr, /已移除/, '必须点名「已移除」语义');
  assert.match(r.stderr, /ready-check-exit0/, '必须点名 flag 名（而非其值）');
  assert.doesNotMatch(r.stderr, /at parseFlags|at runCli|\.mjs:\d+:\d+/, '不得含栈帧特征（受控拒绝，非崩溃）');
  // F-F：带 ledger 的完整命令同样点名
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  r = cli('set-state', ledgerPath, '--ready-check-exit0', '1', '--now', T);
  assert.equal(r.status, 2, '带 ledger 的 --ready-check-exit0 必须 exit 2');
  assert.match(r.stderr, /已移除/);
  // F-H：--verify-status / --verify-evidence-ref（手工写入口已移除）
  r = cli('set-state', '--verify-status', 'pass');
  assert.equal(r.status, 2, '--verify-status 必须 exit 2');
  assert.match(r.stderr, /已移除/, '必须点名「已移除」语义');
  assert.match(r.stderr, /verify-status/, '必须点名 flag 名');
  assert.doesNotMatch(r.stderr, /at parseFlags|at runCli|\.mjs:\d+:\d+/, '不得含栈帧特征');
  r = cli('set-state', '--verify-evidence-ref', 'delivery#1');
  assert.equal(r.status, 2, '--verify-evidence-ref 必须 exit 2');
  assert.match(r.stderr, /已移除/);
  // 缺 <ledger> 路径（validate 无参）：参数错误统一 exit 2 点名，不裸栈
  r = cli('validate');
  assert.equal(r.status, 2, 'validate 无参必须 exit 2（缺 ledger 是参数错误）');
  assert.match(r.stderr, /缺 <ledger>/);
  assert.doesNotMatch(r.stderr, /at parseFlags|at runCli|\.mjs:\d+:\d+/, '不得含栈帧特征');
  // 非 flag token（多余位置参数）受控拒：exit 2 点名，不裸栈
  r = cli('validate', 'L.json', 'extra');
  assert.equal(r.status, 2, '多余位置参数必须 exit 2');
  assert.match(r.stderr, /非法参数: extra/);
  assert.doesNotMatch(r.stderr, /at parseFlags|at runCli|\.mjs:\d+:\d+/, '不得含栈帧特征');
});

test('sc-p1c: init 遇 manifest 组缺 sc_ids 数组 exit 2（禁止静默空组）', () => {
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.waves[0].groups[0].sc_ids;
  writeFileSync(manifestPath, JSON.stringify(m));
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 2, '组缺 sc_ids 必须 exit 2（fail-closed）');
  assert.match(r.stderr, /MANIFEST/, '必须走 MANIFEST 拒绝路径（点名，不是下游 TypeError 兜底）');
  assert.match(r.stderr, /缺少 sc_ids/);
  assert.equal(existsSync(ledgerPath), false, 'init 失败不得创建台账');
});

// r-g7 F6：receipts 形状契约（形状随便写都能过是 F6 落地前的历史状态，本组用例冻结形状校验）。
// 契约（与 task-priority final-gate 产出逐字对齐）：存在时必须是非空数组，每条
// exact 键 { slug, manifest_core_hash, plan_hash, recorded_at }，双 hash 为 64 位十六进制（sha256）。
// 在场契约另行收口于 readManifest（同一判据唯一入口：init 与全部后继消费命令统一要求 receipts 键在场，
// 可空数组；init 后删除由「receipts 在场契约」用例冻结）；readManifest 统一拒坏形状
// （init/validate/render-packet/record-delivery/set-state→ready 全入口）。
// 变异反证：挖掉 readManifest 里的 assertReceiptsSchema 调用 → ①②③ 全红（init 放行坏形状），恰红本用例。
// 子套件跳过（机制同 ready-check 的 RC_MUTATION_CHILD）：F1/F2 变异子套件的失败集契约与 receipts 无关；
// 不跳过会让「父树在途的其他变异（如挖掉 receipts 校验）」被拷贝进子套件 → 污染预测红集。
test('sc-receipts: manifest.receipts 形状校验——坏形状 init 拒、合法形状通过（在场契约另行收口于 readManifest）', (t) => {
  if (process.env.RL_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 F1/F2 变异无关，防污染其失败集契约）'); return; }
  const SHA64 = 'e'.repeat(64);
  // ① 非数组 receipts → exit 2 点名
  {
    const dir = newTmpDir();
    const ledgerPath = join(dir, 'ledger.json');
    const manifestPath = fixtureCopy(dir);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.receipts = 'not-an-array';
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
    assert.equal(r.status, 2, 'receipts 非数组必须 exit 2');
    assert.match(r.stderr, /receipts 必须是数组/, `应点名 receipts 必须是数组: ${r.stderr}`);
  }
  // ② 条目未知键 → 拒（exact 契约）
  {
    const dir = newTmpDir();
    const ledgerPath = join(dir, 'ledger.json');
    const manifestPath = fixtureCopy(dir);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.receipts = [{ slug: 's', manifest_core_hash: SHA64, plan_hash: SHA64, recorded_at: T, extra: 1 }];
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
    assert.equal(r.status, 2, 'receipt 未知键必须 exit 2');
    assert.match(r.stderr, /未列键: extra/, `应点名未知键 extra: ${r.stderr}`);
  }
  // ③ 条目 hash 非 64 位十六进制 → 拒
  {
    const dir = newTmpDir();
    const ledgerPath = join(dir, 'ledger.json');
    const manifestPath = fixtureCopy(dir);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.receipts = [{ slug: 's', manifest_core_hash: 'short', plan_hash: SHA64, recorded_at: T }];
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
    assert.equal(r.status, 2, 'receipt hash 非 64hex 必须 exit 2');
    assert.match(r.stderr, /manifest_core_hash 必须是 64 位十六进制/);
  }
  // ④ 合法形状 → exit 0（append-only 多条同样合法；键在场要求由 readManifest 在场契约把关，
  // 基线夹具本就含 receipts 键）
  {
    const dir = newTmpDir();
    const ledgerPath = join(dir, 'ledger.json');
    const manifestPath = fixtureCopy(dir);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    m.receipts = [
      { slug: 'run-a', manifest_core_hash: SHA64, plan_hash: SHA64, recorded_at: T },
      { slug: 'run-b', manifest_core_hash: SHA64, plan_hash: SHA64, recorded_at: T },
    ];
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
    assert.equal(r.status, 0, `合法 receipts 应 exit 0: ${r.stderr}`);
  }
});

test('sc-p1c: 写盘中断模拟（写 tmp 后不 rename）不污染原台账', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerForClean(dir);
  const before = readFileSync(ledgerPath, 'utf8');
  // 模拟写盘中断：tmp 已写、rename 未发生
  writeTmp(ledgerPath, '{"broken": true}');
  // 原台账未被污染：字节不变、仍可正常读
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '写 tmp 后不 rename，原台账必须字节不变');
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.version, 0);
  // 后续写路径正常（新 tmp 覆盖残留，rename 原子替换）
  writeLedgerAtomic(ledgerPath, ledger.version, (cur) => ({ ...cur, version: ledger.version + 1 }));
  assert.equal(readLedger(ledgerPath).version, 1, '残留 tmp 不应阻碍后续原子写');
  // renameTmp 语义：把 tmp 内容原子替换到主文件
  writeTmp(ledgerPath, '{"x":1}');
  renameTmp(ledgerPath);
  assert.equal(readFileSync(ledgerPath, 'utf8'), '{"x":1}');
});

test('sc-p1c: CAS 冲突模拟（expected version 落后）exit 2 且原台账未被覆盖', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerForClean(dir);
  const first = readLedger(ledgerPath); // version=0，调用方读到 expected=0
  // 他写者插入：version 0 → 1（合法原子写）
  writeLedgerAtomic(ledgerPath, 0, (cur) => ({ ...cur, version: 1 }));
  // 原调用方仍持 expected=0 提交 → CAS 冲突，绝不静默覆盖
  assert.throws(
    () => writeLedgerAtomic(ledgerPath, first.version, (cur) => ({ ...cur, version: first.version + 1 })),
    (err) => err.code === 'CAS_CONFLICT' && /乐观锁冲突/.test(err.message),
    'expected version 落后必须抛 CAS_CONFLICT'
  );
  assert.equal(readLedger(ledgerPath).version, 1, 'CAS 冲突后原台账（他写者版本）不得被覆盖');
  const evCount = readLedger(ledgerPath).events.length;
  assert.equal(evCount, 0);
});

// =====================================================================
// F-C（high）：所谓 CAS 不是原子 compare-and-swap——独占锁 + 唯一 tmp
// =====================================================================
test('F-C: tmp 名带 pid + 随机 nonce（并发写者不共享同一 tmp 路径）', () => {
  const a = tmpPath('/x/ledger.json');
  const b = tmpPath('/x/ledger.json');
  assert.ok(a.startsWith('/x/ledger.json.tmp.'), `tmp 名必须带 .tmp. 前缀: ${a}`);
  assert.ok(a.includes(`.${process.pid}.`), `tmp 名必须带 pid: ${a}`);
  assert.notEqual(a, b, '两次 tmpPath 必须不同（随机 nonce，杜绝共享路径互相覆盖）');
});

test('F-C: 锁可正常获取与释放（无竞争者），释放后可重取', () => {
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  const lockPath = acquireLedgerLock(ledgerPath);
  assert.equal(existsSync(lockPath), true, '获取后锁文件必须存在');
  assert.equal(readFileSync(lockPath, 'utf8').trim(), String(process.pid), '锁文件必须记录持锁 pid');
  releaseLedgerLock(lockPath);
  assert.equal(existsSync(lockPath), false, '释放后锁文件必须删除');
  const lockPath2 = acquireLedgerLock(ledgerPath, 150);
  releaseLedgerLock(lockPath2);
});

test('F-C: acquireLedgerLock 拿不到锁超时抛 LOCK_TIMEOUT（函数层，短超时 fail-closed）', () => {
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  // 模拟他写者持锁：锁文件存在且 pid 为当前活进程 → 永远不会被判定为陈旧 → 重试至超时
  writeFileSync(`${ledgerPath}.lock`, `${process.pid}\n`);
  assert.throws(
    () => acquireLedgerLock(ledgerPath, 120),
    (err) => err.code === 'LOCK_TIMEOUT' && /等待超时/.test(err.message),
    '持锁中超时必须抛 LOCK_TIMEOUT（fail-closed，点名）'
  );
});

test('F-C: 持锁中写操作 exit 2 点名 LOCK_TIMEOUT 且台账未被写入', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 先满足 sc-p0b/c 派工前置（身份+render+快照），让写路径真正走到锁获取处——
  // 否则凭证闸在锁外先拒（PRECONDITION），测不到 LOCK_TIMEOUT。
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  const verBefore = readLedger(ledgerPath).version;
  // 模拟他写者持锁（活 pid）
  writeFileSync(`${ledgerPath}.lock`, `${process.pid}\n`);
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 2, '持锁中写必须 exit 2（fail-closed，拿不到锁不得继续）');
  assert.match(r.stderr, /LOCK_TIMEOUT/);
  assert.match(r.stderr, /lock/);
  assert.equal(readLedger(ledgerPath).version, verBefore, '持锁失败后台账必须未被写入');
});

test('F-C: 两个进程真实竞态——成功数 == version 增量，且每个报成功的写者回读到的都是自身的值', async () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerForClean(dir); // version=0
  // 子进程脚本：writeLedgerAtomic 的 buildNext 内停留 500ms（拉宽临界区制造真实重叠——
  // 修复前无锁时两进程都会在各自 buildNext 里读到 version=0 并先后 rename，双双报成功）；
  // 返回后立即回读磁盘：报成功的写者必须读到自己的 marker（落盘绑定）。
  const childSrc = `
    import { writeLedgerAtomic, readLedger, LedgerError } from ${JSON.stringify(`file://${SCRIPT}`)};
    const ledgerPath = process.argv[2];
    const marker = process.argv[3];
    const expected = Number(process.argv[4]);
    try {
      writeLedgerAtomic(ledgerPath, expected, (cur) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        return { ...cur, slug: marker, version: expected + 1 };
      });
      const disk = readLedger(ledgerPath);
      if (disk.slug !== marker) {
        console.error('READBACK_MISMATCH ' + marker + ' disk_slug=' + disk.slug);
        process.exit(3);
      }
      console.log('OK ' + marker + ' version=' + disk.version);
      process.exit(0);
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'CAS_CONFLICT') {
        console.log('CAS_CONFLICT ' + marker);
        process.exit(2);
      }
      console.error('UNEXPECTED ' + marker + ' code=' + (err.code || '') + ' msg=' + err.message);
      process.exit(4);
    }
  `;
  const childFile = join(dir, 'race-child.mjs');
  writeFileSync(childFile, childSrc);
  const run = (marker) => new Promise((res) => {
    const p = spawn(process.execPath, [childFile, ledgerPath, marker, '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ marker, code, out: out.trim(), err: err.trim() }));
  });
  const results = await Promise.all([run('writer-A'), run('writer-B')]);
  // 成功数 == version 增量（0→1，恰 1 个成功；修复前两个都报成功 → 此断言红）
  const oks = results.filter((r) => r.code === 0 && r.out.startsWith('OK'));
  const conflicts = results.filter((r) => r.code === 2 && r.out.startsWith('CAS_CONFLICT'));
  assert.equal(oks.length, 1, `成功写者必须恰 1 个（version 增量 1）：${JSON.stringify(results)}`);
  assert.equal(conflicts.length, 1, `失败方必须以 CAS_CONFLICT 收场（exit 2 点名）：${JSON.stringify(results)}`);
  // 最终落盘 = 报成功写者的值（每个报成功的写者回读到的都是自身的值——磁盘侧再验一遍）
  const disk = readLedger(ledgerPath);
  assert.equal(disk.version, 1, 'version 必须恰好 +1（两个写者只允许一次成功落地）');
  assert.equal(disk.slug, oks[0].marker, `落盘值必须是报成功写者 ${oks[0].marker} 的值（读回绑定）`);
});

test('sc-p1c: 未知 event type 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', 'bogus_event', '--now', T);
  assert.equal(r.status, 2, '未知 event type 必须 exit 2');
  assert.match(r.stderr, /--event/);
});

test('sc-p1c: integrated_tip 非 40hex 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', 'not-a-sha', '--now', T);
  assert.equal(r.status, 2, '非 40hex integrated_tip 必须 exit 2');
  assert.match(r.stderr, /integrated_tip 非 40 位十六进制/);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA39, '--now', T);
  assert.equal(r.status, 2, '39 位 integrated_tip 必须 exit 2');
});

test('sc-p1c: 无 --now 的写操作拒绝（init/set-state/record-delivery 全拒）', () => {
  const dir = newTmpDir();
  const manifestPath = fixtureCopy(dir);
  const ledgerPath = join(dir, 'ledger.json');
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x');
  assert.equal(r.status, 2, 'init 无 --now 必须 exit 2');
  assert.match(r.stderr, /--now/);
  assert.equal(existsSync(ledgerPath), false, '无 --now 的 init 不得创建台账');
  const { ledgerPath: lp2 } = initLedgerFor(dir);
  r = cli('set-state', lp2, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w');
  assert.equal(r.status, 2, 'set-state 无 --now 必须 exit 2');
  r = cli('record-delivery', lp2, '--group', 'g4', '--payload', JSON.stringify(execDeliveryPayload()));
  assert.equal(r.status, 2, 'record-delivery 无 --now 必须 exit 2');
});

// =====================================================================
// sc-p1d：set-state 组状态机 + phase 状态机 + wave 集成
// =====================================================================
test('sc-p1d: 合法链全通（dispatched→executing→e2e→review→pr-open→accepted）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  runG4ToAccepted(ledgerPath);
  const ledger = readLedger(ledgerPath);
  const g4 = ledger.waves[0].groups[0];
  assert.equal(g4.state, 'accepted');
  assert.equal(g4.worker_label, 'w1');
  assert.equal(g4.session_id, 'sess-g4');
  assert.equal(g4.tip_sha, SHA1);
  assert.match(g4.pr_url, /github\.com/);
  const types = ledger.events.map((e) => e.type);
  assert.ok(types.includes('dispatch'));
  assert.ok(types.includes('session_created'));
  assert.ok(types.includes('gate_goal'));
  assert.ok(types.includes('gate_routing'));
  assert.ok(types.includes('delivery'));
  assert.ok(types.includes('pr_opened'));
  assert.ok(types.includes('accepted'));
});

test('sc-p1d: dispatched→executing 缺 gate_goal 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  const g = 'g4';
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'executing', '--now', T);
  assert.equal(r.status, 2, '缺 gate_goal 必须 exit 2');
  assert.match(r.stderr, /gate_goal/);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'dispatched');
});

test('sc-p1d: executing→e2e 缺 gate_routing 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  const g = 'g4';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  const r = cli('set-state', ledgerPath, '--group', g, '--to', 'e2e', '--now', T);
  assert.equal(r.status, 2, '缺 gate_routing 必须 exit 2');
  assert.match(r.stderr, /gate_routing/);
});

test('sc-p1d: unresolved>0 时 accepted 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  const g = 'g4';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  const handoff = prHandoffPayload(g, { ledgerPath, unresolved: 2 });
  let r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(handoff), '--now', T);
  assert.equal(r.status, 0, `pr-handoff 交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 2, 'unresolved>0 时 accepted 必须 exit 2');
  assert.match(r.stderr, /unresolved==0/);
});

test('sc-p1d: 非法跳转矩阵全部 exit 2 且落 illegal_transition 事件', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  const before = readLedger(ledgerPath).events.length;

  // 阶段 A：pending 上的非法目标（failed 缺 --event 也拒）
  for (const to of ['executing', 'e2e', 'review', 'pr-open', 'accepted', 'pending', 'failed']) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, '--now', T);
    assert.equal(r.status, 2, `pending→${to} 必须 exit 2`);
  }
  // 阶段 B：dispatched 上的非法目标
  assignIdentity(ledgerPath, g, 'feat/run-ledger');
  renderGroup(ledgerPath, g);
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  for (const to of ['review', 'pr-open', 'accepted', 'dispatched', 'pending']) {
    r = cli('set-state', ledgerPath, '--group', g, '--to', to, '--now', T);
    assert.equal(r.status, 2, `dispatched→${to} 必须 exit 2`);
  }
  // 阶段 C：走完到 accepted 后终态只读
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'executing', '--detail', gateGoalDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'e2e', '--detail', gateRoutingDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'review', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const handoff = prHandoffPayload(g, { ledgerPath });
  r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(handoff), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'evil', '--now', T);
  assert.equal(r.status, 2, 'accepted→dispatched 重放攻击必须 exit 2');
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pending', '--now', T);
  assert.equal(r.status, 2, 'accepted→pending 重放攻击必须 exit 2');

  const ledger = readLedger(ledgerPath);
  const illegal = ledger.events.filter((e) => e.type === 'illegal_transition');
  assert.ok(illegal.length >= before + 14, `应至少落 ${before + 14} 条 illegal_transition，实际 ${illegal.length}`);
  assert.equal(ledger.waves[0].groups[0].state, 'accepted', '非法尝试不得改变组状态');
});

test('sc-p1d: failed→pending 后 rounds==0 且 tip_sha/worker_label/身份三键清空（重派不继承旧计数/旧身份）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  // 先分配身份（重派后必须被清空，render-packet 不得拿旧身份出包）
  assignIdentity(ledgerPath, g, 'feat/run-ledger');
  // sc-p0c 迁移：派工前 render-packet 出包（凭证闸前置，落 packet_rendered 事件）
  renderGroup(ledgerPath, g);
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1', '--mem-snapshot', memSnapshotJson()]],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 0, `→failed 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pending', '--now', T);
  assert.equal(r.status, 0, `failed→pending 应 exit 0: ${r.stderr}`);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.state, 'pending');
  assert.deepEqual(g4.review, { rounds: 0, unresolved: 0 }, '重派链计数必须归零');
  assert.equal(g4.tip_sha, null);
  assert.equal(g4.worker_label, null);
  assert.equal(g4.dispatched_at, null);
  // F-I：身份三键必须一并清空（旧身份残留 = render-packet 拿旧 worktree 出包漏洞）
  assert.equal(g4.worktree, null, '重派后 worktree 必须清空');
  assert.equal(g4.branch, null, '重派后 branch 必须清空');
  assert.equal(g4.base, null, '重派后 base 必须清空');
  assert.equal(g4.session_id, null, '重派后 session_id 必须清空');
  assert.equal(g4.title, null, '重派后 title 必须清空');
  assert.equal(g4.pr_url, null, '重派后 pr_url 必须清空');
  assert.equal(g4.provider_id, null, '重派后 provider_id 必须清空');
  // 重派后旧身份不可出包：render-packet 必须 NO_IDENTITY 拒（直到 lead 重新分配身份）
  r = cli('render-packet', ledgerPath, '--group', g);
  assert.equal(r.status, 2, '重派后未重新分配身份，render-packet 必须 exit 2');
  assert.match(r.stderr, /NO_IDENTITY/);
  assert.ok(!r.stdout.includes('/wt/g4'), '旧身份不得出现在出包正文');
  // 重新分配身份后可正常出包（重派闭环）
  assignIdentity(ledgerPath, g, 'feat/run-ledger-v2');
  r = cli('render-packet', ledgerPath, '--group', g);
  assert.equal(r.status, 0, `重派后重新分配身份，render-packet 应 exit 0: ${r.stderr}`);
  assert.match(r.stdout, /feat\/run-ledger-v2/);
});

test('sc-p1d: set-state --unresolved 一律拒（unresolved 唯一通道是审查交卷，无手工填数通道）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const args of [
    ['--group', 'g4', '--to', 'executing', '--unresolved', '0'],
    ['--group', 'g4', '--to', 'failed', '--event', 'timeout_redispatch', '--unresolved', '3'],
  ]) {
    const r = cli('set-state', ledgerPath, ...args, '--now', T);
    assert.equal(r.status, 2, `set-state ${args.join(' ')} 必须 exit 2`);
    assert.match(r.stderr, /record-delivery|手工填数/);
  }
  // 台账未被任何手工通道污染：review.unresolved 保持 0
  assert.deepEqual(readLedger(ledgerPath).waves[0].groups[0].review, { rounds: 0, unresolved: 0 });
});

test('sc-p1d: --identity 含空白字符拒（身份行空格分隔解析）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const bad of [
    { worktree: '/wt/group 1', branch: 'b', base: SHA3 },
    { worktree: '/wt/g', branch: 'feat/a b', base: SHA3 },
  ]) {
    const r = cli('set-state', ledgerPath, '--group', 'g4', '--identity', JSON.stringify(bad), '--now', T);
    assert.equal(r.status, 2, `identity ${JSON.stringify(bad)} 必须 exit 2`);
    assert.match(r.stderr, /空白/);
  }
});

test('sc-p1d: tip_sha 非 40hex 拒（任意字符串拒，格式校验）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // sc-p0a/b/c 迁移：合法派工前先身份+render+快照
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  for (const bad of ['xyz', SHA39, 'A'.repeat(40), '12345']) {
    r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'e2e', '--tip-sha', bad, '--now', T);
    assert.equal(r.status, 2, `tip_sha=${bad} 的非法跳转必须 exit 2`);
  }
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'dispatched');
});

test('sc-p1d: phase 跳步（splitting→running）拒并点名缺失前置', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('set-state', ledgerPath, '--phase', 'running', '--now', T);
  assert.equal(r.status, 2, 'phase 跳步必须 exit 2');
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
  assert.match(r.stderr, /splitting → running/);
  assert.match(r.stderr, /缺失前置|须依次经过/);
  // 非法尝试落事件（detail 结构化：相位级无组上下文 → group_id 显式 null）
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.phase, 'splitting', '非法 phase 跳转不得改变 phase');
  const illegal = ledger.events.find((e) => e.type === 'illegal_transition');
  assert.ok(illegal, '非法尝试必须落 illegal_transition 事件');
  assert.ok(/phase/.test(illegal.detail.reason), '相位级拒绝的 reason 必须点名 phase 跳转');
  assert.equal(illegal.detail.group_id, null, '相位级拒绝无组上下文 → group_id 显式 null');
});

test('sc-p1d: phase 单向前进合法链 + 波次顺序门（F-E）+ →ready receipt 凭据（F-F）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  const v = 'v1';
  // →accepting 前置失败（本波全组未 pr-open/accepted）；splitting→dispatching 无组前置
  let r = cli('set-state', ledgerPath, '--phase', 'dispatching', '--now', T);
  assert.equal(r.status, 0, `→dispatching 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'running', '--now', T);
  assert.equal(r.status, 0, `→running 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'accepting', '--now', T);
  assert.equal(r.status, 2, '→accepting 前置未满足必须 exit 2');
  assert.match(r.stderr, /pr-open|accepted/);
  // F-E ② 波次顺序门：wave1 未集成前，wave2 组不可派工
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'dispatched', '--worker-label', 'wv1', '--now', T);
  assert.equal(r.status, 2, 'wave1 未集成时 wave2 派工必须 exit 2（session_id 或波次顺序门）');
  assert.match(r.stderr, /最早未集成|前波|session_id/);
  // 完整合法链：g4 → verified（凭据走验收交卷）→ wave1 集成；v1 → verified → wave2 集成
  // sc-p0a/b/c 迁移：v1 在 wave1 集成后派工——base 取最新集成点 SHA2（基线闸）+ render 前置 + 快照
  runG4ToVerified(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  runGroupToAccepted(ledgerPath, v, 'feat/verify', SHA2);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // 上面前置失败已把 phase 推到 running；此处只再走 accepting
  r = cli('set-state', ledgerPath, '--phase', 'accepting', '--now', T);
  assert.equal(r.status, 0, `→accepting（前置满足）应 exit 0: ${r.stderr}`);
  // F-F：--ready-check-exit0 布尔凭据已移除 → 必拒
  r = cli('set-state', ledgerPath, '--phase', 'ready', '--ready-check-exit0', '1', '--now', T);
  assert.equal(r.status, 2, '--ready-check-exit0 布尔凭据必须 exit 2（已移除）');
  assert.match(r.stderr, /--ready-check-exit0|已移除/);
  // F-F：→ready 无 receipt 拒
  r = cli('set-state', ledgerPath, '--phase', 'ready', '--now', T);
  assert.equal(r.status, 2, '→ready 无 receipt 必须 exit 2');
  assert.match(r.stderr, /ready-check|receipt/);
  // F-F：receipt 文件缺失/形状不符 → READY_RECEIPT 拒
  r = cli('set-state', ledgerPath, '--phase', 'ready', '--ready-receipt', join(dir, 'no-such-receipt.json'), '--now', T);
  assert.equal(r.status, 2, 'receipt 文件缺失必须 exit 2');
  assert.match(r.stderr, /READY_RECEIPT/);
  const writeReceipt = (content) => {
    const p = join(dir, 'ready-receipt.json');
    writeFileSync(p, JSON.stringify(content));
    return p;
  };
  // F-F：过期 receipt（ledger_version 不符，检查后发生过写操作）→ 拒
  r = cli('set-state', ledgerPath, '--phase', 'ready',
    '--ready-receipt', writeReceipt({ candidate_sha: SHA1, ledger_version: 0, checked_at: T }), '--now', T);
  assert.equal(r.status, 2, 'receipt ledger_version 与台账不符必须 exit 2（防重放）');
  assert.match(r.stderr, /版本不匹配|ledger_version/);
  // F-F：candidate_sha 与台账当前集成树不符 → 拒
  const curVer = readLedger(ledgerPath).version;
  r = cli('set-state', ledgerPath, '--phase', 'ready',
    '--ready-receipt', writeReceipt({ candidate_sha: SHA3, ledger_version: curVer, checked_at: T }), '--now', T);
  assert.equal(r.status, 2, 'receipt candidate_sha 与集成树不符必须 exit 2（伪造拒）');
  assert.match(r.stderr, /candidate_sha|集成树/);
  // F-F：合法 receipt（version 绑定 + candidate_sha=最终集成树 wave2 tip=SHA1）→ 通过。
  // 注意：前面被拒的尝试各落一条 illegal_transition 事件（版本已前进），合法 receipt
  // 必须用当前最新 version 签发——这正是「检查后任何写操作都使 receipt 失效」的语义。
  const freshVer = readLedger(ledgerPath).version;
  r = cli('set-state', ledgerPath, '--phase', 'ready',
    '--ready-receipt', writeReceipt({ candidate_sha: SHA1, ledger_version: freshVer, checked_at: T }), '--now', T);
  assert.equal(r.status, 0, `→ready 带合法 receipt 应 exit 0: ${r.stderr}`);
  const readyLedger = readLedger(ledgerPath);
  assert.equal(readyLedger.phase, 'ready');
  assert.equal(readyLedger.phase_at, T, 'phase→ready 凭据路径必须写 phase_at（F2 契约：ready 时点唯一记录）');
  // ready 达成后台账冻结（只读）：任何写操作拒
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 2, 'ready 相位达成后写操作必须 exit 2');
  assert.match(r.stderr, /FROZEN|冻结/);
});

test('sc-p1d: F-E ② 波次顺序门——wave1 未集成时 wave2 组派工必拒（跳过未完成前波开工）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 原漏洞路径：跳过 wave1（g4 不派工不集成），直接派 wave2 的 v1。
  // sc-p0a 迁移：集成前的 identity base=init 基线 SHA3（此时无集成点）；波次门先于凭证闸，
  // v1 无凭证也会先报「最早未集成」，故此处不 render（render 需要 wave1 已集成，验收组模板）。
  assignIdentity(ledgerPath, 'v1', 'feat/verify');
  const r = cli('set-state', ledgerPath, '--group', 'v1', '--to', 'dispatched', '--worker-label', 'wv1', '--now', T);
  assert.equal(r.status, 2, 'wave1 未集成时 wave2 派工必须 exit 2（波次顺序门）');
  assert.match(r.stderr, /最早未集成|前波/);
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.waves[0].groups[0].state, 'pending', 'wave1 g4 必须仍 pending');
  assert.equal(ledger.waves[1].groups[0].state, 'pending', 'wave2 v1 必须仍 pending（派工被顺序门拒）');
  // 对照：wave1 集成后 wave2 派工放行（合法链前半段）。
  // sc-p0a/b/c 迁移：v1 重分配身份（base=wave1 集成点 SHA2）+ render 前置（凭证闸）+ 快照
  runG4ToVerified(ledgerPath);
  let ok = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(ok.status, 0, ok.stderr);
  assignIdentity(ledgerPath, 'v1', 'feat/verify', SHA2);
  renderGroup(ledgerPath, 'v1');
  ok = cli('set-state', ledgerPath, '--group', 'v1', '--to', 'dispatched', '--worker-label', 'wv1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(ok.status, 0, `wave1 集成后 wave2 派工应 exit 0: ${ok.stderr}`);
});

/** 克隆组对象为新 id/state（波形保持 schema 合法，乱序对照用例的组形状构造）。
 *  state=dispatched 时 worker_label 必须非空（与 forgeG4State 同规则）。 */
function mkGroup(src, groupId, state, workerLabel = null) {
  return { ...src, group_id: groupId, state, worker_label: workerLabel };
}

// 以下三条是「同族第 3–5 处仍按数组顺序读 waves」的对照用例（前两处 renderPacket /
// latestIntegratedTip 已修，见 buildVerifyLedgerWithWaveOrder 的 D1 回归测试）：
// 每一处都是同一语义输入、仅 waves 数组排布不同（ordered / unordered），两组结果必须相同。
// 只有 ordered 正例的测试正是这些缺陷能藏进来的原因：数组顺序在有序输入下恰好等价于
// wave 数值，无照不见乱序下取错。台账经 init 建好后手工重排 waves（消费侧防御：
// assertLedgerSchema 有意容忍乱序，绕过 init 的手写台账也必须按数值读取）。

test('sc-p1d: 乱序/有序对照——在途波按 wave 数值取最大（activeWave 不取数组末位）', (t) => {
  // 与 F1/F2/G1/G2 变异无关，防污染其失败集契约（机制同下方 ready/receipts 系列测试）：
  // 本用例走 set-state 派工/phase 写路径，F1 变异（detail 字符串化）下场景 C 的 dispatch
  // 成功分支会红——但那红与 waves 顺序无关，子套件必须跳过本用例。
  if (process.env.RL_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 F1/F2/G1/G2 变异无关，防污染其失败集契约）'); return; }
  // 语义输入：w3/w1 在途（dispatched）、w2 全 pending、三波全未集成 → →accepting。
  // 正确：activeWave = w3（数值最大在途）→ 前波 = wave 1,2 未集成 → 点名「wave 1, 2」。
  // 修复前 unordered [w3,w2,w1]：reverse().find 取数组末位在途波 w1 → 前波名单变成「wave 3, 2」。
  for (const order of ['ordered', 'unordered']) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const g4 = ledger.waves[0].groups[0];
    const w1 = { wave: 1, integrated_tip: null, groups: [mkGroup(g4, 'g4', 'dispatched', 'w1')] };
    const w2 = { wave: 2, integrated_tip: null, groups: [mkGroup(g4, 'gx', 'pending')] };
    const w3 = { wave: 3, integrated_tip: null, groups: [mkGroup(g4, 'gy', 'dispatched', 'w3')] };
    ledger.waves = order === 'ordered' ? [w1, w2, w3] : [w3, w2, w1];
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    let r = cli('set-state', ledgerPath, '--phase', 'dispatching', '--now', T);
    assert.equal(r.status, 0, `[${order}] →dispatching 应 exit 0: ${r.stderr}`);
    r = cli('set-state', ledgerPath, '--phase', 'running', '--now', T);
    assert.equal(r.status, 0, `[${order}] →running 应 exit 0: ${r.stderr}`);
    r = cli('set-state', ledgerPath, '--phase', 'accepting', '--now', T);
    assert.equal(r.status, 2, `[${order}] →accepting 应 exit 2: ${r.stderr}`);
    // 前波集合必须 = {wave 1, wave 2}（在途波 = 数值最大 w3；输出顺序随数组遍历，无契约）
    assert.match(r.stderr, /未记录前波: wave (1, 2|2, 1)|未集成前波: wave (1, 2|2, 1)/,
      `[${order}] 前波集合必须 = {wave 1, wave 2}（修复前 unordered 取数组末位在途波 w1，前波集合变成 {3,2}）`);
    assert.ok(!/未集成前波: wave 3/.test(r.stderr),
      `[${order}] 前波集合不得含 wave 3（w3 是在途波本身，不是前波）`);
  }
});

test('sc-p1d: 乱序/有序对照——前波未集成检查按 wave 数值，不按数组位置', (t) => {
  if (process.env.RL_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 F1/F2/G1/G2 变异无关，防污染其失败集契约）'); return; }
  // 语义输入：w3 在途（dispatched）、w2 已集成（verified）、w1 未集成（pending）→ →accepting。
  // 正确：activeWave = w3 → 前波（wave<3）未集成 = w1 → 点名「未集成前波: wave 1」。
  // 修复前 unordered [w2,w3,w1]：activeWave 恰好取对（w3），但 indexOf+slice 取数组位置
  // 前波 [w2]（已集成）→ 漏报 w1 未集成，误判前波全集成（若 w3 全组 review_pass 将错误放行）。
  for (const order of ['ordered', 'unordered']) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const g4 = ledger.waves[0].groups[0];
    const verified = { ...g4, state: 'accepted', worker_label: 'w1', tip_sha: SHA1,
      review: { rounds: 2, unresolved: 0 }, verify: { status: 'pass', evidence_ref: null },
      worktree: '/wt/g4', branch: 'feat/run-ledger', base: SHA3 };
    const w1 = { wave: 1, integrated_tip: null, groups: [mkGroup(g4, 'gx', 'pending')] };
    const w2 = { wave: 2, integrated_tip: SHA2, groups: [verified] };
    const w3 = { wave: 3, integrated_tip: null, groups: [mkGroup(g4, 'gy', 'dispatched', 'w3')] };
    ledger.waves = order === 'ordered' ? [w1, w2, w3] : [w2, w3, w1];
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    let r = cli('set-state', ledgerPath, '--phase', 'dispatching', '--now', T);
    assert.equal(r.status, 0, `[${order}] →dispatching 应 exit 0: ${r.stderr}`);
    r = cli('set-state', ledgerPath, '--phase', 'running', '--now', T);
    assert.equal(r.status, 0, `[${order}] →running 应 exit 0: ${r.stderr}`);
    r = cli('set-state', ledgerPath, '--phase', 'accepting', '--now', T);
    assert.equal(r.status, 2, `[${order}] →accepting 应 exit 2: ${r.stderr}`);
    assert.match(r.stderr, /未记录前波: wave 1|未集成前波: wave 1/,
      `[${order}] 前波必须按 wave 数值（<3 的未集成波 = wave 1），不得按数组位置（修复前 unordered 漏报 w1）`);
  }
});

test('sc-p1d: 乱序/有序对照——派工前沿按 wave 数值取最早未集成（firstUnintegrated 不取数组首位）', (t) => {
  if (process.env.RL_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 F1/F2/G1/G2 变异无关，防污染其失败集契约）'); return; }
  // 语义输入：v1 组在 wave1（未集成）、wave2 已集成、wave3 未集成空波 → 派 v1 组。
  // 正确：数值最小未集成波 = wave1 = v1 所在波 → 放行 exit 0。
  // 修复前 unordered [w2,w3,w1]：find 取数组首位未集成波 w3 → 误拒合法派工（wave 1 本就是最早未集成）。
  for (const order of ['ordered', 'unordered']) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const g4 = ledger.waves[0].groups[0];
    Object.assign(g4, { state: 'accepted', worker_label: 'w1', tip_sha: SHA1,
      review: { rounds: 2, unresolved: 0 }, verify: { status: 'pass', evidence_ref: null },
      worktree: '/wt/g4', branch: 'feat/run-ledger', base: SHA3 });
    const v1 = ledger.waves[1].groups[0];
    // sc-p0a 迁移：v1 在 wave1（手工构造）、wave2 已集成——期望基线 = wave2 集成点 SHA2，
    // v1 身份 base 必须等于 SHA2（基线闸消费点①）；v1 是验收组且无更早已集成波，无法经
    // render-packet 出包（NO_INTEGRATED）——凭证闸的凭证事件手工注入（夹具构造手段，
    // digest 按当前身份现算；本用例语义是测派工前沿波次门，不是测凭证闸）。
    v1.worktree = '/wt/v1';
    v1.branch = 'feat/verify';
    v1.base = SHA2;
    v1.session_id = 'sess-v1';
    v1.assignment_seq = 0;
    ledger.events.push({
      type: 'packet_rendered', at: T,
      detail: {
        group_id: 'v1',
        identity_digest: identityDigest({ worktree: '/wt/v1', branch: 'feat/verify', base: SHA2, session_id: 'sess-v1', assignmentSeq: 0 }),
        packet_sha256: 'f'.repeat(16),
        assignment_seq: 0,
      },
    });
    const w1 = { wave: 1, integrated_tip: null, groups: [v1] };
    const w2 = { wave: 2, integrated_tip: SHA2, groups: [g4] };
    const w3 = { wave: 3, integrated_tip: null, groups: [mkGroup(g4, 'gy', 'pending')] };
    ledger.waves = order === 'ordered' ? [w1, w2, w3] : [w2, w3, w1];
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const r = cli('set-state', ledgerPath, '--group', 'v1', '--to', 'dispatched', '--worker-label', 'wv1', '--mem-snapshot', memSnapshotJson(), '--now', T);
    assert.equal(r.status, 0, `[${order}] v1 在数值最小未集成波，派工应放行: ${r.stderr}`);
  }
});

test('sc-p1d: F-E 顺序门反例——伪造台账（v1 已 verified、wave1 未集成）→ phase 推进必拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerForClean(dir);
  // 手工构造：wave2 v1 走到 verified（伪造），wave1 g4 仍 pending 未集成
  const ledger = readLedger(ledgerPath);
  const v1 = ledger.waves[1].groups[0];
  v1.state = 'accepted';
  v1.worker_label = 'wv1';
  v1.tip_sha = SHA1;
  v1.review = { rounds: 2, unresolved: 0 };
  v1.verify = { status: 'pass', evidence_ref: null }; // 伪造：无交付证据（schema 层不查，verified 前置查）
  v1.worktree = '/wt/v1';
  v1.branch = 'feat/verify';
  v1.base = SHA3;
  ledger.waves[1].integrated_tip = SHA1;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  // 前置：phase 已到 reviewing（单步推进）
  let r = cli('set-state', ledgerPath, '--phase', 'dispatching', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--phase', 'running', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // F-E ③：→accepting 要求所有前波已记录合并顺序——wave1 未记录 → 拒
  r = cli('set-state', ledgerPath, '--phase', 'accepting', '--now', T);
  assert.equal(r.status, 2, 'wave1 未记录合并顺序时 →accepting 必须 exit 2（前波未记录）');
  assert.match(r.stderr, /前波已记录|未记录前波|未集成前波|前波已集成/);
  assert.equal(readLedger(ledgerPath).phase, 'running', '被拒的 phase 跳转不得改变 phase');
});

test('sc-p1d: F-E 空结构 fail-closed——空 waves/groups/sc_ids 在 init 与 validate 均拒', () => {
  // init 侧：manifest 空 waves / 空 groups / 空 sc_ids 全拒（MANIFEST，不建台账）
  for (const [label, mutate] of [
    ['空 waves', (m) => { m.waves = []; }],
    ['空 groups', (m) => { m.waves[0].groups = []; }],
    ['空 sc_ids', (m) => { m.waves[0].groups[0].sc_ids = []; }],
  ]) {
    const dir = newTmpDir();
    const ledgerPath = join(dir, 'ledger.json');
    const manifestPath = fixtureCopy(dir);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    mutate(m);
    writeFileSync(manifestPath, JSON.stringify(m));
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
    assert.equal(r.status, 2, `${label} 的 init 必须 exit 2（fail-closed）`);
    assert.match(r.stderr, /MANIFEST/, `${label} 必须走 MANIFEST 拒绝路径`);
    assert.equal(existsSync(ledgerPath), false, `${label} 的 init 不得创建台账`);
  }
  // validate 侧：手工把台账改成空结构 → readLedger（validate 前置）拒
  for (const [label, mutate] of [
    ['空 waves', (l) => { l.waves = []; }],
    ['空 groups', (l) => { l.waves[0].groups = []; }],
    ['空 sc_ids', (l) => { l.waves[0].groups[0].sc_ids = []; }],
  ]) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const l = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    mutate(l);
    writeFileSync(ledgerPath, JSON.stringify(l));
    const r = cli('validate', ledgerPath);
    assert.equal(r.status, 2, `${label} 的 validate 必须 exit 2（fail-closed）`);
    assert.match(r.stderr, /SCHEMA/, `${label} 必须走 SCHEMA 拒绝路径`);
  }
});

// =====================================================================
// init 输入门：顶层三要素 exact 在场 + 逐 packet 完整性（SKILL.md ② 段「缺任一 → 不开跑」）
// ——判据与 render-packet 出包前共用同一份实现（assertPacketComplete），init 就该拒，
// 不是「先开跑、出包时才炸」；被拒的 init 不写台账（连空台账都不留）。
// =====================================================================
test('init 输入门: manifest 缺 receipts 键 exit 2 点名且不建台账（receipts 可空数组但键必须存在——「已考虑过这一项」）', (t) => {
  if (process.env.RL_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 F1/F2/G1/G2 变异无关，防污染其失败集契约）'); return; }
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.receipts;
  writeFileSync(manifestPath, JSON.stringify(m));
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 2, '缺 receipts 键必须 exit 2（fail-closed 不开跑）');
  assert.match(r.stderr, /MANIFEST/, '必须走 MANIFEST 拒绝路径');
  assert.match(r.stderr, /receipts/, '必须点名 receipts');
  assert.equal(existsSync(ledgerPath), false, '被拒的 init 不得创建台账（连空台账都不留）');
  assert.equal(existsSync(`${ledgerPath}.lock`), false, '被拒的 init 不得残留锁文件');
});

test('init 输入门: manifest 缺 dispatch 键 exit 2 点名且不建台账', () => {
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.dispatch;
  writeFileSync(manifestPath, JSON.stringify(m));
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 2, '缺 dispatch 键必须 exit 2（fail-closed 不开跑）');
  assert.match(r.stderr, /MANIFEST/, '必须走 MANIFEST 拒绝路径');
  assert.match(r.stderr, /dispatch/, '必须点名 dispatch');
  assert.equal(existsSync(ledgerPath), false, '被拒的 init 不得创建台账');
  assert.equal(existsSync(`${ledgerPath}.lock`), false, '被拒的 init 不得残留锁文件');
});

test('init 输入门: packet 缺五要素任一 exit 2 点名是哪个 packet 缺哪一项且不建台账（与 render-packet 同判据）', () => {
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.dispatch.packets[0].allowed_paths;
  writeFileSync(manifestPath, JSON.stringify(m));
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 2, 'packet 缺 allowed_paths 必须 exit 2（fail-closed 不开跑）');
  assert.match(r.stderr, /PACKET_INCOMPLETE/, '必须走 PACKET_INCOMPLETE 拒绝路径');
  assert.match(r.stderr, /g4/, '必须点名是哪个 packet（group_id）');
  assert.match(r.stderr, /allowed_paths/, '必须点名缺哪一项');
  assert.equal(existsSync(ledgerPath), false, '被拒的 init 不得创建台账');
  assert.equal(existsSync(`${ledgerPath}.lock`), false, '被拒的 init 不得残留锁文件');
});

test('sc-p1d: wave 集成——非 40hex 拒、全组未 verified 拒、集成后可落账', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 前置不满足（g4 未 verified）→ 拒
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 2, 'wave 未全组 accepted 集成必须 exit 2');
  assert.match(r.stderr, /全组 accepted/);
  // 走完 g4 → 集成成功
  runG4ToVerified(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, `集成应 exit 0: ${r.stderr}`);
  let ledger = readLedger(ledgerPath);
  assert.equal(ledger.waves[0].integrated_tip, SHA2);
  assert.ok(ledger.events.some((e) => e.type === 'integrate' && e.detail.integrated_tip === SHA2),
    'integrate 事件 detail 必须结构化（integrated_tip 键）');
  assert.ok(ledger.events.some((e) => e.type === 'integrate' && e.detail.group_id === null),
    'wave 级事件无组上下文 → group_id 显式 null');
  // 重复集成拒（integrated_tip 集成后不再改）
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 2, '重复集成必须 exit 2');
  assert.match(r.stderr, /已集成/);
  ledger = readLedger(ledgerPath);
  assert.equal(ledger.waves[0].integrated_tip, SHA2, '重复集成不得改写 integrated_tip');
});

// =====================================================================
// sc-p1e：render-packet
// =====================================================================
test('sc-p1e: 五项逐项挖空各得 exit 2 点名（fail-closed 缺一不出包）', () => {
  for (const field of ['scs_inline', 'allowed_paths', 'verify_cmds', 'forbidden', 'submit_format']) {
    const dir = newTmpDir();
    // 完整夹具先 init，再篡改 + 同步台账 hash（init 输入门已拒不完整 manifest；hash 自洽
    // 才能命中 PACKET_INCOMPLETE 而非 F-D 门禁 HASH_MISMATCH——后者是另一个独立的拒因，
    // 由 F-D 专属测试覆盖）
    const { ledgerPath } = tamperManifestThenInit(dir, (m) => {
      const pkt = m.dispatch.packets.find((p) => p.group_id === 'g4');
      // 挖空该字段：「空缺」= 键缺失/空数组/空串（空数组对 allowed_paths/forbidden 是合法表达，
      // 挖空用删键；scs_inline/verify_cmds 空数组即空缺）
      if (field === 'scs_inline' || field === 'verify_cmds') {
        pkt[field] = [];
      } else {
        delete pkt[field];
      }
    });
    assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
    const r = cli('render-packet', ledgerPath, '--group', 'g4');
    assert.equal(r.status, 2, `挖空 ${field} 必须 exit 2`);
    assert.match(r.stderr, /PACKET_INCOMPLETE/);
    assert.match(r.stderr, new RegExp(field), `必须点名缺失字段 ${field}`);
    assert.equal(r.stdout, '', '缺项不得出包（无正文输出）');
  }
});

test('sc-p1e: pr-submit-gate 门禁结论透传——needs_three_review true/false 各渲染对应说明区', () => {
  for (const [flag, expected] of [
    [true, 'needs_three_review=true：本包对应功能改动（功能 PR），交付后须走 submit-pr 三审收口。'],
    [false, 'needs_three_review=false：本包对应非功能性改动，免 submit-pr 三审，常规验证照常。'],
  ]) {
    const dir = newTmpDir();
    // 完整夹具先 init，再改 needs_three_review + 同步台账 hash（init 后改会撞 F-D 门禁
    // HASH_MISMATCH，同步 hash 后渲染才命中目标判据）
    const { ledgerPath } = tamperManifestThenInit(dir, (m) => {
      m.dispatch.packets.find((p) => p.group_id === 'g4').needs_three_review = flag;
    });
    assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
    const r = cli('render-packet', ledgerPath, '--group', 'g4');
    assert.equal(r.status, 0, `needs_three_review=${flag} 应 exit 0: ${r.stderr}`);
    assert.match(r.stdout, /## pr-submit-gate 门禁/, `needs_three_review=${flag} 必须渲染门禁说明区`);
    assert.ok(r.stdout.includes(expected), `needs_three_review=${flag} 必须渲染对应结论（当前输出无「${expected}」）`);
  }
});

test('sc-p1e: needs_three_review 缺失/非布尔 exit 2 点名（fail-closed，禁止默认成 false）', () => {
  for (const [label, value] of [
    ['缺失', undefined],
    ['字符串', 'false'],
    ['数字', 0],
    ['null', null],
  ]) {
    const dir = newTmpDir();
    // 完整夹具先 init，再改 needs_three_review + 同步台账 hash（init 输入门已拒不完整
    // manifest；同步 hash 后渲染才命中目标判据而非 F-D 门禁）
    const { ledgerPath } = tamperManifestThenInit(dir, (m) => {
      const pkt = m.dispatch.packets.find((p) => p.group_id === 'g4');
      if (value === undefined) {
        delete pkt.needs_three_review;
      } else {
        pkt.needs_three_review = value;
      }
    });
    assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
    const r = cli('render-packet', ledgerPath, '--group', 'g4');
    assert.equal(r.status, 2, `${label} needs_three_review 必须 exit 2（禁止默认成 false 放行）`);
    assert.match(r.stderr, /PACKET_INCOMPLETE/, `${label} 必须走 PACKET_INCOMPLETE 拒绝路径`);
    assert.match(r.stderr, /needs_three_review/, `${label} 必须点名 needs_three_review`);
    assert.match(r.stderr, /禁止默认成 false/, `${label} 必须点名 fail-closed 语义（禁止默认成 false）`);
    assert.equal(r.stdout, '', `${label} 不得出包（无正文输出）`);
  }
});

test('probe 组走执行组模板：全 kind=probe 出包 exit 0 且带 goal 三要素（task-priority 首波 probe 池合法出包）', () => {
  const dir = newTmpDir();
  // 把 g4 全部 SC 的 kind 改成 probe（waves-plan 的 probe 池首波形态），同步 hash
  const { ledgerPath } = tamperManifestThenInit(dir, (m) => {
    const pkt = m.dispatch.packets.find((p) => p.group_id === 'g4');
    for (const sc of pkt.scs_inline) sc.kind = 'probe';
    for (const sc of m.scs) if (pkt.scs_inline.some((s) => s.id === sc.id)) sc.kind = 'probe';
  });
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  const r = cli('render-packet', ledgerPath, '--group', 'g4');
  assert.equal(r.status, 0, `全 probe 组必须出包 exit 0（曾误判 PACKET_INCOMPLETE 卡死首波）: ${r.stderr}`);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], '用 goal skill 执行。', 'probe 组走执行组模板：首行逐字');
  assert.equal(lines[1], '--until-sc', 'probe 组走执行组模板：--until-sc 独占一行');
  assert.match(r.stdout, /执行组/, 'probe 组包头必须标执行组');
});

test('probe+verify 混合组按执行组出包（probe 在场即执行组；该形态上游分池不产出，此处钉住判定方向）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = tamperManifestThenInit(dir, (m) => {
    const pkt = m.dispatch.packets.find((p) => p.group_id === 'g4');
    pkt.scs_inline.forEach((sc, i) => { sc.kind = i === 0 ? 'probe' : 'verify'; });
    for (const sc of m.scs) {
      const inl = pkt.scs_inline.find((s) => s.id === sc.id);
      if (inl) sc.kind = inl.kind;
    }
  });
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  const r = cli('render-packet', ledgerPath, '--group', 'g4');
  // 注意：probe 现在归入执行组判定（some(fix|probe)），混入 verify 不改变执行组判定，
  // 该形态由上游 waves-plan 保证不产出（probe 池与尾波池分池），此处按执行组出包。
  assert.equal(r.status, 0, `probe+verify 混合按执行组出包（probe 在场即执行组）: ${r.stderr}`);
  assert.equal(r.stdout.split('\n')[0], '用 goal skill 执行。');
});

test('sc-p1e: 完整包包含三要素——首行逐字「用 goal skill 执行。」、--until-sc 独占一行、身份行只认台账值', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  const r = cli('render-packet', ledgerPath, '--group', 'g4');
  assert.equal(r.status, 0, `render-packet 应 exit 0: ${r.stderr}`);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], '用 goal skill 执行。', '首行必须逐字等于「用 goal skill 执行。」');
  assert.equal(lines[1], '--until-sc', '--until-sc 必须独占一行');
  const identityLine = lines[2];
  assert.match(identityLine, /^worktree=\/wt\/g4 /, '身份行必须以台账 worktree 开头');
  assert.match(identityLine, /branch=feat\/run-ledger/, '身份行必须含台账 branch');
  assert.match(identityLine, new RegExp(`base=${SHA3}`), '身份行必须含台账 base');
  // 其余结构区块
  assert.match(r.stdout, /## SC 清单/);
  assert.match(r.stdout, /sc-p1c: /);
  assert.match(r.stdout, /## allowed_paths/);
  assert.match(r.stdout, /scripts\/run-ledger\.mjs/);
  assert.match(r.stdout, /## 禁做/);
  assert.match(r.stdout, /## 验证命令/);
  assert.match(r.stdout, /node scripts\/run-tests\.mjs/);
  assert.match(r.stdout, /## 交卷格式/);
});

test('sc-p1e: 身份未分配（台账无 worktree/branch/base）→ exit 2 拒出包', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('render-packet', ledgerPath, '--group', 'g4');
  assert.equal(r.status, 2, '身份未分配必须 exit 2');
  assert.match(r.stderr, /NO_IDENTITY/);
  assert.match(r.stderr, /set-state --identity/);
});

test('sc-p1e: CLI 传身份字段被拒（身份单一来源是台账，不接受 CLI 覆盖）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  for (const args of [
    ['--worktree', '/tmp/x'],
    ['--branch', 'evil'],
    ['--base', SHA1],
    ['--identity', JSON.stringify({ worktree: '/x', branch: 'b', base: SHA1 })],
  ]) {
    const r = cli('render-packet', ledgerPath, '--group', 'g4', ...args);
    assert.equal(r.status, 2, `CLI 传身份字段 ${args[0]} 必须 exit 2`);
    assert.match(r.stderr, /不接受 CLI 覆盖|单一来源/);
  }
});

test('sc-p1e: 验收组模板无 goal 触发行、含整合树复查项（integrated_tip 引用 + squash diff 复查指令）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // sc-p0a 迁移：v1 在 wave1 集成后派工/出包——身份 base 必须等于集成点 SHA2（基线闸），
  // 故 assign 移到集成后（集成前 assign 的 base=SHA3 会在 render 时被基线闸拒）。
  // 真实编排顺序（D1 修复语义）：包是派工输入，render 必须先于派工。
  // wave 1 集成后立刻出 v1 的包——验收组复查的是上一波集成出来的树，
  // 不是它自己所在 wave 的树（读本波 integrated_tip 必然为 null，off-by-one-wave 死锁）。
  runG4ToVerified(ledgerPath);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  assignIdentity(ledgerPath, 'v1', 'feat/verify', SHA2);
  r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 0, `验收组在上一波集成后立刻 render 应 exit 0: ${r.stderr}`);
  const out = r.stdout;
  assert.ok(!out.startsWith('用 goal skill 执行。'), '验收组模板不得带 goal 触发行');
  assert.ok(!out.includes('--until-sc'), '验收组模板不得带 --until-sc');
  assert.match(out, /只跑 verify 命令出 verdict，不改代码/);
  assert.match(out, /## pr-submit-gate 门禁/, '验收组模板必须同样渲染 pr-submit-gate 门禁说明区');
  assert.match(out, /needs_three_review=false/, '验收组模板必须渲染门禁结论（夹具 v1 packet=false）');
  assert.match(out, new RegExp(`integrated_tip=${SHA2}`),
    '整合树复查项必须引用严格早于本组的 wave 1 集成 tip（SHA2），而非本组所在 wave 2 的 integrated_tip');
  assert.match(out, /squash diff/, '整合树复查项必须含 squash diff 复查指令');
  assert.match(out, new RegExp(`integrated_tip=${SHA2}（wave 1 集成 squash SHA）`),
    '整合树复查项必须点名 tip 来自 wave 1 集成');
  // 出包之后才派工 v1 到 verified，然后集成 wave 2（真实顺序的剩余半程）。
  // sc-p0b：派工带 --mem-snapshot（凭证已在 render 时落账，digest 匹配）
  const v = 'v1';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'wv1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', v, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  r = cli('record-delivery', ledgerPath, '--group', v, '--payload', JSON.stringify(prHandoffPayload(v, { ledgerPath, branch: 'feat/verify' })), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
});

test('sc-p1e: 验收组无更早已集成 wave 时出包被点名拒（D2 fail-closed：组名/所在 wave/实际已集成最新 wave 三要素齐备）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'v1', 'feat/verify');
  // 可达实例①（正常夹具）：v1 在 wave 2，但 wave 1 尚未集成 → 严格更早的已集成 wave 不存在
  let r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 2, '严格更早的已集成 wave 不存在必须 exit 2');
  assert.match(r.stderr, /NO_INTEGRATED/);
  assert.match(r.stderr, /组 v1/, '拒绝消息必须点名组名');
  assert.match(r.stderr, /wave 2/, '拒绝消息必须点名组所在 wave');
  assert.match(r.stderr, /实际已集成的最新 wave: 无/, '拒绝消息必须如实报告已集成最新 wave 为无（不许回落 null/空串静默继续）');

  // 可达实例②：verify 组被放进 wave 1（D3 实测：消费侧 initLedger 无 kind/波次位置校验，
  // 手写 manifest 可把验收组排进首波，init 照常放行）→ 无严格更早集成波 → 同一点名拒
  const dir2 = newTmpDir();
  const m = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  m.waves = [{ wave: 1, groups: [{ group_id: 'v1', sc_ids: ['sc-v1a'], worker_count: 1 }] }];
  m.manifest_core_hash = manifestCoreHash(m);
  const manifestPath2 = join(dir2, 'sample-manifest.json');
  writeFileSync(manifestPath2, JSON.stringify(m));
  const ledgerPath2 = join(dir2, 'ledger.json');
  let r2 = cli('init', ledgerPath2, '--manifest', manifestPath2, '--run-id', 'test-run2', '--now', T, '--baseline', SHA3);
  assert.equal(r2.status, 0, `verify 进首波的 manifest init 应放行（消费侧无尾波保证，D3 确认）: ${r2.stderr}`);
  r2 = cli('set-state', ledgerPath2, '--group', 'v1', '--identity',
    JSON.stringify({ worktree: '/wt/v1', branch: 'feat/verify', base: SHA3 }), '--now', T);
  assert.equal(r2.status, 0, r2.stderr);
  r2 = cli('render-packet', ledgerPath2, '--group', 'v1');
  assert.equal(r2.status, 2, '验收组在首波、无更早集成波必须 exit 2');
  assert.match(r2.stderr, /NO_INTEGRATED/);
  assert.match(r2.stderr, /组 v1/, '拒绝消息必须点名组名');
  assert.match(r2.stderr, /wave 1/, '拒绝消息必须点名组所在 wave');
  assert.match(r2.stderr, /实际已集成的最新 wave: 无/, '拒绝消息必须如实报告已集成最新 wave 为无');
});

/**
 * 乱序对照用例的台账构造（D1 二阶缺陷回归）：同样的语义输入——v1 在 wave 4（验收组）、
 * wave 3 已集成 SHA2、wave 1 已集成 SHA1——只有 waves 数组排布不同（ordered=[1,3,4] /
 * unordered=[4,3,1]）。render-packet 必须都取到数值最新的 wave 3（SHA2），不依赖数组顺序。
 * 台账经 init 建好后手工重排 waves（本测试测的是消费侧防御：绕过 init 的手写乱序台账在
 * render-packet 也必须按数值取最新；manifest 边界乱序拒由下方 init 测试单独覆盖）。
 */
function buildVerifyLedgerWithWaveOrder(dir, order) {
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'v1', 'feat/verify');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const v1group = ledger.waves.find((w) => w.groups.some((g) => g.group_id === 'v1')).groups[0];
  // sc-p0a 迁移：手工构造后 wave3 集成 SHA2 = 期望基线——v1 身份 base 必须改为 SHA2
  // （基线闸消费点②：render-packet 出包时校验组 base === expectedBase）。
  v1group.base = SHA2;
  const mkWave = (wave, tip) => ({
    wave, integrated_tip: tip,
    groups: [{
      group_id: `x${wave}`, state: 'pending', sc_ids: [`sc-x${wave}`],
      worker_label: null, dispatched_at: null, tip_sha: null,
      review: { rounds: 0, unresolved: 0 }, verify: { status: null, evidence_ref: null },
      worktree: null, branch: null, base: null, session_id: null, title: null, pr_url: null, provider_id: null, assignment_seq: 0,
    }],
  });
  const w4 = { wave: 4, integrated_tip: null, groups: [v1group] };
  const w3 = mkWave(3, SHA2);
  const w1 = mkWave(1, SHA1);
  ledger.waves = order === 'ordered' ? [w1, w3, w4] : [w4, w3, w1];
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { ledgerPath };
}

test('sc-p1e: 乱序/有序对照——「严格早于且最新」按 wave 数值取最大，不按数组位置（D1 二阶回归）', () => {
  // 只有 ordered 正例的测试正是这条缺陷能藏进来的原因：数组末位在有序输入下恰好等于
  // 数值最大，无照不见乱序下取错波。对照用例两组都必须取到数值最新的那一波。
  for (const order of ['ordered', 'unordered']) {
    const dir = newTmpDir();
    const { ledgerPath } = buildVerifyLedgerWithWaveOrder(dir, order);
    const r = cli('render-packet', ledgerPath, '--group', 'v1');
    assert.equal(r.status, 0, `[${order}] render-packet 应 exit 0: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`integrated_tip=${SHA2}`),
      `[${order}] 必须取到数值最新的 wave 3 集成 tip（SHA2），而非数组末位的 wave 1（SHA1）`);
    assert.match(r.stdout, new RegExp(`integrated_tip=${SHA2}（wave 3 集成 squash SHA）`),
      `[${order}] 复查项必须点名 tip 来自 wave 3 集成`);
    assert.ok(!r.stdout.includes(`integrated_tip=${SHA1}`), `[${order}] 不得误取 wave 1 的 tip`);
  }
});

test('sc-p1e: 重复 wave 台账被 schema 点名拒（validate 读台账 fail-closed）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const g4g = ledger.waves[0].groups[0];
  const v1g = ledger.waves.find((w) => w.groups.some((g) => g.group_id === 'v1')).groups[0];
  ledger.waves = [
    { wave: 1, integrated_tip: null, groups: [g4g] },
    { wave: 1, integrated_tip: null, groups: [v1g] },
  ];
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, '重复 wave 台账必须 exit 2');
  assert.match(r.stderr, /SCHEMA/);
  assert.match(r.stderr, /重复 wave 编号: 1/, '拒绝消息必须点名重复的 wave 号');
});

test('sc-p1e: 重复 wave manifest 被 init 点名拒（manifest 边界 fail-closed）', () => {
  const dir = newTmpDir();
  const m = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  m.waves = [
    { wave: 1, groups: [{ group_id: 'g4', sc_ids: ['sc-p1c'], worker_count: 1 }] },
    { wave: 1, groups: [{ group_id: 'v1', sc_ids: ['sc-v1a'], worker_count: 1 }] },
  ];
  m.manifest_core_hash = manifestCoreHash(m);
  const manifestPath = join(dir, 'sample-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(m));
  const ledgerPath = join(dir, 'ledger.json');
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'dup-run', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 2, '重复 wave manifest init 必须 exit 2');
  assert.match(r.stderr, /MANIFEST/);
  assert.match(r.stderr, /重复 wave 编号: 1/, '拒绝消息必须点名重复的 wave 号');
  assert.ok(!existsSync(ledgerPath), 'init 拒后不得留下台账文件（校验失败不落盘）');
});

test('sc-p1e: 乱序 wave manifest 被 init 点名拒（逆序对进消息）', () => {
  const dir = newTmpDir();
  const m = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  m.waves = [
    { wave: 3, groups: [{ group_id: 'g4', sc_ids: ['sc-p1c'], worker_count: 1 }] },
    { wave: 1, groups: [{ group_id: 'v1', sc_ids: ['sc-v1a'], worker_count: 1 }] },
  ];
  m.manifest_core_hash = manifestCoreHash(m);
  const manifestPath = join(dir, 'sample-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(m));
  const ledgerPath = join(dir, 'ledger.json');
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'order-run', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 2, '乱序 wave manifest init 必须 exit 2');
  assert.match(r.stderr, /MANIFEST/);
  assert.match(r.stderr, /乱序: wave 3 之后出现 wave 1/, '拒绝消息必须点名逆序对');
  assert.ok(!existsSync(ledgerPath), 'init 拒后不得留下台账文件（校验失败不落盘）');
});

test('sc-p1e: T 阶段包 verify_cmds 与夹具 manifest 尾波逐条一致', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'sample-manifest.json'), 'utf8'));
  const lastWave = manifest.waves[manifest.waves.length - 1]; // 尾波 = wave 2
  const v1Group = lastWave.groups[0];
  const v1Packet = manifest.dispatch.packets.find((p) => p.group_id === v1Group.group_id);
  // sc-p0a/b/c 迁移：v1 在 wave1 集成后派工——base=集成点 SHA2（基线闸）+ render 前置
  // （凭证闸；验收组模板需 wave1 已集成）→ render 输出保存在派工前，出包后 wave2 集成
  // 会改变期望基线（SHA2→SHA1），此时不可再 render（基线闸拒）——断言用派工前输出。
  runG4ToVerified(ledgerPath);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const v = v1Group.group_id;
  assignIdentity(ledgerPath, v, 'feat/verify', SHA2);
  const packetOut = renderGroup(ledgerPath, v);
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'wv1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', v, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  r = cli('record-delivery', ledgerPath, '--group', v, '--payload', JSON.stringify(prHandoffPayload(v, { ledgerPath, branch: 'feat/verify' })), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // 渲染正文的验证命令必须与尾波 packet.verify_cmds 逐条一致（来自 manifest，不来自台账记忆）
  const renderedCmds = packetOut
    .split('\n')
    .filter((line) => v1Packet.verify_cmds.includes(line.trim()));
  assert.deepEqual(renderedCmds, v1Packet.verify_cmds, '渲染正文 verify_cmds 必须与尾波 packet 逐条一致');
});

// =====================================================================
// sc-p1h：record-delivery
// =====================================================================
function execDeliveryPayload({ tipSha = SHA1, status = 'done', ids = ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h'] } = {}) {
  return {
    status,
    tip_sha: tipSha,
    scs: ids.map((id) => ({ sc_id: id, status: 'pass', evidence: `verify 通过：${id}` })),
  };
}

test('lead-self: pending 组直接 record-delivery exec 被生命周期门拒绝', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(execDeliveryPayload()), '--now', T);
  assert.equal(r.status, 2, 'pending 直接交 exec 必须 exit 2');
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
  assert.match(r.stderr, /pending 不允许 exec/);
});

test('lead-self: worker-label=lead-self 逻辑派工后 exec 交卷成功（无真实 Orca worker）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'lead-self', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, `lead-self dispatched 应 exit 0: ${r.stderr}`);
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(execDeliveryPayload({ tipSha: SHA2 })), '--now', T);
  assert.equal(r.status, 0, `lead-self exec 交卷应 exit 0: ${r.stderr}`);
  const ledger = readLedger(ledgerPath);
  const g4 = ledger.waves[0].groups[0];
  assert.equal(g4.worker_label, 'lead-self');
  assert.equal(g4.tip_sha, SHA2);
  const dispatch = ledger.events.filter((e) => e.type === 'dispatch');
  assert.equal(dispatch.length, 1);
  assert.equal(dispatch[0].detail.worker_label, 'lead-self');
});

test('sc-p1h: 执行组合法交卷入账成功且台账对应字段逐项等于交卷值', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 生命周期门（① 升级）：exec 交卷只允许 dispatched/delivered——先派工到 dispatched
  // sc-p0a/b/c 迁移：合法派工前先身份+render（凭证闸前置）+快照（快照闸）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const payload = execDeliveryPayload({ tipSha: SHA2 });
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `执行组交卷应 exit 0: ${r.stderr}`);
  const ledger = readLedger(ledgerPath);
  const g4 = ledger.waves[0].groups[0];
  assert.equal(g4.tip_sha, SHA2, '台账 tip_sha 必须等于交卷值');
  const delivery = ledger.events.filter((e) => e.type === 'delivery');
  assert.equal(delivery.length, 1);
  // F1 契约：delivery detail 必须是结构化对象（ready-check ① 读 detail.tip_sha 与台账对账）
  assert.equal(delivery[0].detail.group_id, 'g4', 'delivery detail 必须含 group_id');
  assert.equal(delivery[0].detail.status, 'done');
  assert.equal(delivery[0].detail.tip_sha, SHA2);
  assert.equal(delivery[0].detail.candidate_sha, SHA2, '执行交卷候选即所交 tip，candidate_sha 必须等于 tip_sha');
  assert.deepEqual(delivery[0].detail.scs, [
    { sc_id: 'sc-p1c', status: 'pass' },
    { sc_id: 'sc-p1d', status: 'pass' },
    { sc_id: 'sc-p1e', status: 'pass' },
    { sc_id: 'sc-p1h', status: 'pass' },
  ], 'delivery detail.scs 必须结构化摘要交卷结果');
});

test('sc-p1h: 审查组合法交卷——unresolved 由此机器写入 review.unresolved（唯一入账通道）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 生命周期门（① 升级）：review 交卷只允许 delivered——先派工交付到 delivered
  // sc-p0a/b/c 迁移：合法派工前先身份+render（凭证闸前置）+快照（快照闸）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'executing', '--detail', gateGoalDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(execDeliveryPayload()), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'e2e', '--detail', gateRoutingDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const payload = { rounds: 2, findings_total: 5, unresolved: 3, fix_commits: ['abc'.repeat(13), 'def'.repeat(13)], candidate_sha: SHA1 };
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `审查组交卷应 exit 0: ${r.stderr}`);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.review.rounds, 2, 'review.rounds 必须等于交卷值');
  assert.equal(g4.review.unresolved, 3, 'review.unresolved 必须等于交卷值（唯一入账通道）');
  // F1 契约：审查交卷 delivery detail 必须结构化且绑定 candidate_sha（ready-check ③ 读取点）。
  // 取最后一条 delivery（set-state delivered 也落 delivery 事件，filter[0] 会取到它）
  const deliveries = readLedger(ledgerPath).events.filter((e) => e.type === 'delivery');
  const reviewDelivery = deliveries[deliveries.length - 1];
  assert.equal(reviewDelivery.detail.group_id, 'g4');
  assert.equal(reviewDelivery.detail.rounds, 2);
  assert.equal(reviewDelivery.detail.unresolved, 3);
  assert.equal(reviewDelivery.detail.candidate_sha, SHA1, '审查交卷 detail 必须绑定被审 candidate_sha（非派生默认）');
  // delivery detail 契约下限 {group_id, tip_sha, candidate_sha}：组已交付时取台账当前 tip_sha
  assert.equal(reviewDelivery.detail.tip_sha, SHA1, '组已有 tip 时审查交卷 detail.tip_sha 必须取台账当前值');
});

test('sc-p1h: 审查交卷缺 candidate_sha 拒（exact 契约，不许默认）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 缺 candidate_sha：keys 集合与 REVIEW_DELIVERY_KEYS 不符 → classifyDelivery 无法唯一识别
  // （缺键即拒）；即使只缺该键也走 DELIVERY_SCHEMA，绝不允许从台账派生默认
  for (const payload of [
    { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [] },
    { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], candidate_sha: undefined },
  ]) {
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, '审查交卷缺 candidate_sha 必须 exit 2（exact 契约）');
    assert.match(r.stderr, /DELIVERY_SCHEMA/, '必须走 DELIVERY_SCHEMA 拒绝路径');
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, '坏交卷后台账字节必须不变');
  }
});

test('sc-p1h: 审查交卷 candidate_sha 非 40hex 拒并点名（39 位/任意字符串）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const bad of [SHA39, 'not-a-sha', 'A'.repeat(40), '']) {
    const payload = { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], candidate_sha: bad };
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, `candidate_sha=${bad} 必须 exit 2`);
    assert.match(r.stderr, /candidate_sha/, '必须点名 candidate_sha');
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, '坏交卷后台账字节必须不变');
  }
});

test('sc-p1h: 审查交卷 candidate_sha 合法入账——detail 携带审查方声明值（非派生默认）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 生命周期门（① 升级）：review 交卷只允许 delivered——先派工交付
  // sc-p0a/b/c 迁移：合法派工前先身份+render（凭证闸前置）+快照（快照闸）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'executing', '--detail', gateGoalDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'e2e', '--detail', gateRoutingDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const payload = { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], candidate_sha: SHA2 };
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `审查交卷应 exit 0: ${r.stderr}`);
  const deliveries = readLedger(ledgerPath).events.filter((e) => e.type === 'delivery');
  const delivery = deliveries[deliveries.length - 1]; // 最后一条 = 审查交卷（set-state delivered 在前）
  assert.equal(delivery.detail.candidate_sha, SHA2, 'candidate_sha 必须等于交卷 payload 值（审查方声明，非台账派生）');
  // delivery detail 契约下限：{group_id, tip_sha, candidate_sha} 三键齐备
  assert.equal(delivery.detail.group_id, 'g4');
  assert.ok(Object.prototype.hasOwnProperty.call(delivery.detail, 'tip_sha'), 'detail 必须含 tip_sha 键');
});

test('sc-p1h: 验收组合法交卷——verify.status/evidence_ref 入账', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 生命周期门（① 升级）：verify 交卷允许 delivered/review_pass（验收组交付后即出 verdict）。
  // v1 在 wave 2：先 g4 走完并集成 wave 1（波次顺序门），再派 v1 到 delivered 即交卷
  runG4ToVerified(ledgerPath);
  let r0 = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r0.status, 0, r0.stderr);
  const v = 'v1';
  // sc-p0a/b/c 迁移：v1 在 wave1 集成后派工——base=集成点 SHA2（基线闸）+ render 前置（凭证闸）+ 快照
  assignIdentity(ledgerPath, v, 'feat/verify', SHA2);
  renderGroup(ledgerPath, v);
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'wv1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    r0 = cli('set-state', ledgerPath, '--group', v, '--to', to, ...extra, '--now', T);
    assert.equal(r0.status, 0, r0.stderr);
  }
  const payload = {
    scs: [{ sc_id: 'sc-v1a', status: 'pass', evidence: 'ready-check exit 0' }],
    integration_review: { status: 'pass', notes: 'squash diff 复查无越域' },
    candidate_sha: SHA1,
  };
  const r = cli('record-delivery', ledgerPath, '--group', v, '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `验收组交卷应 exit 0: ${r.stderr}`);
  const v1 = readLedger(ledgerPath).waves[1].groups[0];
  assert.equal(v1.verify.status, 'pass', 'verify.status 必须等于 integration_review.status');
  assert.equal(typeof v1.verify.evidence_ref, 'string');
  assert.ok(v1.verify.evidence_ref.length > 0, 'evidence_ref 必须非空');
});

test('sc-p1h: 验收组交卷 sc_id 与派工包不一致拒（多/少/改名全拒，与执行组同判据）', () => {
  for (const [label, ids] of [
    ['缺一', []],
    ['多一', ['sc-v1a', 'sc-extra']],
    ['改名', ['sc-v1b']],
  ]) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const payload = {
      scs: ids.map((id) => ({ sc_id: id, status: 'pass', evidence: `ev:${id}` })),
      integration_review: { status: 'pass', notes: 'ok' },
      candidate_sha: SHA1,
    };
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'v1', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, `${label} 验收交卷 sc_id 必须 exit 2`);
    // 缺一（空数组）先被「scs 必须是非空数组」拦（同为拒）；多一/改名精确点名 SC_ID_MISMATCH
    if (label === '缺一') {
      assert.match(r.stderr, /DELIVERY_SCHEMA|SC_ID_MISMATCH/);
    } else {
      assert.match(r.stderr, /SC_ID_MISMATCH/, `${label} 必须点名 SC_ID_MISMATCH`);
    }
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, `${label}：坏交卷后台账字节必须不变`);
  }
});

test('sc-p1h: sc_id 缺一/多一/改名各 exit 2 且点名（与派工包 scs_inline 完全一致）', () => {
  for (const [label, ids] of [
    ['缺一', ['sc-p1c', 'sc-p1d', 'sc-p1e']],
    ['多一', ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h', 'sc-extra']],
    ['改名', ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-renamed']],
  ]) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const payload = execDeliveryPayload({ ids });
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, `${label} sc_id 必须 exit 2`);
    assert.match(r.stderr, /SC_ID_MISMATCH/, `${label} 必须点名 SC_ID_MISMATCH`);
    assert.match(r.stderr, new RegExp(label === '缺一' ? '缺' : label === '多一' ? '多' : '多/错'));
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, `${label}：坏交卷后台账字节必须不变`);
  }
});

test('sc-p1h: tip_sha 39 位拒（40hex 格式）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const payload = execDeliveryPayload({ tipSha: SHA39 });
  const before = readFileSync(ledgerPath, 'utf8');
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 2, '39 位 tip_sha 必须 exit 2');
  assert.match(r.stderr, /tip_sha 非 40 位十六进制/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);
});

test('sc-p1h: unresolved 非数字拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const bad of ['abc', 2.5, true, null]) {
    const payload = { rounds: 1, findings_total: 1, unresolved: bad, fix_commits: [], candidate_sha: SHA1 };
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, `unresolved=${JSON.stringify(bad)} 必须 exit 2`);
    assert.match(r.stderr, /unresolved 必须是非负安全整数/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, '坏交卷后台账字节必须不变');
  }
});

test('sc-p1h: 坏交卷后台账字节不变（解析失败/schema 不符/未知键/无法识别类型）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const bads = [
    '{not-json',
    { status: 'done' }, // 缺 tip_sha/scs
    { status: 'done', tip_sha: SHA1, scs: [], extra: 1 }, // 未知键
    { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], status: 'done', tip_sha: SHA1 }, // 类型混叠
    [],
    'str',
  ];
  for (const bad of bads) {
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(bad), '--now', T);
    assert.equal(r.status, 2, `坏交卷 ${JSON.stringify(bad)} 必须 exit 2`);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, `坏交卷 ${JSON.stringify(bad)} 后台账字节必须不变`);
  }
});

test('sc-p1h: record-delivery 交卷文件路径（--payload @file）解析', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 生命周期门（① 升级）：exec 交卷只允许 dispatched/delivered——先派工
  // sc-p0a/b/c 迁移：合法派工前先身份+render（凭证闸前置）+快照（快照闸）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const payloadFile = join(dir, 'delivery.json');
  writeFileSync(payloadFile, JSON.stringify(execDeliveryPayload()));
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', `@${payloadFile}`, '--now', T);
  assert.equal(r.status, 0, `@file 交卷应 exit 0: ${r.stderr}`);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].tip_sha, SHA1);
});

// =====================================================================
// F-H：--verify-status 手工通道移除 + verified 凭据绑定可解析 evidence_ref
// =====================================================================
test('F-H: set-state --verify-status/--verify-evidence-ref 手工写入口必拒（与 --unresolved 同类漏洞已封）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const args of [
    ['--group', 'g4', '--to', 'executing', '--verify-status', 'pass'],
    ['--group', 'g4', '--to', 'accepted', '--verify-status', 'pass'],
    ['--group', 'g4', '--verify-status', 'pass', '--verify-evidence-ref', 'x'],
  ]) {
    const r = cli('set-state', ledgerPath, ...args, '--now', T);
    assert.equal(r.status, 2, `set-state ${args.join(' ')} 必须 exit 2`);
    assert.match(r.stderr, /--verify-status|record-delivery|已移除/);
  }
  // 台账未被任何手工通道污染：verify.status 保持 null
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.deepEqual(g4.verify, { status: null, evidence_ref: null });
});

test('F-H: →verified 无 pass 凭据拒（verify.status=null 或手工伪造的 evidence_ref 均拒）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // sc-p0a/b/c 迁移：合法派工前先身份+render（凭证闸前置）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');

  const g = 'g4';
  // 走到 review_pass（无 verify 凭据）
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1', '--mem-snapshot', memSnapshotJson()]],
    ['executing', ['--detail', gateGoalDetail()]],
    ['e2e', ['--detail', gateRoutingDetail()]],
    ['review', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 2, '无 pr-handoff 交卷的 →pr-open 必须 exit 2');
  assert.match(r.stderr, /pr-handoff|gate_goal|gate_routing|PR_RECEIPT/);
  const handoff = prHandoffPayload(g, { ledgerPath });
  r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(handoff), '--now', T);
  assert.equal(r.status, 0, `pr-handoff 交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, `合法 pr-handoff →pr-open 应 exit 0: ${r.stderr}`);
});

// =====================================================================
// F-J：packet.scs_inline 自身重复/空 id 拒（出包 + 交卷双入口）
// =====================================================================
test('F-J: packet.scs_inline 含重复 id → render-packet 与 record-delivery 均拒', () => {
  for (const [label, ids] of [
    ['重复', ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h', 'sc-p1c']],
    ['空 id', ['sc-p1c', '', 'sc-p1e']],
  ]) {
    const dir = newTmpDir();
    // 完整夹具先 init，再篡改 g4 packet.scs_inline 引入重复/空 id + 同步台账 hash
    // （init 输入门已拒不完整 manifest；同步 hash 后渲染/交卷才命中 PACKET_INCOMPLETE）
    const { ledgerPath } = tamperManifestThenInit(dir, (m) => {
      const pkt = m.dispatch.packets.find((p) => p.group_id === 'g4');
      pkt.scs_inline = ids.map((id) => ({ id, kind: 'fix', change: `x ${id}` }));
    });
    assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
    // 出包拒（台账 manifest 路径即篡改副本，默认路径直接命中 id 契约）
    const rp = cli('render-packet', ledgerPath, '--group', 'g4');
    assert.equal(rp.status, 2, `${label} id 的 render-packet 必须 exit 2`);
    assert.match(rp.stderr, /PACKET_INCOMPLETE/, `${label} 必须走 PACKET_INCOMPLETE`);
    assert.match(rp.stderr, /重复 id|非字符串\/空 id/, `${label} 必须点名 id 契约`);
    assert.equal(rp.stdout, '', `${label} 不得出包`);
    // 交卷拒（即使交卷 scs 与去重后的 expected 一致，packet 自身契约先拒）。
    // sc-p0c 迁移说明：此测试的 render-packet 已被 F-J 拒（无 packet_rendered 凭证），
    // dispatched 必被凭证闸拦——不再派工，直接 record-delivery：validateExecDelivery 内的
    // assertPacketScIds（packet 自身 id 契约）先于生命周期门执行，pending 组照样命中
    // PACKET_INCOMPLETE（「确保命中的是 id 契约而非生命周期拒」语义保留）。
    const payload = execDeliveryPayload({ ids: ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h'] });
    const rd = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(rd.status, 2, `${label} id 的 record-delivery 必须 exit 2`);
    assert.match(rd.stderr, /PACKET_INCOMPLETE/, `${label} 交卷必须走 PACKET_INCOMPLETE（packet 自身契约先拒）`);
  }
});

test('F-J: 对照——packet.scs_inline 无重复时，交卷缺一/多一/重复仍按计数比对拒（原有 exact 语义保留）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 生命周期门（① 升级）：exec 交卷需 dispatched——先派工
  // sc-p0a/b/c 迁移：合法派工前先身份+render（凭证闸前置）+快照（快照闸）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // 缺一：只交 3 项
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload',
    JSON.stringify(execDeliveryPayload({ ids: ['sc-p1c', 'sc-p1d', 'sc-p1e'] })), '--now', T);
  assert.equal(r.status, 2, '缺一必须 exit 2');
  assert.match(r.stderr, /SC_ID_MISMATCH/);
  // 重复：actual 重复仍拒（DELIVERY_SCHEMA）
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload',
    JSON.stringify(execDeliveryPayload({ ids: ['sc-p1c', 'sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h'] })), '--now', T);
  assert.equal(r.status, 2, 'actual 重复必须 exit 2');
  assert.match(r.stderr, /重复 sc_id/);
  // 完整一致 → 放行
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload',
    JSON.stringify(execDeliveryPayload()), '--now', T);
  assert.equal(r.status, 0, `完整一致交卷应 exit 0: ${r.stderr}`);
});

// =====================================================================
// P1（整数精度边界）：isInteger 放行 2^53，version+1 在该值上精度饱和不再递增
// （9007199254740992+1 === 9007199254740992）→ CAS 的「读到的版本 ≠ 当前版本就拒」恒判等，
// 乐观锁彻底失效、多陈旧写者同时成功静默覆盖。修法：整数入口一律 Number.isSafeInteger。

const SAFE_MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991（2^53−1，安全边界）
const OVERFLOW = 9007199254740992;        // 2^53：+1 恒等自身，超出安全范围

test('P1: version=2^53−1（安全最大）validate exit 0 正例；该值上的写操作 fail-closed（version 无法安全递增）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const l = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  l.version = SAFE_MAX;
  writeFileSync(ledgerPath, `${JSON.stringify(l, null, 2)}\n`);
  // 安全边界值本身合法：schema 通过、validate exit 0（正例）
  const rv = cli('validate', ledgerPath);
  assert.equal(rv.status, 0, `安全边界 version 应通过 validate: ${rv.stderr}`);
  // 但此值上的写操作必须 fail-closed：expected+1 = 2^53 已越界，绝不静默饱和落盘
  const rs = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(rs.status, 2, '安全边界上的写操作必须 exit 2（version 不可安全递增，fail-closed）');
  assert.match(rs.stderr, /非负安全整数/);
  assert.equal(readLedger(ledgerPath).version, SAFE_MAX, '被拒的写操作不得改变 version');
});

test('P1: version=2^53 validate 与 set-state 均 exit 2 点名（isSafeInteger 拒，点名安全范围）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const l = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  l.version = OVERFLOW;
  writeFileSync(ledgerPath, `${JSON.stringify(l, null, 2)}\n`);
  let r = cli('validate', ledgerPath);
  assert.equal(r.status, 2, '2^53 version 的 validate 必须 exit 2');
  assert.match(r.stderr, /非负安全整数/);
  assert.match(r.stderr, /9007199254740991/, '必须点名安全范围上限');
  const before = readFileSync(ledgerPath, 'utf8');
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 2, '2^53 version 的 set-state 必须 exit 2');
  assert.match(r.stderr, /非负安全整数/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '2^53 台账的写操作不得触碰字节');
});

test('P1: stale 双写反证——2^53 台账双 writer 双双 fail-closed（原状「双成功」被消灭）；安全版本下恰 1 成功 1 CAS_CONFLICT', async () => {
  // 子进程：先 readLedger 取 expected（stale 窗口起点）→ buildNext 内停留（拉宽临界区
  // 制造真实重叠）→ CAS 写。2^53 台账在 readLedger 处即被 isSafeInteger 拒（fail-closed
  // exit 2，绝不进入 buildNext——修复前 isInteger 放行后两个写者都成功、落盘 version 不动）。
  const childSrc = `
    import { writeLedgerAtomic, readLedger, LedgerError } from ${JSON.stringify(`file://${SCRIPT}`)};
    const ledgerPath = process.argv[2];
    const marker = process.argv[3];
    try {
      const expected = readLedger(ledgerPath).version; // 写者先读
      writeLedgerAtomic(ledgerPath, expected, (cur) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        return { ...cur, slug: marker, version: expected + 1 };
      });
      const disk = readLedger(ledgerPath);
      console.log('OK ' + marker + ' version=' + disk.version);
      process.exit(0);
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'CAS_CONFLICT') {
        console.log('CAS_CONFLICT ' + marker);
        process.exit(2);
      }
      if (err instanceof LedgerError && err.code === 'SCHEMA') {
        console.log('SCHEMA_REFUSED ' + marker + ' ' + (err.message || '').slice(0, 50));
        process.exit(2);
      }
      console.error('UNEXPECTED ' + marker + ' code=' + (err.code || '') + ' msg=' + err.message);
      process.exit(4);
    }
  `;
  const childFile = join(newTmpDir(), 'stale-writer.mjs');
  writeFileSync(childFile, childSrc);
  const run = (ledgerPath, marker) => new Promise((res) => {
    const p = spawn(process.execPath, [childFile, ledgerPath, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => res({ marker, code, out: out.trim(), err: err.trim() }));
  });

  // 场景 1：磁盘 version=2^53 → 双 writer 均 readLedger 拒（SCHEMA_REFUSED），无成功、无冲突
  const dir1 = newTmpDir();
  const { ledgerPath: lp1 } = initLedgerFor(dir1);
  const l1 = JSON.parse(readFileSync(lp1, 'utf8'));
  l1.version = OVERFLOW;
  writeFileSync(lp1, `${JSON.stringify(l1, null, 2)}\n`);
  const before1 = readFileSync(lp1, 'utf8');
  const r1 = await Promise.all([run(lp1, 'W-A'), run(lp1, 'W-B')]);
  const oks1 = r1.filter((x) => x.code === 0 && x.out.startsWith('OK'));
  const refusals1 = r1.filter((x) => x.code === 2 && x.out.startsWith('SCHEMA_REFUSED'));
  assert.equal(oks1.length, 0, `2^53 场景绝不允许任何写者成功（原状双成功被消灭）：${JSON.stringify(r1)}`);
  assert.equal(refusals1.length, 2, `2^53 场景双 writer 必须双双 fail-closed（SCHEMA 拒）：${JSON.stringify(r1)}`);
  assert.equal(readFileSync(lp1, 'utf8'), before1, '2^53 场景下台账字节必须不变');

  // 场景 2：安全版本（version=0）→ stale 双写恰 1 成功（version 0→1）、1 CAS_CONFLICT（CAS 机制完好对照）
  const dir2 = newTmpDir();
  const { ledgerPath: lp2 } = initLedgerForClean(dir2); // version=0
  const r2 = await Promise.all([run(lp2, 'W-A'), run(lp2, 'W-B')]);
  const oks2 = r2.filter((x) => x.code === 0 && x.out.startsWith('OK'));
  const conflicts2 = r2.filter((x) => x.code === 2 && x.out.startsWith('CAS_CONFLICT'));
  assert.equal(oks2.length, 1, `安全版本 stale 双写必须恰 1 成功：${JSON.stringify(r2)}`);
  assert.equal(conflicts2.length, 1, `失败方必须以 CAS_CONFLICT 收场：${JSON.stringify(r2)}`);
  assert.equal(readLedger(lp2).version, 1, '安全版本下 version 必须恰好 +1');
});

// =====================================================================
// P2（failed 分支 --event 白名单）：delivery 类型事件只由 record-delivery / delivered 转移
// 产生；set-state --to failed 只允许失败原因类事件（伪造 delivery 会污染 ready-check 的
// 分区对账与「最后一次 delivery」candidate_sha 绑定，且无从分辨真伪）。
// =====================================================================
test('P2: --to failed --event delivery 拒（exit 2 点名白名单）——伪 delivery 不得落盘', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', 'delivery', '--now', T);
  assert.equal(r.status, 2, '伪造 delivery 必须 exit 2');
  assert.match(r.stderr, /白名单/, '必须点名失败原因白名单');
  assert.match(r.stderr, /delivery/, '必须点名被拒事件名');
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.waves[0].groups[0].state, 'pending', '伪造 delivery 后组状态不得变 failed');
  assert.equal(ledger.events.filter((e) => e.type === 'delivery').length, 0, '不得产生任何 delivery 事件（对账污染源被堵死）');
});

test('P2: failed 白名单外事件全拒（dispatch/review_round/integrate/illegal_transition）且不落对应事件', () => {
  for (const evt of ['dispatch', 'review_round', 'integrate', 'illegal_transition']) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', evt, '--now', T);
    assert.equal(r.status, 2, `${evt} 必须 exit 2`);
    assert.match(r.stderr, /白名单/, `${evt} 必须点名失败原因白名单`);
    const ledger = readLedger(ledgerPath);
    assert.equal(ledger.waves[0].groups[0].state, 'pending', `${evt} 后组状态不得变 failed`);
    // 注意：拒绝路径按设计落 illegal_transition 事件（reason 描述），但不得落「以 evt 为失败
    // 原因」的伪造事件——detail.event === evt 的判定区分真伪（illegal_transition 的 detail 无 event 键）
    assert.equal(ledger.events.filter((e) => e.type === evt && e.detail?.event === evt).length, 0, `${evt} 事件不得被伪造为失败原因落盘`);
  }
});

test('P2: failed 白名单内失败原因事件仍正常落盘（正例，未挡死 failed 分支）', () => {
  for (const evt of ['timeout_redispatch', 'overreach_rejected', 'overlap_replan', 'budget_note']) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', evt, '--now', T);
    assert.equal(r.status, 0, `${evt} 应 exit 0: ${r.stderr}`);
    const g4 = readLedger(ledgerPath).waves[0].groups[0];
    assert.equal(g4.state, 'failed', `${evt} 后组必须 failed`);
    const ev = readLedger(ledgerPath).events.find((e) => e.type === evt);
    assert.ok(ev, `${evt} 事件必须落盘`);
    assert.equal(ev.detail.group_id, 'g4');
    assert.equal(ev.detail.event, evt, 'detail.event 回显失败原因');
  }
});

test('P2: 对照——delivery 事件合法通道仍工作（record-delivery 交卷）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(execDeliveryPayload()), '--now', T);
  assert.equal(r.status, 0, `record-delivery（真 delivery 通道）应 exit 0: ${r.stderr}`);
  const deliveries = readLedger(ledgerPath).events.filter((e) => e.type === 'delivery');
  assert.equal(deliveries.length, 1, 'record-delivery 必须写 delivery 事件');
  assert.equal(deliveries[0].detail.tip_sha, SHA1);
  assert.equal(deliveries[0].detail.candidate_sha, SHA1);
});
// ①：verified 组非状态写入口守卫（--identity / record-delivery 绕过状态机修复）
// =====================================================================
// 背景：GROUP_TRANSITIONS.verified = [] 只挡「状态跳转」；身份写入与交卷入账不是跳转，
// 旧实现可把终态组的 worktree/tip_sha/verify.status 等字段任意改写（重放攻击第二形态）。
// 守卫判据：g.state === 'verified' 即拒（纯 throw，不落事件——被拒后台账字节不变）。
test('①: verified 组 --identity 写入拒（exit 2 点名 + 台账字节不变，终态只读）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  forgeG4Verified(ledgerPath);
  const before = readFileSync(ledgerPath, 'utf8');
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/new', branch: 'feat/x', base: SHA3 }), '--now', T);
  assert.equal(r.status, 2, 'accepted 组 --identity 必须 exit 2');
  assert.match(r.stderr, /accepted|pending 写入/, '必须点名终态或 pending-only');
  assert.match(r.stderr, /终态只读|只读|重放攻击/, '必须点名终态只读语义');
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒写后台账字节必须不变（不落事件）');
  const g = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g.worktree, '/wt/g4', '拒写后身份字段不得被改写');
});

test('F3: dispatched 及之后 --identity 写入拒（pending-only 守卫，exit 2 点名当前状态 + 重派指路）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 推到 dispatched（pending 态写身份 + render + 派工——首次写身份正例必须仍放行）
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched',
    '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, `首次 pending 态写身份 + 派工应 exit 0: ${r.stderr}`);
  // dispatched 态改身份 → exit 2 点名当前状态 + pending-only 语义（派发后改身份凭证可伪造）
  const before = readFileSync(ledgerPath, 'utf8');
  r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/changed', base: SHA3 }), '--now', T);
  assert.equal(r.status, 2, 'dispatched 态改身份必须 exit 2');
  assert.match(r.stderr, /dispatched/, '必须点名当前状态');
  assert.match(r.stderr, /只能在 pending 写入/, '必须点名 pending-only 语义');
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒写后台账字节必须不变（不落事件）');
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.branch, 'feat/run-ledger', '拒写后身份字段不得被改写');
  // 正例：failed→pending 重派回到 pending 后可正常重写身份（代际隔离链不误伤）
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'executing', '--detail', gateGoalDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'e2e', '--detail', gateRoutingDetail(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'pending', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/redispatch-v2', base: SHA3 }), '--now', T);
  assert.equal(r.status, 0, `failed→pending 后重写身份应放行: ${r.stderr}`);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].branch, 'feat/redispatch-v2', '重派后新身份必须写入');
});

test('①: verified 组 record-delivery 拒（exec/review/verify 三类交卷全拒 + 字节不变）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  forgeG4Verified(ledgerPath);
  const payloads = [
    execDeliveryPayload(), // exec 类（改写 tip_sha）
    { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], candidate_sha: SHA1 }, // review 类（改写 review.rounds）
    g4VerifyPayload(), // verify 类（改写 verify.status；sc_ids 取 g4 派工包，保证命中生命周期门而非 SC_ID_MISMATCH）
  ];
  for (const payload of payloads) {
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, 'accepted 组交卷必须 exit 2');
    assert.match(r.stderr, /accepted|生命周期门/, '必须点名终态或生命周期门');
    assert.match(r.stderr, /生命周期门/, '必须点名生命周期门（终态不在任何交卷类别允许集）');
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒写后台账字节必须不变（不落事件）');
  }
  const g = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g.tip_sha, SHA1, 'exec 交卷不得改写 accepted 组 tip_sha');
  assert.deepEqual(g.verify, { status: null, evidence_ref: null }, 'verify 交卷不得改写 accepted 组凭据');
});

test('①: 方向 B——pending 组提交合法 verify payload 拒（验收证据不可预写）+ 字节不变', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const before = readFileSync(ledgerPath, 'utf8');
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(g4VerifyPayload()), '--now', T);
  assert.equal(r.status, 2, 'pending 组 verify 交卷必须 exit 2（方向 B：验收凭据不可在派工前预写）');
  assert.match(r.stderr, /生命周期门/, '必须点名生命周期门');
  assert.match(r.stderr, /verify/, '必须点名交卷类别');
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒写后台账字节必须不变（不落事件）');
  const g = readLedger(ledgerPath).waves[0].groups[0];
  assert.deepEqual(g.verify, { status: null, evidence_ref: null }, 'pending 拒写后 verify 凭据不得被写入');
});

test('①: 交卷生命周期矩阵——每类交卷在每个非法状态 exit 2 + 字节不变，合法状态放行', () => {
  const ALL_STATES = ['pending', 'dispatched', 'executing', 'blocked', 'e2e', 'review', 'pr-open', 'accepted', 'failed'];
  const allowedByKind = {
    exec: ['dispatched', 'executing'],
    review: ['e2e', 'review'],
    verify: ['review', 'pr-open'],
    'pr-handoff': ['review'],
  };
  const payloadByKind = {
    exec: () => execDeliveryPayload(),
    review: () => ({ rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], candidate_sha: SHA1 }),
    verify: () => g4VerifyPayload(),
    'pr-handoff': () => prHandoffPayload('g4'),
  };
  for (const [kind, allowed] of Object.entries(allowedByKind)) {
    const illegal = ALL_STATES.filter((s) => !allowed.includes(s));
    // 非法格全拒：每格 exit 2 点名生命周期门 + 字节不变
    for (const state of illegal) {
      const dir = newTmpDir();
      const { ledgerPath } = initLedgerFor(dir);
      forgeG4State(ledgerPath, state);
      const before = readFileSync(ledgerPath, 'utf8');
      const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payloadByKind[kind]()), '--now', T);
      assert.equal(r.status, 2, `${kind}@${state} 必须 exit 2（生命周期门）`);
      assert.match(r.stderr, /生命周期门/, `${kind}@${state} 必须点名生命周期门`);
      assert.equal(readFileSync(ledgerPath, 'utf8'), before, `${kind}@${state} 拒写后台账字节必须不变`);
    }
    // 合法格放行（每类取第一个合法态）
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    forgeG4State(ledgerPath, allowed[0]);
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payloadByKind[kind]()), '--now', T);
    assert.equal(r.status, 0, `${kind}@${allowed[0]}（合法格）应 exit 0: ${r.stderr}`);
  }
});

test('①: evidence_ref 同组同类加固——指向他组 delivery / 非验收类 delivery 的 →verified 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  // 纯手工构造（仿 F-H 伪造风格，绕过波次顺序门）：g4 与 v1 都置 review_pass；
  // events 手工注入两类 delivery——g4 的非验收类（无 integration_review_status）
  // 与 v1 的验收类（integration_review_status）。schema 层校验可通过（detail 对象 + group_id 键）。
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const setState = (gid, state) => {
    const wg = ledger.waves.flatMap((w) => w.groups).find((x) => x.group_id === gid);
    wg.state = state;
    wg.worker_label = wg.worker_label ?? 'w';
    wg.tip_sha = SHA1;
    if (state === 'review') wg.review = { rounds: 1, unresolved: 0 };
  };
  setState('g4', 'review');
  setState('v1', 'review');
  const g4g = ledger.waves.flatMap((w) => w.groups).find((x) => x.group_id === 'g4');
  g4g.session_id = 'sess-g4';
  injectGateEvents(ledger, 'g4');
  injectGateEvents(ledger, 'v1');
  ledger.events.push(
    { type: 'delivery', at: T, detail: { group_id: 'g4', tip_sha: SHA1, candidate_sha: SHA1 } }, // g4 非验收类（无 integration_review_status）
    { type: 'delivery', at: T, detail: { group_id: 'v1', integration_review_status: 'pass', notes: 'ok', candidate_sha: SHA1 } }, // v1 验收类
  );
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const g4Group = () => readLedger(ledgerPath).waves[0].groups[0];
  // 伪造①：指向本组非验收类 delivery（g4 的 delivery#1）→ 同类拒
  let l = readLedger(ledgerPath);
  l.waves[0].groups[0].verify = { status: 'pass', evidence_ref: 'delivery#1' };
  writeFileSync(ledgerPath, `${JSON.stringify(l, null, 2)}\n`);
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 2, '无 pr-handoff 终态交卷的 →pr-open 必须 exit 2');
  assert.match(r.stderr, /pr-handoff|PR_RECEIPT|gate_goal|gate_routing/);
  assert.equal(g4Group().state, 'review', '拒写不得改变组状态');
  const handoff = prHandoffPayload(g, { ledgerPath });
  r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(handoff), '--now', T);
  assert.equal(r.status, 0, `pr-handoff 交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 0, `终态交卷后 →pr-open 应 exit 0: ${r.stderr}`);
});

test('①: 重派链 failed→pending 后 exec 重新交卷放行（生命周期门不挡重派正常链路）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  // 第一轮：身份+render（凭证闸前置）→ 派工 → 交 exec → delivered → failed
  assignIdentity(ledgerPath, g, 'feat/run-ledger');
  renderGroup(ledgerPath, g);
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(execDeliveryPayload()), '--now', T);
  assert.equal(r.status, 0, `首轮 exec 交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // 重派链：failed → pending（计数/身份清零，assignment_seq +1 代际隔离）→
  // 重新分配身份 → 重新 render（新代凭证，旧代凭证因 seq 变化 digest 失配）→ 重新派工
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pending', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  assignIdentity(ledgerPath, g, 'feat/run-ledger-v2');
  renderGroup(ledgerPath, g);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w2', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // 重派后 exec 重新交卷（生命周期门必须放行）
  r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(execDeliveryPayload({ tipSha: SHA2 })), '--now', T);
  assert.equal(r.status, 0, `重派后 exec 重新交卷应 exit 0: ${r.stderr}`);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].tip_sha, SHA2, '重派后交卷必须覆盖为新一轮 tip_sha');
});

// =====================================================================
// ②：wave 集成非法前置/重复尝试落 illegal_transition 事件
// =====================================================================
test('②: wave 集成前置拒/重复集成拒各落 illegal_transition 事件（version+1，group_id: null）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 前置不满足（g4 未 verified）
  const before = readLedger(ledgerPath);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 2, '前置不满足的 wave 集成必须 exit 2');
  assert.match(r.stderr, /全组 accepted/);
  let ledger = readLedger(ledgerPath);
  assert.equal(ledger.version, before.version + 1, '非法尝试必须使 version+1（事件已落盘）');
  const ev = ledger.events[ledger.events.length - 1];
  assert.equal(ev.type, 'illegal_transition', '必须落 illegal_transition 事件');
  assert.equal(ev.detail.group_id, null, 'wave 级拒绝无组上下文 → group_id 显式 null');
  assert.match(ev.detail.reason, /wave 1/, 'reason 必须含 wave');
  assert.match(ev.detail.reason, /全组 accepted/, 'reason 必须点名缺失前置');
  assert.equal(ledger.waves[0].integrated_tip, null, '拒后 integrated_tip 不得写入');
  // 集成成功后重复集成 → 同样落事件
  forgeG4Verified(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, `集成应 exit 0: ${r.stderr}`);
  const before2 = readLedger(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 2, '重复集成必须 exit 2');
  assert.match(r.stderr, /已集成/);
  ledger = readLedger(ledgerPath);
  assert.equal(ledger.version, before2.version + 1, '重复集成尝试必须使 version+1（事件已落盘）');
  const ev2 = ledger.events[ledger.events.length - 1];
  assert.equal(ev2.type, 'illegal_transition');
  assert.equal(ev2.detail.group_id, null);
  assert.match(ev2.detail.reason, /不可重复集成/, 'reason 必须点名重复集成');
  assert.equal(ledger.waves[0].integrated_tip, SHA2, '重复集成不得改写 integrated_tip');
});

// =====================================================================
// ③：parseFlags 子命令 flag allowlist（未知 flag 静默忽略修复）+ 重复 flag 拒
// =====================================================================
test('③: 未知 flag 静默忽略修复——init/set-state typo flag exit 2 点名未知 flag', () => {
  // init：--noww typo 此前静默忽略且台账创建成功；现在必须 exit 2 且不建台账
  const dir = newTmpDir();
  const manifestPath = fixtureCopy(dir);
  const ledgerPath = join(dir, 'ledger.json');
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', SHA3, '--noww', 'typo');
  assert.equal(r.status, 2, 'init 未知 flag 必须 exit 2');
  assert.match(r.stderr, /未知 flag/);
  assert.match(r.stderr, /--noww/);
  assert.equal(existsSync(ledgerPath), false, '未知 flag 的 init 不得创建台账');
  // set-state：--worker-lable typo 此前静默忽略且台账照常写入 dispatched；现在必须 exit 2
  const { ledgerPath: lp } = initLedgerFor(dir);
  r = cli('set-state', lp, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w', '--now', T, '--worker-lable', 'typo');
  assert.equal(r.status, 2, 'set-state 未知 flag 必须 exit 2');
  assert.match(r.stderr, /未知 flag/);
  assert.match(r.stderr, /--worker-lable/);
  const g4 = readLedger(lp).waves[0].groups[0];
  assert.equal(g4.state, 'pending', '未知 flag 的 set-state 不得执行（台账未被写入）');
  assert.equal(g4.worker_label, null);
});

test('③: set-state 用法提示不得教用户已移除的 flag（--verify-status 等只出现在拒绝消息）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 触发「set-state 需要 --group + --to」提示（缺参数组）
  const r = cli('set-state', ledgerPath, '--now', T);
  assert.equal(r.status, 2, '缺参数组必须 exit 2');
  // 提示语不得再列举已移除 flag（--verify-status）——教用户用废掉的接口是 CLI 表面与实际不一致
  assert.doesNotMatch(r.stderr, /--verify-status|--verify-evidence-ref|--ready-check-exit0/, '用法提示不得含已移除 flag');
  assert.match(r.stderr, /--group \+ --to/, '提示语仍须点名当前真实可用接口');
});

test('③: 同一 flag 重复指定拒（后值静默覆盖前值掩盖意图，语义不明确即拒）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--now', T, '--now', T);
  assert.equal(r.status, 2, '重复 --now 必须 exit 2');
  assert.match(r.stderr, /重复指定/);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.state, 'pending', '重复 flag 的 set-state 不得执行');
});

test('③: 未知 flag 带值形态拒（--unrecognised value 此前 exit 0 且写入成功）+ read 子命令 validate 同样覆盖', () => {
  // set-state：未知 flag 带值（审查席实测形态）——此前 exit 0 且写入 dispatched
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'audit-w', '--now', T, '--unrecognised', 'value');
  assert.equal(r.status, 2, 'set-state 未知 flag 带值必须 exit 2');
  assert.match(r.stderr, /未知 flag/);
  assert.match(r.stderr, /--unrecognised/);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.state, 'pending', '未知 flag 带值的 set-state 不得执行');
  assert.equal(g4.worker_label, null);
  // read 子命令（validate）：未知 flag 同样拒（此前静默忽略）
  r = cli('validate', ledgerPath, '--foo', 'bar');
  assert.equal(r.status, 2, 'validate 未知 flag 必须 exit 2');
  assert.match(r.stderr, /未知 flag/);
  assert.match(r.stderr, /--foo/);
});

// =====================================================================
// sc-p0a：基线漂移闸（identity 写入 + render-packet 出包双点消费 expectedBase）
// =====================================================================
test('sc-p0a: identity 写入基线漂移拒——base≠期望基线 exit 2 且消息含期望/实得/来源（init 基线）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir); // baseline=SHA3
  const before = readFileSync(ledgerPath, 'utf8');
  // 期望基线 = init 基线 SHA3（无已集成波）——base=SHA1 漂移拒
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/x', base: SHA1 }), '--now', T);
  assert.equal(r.status, 2, 'identity base≠期望基线必须 exit 2（BASELINE_MISMATCH）');
  assert.match(r.stderr, /BASELINE_MISMATCH/, '必须走 BASELINE_MISMATCH 拒绝路径');
  assert.ok(r.stderr.includes(SHA1), '消息必须含实得值（传入 base）');
  assert.ok(r.stderr.includes(SHA3), '消息必须含期望值（init 基线）');
  assert.match(r.stderr, /init 基线/, '消息必须点名期望值来源（init 基线）');
  assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒写后台账字节必须不变');
  // 对照：base=SHA3（=期望基线）放行
  r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/x', base: SHA3 }), '--now', T);
  assert.equal(r.status, 0, `base=期望基线应放行: ${r.stderr}`);
});

test('sc-p0a: render-packet 出包基线漂移拒——组 base≠期望基线 exit 2 且消息含期望/实得/来源（wave N 集成点）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir); // baseline=SHA3
  // 手工构造集成状态（绕过派工链，F1 变异隔离——不走 dispatch/delivery 写路径）：
  // g4 verified + wave1 integrated_tip=SHA2 → 期望基线从 init 基线 SHA3 切到 SHA2
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const g4 = ledger.waves[0].groups[0];
  Object.assign(g4, { state: 'accepted', worker_label: 'w1', tip_sha: SHA1,
    review: { rounds: 1, unresolved: 0 }, verify: { status: 'pass', evidence_ref: null },
    worktree: '/wt/g4', branch: 'feat/run-ledger', base: SHA3 });
  ledger.waves[0].integrated_tip = SHA2;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  // identity 消费点①：v1 base=SHA3（init 基线）≠ 期望（wave 1 集成点 SHA2）→ 写入拒
  let r = cli('set-state', ledgerPath, '--group', 'v1', '--identity',
    JSON.stringify({ worktree: '/wt/v1', branch: 'feat/verify', base: SHA3 }), '--now', T);
  assert.equal(r.status, 2, '集成后 identity base=SHA3 必须 exit 2（期望=wave 1 集成点 SHA2）');
  assert.match(r.stderr, /wave 1 集成点/, 'identity 消费点①消息必须点名来源（wave N 集成点）');
  assert.ok(r.stderr.includes(SHA2), 'identity 拒绝消息必须含期望值');
  // base=集成点放行 → render 出包放行（消费点②同一基线）
  r = cli('set-state', ledgerPath, '--group', 'v1', '--identity',
    JSON.stringify({ worktree: '/wt/v1', branch: 'feat/verify', base: SHA2 }), '--now', T);
  assert.equal(r.status, 0, `base=集成点应放行: ${r.stderr}`);
  r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 0, `集成后 base=集成点的 render 应 exit 0: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`integrated_tip=${SHA2}`), '验收组模板复查项引用 wave 1 集成点');
  // render 消费点②漂移拒：再集成 wave2（期望切到 SHA1），v1 base 仍 SHA2 → render 拒
  const ledger2 = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const v1 = ledger2.waves[1].groups[0];
  Object.assign(v1, { state: 'accepted', worker_label: 'wv1', tip_sha: SHA1,
    review: { rounds: 1, unresolved: 0 }, verify: { status: 'pass', evidence_ref: null } });
  ledger2.waves[1].integrated_tip = SHA1;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger2, null, 2)}\n`);
  r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 2, '组 base≠期望基线（wave 2 集成点）render 必须 exit 2');
  assert.match(r.stderr, /BASELINE_MISMATCH/, '必须走 BASELINE_MISMATCH 拒绝路径');
  assert.ok(r.stderr.includes(SHA2), '消息必须含实得值（组 base）');
  assert.ok(r.stderr.includes(SHA1), '消息必须含期望值（wave 2 集成点）');
  assert.match(r.stderr, /wave 2 集成点/, '消息必须点名期望值来源（wave N 集成点）');
  assert.equal(r.stdout, '', '拒出包不得有正文输出');
  // 对照：base=新集成点放行（v1 已 verified 终态，身份写入被拒——直接改台账组 base 再 render）
  const ledger3 = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger3.waves[1].groups[0].base = SHA1;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger3, null, 2)}\n`);
  r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 0, `base=wave 2 集成点的 render 应 exit 0: ${r.stderr}`);
});

test('sc-p0a: expectedBase 单一判据——latestIntegratedTip 优先于 init 基线（多波集成取数值最新，乱序不取数组位置）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir); // baseline=SHA3
  // 函数层断言（纯只读，F1 变异隔离）：无集成 → init 基线；集成 wave1 → wave1 tip；
  // 再集成 wave2 → wave2 tip（数值最新）；waves 数组乱序后仍按数值取（消费侧防御）
  let ledger = readLedger(ledgerPath);
  assert.equal(expectedBase(ledger), SHA3, '无集成时期望基线 = init 基线');
  ledger.waves[0].integrated_tip = SHA2;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal(expectedBase(readLedger(ledgerPath)), SHA2, 'wave1 集成后期望基线 = wave1 tip');
  ledger = readLedger(ledgerPath);
  ledger.waves[1].integrated_tip = SHA1;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal(expectedBase(readLedger(ledgerPath)), SHA1, 'wave2 集成后期望基线 = 数值最新已集成波（wave 2 tip）');
  ledger = readLedger(ledgerPath);
  ledger.waves = [ledger.waves[1], ledger.waves[0]]; // 乱序重排
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal(expectedBase(readLedger(ledgerPath)), SHA1, '乱序后仍按 wave 数值取最新（不依赖数组位置）');
});

test('sc-p0a: init --baseline 必填/格式——函数层漏传抛 ARGS、CLI 非 40hex 拒、缺键兼容读、有键非法值仍拒、null 兼容放行', () => {
  // 函数层：initLedger 不传 baseline（undefined）→ ARGS（导出函数漏传与 CLI 同判据）
  const dir = newTmpDir();
  const manifestPath = fixtureCopy(dir);
  assert.throws(
    () => initLedger({ ledgerPath: join(dir, 'l.json'), manifestPath, runId: 'x', now: T }),
    (err) => err instanceof LedgerError && err.code === 'ARGS' && /--baseline/.test(err.message),
    'initLedger 漏传 baseline 必须抛 ARGS（函数层必填）'
  );
  assert.equal(existsSync(join(dir, 'l.json')), false, '函数层漏传不得创建台账');
  // CLI：非 40hex --baseline 拒
  const ledgerPath = join(dir, 'ledger.json');
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T, '--baseline', 'not-a-sha');
  assert.equal(r.status, 2, '--baseline 非 40hex 必须 exit 2');
  assert.match(r.stderr, /非 40 位十六进制/);
  assert.equal(existsSync(ledgerPath), false, '非法 baseline 的 init 不得创建台账');
  // schema：手工删 baseline_tip 键 → 读入口兼容（F1：旧台账补默认 null 放行，validate exit 0）
  const { ledgerPath: lp2 } = initLedgerFor(dir);
  const l = JSON.parse(readFileSync(lp2, 'utf8'));
  delete l.baseline_tip;
  writeFileSync(lp2, `${JSON.stringify(l, null, 2)}\n`);
  r = cli('validate', lp2);
  assert.equal(r.status, 0, `缺 baseline_tip 键的旧台账必须兼容读 exit 0（F1 读入口补默认 null）: ${r.stderr}`);
  assert.equal(readLedger(lp2).baseline_tip, null, '归一化后读出 baseline_tip===null（旧台账视为兼容模式）');
  // 有键但值非法仍拒（宽容只针对「键完全缺失」，不放松值校验）
  const lBad = JSON.parse(readFileSync(lp2, 'utf8'));
  lBad.baseline_tip = 123; // 非 40hex 非 null
  const lpBad = join(dir, 'ledger-bad.json');
  writeFileSync(lpBad, `${JSON.stringify(lBad, null, 2)}\n`);
  r = cli('validate', lpBad);
  assert.equal(r.status, 2, '有键但值非法（数字 123）必须仍 exit 2');
  assert.match(r.stderr, /baseline_tip/);
  lBad.baseline_tip = 'abc'; // 非 40hex 字符串
  writeFileSync(lpBad, `${JSON.stringify(lBad, null, 2)}\n`);
  r = cli('validate', lpBad);
  assert.equal(r.status, 2, '有键但值非 40hex 字符串必须仍 exit 2');
  assert.match(r.stderr, /baseline_tip/);
  // CLI 缺省 --baseline → null 兼容模式（e2e-dryrun 路径），台账仍合法
  const lp3 = join(dir, 'ledger3.json');
  r = cli('init', lp3, '--manifest', manifestPath, '--run-id', 'compat', '--now', T);
  assert.equal(r.status, 0, `CLI 缺省 --baseline（兼容模式）应 exit 0: ${r.stderr}`);
  assert.equal(readLedger(lp3).baseline_tip, null, '兼容模式 baseline_tip=null');
});

// F2：init 缺 --baseline 的降级动作必须可见——stderr WARN 有测试保护，
// 删掉 WARN 输出块即红（「忘传 --baseline」与「明确要兼容模式」不许同形）。
// 警告关键字从 run-ledger.mjs CLI init 分支实际输出的字符串派生（非硬编码猜测）。
test('F2: init 缺 --baseline 时 stderr 必须含兼容模式警告（WARN 保护，删 WARN 块即红）', () => {
  const dir = newTmpDir();
  const manifestPath = fixtureCopy(dir);
  const ledgerPath = join(dir, 'ledger.json');
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'compat-warn', '--now', T);
  assert.equal(r.status, 0, `兼容模式 init 应 exit 0: ${r.stderr}`);
  assert.match(r.stderr, /\[WARN\]/, '缺 --baseline 时 stderr 必须含 WARN 标记（降级动作显式可见）');
  assert.match(r.stderr, /兼容模式/, '必须点名兼容模式');
  assert.match(r.stderr, /三道 P0 新闸全部不生效/, '必须声明基线闸/快照闸/凭证闸三道 P0 新闸不生效');
  assert.match(r.stderr, /--baseline/, '必须指路显式传 --baseline');
  // 对照：显式传 --baseline（严格模式）不得输出 WARN
  const lp2 = join(dir, 'ledger2.json');
  const r2 = cli('init', lp2, '--manifest', manifestPath, '--run-id', 'strict', '--now', T, '--baseline', SHA3);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stderr.includes('[WARN]'), false, '显式 --baseline 的 init 不得输出 WARN');
  assert.equal(readLedger(lp2).baseline_tip, SHA3, '严格模式 baseline_tip=40hex');
});

// =====================================================================
// sc-p0b：派发内存快照闸（--mem-snapshot 四键 exact + 跨字段一致性）
// =====================================================================
test('sc-p0b: dispatched 缺 --mem-snapshot 拒（严格模式，exit 2 点名）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4'); // 凭证闸满足，快照闸独立生效
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--now', T);
  assert.equal(r.status, 2, '缺 --mem-snapshot 必须 exit 2');
  assert.match(r.stderr, /--mem-snapshot/, '必须点名 --mem-snapshot');
  assert.match(r.stderr, /used_slots\/platform_cap\/concurrency\/available_bytes/, '必须点名四键');
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'pending', '被拒后台账组状态不得前进');
});

test('sc-p0b: --mem-snapshot 非法形状拒——未知键/缺键/负数/类型错/concurrency>cap/used_slots>cap', () => {
  const bads = [
    ['未知键', JSON.stringify({ used_slots: 0, platform_cap: 8, concurrency: 8, available_bytes: 1, extra: 1 })],
    ['缺键', JSON.stringify({ used_slots: 0, platform_cap: 8, concurrency: 8 })],
    ['负数', JSON.stringify({ used_slots: -1, platform_cap: 8, concurrency: 8, available_bytes: 1 })],
    ['类型错', JSON.stringify({ used_slots: '0', platform_cap: 8, concurrency: 8, available_bytes: 1 })],
    ['concurrency>cap', JSON.stringify({ used_slots: 0, platform_cap: 8, concurrency: 9, available_bytes: 1 })],
    ['used_slots>cap', JSON.stringify({ used_slots: 9, platform_cap: 8, concurrency: 8, available_bytes: 1 })],
  ];
  for (const [label, snap] of bads) {
    const dir = newTmpDir();
    const { ledgerPath } = initLedgerFor(dir);
    assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
    renderGroup(ledgerPath, 'g4');
    const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1',
      '--mem-snapshot', snap, '--now', T);
    assert.equal(r.status, 2, `${label} 快照必须 exit 2`);
    assert.match(r.stderr, /--mem-snapshot/, `${label} 必须点名 --mem-snapshot`);
    // 前置拒绝走 rejectWithEvent（落 illegal_transition 事件 + version+1，与 worker-label/
    // 波次门/凭证闸等既有前置同风格）——断言组状态不得前进（派工未生效），不断言字节不变。
    assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'pending', `${label}：组状态不得前进`);
    assert.equal(readLedger(ledgerPath).waves[0].groups[0].worker_label, null, `${label}：worker_label 不得写入`);
  }
});

test('sc-p0b: 合法快照放行 + 导出函数同判据（assertMemSnapshot 直接调）+ 非 JSON 拒', () => {
  // 导出函数：合法对象不抛；非法逐类抛 LedgerError（CLI 与函数层同一份判据）
  assert.doesNotThrow(() => assertMemSnapshot({ used_slots: 0, platform_cap: 8, concurrency: 8, available_bytes: 1 }));
  assert.throws(() => assertMemSnapshot({ used_slots: 9, platform_cap: 8, concurrency: 8, available_bytes: 1 }),
    (err) => err instanceof LedgerError && /used_slots=9 > platform_cap=8/.test(err.message),
    'used_slots>cap 导出函数必须抛（跨字段一致性，computeConcurrency 不查上限故此处补）');
  assert.throws(() => assertMemSnapshot('not-an-object'), (err) => err instanceof LedgerError, '非对象必须抛');
  // CLI 层：合法快照放行；JSON 非法拒（--mem-snapshot 不是合法 JSON）
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1',
    '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, `合法快照派工应 exit 0: ${r.stderr}`);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.state, 'dispatched', '合法快照派工后组必须 dispatched');
  // 非 JSON 字符串
  const dir2 = newTmpDir();
  const { ledgerPath: lp2 } = initLedgerFor(dir2);
  assignIdentity(lp2, 'g4', 'feat/run-ledger');
  renderGroup(lp2, 'g4');
  r = cli('set-state', lp2, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1',
    '--mem-snapshot', '{not-json', '--now', T);
  assert.equal(r.status, 2, '非 JSON 的 --mem-snapshot 必须 exit 2');
  assert.match(r.stderr, /不是合法 JSON/);
});

// =====================================================================
// sc-p0c：render-packet 凭证闸（packet_rendered 事件 + assignment_seq 代际隔离）
// =====================================================================
test('sc-p0c: 未 render 派工拒（无 packet_rendered 事件，exit 2 点名）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched',
    '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 2, '未经 render-packet 出包的派工必须 exit 2');
  assert.match(r.stderr, /未经 render-packet 出包/, '必须点名「未经 render-packet 出包」');
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'pending', '被拒后组状态不得前进');
});

test('sc-p0c: render 后派工放行 + 事件 detail 契约（identity_digest 现算比对 + packet_sha256 + assignment_seq）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  const out = renderGroup(ledgerPath, 'g4');
  const ledger = readLedger(ledgerPath);
  const pe = ledger.events.filter((e) => e.type === 'packet_rendered');
  assert.equal(pe.length, 1, 'render 成功必须写恰 1 条 packet_rendered 事件');
  const detail = pe[0].detail;
  assert.equal(detail.group_id, 'g4');
  // digest = 长度前缀编码 sha256 前 16hex（含 assignment_seq=0 代际）
  const expectDigest = identityDigest({ worktree: '/wt/g4', branch: 'feat/run-ledger', base: SHA3, session_id: 'sess-g4', assignmentSeq: 0 });
  assert.equal(detail.identity_digest, expectDigest, 'identity_digest 必须等于现算 digest（长度前缀编码）');
  assert.match(detail.identity_digest, /^[0-9a-f]{16}$/, 'digest 必须为 16 位十六进制');
  assert.match(detail.packet_sha256, /^[0-9a-f]{16}$/, 'packet_sha256 必须为 16 位十六进制');
  assert.equal(detail.assignment_seq, 0, '首代 assignment_seq=0');
  assert.equal(ledger.version >= 1, true, '出包写事件必须使 version 前进（CAS 版本+1）');
  // 凭证匹配 → 派工放行
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched',
    '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, `render 后派工应 exit 0: ${r.stderr}`);
});

test('sc-p0c: 身份变更后旧凭证失配拒（digest 不匹配，exit 2「身份已变更未重出包」）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  // 身份变更（branch 改）但未重新 render → 现算 digest ≠ 最近凭证 digest → 拒
  const r2 = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/changed', base: SHA3 }), '--now', T);
  assert.equal(r2.status, 0, `身份重写（同基线）应放行: ${r2.stderr}`);
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched',
    '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 2, '身份变更未重出包的派工必须 exit 2');
  assert.match(r.stderr, /身份已变更未重出包/, '必须点名「身份已变更未重出包」');
  // 重新 render 后放行（新 digest 匹配）
  renderGroup(ledgerPath, 'g4');
  const r3 = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched',
    '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r3.status, 0, `重新 render 后派工应 exit 0: ${r3.stderr}`);
});

test('sc-p0c: 重派代际隔离——重派后 assignment_seq+1 旧凭证失配拒、重新 render 后放行、旧事件保留审计', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  // 第一代：身份 + render + 派工 + delivered + failed
  assignIdentity(ledgerPath, g, 'feat/run-ledger');
  renderGroup(ledgerPath, g);
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w1',
    '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const eventsBefore = readLedger(ledgerPath).events.length;
  // 重派：failed→pending → assignment_seq 0→1，身份清空（pending 转移按既有语义落
  // timeout_redispatch 事件，与 failed 时落的各一条——共 2 条重派链事件）
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pending', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  let g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.assignment_seq, 1, '重派必须递增 assignment_seq（代际隔离计数器）');
  // 旧 packet_rendered 事件保留（供审计）
  const evs = readLedger(ledgerPath).events;
  assert.equal(evs.filter((e) => e.type === 'packet_rendered').length, 1, '旧代凭证必须保留在 events 中');
  assert.equal(evs.length, eventsBefore + 1, '重派链 pending 转移追加 timeout_redispatch 事件（failed 时已落一条）');
  // 重新分配身份后，旧凭证 digest 因 seq 变化不再匹配 → 派工拒
  assignIdentity(ledgerPath, g, 'feat/run-ledger-v2');
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w2',
    '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 2, '重派后未重新 render 的派工必须 exit 2（旧代凭证 digest 失配）');
  assert.match(r.stderr, /未经 render-packet 出包|身份已变更未重出包/);
  // 重新 render（新代，seq=1）→ 新凭证匹配 → 放行
  renderGroup(ledgerPath, g);
  g4 = readLedger(ledgerPath).waves[0].groups[0];
  const newPe = readLedger(ledgerPath).events.filter((e) => e.type === 'packet_rendered');
  assert.equal(newPe.length, 2, '第二代 render 追加新凭证，旧凭证保留');
  assert.equal(newPe[1].detail.assignment_seq, 1, '新代凭证 assignment_seq=1');
  const expectDigest = identityDigest({ worktree: '/wt/g4', branch: 'feat/run-ledger-v2', base: SHA3, session_id: 'sess-g4', assignmentSeq: 1 });
  assert.equal(newPe[1].detail.identity_digest, expectDigest, '新代 digest 必须含 assignment_seq=1（代际隔离）');
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w2',
    '--mem-snapshot', memSnapshotJson(), '--now', T);
  assert.equal(r.status, 0, `重派后重新 render 的派工应 exit 0: ${r.stderr}`);
});

// =====================================================================
// sc-p0d：staleness 只读子命令
// =====================================================================
test('sc-p0d: staleness 基本输出——phase/version/last_event_at/minutes 与 --now 注入、无事件 null', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 无事件：last_event_at/minutes 必须 null（不伪造 0）
  let r = cli('staleness', ledgerPath, '--now', '2026-08-09T01:30:00Z');
  assert.equal(r.status, 0, `staleness 应 exit 0: ${r.stderr}`);
  let out = JSON.parse(r.stdout);
  assert.equal(out.phase, 'splitting');
  assert.equal(out.version, 0);
  assert.equal(out.last_event_at, null, '无事件时 last_event_at 必须 null（不伪造 0）');
  assert.equal(out.minutes_since_last_event, null, '无事件时 minutes_since_last_event 必须 null');
  assert.deepEqual(out.in_flight_groups, []);
  assert.equal(out.all_waves_integrated, false);
  // 派工几步（每次写事件）后：last_event_at=最后事件 at、minutes 按注入 now 计算
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  const st = readLedger(ledgerPath);
  r = cli('staleness', ledgerPath, '--now', '2026-08-09T01:30:00Z');
  out = JSON.parse(r.stdout);
  assert.equal(out.last_event_at, st.events[st.events.length - 1].at, 'last_event_at = 最后一条事件 at');
  // 最后事件 = packet_rendered（render 写事件，at=系统时钟或缺省）——minutes 只断言非 null 可算
  assert.equal(typeof out.minutes_since_last_event, 'number', '有事件时 minutes 必须可计算');
  assert.ok(out.minutes_since_last_event >= 0, 'minutes 必须非负');
  // 导出函数与 CLI 同实现：函数层输出与 CLI 逐字段一致
  const fnOut = staleness({ ledgerPath, now: '2026-08-09T01:30:00Z' });
  assert.deepEqual(fnOut, out, '导出函数与 CLI 必须输出同一份 JSON');
});

test('sc-p0d: in_flight_groups 按「未完成集成」语义过滤——dispatched/delivered/review_pass 可见，其余不可见', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 手工构造六态组（各 wave 一组；verified 组带身份字段保持 schema 合法）
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const states = ['pending', 'dispatched', 'executing', 'blocked', 'e2e', 'review', 'pr-open', 'accepted', 'failed'];
  const base = ledger.waves[0].groups[0];
  const inFlight = ['dispatched', 'executing', 'blocked', 'e2e', 'review', 'pr-open'];
  ledger.waves = states.map((s, i) => ({
    wave: i + 1, integrated_tip: null,
    groups: [{
      ...base, group_id: `g-${s}`, state: s, sc_ids: [`sc-${s}`],
      worker_label: s === 'pending' ? null : 'w',
      tip_sha: ['e2e', 'review', 'pr-open', 'accepted'].includes(s) ? SHA1 : null,
      dispatched_at: s === 'pending' ? null : T,
      review: { rounds: 0, unresolved: 0 },
      verify: { status: null, evidence_ref: null },
      worktree: s === 'accepted' ? '/wt/x' : (base.worktree ?? null),
      branch: s === 'accepted' ? 'feat/x' : (base.branch ?? null),
      base: s === 'accepted' ? SHA3 : (base.base ?? null),
      session_id: s === 'pending' ? null : `sess-${s}`,
      title: s === 'accepted' ? 'Skills-x丨 0902' : null,
      pr_url: ['pr-open', 'accepted'].includes(s) ? 'https://github.com/xindong/mivo-canvas-plugin/pull/1' : null,
      provider_id: s === 'accepted' ? 'art' : null,
      assignment_seq: 0,
    }],
  }));
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const out = staleness({ ledgerPath, now: '2026-08-09T01:30:00Z' });
  const visible = out.in_flight_groups.map((g) => g.state).sort();
  assert.deepEqual(visible, [...inFlight].sort(), 'in_flight 必须恰含 dispatched/executing/blocked/e2e/review/pr-open');
  for (const g of out.in_flight_groups) {
    assert.equal(typeof g.group_id, 'string', 'in_flight 条目必须含 group_id');
    assert.equal(typeof g.state, 'string', 'in_flight 条目必须含 state');
    assert.ok('dispatched_at' in g, 'in_flight 条目必须含 dispatched_at 键');
  }
  // 对照：给 review_pass 补落事件不是判据（state 过滤已捕获）——events 全空时 review_pass 仍可见
  const ledger2 = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger2.events = [];
  writeFileSync(ledgerPath, `${JSON.stringify(ledger2, null, 2)}\n`);
  const out2 = staleness({ ledgerPath, now: '2026-08-09T01:30:00Z' });
  assert.equal(out2.in_flight_groups.filter((g) => g.state === 'review').length, 1,
    'review_pass 组不落事件也必须在 in_flight（伪修复「给 review_pass 补落事件」不采用）');
});

test('sc-p0d: all_waves_integrated + ready 冻结不拦读 + --now 非法拒 + 未知 flag 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 手工构造全集成台账
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  for (const w of ledger.waves) w.integrated_tip = SHA1;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  let out = staleness({ ledgerPath, now: '2026-08-09T01:30:00Z' });
  assert.equal(out.all_waves_integrated, true, '全波集成后 all_waves_integrated=true');
  // phase=ready（冻结态）：staleness 只读不拦（冻结只拦写路径）
  const ledger2 = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger2.phase = 'ready';
  ledger2.phase_at = T;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger2, null, 2)}\n`);
  let r = cli('staleness', ledgerPath, '--now', '2026-08-09T01:30:00Z');
  assert.equal(r.status, 0, `ready 冻结期 staleness 应 exit 0（只读不拦）: ${r.stderr}`);
  out = JSON.parse(r.stdout);
  assert.equal(out.phase, 'ready');
  // --now 非法 → exit 2 点名；未知 flag → exit 2
  r = cli('staleness', ledgerPath, '--now', 'not-a-time');
  assert.equal(r.status, 2, 'staleness --now 非法必须 exit 2');
  assert.match(r.stderr, /无法解析为时间戳/);
  r = cli('staleness', ledgerPath, '--foo', 'x');
  assert.equal(r.status, 2, 'staleness 未知 flag 必须 exit 2（只读命令同样 exact）');
  assert.match(r.stderr, /未知 flag/);
});

// =====================================================================
// 兼容模式对照（init 无 --baseline → baseline_tip=null → 三道新闸全部跳过）
// =====================================================================
test('sc-p0a/b/c 兼容模式对照——init 无 baseline 时基线闸/快照闸/凭证闸全部不强制（e2e-dryrun 路径）', () => {
  const dir = newTmpDir();
  const manifestPath = fixtureCopy(dir);
  const ledgerPath = join(dir, 'ledger.json');
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'compat', '--now', T);
  assert.equal(r.status, 0, `兼容模式 init 应 exit 0: ${r.stderr}`);
  // 基线闸跳过：identity base 任意 40hex（非 init 基线）放行
  r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/x', base: SHA1, session_id: 'sess-g4' }), '--now', T);
  assert.equal(r.status, 0, `兼容模式 identity base 任意放行（基线闸跳过）: ${r.stderr}`);
  // 凭证闸/快照闸跳过：无 render、无 mem-snapshot 直接派工（session_id 仍必填）
  r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--now', T);
  assert.equal(r.status, 0, `兼容模式派工无需凭证/快照应放行: ${r.stderr}`);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'dispatched');
});

// =====================================================================
// ④：identity.worktree 强制绝对路径
// =====================================================================
test('④: --identity.worktree 相对路径拒（强制绝对路径，exit 2 点名 + 字节不变）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const wt of ['relative/worktree', './wt/g4', 'wt/g4']) {
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
      JSON.stringify({ worktree: wt, branch: 'feat/x', base: SHA3 }), '--now', T);
    assert.equal(r.status, 2, `相对 worktree ${wt} 必须 exit 2`);
    assert.match(r.stderr, /绝对路径/, '必须点名绝对路径要求');
    assert.equal(readFileSync(ledgerPath, 'utf8'), before, '拒写后台账字节必须不变');
  }
  const g = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g.worktree, null, '拒写后 worktree 不得被写入');
  // 对照：绝对路径放行
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/x', base: SHA3 }), '--now', T);
  assert.equal(r.status, 0, `绝对 worktree 应 exit 0: ${r.stderr}`);
});

// ============ 组 F：main guard realpath 归一（与 selfcheck 组F-1 / mem-probe 组F-1 同型） ============
// 前提：import.meta.url 已被 ESM loader 规范化（realpath 后的真实路径），而 process.argv[1] 是调用方
// 原样路径。macOS 上 os.tmpdir() 落在 /var/folders/...（/var → /private/var symlink），以逻辑 /var 路径
// 调用时两者恒不相等（旧 guard 的 resolve(argv[1]) 不解析 symlink）——main 静默不执行（exit 0 + 零输出，
// 与「写成功」同形，台账操作直接变假）。本用例断言：非规范化路径调用必须真的执行 init 并创建台账；
// 只断言 exit code 会被「零输出」骗过。
test('组F-1: 非规范化路径调用必须实际执行 init 并创建台账（main guard realpath 归一）', (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rl-norm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 保持 <root>/scripts/run-ledger.mjs 布局：脚本 root = dirname(import.meta.url) + '..'，
  // config/defaults.json 按 root 解析（缺了会让命令与 guard 无关地失败）
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  cpSync(join(ROOT, 'scripts/run-ledger.mjs'), join(dir, 'scripts/run-ledger.mjs'));
  writeFileSync(join(dir, 'config/defaults.json'), readFileSync(join(ROOT, 'config/defaults.json'), 'utf8'));
  // link 名必须唯一：历史用 process.pid，进程被杀时 t.after 未注册 → link-<PID> 残留；
  // 宿主并发下 PID 复用即撞名 EEXIST（mem-probe/selfcheck 组F-1 同款，tmpdir 曾积上千残留）。
  // dir 名来自 mkdtemp 唯一，用它派生 link 名——残留永不撞名，非规范化语义不变。
  const link = join(realpathSync(tmpdir()), `rl-norm-link-${basename(dir)}`);
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  assert.notEqual(realpathSync(link), link, '前置条件: 调用路径必须非规范化（否则本用例空转）');
  // 真实写操作：init 经非规范化路径执行 → 台账必须真的创建（静默跳过时连文件都不存在）
  const runDir = mkdtempSync(join(realpathSync(tmpdir()), 'rl-norm-run-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const ledgerPath = join(runDir, 'ledger.json');
  const manifestPath = fixtureCopy(runDir);
  const r = spawnSync(process.execPath,
    [join(link, 'scripts/run-ledger.mjs'), 'init', ledgerPath, '--manifest', manifestPath, '--run-id', 'norm', '--now', T, '--baseline', SHA3],
    { encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(text.length > 0, '非规范化路径调用不得静默零输出（guard 被 bypass 的形态就是 exit 0 + 全空）');
  assert.ok(text.includes('init: 台账已创建'), `非规范化路径调用必须实际执行 init，实际:\n${text}`);
  assert.ok(existsSync(ledgerPath), 'init 必须真的创建台账文件（静默跳过时文件不存在）');
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${text}`);
});


// =====================================================================
// 变异反证（F1/F2 集成契约）：两组各自测试全绿 ≠ 串起来正确
// =====================================================================
// 机制同 ready-check.test.mjs 的 mutation-kill：把 scripts/tests/config/SKILL.md/graph.json 复制到
// 临时目录，对 run-ledger.mjs 副本应用变异（精确字符串替换，锚点唯一），跑「跳过变异测试自身」
// （RL_MUTATION_CHILD=1 + RC_MUTATION_CHILD=1）的完整 7 文件套件（清单见 RL_MUTATION_TEST_FILES），
// 断言失败集恰为预测集——
// 排除说明（两个测试文件都未列入，各有一个独立原因）：
//   - selfcheck.test.mjs：其组B-1/组B-3 的 --live 接线检查依赖「真实仓库」（symlink 目标与 git
//     common dir 同源），在变异复制树中天然 FAIL，与本三缺陷的变异无关（RL_MUTATION_TEST_FILES
//     定义处有同款注释）。
//   - run-tests.test.mjs：它测的是 runner 自身的枚举契约与黑盒入口（spawn run-tests.mjs 跑 fixture），
//     与 run-ledger 写路径 / ready-check 读路径无断言交集，列入只会让子套件多跑一轮完整 runner。
// 挖红（失败集非空）+ 隔离（恰等于预测集，无多余无遗漏）。真实脚本永不被触碰，无需恢复。
//
// F1 变异：把 dispatch/delivery 事件 detail 写回字符串（旧行为，ready-check 读 e.detail?.group_id
//   恒 undefined → 分区对账与 delivery 绑定形同虚设）。新 schema 拒字符串 → 所有经过 set-state
//   派工/交付的断言红 + e2e 全链红；record-delivery 单侧（写路径未变异）、ready-check 单侧
//   （夹具本就是对象 detail）与其余测试绿。
// F2 变异：把 phase_at 从 LEDGER_TOP_KEYS 挖掉 → ready 台账成「未列键」形状，run-ledger
//   readLedger/validate 即拒；预测红集 = 读 ready 台账的断言 + ready-check 链尾 validate + e2e 链尾 validate。
const RL_MUTATION_PREDICTIONS = [
  {
    id: 'F1 变异',
    label: 'dispatch/delivery detail 写回字符串（F1 修复点挖除）',
    mutate: (src) => src
      .replace(
        'detail: { group_id: group, worker_label: g.worker_label, session_id: g.session_id },',
        'detail: `group=${group} worker_label=${g.worker_label}`,',
      ),
    red: [
      'sc-p1d: 合法链全通（dispatched→executing→e2e→review→pr-open→accepted）',
      'sc-p1d: dispatched→executing 缺 gate_goal 拒',
      'sc-p1d: executing→e2e 缺 gate_routing 拒',
      'sc-p1d: unresolved>0 时 accepted 拒',
      'sc-p1d: 非法跳转矩阵全部 exit 2 且落 illegal_transition 事件',
      'sc-p1d: failed→pending 后 rounds==0 且 tip_sha/worker_label/身份三键清空（重派不继承旧计数/旧身份）',
      'sc-p1d: tip_sha 非 40hex 拒（任意字符串拒，格式校验）',
      'sc-p1d: phase 单向前进合法链 + 波次顺序门（F-E）+ →ready receipt 凭据（F-F）',
      'sc-p1d: F-E ② 波次顺序门——wave1 未集成时 wave2 组派工必拒（跳过未完成前波开工）',
      'sc-p1d: wave 集成——非 40hex 拒、全组未 verified 拒、集成后可落账',
      'sc-p1e: 验收组模板无 goal 触发行、含整合树复查项（integrated_tip 引用 + squash diff 复查指令）',
      'sc-p1e: T 阶段包 verify_cmds 与夹具 manifest 尾波逐条一致',
      'sc-p2d: 全链 dry-run——先红（缺 e2e 报告与 presubmit 三闸）后绿（READY_FOR_LATER_SUBMIT_PR_SKILL + 台账 phase→ready + 链尾 validate exit 0）',
      'sc-p2d: 双账本一致性——collected_tip 与 tip_sha 不一致时链路中断于 integrate 前',
      'sc-p2d: 槽位对账——used_slots 与 dispatched 未归档组数一致无告警、不符出告警行',
      'F-H: →verified 无 pass 凭据拒（verify.status=null 或手工伪造的 evidence_ref 均拒）',
      'P2: 对照——delivery 事件合法通道仍工作（record-delivery 交卷）',
      // ① 升级后改造的测试含 set-state dispatch/delivered 步骤（走 dispatch/delivery 写路径）：
      // F1 变异字符串化 detail → schema 拒 → 这些测试的 set-state 步骤红（确定性，语义合法扩展）
      // 「F-J: 重复 id」不在列：sc-p0c 迁移后该测试删除 dispatched 步骤（render-packet 被 F-J
      // 拒、无凭证可派工），record-delivery 对 pending 组直接命中 PACKET_INCOMPLETE 不写事件——
      // F1 变异下保持绿（语义合法收缩，测试注释同步说明）。
      'F-J: 对照——packet.scs_inline 无重复时，交卷缺一/多一/重复仍按计数比对拒（原有 exact 语义保留）',
      'sc-p1h: record-delivery 交卷文件路径（--payload @file）解析',
      'sc-p1h: 审查交卷 candidate_sha 合法入账——detail 携带审查方声明值（非派生默认）',
      'sc-p1h: 审查组合法交卷——unresolved 由此机器写入 review.unresolved（唯一入账通道）',
      'sc-p1h: 执行组合法交卷入账成功且台账对应字段逐项等于交卷值',
      'sc-p1h: 验收组合法交卷——verify.status/evidence_ref 入账',
      '①: 重派链 failed→pending 后 exec 重新交卷放行（生命周期门不挡重派正常链路）',
      // F-D →ready 绑定测试走完整链（set-state dispatch/delivery + record-delivery 写路径）：
      // F1 变异字符串化 detail → 链上 set-state 步骤 schema 拒 → 红（语义合法扩展，与上组同因）
      'F-D: →ready 绑定 manifest 内容——最后一次 hash 绑定后篡改，receipt 驱动必须 exit 2 HASH_MISMATCH（台账 phase 不前进）',
      'F-D: →ready manifest 绑定不误伤合法链——三重校验（manifest 内容/ledger_version/candidate_sha）各自独立成立',
      // sc-p0a/b/c 新增断言组中含「set-state dispatched 成功」步骤（走 dispatch 写路径）：
      // F1 变异字符串化 detail → schema 拒 → 这些测试的派工步骤红（确定性，语义合法扩展，
      // 与上方「① 升级后改造的测试」同因同款）。sc-p0a 的漂移拒测试经手工构造集成状态、
      // sc-p0d 的 staleness 测试只经 identity/render（不写 dispatch/delivery 事件），保持绿。
      'sc-p0b: 合法快照放行 + 导出函数同判据（assertMemSnapshot 直接调）+ 非 JSON 拒',
      'sc-p0c: render 后派工放行 + 事件 detail 契约（identity_digest 现算比对 + packet_sha256 + assignment_seq）',
      'sc-p0c: 身份变更后旧凭证失配拒（digest 不匹配，exit 2「身份已变更未重出包」）',
      'sc-p0c: 重派代际隔离——重派后 assignment_seq+1 旧凭证失配拒、重新 render 后放行、旧事件保留审计',
      'sc-p0a/b/c 兼容模式对照——init 无 baseline 时基线闸/快照闸/凭证闸全部不强制（e2e-dryrun 路径）',
      // F3 测试含 set-state dispatched 写路径步骤（推到 dispatched 验证守卫）：
      // F1 变异字符串化 detail → 该步骤 schema 拒 → 红（同上方 sc-p0c 组同因同款）
      'F3: dispatched 及之后 --identity 写入拒（pending-only 守卫，exit 2 点名当前状态 + 重派指路）',
      // ae-prewalk 组经 dispatchG4（set-state dispatched）再 record-delivery：
      // F1 变异字符串化 dispatch detail → schema 拒 → 派工步骤红（同 sc-p0c 组同因）
      'ae-prewalk-class: 四键 exact 判为 prewalk；exec 多塞 first_edit 红；prewalk 少 open_unknowns 红',
      'ae-first-edit-contract: sha 非 40hex / open_unknowns 长度 5 / sentence 超限 均 DELIVERY_SCHEMA',
      'ae-first-edit-exists: 40hex 但不在 worktree 的 sha 红；sha 在但 path 不在该 commit 红；真 sha+path 绿',
      'ae-prewalk-lifecycle: 第二组交 prewalk 红；同一组交第二次红；pending/delivered 交 prewalk 红',
      'ae-prewalk-persist: 入账后再读 events 含四键原文，无只剩 status/tip_sha/scs 的摘要替代',
      'ae-prewalk-render: render 前后 manifest_core_hash 不变；包文含 first_edit.path 与 landmines',
      'ae-prewalk-handoff: 后续执行组出包含波0组的 first_edit.path/landmines，hashed packet 仍无四键',
      // lead-self 正路径走 set-state dispatched（写 dispatch 事件）+ record-delivery exec：
      // F1 变异字符串化 dispatch detail → schema 拒 → 派工步骤红（同 sc-p0c 组同因）
      'lead-self: worker-label=lead-self 逻辑派工后 exec 交卷成功（无真实 Orca worker）',
    ],
  },
  {
    id: 'F2 变异',
    label: 'phase_at 从 LEDGER_TOP_KEYS 挖除（F2 修复点挖除）',
    // 只挖 phase_at 行：baseline_tip 独立成行（sc-p0a 新键）不在此锚点范围内——
    // 挖掉它会让所有含 baseline_tip 的台账成「未列键」而全量红，污染 F2 的失败集契约。
    mutate: (src) => src.replace(
      "  'version', 'phase', 'phase_at',",
      "  'version', 'phase',",
    ),
    // phase_at 写入路径的消费侧测试：闭环（ready-check 铸 receipt → run-ledger 消费 → ready）、
    // 并发（末轮 receipt 驱动）、sc-p1d / sc-p2d 都由 run-ledger 驱动 phase→ready，写 phase_at——
    // 从 exact 键白名单挖除后在 assertLedgerSchema 处撞 schema 拒，是 F2 契约的真实红集。
    // ready-check 的 full 测试不在此列：新架构下 ready-check 只写 receipt 不写台账
    // （phase_at 由 run-ledger 驱动时写入），full 不再触碰 phase_at，挖除后应保持绿。
    // 预测随测试名同步（机制耦合，防变异测试静默空转）。
    red: [
      'sc-p1d: phase 单向前进合法链 + 波次顺序门（F-E）+ →ready receipt 凭据（F-F）',
      '闭环: ready-check 写出 receipt → run-ledger set-state --ready-receipt 消费 → exit 0 成功到 ready',
      '并发: 同台账双进程同时跑 ready-check → 双 READY、台账 version 全程不变，receipt 驱动恰 1 成功（30 轮）',
      'sc-p2d: 全链 dry-run——先红（缺 e2e 报告与 presubmit 三闸）后绿（READY_FOR_LATER_SUBMIT_PR_SKILL + 台账 phase→ready + 链尾 validate exit 0）',
      // F-D →ready 正例测试断言 phase=ready + phase_at（F2 契约的读取点）：
      // 变异挖除 phase_at → ready 台账成未列键形状 → 读即拒 → 红（语义合法扩展）
      'F-D: →ready manifest 绑定不误伤合法链——三重校验（manifest 内容/ledger_version/candidate_sha）各自独立成立',
      // sc-p0d staleness 测试手工构造 phase=ready 台账（schema 要求 ready 必带 phase_at）：
      // 变异挖除 phase_at → readLedger 拒 → staleness 读红（同一「读 ready 台账」契约，语义合法扩展）
      'sc-p0d: all_waves_integrated + ready 冻结不拦读 + --now 非法拒 + 未知 flag 拒',
    ],
  },
  {
    id: 'G1 变异',
    label: '组可写性守卫挖除（identity pending-only 守卫 + 交卷生命周期门两锚点 → if (false)，① 修复点）',
    mutate: (src) => src
      .replace(
        "if (g.state !== 'pending') {",
        'if (false) {',
      )
      .replace(
        'if (!allowedStates.includes(g.state)) {',
        'if (false) {',
      ),
    red: [
      '①: verified 组 --identity 写入拒（exit 2 点名 + 台账字节不变，终态只读）',
      // F3 收紧为 pending-only 后，dispatched 态改身份同样由本守卫拒绝——守卫挖除即放行红
      // （同一锚点同一契约，语义合法扩展；verified 拒是 pending-only 的子集）
      'F3: dispatched 及之后 --identity 写入拒（pending-only 守卫，exit 2 点名当前状态 + 重派指路）',
      '①: verified 组 record-delivery 拒（exec/review/verify 三类交卷全拒 + 字节不变）',
      '①: 方向 B——pending 组提交合法 verify payload 拒（验收证据不可预写）+ 字节不变',
      '①: 交卷生命周期矩阵——每类交卷在每个非法状态 exit 2 + 字节不变，合法状态放行',
      // G1 挖掉 allowedStates 门后，pending/delivered 组也能交 prewalk → 本条红
      'ae-prewalk-lifecycle: 第二组交 prewalk 红；同一组交第二次红；pending/delivered 交 prewalk 红',
      // lead-self 反路径：init 后 pending 组直接 exec 交卷，正是生命周期门在咬；
      // G1 挖掉 allowedStates 门后该条放行 → 红（同一锚点，语义合法扩展）
      'lead-self: pending 组直接 record-delivery exec 被生命周期门拒绝',
    ],
  },
  {
    id: 'G2 变异',
    label: 'flag allowlist 挖除（unknown 恒为空数组，③ 修复点）',
    mutate: (src) => src.replace(
      'const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));',
      'const unknown = [];',
    ),
    red: [
      '③: 未知 flag 静默忽略修复——init/set-state typo flag exit 2 点名未知 flag',
      '③: 未知 flag 带值形态拒（--unrecognised value 此前 exit 0 且写入成功）+ read 子命令 validate 同样覆盖',
      // sc-p0d staleness 测试含「staleness 未知 flag 拒」断言（只读子命令同样 exact allowlist）：
      // G2 变异挖除 unknown 过滤 → staleness 接受未知 flag → 该断言红（同一 allowlist 契约，语义合法扩展）
      'sc-p0d: all_waves_integrated + ready 冻结不拦读 + --now 非法拒 + 未知 flag 拒',
    ],
  },
  {
    id: 'P0A 变异',
    label: 'expectedBase 比对挖除（sc-p0a 基线闸双点：identity 写入 + render-packet 出包 → if (false)）',
    mutate: (src) => src
      .replace(
        'if (parsed.base !== exp.base) {',
        'if (false) {',
      )
      .replace(
        'if (base !== exp.base) {',
        'if (false) {',
      ),
    // 红集 = 基线闸断言组（漂移拒绝断言 exit 2 的用例）；合法流程（base=期望基线）挖除后
    // 照样放行保持绿；expectedBase 函数本身不在变异范围（单一判据仍在）。兼容模式对照
    // 用例本就不触发比对，挖除后不变。既有迁移测试的合法派工同样绿（隔离性验证）。
    red: [
      'sc-p0a: identity 写入基线漂移拒——base≠期望基线 exit 2 且消息含期望/实得/来源（init 基线）',
      'sc-p0a: render-packet 出包基线漂移拒——组 base≠期望基线 exit 2 且消息含期望/实得/来源（wave N 集成点）',
    ],
  },
  {
    id: 'P0B 变异',
    label: '--mem-snapshot 必填挖除（sc-p0b 快照闸缺失拒绝 → if (false)）',
    mutate: (src) => src.replace(
      'if (parsedMemSnapshot === undefined) {',
      'if (false) {',
    ),
    // 红集 = 缺失断言组；非法形状拒绝走 assertMemSnapshot（独立校验函数，不在变异范围）——
    // 未知键/缺键/负数/类型错/concurrency>cap/used_slots>cap 仍拒，保持绿（隔离性验证）。
    // 合法快照与兼容模式对照用例不依赖缺失拒绝，保持绿。
    red: [
      'sc-p0b: dispatched 缺 --mem-snapshot 拒（严格模式，exit 2 点名）',
    ],
  },
  {
    id: 'P0C 变异',
    label: 'packet_rendered 前置挖除（sc-p0c 凭证闸两锚点：无事件 + digest 失配 → if (false)）',
    mutate: (src) => src
      .replace(
        'if (!latest) {',
        'if (false) {',
      )
      .replace(
        'if (latest.detail.identity_digest !== curDigest) {',
        'if (false) {',
      ),
    // 红集 = 凭证闸断言组（依赖「无凭证拒绝」的用例）；render 后派工放行（凭证满足）与
    // 兼容模式对照（本就不强制）不依赖拒绝路径，保持绿（隔离性验证）。
    red: [
      'sc-p0c: 未 render 派工拒（无 packet_rendered 事件，exit 2 点名）',
      'sc-p0c: 身份变更后旧凭证失配拒（digest 不匹配，exit 2「身份已变更未重出包」）',
      'sc-p0c: 重派代际隔离——重派后 assignment_seq+1 旧凭证失配拒、重新 render 后放行、旧事件保留审计',
    ],
  },
];

function prewalkPayload({
  sha = SHA1,
  path = 'scripts/run-ledger.mjs',
  sentence = 'first reversible commit',
  read_paths = ['scripts/run-ledger.mjs'],
  landmines = [{ path: 'scripts/run-ledger.mjs', sentence: 'exact key set' }],
  open_unknowns = [{ sentence: 'open question one' }],
} = {}) {
  return {
    first_edit: { sha, path, sentence },
    read_paths,
    landmines,
    open_unknowns,
  };
}

function dispatchG4(ledgerPath) {
  assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
  renderGroup(ledgerPath, 'g4');
  const r = cli(
    'set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched',
    '--worker-label', 'w1', '--mem-snapshot', memSnapshotJson(), '--now', T,
  );
  assert.equal(r.status, 0, r.stderr);
}

function bindG4Worktree(ledgerPath, worktree) {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  ledger.waves[0].groups[0].worktree = worktree;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** 在既有台账/manifest 上挂一个同波执行组（夹具只有 g4+v1，测跨组 PreWalk 注入用）。 */
function attachSiblingExecGroup(ledgerPath, manifestPath, groupId) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const srcPkt = manifest.dispatch.packets.find((p) => p.group_id === 'g4');
  const pkt = JSON.parse(JSON.stringify(srcPkt));
  pkt.group_id = groupId;
  pkt.scs_inline = [srcPkt.scs_inline[0]];
  manifest.dispatch.packets.push(pkt);
  manifest.waves[0].groups.push({
    group_id: groupId,
    sc_ids: [srcPkt.scs_inline[0].id],
    worker_count: 1,
  });
  manifest.manifest_core_hash = manifestCoreHash(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const srcG = ledger.waves[0].groups[0];
  ledger.waves[0].groups.push({
    group_id: groupId,
    state: 'pending',
    sc_ids: [srcG.sc_ids[0]],
    worker_label: null,
    dispatched_at: null,
    tip_sha: null,
    review: { rounds: 0, unresolved: 0 },
    verify: { status: null, evidence_ref: null },
    worktree: null,
    branch: null,
    base: null,
    assignment_seq: 0,
  });
  ledger.manifest_core_hash = manifest.manifest_core_hash;
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

function makeGitRepoWithFile(t, relPath, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'prewalk-git-'));
  const runGit = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: buildChildEnv(process.env) });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  runGit(['init', '-q']);
  runGit(['config', 'user.email', 'fixture@test.local']);
  runGit(['config', 'user.name', 'Fixture']);
  mkdirSync(join(dir, dirname(relPath)), { recursive: true });
  writeFileSync(join(dir, relPath), contents);
  runGit(['add', '-A']);
  runGit(['commit', '-q', '-m', 'prewalk fixture']);
  const sha = runGit(['rev-parse', 'HEAD']).stdout.trim();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sha };
}

test('ae-prewalk-class: 四键 exact 判为 prewalk；exec 多塞 first_edit 红；prewalk 少 open_unknowns 红', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  dispatchG4(ledgerPath);
  const missing = { first_edit: { sha: SHA1, path: 'scripts/run-ledger.mjs', sentence: 'x' }, read_paths: [], landmines: [] };
  let before = readFileSync(ledgerPath, 'utf8');
  let r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(missing), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DELIVERY_SCHEMA/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);

  const mixed = { ...execDeliveryPayload({ tipSha: SHA2 }), first_edit: { sha: SHA1, path: 'a', sentence: 'x' } };
  before = readFileSync(ledgerPath, 'utf8');
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(mixed), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DELIVERY_SCHEMA/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);
});

test('ae-first-edit-contract: sha 非 40hex / open_unknowns 长度 5 / sentence 超限 均 DELIVERY_SCHEMA', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  dispatchG4(ledgerPath);
  const cases = [
    prewalkPayload({ sha: SHA39 }),
    prewalkPayload({ open_unknowns: Array.from({ length: 5 }, (_, i) => ({ sentence: `u${i}` })) }),
    prewalkPayload({ sentence: 'x'.repeat(81) }),
  ];
  for (const payload of cases) {
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, JSON.stringify(payload).slice(0, 80));
    assert.match(r.stderr, /DELIVERY_SCHEMA/);
    assert.equal(readFileSync(ledgerPath, 'utf8'), before);
  }
});

test('ae-first-edit-exists: 40hex 但不在 worktree 的 sha 红；sha 在但 path 不在该 commit 红；真 sha+path 绿', (t) => {
  const { dir: repo, sha } = makeGitRepoWithFile(t, 'scripts/run-ledger.mjs', 'ok\n');
  const tmp = newTmpDir();
  const { ledgerPath } = initLedgerFor(tmp);
  dispatchG4(ledgerPath);
  bindG4Worktree(ledgerPath, repo);

  let before = readFileSync(ledgerPath, 'utf8');
  let r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(prewalkPayload({ sha: SHA1 })), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FIRST_EDIT_MISSING/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);

  before = readFileSync(ledgerPath, 'utf8');
  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(prewalkPayload({ sha, path: 'no/such/file.mjs' })), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FIRST_EDIT_MISSING/);
  assert.equal(readFileSync(ledgerPath, 'utf8'), before);

  r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(prewalkPayload({ sha, path: 'scripts/run-ledger.mjs' })), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const ev = ledger.events.filter((e) => e.type === 'delivery').at(-1);
  assert.equal(ev.detail.first_edit.sha, sha);
  assert.equal(ev.detail.first_edit.path, 'scripts/run-ledger.mjs');
  assert.deepEqual(ev.detail.read_paths, ['scripts/run-ledger.mjs']);
  assert.equal(ledger.waves[0].groups[0].state, 'dispatched');
});

test('ae-prewalk-lifecycle: 第二组交 prewalk 红；同一组交第二次红；pending/delivered 交 prewalk 红', (t) => {
  const { dir: repo, sha } = makeGitRepoWithFile(t, 'scripts/run-ledger.mjs', 'ok\n');
  const payload = prewalkPayload({ sha, path: 'scripts/run-ledger.mjs' });

  const pendingDir = newTmpDir();
  const pending = initLedgerFor(pendingDir);
  assignIdentity(pending.ledgerPath, 'g4', 'feat/run-ledger');
  bindG4Worktree(pending.ledgerPath, repo);
  let before = readFileSync(pending.ledgerPath, 'utf8');
  let r = cli('record-delivery', pending.ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
  assert.equal(readFileSync(pending.ledgerPath, 'utf8'), before);

  const deliveredDir = newTmpDir();
  const delivered = initLedgerFor(deliveredDir);
  dispatchG4(delivered.ledgerPath);
  forgeG4State(delivered.ledgerPath, 'review');
  bindG4Worktree(delivered.ledgerPath, repo);
  before = readFileSync(delivered.ledgerPath, 'utf8');
  r = cli('record-delivery', delivered.ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
  assert.equal(readFileSync(delivered.ledgerPath, 'utf8'), before);

  const okDir = newTmpDir();
  const ok = initLedgerFor(okDir);
  dispatchG4(ok.ledgerPath);
  bindG4Worktree(ok.ledgerPath, repo);
  r = cli('record-delivery', ok.ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  before = readFileSync(ok.ledgerPath, 'utf8');
  r = cli('record-delivery', ok.ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
  assert.equal(readFileSync(ok.ledgerPath, 'utf8'), before);

  r = cli('record-delivery', ok.ledgerPath, '--group', 'v1', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
});

test('ae-prewalk-persist: 入账后再读 events 含四键原文，无只剩 status/tip_sha/scs 的摘要替代', (t) => {
  const { dir: repo, sha } = makeGitRepoWithFile(t, 'scripts/run-ledger.mjs', 'ok\n');
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  dispatchG4(ledgerPath);
  bindG4Worktree(ledgerPath, repo);
  const payload = prewalkPayload({ sha, path: 'scripts/run-ledger.mjs' });
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const ev = ledger.events.filter((e) => e.type === 'delivery').at(-1);
  assert.deepEqual(ev.detail.first_edit, payload.first_edit);
  assert.deepEqual(ev.detail.read_paths, payload.read_paths);
  assert.deepEqual(ev.detail.landmines, payload.landmines);
  assert.deepEqual(ev.detail.open_unknowns, payload.open_unknowns);
  assert.equal(ev.detail.status, undefined);
  assert.equal(ev.detail.tip_sha, undefined);
  assert.equal(ev.detail.scs, undefined);
});

test('ae-prewalk-render: render 前后 manifest_core_hash 不变；包文含 first_edit.path 与 landmines', (t) => {
  const { dir: repo, sha } = makeGitRepoWithFile(t, 'scripts/run-ledger.mjs', 'ok\n');
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  dispatchG4(ledgerPath);
  bindG4Worktree(ledgerPath, repo);
  const beforeHash = JSON.parse(readFileSync(ledgerPath, 'utf8')).manifest_core_hash;
  const payload = prewalkPayload({ sha, path: 'scripts/run-ledger.mjs' });
  let r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('render-packet', ledgerPath, '--group', 'g4');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /first_edit\.path=scripts\/run-ledger\.mjs/);
  assert.match(r.stdout, /landmines:/);
  assert.match(r.stdout, /exact key set/);
  const after = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(after.manifest_core_hash, beforeHash);
  const manifest = JSON.parse(readFileSync(after.manifest_path, 'utf8'));
  const pkt = manifest.dispatch.packets.find((p) => p.group_id === 'g4');
  assert.equal(Object.hasOwn(pkt, 'first_edit'), false);
  assert.equal(Object.hasOwn(pkt, 'landmines'), false);
});

test('ae-prewalk-handoff: 后续执行组出包含波0组的 first_edit.path/landmines，hashed packet 仍无四键', (t) => {
  const { dir: repo, sha } = makeGitRepoWithFile(t, 'scripts/run-ledger.mjs', 'ok\n');
  const dir = newTmpDir();
  const { ledgerPath, manifestPath } = initLedgerFor(dir);
  dispatchG4(ledgerPath);
  bindG4Worktree(ledgerPath, repo);
  const payload = prewalkPayload({ sha, path: 'scripts/run-ledger.mjs' });
  let r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, r.stderr);

  attachSiblingExecGroup(ledgerPath, manifestPath, 'g5');
  assignIdentity(ledgerPath, 'g5', 'feat/g5');
  r = cli('render-packet', ledgerPath, '--group', 'g5');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /first_edit\.path=scripts\/run-ledger\.mjs/);
  assert.match(r.stdout, /landmines:/);
  assert.match(r.stdout, /exact key set/);
  assert.match(r.stdout, /组 g5/);
  const after = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(after.manifest_path, 'utf8'));
  const pkt = manifest.dispatch.packets.find((p) => p.group_id === 'g5');
  assert.equal(Object.hasOwn(pkt, 'first_edit'), false);
  assert.equal(Object.hasOwn(pkt, 'landmines'), false);

  const dir2 = newTmpDir();
  const second = initLedgerFor(dir2);
  attachSiblingExecGroup(second.ledgerPath, second.manifestPath, 'g5');
  assignIdentity(second.ledgerPath, 'g5', 'feat/g5');
  r = cli('render-packet', second.ledgerPath, '--group', 'g5');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /## PreWalk 现场/);
});

// 变异子套件要跑的测试文件集（含 e2e-dryrun 与 ready-check，证明「其余绿」覆盖到消费侧单测，
// 不只是生产侧）。不含 selfcheck.test.mjs：其组B-1/组B-3 的 --live 接线检查依赖「真实仓库」
// （symlink 目标与 git common dir 同源），在变异复制树中天然 FAIL，与本三缺陷的变异无关。
const RL_MUTATION_TEST_FILES = [
  'tests/config.test.mjs', 'tests/e2e-dryrun.test.mjs', 'tests/graph.test.mjs',
  'tests/mem-probe.test.mjs', 'tests/ready-check.test.mjs', 'tests/run-ledger.test.mjs',
  'tests/skill-doc.test.mjs',
];

// 复制 scripts/tests/config/SKILL.md/graph.json 并对 run-ledger.mjs 副本应用变异；返回副本根目录。
function copyTreeForRLMutation(t, mutateScript) {
  const dir = mkdtempSync(join(tmpdir(), 'rl-mut-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, '_tmp'), { recursive: true });
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'tests'), join(dir, 'tests'), { recursive: true });
  cpSync(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
  if (existsSync(join(ROOT, '_tmp'))) cpSync(join(ROOT, '_tmp'), join(dir, '_tmp'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), readFileSync(join(ROOT, 'SKILL.md'), 'utf8'));
  writeFileSync(join(dir, 'graph.json'), readFileSync(join(ROOT, 'graph.json'), 'utf8'));
  const scriptPath = join(dir, 'scripts/run-ledger.mjs');
  const src = readFileSync(scriptPath, 'utf8');
  const mutated = mutateScript(src);
  assert.notEqual(mutated, src, '变异必须实际改变脚本内容（防替换静默空转）');
  writeFileSync(scriptPath, mutated);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 跑子套件（变异副本上），返回 exit code 与失败测试名集合；
// 同时解析 spec('✖ name (ms)') 与 TAP('not ok N - name') 报告器。
function runMutatedRLSuite(dir) {
  // 剥掉 NODE_TEST_CONTEXT：本进程由 node --test 拉起时该标记会被子进程继承，
  // node 检测到「test run 递归」会静默跳过全部测试并 exit 0（实际空跑），必须剥离才能让子套件真正执行。
  const { NODE_TEST_CONTEXT: _drop, ...childEnv } = process.env;
  const r = spawnSync(process.execPath, ['--test', ...RL_MUTATION_TEST_FILES],
    { cwd: dir, encoding: 'utf8', env: { ...buildChildEnv(childEnv), RL_MUTATION_CHILD: '1', RC_MUTATION_CHILD: '1' } });
  const failedNames = new Set();
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
    if (line.startsWith('not ok ')) {
      const m = line.match(/^not ok \d+ - (.+)$/);
      if (m) failedNames.add(m[1].trim());
    } else if (line.startsWith('✖ ') && !line.startsWith('✖ failing tests:')) {
      failedNames.add(line.replace(/^✖ /, '').replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, '').trim());
    }
  }
  return { status: r.status, failedNames: [...failedNames] };
}

for (const m of RL_MUTATION_PREDICTIONS) {
  test(`mutation-kill: ${m.id} ${m.label} 被挖 → 恰红预测用例，其余绿（跨组件串联契约反证）`, (t) => {
    if (process.env.RL_MUTATION_CHILD === '1') { t.skip('子套件运行跳过变异测试（防递归）'); return; }
    const dir = copyTreeForRLMutation(t, m.mutate);
    const { status, failedNames } = runMutatedRLSuite(dir);
    assert.equal(status, 1, `变异 ${m.id} 后套件必须红（exit 1），实际 ${status}`);
    assert.deepEqual([...failedNames].sort(), [...m.red].sort(),
      `变异 ${m.id} 的失败集必须恰为预测集（${m.red.length} 条，无多余无遗漏）\n实际失败:\n${failedNames.join('\n')}`);
  });
}

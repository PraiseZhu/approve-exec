// e2e-dryrun.test.mjs — sc-p2d 全链 dry-run：真实脚本走完整链，先红后绿双态断言。
//
// 链：run-ledger init → 槽位对账 → 执行组派工 → render-packet（断言「用 goal skill 执行。」三要素）
//     → set-state 合法链推进到全组 verified（含审查/验收交卷 candidate_sha 绑定）→ 双账本比对
//     → wave 集成 → phase 推进 → ready-check **先红**（缺 e2e 报告与 presubmit 三闸，gap 恰含两项）
//     → 补齐夹具 → **READY_FOR_LATER_SUBMIT_PR_SKILL**（含夹具分支名）→ 链尾 run-ledger validate（F2 回归）。
//
// 反证 dry-run 非空转：红态与绿态都要断言（只断言绿态 = 红态也可能被静默放行，等于没测）。
// 两条交叉断言：
//   a) 双账本一致性——run-ledger 各组 tip_sha 与 worktree 台账夹具 collected_tip 逐组比对，
//      不一致时链路中断于 integrate 前（集成步骤拒绝执行，台账字节不变）；
//   b) 槽位对账——mem-probe 的 used_slots 声明值与台账内 dispatched 未归档组数不符时输出告警行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// buildChildEnv：git 隔离唯一实现（run-tests.mjs 是权威）。裸跑 makeRepo 的 git commit
// 同样必须走它——缺隔离会继承机器全局 commit.gpgsign=true，负载下 gpg 失败让夹具红。
import { buildChildEnv } from '../scripts/run-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_LEDGER = join(ROOT, 'scripts/run-ledger.mjs');
const READY_CHECK = join(ROOT, 'scripts/ready-check.mjs');
const MEM_PROBE = join(ROOT, 'scripts/mem-probe.mjs');
const FIXTURE_DIR = join(ROOT, 'tests/fixtures/e2e-dryrun');
const VM_STAT = join(ROOT, 'tests/fixtures/vm-stat-64g.txt');

const FIXED_NOW = '2026-08-09T04:00:00.000Z';
const BRANCH = 'feat/e2e-dryrun-fixture';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function cliLedger(...args) {
  return run(process.execPath, [RUN_LEDGER, ...args]);
}

// ---------- 环境 ----------

// 建临时候选仓：evidence 锚点 + 干净工作树 + 具名 feature 分支（ready-check ⑥⑦ 的真实来源）
// 每个 git 调用都断言 status===0（fail-fast，与 ready-check.test.mjs makeRepo 同规）：fixture
// 构造失败必须显式红并点名失败步骤，不允许「构造失败但继续跑并通过」的静默降级。
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dryrun-repo-'));
  const gitRun = (args, label) => {
    // buildChildEnv：裸跑（非权威入口）时 makeRepo 的 git commit 同样必须隔离——缺它会继承
    // 机器全局 commit.gpgsign=true，负载下 gpg 失败让夹具 commit 红。同一份实现，不拷。
    const r = run('git', args, { cwd: dir, env: buildChildEnv(process.env) });
    assert.equal(r.status, 0, `fixture ${label} 失败: ${r.stderr}`);
    return r;
  };
  gitRun(['init', '-q', dir], 'git init');
  gitRun(['config', 'user.email', 'dryrun@test.local'], 'git config user.email');
  gitRun(['config', 'user.name', 'DryRun'], 'git config user.name');
  gitRun(['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`], 'git symbolic-ref');
  mkdirSync(join(dir, 'evidence/anchors'), { recursive: true });
  writeFileSync(join(dir, 'evidence/anchors/a.txt'), 'anchor a\n');
  writeFileSync(join(dir, 'evidence/anchors/b.txt'), 'anchor b\n');
  writeFileSync(join(dir, 'src.ts'), 'export const dryrun = 1;\n');
  gitRun(['add', '-A'], 'git add -A');
  gitRun(['commit', '-q', '-m', 'dryrun fixture initial'], 'git commit');
  const sha = gitRun(['rev-parse', 'HEAD'], 'git rev-parse HEAD').stdout;
  assert.match(sha, /^[0-9a-f]{40}$/, '候选仓 HEAD 应为 40 位十六进制');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sha };
}

// 环境：复制夹具并替换 __HEAD_SHA__ 占位。红态前置 = e2e 报告与 presubmit 三闸**不**进环境，
// 绿态步骤才 fillGreenFixtures 补齐（红态 gap 恰含这两项的前提）。
function makeEnv(t, repo) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dryrun-env-'));
  for (const rel of ['manifest.json', 'verdict.json', 'worktree-ledger.json']) {
    const p = join(dir, rel);
    writeFileSync(p, readFileSync(join(FIXTURE_DIR, rel), 'utf8').replaceAll('__HEAD_SHA__', repo.sha));
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    headSha: repo.sha,
    ledgerPath: join(dir, 'ledger.json'),
    manifestPath: join(dir, 'manifest.json'),
    verdictPath: join(dir, 'verdict.json'),
    worktreeLedgerPath: join(dir, 'worktree-ledger.json'),
    e2ePath: join(dir, 'e2e-report.json'),
    presubmitDir: join(dir, 'presubmit'),
  };
}

function fillGreenFixtures(env, repo) {
  writeFileSync(env.e2ePath, readFileSync(join(FIXTURE_DIR, 'e2e-report.json'), 'utf8').replaceAll('__HEAD_SHA__', repo.sha));
  mkdirSync(env.presubmitDir, { recursive: true });
  for (const name of ['size', 'format', 'intent']) {
    writeFileSync(
      join(env.presubmitDir, `${name}.json`),
      readFileSync(join(FIXTURE_DIR, 'presubmit', `${name}.json`), 'utf8').replaceAll('__HEAD_SHA__', repo.sha),
    );
  }
}

// ---------- 链上步骤 ----------

// 槽位对账（b）：mem-probe 实跑（vm_stat 夹具注入）取 used_slots 声明值，
// 与台账内 dispatched 未归档组数（state==='dispatched' 的在途组；run-ledger 无归档字段，
// 交付并归档后组即离开 dispatched 态）比对；不符 → 告警行进 log。
function reconcileSlots(env, declaredUsedSlots, log) {
  const r = run(process.execPath, [MEM_PROBE, '--json', '--used-slots', String(declaredUsedSlots),
    '--pending', '0', '--vm-stat-file', VM_STAT]);
  assert.equal(r.status, 0, `mem-probe 应 exit 0: ${r.stderr}`);
  const probe = JSON.parse(r.stdout);
  const ledger = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  const inFlight = ledger.waves.flatMap((w) => w.groups).filter((g) => g.state === 'dispatched').length;
  if (probe.used_slots !== inFlight) {
    log.push(`WARN: 槽位对账: mem-probe used_slots=${probe.used_slots} != 台账 dispatched 未归档组数=${inFlight}`);
  }
}

// 双账本一致性（a）：run-ledger 各组 tip_sha 与 worktree 台账夹具 collected_tip 逐组比对。
// 只比对「已交付组」（tip_sha 非 null）：未派工/未交付的组没有可比的收卷结果，跳过——
// 本检查在 integrate 前运行，天然只覆盖到本波为止已完成交付的组。
function checkDualLedger(env) {
  const ledger = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  const wt = JSON.parse(readFileSync(env.worktreeLedgerPath, 'utf8'));
  const groups = ledger.waves.flatMap((w) => w.groups).filter((g) => g.tip_sha !== null);
  const mismatches = [];
  for (const g of groups) {
    const alloc = wt.allocations.find((a) => a.group === g.group_id);
    if (!alloc) {
      mismatches.push({ group: g.group_id, reason: 'worktree 台账无对应 allocation' });
    } else if (alloc.collected_tip !== g.tip_sha) {
      mismatches.push({ group: g.group_id, ledger_tip: g.tip_sha, collected_tip: alloc.collected_tip });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// 集成步骤：先双账本比对，不一致 → 拒绝集成（链路中断于 integrate 前，台账字节不变）
function waveIntegrate(env, wave) {
  const c = checkDualLedger(env);
  if (!c.ok) return { ok: false, mismatches: c.mismatches };
  const r = cliLedger('set-state', env.ledgerPath, '--wave', String(wave), '--integrate', env.headSha, '--now', FIXED_NOW);
  if (r.status !== 0) return { ok: false, reason: r.stderr };
  return { ok: true };
}

const GATE_GOAL_SHA = '7d7b9d9b97c99b39de5cbbd6b20e4869afe4cb16dab1dc91833a94a29dca356e';
const GATE_ROUTING_SHA = 'e88009fec5d61472d41554b8c0238c6eedd1395d8b301cbc1524d121dc386c23';
const GOAL_SKILL_PI = '/Users/praise/.agents/skills/goal/SKILL.md';
const ROUTING_LIVE = '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json';

function gateGoalDetail() {
  return JSON.stringify({ goal_skill_path: GOAL_SKILL_PI, goal_skill_sha256: GATE_GOAL_SHA });
}
function gateRoutingDetail() {
  return JSON.stringify({
    route_source: ROUTING_LIVE, routing_sha256: GATE_ROUTING_SHA,
    e2e_model: 'codex/gpt-5.6-luna', review_model: 'codex/gpt-5.6-sol',
  });
}

function prHandoffFor(env, group, branch) {
  const manifest = JSON.parse(readFileSync(env.manifestPath, 'utf8'));
  const packet = manifest.dispatch.packets.find((p) => p.group_id === group);
  const tip = env.headSha;
  return {
    branch,
    tip_sha: tip,
    scs: packet.scs_inline.map((s) => ({ id: s.id, status: 'pass' })),
    goal_skill_path: GOAL_SKILL_PI,
    e2e: { status: 'pass', candidate_sha: tip, model: 'codex/gpt-5.6-luna', route_source: ROUTING_LIVE },
    review: { unresolved: 0, candidate_sha: tip, model: 'codex/gpt-5.6-sol', route_source: ROUTING_LIVE },
    size_gate: { result: 'PASS', candidate_sha: tip },
  };
}

// 组派工：identity 含 session_id + dispatched（兼容模式跳过 render/mem-snapshot）
function dispatchGroup(env, group, workerLabel) {
  let r = cliLedger('set-state', env.ledgerPath, '--group', group, '--identity',
    JSON.stringify({ worktree: `/wt/${group}`, branch: `feat/${group}`, base: env.headSha, session_id: `sess-${group}` }), '--now', FIXED_NOW);
  assert.equal(r.status, 0, `--identity ${group} 应 exit 0: ${r.stderr}`);
  r = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'dispatched', '--worker-label', workerLabel, '--now', FIXED_NOW);
  assert.equal(r.status, 0, `派工 ${group} 应 exit 0: ${r.stderr}`);
}

function walkGroupToAccepted(env, group, workerLabel) {
  dispatchGroup(env, group, workerLabel);
  if (group === 'g4') {
    const r = cliLedger('render-packet', env.ledgerPath, '--group', 'g4');
    assert.equal(r.status, 0, `render-packet 应 exit 0: ${r.stderr}`);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], '用 goal skill 执行。', '首行必须逐字等于「用 goal skill 执行。」');
    assert.equal(lines[1], '--until-sc', '--until-sc 必须独占一行');
    assert.match(lines[2], /^worktree=\/wt\/g4 /, '身份行必须以台账 worktree 开头');
  }
  const packet = JSON.parse(readFileSync(env.manifestPath, 'utf8')).dispatch.packets
    .find((p) => p.group_id === group);
  const isVerify = Array.isArray(packet.scs_inline) && packet.scs_inline.length > 0
    && packet.scs_inline.every((s) => s.kind === 'verify');
  let rr = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'executing', '--detail', gateGoalDetail(), '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `${group} →executing 应 exit 0: ${rr.stderr}`);
  if (!isVerify) {
    rr = cliLedger('record-delivery', env.ledgerPath, '--group', group, '--payload', JSON.stringify({
      status: 'done', tip_sha: env.headSha,
      scs: packet.scs_inline.map((s) => ({ sc_id: s.id, status: 'pass', evidence: `verify 通过：${s.id}` })),
    }), '--now', FIXED_NOW);
    assert.equal(rr.status, 0, `${group} exec 交卷应 exit 0: ${rr.stderr}`);
  }
  rr = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'e2e', '--detail', gateRoutingDetail(), '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `${group} →e2e 应 exit 0: ${rr.stderr}`);
  if (!isVerify) {
    rr = cliLedger('record-delivery', env.ledgerPath, '--group', group, '--payload', JSON.stringify({
      rounds: 1, findings_total: 0, unresolved: 0, fix_commits: [], candidate_sha: env.headSha,
    }), '--now', FIXED_NOW);
    assert.equal(rr.status, 0, `${group} 审查交卷应 exit 0: ${rr.stderr}`);
  }
  rr = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'review', '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `${group} →review 应 exit 0: ${rr.stderr}`);
  if (isVerify) {
    rr = cliLedger('record-delivery', env.ledgerPath, '--group', group, '--payload', JSON.stringify({
      scs: packet.scs_inline.map((s) => ({ sc_id: s.id, status: 'pass', evidence: `verify 通过：${s.id}` })),
      integration_review: { status: 'pass', notes: 'dry-run 验收通过' },
      candidate_sha: env.headSha,
    }), '--now', FIXED_NOW);
    assert.equal(rr.status, 0, `${group} verify 交卷应 exit 0: ${rr.stderr}`);
  }
  rr = cliLedger('record-delivery', env.ledgerPath, '--group', group, '--payload', JSON.stringify(prHandoffFor(env, group, `feat/${group}`)), '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `${group} candidate 交卷应 exit 0: ${rr.stderr}`);
  rr = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'accepted', '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `${group} →accepted 应 exit 0: ${rr.stderr}`);
}

function execGroupToVerified(env) {
  walkGroupToAccepted(env, 'g4', 'w1');
}

// 验收组（v1）到 verified：验收交卷（candidate_sha 绑定）——它是 v1 的 verify 类最后一条
// delivery，ready-check ③ 按类别消费（验收组绑 verify 类最后一条）从它读 candidate_sha
function verifyGroupToVerified(env) {
  walkGroupToAccepted(env, 'v1', 'w2');
}

// 全链推进到 packaging（波序执行 → 双账本比对 → 集成 → phase 推进）
function runChainToPackaging(env, log = []) {
  let r = cliLedger('init', env.ledgerPath, '--manifest', env.manifestPath, '--run-id', 'e2e-dryrun', '--now', FIXED_NOW);
  assert.equal(r.status, 0, `init 应 exit 0: ${r.stderr}`);
  reconcileSlots(env, 0, log); // 派工前：在途 0
  execGroupToVerified(env);
  reconcileSlots(env, 0, log); // g4 已交付归档：在途 0
  const i1 = waveIntegrate(env, 1);
  assert.equal(i1.ok, true, `wave 1 集成应成功: ${JSON.stringify(i1.mismatches ?? i1.reason)}`);
  verifyGroupToVerified(env);
  const i2 = waveIntegrate(env, 2);
  assert.equal(i2.ok, true, `wave 2 集成应成功: ${JSON.stringify(i2.mismatches ?? i2.reason)}`);
  for (const ph of ['dispatching', 'running', 'accepting']) {
    r = cliLedger('set-state', env.ledgerPath, '--phase', ph, '--now', FIXED_NOW);
    assert.equal(r.status, 0, `→${ph} 应 exit 0: ${r.stderr}`);
  }
}

function runReadyCheck(env, repo, { withNow = true } = {}) {
  const args = [READY_CHECK, '--repo', repo.dir, '--ledger', env.ledgerPath, '--manifest', env.manifestPath,
    '--verdict', env.verdictPath, '--e2e-report', env.e2ePath, '--presubmit-dir', env.presubmitDir];
  if (withNow) args.push('--now', FIXED_NOW);
  // F-F：→ready 凭据 = ready-check 原子写入的 receipt（缺 --receipt 时 ready-check fail-closed 拒）
  args.push('--receipt', join(env.dir, 'ready-receipt.json'));
  return run(process.execPath, args);
}

// =====================================================================
// 全链 dry-run：先红后绿
// =====================================================================
test('sc-p2d: 全链 dry-run——先红（缺 e2e 报告与 presubmit 三闸）后绿（READY_FOR_LATER_SUBMIT_PR_SKILL + 台账 phase→ready + 链尾 validate exit 0）', (t) => {
  const repo = makeRepo(t);
  const env = makeEnv(t, repo);
  const log = [];
  runChainToPackaging(env, log);
  assert.ok(log.every((l) => !l.startsWith('WARN:')), '正常链不得出现槽位对账告警行');

  // ---- 红态：缺 e2e 报告与 presubmit 三闸 ----
  assert.equal(existsSync(env.e2ePath), false, '红态前置：e2e 报告必须缺失');
  assert.equal(existsSync(env.presubmitDir), false, '红态前置：presubmit 目录必须缺失');
  const red = runReadyCheck(env, repo);
  assert.equal(red.status, 2, `缺 e2e/presubmit 必须 exit 2\nstderr: ${red.stderr}`);
  const gapLines = red.stderr.split('\n').filter((l) => l.startsWith('GAP: '));
  const gapGates = gapLines.map((l) => l.replace(/^GAP: /, '').split(':')[0]);
  assert.deepEqual([...new Set(gapGates)].sort(), ['e2e-report', 'presubmit-gates'],
    `gap 列表必须恰含这两项 gate（红态非空转的反证——其余五项全过）\nstderr:\n${red.stderr}`);
  assert.deepEqual(gapLines.length, 4, `gap 行数 = 1（e2e-report）+ 3（presubmit 三闸各一）`);
  assert.equal(red.stdout, '', '红态不得输出 READY 行');
  let ledger = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  const versionBefore = ledger.version;
  assert.equal(ledger.phase, 'accepting', '红态不得驱动台账 phase');

  // ---- 绿态：补齐夹具 ----
  fillGreenFixtures(env, repo);
  const green = runReadyCheck(env, repo);
  assert.equal(green.status, 0, `全齐应 exit 0\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  assert.equal(green.stdout, `READY_FOR_LATER_SUBMIT_PR_SKILL ${BRANCH} ${repo.sha}`, 'READY 行必须单行含夹具分支名与 HEAD SHA');
  // ready-check 只写 receipt 不驱动台账（写入权在 run-ledger）——台账此刻仍未被驱动
  ledger = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(ledger.phase, 'accepting', 'ready-check 不得驱动台账 phase（只检查）');
  assert.equal(ledger.version, versionBefore, 'ready-check 不得递增台账 version');
  // phase→ready 由 run-ledger set-state --phase ready --ready-receipt 驱动（锁/CAS/状态机）
  const receiptPath = join(env.dir, 'ready-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.ledger_version, versionBefore, 'receipt.ledger_version 必须 = 检查时读到的台账 version');
  const drv = cliLedger('set-state', env.ledgerPath, '--phase', 'ready',
    '--ready-receipt', receiptPath, '--now', FIXED_NOW);
  assert.equal(drv.status, 0, `receipt 驱动 phase→ready 应 exit 0: ${drv.stderr}`);
  ledger = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(ledger.phase, 'ready', '台账 phase 应被驱动为 ready');
  assert.equal(ledger.version, versionBefore + 1, '台账 version 应 +1（CAS 乐观锁）');
  assert.equal(ledger.phase_at, FIXED_NOW, 'phase_at 应使用 --now 注入的时间戳（F2 契约）');

  // ---- 链尾：run-ledger validate 必须接受 ready 台账（F2 回归：phase_at 是 exact 键白名单成员）----
  const v = cliLedger('validate', env.ledgerPath);
  assert.equal(v.status, 0, `ready 台账必须过 run-ledger validate（F2 回归）: ${v.stderr}`);
});

// =====================================================================
// 交叉断言 a：双账本一致性
// =====================================================================
test('sc-p2d: 双账本一致性——collected_tip 与 tip_sha 不一致时链路中断于 integrate 前', (t) => {
  const repo = makeRepo(t);
  const env = makeEnv(t, repo);
  let r = cliLedger('init', env.ledgerPath, '--manifest', env.manifestPath, '--run-id', 'e2e-dryrun', '--now', FIXED_NOW);
  assert.equal(r.status, 0, r.stderr);

  // 一致世界：g4 到 verified 后 wave 1 集成成功（链上双账本比对通过）
  execGroupToVerified(env);
  const i1 = waveIntegrate(env, 1);
  assert.equal(i1.ok, true, '一致时 wave 1 必须可集成');
  assert.equal(i1.mismatches ?? 0, 0, '一致时不得有 mismatch');

  // 变异世界：v1 的 collected_tip 与 run-ledger tip_sha 不一致
  verifyGroupToVerified(env);
  const wt = JSON.parse(readFileSync(env.worktreeLedgerPath, 'utf8'));
  wt.allocations.find((a) => a.group === 'v1').collected_tip = 'b'.repeat(40);
  writeFileSync(env.worktreeLedgerPath, JSON.stringify(wt));
  const c = checkDualLedger(env);
  assert.equal(c.ok, false, 'collected_tip 不一致必须被检出');
  assert.deepEqual(c.mismatches, [{ group: 'v1', ledger_tip: repo.sha, collected_tip: 'b'.repeat(40) }]);

  // 链路中断于 integrate 前：集成步骤拒绝执行，台账字节不变
  const before = readFileSync(env.ledgerPath, 'utf8');
  const i2 = waveIntegrate(env, 2);
  assert.equal(i2.ok, false, '不一致时 wave 2 集成必须被拒绝');
  assert.deepEqual(i2.mismatches, c.mismatches, '拒绝原因必须点名 mismatches');
  assert.equal(readFileSync(env.ledgerPath, 'utf8'), before, '不一致时集成不得改写台账');
  const ledger = JSON.parse(before);
  const w2 = ledger.waves.find((w) => w.wave === 2);
  assert.equal(w2.integrated_tip, null, '不一致时 wave 2 integrated_tip 必须保持 null');
  assert.ok(!ledger.events.some((e) => e.type === 'integrate' && e.detail.wave === 2), '不一致时不得落 integrate 事件');
});

// =====================================================================
// 交叉断言 b：槽位对账告警
// =====================================================================
test('sc-p2d: 槽位对账——used_slots 与 dispatched 未归档组数一致无告警、不符出告警行', (t) => {
  const repo = makeRepo(t);
  const env = makeEnv(t, repo);
  const log = [];
  let r = cliLedger('init', env.ledgerPath, '--manifest', env.manifestPath, '--run-id', 'e2e-dryrun', '--now', FIXED_NOW);
  assert.equal(r.status, 0, r.stderr);

  // 一致：在途 0 声明 0 → 无告警
  reconcileSlots(env, 0, log);
  assert.ok(log.every((l) => !l.startsWith('WARN:')), '一致时不得输出告警行');

  // 不符：在途 0 却声明 1 → 恰好一条告警行，内容点名两侧数值
  reconcileSlots(env, 1, log);
  const warns = log.filter((l) => l.startsWith('WARN:'));
  assert.equal(warns.length, 1, '不符时必须恰好输出一条告警行');
  assert.match(warns[0], /槽位对账/);
  assert.match(warns[0], /used_slots=1/);
  assert.match(warns[0], /dispatched 未归档组数=0/);

  // 在途 1（只派工不交付）：声明 1 → 一致无告警；声明 0 → 新增一条告警
  r = cliLedger('set-state', env.ledgerPath, '--group', 'g4', '--identity',
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/g4', base: env.headSha, session_id: 'sess-g4' }), '--now', FIXED_NOW);
  assert.equal(r.status, 0, r.stderr);
  r = cliLedger('set-state', env.ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--now', FIXED_NOW);
  assert.equal(r.status, 0, r.stderr);
  reconcileSlots(env, 1, log);
  assert.equal(log.filter((l) => l.startsWith('WARN:')).length, 1, '在途 1 声明 1 不得新增告警行');
  reconcileSlots(env, 0, log);
  const warns2 = log.filter((l) => l.startsWith('WARN:'));
  assert.equal(warns2.length, 2, '在途 1 声明 0 必须新增一条告警行');
  assert.match(warns2[1], /used_slots=0/);
  assert.match(warns2[1], /dispatched 未归档组数=1/);
});

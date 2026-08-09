// e2e-dryrun.test.mjs — sc-p2d 全链 dry-run：真实脚本走完整链，先红后绿双态断言。
//
// 链：run-ledger init → 槽位对账 → 执行组派工 → render-packet（断言「用 goal skill 执行。」三要素）
//     → set-state 合法链推进到全组 verified（含审查/验收交卷 candidate_sha 绑定）→ 双账本比对
//     → wave 集成 → phase 推进 → ready-check **先红**（缺 e2e 报告与 presubmit 三闸，gap 恰含两项）
//     → 补齐夹具 → **READY_FOR_SUBMIT_PR**（含夹具分支名）→ 链尾 run-ledger validate（F2 回归）。
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
  run('git', ['add', '-A'], { cwd: dir });
  const commit = run('git', ['commit', '-q', '-m', 'dryrun fixture initial'], { cwd: dir });
  assert.equal(commit.status, 0, `fixture repo 首提交失败: ${commit.stderr}`);
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout;
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

// 组派工：identity + dispatched + delivered（tip_sha=候选 HEAD）
function dispatchGroup(env, group, workerLabel) {
  let r = cliLedger('set-state', env.ledgerPath, '--group', group, '--identity',
    JSON.stringify({ worktree: `/wt/${group}`, branch: `feat/${group}`, base: env.headSha }), '--now', FIXED_NOW);
  assert.equal(r.status, 0, `--identity ${group} 应 exit 0: ${r.stderr}`);
  r = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'dispatched', '--worker-label', workerLabel, '--now', FIXED_NOW);
  assert.equal(r.status, 0, `派工 ${group} 应 exit 0: ${r.stderr}`);
  r = cliLedger('set-state', env.ledgerPath, '--group', group, '--to', 'delivered', '--tip-sha', env.headSha, '--now', FIXED_NOW);
  assert.equal(r.status, 0, `交付 ${group} 应 exit 0: ${r.stderr}`);
}

// 执行组（g4）到 verified：render-packet 三要素断言 + 审查交卷（candidate_sha 绑定）
function execGroupToVerified(env) {
  dispatchGroup(env, 'g4', 'w1');
  // render-packet：执行组三要素（首行逐字 + --until-sc 独占一行 + 身份行只认台账值）
  const r = cliLedger('render-packet', env.ledgerPath, '--group', 'g4');
  assert.equal(r.status, 0, `render-packet 应 exit 0: ${r.stderr}`);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], '用 goal skill 执行。', '首行必须逐字等于「用 goal skill 执行。」');
  assert.equal(lines[1], '--until-sc', '--until-sc 必须独占一行');
  assert.match(lines[2], /^worktree=\/wt\/g4 /, '身份行必须以台账 worktree 开头');
  assert.match(lines[2], /branch=feat\/g4/, '身份行必须含台账 branch');
  assert.match(lines[2], new RegExp(`base=${env.headSha}`), '身份行必须含台账 base');
  // 审查交卷：unresolved=0 入账 + candidate_sha 绑定（ready-check ③ 的读取点）
  let rr = cliLedger('record-delivery', env.ledgerPath, '--group', 'g4', '--payload', JSON.stringify({
    rounds: 1, findings_total: 0, unresolved: 0, fix_commits: [], candidate_sha: env.headSha,
  }), '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `g4 审查交卷应 exit 0: ${rr.stderr}`);
  rr = cliLedger('set-state', env.ledgerPath, '--group', 'g4', '--to', 'review_pass', '--now', FIXED_NOW);
  assert.equal(rr.status, 0, rr.stderr);
  rr = cliLedger('set-state', env.ledgerPath, '--group', 'g4', '--verify-status', 'pass', '--now', FIXED_NOW);
  assert.equal(rr.status, 0, rr.stderr);
  rr = cliLedger('set-state', env.ledgerPath, '--group', 'g4', '--to', 'verified', '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `g4 →verified 应 exit 0: ${rr.stderr}`);
}

// 验收组（v1）到 verified：验收交卷（candidate_sha 绑定）——它是 v1 最后一条 delivery，
// ready-check ③ 从它读 candidate_sha
function verifyGroupToVerified(env) {
  dispatchGroup(env, 'v1', 'w2');
  const rr = cliLedger('record-delivery', env.ledgerPath, '--group', 'v1', '--payload', JSON.stringify({
    scs: [{ sc_id: 'sc-dry-2', status: 'pass', evidence: 'dry-run verdict' }],
    integration_review: { status: 'pass', notes: 'squash diff 复查无越域' },
    candidate_sha: env.headSha,
  }), '--now', FIXED_NOW);
  assert.equal(rr.status, 0, `v1 验收交卷应 exit 0: ${rr.stderr}`);
  let r = cliLedger('set-state', env.ledgerPath, '--group', 'v1', '--to', 'review_pass', '--now', FIXED_NOW);
  assert.equal(r.status, 0, r.stderr);
  r = cliLedger('set-state', env.ledgerPath, '--group', 'v1', '--to', 'verified', '--now', FIXED_NOW);
  assert.equal(r.status, 0, `v1 →verified 应 exit 0: ${r.stderr}`);
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
  for (const ph of ['reviewing', 'validating', 'e2e', 'packaging']) {
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
    JSON.stringify({ worktree: '/wt/g4', branch: 'feat/g4', base: env.headSha }), '--now', FIXED_NOW);
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
// run-ledger.test.mjs — sc-p1c/p1d/p1e/p1h 四条 SC 的验收测试。
// 判据：exit 0 且 fail 0（由 scripts/run-tests.mjs 权威入口驱动）。
// CLI 层用 spawnSync 验 exit code（fail-closed 一律 exit 2）；
// 函数层（CAS/原子写）直接 import run-ledger.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLedger, writeLedgerAtomic, writeTmp, renameTmp, initLedger,
} from '../scripts/run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'run-ledger.mjs');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'sample-manifest.json');

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const SHA39 = 'd'.repeat(39);

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

/** init 一个台账（CLI 层），返回 { ledgerPath, manifestPath }。 */
function initLedgerFor(dir) {
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'test-run', '--now', T);
  assert.equal(r.status, 0, `init 应 exit 0: ${r.stderr}`);
  return { ledgerPath, manifestPath };
}

function initLedgerForClean(dir) {
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  initLedger({ ledgerPath, manifestPath, runId: 'test-run', now: T });
  return { ledgerPath, manifestPath };
}

/** 给组分配身份（worktree/branch/base）。 */
function assignIdentity(ledgerPath, group, branch) {
  const r = cli(
    'set-state', ledgerPath, '--group', group, '--identity',
    JSON.stringify({ worktree: `/wt/${group}`, branch, base: SHA3 }), '--now', T
  );
  assert.equal(r.status, 0, `set-state --identity 应 exit 0: ${r.stderr}`);
}

/** 把组 g4 走完到 verified 的合法链（sc-p1d 合法链 + verify 凭据）。
 * 注意：delivered 自环仅 rounds+1（unresolved 唯一通道是审查交卷，测试初始 unresolved=0 直接可 review_pass）。 */
function runG4ToVerified(ledgerPath) {
  const g = 'g4';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, `合法链 ${to} 应 exit 0: ${r.stderr}`);
  }
  let r = cli('set-state', ledgerPath, '--group', g, '--verify-status', 'pass', '--now', T);
  assert.equal(r.status, 0, `verify-status 写入应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 0, `→verified 应 exit 0: ${r.stderr}`);
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
  assert.equal(ledger.phase, 'executing');
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

test('sc-p1c: init 遇 manifest 组缺 sc_ids 数组 exit 2（禁止静默空组）', () => {
  const dir = newTmpDir();
  const ledgerPath = join(dir, 'ledger.json');
  const manifestPath = fixtureCopy(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete m.waves[0].groups[0].sc_ids;
  writeFileSync(manifestPath, JSON.stringify(m));
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
  assert.equal(r.status, 2, '组缺 sc_ids 必须 exit 2（fail-closed）');
  assert.match(r.stderr, /MANIFEST/, '必须走 MANIFEST 拒绝路径（点名，不是下游 TypeError 兜底）');
  assert.match(r.stderr, /缺少 sc_ids/);
  assert.equal(existsSync(ledgerPath), false, 'init 失败不得创建台账');
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
test('sc-p1d: 合法链全通（dispatched→delivered→自环两轮→review_pass→verified）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  runG4ToVerified(ledgerPath);
  const ledger = readLedger(ledgerPath);
  const g4 = ledger.waves[0].groups[0];
  assert.equal(g4.state, 'verified');
  assert.equal(g4.worker_label, 'w1');
  assert.equal(g4.tip_sha, SHA1);
  assert.deepEqual(g4.review, { rounds: 2, unresolved: 0 });
  assert.equal(g4.verify.status, 'pass');
  // 事件流：dispatch, delivery, review_round×2, delivery(verify 凭据不落事件) → dispatch/delivery/review_round 各就位
  const types = ledger.events.map((e) => e.type);
  assert.ok(types.includes('dispatch'));
  assert.ok(types.includes('delivery'));
  assert.equal(types.filter((t) => t === 'review_round').length, 2);
});

test('sc-p1d: rounds 超上限时 delivered→review_pass 拒（审查不收敛）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1']],
    ['delivered', ['--tip-sha', SHA1]],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  // 自环 4 次 → rounds=4 > reviewMaxRounds=3（config 读取，非字面量）
  for (let i = 0; i < 4; i += 1) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', 'delivered', '--now', T);
    assert.equal(r.status, 0, `自环第 ${i + 1} 次应 exit 0: ${r.stderr}`);
  }
  const r = cli('set-state', ledgerPath, '--group', g, '--to', 'review_pass', '--now', T);
  assert.equal(r.status, 2, 'rounds 超上限 review_pass 必须 exit 2');
  assert.match(r.stderr, /rounds≤3/);
});

test('sc-p1d: unresolved>0 时 review_pass 拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  // unresolved 走唯一合法通道：record-delivery 审查交卷
  const reviewDelivery = { rounds: 1, findings_total: 3, unresolved: 2, fix_commits: [] };
  let r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify(reviewDelivery), '--now', T);
  assert.equal(r.status, 0, `审查交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'review_pass', '--now', T);
  assert.equal(r.status, 2, 'unresolved>0 时 review_pass 必须 exit 2');
  assert.match(r.stderr, /unresolved==0/);
});

test('sc-p1d: 非法跳转矩阵（12 例）全部 exit 2 且落 illegal_transition 事件', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  const before = readLedger(ledgerPath).events.length;

  // 阶段 A：pending 上的非法目标
  for (const to of ['delivered', 'review_pass', 'verified', 'pending', 'failed']) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, '--now', T);
    assert.equal(r.status, 2, `pending→${to} 必须 exit 2`);
  }
  // 阶段 B：dispatched 上的非法目标
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w1', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  for (const to of ['review_pass', 'verified', 'dispatched', 'pending']) {
    r = cli('set-state', ledgerPath, '--group', g, '--to', to, '--now', T);
    assert.equal(r.status, 2, `dispatched→${to} 必须 exit 2`);
  }
  // 阶段 C：delivered→verified（白名单外）
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'delivered', '--tip-sha', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 2, 'delivered→verified 必须 exit 2');
  // 阶段 D：重放攻击 verified→dispatched（终态只读）——从当前 delivered 续走到 verified
  for (const [to, extra] of [
    ['delivered', []],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  r = cli('set-state', ledgerPath, '--group', g, '--verify-status', 'pass', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'evil', '--now', T);
  assert.equal(r.status, 2, 'verified→dispatched 重放攻击必须 exit 2');
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pending', '--now', T);
  assert.equal(r.status, 2, 'verified→pending 重放攻击必须 exit 2');

  // 12 例非法尝试，每例都落 illegal_transition 事件（写盘在 throw 之前）
  const ledger = readLedger(ledgerPath);
  const illegal = ledger.events.filter((e) => e.type === 'illegal_transition');
  assert.equal(illegal.length, before + 12, `应落 ${before + 12} 条 illegal_transition 事件，实际 ${illegal.length}`);
  assert.equal(ledger.waves[0].groups[0].state, 'verified', '非法尝试不得改变组状态');
});

test('sc-p1d: failed→pending 后 rounds==0 且 tip_sha/worker_label 清空（重派不继承旧计数）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  // 走到 delivered 有计数（unresolved 走审查交卷唯一通道）
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  let r = cli('record-delivery', ledgerPath, '--group', g, '--payload',
    JSON.stringify({ rounds: 1, findings_total: 2, unresolved: 1, fix_commits: [] }), '--now', T);
  assert.equal(r.status, 0, `审查交卷应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 0, `→failed 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pending', '--now', T);
  assert.equal(r.status, 0, `failed→pending 应 exit 0: ${r.stderr}`);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.state, 'pending');
  assert.deepEqual(g4.review, { rounds: 0, unresolved: 0 }, '重派链计数必须归零');
  assert.equal(g4.tip_sha, null);
  assert.equal(g4.worker_label, null);
  assert.equal(g4.dispatched_at, null);
});

test('sc-p1d: set-state --unresolved 一律拒（unresolved 唯一通道是审查交卷，无手工填数通道）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const args of [
    ['--group', 'g4', '--to', 'delivered', '--unresolved', '0'],
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
  let r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  for (const bad of ['xyz', SHA39, 'A'.repeat(40), '12345']) {
    r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'delivered', '--tip-sha', bad, '--now', T);
    assert.equal(r.status, 2, `tip_sha=${bad} 必须 exit 2`);
    assert.match(r.stderr, /40hex/);
  }
  // 组状态未被污染
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].state, 'dispatched');
});

test('sc-p1d: phase 跳步（executing→e2e）拒并点名缺失前置', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const r = cli('set-state', ledgerPath, '--phase', 'e2e', '--now', T);
  assert.equal(r.status, 2, 'phase 跳步必须 exit 2');
  assert.match(r.stderr, /ILLEGAL_TRANSITION/);
  assert.match(r.stderr, /executing → e2e/);
  assert.match(r.stderr, /缺失前置|须依次经过/);
  // 非法尝试落事件
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.phase, 'executing', '非法 phase 跳转不得改变 phase');
  assert.ok(ledger.events.some((e) => e.type === 'illegal_transition' && /phase/.test(e.detail)));
});

test('sc-p1d: phase 单向前进合法链 + →validating 前置 + →ready 凭据', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // →validating 前置失败（本波全组未 review_pass）
  let r = cli('set-state', ledgerPath, '--phase', 'reviewing', '--now', T);
  assert.equal(r.status, 0, `→reviewing 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'validating', '--now', T);
  assert.equal(r.status, 2, '→validating 前置未满足必须 exit 2');
  assert.match(r.stderr, /review_pass/);
  // 补前置：g4 走到 review_pass（本波唯一组）
  const g = 'g4';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  r = cli('set-state', ledgerPath, '--phase', 'validating', '--now', T);
  assert.equal(r.status, 0, `→validating（前置满足）应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'e2e', '--now', T);
  assert.equal(r.status, 0, `→e2e 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'packaging', '--now', T);
  assert.equal(r.status, 0, `→packaging 应 exit 0: ${r.stderr}`);
  // →ready 无凭据拒
  r = cli('set-state', ledgerPath, '--phase', 'ready', '--now', T);
  assert.equal(r.status, 2, '→ready 无 ready-check 凭据必须 exit 2');
  assert.match(r.stderr, /ready-check exit 0/);
  // →ready 带凭据通过
  r = cli('set-state', ledgerPath, '--phase', 'ready', '--ready-check-exit0', '1', '--now', T);
  assert.equal(r.status, 0, `→ready 带凭据应 exit 0: ${r.stderr}`);
  assert.equal(readLedger(ledgerPath).phase, 'ready');
  // ready 达成后台账冻结（只读）：任何写操作拒
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'failed', '--event', 'timeout_redispatch', '--now', T);
  assert.equal(r.status, 2, 'ready 相位达成后写操作必须 exit 2');
  assert.match(r.stderr, /FROZEN|冻结/);
});

test('sc-p1d: wave 集成——非 40hex 拒、全组未 verified 拒、集成后可落账', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 前置不满足（g4 未 verified）→ 拒
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 2, 'wave 未全组 verified 集成必须 exit 2');
  assert.match(r.stderr, /全组 verified/);
  // 走完 g4 → 集成成功
  runG4ToVerified(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, `集成应 exit 0: ${r.stderr}`);
  let ledger = readLedger(ledgerPath);
  assert.equal(ledger.waves[0].integrated_tip, SHA2);
  assert.ok(ledger.events.some((e) => e.type === 'integrate' && e.detail.includes(SHA2)));
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
    const { ledgerPath } = initLedgerFor(dir);
    assignIdentity(ledgerPath, 'g4', 'feat/run-ledger');
    // 挖空该字段：「空缺」= 键缺失/空数组/空串（空数组对 allowed_paths/forbidden 是合法表达，
    // 挖空用删键；scs_inline/verify_cmds 空数组即空缺）
    const m = JSON.parse(readFileSync(join(dir, 'sample-manifest.json'), 'utf8'));
    const pkt = m.dispatch.packets.find((p) => p.group_id === 'g4');
    if (field === 'scs_inline' || field === 'verify_cmds') {
      pkt[field] = [];
    } else {
      delete pkt[field];
    }
    writeFileSync(join(dir, 'sample-manifest.json'), JSON.stringify(m));
    const r = cli('render-packet', ledgerPath, '--group', 'g4', '--manifest', join(dir, 'sample-manifest.json'));
    assert.equal(r.status, 2, `挖空 ${field} 必须 exit 2`);
    assert.match(r.stderr, /PACKET_INCOMPLETE/);
    assert.match(r.stderr, new RegExp(field), `必须点名缺失字段 ${field}`);
    assert.equal(r.stdout, '', '缺项不得出包（无正文输出）');
  }
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
  // v1 所在 wave 2 未集成 → 拒
  assignIdentity(ledgerPath, 'v1', 'feat/verify');
  let r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 2, '验收组所在波未集成必须 exit 2');
  assert.match(r.stderr, /NO_INTEGRATED/);
  // 集成 wave 1（g4 全 verified）+ wave 2（v1 全 verified）
  runG4ToVerified(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const v = 'v1';
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'wv1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', v, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  r = cli('set-state', ledgerPath, '--group', v, '--verify-status', 'pass', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'verified', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // 渲染验收包
  r = cli('render-packet', ledgerPath, '--group', 'v1');
  assert.equal(r.status, 0, `验收组 render 应 exit 0: ${r.stderr}`);
  const out = r.stdout;
  assert.ok(!out.startsWith('用 goal skill 执行。'), '验收组模板不得带 goal 触发行');
  assert.ok(!out.includes('--until-sc'), '验收组模板不得带 --until-sc');
  assert.match(out, /只跑 verify 命令出 verdict，不改代码/);
  assert.match(out, new RegExp(`integrated_tip=${SHA1}`), '整合树复查项必须引用台账 integrated_tip');
  assert.match(out, /squash diff/, '整合树复查项必须含 squash diff 复查指令');
  assert.match(out, new RegExp(`integrated_tip=${SHA1}（wave 2 集成 squash SHA）`));
});

test('sc-p1e: T 阶段包 verify_cmds 与夹具 manifest 尾波逐条一致', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'sample-manifest.json'), 'utf8'));
  const lastWave = manifest.waves[manifest.waves.length - 1]; // 尾波 = wave 2
  const v1Group = lastWave.groups[0];
  const v1Packet = manifest.dispatch.packets.find((p) => p.group_id === v1Group.group_id);
  assignIdentity(ledgerPath, v1Group.group_id, 'feat/verify');
  // 集成两个 wave 让验收组可渲染
  runG4ToVerified(ledgerPath);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const v = v1Group.group_id;
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'wv1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', v, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  r = cli('set-state', ledgerPath, '--group', v, '--verify-status', 'pass', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'verified', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('render-packet', ledgerPath, '--group', v);
  assert.equal(r.status, 0, r.stderr);
  // 渲染正文的验证命令必须与尾波 packet.verify_cmds 逐条一致（来自 manifest，不来自台账记忆）
  const renderedCmds = r.stdout
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

test('sc-p1h: 执行组合法交卷入账成功且台账对应字段逐项等于交卷值', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const payload = execDeliveryPayload({ tipSha: SHA2 });
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `执行组交卷应 exit 0: ${r.stderr}`);
  const ledger = readLedger(ledgerPath);
  const g4 = ledger.waves[0].groups[0];
  assert.equal(g4.tip_sha, SHA2, '台账 tip_sha 必须等于交卷值');
  const delivery = ledger.events.filter((e) => e.type === 'delivery');
  assert.equal(delivery.length, 1);
  assert.match(delivery[0].detail, /status=done/);
  assert.match(delivery[0].detail, new RegExp(SHA2));
  assert.match(delivery[0].detail, /sc-p1c=pass/);
});

test('sc-p1h: 审查组合法交卷——unresolved 由此机器写入 review.unresolved（唯一入账通道）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const payload = { rounds: 2, findings_total: 5, unresolved: 3, fix_commits: ['abc'.repeat(13), 'def'.repeat(13)] };
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `审查组交卷应 exit 0: ${r.stderr}`);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.review.rounds, 2, 'review.rounds 必须等于交卷值');
  assert.equal(g4.review.unresolved, 3, 'review.unresolved 必须等于交卷值（唯一入账通道）');
});

test('sc-p1h: 验收组合法交卷——verify.status/evidence_ref 入账', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const payload = {
    scs: [{ sc_id: 'sc-v1a', status: 'pass', evidence: 'ready-check exit 0' }],
    integration_review: { status: 'pass', notes: 'squash diff 复查无越域' },
  };
  const r = cli('record-delivery', ledgerPath, '--group', 'v1', '--payload', JSON.stringify(payload), '--now', T);
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
    const payload = { rounds: 1, findings_total: 1, unresolved: bad, fix_commits: [] };
    const before = readFileSync(ledgerPath, 'utf8');
    const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(r.status, 2, `unresolved=${JSON.stringify(bad)} 必须 exit 2`);
    assert.match(r.stderr, /unresolved 必须是非负整数/);
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
  const payloadFile = join(dir, 'delivery.json');
  writeFileSync(payloadFile, JSON.stringify(execDeliveryPayload()));
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', `@${payloadFile}`, '--now', T);
  assert.equal(r.status, 0, `@file 交卷应 exit 0: ${r.stderr}`);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].tip_sha, SHA1);
});

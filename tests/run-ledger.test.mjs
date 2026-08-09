// run-ledger.test.mjs — sc-p1c/p1d/p1e/p1h 四条 SC 的验收测试。
// 判据：exit 0 且 fail 0（由 scripts/run-tests.mjs 权威入口驱动）。
// CLI 层用 spawnSync 验 exit code（fail-closed 一律 exit 2）；
// 函数层（CAS/原子写）直接 import run-ledger.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, cpSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLedger, writeLedgerAtomic, writeTmp, renameTmp, initLedger,
  tmpPath, acquireLedgerLock, releaseLedgerLock, manifestCoreHash, LedgerError,
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

/**
 * 在 init 前篡改夹具 manifest 并重算 manifest_core_hash 后 init（F-D 门禁下，
 * init 后篡改会被 HASH_MISMATCH 先行拦截，测不到下游行为；改在 init 前使台账 hash 与改动一致）。
 */
function tamperManifestThenInit(dir, mutate) {
  const manifestPath = fixtureCopy(dir);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mutate(m);
  m.manifest_core_hash = manifestCoreHash(m);
  writeFileSync(manifestPath, JSON.stringify(m));
  const ledgerPath = join(dir, 'ledger.json');
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'test-run', '--now', T);
  assert.equal(r.status, 0, `init（篡改后）应 exit 0: ${r.stderr}`);
  return { ledgerPath, manifestPath };
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

/** 把组 g4 走完到 verified 的合法链（sc-p1d 合法链 + verify 凭据走验收交卷）。
 * 注意：delivered 自环仅 rounds+1 且受 reviewMaxRounds 上限（unresolved 唯一通道是审查交卷，
 * 测试初始 unresolved=0 直接可 review_pass）。 */
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
  grantVerifyPass(ledgerPath, g); // F-H：pass 凭据唯一通道 = 验收 record-delivery
  const r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
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
  const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
  assert.equal(r.status, 2, '组缺 sc_ids 必须 exit 2（fail-closed）');
  assert.match(r.stderr, /MANIFEST/, '必须走 MANIFEST 拒绝路径（点名，不是下游 TypeError 兜底）');
  assert.match(r.stderr, /缺少 sc_ids/);
  assert.equal(existsSync(ledgerPath), false, 'init 失败不得创建台账');
});

// r-g7 F6：receipts 无机器校验——形状随便写都能过。
// 契约（与 task-priority final-gate 产出逐字对齐）：存在时必须是非空数组，每条
// exact 键 { slug, manifest_core_hash, plan_hash, recorded_at }，双 hash 为 64 位十六进制（sha256）。
// 缺键允许（早期/中间产物无 receipts）；readManifest 统一拒坏形状（init/validate/render-packet/record-delivery 全入口）。
// 变异反证：挖掉 readManifest 里的 assertReceiptsSchema 调用 → ①②③ 全红（init 放行坏形状），恰红本用例。
// 子套件跳过（机制同 ready-check 的 RC_MUTATION_CHILD）：F1/F2 变异子套件的失败集契约与 receipts 无关；
// 不跳过会让「父树在途的其他变异（如挖掉 receipts 校验）」被拷贝进子套件 → 污染预测红集。
test('sc-receipts: manifest.receipts 形状校验——坏形状 init 拒、合法/缺键通过', (t) => {
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
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
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
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
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
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
    assert.equal(r.status, 2, 'receipt hash 非 64hex 必须 exit 2');
    assert.match(r.stderr, /manifest_core_hash 必须是 64 位十六进制/);
  }
  // ④ 合法形状 → exit 0（append-only 多条同样合法；缺键 = 早期产物同样放行，基线夹具覆盖）
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
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
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
  // 模拟他写者持锁（活 pid）
  writeFileSync(`${ledgerPath}.lock`, `${process.pid}\n`);
  const r = cli('set-state', ledgerPath, '--group', 'g4', '--to', 'dispatched', '--worker-label', 'w1', '--now', T);
  assert.equal(r.status, 2, '持锁中写必须 exit 2（fail-closed，拿不到锁不得继续）');
  assert.match(r.stderr, /LOCK_TIMEOUT/);
  assert.match(r.stderr, /lock/);
  assert.equal(readLedger(ledgerPath).version, 0, '持锁失败后台账必须未被写入');
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
  // 事件流：dispatch, delivery(exec), review_round×2, delivery(verify 凭据经 record-delivery)
  const types = ledger.events.map((e) => e.type);
  assert.ok(types.includes('dispatch'));
  assert.ok(types.includes('delivery'));
  assert.equal(types.filter((t) => t === 'review_round').length, 2);
  assert.equal(types.filter((t) => t === 'delivery').length, 2, 'exec 交卷 + verify 凭据交卷各一条');
});

test('sc-p1d: delivered 自环达上限拒（F-G 第 4 次自环必红，rounds 不可无限膨胀）', () => {
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
  // reviewMaxRounds=3：自环 3 次内合法（rounds 1→2→3），第 4 次（rounds=3 ≥ 3）必红
  for (let i = 0; i < 3; i += 1) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', 'delivered', '--now', T);
    assert.equal(r.status, 0, `自环第 ${i + 1} 次（上限内）应 exit 0: ${r.stderr}`);
  }
  const r4 = cli('set-state', ledgerPath, '--group', g, '--to', 'delivered', '--now', T);
  assert.equal(r4.status, 2, '第 4 次自环（达 reviewMaxRounds 上限）必须 exit 2');
  assert.match(r4.stderr, /自环达上限|不收敛/);
  assert.equal(readLedger(ledgerPath).waves[0].groups[0].review.rounds, 3, '被拒的自环不得推进 rounds');
});

test('sc-p1d: rounds 超上限时 delivered→review_pass 拒（审查不收敛，record-delivery 通道写入的高 rounds）', () => {
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
  // 审查交卷写入 rounds=5 > reviewMaxRounds=3（自环门已挡不住这一通道，review_pass 门兜底）
  const r = cli('record-delivery', ledgerPath, '--group', g, '--payload',
    JSON.stringify({ rounds: 5, findings_total: 5, unresolved: 0, fix_commits: [], candidate_sha: SHA1 }), '--now', T);
  assert.equal(r.status, 0, `审查交卷应 exit 0: ${r.stderr}`);
  const rp = cli('set-state', ledgerPath, '--group', g, '--to', 'review_pass', '--now', T);
  assert.equal(rp.status, 2, 'rounds 超上限 review_pass 必须 exit 2');
  assert.match(rp.stderr, /rounds≤3/);
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
  // unresolved 走唯一合法通道：record-delivery 审查交卷（candidate_sha 是 ready-check ③ 绑定必需键）
  const reviewDelivery = { rounds: 1, findings_total: 3, unresolved: 2, fix_commits: [], candidate_sha: SHA1 };
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
  grantVerifyPass(ledgerPath, g); // F-H：pass 凭据唯一通道 = 验收 record-delivery
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

test('sc-p1d: failed→pending 后 rounds==0 且 tip_sha/worker_label/身份三键清空（重派不继承旧计数/旧身份）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const g = 'g4';
  // 先分配身份（重派后必须被清空，render-packet 不得拿旧身份出包）
  assignIdentity(ledgerPath, g, 'feat/run-ledger');
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
    JSON.stringify({ rounds: 1, findings_total: 2, unresolved: 1, fix_commits: [], candidate_sha: SHA1 }), '--now', T);
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
  // F-I：身份三键必须一并清空（旧身份残留 = render-packet 拿旧 worktree 出包漏洞）
  assert.equal(g4.worktree, null, '重派后 worktree 必须清空');
  assert.equal(g4.branch, null, '重派后 branch 必须清空');
  assert.equal(g4.base, null, '重派后 base 必须清空');
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
  // 非法尝试落事件（detail 结构化：相位级无组上下文 → group_id 显式 null）
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.phase, 'executing', '非法 phase 跳转不得改变 phase');
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
  // →validating 前置失败（本波全组未 review_pass）
  let r = cli('set-state', ledgerPath, '--phase', 'reviewing', '--now', T);
  assert.equal(r.status, 0, `→reviewing 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'validating', '--now', T);
  assert.equal(r.status, 2, '→validating 前置未满足必须 exit 2');
  assert.match(r.stderr, /review_pass/);
  // F-E ② 波次顺序门：wave1 未集成前，wave2 组不可派工
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'dispatched', '--worker-label', 'wv1', '--now', T);
  assert.equal(r.status, 2, 'wave1 未集成时 wave2 派工必须 exit 2（波次顺序门）');
  assert.match(r.stderr, /最早未集成|前波/);
  // 完整合法链：g4 → verified（凭据走验收交卷）→ wave1 集成；v1 → verified → wave2 集成
  runG4ToVerified(ledgerPath);
  r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  assignIdentity(ledgerPath, v, 'feat/verify');
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'wv1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    r = cli('set-state', ledgerPath, '--group', v, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  grantVerifyPass(ledgerPath, v); // F-H：凭据唯一通道 = 验收 record-delivery
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'verified', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--wave', '2', '--integrate', SHA1, '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // phase 单向前进（前置满足）
  r = cli('set-state', ledgerPath, '--phase', 'validating', '--now', T);
  assert.equal(r.status, 0, `→validating（前置满足）应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'e2e', '--now', T);
  assert.equal(r.status, 0, `→e2e 应 exit 0: ${r.stderr}`);
  r = cli('set-state', ledgerPath, '--phase', 'packaging', '--now', T);
  assert.equal(r.status, 0, `→packaging 应 exit 0: ${r.stderr}`);
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
  // 原漏洞路径：跳过 wave1（g4 不派工不集成），直接派 wave2 的 v1
  assignIdentity(ledgerPath, 'v1', 'feat/verify');
  const r = cli('set-state', ledgerPath, '--group', 'v1', '--to', 'dispatched', '--worker-label', 'wv1', '--now', T);
  assert.equal(r.status, 2, 'wave1 未集成时 wave2 派工必须 exit 2（波次顺序门）');
  assert.match(r.stderr, /最早未集成|前波/);
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.waves[0].groups[0].state, 'pending', 'wave1 g4 必须仍 pending');
  assert.equal(ledger.waves[1].groups[0].state, 'pending', 'wave2 v1 必须仍 pending（派工被顺序门拒）');
  // 对照：wave1 集成后 wave2 派工放行（合法链前半段）
  runG4ToVerified(ledgerPath);
  let ok = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(ok.status, 0, ok.stderr);
  ok = cli('set-state', ledgerPath, '--group', 'v1', '--to', 'dispatched', '--worker-label', 'wv1', '--now', T);
  assert.equal(ok.status, 0, `wave1 集成后 wave2 派工应 exit 0: ${ok.stderr}`);
});

test('sc-p1d: F-E 顺序门反例——伪造台账（v1 已 verified、wave1 未集成）→ phase 推进必拒', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerForClean(dir);
  // 手工构造：wave2 v1 走到 verified（伪造），wave1 g4 仍 pending 未集成
  const ledger = readLedger(ledgerPath);
  const v1 = ledger.waves[1].groups[0];
  v1.state = 'verified';
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
  let r = cli('set-state', ledgerPath, '--phase', 'reviewing', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  // F-E ③：→validating 要求所有前波已集成——wave1 未集成 → 拒
  r = cli('set-state', ledgerPath, '--phase', 'validating', '--now', T);
  assert.equal(r.status, 2, 'wave1 未集成时 →validating 必须 exit 2（前波未集成）');
  assert.match(r.stderr, /前波已集成|未集成前波/);
  assert.equal(readLedger(ledgerPath).phase, 'reviewing', '被拒的 phase 跳转不得改变 phase');
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
    const r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'x', '--now', T);
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
    // manifest 在 init 前改好并重算 hash（台账 hash 与改动一致，才能命中 PACKET_INCOMPLETE
    // 而非 F-D 门禁 HASH_MISMATCH——后者是另一个独立的拒因，由 F-D 专属测试覆盖）
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
    // init 前改 needs_three_review 并重算 hash（init 后改会被 F-D 门禁 HASH_MISMATCH 拦截）
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
    // init 前改 needs_three_review 并重算 hash（init 后改会被 F-D 门禁 HASH_MISMATCH 拦截）
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
  assignIdentity(ledgerPath, 'v1', 'feat/verify');
  // 真实编排顺序（D1 修复语义）：包是派工输入，render 必须先于派工。
  // wave 1 集成后立刻出 v1 的包——验收组复查的是上一波集成出来的树，
  // 不是它自己所在 wave 的树（读本波 integrated_tip 必然为 null，off-by-one-wave 死锁）。
  runG4ToVerified(ledgerPath);
  let r = cli('set-state', ledgerPath, '--wave', '1', '--integrate', SHA2, '--now', T);
  assert.equal(r.status, 0, r.stderr);
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
  // 出包之后才派工 v1 到 verified，然后集成 wave 2（真实顺序的剩余半程）
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
  grantVerifyPass(ledgerPath, v); // F-H：凭据唯一通道 = 验收 record-delivery
  r = cli('set-state', ledgerPath, '--group', v, '--to', 'verified', '--now', T);
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
  let r2 = cli('init', ledgerPath2, '--manifest', manifestPath2, '--run-id', 'test-run2', '--now', T);
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
  grantVerifyPass(ledgerPath, v); // F-H：凭据唯一通道 = 验收 record-delivery
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
  const payload = { rounds: 2, findings_total: 5, unresolved: 3, fix_commits: ['abc'.repeat(13), 'def'.repeat(13)], candidate_sha: SHA1 };
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `审查组交卷应 exit 0: ${r.stderr}`);
  const g4 = readLedger(ledgerPath).waves[0].groups[0];
  assert.equal(g4.review.rounds, 2, 'review.rounds 必须等于交卷值');
  assert.equal(g4.review.unresolved, 3, 'review.unresolved 必须等于交卷值（唯一入账通道）');
  // F1 契约：审查交卷 delivery detail 必须结构化且绑定 candidate_sha（ready-check ③ 读取点）
  const reviewDelivery = readLedger(ledgerPath).events.filter((e) => e.type === 'delivery')[0];
  assert.equal(reviewDelivery.detail.group_id, 'g4');
  assert.equal(reviewDelivery.detail.rounds, 2);
  assert.equal(reviewDelivery.detail.unresolved, 3);
  assert.equal(reviewDelivery.detail.candidate_sha, SHA1, '审查交卷 detail 必须绑定被审 candidate_sha（非派生默认）');
  // delivery detail 契约下限 {group_id, tip_sha, candidate_sha}：组未交付时 tip_sha 为 null（fail-closed，出口门 ① 对账会拒）
  assert.equal(reviewDelivery.detail.tip_sha, null, '组未交付时审查交卷 detail.tip_sha 必须为 null（fail-closed）');
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
  const payload = { rounds: 1, findings_total: 1, unresolved: 0, fix_commits: [], candidate_sha: SHA2 };
  const r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
  assert.equal(r.status, 0, `审查交卷应 exit 0: ${r.stderr}`);
  const delivery = readLedger(ledgerPath).events.find((e) => e.type === 'delivery');
  assert.equal(delivery.detail.candidate_sha, SHA2, 'candidate_sha 必须等于交卷 payload 值（审查方声明，非台账派生）');
  // delivery detail 契约下限：{group_id, tip_sha, candidate_sha} 三键齐备
  assert.equal(delivery.detail.group_id, 'g4');
  assert.ok(Object.prototype.hasOwnProperty.call(delivery.detail, 'tip_sha'), 'detail 必须含 tip_sha 键');
});

test('sc-p1h: 验收组合法交卷——verify.status/evidence_ref 入账', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  const payload = {
    scs: [{ sc_id: 'sc-v1a', status: 'pass', evidence: 'ready-check exit 0' }],
    integration_review: { status: 'pass', notes: 'squash diff 复查无越域' },
    candidate_sha: SHA1,
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

// =====================================================================
// F-H：--verify-status 手工通道移除 + verified 凭据绑定可解析 evidence_ref
// =====================================================================
test('F-H: set-state --verify-status/--verify-evidence-ref 手工写入口必拒（与 --unresolved 同类漏洞已封）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  for (const args of [
    ['--group', 'g4', '--to', 'delivered', '--verify-status', 'pass'],
    ['--group', 'g4', '--to', 'verified', '--verify-status', 'pass'],
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
  const g = 'g4';
  // 走到 review_pass（无 verify 凭据）
  for (const [to, extra] of [
    ['dispatched', ['--worker-label', 'w1']],
    ['delivered', ['--tip-sha', SHA1]],
    ['delivered', []],
    ['review_pass', []],
  ]) {
    const r = cli('set-state', ledgerPath, '--group', g, '--to', to, ...extra, '--now', T);
    assert.equal(r.status, 0, r.stderr);
  }
  // 无凭据 → verified 拒
  let r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 2, '无 verify.status=pass 凭据的 →verified 必须 exit 2');
  assert.match(r.stderr, /verify.status=pass/);
  // 手工伪造 verify.status=pass（直接改台账字节，绕过 CLI——验证 precondition 对伪造的 evidence_ref 也拒）
  const ledger = readLedger(ledgerPath);
  ledger.waves[0].groups[0].verify.status = 'pass';
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 2, 'status=pass 但 evidence_ref=null 的 →verified 必须 exit 2');
  assert.match(r.stderr, /evidence_ref/);
  // 伪造 evidence_ref 指向不存在/非 delivery 事件 → 拒
  const ledger2 = readLedger(ledgerPath);
  ledger2.waves[0].groups[0].verify.evidence_ref = 'delivery#99';
  writeFileSync(ledgerPath, `${JSON.stringify(ledger2, null, 2)}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 2, 'evidence_ref 不可解析到 delivery 事件必须 exit 2（伪造拒）');
  assert.match(r.stderr, /可解析|delivery/);
  // 对照：验收 record-delivery 写入的凭据（delivery#N 指向真实 delivery 事件）→ 放行
  grantVerifyPass(ledgerPath, g);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'verified', '--now', T);
  assert.equal(r.status, 0, `合法凭据 →verified 应 exit 0: ${r.stderr}`);
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
    // init 前篡改 g4 packet.scs_inline 引入重复/空 id 并重算 hash（F-D 内容绑定下，
    // init 后改会先撞 HASH_MISMATCH；hash 自洽后渲染/交卷才命中 PACKET_INCOMPLETE）
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
    // 交卷拒（即使交卷 scs 与去重后的 expected 一致，packet 自身契约先拒）
    const payload = execDeliveryPayload({ ids: ['sc-p1c', 'sc-p1d', 'sc-p1e', 'sc-p1h'] });
    const rd = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload', JSON.stringify(payload), '--now', T);
    assert.equal(rd.status, 2, `${label} id 的 record-delivery 必须 exit 2`);
    assert.match(rd.stderr, /PACKET_INCOMPLETE/, `${label} 交卷必须走 PACKET_INCOMPLETE（packet 自身契约先拒）`);
  }
});

test('F-J: 对照——packet.scs_inline 无重复时，交卷缺一/多一/重复仍按计数比对拒（原有 exact 语义保留）', () => {
  const dir = newTmpDir();
  const { ledgerPath } = initLedgerFor(dir);
  // 缺一：只交 3 项
  let r = cli('record-delivery', ledgerPath, '--group', 'g4', '--payload',
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

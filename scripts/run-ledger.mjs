#!/usr/bin/env node
// run-ledger.mjs — approve-exec run 状态机台账（sc-p1c/p1d/p1e/p1h）。
//
// 五个子命令：
//   init <ledger> --manifest <path> --run-id <id> --now <ts>
//   validate <ledger>
//   set-state <ledger> --group <gid> --to <state> --now <ts> [..]
//   set-state <ledger> --phase <phase> --now <ts> [--ready-check-exit0]
//   set-state <ledger> --wave <n> --integrate <sha> --now <ts>
//   set-state <ledger> --group <gid> --identity <json> --now <ts>
//   render-packet <ledger> --group <gid> [--manifest <path>]
//   record-delivery <ledger> --group <gid> --payload <json|@file> --now <ts>
//
// 硬约束：
//   - 台账 schema 是 exact 契约：未列键出现即拒（LedgerError SCHEMA）。
//   - 所有写路径 tmp+rename 原子替换 + 乐观锁 CAS（读时 version 为 expected，
//     落盘 version+1；写入前重读发现 version 已变 → 冲突 exit 2，绝不静默覆盖）。
//   - 时间戳由 --now 注入；无 --now 的写操作拒绝（确定性可测）。
//   - events[].type 为 exact 枚举，未知 type 拒。
//   - manifest 绑定是内容绑定：manifest_core_hash（黑名单剔除 + 键排序 + sha256）。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 错误类型：CLI 层统一转 exit 2（fail-closed 用码） ----------
export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// ---------- 配置（数值单一来源 config/defaults.json，禁字面量） ----------
let _defaults = null;
export function readDefaults() {
  if (_defaults) return _defaults;
  _defaults = JSON.parse(readFileSync(join(ROOT, 'config/defaults.json'), 'utf8'));
  return _defaults;
}

// ---------- 常量契约（SC 验收口径，非运行参数） ----------
export const EVENT_TYPES = Object.freeze([
  'dispatch',
  'delivery',
  'review_round',
  'integrate',
  'timeout_redispatch',
  'illegal_transition',
  'overreach_rejected',
  'overlap_replan',
  'budget_note',
]);
export const GROUP_STATES = Object.freeze([
  'pending', 'dispatched', 'delivered', 'review_pass', 'verified', 'failed',
]);
export const PHASE_ORDER = Object.freeze([
  'executing', 'reviewing', 'validating', 'e2e', 'packaging', 'ready',
]);
export const TIP_SHA_RE = /^[0-9a-f]{40}$/;
const EXEC_DELIVERY_STATUS = Object.freeze(['done', 'partial', 'blocked']);
const SC_RESULT_STATUS = Object.freeze(['pass', 'fail', 'not_run']);

// ---------- manifest core hash（与 task-priority hashing.mjs 同算法） ----------
const EXCLUDE_KEYS = new Set(['manifest_core_hash', 'receipts']);

function stripExcluded(value) {
  if (Array.isArray(value)) return value.map(stripExcluded);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (EXCLUDE_KEYS.has(key)) continue; // 黑名单：任何层级的同名键都剔除
      out[key] = stripExcluded(value[key]);
    }
    return out;
  }
  return value;
}

export function manifestCoreHash(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new LedgerError('MANIFEST', 'manifestCoreHash: manifest 必须是非数组对象');
  }
  return createHash('sha256').update(JSON.stringify(stripExcluded(manifest)), 'utf8').digest('hex');
}

// ---------- 台账 exact schema（未列键拒） ----------
const LEDGER_TOP_KEYS = Object.freeze([
  'schema_version', 'run_id', 'slug', 'manifest_path', 'manifest_core_hash',
  'version', 'phase', 'waves', 'events',
]);
const WAVE_KEYS = Object.freeze(['wave', 'integrated_tip', 'groups']);
// 身份三键（worktree/branch/base）属于台账 schema：由 lead 经 orca-fanout
// worktree-ledger 分配后经 set-state --identity 写入，render-packet 只读它。
const GROUP_KEYS = Object.freeze([
  'group_id', 'state', 'sc_ids', 'worker_label', 'dispatched_at', 'tip_sha',
  'review', 'verify', 'worktree', 'branch', 'base',
]);
const REVIEW_KEYS = Object.freeze(['rounds', 'unresolved']);
const VERIFY_KEYS = Object.freeze(['status', 'evidence_ref']);
const EVENT_KEYS = Object.freeze(['type', 'at', 'detail']);

function assertKeys(obj, allowed, what) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new LedgerError('SCHEMA', `${what} 必须是对象`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new LedgerError('SCHEMA', `${what} 含未列键: ${key}（exact 契约，未知键拒）`);
    }
  }
}

export function assertEventSchema(ev) {
  assertKeys(ev, EVENT_KEYS, 'event');
  if (!EVENT_TYPES.includes(ev.type)) {
    throw new LedgerError('SCHEMA', `event.type 未知: ${ev.type}（枚举: ${EVENT_TYPES.join('/')}）`);
  }
  if (typeof ev.at !== 'string' || ev.at.length === 0) {
    throw new LedgerError('SCHEMA', 'event.at 必须是非空字符串（--now 注入）');
  }
  if (typeof ev.detail !== 'string') {
    throw new LedgerError('SCHEMA', 'event.detail 必须是字符串');
  }
}

export function assertLedgerSchema(ledger) {
  assertKeys(ledger, LEDGER_TOP_KEYS, '台账顶层');
  for (const k of ['schema_version', 'run_id', 'slug', 'manifest_path', 'manifest_core_hash']) {
    if (typeof ledger[k] !== 'string' || ledger[k].length === 0) {
      throw new LedgerError('SCHEMA', `台账 ${k} 必须是非空字符串`);
    }
  }
  if (!Number.isInteger(ledger.version) || ledger.version < 0) {
    throw new LedgerError('SCHEMA', '台账 version 必须是非负整数（乐观锁计数）');
  }
  if (!PHASE_ORDER.includes(ledger.phase)) {
    throw new LedgerError('SCHEMA', `台账 phase 非法: ${ledger.phase}`);
  }
  if (!Array.isArray(ledger.waves)) {
    throw new LedgerError('SCHEMA', '台账 waves 必须是数组');
  }
  for (const wave of ledger.waves) {
    assertKeys(wave, WAVE_KEYS, 'wave');
    if (!Number.isInteger(wave.wave) || wave.wave < 0) {
      throw new LedgerError('SCHEMA', 'wave.wave 必须是非负整数');
    }
    if (wave.integrated_tip !== null && typeof wave.integrated_tip === 'string'
      && !TIP_SHA_RE.test(wave.integrated_tip)) {
      throw new LedgerError('SCHEMA', `wave ${wave.wave} 的 integrated_tip 非 40 位十六进制: ${wave.integrated_tip}`);
    }
    if (wave.integrated_tip !== null && typeof wave.integrated_tip !== 'string') {
      throw new LedgerError('SCHEMA', 'wave.integrated_tip 必须是 40hex 字符串或 null');
    }
    if (!Array.isArray(wave.groups)) {
      throw new LedgerError('SCHEMA', `wave ${wave.wave} 的 groups 必须是数组`);
    }
    for (const g of wave.groups) {
      assertKeys(g, GROUP_KEYS, `wave ${wave.wave} 的 group`);
      if (typeof g.group_id !== 'string' || g.group_id.length === 0) {
        throw new LedgerError('SCHEMA', 'group.group_id 必须是非空字符串');
      }
      if (!GROUP_STATES.includes(g.state)) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 状态非法: ${g.state}`);
      }
      if (!Array.isArray(g.sc_ids)) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 sc_ids 必须是数组`);
      }
      for (const id of g.sc_ids) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new LedgerError('SCHEMA', `group ${g.group_id} 的 sc_ids 元素必须是非空字符串`);
        }
      }
      for (const nullable of ['worker_label', 'dispatched_at', 'tip_sha', 'worktree', 'branch', 'base']) {
        if (g[nullable] !== null && typeof g[nullable] !== 'string') {
          throw new LedgerError('SCHEMA', `group ${g.group_id} 的 ${nullable} 必须是字符串或 null`);
        }
      }
      if (g.tip_sha !== null && !TIP_SHA_RE.test(g.tip_sha)) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 tip_sha 非 40 位十六进制`);
      }
      if (g.base !== null && !TIP_SHA_RE.test(g.base)) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 base 非 40 位十六进制`);
      }
      assertKeys(g.review, REVIEW_KEYS, `group ${g.group_id} 的 review`);
      if (!Number.isInteger(g.review.rounds) || g.review.rounds < 0) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 review.rounds 必须是非负整数`);
      }
      if (!Number.isInteger(g.review.unresolved) || g.review.unresolved < 0) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 review.unresolved 必须是非负整数`);
      }
      assertKeys(g.verify, VERIFY_KEYS, `group ${g.group_id} 的 verify`);
      for (const nullable of ['status', 'evidence_ref']) {
        if (g.verify[nullable] !== null && typeof g.verify[nullable] !== 'string') {
          throw new LedgerError('SCHEMA', `group ${g.group_id} 的 verify.${nullable} 必须是字符串或 null`);
        }
      }
    }
  }
  if (!Array.isArray(ledger.events)) {
    throw new LedgerError('SCHEMA', '台账 events 必须是数组');
  }
  for (const ev of ledger.events) {
    assertEventSchema(ev);
  }
}

// ---------- 读写：tmp+rename 原子替换 + 乐观锁 CAS ----------
export function tmpPath(ledgerPath) {
  return `${ledgerPath}.tmp`;
}

/** 只写 tmp（不 rename）——暴露分步是为了可测「写盘中断不污染原台账」。 */
export function writeTmp(ledgerPath, content) {
  writeFileSync(tmpPath(ledgerPath), content, 'utf8');
}

/** 把 tmp rename 到目标（原子替换）。 */
export function renameTmp(ledgerPath) {
  renameSync(tmpPath(ledgerPath), ledgerPath);
}

export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    throw new LedgerError('LEDGER_MISSING', `台账不存在: ${ledgerPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    throw new LedgerError('LEDGER_CORRUPT', `台账 JSON 解析失败: ${err.message}`);
  }
  assertLedgerSchema(parsed);
  return parsed;
}

/**
 * 乐观锁 CAS 写盘：expectedVersion = 读时 version；写入前重读现有文件，
 * version 必须仍 == expectedVersion（否则他写者插入），冲突 exit 2 绝不静默覆盖。
 * buildNext(current) 返回下一版台账对象（须把 version 置为 expectedVersion + 1）。
 */
export function writeLedgerAtomic(ledgerPath, expectedVersion, buildNext) {
  const current = readLedger(ledgerPath);
  if (current.version !== expectedVersion) {
    throw new LedgerError(
      'CAS_CONFLICT',
      `乐观锁冲突：expected version=${expectedVersion}，磁盘 version=${current.version}（他写者插入），拒绝覆盖`
    );
  }
  const next = buildNext(current);
  if (!Number.isInteger(next.version) || next.version !== expectedVersion + 1) {
    throw new LedgerError('SCHEMA', 'buildNext 必须把 version 置为 expectedVersion + 1');
  }
  assertLedgerSchema(next); // 写盘前自校验：坏台账永远不该落盘
  writeTmp(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
  renameTmp(ledgerPath);
  return next;
}

// ---------- manifest 读取 ----------
export function readManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new LedgerError('MANIFEST', `manifest 读取/解析失败（${manifestPath}）: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerError('MANIFEST', 'manifest 必须是非数组对象');
  }
  return parsed;
}

export function findPacket(manifest, groupId) {
  const packets = manifest?.dispatch?.packets;
  if (!Array.isArray(packets)) {
    throw new LedgerError('MANIFEST', 'manifest 缺少 dispatch.packets 数组');
  }
  const packet = packets.find((p) => p && typeof p === 'object' && p.group_id === groupId);
  if (!packet) {
    throw new LedgerError('NO_PACKET', `group ${groupId} 在 manifest 的 dispatch.packets 中无对应 packet`);
  }
  return packet;
}

export function findGroupWave(ledger, groupId) {
  const wave = ledger.waves.find((w) => w.groups.some((g) => g.group_id === groupId));
  if (!wave) {
    throw new LedgerError('NO_GROUP', `台账中无组 ${groupId}`);
  }
  return wave;
}

export function findGroup(ledger, groupId) {
  const wave = findGroupWave(ledger, groupId);
  return wave.groups.find((g) => g.group_id === groupId);
}

// ---------- 时间戳注入 ----------
function requireNow(now, what) {
  if (typeof now !== 'string' || now.length === 0) {
    throw new LedgerError('NOW_REQUIRED', `${what} 是写操作：必须携带 --now 时间戳（确定性可测，禁止缺省）`);
  }
  return now;
}

// ---------- init：从 task-manifest.json 派生台账 ----------
export function initLedger({ ledgerPath, manifestPath, runId, now }) {
  requireNow(now, 'init');
  if (!manifestPath) throw new LedgerError('ARGS', 'init 缺 --manifest <path>');
  if (!runId) throw new LedgerError('ARGS', 'init 缺 --run-id <id>');
  if (existsSync(ledgerPath)) {
    throw new LedgerError('ALREADY_EXISTS', `台账已存在，拒绝覆盖（${ledgerPath}）；如需重建先移走旧台账`);
  }
  const manifest = readManifest(manifestPath);
  if (!Array.isArray(manifest.waves)) {
    throw new LedgerError('MANIFEST', 'manifest 缺少 waves 数组');
  }
  // waves/groups/sc_ids 原样映射（不重算分组）；manifest_core_hash 原样复制（validate 才现算比对）
  const waves = manifest.waves.map((w) => {
    if (!Array.isArray(w.groups)) {
      throw new LedgerError('MANIFEST', `wave ${w.wave} 缺少 groups 数组`);
    }
    return {
      wave: w.wave,
      integrated_tip: null, // 集成前 null，本波全组 verified 后允许写入
      groups: w.groups.map((g) => {
        if (!Array.isArray(g.sc_ids)) {
          throw new LedgerError('MANIFEST', `wave ${w.wave} 的组 ${g.group_id} 缺少 sc_ids 数组（fail-closed，禁止静默空组）`);
        }
        return {
          group_id: g.group_id,
          state: 'pending',
          sc_ids: [...g.sc_ids],
          worker_label: null,
          dispatched_at: null,
          tip_sha: null,
          review: { rounds: 0, unresolved: 0 },
          verify: { status: null, evidence_ref: null },
          // 身份三键：集成期由 lead 经 set-state --identity 分配（初始 null）
          worktree: null,
          branch: null,
          base: null,
        };
      }),
    };
  });
  const ledger = {
    schema_version: typeof manifest.schema_version === 'string' ? manifest.schema_version : 'v1',
    run_id: runId,
    slug: typeof manifest.slug === 'string' ? manifest.slug : runId,
    manifest_path: resolve(manifestPath),
    manifest_core_hash: manifest.manifest_core_hash,
    version: 0,
    phase: 'executing', // E(执行) 起步
    waves,
    events: [],
  };
  assertLedgerSchema(ledger);
  // 新台账直接原子落盘（无旧内容可比，无 CAS 对手）；写盘中断 → 只有 tmp 残留，主文件不出现
  writeTmp(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  renameTmp(ledgerPath);
  return ledger;
}

// ---------- validate：重读 manifest 现算 core hash 与台账比对 ----------
export function validateLedger({ ledgerPath }) {
  const ledger = readLedger(ledgerPath);
  const manifest = readManifest(ledger.manifest_path);
  const computed = manifestCoreHash(manifest);
  if (computed !== ledger.manifest_core_hash) {
    throw new LedgerError(
      'HASH_MISMATCH',
      `manifest core hash 不匹配：台账=${ledger.manifest_core_hash}，现算=${computed}（旧台账配新 manifest 必拒，内容绑定）`
    );
  }
  return { ledger, computed };
}

// ---------- set-state ----------
const GROUP_TRANSITIONS = Object.freeze({
  pending: ['dispatched', 'failed'],
  dispatched: ['delivered', 'failed'],
  delivered: ['delivered', 'review_pass', 'failed'],
  review_pass: ['verified', 'failed'],
  failed: ['pending'],
  verified: [], // 组级终态，不可回退：任何跳转拒（重放攻击）
});

// phase 单向前进：→validating 要求本波全组 review_pass（或更终态）；
// →ready 仅允许由 ready-check exit 0 凭据驱动。
// 返回 null = 允许；返回字符串 = 拒绝原因（非法跳转/缺失前置）。
function phaseTransitionAllowed(ledger, targetPhase) {
  const idx = PHASE_ORDER.indexOf(ledger.phase);
  const targetIdx = PHASE_ORDER.indexOf(targetPhase);
  if (targetIdx !== idx + 1) {
    return `phase 非法跳转：${ledger.phase} → ${targetPhase}（须依次经过 ${PHASE_ORDER.slice(idx + 1, targetIdx).join(' → ') || '无'} 前进）`;
  }
  if (targetPhase === 'validating') {
    // 本波 = 最后一个包含非 pending 组的 wave（run 逐波推进，派过工的波才算在途；
    // 全 pending 时取第一个波——此时前置天然不满足，fail-closed）
    const activeWave = [...ledger.waves].reverse()
      .find((w) => w.groups.some((g) => g.state !== 'pending')) ?? ledger.waves[0];
    const allReviewPass = activeWave
      && activeWave.groups.every((g) => g.state === 'review_pass' || g.state === 'verified');
    if (!allReviewPass) {
      return '缺失前置：→validating 要求本波全组 review_pass（当前未满足）';
    }
  }
  return null;
}

/**
 * 非法尝试统一收口：先落 illegal_transition 事件（原子写盘），再抛 LedgerError。
 * 「每次非法尝试都留 events 记录」+「exit 2 点名」两者都要——事件写盘发生在
 * throw 之前（writeLedgerAtomic 内 throw 会导致事件不落盘，故先写后抛）。
 */
function rejectWithEvent({ ledgerPath, expected, now, group, detail, code, message }) {
  writeLedgerAtomic(ledgerPath, expected, (cur) => {
    cur.events.push({ type: 'illegal_transition', at: now, detail });
    return { ...cur, version: expected + 1 };
  });
  throw new LedgerError(code, message);
}

export function setState({
  ledgerPath, now, group, to, workerLabel, tipSha, event,
  identity, phase, wave, integrate, verifyStatus, verifyEvidenceRef, readyCheckExit0,
}) {
  requireNow(now, 'set-state');
  const ledger = readLedger(ledgerPath);
  if (ledger.phase === 'ready') {
    // ready 相位达成后台账冻结（只读）：任何写操作拒（含非法尝试，冻结后不落事件）
    throw new LedgerError('FROZEN', `台账已 ready（phase=${ledger.phase}），冻结只读，拒绝写操作`);
  }
  const expected = ledger.version;

  // ---- 身份写入（sc-p1e 依赖：worktree/分支/base 由 lead 分配后写入台账） ----
  if (identity !== undefined) {
    if (group === undefined) throw new LedgerError('ARGS', 'set-state --identity 必须与 --group 一起使用');
    let parsed;
    try {
      parsed = typeof identity === 'string' ? JSON.parse(identity) : identity;
    } catch (err) {
      throw new LedgerError('ARGS', `--identity 不是合法 JSON: ${err.message}`);
    }
    const allowed = Object.freeze(['worktree', 'branch', 'base']);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LedgerError('ARGS', '--identity 必须是 {worktree, branch, base} 对象');
    }
    for (const k of Object.keys(parsed)) {
      if (!allowed.includes(k)) {
        throw new LedgerError('ARGS', `--identity 含未列键: ${k}（只允许 worktree/branch/base）`);
      }
    }
    for (const k of allowed) {
      if (typeof parsed[k] !== 'string' || parsed[k].length === 0) {
        throw new LedgerError('ARGS', `--identity.${k} 必须是非空字符串`);
      }
      // 身份行渲染为空格分隔（worktree=.. branch=.. base=..），含空白会破坏解析，拒
      if (/\s/.test(parsed[k])) {
        throw new LedgerError('ARGS', `--identity.${k} 不得含空白字符: ${parsed[k]}`);
      }
    }
    if (!TIP_SHA_RE.test(parsed.base)) {
      throw new LedgerError('ARGS', `--identity.base 非 40 位十六进制: ${parsed.base}`);
    }
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      const g = findGroup(cur, group);
      g.worktree = parsed.worktree;
      g.branch = parsed.branch;
      g.base = parsed.base;
      return { ...cur, version: expected + 1 };
    });
  }

  // ---- verify 字段写入（review_pass→verified 前置 verify.status=pass 的凭据入口） ----
  if (verifyStatus !== undefined) {
    if (group === undefined) throw new LedgerError('ARGS', 'set-state --verify-status 必须与 --group 一起使用');
    if (typeof verifyStatus !== 'string' || verifyStatus.length === 0) {
      throw new LedgerError('ARGS', '--verify-status 必须是非空字符串');
    }
    if (verifyEvidenceRef !== undefined
      && (typeof verifyEvidenceRef !== 'string' || verifyEvidenceRef.length === 0)) {
      throw new LedgerError('ARGS', '--verify-evidence-ref 必须是非空字符串');
    }
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      const g = findGroup(cur, group);
      g.verify.status = verifyStatus;
      if (verifyEvidenceRef !== undefined) g.verify.evidence_ref = verifyEvidenceRef;
      return { ...cur, version: expected + 1 };
    });
  }

  // ---- wave 级集成：本波全组 verified 后写 integrated_tip ----
  if (integrate !== undefined) {
    if (wave === undefined) throw new LedgerError('ARGS', 'set-state --integrate 必须与 --wave <n> 一起使用');
    if (typeof integrate !== 'string' || !TIP_SHA_RE.test(integrate)) {
      throw new LedgerError('ARGS', `integrated_tip 非 40 位十六进制: ${integrate}`);
    }
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      const w = cur.waves.find((x) => x.wave === wave);
      if (!w) throw new LedgerError('NO_WAVE', `台账中无 wave ${wave}`);
      if (w.integrated_tip !== null) {
        throw new LedgerError('ILLEGAL_TRANSITION', `wave ${wave} 已集成（integrated_tip=${w.integrated_tip}），不可重复集成`);
      }
      const allVerified = w.groups.every((g) => g.state === 'verified');
      if (!allVerified) {
        const pending = w.groups.filter((g) => g.state !== 'verified').map((g) => g.group_id);
        throw new LedgerError(
          'PRECONDITION',
          `缺失前置：wave ${wave} 集成要求全组 verified，未 verified: ${pending.join(', ')}`
        );
      }
      w.integrated_tip = integrate;
      cur.events.push({
        type: 'integrate',
        at: now,
        detail: `wave=${wave} integrated_tip=${integrate}`,
      });
      return { ...cur, version: expected + 1 };
    });
  }

  // ---- phase 状态机：单向前进 ----
  if (phase !== undefined) {
    if (!PHASE_ORDER.includes(phase)) {
      throw new LedgerError('ARGS', `非法 phase: ${phase}（枚举: ${PHASE_ORDER.join('/')}）`);
    }
    const problem = phaseTransitionAllowed(ledger, phase);
    if (phase === 'ready' && !readyCheckExit0) {
      // →ready 的唯一凭据是 ready-check exit 0；无凭据 = 非法尝试
      rejectWithEvent({
        ledgerPath, expected, now, group: null,
        detail: `phase 非法跳转 ${ledger.phase} → ready：缺失前置（无 ready-check exit 0 凭据）`,
        code: 'PRECONDITION',
        message: '缺失前置：→ready 仅允许由 ready-check exit 0 凭据驱动（--ready-check-exit0 未携带）',
      });
    }
    if (problem) {
      rejectWithEvent({
        ledgerPath, expected, now, group: null,
        detail: `phase 非法跳转 ${ledger.phase} → ${phase}：${problem}`,
        code: 'ILLEGAL_TRANSITION',
        message: `phase 非法跳转 ${ledger.phase} → ${phase}：${problem}`,
      });
    }
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      cur.phase = phase;
      return { ...cur, version: expected + 1 };
    });
  }

  // ---- 组状态机 ----
  if (group === undefined || to === undefined) {
    throw new LedgerError('ARGS', 'set-state 需要 --group + --to（或 --phase / --wave+--integrate / --identity / --verify-status）');
  }
  if (!GROUP_STATES.includes(to)) {
    throw new LedgerError('ARGS', `非法目标状态: ${to}（枚举: ${GROUP_STATES.join('/')}）`);
  }
  const curGroup = findGroup(ledger, group);

  // 前置机器判（基于读到的台账版本；从 = 当前态）
  const preconditionProblem = () => {
    const g = curGroup;
    const from = g.state;
    if (to === 'dispatched' && from === 'pending') {
      if (!workerLabel) return '缺失前置：pending→dispatched 必须携带 --worker-label';
    }
    if (to === 'delivered' && from === 'dispatched') {
      if (typeof tipSha !== 'string' || !TIP_SHA_RE.test(tipSha)) {
        return `缺失前置：dispatched→delivered 必须携带 40hex --tip-sha（当前: ${tipSha ?? '无'}）`;
      }
    }
    if (to === 'delivered' && from === 'delivered') {
      // 审查轮自环：仅 rounds+1。unresolved 的唯一写入通道是 record-delivery 审查交卷
      // （CLI 层已拒 --unresolved，防手工填数绕过审查机器的计量）
    }
    if (to === 'review_pass' && from === 'delivered') {
      if (g.review.unresolved !== 0) {
        return `缺失前置：→review_pass 要求 unresolved==0（当前 ${g.review.unresolved}）`;
      }
      const maxRounds = readDefaults().reviewMaxRounds;
      if (g.review.rounds > maxRounds) {
        return `缺失前置：→review_pass 要求 rounds≤${maxRounds}（当前 ${g.review.rounds}，审查不收敛）`;
      }
    }
    if (to === 'verified' && from === 'review_pass') {
      if (g.verify.status !== 'pass') {
        return `缺失前置：→verified 要求 verify.status=pass（当前 ${g.verify.status ?? 'null'}）`;
      }
    }
    if (to === 'failed') {
      if (!event || !EVENT_TYPES.includes(event)) {
        return `缺失前置：→failed 必须携带 --event（枚举: ${EVENT_TYPES.join('/')}）`;
      }
    }
    if (to === 'pending' && from === 'failed') {
      // 重派链：rounds/unresolved 归零、tip_sha/worker_label 清空——重派语义为
      // 新 worktree 新一轮，不继承旧计数；身份（worktree/branch/base）一并清空，
      // 下轮派工时由 lead 重新分配。
    }
    return null;
  };

  // 重放攻击 / 非白名单：verified 终态不接受任何跳转
  if (!GROUP_TRANSITIONS[curGroup.state].includes(to)) {
    rejectWithEvent({
      ledgerPath, expected, now, group,
      detail: `组状态非法跳转 ${curGroup.state} → ${to}（组 ${group}；白名单: ${GROUP_TRANSITIONS[curGroup.state].join('/') || '无，终态只读'}）`,
      code: 'ILLEGAL_TRANSITION',
      message: `组 ${group} 状态非法跳转 ${curGroup.state} → ${to}（白名单外，重放攻击拒）`,
    });
  }

  const problem = preconditionProblem();
  if (problem) {
    rejectWithEvent({
      ledgerPath, expected, now, group,
      detail: `组 ${group} ${curGroup.state} → ${to} 被拒：${problem}`,
      code: 'PRECONDITION',
      message: `组 ${group} 状态跳转 ${curGroup.state} → ${to} 被拒：${problem}`,
    });
  }

  return writeLedgerAtomic(ledgerPath, expected, (cur) => {
    const g = findGroup(cur, group);
    const from = g.state;
    if (to === 'dispatched') {
      g.state = 'dispatched';
      g.worker_label = workerLabel;
      g.dispatched_at = now;
      cur.events.push({ type: 'dispatch', at: now, detail: `group=${group} worker_label=${workerLabel}` });
    } else if (to === 'delivered' && from === 'dispatched') {
      g.state = 'delivered';
      g.tip_sha = tipSha;
      cur.events.push({ type: 'delivery', at: now, detail: `group=${group} tip_sha=${tipSha}` });
    } else if (to === 'delivered' && from === 'delivered') {
      g.review.rounds += 1;
      // unresolved 不在此更新：唯一通道是 record-delivery 审查交卷（CLI --unresolved 已拒）
      cur.events.push({
        type: 'review_round',
        at: now,
        detail: `group=${group} rounds=${g.review.rounds} unresolved=${g.review.unresolved}`,
      });
    } else if (to === 'review_pass') {
      g.state = 'review_pass';
    } else if (to === 'verified') {
      g.state = 'verified';
    } else if (to === 'failed') {
      g.state = 'failed';
      cur.events.push({ type: event, at: now, detail: `group=${group} → failed（${event}）` });
    } else if (to === 'pending' && from === 'failed') {
      g.state = 'pending';
      g.review.rounds = 0;
      g.review.unresolved = 0;
      g.tip_sha = null;
      g.worker_label = null;
      g.dispatched_at = null;
      g.verify = { status: null, evidence_ref: null };
      cur.events.push({ type: 'timeout_redispatch', at: now, detail: `group=${group} 重派链重置（新 worktree 新一轮）` });
    }
    return { ...cur, version: expected + 1 };
  });
}

// ---------- render-packet：五项 fail-closed + 执行/验收双模板 ----------
const PACKET_REQUIRED_FIELDS = Object.freeze([
  'scs_inline', 'allowed_paths', 'verify_cmds', 'forbidden', 'submit_format',
]);

export function renderPacket({ ledgerPath, group, manifestPath }) {
  const ledger = readLedger(ledgerPath);
  const manifest = readManifest(manifestPath || ledger.manifest_path);
  const packet = findPacket(manifest, group);
  const wave = findGroupWave(ledger, group);
  const wg = wave.groups.find((g) => g.group_id === group);

  // 五项 fail-closed（对齐 goal 场景 C 清单）：缺一不出包。
  // 「空缺」= 键缺失/类型不符；空数组对 allowed_paths/forbidden 是合法表达
  // （验收组不改代码 → 空可写范围），scs_inline/verify_cmds 空数组视为空缺。
  for (const field of PACKET_REQUIRED_FIELDS) {
    const v = packet[field];
    if (v === undefined || v === null) {
      throw new LedgerError('PACKET_INCOMPLETE', `出包前校验失败：packet.${field} 空缺（fail-closed，缺一不出包）`);
    }
    if (field === 'scs_inline' && (!Array.isArray(v) || v.length === 0)) {
      throw new LedgerError('PACKET_INCOMPLETE', '出包前校验失败：packet.scs_inline 必须是非空数组');
    }
    if (field === 'verify_cmds' && (!Array.isArray(v) || v.length === 0)) {
      throw new LedgerError('PACKET_INCOMPLETE', '出包前校验失败：packet.verify_cmds 必须是非空数组');
    }
    if ((field === 'allowed_paths' || field === 'forbidden') && !Array.isArray(v)) {
      throw new LedgerError('PACKET_INCOMPLETE', `出包前校验失败：packet.${field} 必须是数组（空数组合法）`);
    }
    if (field === 'submit_format' && (typeof v !== 'string' || v.trim().length === 0)) {
      throw new LedgerError('PACKET_INCOMPLETE', '出包前校验失败：packet.submit_format 必须是非空字符串');
    }
  }

  // 身份字段单一来源是台账：只认台账值，不接受 CLI 覆盖（见 CLI 解析层）
  const { worktree, branch, base } = wg;
  if (!worktree || !branch || !base) {
    throw new LedgerError(
      'NO_IDENTITY',
      `组 ${group} 尚未分配身份（worktree/branch/base 需经 set-state --identity 写入台账），拒绝出包`
    );
  }

  // 组类型：kind 含 fix → 执行组模板；全部 kind=verify → 验收组模板
  const kinds = packet.scs_inline.map((s) => s && typeof s === 'object' && s.kind ? s.kind : null);
  const isExecGroup = kinds.some((k) => k === 'fix');
  const isVerifyGroup = kinds.every((k) => k === 'verify');

  if (isVerifyGroup) {
    if (!wave.integrated_tip) {
      throw new LedgerError(
        'NO_INTEGRATED',
        `验收组 ${group} 所在 wave ${wave.wave} 尚未集成（integrated_tip=null），无法渲染整合树复查项`
      );
    }
    return renderVerifyPacket({ packet, group, wg, wave, identity: { worktree, branch, base } });
  }
  if (!isExecGroup) {
    throw new LedgerError('PACKET_INCOMPLETE', `组 ${group} 的 scs_inline kind 既无 fix 也无全 verify，无法选模板`);
  }
  return renderExecPacket({ packet, group, wg, wave, identity: { worktree, branch, base } });
}

function renderExecPacket({ packet, group, wave, identity }) {
  const lines = [];
  // 固定头三要素（首行逐字；g7 文档测试会引用比对，一个字不能变）
  lines.push('用 goal skill 执行。');
  lines.push('--until-sc');
  lines.push(`worktree=${identity.worktree} branch=${identity.branch} base=${identity.base}`);
  lines.push('');
  lines.push(`run-ledger 派工包：组 ${group}（wave ${wave.wave}，执行组）`);
  lines.push('');
  lines.push('## SC 清单');
  for (const sc of packet.scs_inline) {
    lines.push(`- ${sc.id}: ${typeof sc.change === 'string' ? sc.change.split('\n')[0] : ''}`);
  }
  lines.push('');
  lines.push('## allowed_paths（唯一可写范围）');
  for (const p of packet.allowed_paths) lines.push(`- ${p}`);
  lines.push('');
  lines.push('## 禁做');
  for (const f of packet.forbidden) lines.push(`- ${f}`);
  lines.push('');
  lines.push('## 验证命令');
  for (const c of packet.verify_cmds) lines.push(c);
  lines.push('');
  lines.push('## 交卷格式');
  lines.push(packet.submit_format);
  return `${lines.join('\n')}\n`;
}

function renderVerifyPacket({ packet, group, wave, identity }) {
  const lines = [];
  // 验收组：不带 goal 触发行，明确只跑 verify 命令出 verdict 不改代码
  lines.push(`run-ledger 验收包：组 ${group}（wave ${wave.wave}，验收组）`);
  lines.push(`worktree=${identity.worktree} branch=${identity.branch} base=${identity.base}`);
  lines.push('');
  lines.push('## 职责');
  lines.push('只跑 verify 命令出 verdict，不改代码。');
  lines.push('');
  lines.push('## 验证命令');
  for (const c of packet.verify_cmds) lines.push(c);
  lines.push('');
  lines.push('## 整合树复查');
  lines.push(`integrated_tip=${wave.integrated_tip}（wave ${wave.wave} 集成 squash SHA）`);
  lines.push('对 integrated_tip 相对上一集成点的 squash diff 执行复查指令：核对改动物与台账断言一致、无越域写入、验证命令与 manifest 逐条一致。');
  return `${lines.join('\n')}\n`;
}

// ---------- record-delivery：worker 交卷进台账的唯一通道 ----------
const EXEC_DELIVERY_KEYS = Object.freeze(['status', 'tip_sha', 'scs']);
const EXEC_SC_KEYS = Object.freeze(['sc_id', 'status', 'evidence']);
const REVIEW_DELIVERY_KEYS = Object.freeze(['rounds', 'findings_total', 'unresolved', 'fix_commits']);
const VERIFY_DELIVERY_KEYS = Object.freeze(['scs', 'integration_review']);
const INTEGRATION_REVIEW_KEYS = Object.freeze(['status', 'notes']);

function classifyDelivery(data) {
  const keys = Object.keys(data).sort();
  const hasExec = EXEC_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === EXEC_DELIVERY_KEYS.length;
  const hasReview = REVIEW_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === REVIEW_DELIVERY_KEYS.length;
  const hasVerify = VERIFY_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === VERIFY_DELIVERY_KEYS.length;
  const hits = [hasExec, hasReview, hasVerify].filter(Boolean).length;
  if (hits !== 1) {
    throw new LedgerError(
      'DELIVERY_SCHEMA',
      `交卷 schema 无法唯一识别（exec/review/verify 三类命中 ${hits} 类）；exact 契约，多余键或缺失键都拒`
    );
  }
  if (hasExec) return 'exec';
  if (hasReview) return 'review';
  return 'verify';
}

function validateExecDelivery(data, packet) {
  if (!EXEC_DELIVERY_STATUS.includes(data.status)) {
    throw new LedgerError('DELIVERY_SCHEMA', `执行组交卷 status 非法: ${data.status}（枚举: ${EXEC_DELIVERY_STATUS.join('/')}）`);
  }
  if (typeof data.tip_sha !== 'string' || !TIP_SHA_RE.test(data.tip_sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', `执行组交卷 tip_sha 非 40 位十六进制（长度 ${data.tip_sha?.length ?? 0}）`);
  }
  if (!Array.isArray(data.scs) || data.scs.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '执行组交卷 scs 必须是非空数组');
  }
  for (const sc of data.scs) {
    assertKeys(sc, EXEC_SC_KEYS, '执行组交卷 sc 条目');
    if (typeof sc.sc_id !== 'string' || sc.sc_id.length === 0) {
      throw new LedgerError('DELIVERY_SCHEMA', '执行组交卷 sc.sc_id 必须是非空字符串');
    }
    if (!SC_RESULT_STATUS.includes(sc.status)) {
      throw new LedgerError('DELIVERY_SCHEMA', `执行组交卷 sc ${sc.sc_id} 的 status 非法: ${sc.status}`);
    }
    if (typeof sc.evidence !== 'string' || sc.evidence.trim().length === 0) {
      throw new LedgerError('DELIVERY_SCHEMA', `执行组交卷 sc ${sc.sc_id} 的 evidence 必须是非空字符串`);
    }
  }
  assertScIdSet(data.scs, packet, '执行组交卷');
}

/** sc_id 集合必须与派工包 scs_inline 完全一致（exact：多/少/错都拒）+ 无重复。 */
function assertScIdSet(scEntries, packet, what) {
  const expectedIds = packet.scs_inline.map((s) => s.id);
  const actualIds = scEntries.map((sc) => sc.sc_id);
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new LedgerError(
      'SC_ID_MISMATCH',
      `${what} sc_id 集合与派工包 scs_inline 不一致：缺 ${missing.join(',') || '无'}，多/错 ${extra.join(',') || '无'}`
    );
  }
  if (new Set(actualIds).size !== actualIds.length) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 存在重复 sc_id`);
  }
}

function validateReviewDelivery(data) {
  // rounds/findings_total/unresolved 都是整数语义字段（台账 review 层为整数契约），
  // 非负整数一把抓：字符串/小数/布尔/负值全部拒
  for (const k of ['rounds', 'findings_total', 'unresolved']) {
    if (!Number.isInteger(data[k]) || data[k] < 0) {
      throw new LedgerError('DELIVERY_SCHEMA', `审查组交卷 ${k} 必须是非负整数（当前: ${data[k]}）`);
    }
  }
  if (!Array.isArray(data.fix_commits)) {
    throw new LedgerError('DELIVERY_SCHEMA', '审查组交卷 fix_commits 必须是数组');
  }
  for (const c of data.fix_commits) {
    if (typeof c !== 'string') {
      throw new LedgerError('DELIVERY_SCHEMA', '审查组交卷 fix_commits 元素必须是字符串');
    }
  }
}

function validateVerifyDelivery(data, packet) {
  if (!Array.isArray(data.scs) || data.scs.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '验收组交卷 scs 必须是非空数组');
  }
  for (const sc of data.scs) {
    assertKeys(sc, EXEC_SC_KEYS, '验收组交卷 sc 条目');
    if (typeof sc.sc_id !== 'string' || sc.sc_id.length === 0) {
      throw new LedgerError('DELIVERY_SCHEMA', '验收组交卷 sc.sc_id 必须是非空字符串');
    }
    if (typeof sc.status !== 'string' || sc.status.length === 0) {
      throw new LedgerError('DELIVERY_SCHEMA', `验收组交卷 sc ${sc.sc_id} 的 status 必须是非空字符串`);
    }
    if (typeof sc.evidence !== 'string' || sc.evidence.trim().length === 0) {
      throw new LedgerError('DELIVERY_SCHEMA', `验收组交卷 sc ${sc.sc_id} 的 evidence 必须是非空字符串`);
    }
  }
  assertScIdSet(data.scs, packet, '验收组交卷');
  assertKeys(data.integration_review, INTEGRATION_REVIEW_KEYS, '验收组交卷 integration_review');
  if (typeof data.integration_review.status !== 'string' || data.integration_review.status.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '验收组交卷 integration_review.status 必须是非空字符串');
  }
  if (typeof data.integration_review.notes !== 'string') {
    throw new LedgerError('DELIVERY_SCHEMA', '验收组交卷 integration_review.notes 必须是字符串');
  }
}

export function recordDelivery({ ledgerPath, group, payload, now }) {
  requireNow(now, 'record-delivery');
  let data;
  if (typeof payload === 'string' && payload.startsWith('@')) {
    const filePath = resolve(payload.slice(1));
    try {
      data = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new LedgerError('DELIVERY_PARSE', `交卷文件解析失败（${filePath}）: ${err.message}`);
    }
  } else if (typeof payload === 'string') {
    try {
      data = JSON.parse(payload);
    } catch (err) {
      throw new LedgerError('DELIVERY_PARSE', `交卷 JSON 解析失败: ${err.message}`);
    }
  } else {
    data = payload;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new LedgerError('DELIVERY_SCHEMA', '交卷必须是 JSON 对象');
  }

  const ledger = readLedger(ledgerPath);
  if (ledger.phase === 'ready') {
    throw new LedgerError('FROZEN', `台账已 ready（phase=${ledger.phase}），冻结只读，拒绝写操作`);
  }
  const expected = ledger.version;
  const wave = findGroupWave(ledger, group);
  const wg = wave.groups.find((g) => g.group_id === group);
  const manifest = readManifest(ledger.manifest_path);
  const packet = findPacket(manifest, group);

  const kind = classifyDelivery(data);
  if (kind === 'exec') validateExecDelivery(data, packet);
  if (kind === 'review') validateReviewDelivery(data);
  if (kind === 'verify') validateVerifyDelivery(data, packet);

  // 校验全部通过才原子写盘；任何失败路径都不触碰原台账（坏交卷后台账字节不变）
  return writeLedgerAtomic(ledgerPath, expected, (cur) => {
    const g = findGroup(cur, group);
    if (kind === 'exec') {
      g.tip_sha = data.tip_sha;
      const scResults = data.scs.map((sc) => `${sc.sc_id}=${sc.status}`).join(', ');
      cur.events.push({
        type: 'delivery',
        at: now,
        detail: `group=${group} status=${data.status} tip_sha=${data.tip_sha} scs: ${scResults}`,
      });
    } else if (kind === 'review') {
      g.review.rounds = data.rounds;
      g.review.unresolved = data.unresolved;
      cur.events.push({
        type: 'delivery',
        at: now,
        detail: `group=${group} 审查交卷 rounds=${data.rounds} findings_total=${data.findings_total} unresolved=${data.unresolved} fix_commits=${data.fix_commits.length}`,
      });
    } else {
      g.verify.status = data.integration_review.status;
      g.verify.evidence_ref = `delivery#${cur.events.length + 1}`;
      cur.events.push({
        type: 'delivery',
        at: now,
        detail: `group=${group} 验收交卷 integration_review=${data.integration_review.status}: ${data.integration_review.notes}`,
      });
    }
    return { ...cur, version: expected + 1 };
  });
}

// ---------- CLI ----------
function usage() {
  return [
    'run-ledger <sub> <ledger> [flags]',
    '  init <ledger> --manifest <path> --run-id <id> --now <ts>',
    '  validate <ledger>',
    '  set-state <ledger> --group <gid> --to <state> --now <ts> [--worker-label <l>] [--tip-sha <hex40>] [--event <type>] [--verify-status <s>] [--verify-evidence-ref <r>]',
    '  set-state <ledger> --identity <json> --group <gid> --now <ts>',
    '  set-state <ledger> --phase <phase> --now <ts> [--ready-check-exit0]',
    '  set-state <ledger> --wave <n> --integrate <hex40> --now <ts>',
    '  render-packet <ledger> --group <gid> [--manifest <path>]',
    '  record-delivery <ledger> --group <gid> --payload <json|@file> --now <ts>',
    '退出码：0 成功 / 1 用法错误 / 2 fail-closed（schema/CAS/前置/hash 不匹配等，点名原因）',
  ].join('\n');
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const value = eq === -1 ? args[i + 1] : a.slice(eq + 1);
    if (eq === -1 && (value === undefined || value.startsWith('--'))) {
      throw new LedgerError('ARGS', `参数 --${key} 缺值`);
    }
    if (eq === -1) i += 1;
    flags[key] = value;
  }
  return flags;
}

// render-packet 的身份字段单一来源是台账：CLI 一律拒（防覆盖）
const IDENTITY_CLI_FLAGS = Object.freeze(['worktree', 'branch', 'base', 'identity']);

export function runCli(argv) {
  if (argv.length === 0) {
    console.error(usage());
    return 1;
  }
  const [sub, ledgerArg, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!ledgerArg) {
    console.error(`run-ledger: ${sub} 缺 <ledger> 路径\n${usage()}`);
    return 1;
  }
  const ledgerPath = resolve(ledgerArg);

  try {
    switch (sub) {
      case 'init': {
        initLedger({
          ledgerPath,
          manifestPath: flags.manifest,
          runId: flags['run-id'],
          now: flags.now,
        });
        console.log(`init: 台账已创建 ${ledgerPath}（version=0, phase=executing）`);
        return 0;
      }
      case 'validate': {
        const { computed } = validateLedger({ ledgerPath });
        console.log(`validate: OK（core hash 匹配 ${computed}）`);
        return 0;
      }
      case 'set-state': {
        // 身份字段只走 --identity JSON；独立 --worktree/--branch/--base flag 一律拒（防绕行）
        for (const k of ['worktree', 'branch', 'base']) {
          if (flags[k] !== undefined) {
            throw new LedgerError('ARGS', `身份字段只允许经 --identity JSON 写入（收到独立 --${k}，拒绝）`);
          }
        }
        // unresolved 的唯一写入通道是 record-delivery 审查交卷：set-state 一律拒 --unresolved
        // （防手工填数绕过审查机器的计量，与「无手工填数通道」设计预期对齐）
        if (flags.unresolved !== undefined) {
          throw new LedgerError('ARGS', 'unresolved 只能经 record-delivery 审查交卷入账（--unresolved 手工填数通道已关闭）');
        }
        const usedIdentity = flags.identity !== undefined;
        setState({
          ledgerPath,
          now: flags.now,
          group: flags.group,
          to: flags.to,
          workerLabel: flags['worker-label'],
          tipSha: flags['tip-sha'],
          event: flags.event,
          identity: usedIdentity ? flags.identity ?? undefined : undefined,
          phase: flags.phase,
          wave: flags.wave === undefined ? undefined : Number(flags.wave),
          integrate: flags.integrate,
          verifyStatus: flags['verify-status'],
          verifyEvidenceRef: flags['verify-evidence-ref'],
          readyCheckExit0: flags['ready-check-exit0'] === '1' || flags['ready-check-exit0'] === 'true',
        });
        if (flags.phase !== undefined) {
          console.log(`set-state: phase → ${flags.phase}（version+1）`);
        } else if (flags.integrate !== undefined) {
          console.log(`set-state: wave ${flags.wave} integrated_tip=${flags.integrate}`);
        } else if (flags.identity !== undefined) {
          console.log(`set-state: group ${flags.group} 身份已写入台账`);
        } else {
          console.log(`set-state: group ${flags.group} ${flags.to ?? ''}（version+1）`);
        }
        return 0;
      }
      case 'render-packet': {
        if (IDENTITY_CLI_FLAGS.some((k) => flags[k] !== undefined)) {
          throw new LedgerError(
            'ARGS',
            'render-packet 身份字段（worktree/branch/base）单一来源是台账，不接受 CLI 覆盖'
          );
        }
        const out = renderPacket({
          ledgerPath,
          group: flags.group,
          manifestPath: flags.manifest,
        });
        process.stdout.write(out);
        return 0;
      }
      case 'record-delivery': {
        recordDelivery({
          ledgerPath,
          group: flags.group,
          payload: flags.payload,
          now: flags.now,
        });
        console.log(`record-delivery: group ${flags.group} 交卷已入账（version+1）`);
        return 0;
      }
      default:
        console.error(`run-ledger: 未知子命令 ${sub}\n${usage()}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`run-ledger: [${err.code}] ${err.message}`);
      return 2; // fail-closed：schema/CAS/前置/hash 不匹配等一律 exit 2
    }
    console.error(`run-ledger: 未预期错误: ${err.message}`);
    return 2;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}

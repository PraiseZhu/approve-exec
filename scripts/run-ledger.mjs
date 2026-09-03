#!/usr/bin/env node
// run-ledger.mjs — approve-exec run 状态机台账（sc-p1c/p1d/p1e/p1h）。
//
// 五个子命令：
//   init <ledger> --manifest <path> --run-id <id> --now <ts>
//   validate <ledger>
//   set-state <ledger> --group <gid> --to <state> --now <ts> [..]
//   set-state <ledger> --phase <phase> --now <ts> [--ready-receipt <path>]
//   set-state <ledger> --wave <n> --integrate <sha> --now <ts>
//   set-state <ledger> --group <gid> --identity <json> --now <ts>
//   render-packet <ledger> --group <gid> [--manifest <path>]
//   record-delivery <ledger> --group <gid> --payload <json|@file> --now <ts>
//
// 硬约束：
//   - 台账 schema 是 exact 契约：未列键出现即拒（LedgerError SCHEMA）。
//   - 所有写路径 独占锁 + 唯一 tmp + rename 原子替换 + 乐观锁 CAS（读时 version 为 expected，
//     落盘 version+1；锁内重读发现 version 已变 → 冲突 exit 2，绝不静默覆盖）。
//   - 消费 manifest 的命令（validate/render-packet/record-delivery）入口统一校
//     manifestCoreHash(实读文件) == ledger.manifest_core_hash，不符 exit 2（内容绑定，F-D）。
//   - 时间戳由 --now 注入；无 --now 的写操作拒绝（确定性可测）。
//   - events[].type 为 exact 枚举，未知 type 拒。
//   - events[].detail 是结构化对象契约：必须含 group_id 键（组上下文事件非空字符串；
//     ready-check 消费侧读取 detail.group_id/tip_sha/candidate_sha，字符串 detail 会让
//     分区对账与 delivery 绑定形同虚设）。phase→ready 时写 phase_at（ready 时点唯一记录）。
//   - manifest 绑定是内容绑定：manifest_core_hash（黑名单剔除 + 键排序 + sha256）。
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, existsSync,
  openSync, writeSync, closeSync, unlinkSync, realpathSync,
} from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMiniWatchConfig, miniWatchConfigSha256 } from './lib/mini-watch-config.mjs';

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
  'packet_rendered',
  'timeout_redispatch',
  'illegal_transition',
  'overreach_rejected',
  'overlap_replan',
  'budget_note',
  'session_created',
  'session_steer',
  'gate_goal',
  'gate_routing',
  'pr_opened',
  'accepted',
  'local_cleaned',
  'session_archived',
  'watch_registered',
  'site_report',
  'replan_note',
]);
// set-state --to failed 的 --event 白名单（窄事件集）：只允许「失败原因类」事件。
// dispatch/delivery/review_round/integrate 是成功流事件——ready-check ①③ 消费它们做分区
// 对账与「最后一次 delivery」判定（读 detail.tip_sha/candidate_sha），由 set-state 伪造的
// delivery 缺 worker payload/tip_sha/candidate_sha，会让对账结果被污染且无从分辨真伪；
// illegal_transition 是系统拒绝记录（rejectWithEvent 专用），不是组失败原因。
// delivery 类型事件只能由 record-delivery / delivered 转移产生（唯一真写入口）。
export const FAILED_EVENT_TYPES = Object.freeze([
  'timeout_redispatch',  // 超时（worker 未交卷，lead 标记失败）
  'overreach_rejected',  // 越权被拒
  'overlap_replan',      // 重叠重排
  'budget_note',         // 预算耗尽
]);
export const GROUP_STATES = Object.freeze([
  'pending', 'dispatched', 'executing', 'blocked', 'e2e', 'review', 'accepted', 'pr-open', 'local-cleaned', 'archived', 'failed',
]);
export const PHASE_ORDER = Object.freeze([
  'splitting', 'dispatching', 'running', 'accepting', 'ready',
]);
export const TIP_SHA_RE = /^[0-9a-f]{40}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

// detail 契约的组上下文事件：ready-check 的分区对账与 delivery 绑定读取 detail.group_id 的
// 事件类型（F1 修复点）。wave 级（integrate）与相位级（illegal_transition 的 group_id: null）
// 事件无组上下文，不强制非空字符串，但 detail 必须显式含 group_id 键（无组归属写 null，不伪造）。
const GROUP_SCOPED_EVENT_TYPES = new Set([
  'dispatch', 'delivery', 'review_round', 'packet_rendered', 'timeout_redispatch',
  'overreach_rejected', 'overlap_replan', 'budget_note',
  'session_created', 'session_steer', 'gate_goal', 'gate_routing', 'pr_opened', 'accepted',
  'local_cleaned', 'session_archived', 'watch_registered',
  'replan_note',
]);
const GATE_EVENT_TYPES = Object.freeze(['gate_goal', 'gate_routing']);
const SESSION_EVENT_TYPES = Object.freeze([
  'session_created', 'session_steer', 'pr_opened', 'accepted',
  'local_cleaned', 'session_archived', 'watch_registered',
]);
const NOTE_EVENT_TYPES = Object.freeze(['site_report', 'replan_note', 'watch_registered']);
const OLD_WATCH_SCHEDULE_IDS = Object.freeze([
  ...loadMiniWatchConfig().old_schedule_ids_blocklist,
]);
const REPLAN_ACTIONS = Object.freeze(['repack', 'resplit', 'land-first', 'split-new']);
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

/**
 * 内容绑定入口闸（F-D）：任何消费 manifest 的命令（validate/render-packet/record-delivery）
 * 先校 manifestCoreHash(实读文件) == ledger.manifest_core_hash。manifest 变了就不能再拿
 * 旧结论干活——绑定不能只存在于「你可以不调」的 validate 里。不符抛 HASH_MISMATCH（exit 2 点名）。
 */
export function assertManifestBound(ledger, manifest, what) {
  const computed = manifestCoreHash(manifest);
  if (computed !== ledger.manifest_core_hash) {
    throw new LedgerError(
      'HASH_MISMATCH',
      `${what}: manifest core hash 不匹配：台账=${ledger.manifest_core_hash}，现算=${computed}（manifest 内容已变/异本，内容绑定拒：禁止拿旧 manifest 干活）`
    );
  }
  return computed;
}

// ---------- 台账 exact schema（未列键拒） ----------
// phase_at：ready 时点时间戳（F2 修复点）。ready-check 驱动 phase→ready 时写入；phase 跳转不落
// 事件（setState phase 分支只改 phase），若无 phase_at，「何时达成 ready」无处可查，故它是 ready
// 时点的唯一记录、有审计价值——进 exact 键白名单，而不是删掉 ready-check 的写入。
const LEDGER_TOP_KEYS = Object.freeze([
  'schema_version', 'run_id', 'slug', 'manifest_path', 'manifest_core_hash',
  'version', 'phase', 'phase_at',
  'baseline_tip', // 独立成行：F2 变异锚点只挖 phase_at 行，baseline_tip 保持白名单成员
  'mini_watch_config_sha256', // 独立成行：init 钉死盯梢配置，watch_registered 三方等值
  'waves', 'events',
]);
const WAVE_KEYS = Object.freeze(['wave', 'integrated_tip', 'groups']);
// 身份三键（worktree/branch/base）属于台账 schema：由 lead 经 orca-fanout
// worktree-ledger 分配后经 set-state --identity 写入，render-packet 只读它。
// assignment_seq：组级派发代际计数器（sc-p0c 代际隔离）——init 时赋 0，
// failed→pending 重派递增 +1，使同 worktree/branch/base 三键的重派产生不同
// identity_digest，旧代 packet_rendered 凭证自然失配。
const GROUP_KEYS = Object.freeze([
  'group_id', 'state', 'sc_ids', 'worker_label', 'dispatched_at', 'tip_sha',
  'review', 'verify', 'worktree', 'branch', 'base', 'assignment_seq',
  'session_id', 'title', 'pr_url', 'provider_id',
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
  // ---- detail 结构化契约（F1 修复点；ready-check 消费侧读取 detail.group_id/tip_sha/candidate_sha）----
  // 字符串 detail 会让 ready-check 的 e.detail?.group_id 恒 undefined：分区对账与 delivery 绑定
  // 形同虚设（该拒的拒不掉）。对象必须含 group_id 键；组上下文事件要求非空字符串；
  // wave 级 integrate 与相位级 illegal_transition 无组上下文，显式 group_id: null。
  if (ev.detail === null || typeof ev.detail !== 'object' || Array.isArray(ev.detail)) {
    throw new LedgerError('SCHEMA', 'event.detail 必须是对象（ready-check 读 detail.group_id；字符串 detail 会让分区对账与 delivery 绑定形同虚设）');
  }
  if (!('group_id' in ev.detail)) {
    throw new LedgerError('SCHEMA', 'event.detail 缺 group_id 键（无组上下文的事件显式写 group_id: null，不得缺键）');
  }
  if (GROUP_SCOPED_EVENT_TYPES.has(ev.type)
    && (typeof ev.detail.group_id !== 'string' || ev.detail.group_id.length === 0)) {
    throw new LedgerError('SCHEMA', 'event.type=' + ev.type + ' 的 detail.group_id 必须是非空字符串（ready-check 分区对账/delivery 绑定的读取点）');
  }
  if (ev.type === 'gate_goal') {
    const sha = ev.detail.goal_skill_sha256;
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
      throw new LedgerError('SCHEMA', 'gate_goal 的 detail.goal_skill_sha256 必须是 64 位十六进制（缺 sha256 拒）');
    }
    if (!Number.isSafeInteger(ev.detail.assignment_seq) || ev.detail.assignment_seq < 0) {
      throw new LedgerError('SCHEMA', 'gate_goal 的 detail.assignment_seq 必须是非负安全整数（代际隔离）');
    }
  }
  if (ev.type === 'gate_routing') {
    const sha = ev.detail.routing_sha256;
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
      throw new LedgerError('SCHEMA', 'gate_routing 的 detail.routing_sha256 必须是 64 位十六进制（缺 sha256 拒）');
    }
    if (!Number.isSafeInteger(ev.detail.assignment_seq) || ev.detail.assignment_seq < 0) {
      throw new LedgerError('SCHEMA', 'gate_routing 的 detail.assignment_seq 必须是非负安全整数（代际隔离）');
    }
  }
  if (ev.type === 'site_report') {
    if (ev.detail.group_id !== null) {
      throw new LedgerError('SCHEMA', 'site_report 的 detail.group_id 必须是 null（run 级，不挂组）');
    }
    const sha = ev.detail.report_sha256;
    if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
      throw new LedgerError('SCHEMA', 'site_report 的 detail.report_sha256 必须是 64 位十六进制');
    }
  }
  if (ev.type === 'replan_note') {
    for (const k of ['origin_group', 'broke_assumption', 'action']) {
      if (typeof ev.detail[k] !== 'string' || ev.detail[k].length === 0) {
        throw new LedgerError('SCHEMA', `replan_note 的 detail.${k} 必须是非空字符串`);
      }
    }
    if (!REPLAN_ACTIONS.includes(ev.detail.action)) {
      throw new LedgerError('SCHEMA', `replan_note.action 必须是 ${REPLAN_ACTIONS.join('/')}（收到: ${ev.detail.action}）`);
    }
    if (!Array.isArray(ev.detail.affected_groups) || ev.detail.affected_groups.some((g) => typeof g !== 'string' || g.length === 0)) {
      throw new LedgerError('SCHEMA', 'replan_note 的 detail.affected_groups 必须是非空字符串数组');
    }
  }
  if (ev.type === 'watch_registered') {
    const url = ev.detail.pr_url;
    if (typeof url !== 'string' || !GITHUB_PR_URL_RE.test(url)) {
      throw new LedgerError('SCHEMA', 'watch_registered 的 detail.pr_url 必须是 GitHub PR URL');
    }
    if (typeof ev.detail.state_file !== 'string' || ev.detail.state_file.length === 0) {
      throw new LedgerError('SCHEMA', 'watch_registered 的 detail.state_file 必须是非空字符串');
    }
    for (const k of ['owner', 'repo']) {
      if (typeof ev.detail[k] !== 'string' || ev.detail[k].length === 0) {
        throw new LedgerError('SCHEMA', `watch_registered 的 detail.${k} 必须是非空字符串`);
      }
    }
    if (!Number.isSafeInteger(ev.detail.pr_number) || ev.detail.pr_number <= 0) {
      throw new LedgerError('SCHEMA', 'watch_registered 的 detail.pr_number 必须是正整数');
    }
    if (!Number.isSafeInteger(ev.detail.assignment_seq) || ev.detail.assignment_seq < 0) {
      throw new LedgerError('SCHEMA', 'watch_registered 的 detail.assignment_seq 必须是非负安全整数（代际隔离）');
    }
    const blob = JSON.stringify(ev.detail);
    for (const id of OLD_WATCH_SCHEDULE_IDS) {
      if (blob.includes(id)) {
        throw new LedgerError('SCHEMA', `watch_registered 不得引用旧班车 id ${id}`);
      }
    }
  }
}

export function assertLedgerSchema(ledger) {
  assertKeys(ledger, LEDGER_TOP_KEYS, '台账顶层');
  for (const k of ['schema_version', 'run_id', 'slug', 'manifest_path', 'manifest_core_hash']) {
    if (typeof ledger[k] !== 'string' || ledger[k].length === 0) {
      throw new LedgerError('SCHEMA', `台账 ${k} 必须是非空字符串`);
    }
  }
  if (!Number.isSafeInteger(ledger.version) || ledger.version < 0) {
    // isInteger 放行 2^53：version+1 在该值上精度饱和不再递增（9007199254740992+1 === 9007199254740992），
    // CAS 的「读到的版本 ≠ 当前版本就拒」恒判等 → 乐观锁失效、多陈旧写者同时成功静默覆盖。
    throw new LedgerError('SCHEMA', `台账 version 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}，乐观锁计数；超出安全范围 +1 会精度饱和使 CAS 失效），当前: ${ledger.version}`);
  }
  if (!PHASE_ORDER.includes(ledger.phase)) {
    throw new LedgerError('SCHEMA', `台账 phase 非法: ${ledger.phase}`);
  }
  // F2 契约：phase_at 是 exact 键白名单成员；出现即必须是非空字符串；
  // phase=ready 时必须存在（ready 时点唯一记录，ready-check / set-state 凭据路径都写它）
  if (ledger.phase_at !== undefined && (typeof ledger.phase_at !== 'string' || ledger.phase_at.length === 0)) {
    throw new LedgerError('SCHEMA', '台账 phase_at 必须是非空字符串（ready 时点时间戳）');
  }
  if (ledger.phase === 'ready' && typeof ledger.phase_at !== 'string') {
    throw new LedgerError('SCHEMA', '台账 phase=ready 必须携带非空 phase_at（ready 时点唯一记录；ready-check / set-state 凭据路径写入）');
  }
  // baseline_tip（sc-p0a 基线漂移闸）：值为 40hex 或 null。
  // 40hex = 严格模式（基线闸/快照闸/凭证闸全强制）；null = 兼容模式（e2e-dryrun 等
  // 无基线语义的旧路径，三道新闸跳过）。init 是唯一合法建台账路径，键由 initLedger 写入。
  // 键完全缺失 = sc-p0a 引入前创建的存量台账（读入口宽容：补默认 null 后放行，不 throw，
  // 语义 = 旧台账视为兼容模式——baseline_tip=null 本就是兼容模式的合法值；首次写操作经
  // writeLedgerAtomic 自校验会把补默认后的键落盘，磁盘侧自然迁移）。宽容只针对「键完全
  // 缺失」这一种向后兼容场景：有键但值非法（非 40hex 非 null）仍拒，不放松值校验。
  if (!('baseline_tip' in ledger)) {
    ledger.baseline_tip = null;
  }
  if (ledger.baseline_tip !== null && !TIP_SHA_RE.test(ledger.baseline_tip)) {
    throw new LedgerError('SCHEMA', `台账 baseline_tip 非 40 位十六进制或 null: ${ledger.baseline_tip}`);
  }
  if (typeof ledger.mini_watch_config_sha256 !== 'string' || !SHA256_RE.test(ledger.mini_watch_config_sha256)) {
    throw new LedgerError('SCHEMA', `台账 mini_watch_config_sha256 必须是 64 位十六进制（init 钉死的盯梢配置闸；缺/空/非 hex 拒），当前: ${ledger.mini_watch_config_sha256}`);
  }
  if (!Array.isArray(ledger.waves) || ledger.waves.length === 0) {
    throw new LedgerError('SCHEMA', '台账 waves 必须是非空数组（禁止空波次计划，F-E fail-closed）');
  }
  for (const wave of ledger.waves) {
    assertKeys(wave, WAVE_KEYS, 'wave');
    if (!Number.isSafeInteger(wave.wave) || wave.wave < 0) {
      throw new LedgerError('SCHEMA', `wave.wave 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}），当前: ${wave.wave}`);
    }
    if (wave.integrated_tip !== null && typeof wave.integrated_tip === 'string'
      && !TIP_SHA_RE.test(wave.integrated_tip)) {
      throw new LedgerError('SCHEMA', `wave ${wave.wave} 的 integrated_tip 非 40 位十六进制: ${wave.integrated_tip}`);
    }
    if (wave.integrated_tip !== null && typeof wave.integrated_tip !== 'string') {
      throw new LedgerError('SCHEMA', 'wave.integrated_tip 必须是 40hex 字符串或 null');
    }
    if (!Array.isArray(wave.groups) || wave.groups.length === 0) {
      throw new LedgerError('SCHEMA', `wave ${wave.wave} 的 groups 必须是非空数组（禁止空波次，F-E fail-closed）`);
    }
    for (const g of wave.groups) {
      assertKeys(g, GROUP_KEYS, `wave ${wave.wave} 的 group`);
      if (typeof g.group_id !== 'string' || g.group_id.length === 0) {
        throw new LedgerError('SCHEMA', 'group.group_id 必须是非空字符串');
      }
      if (!GROUP_STATES.includes(g.state)) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 状态非法: ${g.state}`);
      }
      if (!Array.isArray(g.sc_ids) || g.sc_ids.length === 0) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 sc_ids 必须是非空数组（禁止空 SC 集，F-E fail-closed）`);
      }
      for (const id of g.sc_ids) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new LedgerError('SCHEMA', `group ${g.group_id} 的 sc_ids 元素必须是非空字符串`);
        }
      }
      for (const nullable of ['worker_label', 'dispatched_at', 'tip_sha', 'worktree', 'branch', 'base', 'session_id', 'title', 'pr_url', 'provider_id']) {
        if (!(nullable in g)) g[nullable] = null;
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
      // assignment_seq（sc-p0c 代际计数器）：出现即必须非负安全整数（init 写 0，
      // 重派 +1；手写台账缺键不强制在场——凭证闸按 g.assignment_seq ?? 0 读取兜底）。
      if (g.assignment_seq !== undefined
        && (!Number.isSafeInteger(g.assignment_seq) || g.assignment_seq < 0)) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 assignment_seq 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}，当前: ${g.assignment_seq}）`);
      }
      assertKeys(g.review, REVIEW_KEYS, `group ${g.group_id} 的 review`);
      if (!Number.isSafeInteger(g.review.rounds) || g.review.rounds < 0) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 review.rounds 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}，审查自环会 +1），当前: ${g.review.rounds}`);
      }
      if (!Number.isSafeInteger(g.review.unresolved) || g.review.unresolved < 0) {
        throw new LedgerError('SCHEMA', `group ${g.group_id} 的 review.unresolved 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}），当前: ${g.review.unresolved}`);
      }
      assertKeys(g.verify, VERIFY_KEYS, `group ${g.group_id} 的 verify`);
      for (const nullable of ['status', 'evidence_ref']) {
        if (g.verify[nullable] !== null && typeof g.verify[nullable] !== 'string') {
          throw new LedgerError('SCHEMA', `group ${g.group_id} 的 verify.${nullable} 必须是字符串或 null`);
        }
      }
    }
  }
  // 波次编号唯一性（fail-closed，放在 per-wave 字段校验之后）：wave 编号是计划语义键，
  // 重复即坏——任何按数值读的消费（findGroupWave / latestIntegratedTip / render-packet 的
  // 「最新已集成」）都无法消歧，在 schema 层点名拒（readLedger 全读路径 + writeLedgerAtomic
  // 写路径共用本函数）。注意：数组顺序在此有意不校验（乱序由 initLedger 在 manifest 边界拒；
  // 台账级容忍乱序是为了让 render-packet 的「按数值取最新」消费侧防御可被乱序对照用例
  // 真正测到——消费侧必须在乱序下也正确，不能靠「顺序恰好有序」隐身）。
  const seenWaveNums = new Set();
  for (const wave of ledger.waves) {
    if (seenWaveNums.has(wave.wave)) {
      throw new LedgerError('SCHEMA', `台账 waves 含重复 wave 编号: ${wave.wave}（同一波次出现两次，语义非法，fail-closed 拒）`);
    }
    seenWaveNums.add(wave.wave);
  }
  if (!Array.isArray(ledger.events)) {
    throw new LedgerError('SCHEMA', '台账 events 必须是数组');
  }
  for (const ev of ledger.events) {
    assertEventSchema(ev);
  }
}

// ---------- 读写：独占锁 + 唯一 tmp + rename 原子替换 + 乐观锁 CAS ----------
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1000;

/** 同步睡眠（Atomics.wait 在 Node 主线程合法；仅用于锁重试退避）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 独占写锁：<ledger>.lock 以 O_EXCL 原子创建。拿不到 = 他写者正在临界区，
 * 重试至超时抛 LOCK_TIMEOUT（fail-closed，exit 2 点名）。
 * 持锁进程崩溃会留下锁文件：故意不做自动抢占——抢占（先读旧 pid → unlink → 重开）自身有
 * ABA 竞态，会重蹈本文件 F-C 的覆辙；超时错误信息点名人工删除路径。
 */
export function acquireLedgerLock(ledgerPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = `${ledgerPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, `${process.pid}\n`, null, 'utf8');
      closeSync(fd);
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new LedgerError('LOCK_ERROR', `台账锁获取失败（${lockPath}）: ${err.message}`);
      }
      if (Date.now() >= deadline) {
        throw new LedgerError(
          'LOCK_TIMEOUT',
          `台账锁等待超时（${lockPath}，${timeoutMs}ms）：他写者持锁中，拒绝写入（fail-closed）；若持锁进程已死，人工删除锁文件后重试`
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

/** 释放写锁（幂等：文件已不在时忽略）。 */
export function releaseLedgerLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    // 锁文件已不存在（幂等释放），忽略
  }
}

/**
 * 唯一 tmp 名：pid + 随机 nonce。并发写者绝不共享同一路径——
 * 固定 <ledger>.tmp 会让「A 写 → B 覆盖 → A rename」落盘 B 的值而 A 报成功（F-C 根因②）。
 */
export function tmpPath(ledgerPath) {
  return `${ledgerPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
}

/** 本进程最近一次为该台账写入的 tmp 路径（writeTmp/renameTmp 分步契约用）。 */
const _lastTmp = new Map();

/** 只写唯一 tmp（不 rename）——暴露分步是为了可测「写盘中断不污染原台账」。 */
export function writeTmp(ledgerPath, content) {
  const p = tmpPath(ledgerPath);
  writeFileSync(p, content, 'utf8');
  _lastTmp.set(ledgerPath, p);
}

/** 把最近一次写入的 tmp rename 到目标（原子替换）。 */
export function renameTmp(ledgerPath) {
  const p = _lastTmp.get(ledgerPath);
  if (p === undefined) {
    throw new LedgerError('TMP_MISSING', `无可 rename 的 tmp（${ledgerPath}）：须先 writeTmp 且未被 rename`);
  }
  renameSync(p, ledgerPath);
  _lastTmp.delete(ledgerPath);
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
 *
 * 独占锁包住「重读版本 → 写唯一 tmp → rename」整段（F-C）：仅比对 version 不构成 CAS——
 * 重读通过后到 rename 之间他写者仍可插入并覆盖共享 tmp；锁内临界区串行化后，
 * 冲突方一定在锁内重读处撞上 version 变化抛 CAS_CONFLICT，而非「报成功却落盘他者的值」。
 */
export function writeLedgerAtomic(ledgerPath, expectedVersion, buildNext, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const lockPath = acquireLedgerLock(ledgerPath, lockTimeoutMs);
  try {
    const current = readLedger(ledgerPath);
    if (current.version !== expectedVersion) {
      throw new LedgerError(
        'CAS_CONFLICT',
        `乐观锁冲突：expected version=${expectedVersion}，磁盘 version=${current.version}（他写者插入），拒绝覆盖`
      );
    }
    const next = buildNext(current);
    if (!Number.isSafeInteger(next.version) || next.version !== expectedVersion + 1) {
      // isSafeInteger 连带锁死 expectedVersion+1 的精度：expectedVersion=2^53-1 时 +1 得 2^53，
      // 已超出安全范围 → 拒（version 不能再安全递增，fail-closed）；isInteger 放行的 2^53 上
      // +1 恒等自身，乐观锁在饱和值上彻底失效。
      throw new LedgerError('SCHEMA', `buildNext 必须把 version 置为 expectedVersion + 1 且为非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}；expected=${expectedVersion}，next=${next.version}）`);
    }
    assertLedgerSchema(next); // 写盘前自校验：坏台账永远不该落盘
    writeTmp(ledgerPath, `${JSON.stringify(next, null, 2)}\n`);
    renameTmp(ledgerPath);
    return next;
  } finally {
    releaseLedgerLock(lockPath);
  }
}

// ---------- manifest receipts schema（r-g7 F6：形状契约；在场契约收口于 readManifest） ----------
// receipts 是 manifest 顶层元素（SKILL.md 输入门三要素之一），由 task-priority final-gate 全过时
// 追加写入（append-only 数组，每条 { slug, manifest_core_hash, plan_hash, recorded_at }，
// 双 hash 均为 sha256 hex）。本仓把它从 manifest core hash 黑名单剔除（不动点：追加 receipts
// 不破坏 hash 绑定），因此形状错误不会触碰 hash——形状校验必须独立存在。
// 在场由 readManifest 统一把关（init 与全部后继消费入口同判据，fail-closed）；本函数只管形状，
// 数组条目必须 exact 四键，未知键/类型错一律拒。
const RECEIPT_ENTRY_KEYS = Object.freeze(['slug', 'manifest_core_hash', 'plan_hash', 'recorded_at']);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function assertReceiptsSchema(manifest) {
  if (manifest.receipts === undefined) return;
  if (!Array.isArray(manifest.receipts)) {
    throw new LedgerError('SCHEMA', 'manifest.receipts 必须是数组（task-priority final-gate 追加写入的收据列表）');
  }
  for (const [i, rec] of manifest.receipts.entries()) {
    assertKeys(rec, RECEIPT_ENTRY_KEYS, `manifest.receipts[${i}]`);
    if (typeof rec.slug !== 'string' || rec.slug.length === 0) {
      throw new LedgerError('SCHEMA', `manifest.receipts[${i}].slug 必须是非空字符串`);
    }
    if (!SHA256_HEX_RE.test(rec.manifest_core_hash)) {
      throw new LedgerError('SCHEMA', `manifest.receipts[${i}].manifest_core_hash 必须是 64 位十六进制（sha256）`);
    }
    if (!SHA256_HEX_RE.test(rec.plan_hash)) {
      throw new LedgerError('SCHEMA', `manifest.receipts[${i}].plan_hash 必须是 64 位十六进制（sha256）`);
    }
    if (typeof rec.recorded_at !== 'string' || rec.recorded_at.length === 0) {
      throw new LedgerError('SCHEMA', `manifest.receipts[${i}].recorded_at 必须是非空字符串`);
    }
  }
}

// ---------- manifest 读取 ----------
// receipts 在场契约的唯一收口（D1：修在 readManifest，不在任何调用点——同一判据只允许存在一份，
// 防多份拷贝漂移）。receipts 在 core hash 黑名单之外（append-only 追加不破坏绑定），删它 hash
// 一个字节都不变——存在性不能靠 hash 兜底，必须在唯一入口要求在场（可空数组；形状由
// assertReceiptsSchema 把关）。init/validate/render-packet/record-delivery/set-state→ready
// 全部消费命令经此继承，任何消费方不得另写一份存在性检查。
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
  if (!('receipts' in parsed)) {
    throw new LedgerError('MANIFEST', 'manifest 缺 receipts 键（顶层要素 exact 在场契约，fail-closed：init 与全部后继消费入口统一要求在场，可空数组）');
  }
  assertReceiptsSchema(parsed); // 形状契约：存在必须形状正确（presence 由上行在场检查把关）
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
export function parseTimestamp(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what} 必须是非空时间戳`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what} 不是可解析时间（当前: ${value}）`);
  }
  return ms;
}

function requireNow(now, what) {
  if (typeof now !== 'string' || now.length === 0) {
    throw new LedgerError('NOW_REQUIRED', `${what} 是写操作：必须携带 --now 时间戳（确定性可测，禁止缺省）`);
  }
  parseTimestamp(now, `${what} --now`);
  return now;
}

// ---------- manifest 顶层与 packet 完整性判据（init 建台账前与 render-packet 出包前共用） ----------
// SKILL.md ② 段：manifest 缺 waves/dispatch/receipts 任一、或 packet 缺五要素任一 → 不开跑。
// 「不开跑」的机器语义 = init 就该拒（失败不写台账，连空台账都不留），不是「先开跑、出包时才炸」。
// 同一份判据在 init 与 render-packet 共用：同一判据两份实现必然漂移（写盘锁、集合比对都栽过），
// init 放行过的东西 render-packet 一定放行，反之亦然。
const PACKET_REQUIRED_FIELDS = Object.freeze([
  'scs_inline', 'allowed_paths', 'verify_cmds', 'forbidden', 'submit_format',
]);

/**
 * packet 完整性判据（render-packet 出包前与 init 建台账前共用同一份实现）。包含：
 *   ① PACKET_REQUIRED_FIELDS 五要素：存在性 + 类型。「空缺」= 键缺失/类型不符；空数组对
 *      allowed_paths/forbidden 是合法表达（验收组不改代码 → 空可写范围），scs_inline/verify_cmds
 *      空数组视为空缺；
 *   ② scs_inline id 契约（非空字符串 + 无重复，F-J）；
 *   ③ needs_three_review 布尔 exact 契约（pr-submit-gate 门禁透传：缺失/非布尔一律拒，
 *      缺省即拒，禁止默认成 false——默认 false 会让功能 PR 悄悄绕过 submit-pr 三审门禁）。
 * 任一条不过 → PACKET_INCOMPLETE（exit 2 点名）。
 */
function assertPacketComplete(packet, what) {
  for (const field of PACKET_REQUIRED_FIELDS) {
    const v = packet[field];
    if (v === undefined || v === null) {
      throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.${field} 空缺（fail-closed，缺一不开跑）`);
    }
    if (field === 'scs_inline' && (!Array.isArray(v) || v.length === 0)) {
      throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.scs_inline 必须是非空数组`);
    }
    if (field === 'verify_cmds' && (!Array.isArray(v) || v.length === 0)) {
      throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.verify_cmds 必须是非空数组`);
    }
    if ((field === 'allowed_paths' || field === 'forbidden') && !Array.isArray(v)) {
      throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.${field} 必须是数组（空数组合法）`);
    }
    if (field === 'submit_format' && (typeof v !== 'string' || v.trim().length === 0)) {
      throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.submit_format 必须是非空字符串`);
    }
  }
  assertPacketScIds(packet, what); // F-J：id 契约（出包/交卷/init 三道关共用同一份实现）
  if (typeof packet.needs_three_review !== 'boolean') {
    const shown = packet.needs_three_review === undefined ? '缺失' : JSON.stringify(packet.needs_three_review);
    throw new LedgerError(
      'PACKET_INCOMPLETE',
      `${what}：packet.needs_three_review 必须是布尔（true=功能 PR 交付后须走 submit-pr 三审 / false=非功能性免三审）；当前: ${shown}（fail-closed，禁止默认成 false）`
    );
  }
}

/**
 * manifest 顶层 exact 在场契约（init 入口一次性校验，失败不写台账）：
 *   dispatch 键必须在场且是含非空 packets 数组的对象；receipts 的在场契约已收口到 readManifest
 *   （唯一判据唯一入口，init 与全部后继消费命令统一要求——本函数不重复校验，防多份拷贝漂移）；
 *   waves 的非空数组检查在 initLedger 内既有逻辑。
 *   每个 dispatch.packets[] 过 assertPacketComplete（与 render-packet 同一份判据）。
 */
function assertManifestComplete(manifest) {
  if (!('dispatch' in manifest)) {
    throw new LedgerError('MANIFEST', 'manifest 缺 dispatch 键（顶层要素 exact 在场契约，fail-closed 不开跑）');
  }
  const dispatch = manifest.dispatch;
  if (dispatch === null || typeof dispatch !== 'object' || Array.isArray(dispatch)) {
    throw new LedgerError('MANIFEST', 'manifest.dispatch 必须是对象');
  }
  if (!Array.isArray(dispatch.packets) || dispatch.packets.length === 0) {
    throw new LedgerError('MANIFEST', 'manifest.dispatch.packets 必须是非空数组（禁止空派工计划，fail-closed 不开跑）');
  }
  for (const packet of dispatch.packets) {
    if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
      throw new LedgerError('MANIFEST', 'manifest.dispatch.packets 元素必须是对象');
    }
    const gid = typeof packet.group_id === 'string' && packet.group_id.length > 0 ? packet.group_id : '<未命名>';
    assertPacketComplete(packet, `packet(${gid}) init 校验`);
  }
}

// ---------- init：从 task-manifest.json 派生台账 ----------
// baseline（sc-p0a 基线漂移闸）：函数层必填参数（undefined 即拒——in-process 调用漏传
// 与 CLI 同判据）；null = 兼容模式（e2e-dryrun 等无基线语义的旧路径，基线闸/快照闸/凭证闸
// 全部跳过）；40hex = 严格模式（三道新闸全强制）。
export function initLedger({ ledgerPath, manifestPath, runId, now, baseline }) {
  requireNow(now, 'init');
  if (!manifestPath) throw new LedgerError('ARGS', 'init 缺 --manifest <path>');
  if (!runId) throw new LedgerError('ARGS', 'init 缺 --run-id <id>');
  if (baseline === undefined) {
    throw new LedgerError('ARGS', 'init 缺 --baseline <sha>（sc-p0a 必填：init 基线 SHA，40hex；仅 e2e 兼容路径允许显式传 null）');
  }
  if (baseline !== null && !TIP_SHA_RE.test(baseline)) {
    throw new LedgerError('ARGS', `init --baseline 非 40 位十六进制: ${baseline}`);
  }
  const manifest = readManifest(manifestPath);
  // 顶层三要素 + 逐 packet 完整性在 init 入口一次性校验（SKILL.md ② 段「缺任一 → 不开跑」）。
  // 校验失败不写台账——连空台账都不留（不能「先开跑、出包时才炸」，中间态污染状态机）。
  assertManifestComplete(manifest);
  if (!Array.isArray(manifest.waves) || manifest.waves.length === 0) {
    throw new LedgerError('MANIFEST', 'manifest.waves 必须是非空数组（禁止空波次计划，F-E fail-closed）');
  }
  // 波次编号唯一 + 严格升序（manifest 边界 fail-closed）：wave 编号是计划语义键，前波/后波、
  // 「最新已集成」全部按数值定义——重复 wave 无消歧可言，乱序 wave 则是异源/手写台账信号
  // （消费侧已全部按数值读取：前波 wave<、派工前沿 wave min、最新已集成 wave max，乱序不再
  // 静默错位）。init 是唯一合法建台账路径，入口即拒（点名词对），台账级 schema 只拒重复不拒
  // 乱序（见 assertLedgerSchema 注：乱序台账必须可载入，数值语义消费侧防御才有对照用例可测）。
  const seenWaveNums = new Set();
  let prevWaveNum = -1;
  for (const w of manifest.waves) {
    if (!Number.isSafeInteger(w.wave) || w.wave < 0) {
      throw new LedgerError('MANIFEST', `wave.wave 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}），当前: ${w.wave}`);
    }
    if (seenWaveNums.has(w.wave)) {
      throw new LedgerError('MANIFEST', `manifest.waves 含重复 wave 编号: ${w.wave}（同一波次出现两次，语义非法，fail-closed 拒）`);
    }
    if (w.wave <= prevWaveNum) {
      throw new LedgerError('MANIFEST', `manifest.waves 乱序: wave ${prevWaveNum} 之后出现 wave ${w.wave}（要求按 wave 数值严格升序，fail-closed 拒）`);
    }
    seenWaveNums.add(w.wave);
    prevWaveNum = w.wave;
  }
  // waves/groups/sc_ids 原样映射（不重算分组）；manifest_core_hash 原样复制（validate 才现算比对）
  const waves = manifest.waves.map((w) => {
    if (!Array.isArray(w.groups) || w.groups.length === 0) {
      throw new LedgerError('MANIFEST', `wave ${w.wave} 的 groups 必须是非空数组（禁止空波次，F-E fail-closed）`);
    }
    return {
      wave: w.wave,
      integrated_tip: null, // 集成前 null；本波全组 accepted 后只记合并顺序，真正 merge 由 lead 执行
      groups: w.groups.map((g) => {
        if (!Array.isArray(g.sc_ids) || g.sc_ids.length === 0) {
          throw new LedgerError('MANIFEST', `wave ${w.wave} 的组 ${g.group_id} 缺少 sc_ids 数组或为空（禁止空 SC 集，F-E fail-closed）`);
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
          // 身份：worktree/branch/base + session_id/title；create 后经 --identity 一次写齐
          worktree: null,
          branch: null,
          base: null,
          session_id: null,
          title: null,
          pr_url: null,
          provider_id: null,
          // 派发代际计数器（sc-p0c）：init 时赋 0，failed→pending 重派递增 +1
          assignment_seq: 0,
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
    phase: 'splitting', // run 级起步：拆 PR
    baseline_tip: baseline, // sc-p0a：init 基线（40hex=严格模式 / null=兼容模式）
    mini_watch_config_sha256: miniWatchConfigSha256(), // init 当下盯梢配置闸；watch_registered 三方等值
    waves,
    events: [],
  };
  assertLedgerSchema(ledger);
  // 新台账直接原子落盘（无旧内容可比，无 CAS 对手）；写盘中断 → 只有 tmp 残留，主文件不出现。
  // 存在性复查 + 写盘放锁内（F-C 同源竞态：两个并发 init 若都过了外部 existsSync，
  // 后 rename 者会静默覆盖先者——锁内复查把并发 init 串行化）
  const lockPath = acquireLedgerLock(ledgerPath);
  try {
    if (existsSync(ledgerPath)) {
      throw new LedgerError('ALREADY_EXISTS', `台账已存在，拒绝覆盖（${ledgerPath}）；如需重建先移走旧台账`);
    }
    writeTmp(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    renameTmp(ledgerPath);
  } finally {
    releaseLedgerLock(lockPath);
  }
  return ledger;
}

// ---------- validate：重读 manifest 现算 core hash 与台账比对 ----------
export function validateLedger({ ledgerPath }) {
  const ledger = readLedger(ledgerPath);
  const manifest = readManifest(ledger.manifest_path);
  const computed = assertManifestBound(ledger, manifest, 'validate');
  return { ledger, computed };
}

// ---------- set-state ----------
const GROUP_TRANSITIONS = Object.freeze({
  pending: ['dispatched', 'failed'],
  dispatched: ['executing', 'blocked', 'failed'],
  executing: ['blocked', 'e2e', 'failed'],
  blocked: ['executing', 'failed'],
  e2e: ['review', 'failed'],
  review: ['accepted', 'failed'],
  accepted: ['pr-open', 'failed'],
  'pr-open': ['local-cleaned', 'failed'],
  'local-cleaned': ['archived', 'failed'],
  archived: [],
  failed: ['pending'],
});

// phase 单向前进（波次顺序门 F-E）：→accepting 及后续 phase 要求——
//   ① 所有前波已 integrated（integrated_tip != null；只记合并顺序，真正 merge 由 lead 执行）；
//   ② 当前波非空且全组 pr-open 或 accepted；
//   →ready 额外要求全部组 accepted + 全部波已记录合并顺序。
// →ready 的凭据 = ready-check 写入的 receipt（见 READY_RECEIPT_KEYS 契约），此处只查波次前置。
// 返回 null = 允许；返回字符串 = 拒绝原因（非法跳转/缺失前置）。
function phaseTransitionAllowed(ledger, targetPhase) {
  const idx = PHASE_ORDER.indexOf(ledger.phase);
  const targetIdx = PHASE_ORDER.indexOf(targetPhase);
  if (targetIdx !== idx + 1) {
    return `phase 非法跳转：${ledger.phase} → ${targetPhase}（须依次经过 ${PHASE_ORDER.slice(idx + 1, targetIdx).join(' → ') || '无'} 前进）`;
  }
  if (targetIdx >= PHASE_ORDER.indexOf('accepting')) {
    // 本波 = wave 数值最大的包含非 pending 组的 wave（run 逐波推进，派过工的波才算在途；
    // 全 pending 时取 wave 数值最小的波——此时前置天然不满足，fail-closed）。
    const activeCandidates = ledger.waves.filter((w) => w.groups.some((g) => g.state !== 'pending'));
    const activeWave = activeCandidates.length > 0
      ? activeCandidates.reduce((max, w) => (w.wave > max.wave ? w : max))
      : (ledger.waves.length > 0
        ? ledger.waves.reduce((min, w) => (w.wave < min.wave ? w : min))
        : undefined);
    if (!activeWave) {
      return `缺失前置：→${targetPhase} 要求存在在途波（waves 为空，F-E fail-closed）`;
    }
    const unintegratedPrev = ledger.waves
      .filter((w) => w.wave < activeWave.wave && w.integrated_tip === null);
    if (unintegratedPrev.length > 0) {
      return `缺失前置：→${targetPhase} 要求所有前波已记录合并顺序，未记录前波: wave ${unintegratedPrev.map((w) => w.wave).join(', ')}`;
    }
    const allAccepted = activeWave.groups.every((g) => (
      g.state === 'accepted' || g.state === 'pr-open' || g.state === 'local-cleaned' || g.state === 'archived'
    ));
    if (!allAccepted) {
      return `缺失前置：→${targetPhase} 要求当前波全组 accepted 或之后的收尾态（当前未满足）`;
    }
    if (targetPhase === 'ready') {
      const notAccepted = ledger.waves.flatMap((w) => w.groups).filter((g) => (
        g.state !== 'accepted' && g.state !== 'pr-open' && g.state !== 'local-cleaned' && g.state !== 'archived'
      ));
      if (notAccepted.length > 0) {
        return `缺失前置：→ready 要求全部组至少 accepted，未 accepted: ${notAccepted.map((g) => g.group_id).join(', ')}`;
      }
      const unintegratedAll = ledger.waves.filter((w) => w.integrated_tip === null);
      if (unintegratedAll.length > 0) {
        return `缺失前置：→ready 要求全部波已记录合并顺序（真正 merge 由 lead 执行），未记录: wave ${unintegratedAll.map((w) => w.wave).join(', ')}`;
      }
    }
  }
  return null;
}

// ---------- →ready receipt（F-F：ready-check 写入的不可伪造凭据，run-ledger 只消费不生产） ----------
// 消费契约（ready-check 侧需配合写入，lead 集成时接入）：
//   ready-check.mjs 在七项检查全过（exit 0）时，原子写入 receipt 文件（tmp+rename 防半写）：
//     推荐路径：<ledgerPath>.ready-receipt.json
//     内容（exact schema，未知键拒，缺一不可）：
//       { "candidate_sha": "<40hex，检查通过的目标树 SHA>",
//         "ledger_version": <非负整数，检查时台账 version>,
//         "checked_at": "<非空字符串时间戳>" }
//   run-ledger 消费规则（set-state --phase ready 时）：
//     1. CLI 必须显式携带 --ready-receipt <path>（缺省拒；--ready-check-exit0 布尔凭据已移除）。
//     2. receipt 解析成功 + exact 键契约 + candidate_sha 40hex + ledger_version 非负整数
//        （文件不可读/形状不符 → READY_RECEIPT，等同参数错误，不落事件）。
//     3. receipt.ledger_version 必须 == 当前台账 version：检查后任何写操作都会使 version +1，
//        receipt 即失效（防重放：旧 receipt 不能驱动新一轮 ready）。
//     4. receipt.candidate_sha 必须 == 台账当前最新集成 tip（全波已集成时的最终树；
//        校验不过 → PRECONDITION 拒 + 落 illegal_transition 事件）。
//     5. 校验全过才允许 phase→ready；通过后台账冻结（既有逻辑，只读）。
//   测试用夹具模拟 receipt 文件即可（writeFileSync 后经 CLI --ready-receipt 传入）。
const READY_RECEIPT_KEYS = Object.freeze(['candidate_sha', 'ledger_version', 'checked_at']);
export const PR_RECEIPT_KEYS = Object.freeze([
  'pr_id', 'session_id', 'candidate_sha', 'pr_url', 'e2e_status',
  'review_unresolved', 'size_result', 'ledger_version', 'checked_at',
]);
export const PR_OPEN_RECEIPT_KEYS = Object.freeze([
  'url', 'number', 'headRefOid', 'isDraft', 'state', 'branch', 'checked_at',
  'ledger_version', 'assignment_seq',
]);
export const CLEANUP_RECEIPT_KEYS = Object.freeze([
  'ok', 'skipped', 'branch', 'worktree', 'sha', 'remoteDeleted', 'checked_at',
  'ledger_version', 'assignment_seq',
]);
export const ARCHIVE_RECEIPT_KEYS = Object.freeze([
  'session_id', 'archived', 'checked_at', 'ledger_version', 'assignment_seq',
]);
export const WATCH_RECEIPT_KEYS = Object.freeze([
  'ok', 'owner', 'repo', 'pr_number', 'branch', 'state_file', 'session_id',
  'checked_at', 'ledger_version', 'assignment_seq', 'mini_watch_config_sha256',
]);
const GOAL_SKILL_PATHS = Object.freeze([
  '/Users/praise/.agents/skills/goal/SKILL.md',
  '/Users/praise/.claude/skills/goal/SKILL.md',
  '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/goal/SKILL.md',
]);
const ROUTING_PATH_LIVE = '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json';
const ROUTING_PATH_LINK = '/Users/praise/.agents/skills/orca-fanout/routing.json';
const PR_HANDOFF_DELIVERY_KEYS = Object.freeze([
  'branch', 'tip_sha', 'scs', 'goal_skill_path', 'e2e', 'review', 'size_gate',
]);
const PR_HANDOFF_E2E_KEYS = Object.freeze(['status', 'candidate_sha', 'model', 'route_source']);
const PR_HANDOFF_REVIEW_KEYS = Object.freeze(['unresolved', 'candidate_sha', 'model', 'route_source']);
const PR_HANDOFF_SIZE_KEYS = Object.freeze(['result', 'candidate_sha']);
const PR_HANDOFF_SC_KEYS = Object.freeze(['id', 'status']);

/** 读取 + exact 校验 receipt（文件级/形状级错误 → READY_RECEIPT；语义绑定由调用方对台账校验）。 */
export function readReadyReceipt(receiptPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (err) {
    throw new LedgerError('READY_RECEIPT', `→ready receipt 读取/解析失败（${receiptPath}）: ${err.message}`);
  }
  assertKeys(parsed, READY_RECEIPT_KEYS, '→ready receipt');
  if (typeof parsed.candidate_sha !== 'string' || !TIP_SHA_RE.test(parsed.candidate_sha)) {
    throw new LedgerError('READY_RECEIPT', '→ready receipt.candidate_sha 非 40 位十六进制');
  }
  if (!Number.isSafeInteger(parsed.ledger_version) || parsed.ledger_version < 0) {
    throw new LedgerError('READY_RECEIPT', `→ready receipt.ledger_version 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}，与台账 version 的 == 比对在超出安全范围时无法区分版本），当前: ${parsed.ledger_version}`);
  }
  if (typeof parsed.checked_at !== 'string' || parsed.checked_at.length === 0) {
    throw new LedgerError('READY_RECEIPT', '→ready receipt.checked_at 必须是非空字符串');
  }
  return parsed;
}

function readExactReceipt(receiptPath, keys, what) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (err) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what} 读取/解析失败（${receiptPath}）: ${err.message}`);
  }
  try {
    assertKeys(parsed, keys, what);
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'SCHEMA') {
      throw new LedgerError('WRAPUP_RECEIPT', err.message);
    }
    throw err;
  }
  parseTimestamp(parsed.checked_at, `${what}.checked_at`);
  if (!Number.isSafeInteger(parsed.ledger_version) || parsed.ledger_version < 0) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what}.ledger_version 必须是非负安全整数（当前: ${parsed.ledger_version}）`);
  }
  if (!Number.isSafeInteger(parsed.assignment_seq) || parsed.assignment_seq < 0) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what}.assignment_seq 必须是非负安全整数（当前: ${parsed.assignment_seq}）`);
  }
  return parsed;
}

function githubIdentityFromUrl(url) {
  const m = typeof url === 'string' ? url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/) : null;
  if (!m) return null;
  return { owner: m[1], repo: m[2], pr_number: Number(m[3]) };
}

function assertReceiptBoundToLedger(receipt, ledger, group, what) {
  const g = findGroup(ledger, group);
  if (receipt.ledger_version > ledger.version) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what}.ledger_version=${receipt.ledger_version} 大于当前台账 version=${ledger.version}（未来回执拒）`);
  }
  if (receipt.assignment_seq !== (g.assignment_seq ?? 0)) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what}.assignment_seq=${receipt.assignment_seq} 对不上组 assignment_seq=${g.assignment_seq ?? 0}`);
  }
}

function assertReceiptAfterEvent(receipt, ledger, group, eventType, what) {
  const ev = latestGroupEvent(ledger, group, eventType);
  if (!ev) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what} 要求本组成立的 ${eventType}`);
  }
  const receiptMs = parseTimestamp(receipt.checked_at, `${what}.checked_at`);
  const eventMs = parseTimestamp(ev.at, `${eventType}.at`);
  if (receiptMs <= eventMs) {
    throw new LedgerError('WRAPUP_RECEIPT', `${what}.checked_at=${receipt.checked_at} 不得早于或等于 ${eventType}.at=${ev.at}`);
  }
}

export function readPrOpenReceipt(receiptPath) {
  const parsed = readExactReceipt(receiptPath, PR_OPEN_RECEIPT_KEYS, '→pr-open receipt');
  if (typeof parsed.url !== 'string' || !GITHUB_PR_URL_RE.test(parsed.url)) {
    throw new LedgerError('WRAPUP_RECEIPT', `→pr-open receipt.url 非法（当前: ${parsed.url ?? '缺失'}）`);
  }
  if (parsed.state !== 'OPEN') {
    throw new LedgerError('WRAPUP_RECEIPT', `→pr-open receipt.state 必须是 OPEN（当前: ${parsed.state}）`);
  }
  if (parsed.isDraft !== false) {
    throw new LedgerError('WRAPUP_RECEIPT', '→pr-open receipt.isDraft 必须是 false（验收后不得仍是 draft）');
  }
  if (!Number.isSafeInteger(parsed.number) || parsed.number <= 0) {
    throw new LedgerError('WRAPUP_RECEIPT', `→pr-open receipt.number 必须是正整数（当前: ${parsed.number}）`);
  }
  const urlNumber = Number(parsed.url.match(/\/pull\/(\d+)/)[1]);
  if (urlNumber !== parsed.number) {
    throw new LedgerError('WRAPUP_RECEIPT', `→pr-open receipt.number=${parsed.number} 对不上 URL #${urlNumber}`);
  }
  if (typeof parsed.headRefOid !== 'string' || !TIP_SHA_RE.test(parsed.headRefOid)) {
    throw new LedgerError('WRAPUP_RECEIPT', '→pr-open receipt.headRefOid 非 40 位十六进制');
  }
  if (typeof parsed.branch !== 'string' || parsed.branch.length === 0) {
    throw new LedgerError('WRAPUP_RECEIPT', '→pr-open receipt.branch 必须是非空字符串');
  }
  return parsed;
}

export function readCleanupReceipt(receiptPath) {
  const parsed = readExactReceipt(receiptPath, CLEANUP_RECEIPT_KEYS, '→local-cleaned receipt');
  if (parsed.ok !== true) {
    throw new LedgerError('WRAPUP_RECEIPT', `→local-cleaned receipt.ok 必须是 true（当前: ${parsed.ok}）`);
  }
  if (parsed.skipped !== false) {
    throw new LedgerError('WRAPUP_RECEIPT', '→local-cleaned receipt.skipped 必须是 false（跳过删除不得入账）');
  }
  if (parsed.remoteDeleted !== false) {
    throw new LedgerError('WRAPUP_RECEIPT', '→local-cleaned receipt.remoteDeleted 必须是 false（禁止删远端）');
  }
  if (typeof parsed.branch !== 'string' || parsed.branch.length === 0) {
    throw new LedgerError('WRAPUP_RECEIPT', '→local-cleaned receipt.branch 必须是非空字符串');
  }
  if (typeof parsed.worktree !== 'string' || !parsed.worktree.startsWith('/')) {
    throw new LedgerError('WRAPUP_RECEIPT', '→local-cleaned receipt.worktree 必须是绝对路径');
  }
  if (typeof parsed.sha !== 'string' || !TIP_SHA_RE.test(parsed.sha)) {
    throw new LedgerError('WRAPUP_RECEIPT', '→local-cleaned receipt.sha 非 40 位十六进制');
  }
  return parsed;
}

export function readArchiveReceipt(receiptPath) {
  const parsed = readExactReceipt(receiptPath, ARCHIVE_RECEIPT_KEYS, '→archived receipt');
  if (parsed.archived !== true) {
    throw new LedgerError('WRAPUP_RECEIPT', `→archived receipt.archived 必须是 true（当前: ${parsed.archived}）`);
  }
  if (typeof parsed.session_id !== 'string' || parsed.session_id.length === 0) {
    throw new LedgerError('WRAPUP_RECEIPT', '→archived receipt.session_id 必须是非空字符串');
  }
  return parsed;
}

export function readWatchReceipt(receiptPath) {
  const parsed = readExactReceipt(receiptPath, WATCH_RECEIPT_KEYS, 'watch_registered receipt');
  if (parsed.ok !== true) {
    throw new LedgerError('WRAPUP_RECEIPT', `watch_registered receipt.ok 必须是 true（当前: ${parsed.ok}）`);
  }
  for (const k of ['owner', 'repo', 'branch', 'state_file']) {
    if (typeof parsed[k] !== 'string' || parsed[k].length === 0) {
      throw new LedgerError('WRAPUP_RECEIPT', `watch_registered receipt.${k} 必须是非空字符串`);
    }
  }
  if (!parsed.state_file.startsWith('/')) {
    throw new LedgerError('WRAPUP_RECEIPT', 'watch_registered receipt.state_file 必须是 Mini 绝对路径');
  }
  if (!Number.isSafeInteger(parsed.pr_number) || parsed.pr_number <= 0) {
    throw new LedgerError('WRAPUP_RECEIPT', `watch_registered receipt.pr_number 必须是正整数（当前: ${parsed.pr_number}）`);
  }
  if (parsed.session_id !== null) {
    throw new LedgerError('WRAPUP_RECEIPT', 'watch_registered receipt.session_id 必须是 null（盯梢会话由 Mini 首次信号 create，不是本机代填）');
  }
  if (typeof parsed.mini_watch_config_sha256 !== 'string' || !SHA256_RE.test(parsed.mini_watch_config_sha256)) {
    throw new LedgerError('WRAPUP_RECEIPT', `watch_registered receipt.mini_watch_config_sha256 必须是 64 位十六进制（当前: ${parsed.mini_watch_config_sha256}）`);
  }
  return parsed;
}

/** 台账当前最新集成 tip = wave 数值最大的已集成 wave 的 tip（全波集成时 = 最终树）。
 *  按数值取不依赖数组顺序（同族：waves 有序性无处强制，末位 ≠ 数值最新；重复 wave 已由 schema 拒）。 */
export function latestIntegratedTip(ledger) {
  const integrated = ledger.waves.filter((w) => w.integrated_tip !== null);
  if (integrated.length === 0) return null;
  return integrated.reduce((max, w) => (w.wave > max.wave ? w : max)).integrated_tip;
}

// ---------- sc-p0a：基线漂移闸（单一判据 + 双点消费） ----------
// 期望基线的单一判据函数：有已集成波 → 最新集成点（wave 数值最大，按数值不按数组位置）；
// 无已集成波 → init 基线 baseline_tip（null = 兼容模式，无基线可比）。
// 双点消费（set-state --identity 写入、render-packet 出包）只允许经本函数取值，
// 同一判据两份实现必然漂移——两处比对都必须过 expectedBase(ledger)。
export function expectedBase(ledger) {
  return expectedBaseInfo(ledger).base;
}

/** expectedBase 的值 + 来源（错误消息点名「期望值来源」用：wave N 集成点 / init 基线）。 */
export function expectedBaseInfo(ledger) {
  const integrated = ledger.waves.filter((w) => w.integrated_tip !== null);
  if (integrated.length > 0) {
    const max = integrated.reduce((a, b) => (b.wave > a.wave ? b : a));
    return { base: max.integrated_tip, source: `wave ${max.wave} 集成点` };
  }
  return { base: ledger.baseline_tip, source: 'init 基线' };
}

/** 严格模式 = init 时注入了基线（baseline_tip 非 null）：
 *  基线闸/快照闸/凭证闸三道新闸全部强制；null（兼容模式，e2e-dryrun 等无基线语义旧路径）跳过。
 *  兼容模式的判定锚点是 baseline_tip 而非 expectedBase：e2e 在 wave 集成后 expectedBase 也非 null，
 *  但它的派工流程（dispatched 先于 render-packet）不满足新闸时序，必须全程不启用。 */
export function isStrictMode(ledger) {
  return ledger.baseline_tip !== null;
}

/** 组身份 digest（sc-p0c）：长度前缀编码防拼接歧义——裸 '|' 拼接下
 *  "ab|cd" 与 "a|bcd" 碰撞，长度前缀把每段边界钉死。
 *  输入段顺序（与 SKILL ⑨ 字面一致）：seq → worktree → branch → base → session_id。
 *  session_id 未定时用空串（出包在 create 之前）；create 后 --identity 写入真实 id。 */
export function identityDigest({ worktree, branch, base, session_id, assignmentSeq }) {
  const seq = String(assignmentSeq);
  const sid = session_id == null ? '' : String(session_id);
  const wt = worktree == null ? '' : String(worktree);
  const br = branch == null ? '' : String(branch);
  const bs = base == null ? '' : String(base);
  const canonical = `${seq.length}:${seq}:${wt.length}:${wt}:${br.length}:${br}:${bs.length}:${bs}:${sid.length}:${sid}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16);
}

/** 组最近一条 packet_rendered 事件（无则 null）。凭证闸消费：取最近一条（身份可能多次出包）。 */
export function latestPacketRendered(ledger, groupId) {
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const ev = ledger.events[i];
    if (ev.type === 'packet_rendered' && ev.detail?.group_id === groupId) return ev;
  }
  return null;
}

/** 组最近一条指定 type 事件（无则 null）。开工闸 / 交卷前置消费。
 *  代际隔离：组对象带 assignment_seq 时，只认 detail.assignment_seq 同代的事件。 */
export function latestGroupEvent(ledger, groupId, type) {
  const g = findGroup(ledger, groupId);
  const seq = g?.assignment_seq;
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const ev = ledger.events[i];
    if (ev.type !== type || ev.detail?.group_id !== groupId) continue;
    if (seq !== undefined && ev.detail?.assignment_seq !== seq) continue;
    return ev;
  }
  return null;
}

/** 组最近一条 candidate 交卷（无则 null）。→accepted 前置消费。同代才算。 */
export function latestPrHandoffDelivery(ledger, groupId) {
  const g = findGroup(ledger, groupId);
  const seq = g?.assignment_seq;
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const ev = ledger.events[i];
    if (ev.type !== 'delivery' || ev.detail?.group_id !== groupId) continue;
    if (!(ev.detail?.e2e && ev.detail?.review && ev.detail?.size_gate && ev.detail?.branch && ev.detail?.tip_sha)) continue;
    if (ev.detail?.pr_url) continue;
    if (seq !== undefined && ev.detail?.assignment_seq !== seq) continue;
    return ev.detail;
  }
  return null;
}

// ---------- sc-p0b：派发内存快照（--mem-snapshot）四键 exact 契约 ----------
// 快照由 lead 侧从 mem-probe --json 的 9 键输出中提取四键构造（mem-probe 另含
// page_size/total_bytes/per_worker_bytes/reserve_ratio/pending_groups 五键，原样直喂
// 必因未知键被拒——提取责任在 lead 侧，SKILL.md 检查单第 5 步写明）。
const MEM_SNAPSHOT_KEYS = Object.freeze(['used_slots', 'platform_cap', 'concurrency', 'available_bytes']);

/** 快照校验（CLI 与导出函数共用同一判据）：exact 四键 + 全非负安全整数 +
 *  concurrency<=platform_cap + used_slots<=platform_cap（自相矛盾输入必须拒——
 *  computeConcurrency 仅对 usedSlots 过 assertNonNegInt 不查上限，这里补跨字段一致性）。 */
export function assertMemSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new LedgerError('ARGS', '--mem-snapshot 必须是 JSON 对象（四键 used_slots/platform_cap/concurrency/available_bytes）');
  }
  assertKeys(snapshot, MEM_SNAPSHOT_KEYS, '--mem-snapshot');
  for (const k of MEM_SNAPSHOT_KEYS) {
    const v = snapshot[k];
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new LedgerError('ARGS', `--mem-snapshot.${k} 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}，当前: ${JSON.stringify(v)}）`);
    }
  }
  if (snapshot.concurrency > snapshot.platform_cap) {
    throw new LedgerError(
      'ARGS',
      `--mem-snapshot 跨字段自相矛盾：concurrency=${snapshot.concurrency} > platform_cap=${snapshot.platform_cap}（并发数不得超过平台槽位上限，拒绝派发）`
    );
  }
  if (snapshot.used_slots > snapshot.platform_cap) {
    throw new LedgerError(
      'ARGS',
      `--mem-snapshot 跨字段自相矛盾：used_slots=${snapshot.used_slots} > platform_cap=${snapshot.platform_cap}（占用槽位不得超过平台上限，拒绝派发）`
    );
  }
  return snapshot;
}

/**
 * 非法尝试统一收口：先落 illegal_transition 事件（原子写盘），再抛 LedgerError。
 * 「每次非法尝试都留 events 记录」+「exit 2 点名」两者都要——事件写盘发生在
 * throw 之前（writeLedgerAtomic 内 throw 会导致事件不落盘，故先写后抛）。
 */
function rejectWithEvent({ ledgerPath, expected, now, group, reason, code, message }) {
  writeLedgerAtomic(ledgerPath, expected, (cur) => {
    // 组级拒绝带真实 group_id；相位级拒绝无组上下文 → group_id: null（不伪造组归属）
    cur.events.push({ type: 'illegal_transition', at: now, detail: { group_id: group ?? null, reason } });
    return { ...cur, version: expected + 1 };
  });
  throw new LedgerError(code, message);
}

/**
 * 组级可写性守卫（① 修复点）：非状态写入口之一——身份写入（--identity）。
 * 只允许 pending 态：组一旦 dispatched 及之后，身份写入一律拒——派发后改身份会让
 * 台账审计成新身份，而唯一 packet_rendered 凭证仍是旧身份的 identity_digest。
 * 收紧为 pending-only 后自然覆盖 accepted 终态。重派链 failed→pending 清空身份
 * + assignment_seq+1 回到 pending 后方可重写身份（代际隔离天然接续）。
 * 与 rejectWithEvent 不同：拒写不落事件（纯 throw）——验收口径要求被拒后台账字节不变
 * （同 phase=ready 冻结的 FROZEN 路径：冻结后不落事件）。
 */
function assertGroupWritable(g, what) {
  if (g.state !== 'pending') {
    throw new LedgerError(
      'ILLEGAL_TRANSITION',
      `组 ${g.group_id} 当前 ${g.state}，身份只能在 pending 写入（变更身份须先 failed→pending 重派；派发后组身份只读，重放攻击拒），拒绝${what}`
    );
  }
}

// ① 升级（方向 B）：交卷生命周期表——每类交卷只允许在其对应组阶段入账。
// 与现有状态机核对结论（含 e2e-dryrun 真实验收链，逐条验证后修正）：
//   exec  （写 tip_sha）   ：worker 在 dispatched 时交卷（lead 尚未标 delivered）；
//                           重派链 failed→pending→dispatched 后同样要能重新交卷 → dispatched/delivered
//   review（写 rounds/unresolved）：审查在组 delivered 后（tip_sha 已定，detail.tip_sha 才有绑定对象）→ 仅 delivered
//   verify（写 status/evidence_ref）：执行组在 review_pass 时交卷（→verified 凭据时点）；
//                           验收组（kind=verify）在 delivered 后立即出 verdict 是其交付物
//                           （e2e-dryrun verifyGroupToVerified：delivered → verify 交卷 → review_pass → verified）→ delivered/review_pass
// 方向 B 漏洞：pending 组可先提交合法 verify payload（evidence_ref 指向真实存在的 delivery 事件，
// 存在性校验挡不住），随后状态机一路走绿——验收证据可在组派工前预写。
// 故校验必须从「事件存在性」升级为「时序合法性」：类别 × 组状态矩阵，verified/failed 一律拒。
const DELIVERY_LIFECYCLE = Object.freeze({
  exec: ['dispatched', 'executing'],
  review: ['e2e', 'review'],
  verify: ['review', 'accepted'],
  // prewalk：只允许 dispatched；入账不改组状态。组级次数/波 0 门在 recordDelivery 锁内另判。
  prewalk: ['dispatched'],
  'pr-handoff': ['review'],
});

export function noteEvent({ ledgerPath, now, event, detail }) {
  requireNow(now, 'note-event');
  if (!NOTE_EVENT_TYPES.includes(event)) {
    throw new LedgerError('ARGS', `note-event --event 必须是 ${NOTE_EVENT_TYPES.join('/')}（收到: ${event ?? '无'}）`);
  }
  let parsed;
  try {
    parsed = typeof detail === 'string' ? JSON.parse(detail) : detail;
  } catch (err) {
    throw new LedgerError('ARGS', `--detail 不是合法 JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerError('ARGS', '--detail 必须是 JSON 对象');
  }
  const ledger = readLedger(ledgerPath);
  if (ledger.phase === 'ready' && event !== 'watch_registered') {
    throw new LedgerError('FROZEN', `台账已 ready（phase=${ledger.phase}），冻结只读，拒绝写操作`);
  }
  const expected = ledger.version;
  const ev = { type: event, at: now, detail: { ...parsed } };
  if (event === 'site_report' && !('group_id' in parsed)) {
    ev.detail.group_id = null;
  }
  if (event === 'replan_note' && !('group_id' in parsed) && typeof parsed.origin_group === 'string') {
    ev.detail.group_id = parsed.origin_group;
  }
  if (event === 'watch_registered') {
    if (typeof parsed.group_id !== 'string' || parsed.group_id.length === 0) {
      throw new LedgerError('ARGS', 'watch_registered 的 --detail.group_id 必须是非空字符串');
    }
    const g = findGroup(ledger, parsed.group_id);
    if (g.state !== 'pr-open') {
      throw new LedgerError('PRECONDITION', `watch_registered 只允许在 pr-open 入账（组 ${parsed.group_id} 当前 ${g.state}）`);
    }
    if (typeof parsed.pr_url !== 'string' || parsed.pr_url !== g.pr_url) {
      throw new LedgerError('PRECONDITION', `watch_registered.pr_url 必须等于组上已开的 GitHub URL`);
    }
    if (typeof parsed.receipt !== 'string' || parsed.receipt.length === 0) {
      throw new LedgerError('ARGS', 'watch_registered 必须携带 Mini register.mjs 成功回执（--detail.receipt <path>）');
    }
    const watchReceipt = readWatchReceipt(resolve(parsed.receipt));
    assertReceiptBoundToLedger(watchReceipt, ledger, parsed.group_id, 'watch_registered receipt');
    assertReceiptAfterEvent(watchReceipt, ledger, parsed.group_id, 'pr_opened', 'watch_registered receipt');
    const expectedId = githubIdentityFromUrl(g.pr_url);
    if (!expectedId) {
      throw new LedgerError('PRECONDITION', 'watch_registered 组 pr_url 解析不出 owner/repo/pr');
    }
    if (watchReceipt.owner !== expectedId.owner || watchReceipt.repo !== expectedId.repo || watchReceipt.pr_number !== expectedId.pr_number) {
      throw new LedgerError('PRECONDITION', `watch_registered receipt 身份不符（${watchReceipt.owner}/${watchReceipt.repo}#${watchReceipt.pr_number} ≠ ${expectedId.owner}/${expectedId.repo}#${expectedId.pr_number}）`);
    }
    if (typeof g.branch === 'string' && watchReceipt.branch !== g.branch) {
      throw new LedgerError('PRECONDITION', `watch_registered receipt.branch=${watchReceipt.branch} 对不上组分支 ${g.branch}`);
    }
    const liveHash = miniWatchConfigSha256();
    if (watchReceipt.mini_watch_config_sha256 !== ledger.mini_watch_config_sha256
      || watchReceipt.mini_watch_config_sha256 !== liveHash) {
      throw new LedgerError(
        'PRECONDITION',
        `watch_registered 盯梢配置闸三方不等值：receipt=${watchReceipt.mini_watch_config_sha256} ledger=${ledger.mini_watch_config_sha256} live=${liveHash}`,
      );
    }
    ev.detail.state_file = watchReceipt.state_file;
    ev.detail.owner = watchReceipt.owner;
    ev.detail.repo = watchReceipt.repo;
    ev.detail.pr_number = watchReceipt.pr_number;
    ev.detail.assignment_seq = g.assignment_seq ?? 0;
    delete ev.detail.receipt;
  }
  assertEventSchema(ev);
  return writeLedgerAtomic(ledgerPath, expected, (cur) => {
    cur.events.push(ev);
    return { ...cur, version: expected + 1 };
  });
}

export function setState({
  ledgerPath, now, group, to, workerLabel, tipSha, event, detail,
  identity, phase, wave, integrate, readyReceipt, memSnapshot,
  prOpenReceipt, cleanupReceipt, archiveReceipt,
}) {
  requireNow(now, 'set-state');
  const ledger = readLedger(ledgerPath);
  const wrapupAfterReady = ledger.phase === 'ready'
    && identity === undefined
    && phase === undefined
    && integrate === undefined
    && ['pr-open', 'local-cleaned', 'archived'].includes(to);
  if (ledger.phase === 'ready' && !wrapupAfterReady) {
    // ready 相位达成后台账冻结（只读）：验收后收尾（pr-open / local-cleaned / archived）例外
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
    const allowed = Object.freeze(['worktree', 'branch', 'base', 'session_id', 'title']);
    const required = Object.freeze(['worktree', 'branch', 'base']);
    const noWhitespace = Object.freeze(['worktree', 'branch', 'base', 'session_id']);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LedgerError('ARGS', '--identity 必须是 {worktree, branch, base, session_id?, title?} 对象');
    }
    for (const k of Object.keys(parsed)) {
      if (!allowed.includes(k)) {
        throw new LedgerError('ARGS', `--identity 含未列键: ${k}（只允许 worktree/branch/base/session_id/title）`);
      }
    }
    for (const k of required) {
      if (typeof parsed[k] !== 'string' || parsed[k].length === 0) {
        throw new LedgerError('ARGS', `--identity.${k} 必须是非空字符串`);
      }
    }
    for (const k of ['session_id', 'title']) {
      if (parsed[k] !== undefined && (typeof parsed[k] !== 'string' || parsed[k].length === 0)) {
        throw new LedgerError('ARGS', `--identity.${k} 必须是非空字符串`);
      }
    }
    for (const k of noWhitespace) {
      if (parsed[k] !== undefined && /\s/.test(parsed[k])) {
        throw new LedgerError('ARGS', `--identity.${k} 不得含空白字符: ${parsed[k]}`);
      }
    }
    if (!TIP_SHA_RE.test(parsed.base)) {
      throw new LedgerError('ARGS', `--identity.base 非 40 位十六进制: ${parsed.base}`);
    }
    // ④ 修复点：worktree 会原样渲染进派工包身份行（worktree=.. 被 goal 当作实际工作目录），
    // 相对路径会把执行带到解析者 cwd 下的意外位置——强制绝对路径。
    if (!isAbsolute(parsed.worktree)) {
      throw new LedgerError('ARGS', `--identity.worktree 必须是绝对路径（当前: ${parsed.worktree}）`);
    }
    // sc-p0a 基线漂移闸（消费点①）：identity.base 必须等于期望基线（最新集成点 ?? init 基线）。
    // 防止派工包的 base 与台账已集成树脱节——基线变了旧 base 的包不能落到旧树上干活。
    // 兼容模式（baseline_tip=null，无基线可比）跳过。错误消息含期望值、实得值、期望值来源。
    if (isStrictMode(ledger)) {
      const exp = expectedBaseInfo(ledger);
      if (parsed.base !== exp.base) {
        throw new LedgerError(
          'BASELINE_MISMATCH',
          `--identity.base=${parsed.base} 与期望基线 ${exp.base} 不一致（期望值来源：${exp.source}；组 ${group} 派工基线必须等于台账当前期望基线，基线漂移拒）`
        );
      }
    }
    // ① 修复点：verified 是组级终态，身份写入不得绕过状态机（终态组身份只读）。
    // 读侧先拒（早失败）；锁内复核兜底（读后写到锁内之间状态可能被并发改写，
    // 同一判据同一函数，两份调用不漂移）。
    assertGroupWritable(findGroup(ledger, group), '身份写入（--identity）');
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      const g = findGroup(cur, group);
      assertGroupWritable(g, '身份写入（--identity）'); // 锁内复核当前状态
      g.worktree = parsed.worktree;
      g.branch = parsed.branch;
      g.base = parsed.base;
      if (parsed.session_id !== undefined) g.session_id = parsed.session_id;
      if (parsed.title !== undefined) g.title = parsed.title;
      return { ...cur, version: expected + 1 };
    });
  }

  // ---- verify 字段写入口已移除（F-H）----
  // 历史：set-state --verify-status/--verify-evidence-ref 是绕过 record-delivery 的手工
  // 填数通道（与已修的 --unresolved 同类漏洞）。verify.status/evidence_ref 的唯一写入
  // 通道是验收组 record-delivery（verify 类交卷，evidence_ref=delivery#<n> 绑定事件）。
  // →verified 前置会校验 status=pass 且 evidence_ref 可解析（见 preconditionProblem）。

  // ---- wave 级集成：本波全组 verified 后写 integrated_tip ----
  if (integrate !== undefined) {
    if (wave === undefined) throw new LedgerError('ARGS', 'set-state --integrate 必须与 --wave <n> 一起使用');
    if (typeof integrate !== 'string' || !TIP_SHA_RE.test(integrate)) {
      throw new LedgerError('ARGS', `integrated_tip 非 40 位十六进制: ${integrate}`);
    }
    // ② 修复点：已知拒绝前置从 writeLedgerAtomic 回调内移出，转 rejectWithEvent——
    // 此前在回调内 throw 只 exit 2，事件不落盘、版本不前进（违背「每次非法尝试都留
    // events 记录」契约）。wave 级拒绝无组上下文 → group_id: null。NO_WAVE（wave 号
    // 根本不在台账里）是参数级错误，不属于状态机非法尝试，保持不落事件。
    const w = ledger.waves.find((x) => x.wave === wave);
    if (!w) throw new LedgerError('NO_WAVE', `台账中无 wave ${wave}`);
    if (w.integrated_tip !== null) {
      rejectWithEvent({
        ledgerPath, expected, now, group: null,
        reason: `wave ${wave} 已集成（integrated_tip=${w.integrated_tip}），不可重复集成（重放攻击拒）`,
        code: 'ILLEGAL_TRANSITION',
        message: `wave ${wave} 已集成（integrated_tip=${w.integrated_tip}），不可重复集成`,
      });
    }
    const allAccepted = w.groups.every((g) => g.state === 'accepted');
    if (!allAccepted) {
      const pending = w.groups.filter((g) => g.state !== 'accepted').map((g) => g.group_id);
      rejectWithEvent({
        ledgerPath, expected, now, group: null,
        reason: `缺失前置：wave ${wave} 记录合并顺序要求全组 accepted（真正 merge 由 lead 执行），未 accepted: ${pending.join(', ')}`,
        code: 'PRECONDITION',
        message: `缺失前置：wave ${wave} 记录合并顺序要求全组 accepted（真正 merge 由 lead 执行），未 accepted: ${pending.join(', ')}`,
      });
    }
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      const ww = cur.waves.find((x) => x.wave === wave);
      ww.integrated_tip = integrate;
      cur.events.push({
        type: 'integrate',
        at: now,
        // wave 级事件无组上下文：group_id 显式 null（schema 要求键存在，不伪造组归属）
        detail: { group_id: null, wave, integrated_tip: integrate },
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
    if (phase === 'ready') {
      // F-F：→ready 的唯一凭据 = ready-check 写入的 receipt（不可伪造：version 绑定 +
      // candidate_sha 绑定当前集成树）。CLI 布尔凭据（--ready-check-exit0）已移除。
      if (readyReceipt === undefined) {
        // 无凭据 = 非法尝试
        rejectWithEvent({
          ledgerPath, expected, now, group: null,
          reason: `phase 非法跳转 ${ledger.phase} → ready：缺失前置（无 ready-check receipt 凭据）`,
          code: 'PRECONDITION',
          message: '缺失前置：→ready 仅允许由 ready-check receipt 驱动（--ready-receipt <path> 未携带；--ready-check-exit0 布尔凭据已移除）',
        });
      }
      if (readyReceipt.ledger_version !== ledger.version) {
        rejectWithEvent({
          ledgerPath, expected, now, group: null,
          reason: `phase 非法跳转 ${ledger.phase} → ready：receipt ledger_version=${readyReceipt.ledger_version} ≠ 台账 version=${ledger.version}（检查后发生过写操作，receipt 失效，防重放）`,
          code: 'PRECONDITION',
          message: `缺失前置：→ready receipt 版本不匹配（receipt ledger_version=${readyReceipt.ledger_version}，台账 version=${ledger.version}，检查后发生过写操作，receipt 失效）`,
        });
      }
      const tip = latestIntegratedTip(ledger);
      if (readyReceipt.candidate_sha !== tip) {
        rejectWithEvent({
          ledgerPath, expected, now, group: null,
          reason: `phase 非法跳转 ${ledger.phase} → ready：receipt candidate_sha=${readyReceipt.candidate_sha} ≠ 台账当前集成树 ${tip ?? 'null'}（凭据与台账不一致，伪造拒）`,
          code: 'PRECONDITION',
          message: `缺失前置：→ready receipt candidate_sha 与台账当前集成树不一致（receipt=${readyReceipt.candidate_sha}，台账=${tip ?? 'null'}）`,
        });
      }
      // F-D 收口：→ready 前重读 manifest 校 core hash（ready 是终态、冻结后台账内无法纠正；
      // receipt 只绑 candidate_sha + ledger_version，不绑 manifest 内容——最后一次 hash 绑定写入
      // 之后篡改 manifest，receipt 驱动仍会成功，篡改只在链尾 validate 才暴露，而那时台账已冻结。
      // 与 validate/render-packet/record-delivery 同一入口闸：manifest 变了就不能拿旧结论进 ready。
      // manifest 来源 = 台账 manifest_path（init 时 resolve 为绝对路径，cwd 无关；调用方无需传，
      // 也就不会「忘记传」——与既有三个消费入口同源同判据）。
      const manifest = readManifest(ledger.manifest_path);
      assertManifestBound(ledger, manifest, 'set-state →ready');
    }
    if (problem) {
      rejectWithEvent({
        ledgerPath, expected, now, group: null,
        reason: `phase 非法跳转 ${ledger.phase} → ${phase}：${problem}`,
        code: 'ILLEGAL_TRANSITION',
        message: `phase 非法跳转 ${ledger.phase} → ${phase}：${problem}`,
      });
    }
    return writeLedgerAtomic(ledgerPath, expected, (cur) => {
      cur.phase = phase;
      // F2 契约：phase→ready 必须写 phase_at（ready 时点唯一记录；phase 跳转不落事件）
      if (phase === 'ready') cur.phase_at = now;
      return { ...cur, version: expected + 1 };
    });
  }

  // ---- 组状态机 ----
  if (group === undefined || to === undefined) {
    throw new LedgerError('ARGS', 'set-state 需要 --group + --to（或 --phase / --wave+--integrate / --identity）');
  }
  if (!GROUP_STATES.includes(to)) {
    throw new LedgerError('ARGS', `非法目标状态: ${to}（枚举: ${GROUP_STATES.join('/')}）`);
  }
  const curGroup = findGroup(ledger, group);

  // sc-p0b：--mem-snapshot 预解析（字符串 → 对象；JSON 非法 → ARGS 直接拒，不落事件——
  // 与 --identity 的 JSON.parse 失败同风格）。严格模式下漏传由前置机判拒（落事件 + exit 2）。
  let parsedMemSnapshot;
  if (memSnapshot !== undefined) {
    try {
      parsedMemSnapshot = typeof memSnapshot === 'string' ? JSON.parse(memSnapshot) : memSnapshot;
    } catch (err) {
      throw new LedgerError('ARGS', `--mem-snapshot 不是合法 JSON: ${err.message}`);
    }
  }
  let parsedDetail;
  if (detail !== undefined) {
    try {
      parsedDetail = typeof detail === 'string' ? JSON.parse(detail) : detail;
    } catch (err) {
      throw new LedgerError('ARGS', `--detail 不是合法 JSON: ${err.message}`);
    }
    if (parsedDetail === null || typeof parsedDetail !== 'object' || Array.isArray(parsedDetail)) {
      throw new LedgerError('ARGS', '--detail 必须是 JSON 对象');
    }
  }

  // 前置机器判（基于读到的台账版本；从 = 当前态）
  const preconditionProblem = () => {
    const g = curGroup;
    const from = g.state;
    if (to === 'dispatched' && from === 'pending') {
      if (typeof g.session_id !== 'string' || g.session_id.length === 0) {
        return '缺失前置：pending→dispatched 要求 identity 已含 session_id（先 create + 钉 Art + --identity）';
      }
      const wave = ledger.waves.find((w) => w.groups.some((x) => x.group_id === group));
      const unintegrated = ledger.waves.filter((w) => w.integrated_tip === null);
      const firstUnintegrated = unintegrated.length > 0
        ? unintegrated.reduce((min, w) => (w.wave < min.wave ? w : min))
        : undefined;
      if (wave !== firstUnintegrated) {
        return `缺失前置：组 ${group} 所在 wave ${wave.wave} 不是最早未集成 wave（wave ${firstUnintegrated.wave} 仍在途），不可跳过未完成前波派工`;
      }
      if (isStrictMode(ledger)) {
        const latest = latestPacketRendered(ledger, group);
        if (!latest) {
          return `缺失前置：组 ${group} 未经 render-packet 出包（无 packet_rendered 事件），拒绝派发`;
        }
        const curDigest = identityDigest({
          worktree: g.worktree, branch: g.branch, base: g.base,
          session_id: g.session_id, assignmentSeq: g.assignment_seq ?? 0,
        });
        if (latest.detail.identity_digest !== curDigest) {
          return `缺失前置：组 ${group} 未经 render-packet 出包（或身份已变更未重出包），拒绝派发`;
        }
        if (parsedMemSnapshot === undefined) {
          return '缺失前置：→dispatched 必须携带 --mem-snapshot \'<json>\'（四键 used_slots/platform_cap/concurrency/available_bytes，lead 从 mem-probe --json 提取）';
        }
        if (parsedMemSnapshot !== undefined) {
          try {
            assertMemSnapshot(parsedMemSnapshot);
          } catch (err) {
            if (err instanceof LedgerError) return `缺失前置：→dispatched --mem-snapshot 校验失败（${err.message}）`;
            throw err;
          }
        }
      }
    }
    if (to === 'executing' && from === 'dispatched') {
      const sha = parsedDetail?.goal_skill_sha256 ?? latestGroupEvent(ledger, group, 'gate_goal')?.detail?.goal_skill_sha256;
      if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
        return '缺失前置：dispatched→executing 要求本组成立的 gate_goal（detail.goal_skill_sha256 64hex）';
      }
    }
    if (to === 'executing' && from === 'blocked') {
      // 卡点恢复：不重跑开工闸
    }
    if (to === 'e2e' && from === 'executing') {
      const sha = parsedDetail?.routing_sha256 ?? latestGroupEvent(ledger, group, 'gate_routing')?.detail?.routing_sha256;
      if (typeof sha !== 'string' || !SHA256_RE.test(sha)) {
        return '缺失前置：executing→e2e 要求本组成立的 gate_routing（detail.routing_sha256 64hex）；create_worker 前必须现读 routing.json';
      }
    }
    if (to === 'accepted' && from === 'review') {
      if (!latestGroupEvent(ledger, group, 'gate_goal')) {
        return '缺失前置：→accepted 要求本组成立的 gate_goal';
      }
      if (!latestGroupEvent(ledger, group, 'gate_routing')) {
        return '缺失前置：→accepted 要求本组成立的 gate_routing';
      }
      const handoff = latestPrHandoffDelivery(ledger, group);
      if (!handoff) {
        return '缺失前置：→accepted 要求 candidate record-delivery（pr-handoff exact schema，不得含 pr_url）已入账';
      }
      // accepted 是 lead 的验收闸，不只是「有一张交卷」：candidate 必须是可提交
      // 的完整绿证据。record-delivery 仍允许把失败/未跑结果交上来供 lead 诊断，
      // 但不能借 accepted 状态把它们当成已验收。所有 candidate SHA 也必须绑定同一
      // 树，避免 e2e/review/size 各自验了不同候选后拼成一张假绿交卷。
      const badScs = Array.isArray(handoff.scs)
        ? handoff.scs.filter((sc) => sc?.status !== 'pass').map((sc) => sc?.id ?? '<missing>')
        : ['<missing>'];
      if (badScs.length > 0) {
        return `缺失前置：→accepted 要求全部 SC status=pass（未通过: ${badScs.join(', ')}）`;
      }
      if (handoff.e2e?.status !== 'pass') {
        return `缺失前置：→accepted 要求 e2e.status=pass（当前 ${handoff.e2e?.status ?? '缺失'}）`;
      }
      if (handoff.review?.unresolved !== 0 || g.review.unresolved !== 0) {
        const unresolved = handoff.review?.unresolved ?? g.review.unresolved;
        return `缺失前置：→accepted 要求 unresolved==0（当前 ${unresolved}）`;
      }
      if (handoff.size_gate?.result === 'STOP') {
        return '缺失前置：→accepted 要求 size_gate.result != STOP（当前 STOP）';
      }
      if (typeof g.branch !== 'string' || g.branch.length === 0 || handoff.branch !== g.branch) {
        return `缺失前置：→accepted 要求 candidate branch 对上台账身份（candidate=${handoff.branch ?? '缺失'}，台账=${g.branch ?? '缺失'}）`;
      }
      const tip = handoff.tip_sha;
      const mismatched = [
        ['tip_sha', tip],
        ['ledger.tip_sha', g.tip_sha],
        ['e2e.candidate_sha', handoff.e2e?.candidate_sha],
        ['review.candidate_sha', handoff.review?.candidate_sha],
        ['size_gate.candidate_sha', handoff.size_gate?.candidate_sha],
      ].filter(([, sha]) => sha !== tip).map(([name, sha]) => `${name}=${sha ?? '缺失'}`);
      if (mismatched.length > 0) {
        return `缺失前置：→accepted 要求 e2e/review/size candidate_sha 全部等于 tip_sha=${tip}（不一致: ${mismatched.join(', ')}）`;
      }
    }
    if (to === 'pr-open' && from === 'accepted') {
      if (ledger.phase !== 'ready') {
        return `缺失前置：accepted→pr-open 要求 run phase=ready（当前 ${ledger.phase}；先由 ready-check receipt 驱动 →ready，再开远端 PR）`;
      }
      if (prOpenReceipt === undefined) {
        return '缺失前置：accepted→pr-open 要求 confirm-pr-open 成功回执（--pr-open-receipt <path>）';
      }
      if (prOpenReceipt.branch !== g.branch) {
        return `缺失前置：pr-open receipt.branch=${prOpenReceipt.branch} 对不上组分支 ${g.branch ?? '缺失'}`;
      }
      if (prOpenReceipt.headRefOid !== g.tip_sha) {
        return `缺失前置：pr-open receipt.headRefOid=${prOpenReceipt.headRefOid} 对不上组 tip_sha=${g.tip_sha ?? '缺失'}`;
      }
      try {
        assertReceiptBoundToLedger(prOpenReceipt, ledger, group, 'pr-open receipt');
        assertReceiptAfterEvent(prOpenReceipt, ledger, group, 'accepted', 'pr-open receipt');
      } catch (err) {
        if (err instanceof LedgerError) return `缺失前置：${err.message}`;
        throw err;
      }
    }
    if (to === 'local-cleaned' && from === 'pr-open') {
      if (typeof g.pr_url !== 'string' || !GITHUB_PR_URL_RE.test(g.pr_url)) {
        return '缺失前置：→local-cleaned 要求组上已有 GitHub PR URL';
      }
      if (!latestGroupEvent(ledger, group, 'watch_registered')) {
        return '缺失前置：→local-cleaned 要求本组成立的 watch_registered（Mini 名册先于清场）';
      }
      if (cleanupReceipt === undefined) {
        return '缺失前置：→local-cleaned 要求 wrapup-cleanup 成功回执（--cleanup-receipt <path>）';
      }
      if (cleanupReceipt.branch !== g.branch) {
        return `缺失前置：cleanup receipt.branch=${cleanupReceipt.branch} 对不上组分支 ${g.branch ?? '缺失'}`;
      }
      if (cleanupReceipt.sha !== g.tip_sha) {
        return `缺失前置：cleanup receipt.sha=${cleanupReceipt.sha} 对不上组 tip_sha=${g.tip_sha ?? '缺失'}`;
      }
      if (typeof g.worktree === 'string' && cleanupReceipt.worktree !== g.worktree) {
        return `缺失前置：cleanup receipt.worktree=${cleanupReceipt.worktree} 对不上组 worktree=${g.worktree}`;
      }
      try {
        assertReceiptBoundToLedger(cleanupReceipt, ledger, group, 'cleanup receipt');
        assertReceiptAfterEvent(cleanupReceipt, ledger, group, 'watch_registered', 'cleanup receipt');
      } catch (err) {
        if (err instanceof LedgerError) return `缺失前置：${err.message}`;
        throw err;
      }
    }
    if (to === 'archived' && from === 'local-cleaned') {
      if (typeof g.session_id !== 'string' || g.session_id.length === 0) {
        return '缺失前置：→archived 要求 session_id（只归档 PI session）';
      }
      if (archiveReceipt === undefined) {
        return '缺失前置：→archived 要求 archive_sessions 成功回执（--archive-receipt <path>）';
      }
      if (archiveReceipt.session_id !== g.session_id) {
        return `缺失前置：archive receipt.session_id=${archiveReceipt.session_id} 对不上组 session_id=${g.session_id}`;
      }
      try {
        assertReceiptBoundToLedger(archiveReceipt, ledger, group, 'archive receipt');
        assertReceiptAfterEvent(archiveReceipt, ledger, group, 'local_cleaned', 'archive receipt');
      } catch (err) {
        if (err instanceof LedgerError) return `缺失前置：${err.message}`;
        throw err;
      }
    }
    if (to === 'failed') {
      if (!event || !FAILED_EVENT_TYPES.includes(event)) {
        // 只允许失败原因类事件：dispatch/delivery/review_round/integrate 等成功流事件若可
        // 由 set-state 伪造，会污染 ready-check 的分区对账与 delivery 绑定（伪 delivery 缺
        // tip_sha/candidate_sha 无从分辨）；illegal_transition 是系统拒绝记录，非失败原因。
        return `缺失前置：→failed 必须携带失败原因 --event（白名单: ${FAILED_EVENT_TYPES.join('/')}；收到: ${event ?? '无'}；成功流事件不得伪造）`;
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
      reason: `组状态非法跳转 ${curGroup.state} → ${to}（组 ${group}；白名单: ${GROUP_TRANSITIONS[curGroup.state].join('/') || '无，终态只读'}）`,
      code: 'ILLEGAL_TRANSITION',
      message: `组 ${group} 状态非法跳转 ${curGroup.state} → ${to}（白名单外，重放攻击拒）`,
    });
  }

  const problem = preconditionProblem();
  if (problem) {
    rejectWithEvent({
      ledgerPath, expected, now, group,
      reason: `组 ${group} ${curGroup.state} → ${to} 被拒：${problem}`,
      code: 'PRECONDITION',
      message: `组 ${group} 状态跳转 ${curGroup.state} → ${to} 被拒：${problem}`,
    });
  }

  return writeLedgerAtomic(ledgerPath, expected, (cur) => {
    const g = findGroup(cur, group);
    const from = g.state;
    if (to === 'dispatched') {
      g.state = 'dispatched';
      g.worker_label = workerLabel ?? g.session_id;
      g.dispatched_at = now;
      if (parsedDetail?.provider_id) g.provider_id = parsedDetail.provider_id;
      cur.events.push({
        type: 'dispatch',
        at: now,
        detail: { group_id: group, worker_label: g.worker_label, session_id: g.session_id },
      });
      cur.events.push({
        type: 'session_created',
        at: now,
        detail: { group_id: group, session_id: g.session_id, provider_id: g.provider_id },
      });
    } else if (to === 'executing') {
      g.state = 'executing';
      const sha = parsedDetail?.goal_skill_sha256 ?? latestGroupEvent(cur, group, 'gate_goal')?.detail?.goal_skill_sha256;
      if (!latestGroupEvent(cur, group, 'gate_goal') && sha) {
        cur.events.push({
          type: 'gate_goal',
          at: now,
          detail: {
            group_id: group,
            goal_skill_path: parsedDetail?.goal_skill_path ?? GOAL_SKILL_PATHS[0],
            goal_skill_sha256: sha,
            assignment_seq: g.assignment_seq ?? 0,
          },
        });
      }
    } else if (to === 'blocked') {
      g.state = 'blocked';
    } else if (to === 'e2e') {
      g.state = 'e2e';
      const sha = parsedDetail?.routing_sha256 ?? latestGroupEvent(cur, group, 'gate_routing')?.detail?.routing_sha256;
      if (!latestGroupEvent(cur, group, 'gate_routing') && sha) {
        cur.events.push({
          type: 'gate_routing',
          at: now,
          detail: {
            group_id: group,
            route_source: parsedDetail?.route_source ?? ROUTING_PATH_LIVE,
            routing_sha256: sha,
            e2e_model: parsedDetail?.e2e_model ?? null,
            review_model: parsedDetail?.review_model ?? null,
            assignment_seq: g.assignment_seq ?? 0,
          },
        });
      }
    } else if (to === 'review') {
      g.state = 'review';
    } else if (to === 'accepted') {
      g.state = 'accepted';
      const handoff = latestPrHandoffDelivery(cur, group);
      if (handoff?.tip_sha) g.tip_sha = handoff.tip_sha;
      cur.events.push({
        type: 'accepted',
        at: now,
        detail: { group_id: group, session_id: g.session_id, tip_sha: g.tip_sha, assignment_seq: g.assignment_seq ?? 0 },
      });
    } else if (to === 'pr-open') {
      g.state = 'pr-open';
      g.pr_url = prOpenReceipt.url;
      cur.events.push({
        type: 'pr_opened',
        at: now,
        detail: {
          group_id: group,
          pr_url: g.pr_url,
          pr_number: prOpenReceipt.number,
          headRefOid: prOpenReceipt.headRefOid,
          session_id: g.session_id,
          tip_sha: g.tip_sha,
          assignment_seq: g.assignment_seq ?? 0,
        },
      });
    } else if (to === 'local-cleaned') {
      g.state = 'local-cleaned';
      cur.events.push({
        type: 'local_cleaned',
        at: now,
        detail: {
          group_id: group,
          branch: cleanupReceipt.branch,
          worktree: cleanupReceipt.worktree,
          sha: cleanupReceipt.sha,
          remoteDeleted: false,
          session_id: g.session_id,
          pr_url: g.pr_url,
          assignment_seq: g.assignment_seq ?? 0,
        },
      });
    } else if (to === 'archived') {
      g.state = 'archived';
      cur.events.push({
        type: 'session_archived',
        at: now,
        detail: {
          group_id: group,
          session_id: archiveReceipt.session_id,
          archived: true,
          pr_url: g.pr_url,
          assignment_seq: g.assignment_seq ?? 0,
        },
      });
    } else if (to === 'failed') {
      if (!event || !FAILED_EVENT_TYPES.includes(event)) {
        throw new LedgerError('SCHEMA', `→failed 落盘事件非失败原因白名单（白名单: ${FAILED_EVENT_TYPES.join('/')}，收到: ${event ?? '无'}）`);
      }
      g.state = 'failed';
      cur.events.push({ type: event, at: now, detail: { group_id: group, event } });
    } else if (to === 'pending' && from === 'failed') {
      g.state = 'pending';
      g.review.rounds = 0;
      g.review.unresolved = 0;
      g.tip_sha = null;
      g.worker_label = null;
      g.dispatched_at = null;
      g.verify = { status: null, evidence_ref: null };
      g.worktree = null;
      g.branch = null;
      g.base = null;
      g.session_id = null;
      g.title = null;
      g.pr_url = null;
      g.provider_id = null;
      g.assignment_seq = (g.assignment_seq ?? 0) + 1;
      cur.events.push({ type: 'timeout_redispatch', at: now, detail: { group_id: group, reason: '重派链重置（新 worktree 新一轮）' } });
    }
    return { ...cur, version: expected + 1 };
  });
}

// ---------- render-packet：五项 fail-closed + pr-submit-gate 门禁透传 + 执行/验收双模板 ----------
// now（可选，缺省系统时钟）：出包成功写 packet_rendered 事件的 at 时间戳。render-packet 由
// 只读命令升级为写命令（sc-p0c 凭证闸），但 e2e-dryrun 等既有调用点不传 --now——缺省取
// 系统时钟保持兼容；确定性断言不断言事件 at（staleness 测试用 --now 注入对冲）。
export function renderPacket({ ledgerPath, group, manifestPath, now }) {
  const ledger = readLedger(ledgerPath);
  // F-D 内容绑定入口：消费 manifest 先校 core hash。--manifest 覆盖只接受 resolve 后
  // 等于台账 manifest_path（此时 hash 校验 = 验原文件未被篡改）或通过同一 hash 校验的异本文件。
  const manifestResolved = manifestPath ? resolve(manifestPath) : ledger.manifest_path;
  const manifest = readManifest(manifestResolved);
  assertManifestBound(ledger, manifest, 'render-packet');
  const packet = findPacket(manifest, group);
  const wave = findGroupWave(ledger, group);
  const wg = wave.groups.find((g) => g.group_id === group);

  // 完整性判据与 init 建台账前共用同一份实现（assertPacketComplete，含五要素存在性+类型、
  // scs_inline id 契约与 needs_three_review 布尔契约）：缺一不出包，与 init 同判据同拒绝。
  assertPacketComplete(packet, `组 ${group} 出包校验`);

  // 身份字段单一来源是台账：只认台账值，不接受 CLI 覆盖（见 CLI 解析层）
  const { worktree, branch, base } = wg;
  if (!worktree || !branch || !base) {
    throw new LedgerError(
      'NO_IDENTITY',
      `组 ${group} 尚未分配身份（worktree/branch/base 需经 set-state --identity 写入台账），拒绝出包`
    );
  }

  // sc-p0a 基线漂移闸（消费点②）：出包校验台账组 base === 期望基线（最新集成点 ?? init 基线）。
  // 与 set-state --identity 的消费点①共用同一判据函数（expectedBase）——两处比对同一基线。
  // 兼容模式（baseline_tip=null）跳过。错误消息含期望值、实得值、期望值来源。
  if (isStrictMode(ledger)) {
    const exp = expectedBaseInfo(ledger);
    if (base !== exp.base) {
      throw new LedgerError(
        'BASELINE_MISMATCH',
        `组 ${group} base=${base} 与期望基线 ${exp.base} 不一致（期望值来源：${exp.source}；派工基线必须等于台账当前期望基线，基线漂移拒出包）`
      );
    }
  }

  // 组类型：kind 含 fix 或 probe → 执行组模板；全部 kind=verify → 验收组模板。
  // probe 走执行组：task-priority waves-plan 官方把 probe 池排进首波（p1..），
  // 其产出是落盘证据/清单（goal 场景 C 照发），allowed_paths 已由 manifest 限死；
  // 只认 fix 会让合法首波恒 PACKET_INCOMPLETE（实测卡死 akb2-cloud-ci /
  // mivo-repo-split-closeout / mivo-slack-mention 三个 run 的 wave 1）。
  const kinds = packet.scs_inline.map((s) => s && typeof s === 'object' && s.kind ? s.kind : null);
  const isExecGroup = kinds.some((k) => k === 'fix' || k === 'probe');
  const isVerifyGroup = kinds.every((k) => k === 'verify');

  if (isVerifyGroup) {
    // D1 修复：验收组复查的是「严格早于本组所在 wave 的最新已集成 wave」的整合树，
    // 不是本组所在 wave 自己的树——本波要等本组 verified 后才集成，而 render-packet
    // 必须发生在派工之前（包是派工输入），读本波 integrated_tip 必然为 null，
    // 三者互相等待 = off-by-one-wave 死锁（实测：wave 1 集成后 render wave 2 的 v1 仍拒）。
    // 「最新已集成」= wave 数值最大，不是数组末位：waves 数组的有序性此前无处强制
    // （schema/init 均不校验），手写/异源台账可按任意顺序排布——取末位会取到数值更小的
    // 已集成波（同族缺陷实测：乱序 [4,3,1] 下误取 wave 1 而非 wave 3）。重复 wave 已由
    // schema 拒，按数值取 max 无歧义。initLedger 另在 manifest 边界拒乱序（合法输入恒有序，
    // 此处是纵深防御：绕过 init 的手写台账也必须正确）。
    const integratedBefore = ledger.waves
      .filter((w) => w.wave < wave.wave && w.integrated_tip !== null);
    const prevIntegrated = integratedBefore.reduce((max, w) => (max === null || w.wave > max.wave ? w : max), null);
    if (!prevIntegrated) {
      // D2：fail-closed 且点名。严格更早的已集成 wave 不存在（验收组被排进首波 /
      // 前波未集成）时不许回落 null/空串/当前 tip 静默继续——消息带组名、所在 wave、
      // 以及「实际已集成的最新 wave」是什么（无则明说无）。
      const latestIntegratedWave = ledger.waves.filter((w) => w.integrated_tip !== null);
      const latest = latestIntegratedWave.reduce((max, w) => (max === null || w.wave > max.wave ? w : max), null);
      throw new LedgerError(
        'NO_INTEGRATED',
        `验收组 ${group} 所在 wave ${wave.wave} 之前没有已集成 wave（严格更早的 integrated_tip 不存在；` +
        `实际已集成的最新 wave: ${latest ? `wave ${latest.wave}（integrated_tip=${latest.integrated_tip}）` : '无'}），无法渲染整合树复查项`
      );
    }
    return renderPacketWithCredential({
      ledgerPath, group, ledger, out: renderVerifyPacket({ packet, group, wg, wave, integratedWave: prevIntegrated, identity: { worktree, branch, base } }),
      now,
    });
  }
  if (!isExecGroup) {
    throw new LedgerError('PACKET_INCOMPLETE', `组 ${group} 的 scs_inline kind 既无 fix/probe 也无全 verify，无法选模板`);
  }
  return renderPacketWithCredential({
    ledgerPath, group, ledger,
    out: renderExecPacket({
      packet, group, wg, wave, identity: { worktree, branch, base },
      // 全台账最新一条 prewalk（不限本组）：波 0 现场要进后续执行组的包文
      prewalk: latestPrewalkDetail(ledger),
    }),
    now,
  });
}

/**
 * sc-p0c：成功出包写 packet_rendered 事件（凭证闸的落账侧）。CAS 版本+1（写事件不是
 * 无锁追加——与其他写路径同契约：乐观锁冲突 exit 2 绝不静默覆盖）。
 * detail：group_id + identity_digest（长度前缀编码 sha256 前 16hex，含 assignment_seq
 * 代际） + packet_sha256（渲染文本 sha256 前 16hex）+ assignment_seq。
 * 任何模式（严格/兼容）都写：出包成功即落凭证，凭证闸只在严格模式强制消费。
 */
function renderPacketWithCredential({ ledgerPath, group, ledger, out, now }) {
  writeLedgerAtomic(ledgerPath, ledger.version, (cur) => {
    const wg2 = findGroup(cur, group);
    const seq = wg2.assignment_seq ?? 0;
    cur.events.push({
      type: 'packet_rendered',
      at: now ?? new Date().toISOString(),
      detail: {
        group_id: group,
        identity_digest: identityDigest({
          worktree: wg2.worktree, branch: wg2.branch, base: wg2.base,
          session_id: wg2.session_id, assignmentSeq: seq,
        }),
        packet_sha256: createHash('sha256').update(out, 'utf8').digest('hex').slice(0, 16),
        assignment_seq: seq,
      },
    });
    return { ...cur, version: ledger.version + 1 };
  });
  return out;
}

/** pr-submit-gate 门禁说明（needs_three_review 判定结论；renderPacket 已校验为布尔，双模板共用）。 */
function renderGateNote(packet) {
  return packet.needs_three_review
    ? 'needs_three_review=true：本包对应功能改动（功能 PR），交付后须走 submit-pr 三审收口。'
    : 'needs_three_review=false：本包对应非功能性改动，免 submit-pr 三审，常规验证照常。';
}

function renderExecPacket({ packet, group, wave, identity, prewalk }) {
  const lines = [];
  // 固定头三要素（首行逐字；g7 文档测试会引用比对，一个字不能变）
  lines.push('用 goal skill 执行。');
  lines.push('--until-sc');
  lines.push(`worktree=${identity.worktree} branch=${identity.branch} base=${identity.base}`);
  lines.push('');
  lines.push(`run-ledger 派工包：组 ${group}（wave ${wave.wave}，执行组）`);
  lines.push('');
  lines.push('## pr-submit-gate 门禁');
  lines.push(renderGateNote(packet));
  if (prewalk) {
    // 现场只进渲染文本，不进 hashed packet JSON（ae-prewalk-render）
    lines.push('');
    lines.push('## PreWalk 现场');
    lines.push(`first_edit.path=${prewalk.first_edit.path}`);
    lines.push(`first_edit.sha=${prewalk.first_edit.sha}`);
    lines.push(`first_edit.sentence=${prewalk.first_edit.sentence}`);
    lines.push(`read_paths=${JSON.stringify(prewalk.read_paths)}`);
    lines.push('landmines:');
    for (const item of prewalk.landmines) {
      lines.push(`- ${item.path}: ${item.sentence}`);
    }
    lines.push('open_unknowns:');
    for (const item of prewalk.open_unknowns) {
      lines.push(`- ${item.sentence}`);
    }
  }
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

function renderVerifyPacket({ packet, group, wave, integratedWave, identity }) {
  const lines = [];
  // 验收组：不带 goal 触发行，明确只跑 verify 命令出 verdict 不改代码
  lines.push(`run-ledger 验收包：组 ${group}（wave ${wave.wave}，验收组）`);
  lines.push(`worktree=${identity.worktree} branch=${identity.branch} base=${identity.base}`);
  lines.push('');
  lines.push('## 职责');
  lines.push('只跑 verify 命令出 verdict，不改代码。');
  lines.push('');
  lines.push('## pr-submit-gate 门禁');
  lines.push(renderGateNote(packet));
  lines.push('');
  lines.push('## 验证命令');
  for (const c of packet.verify_cmds) lines.push(c);
  lines.push('');
  lines.push('## 整合树复查');
  // D1：复查对象是严格早于本组 wave 的已集成波（integratedWave），header 的 wave 仍指本组所在波
  lines.push(`integrated_tip=${integratedWave.integrated_tip}（wave ${integratedWave.wave} 集成 squash SHA）`);
  lines.push('对 integrated_tip 相对上一集成点的 squash diff 执行复查指令：核对改动物与台账断言一致、无越域写入、验证命令与 manifest 逐条一致。');
  return `${lines.join('\n')}\n`;
}

// ---------- record-delivery：worker 交卷进台账的唯一通道 ----------
const EXEC_DELIVERY_KEYS = Object.freeze(['status', 'tip_sha', 'scs']);
const EXEC_SC_KEYS = Object.freeze(['sc_id', 'status', 'evidence']);
// candidate_sha 是审查交卷的必填契约字段：ready-check ③ 按交卷类别消费（执行组绑
// review 类最后一条 delivery）的 detail.candidate_sha 绑定候选 HEAD——缺它则绑定形同虚设
// （F1 跨组断链补充），缺失/非 40hex 一律拒，禁止从台账派生默认（被审查对象由审查方在
// 交卷里显式声明）。
const REVIEW_DELIVERY_KEYS = Object.freeze(['rounds', 'findings_total', 'unresolved', 'fix_commits', 'candidate_sha']);
const VERIFY_DELIVERY_KEYS = Object.freeze(['scs', 'integration_review', 'candidate_sha']);
const INTEGRATION_REVIEW_KEYS = Object.freeze(['status', 'notes']);
// 第 4 类：与 exec/review/verify 并列的 exact 键集。hits===1 仍是唯一识别门。
export const PREWALK_DELIVERY_KEYS = Object.freeze(['first_edit', 'read_paths', 'landmines', 'open_unknowns']);
const PREWALK_SENTENCE_MAX = 80;
const PREWALK_OPEN_UNKNOWNS_MAX = 4;
const RELATIVE_PATH_RE = /^(?!\.\.?(?:\/|$))(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;

function classifyDelivery(data) {
  const keys = Object.keys(data).sort();
  const hasExec = EXEC_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === EXEC_DELIVERY_KEYS.length;
  const hasReview = REVIEW_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === REVIEW_DELIVERY_KEYS.length;
  const hasVerify = VERIFY_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === VERIFY_DELIVERY_KEYS.length;
  const hasPrewalk = PREWALK_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === PREWALK_DELIVERY_KEYS.length;
  const hasPrHandoff = PR_HANDOFF_DELIVERY_KEYS.every((k) => keys.includes(k)) && keys.length === PR_HANDOFF_DELIVERY_KEYS.length;
  const hits = [hasExec, hasReview, hasVerify, hasPrewalk, hasPrHandoff].filter(Boolean).length;
  if (hits !== 1) {
    throw new LedgerError(
      'DELIVERY_SCHEMA',
      `交卷 schema 无法唯一识别（exec/review/verify/prewalk/pr-handoff 五类命中 ${hits} 类）；exact 契约，多余键或缺失键都拒`
    );
  }
  if (hasExec) return 'exec';
  if (hasReview) return 'review';
  if (hasVerify) return 'verify';
  if (hasPrHandoff) return 'pr-handoff';
  return 'prewalk';
}

function assertRouteSource(value, what) {
  if (value === 'model-route show') return;
  if (value === ROUTING_PATH_LIVE || value === ROUTING_PATH_LINK) return;
  throw new LedgerError('DELIVERY_SCHEMA', `${what} 必须是 live routing.json 绝对路径、其 ~/.agents 软链、或字面量 model-route show（当前: ${value}）`);
}

function validatePrHandoffDelivery(data, packet) {
  if (Object.prototype.hasOwnProperty.call(data, 'pr_url')) {
    throw new LedgerError('DELIVERY_SCHEMA', 'candidate 交卷不得含 pr_url（验收前不开远端 PR）');
  }
  if (typeof data.branch !== 'string' || data.branch.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 branch 必须是非空字符串');
  }
  if (typeof data.tip_sha !== 'string' || !TIP_SHA_RE.test(data.tip_sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', `终态交卷 tip_sha 非 40 位十六进制（当前: ${data.tip_sha ?? '缺失'}）`);
  }
  if (!GOAL_SKILL_PATHS.includes(data.goal_skill_path)) {
    throw new LedgerError(
      'DELIVERY_SCHEMA',
      `终态交卷 goal_skill_path 必须是 PI 自己的 goal skill 三路径之一（当前: ${data.goal_skill_path ?? '缺失'}）`
    );
  }
  if (!Array.isArray(data.scs) || data.scs.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 scs 必须是非空数组');
  }
  for (const sc of data.scs) {
    assertKeys(sc, PR_HANDOFF_SC_KEYS, '终态交卷 sc 条目');
    if (typeof sc.id !== 'string' || sc.id.length === 0) {
      throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 sc.id 必须是非空字符串');
    }
    if (!SC_RESULT_STATUS.includes(sc.status)) {
      throw new LedgerError('DELIVERY_SCHEMA', `终态交卷 sc ${sc.id} 的 status 非法: ${sc.status}`);
    }
  }
  assertScIdSet(data.scs.map((s) => ({ sc_id: s.id })), packet, '终态交卷');
  if (data.e2e === null || typeof data.e2e !== 'object' || Array.isArray(data.e2e)) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 e2e 必须是对象');
  }
  assertKeys(data.e2e, PR_HANDOFF_E2E_KEYS, '终态交卷 e2e');
  if (typeof data.e2e.status !== 'string' || data.e2e.status.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 e2e.status 必须是非空字符串');
  }
  if (typeof data.e2e.candidate_sha !== 'string' || !TIP_SHA_RE.test(data.e2e.candidate_sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 e2e.candidate_sha 非 40 位十六进制');
  }
  if (typeof data.e2e.model !== 'string' || data.e2e.model.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 e2e.model 必须是非空字符串');
  }
  assertRouteSource(data.e2e.route_source, '终态交卷 e2e.route_source');
  if (data.review === null || typeof data.review !== 'object' || Array.isArray(data.review)) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 review 必须是对象');
  }
  assertKeys(data.review, PR_HANDOFF_REVIEW_KEYS, '终态交卷 review');
  if (!Number.isSafeInteger(data.review.unresolved) || data.review.unresolved < 0) {
    throw new LedgerError('DELIVERY_SCHEMA', `终态交卷 review.unresolved 必须是非负安全整数（当前: ${data.review.unresolved}）`);
  }
  if (typeof data.review.candidate_sha !== 'string' || !TIP_SHA_RE.test(data.review.candidate_sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 review.candidate_sha 非 40 位十六进制');
  }
  if (typeof data.review.model !== 'string' || data.review.model.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 review.model 必须是非空字符串');
  }
  assertRouteSource(data.review.route_source, '终态交卷 review.route_source');
  if (data.size_gate === null || typeof data.size_gate !== 'object' || Array.isArray(data.size_gate)) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 size_gate 必须是对象');
  }
  assertKeys(data.size_gate, PR_HANDOFF_SIZE_KEYS, '终态交卷 size_gate');
  if (typeof data.size_gate.result !== 'string' || data.size_gate.result.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 size_gate.result 必须是非空字符串');
  }
  if (typeof data.size_gate.candidate_sha !== 'string' || !TIP_SHA_RE.test(data.size_gate.candidate_sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', '终态交卷 size_gate.candidate_sha 非 40 位十六进制');
  }
}

function assertPrewalkSentence(value, what) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 必须是非空短句`);
  }
  if (value.length > PREWALK_SENTENCE_MAX) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 超限（>${PREWALK_SENTENCE_MAX}）：长度 ${value.length}`);
  }
  if (value.includes('\n')) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 不得含换行（散文拒）`);
  }
}

function assertRelativePath(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 必须是非空相对路径`);
  }
  if (!RELATIVE_PATH_RE.test(value) || value.includes('\\')) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 必须是非空相对路径（当前: ${value}）`);
  }
}

function validatePrewalkDelivery(data) {
  const fe = data.first_edit;
  if (fe === null || typeof fe !== 'object' || Array.isArray(fe)) {
    throw new LedgerError('DELIVERY_SCHEMA', 'prewalk.first_edit 必须是 {sha,path,sentence} 对象');
  }
  const feKeys = Object.freeze(['sha', 'path', 'sentence']);
  assertKeys(fe, feKeys, 'prewalk.first_edit');
  if (typeof fe.sha !== 'string' || !TIP_SHA_RE.test(fe.sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', `prewalk.first_edit.sha 非 40 位十六进制（长度 ${fe.sha?.length ?? 0}）`);
  }
  assertRelativePath(fe.path, 'prewalk.first_edit.path');
  assertPrewalkSentence(fe.sentence, 'prewalk.first_edit.sentence');
  if (!Array.isArray(data.read_paths)) {
    throw new LedgerError('DELIVERY_SCHEMA', 'prewalk.read_paths 必须是字符串数组');
  }
  for (let i = 0; i < data.read_paths.length; i += 1) {
    assertRelativePath(data.read_paths[i], `prewalk.read_paths[${i}]`);
  }
  if (!Array.isArray(data.landmines)) {
    throw new LedgerError('DELIVERY_SCHEMA', 'prewalk.landmines 必须是 {path,sentence}[]');
  }
  for (let i = 0; i < data.landmines.length; i += 1) {
    const item = data.landmines[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new LedgerError('DELIVERY_SCHEMA', `prewalk.landmines[${i}] 必须是 {path,sentence} 对象`);
    }
    assertKeys(item, Object.freeze(['path', 'sentence']), `prewalk.landmines[${i}]`);
    assertRelativePath(item.path, `prewalk.landmines[${i}].path`);
    assertPrewalkSentence(item.sentence, `prewalk.landmines[${i}].sentence`);
  }
  if (!Array.isArray(data.open_unknowns)) {
    throw new LedgerError('DELIVERY_SCHEMA', 'prewalk.open_unknowns 必须是 {sentence}[]');
  }
  if (data.open_unknowns.length > PREWALK_OPEN_UNKNOWNS_MAX) {
    throw new LedgerError(
      'DELIVERY_SCHEMA',
      `prewalk.open_unknowns 长度 ${data.open_unknowns.length} 超限（≤${PREWALK_OPEN_UNKNOWNS_MAX}）`
    );
  }
  for (let i = 0; i < data.open_unknowns.length; i += 1) {
    const item = data.open_unknowns[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new LedgerError('DELIVERY_SCHEMA', `prewalk.open_unknowns[${i}] 必须是 {sentence} 对象`);
    }
    assertKeys(item, Object.freeze(['sentence']), `prewalk.open_unknowns[${i}]`);
    assertPrewalkSentence(item.sentence, `prewalk.open_unknowns[${i}].sentence`);
  }
}

function assertFirstEditExists(worktree, firstEdit) {
  if (typeof worktree !== 'string' || worktree.length === 0) {
    throw new LedgerError('FIRST_EDIT_MISSING', 'prewalk 入账要求组 identity.worktree 已分配');
  }
  const typeR = spawnSync('git', ['-C', worktree, 'cat-file', '-t', firstEdit.sha], { encoding: 'utf8' });
  if (typeR.status !== 0 || String(typeR.stdout).trim() !== 'commit') {
    throw new LedgerError(
      'FIRST_EDIT_MISSING',
      `first_edit.sha=${firstEdit.sha} 不在 worktree ${worktree}（git cat-file -t 非 commit）`
    );
  }
  const showR = spawnSync('git', ['-C', worktree, 'show', `${firstEdit.sha}:${firstEdit.path}`], { encoding: 'utf8' });
  if (showR.status !== 0) {
    throw new LedgerError(
      'FIRST_EDIT_MISSING',
      `first_edit.path=${firstEdit.path} 不在 commit ${firstEdit.sha}（git show 失败）`
    );
  }
}

function isWaveZeroGroup(ledger, groupId) {
  if (!Array.isArray(ledger.waves) || ledger.waves.length === 0) return false;
  const firstWave = ledger.waves.reduce((min, w) => (w.wave < min.wave ? w : min));
  const firstGroup = firstWave.groups?.[0];
  return firstGroup?.group_id === groupId;
}

function latestPrewalkDetail(ledger) {
  for (let i = ledger.events.length - 1; i >= 0; i -= 1) {
    const ev = ledger.events[i];
    if (ev.type !== 'delivery') continue;
    const d = ev.detail;
    if (
      d?.first_edit && typeof d.first_edit === 'object'
      && Array.isArray(d.read_paths)
      && Array.isArray(d.landmines)
      && Array.isArray(d.open_unknowns)
    ) {
      return d;
    }
  }
  return null;
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

/** packet.scs_inline 的 id 契约（F-J）：非空字符串 + 无重复（Set.size === length）。
 *  出包（render-packet）与交卷（record-delivery）双入口都先过此关——packet 自身
 *  重复/空 id 时 exact 比对无从谈起（expected 的重复会让「多/少」判据恒过），必须 fail-closed。 */
function assertPacketScIds(packet, what) {
  if (!Array.isArray(packet.scs_inline) || packet.scs_inline.length === 0) {
    throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.scs_inline 必须是非空数组`);
  }
  const ids = packet.scs_inline.map((s) => s.id);
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.scs_inline 含非字符串/空 id（值: ${String(id)}，F-J fail-closed）`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    throw new LedgerError('PACKET_INCOMPLETE', `${what}：packet.scs_inline 含重复 id（${dup.join(', ')}，出包/交卷均拒，F-J fail-closed）`);
  }
}

/** sc_id 集合必须与派工包 scs_inline 完全一致（exact：多/少/错都拒）+ 无重复。
 *  F-J：先验 packet 自身 id 契约（重复/空 → 直接拒），再按计数 map 双向比。 */
function assertScIdSet(scEntries, packet, what) {
  assertPacketScIds(packet, what); // F-J：expected 自身重复/空 id 先拒（出包/交卷共用此关）
  const expectedIds = packet.scs_inline.map((s) => s.id);
  const actualIds = scEntries.map((sc) => sc.sc_id);
  if (new Set(actualIds).size !== actualIds.length) {
    throw new LedgerError('DELIVERY_SCHEMA', `${what} 存在重复 sc_id`);
  }
  // 计数 map 双向比（expected 已保证无重复 → 每个 expected id 恰出现 1 次才算一致）
  const expectedCount = new Map();
  for (const id of expectedIds) expectedCount.set(id, (expectedCount.get(id) ?? 0) + 1);
  const actualCount = new Map();
  for (const id of actualIds) actualCount.set(id, (actualCount.get(id) ?? 0) + 1);
  const missing = [...expectedCount.entries()]
    .filter(([id, c]) => actualCount.get(id) !== c)
    .map(([id]) => id);
  const extra = [...actualCount.entries()]
    .filter(([id, c]) => expectedCount.get(id) !== c)
    .map(([id]) => id);
  if (missing.length > 0 || extra.length > 0) {
    throw new LedgerError(
      'SC_ID_MISMATCH',
      `${what} sc_id 集合与派工包 scs_inline 不一致（计数比对）：缺 ${missing.join(',') || '无'}，多/错 ${extra.join(',') || '无'}`
    );
  }
}

function validateReviewDelivery(data) {
  // rounds/findings_total/unresolved 都是整数语义字段（台账 review 层为整数契约），
  // 非负整数一把抓：字符串/小数/布尔/负值全部拒
  for (const k of ['rounds', 'findings_total', 'unresolved']) {
    if (!Number.isSafeInteger(data[k]) || data[k] < 0) {
      throw new LedgerError('DELIVERY_SCHEMA', `审查组交卷 ${k} 必须是非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}，当前: ${data[k]}）`);
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
  // candidate_sha 必填（exact 契约，不许默认）：ready-check ③ 按交卷类别消费（执行组绑
  // review 类最后一条 delivery）的 detail.candidate_sha 绑定 HEAD，审查方必须在交卷里显式声明所审查候选
  if (typeof data.candidate_sha !== 'string' || !TIP_SHA_RE.test(data.candidate_sha)) {
    throw new LedgerError(
      'DELIVERY_SCHEMA',
      `审查组交卷 candidate_sha 非 40 位十六进制（当前: ${data.candidate_sha ?? '缺失'}）——审查交卷必须绑定所审查候选 SHA，禁止默认`
    );
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
  // 验收交卷 = 验收组（verify 类）最后一条 delivery：ready-check ③ 按交卷类别消费
  // （验收组绑 verify 类最后一条）的 detail.candidate_sha 绑定 HEAD
  if (typeof data.candidate_sha !== 'string' || !TIP_SHA_RE.test(data.candidate_sha)) {
    throw new LedgerError('DELIVERY_SCHEMA', `验收组交卷 candidate_sha 非 40 位十六进制（ready-check ③ 消费 verify 类最后一条 delivery 的读取点，当前: ${data.candidate_sha}）`);
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
  // F-D 内容绑定入口：manifest 已变（相对台账记录）时交卷不得入账——禁止拿旧结论/旧 manifest 干活
  const manifest = readManifest(ledger.manifest_path);
  assertManifestBound(ledger, manifest, 'record-delivery');
  const packet = findPacket(manifest, group);

  const kind = classifyDelivery(data);
  if (kind === 'exec') validateExecDelivery(data, packet);
  if (kind === 'review') validateReviewDelivery(data);
  if (kind === 'verify') validateVerifyDelivery(data, packet);
  if (kind === 'pr-handoff') validatePrHandoffDelivery(data, packet);
  if (kind === 'prewalk') {
    validatePrewalkDelivery(data);
    // 存在性放到锁内、生命周期门之后：pending/非波0 组应先 ILLEGAL_TRANSITION，
    // 不能被 FIRST_EDIT_MISSING 抢先（第二组可能还没 identity.worktree）。
  }

  // 校验全部通过才原子写盘；任何失败路径都不触碰原台账（坏交卷后台账字节不变）
  return writeLedgerAtomic(ledgerPath, expected, (cur) => {
    const g = findGroup(cur, group);
    // ① 升级（方向 B）：生命周期门在锁内复核当前组状态（读后写到锁内之间状态可能被并发
    // 改写——不能拿读侧 wg 一次判定）。payload schema 校验已在外层完成，此处只验时序：
    // 类别 × 状态矩阵（DELIVERY_LIFECYCLE），verified/failed 一律拒。锁内 throw 不落盘
    // （字节不变），与 ready 冻结 FROZEN 同风格。
    const allowedStates = DELIVERY_LIFECYCLE[kind];
    if (!allowedStates.includes(g.state)) {
      throw new LedgerError(
        'ILLEGAL_TRANSITION',
        `组 ${group} 状态 ${g.state} 不允许 ${kind} 类交卷入账（生命周期门：${kind} 类只允许在 ${allowedStates.join('/')} 状态入账；交卷类别必须匹配组阶段，防验收凭据预写/终态改写）`
      );
    }
    if (kind === 'prewalk') {
      if (!isWaveZeroGroup(cur, group)) {
        throw new LedgerError(
          'ILLEGAL_TRANSITION',
          `组 ${group} 不是第一波第一组，拒绝 prewalk（只允许 wave 0 组交恰好一次）`
        );
      }
      const already = cur.events.some((e) => (
        e.type === 'delivery'
        && e.detail?.group_id === group
        && e.detail?.first_edit
        && Array.isArray(e.detail?.read_paths)
        && Array.isArray(e.detail?.landmines)
        && Array.isArray(e.detail?.open_unknowns)
      ));
      if (already) {
        throw new LedgerError(
          'ILLEGAL_TRANSITION',
          `组 ${group} 已有一条 prewalk 交卷，拒绝第二次`
        );
      }
      assertFirstEditExists(g.worktree, data.first_edit);
      cur.events.push({
        type: 'delivery',
        at: now,
        detail: {
          group_id: group,
          first_edit: {
            sha: data.first_edit.sha,
            path: data.first_edit.path,
            sentence: data.first_edit.sentence,
          },
          read_paths: data.read_paths.slice(),
          landmines: data.landmines.map((x) => ({ path: x.path, sentence: x.sentence })),
          open_unknowns: data.open_unknowns.map((x) => ({ sentence: x.sentence })),
        },
      });
      // 不改组状态：仍 dispatched，随后仍能交 exec
    } else if (kind === 'exec') {
      g.tip_sha = data.tip_sha;
      cur.events.push({
        type: 'delivery',
        at: now,
        // F1 修复：detail.tip_sha 是 ready-check ① 与台账 tip_sha 对账的读取点；scs 摘要结构化。
        // exec 交卷侧 candidate_sha = 所交 tip_sha（身份同一：候选即所交 tip，与 set-state 派发时刻同值）
        detail: {
          group_id: group,
          status: data.status,
          tip_sha: data.tip_sha,
          candidate_sha: data.tip_sha,
          scs: data.scs.map((s) => ({ sc_id: s.sc_id, status: s.status })),
        },
      });
    } else if (kind === 'review') {
      g.review.rounds = data.rounds;
      g.review.unresolved = data.unresolved;
      cur.events.push({
        type: 'delivery',
        at: now,
        // F1 修复：detail.candidate_sha 是 ready-check ③ 审查交卷绑定的读取点；tip_sha 取台账当前值
        // （组已交付 tip，未交付即 null——fail-closed，出口门 ① 对账/③ 绑定会拒绝）
        detail: {
          group_id: group,
          tip_sha: g.tip_sha,
          candidate_sha: data.candidate_sha,
          rounds: data.rounds,
          findings_total: data.findings_total,
          unresolved: data.unresolved,
          fix_commits: data.fix_commits.length,
        },
      });
    } else if (kind === 'pr-handoff') {
      if (!latestGroupEvent(cur, group, 'gate_goal') || !latestGroupEvent(cur, group, 'gate_routing')) {
        throw new LedgerError(
          'PRECONDITION',
          `组 ${group} candidate 交卷要求本组成立的 gate_goal + gate_routing（视为未执行开工闸，拒，不得 accepted）`
        );
      }
      g.tip_sha = data.tip_sha;
      g.review.unresolved = data.review.unresolved;
      cur.events.push({
        type: 'delivery',
        at: now,
        detail: {
          group_id: group,
          branch: data.branch,
          tip_sha: data.tip_sha,
          scs: data.scs,
          goal_skill_path: data.goal_skill_path,
          e2e: data.e2e,
          review: data.review,
          size_gate: data.size_gate,
          session_id: g.session_id,
          candidate_sha: data.tip_sha,
          e2e_status: data.e2e.status,
          review_unresolved: data.review.unresolved,
          size_result: data.size_gate.result,
          ledger_version: expected,
          checked_at: now,
          assignment_seq: g.assignment_seq ?? 0,
        },
      });
    } else {
      g.verify.status = data.integration_review.status;
      g.verify.evidence_ref = `delivery#${cur.events.length + 1}`;
      cur.events.push({
        type: 'delivery',
        at: now,
        // F1 修复：验收交卷 = 验收组（verify 类）最后一条 delivery——detail.candidate_sha 供
        // ready-check ③ 按类别消费（验收组绑 verify 类最后一条）绑定
        detail: {
          group_id: group,
          integration_review_status: data.integration_review.status,
          notes: data.integration_review.notes,
          candidate_sha: data.candidate_sha,
        },
      });
    }
    return { ...cur, version: expected + 1 };
  });
}

// ---------- sc-p0d：staleness 只读子命令（台账新鲜度诊断） ----------
// last_event_at = 台账最后一条事件的 at（events 数组按写入顺序追加，末位即最新）。
// 无事件时 last_event_at/minutes_since_last_event 输出 null——不伪造 0（0 会被看成
// 「刚刚有活动」，掩盖「自 init 起就无事件」的停摆事实）。
// in_flight_groups 按「未完成验收」语义过滤：state ∈ dispatched/executing/blocked/e2e/review
// （组已派工但尚未 accepted）。accepted 及之后的收尾态不算在途。
// 导出函数与 CLI 同实现：只读（readLedger，ready 冻结不拦读——冻结只拦写路径）；
// --now 注入供确定性测试，缺省取系统时钟。
export function staleness({ ledgerPath, now }) {
  const ledger = readLedger(ledgerPath);
  const refTime = now !== undefined ? Date.parse(now) : Date.now();
  if (!Number.isFinite(refTime)) {
    throw new LedgerError('ARGS', `staleness --now 无法解析为时间戳: ${now}`);
  }
  const lastEvent = ledger.events.length > 0 ? ledger.events[ledger.events.length - 1] : null;
  let lastEventAt = null;
  let minutesSince = null;
  if (lastEvent) {
    lastEventAt = lastEvent.at;
    const evTime = Date.parse(lastEvent.at);
    if (Number.isFinite(evTime)) {
      minutesSince = Math.max(0, Math.floor((refTime - evTime) / 60000));
    }
  }
  const inFlight = ledger.waves
    .flatMap((w) => w.groups)
    .filter((g) => ['dispatched', 'executing', 'blocked', 'e2e', 'review'].includes(g.state))
    .map((g) => ({ group_id: g.group_id, state: g.state, dispatched_at: g.dispatched_at }));
  return {
    phase: ledger.phase,
    version: ledger.version,
    last_event_at: lastEventAt,
    minutes_since_last_event: minutesSince,
    in_flight_groups: inFlight,
    all_waves_integrated: ledger.waves.every((w) => w.integrated_tip !== null),
  };
}

// ---------- CLI ----------
function usage() {
  return [
    'run-ledger <sub> <ledger> [flags]',
    '  init <ledger> --manifest <path> --run-id <id> --now <ts> [--baseline <sha>]',
    '  validate <ledger>',
    '  set-state <ledger> --group <gid> --to <state> --now <ts> [--worker-label <l>] [--tip-sha <hex40>] [--event <type>] [--mem-snapshot <json>] [--pr-open-receipt <path>] [--cleanup-receipt <path>] [--archive-receipt <path>]',
    '  set-state <ledger> --identity <json> --group <gid> --now <ts>',
    '  set-state <ledger> --phase <phase> --now <ts> [--ready-receipt <path>]',
    '  set-state <ledger> --wave <n> --integrate <hex40> --now <ts>',
    '  render-packet <ledger> --group <gid> [--manifest <path>]',
    '  record-delivery <ledger> --group <gid> --payload <json|@file> --now <ts>',
    '  note-event <ledger> --event site_report|replan_note|watch_registered --detail <json> --now <ts>',
    '  staleness <ledger> [--now <iso>]',
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
    // ③ 修复点：单值 flag 重复传 = 语义不明确（后值静默覆盖前值会掩盖真实意图），拒。
    // 用 hasOwnProperty 而非 `key in flags`（后者会被 Object 原型链上的键误判为重复）。
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      throw new LedgerError('ARGS', `参数 --${key} 重复指定（单值 flag，静默覆盖会掩盖真实意图）`);
    }
    if (eq === -1) i += 1;
    flags[key] = value;
  }
  return flags;
}

// render-packet 的身份字段单一来源是台账：CLI 一律拒（防覆盖）
const IDENTITY_CLI_FLAGS = Object.freeze(['worktree', 'branch', 'base', 'identity']);

// F-F/F-H 已移除 flag：前置扫描统一点名（flag 出现在位置参数位/值位都命中）。
// 旧行为 `set-state --ready-check-exit0 1`（无 ledger）会把 flag 顶位成 ledgerArg、
// 把值 `1` 当独立 token 报「非法参数: 1」连参数名都没报对；扫描保证点名 flag 名与
// 已移除语义。等号形式（--ready-check-exit0=1）由 set-state 分支内拒收兜底（双保险）。
const REMOVED_CLI_FLAGS = Object.freeze(['--ready-check-exit0', '--verify-status', '--verify-evidence-ref']);

function removedFlagMessage(flag) {
  if (flag === '--ready-check-exit0') {
    return '--ready-check-exit0 布尔凭据已移除：→ready 只能由 ready-check 写入的 receipt 驱动（--ready-receipt <path>）';
  }
  return '--verify-status/--verify-evidence-ref 手工写入口已移除：verified 的 pass 凭据只能由验收组 record-delivery 写入';
}

// ③ 修复点：子命令 exact flag allowlist——未知 flag 先拒再执行业务分支（此前静默忽略，
// typo 一个 flag 命令照常成功但语义不是使用者要的）。只列业务实际消费的 flag；
// 已移除/已拒 flag（--ready-check-exit0/--verify-status/--verify-evidence-ref/--unresolved/
// 身份独立键）由各分支专门点名拒绝，不在此表（防 allowlist 通用报错顶掉语义更明确的点名）。
const SUBCOMMAND_FLAGS = Object.freeze({
  init: ['manifest', 'run-id', 'now', 'baseline'],
  validate: [],
  'set-state': ['group', 'to', 'now', 'worker-label', 'tip-sha', 'event', 'identity', 'phase', 'wave', 'integrate', 'ready-receipt', 'mem-snapshot', 'detail', 'pr-open-receipt', 'cleanup-receipt', 'archive-receipt'],
  'render-packet': ['group', 'manifest', 'now'],
  'record-delivery': ['group', 'payload', 'now'],
  'note-event': ['event', 'detail', 'now'],
  staleness: ['now'],
});

function assertKnownFlags(sub, flags) {
  const allowed = SUBCOMMAND_FLAGS[sub];
  const unknown = Object.keys(flags).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new LedgerError(
      'ARGS',
      `未知 flag: ${unknown.map((k) => `--${k}`).join('、')}（${sub} 允许: ${allowed.map((k) => `--${k}`).join('、')}）`
    );
  }
}

export function runCli(argv) {
  if (argv.length === 0) {
    console.error(usage());
    return 1;
  }
  try {
    // 已移除 flag 前置扫描：parseFlags 之前，位置参数位/值位都命中（点名 flag 名而非其值）
    for (const removed of REMOVED_CLI_FLAGS) {
      if (argv.includes(removed)) {
        throw new LedgerError('ARGS', removedFlagMessage(removed));
      }
    }
    const [sub, ledgerArg, ...rest] = argv;
    if (!ledgerArg || ledgerArg.startsWith('--')) {
      // 缺 <ledger> 路径（flag 顶位也算缺）：参数错误统一 exit 2 点名（fail-closed，不裸栈）
      throw new LedgerError('ARGS', `${sub} 缺 <ledger> 路径（位置参数必须是台账路径）`);
    }
    const flags = parseFlags(rest);
    const ledgerPath = resolve(ledgerArg);
    switch (sub) {
      case 'init': {
        assertKnownFlags('init', flags); // ③：未知 flag 先拒，不得创建台账
        // sc-p0a：--baseline 可选（缺省 null = 兼容模式，e2e-dryrun 等旧路径；严格模式
        // 下 run-ledger 测试路径全部显式传 40hex）。函数层 initLedger 对 undefined 拒
        // （in-process 漏传同样拒），CLI 缺省显式传 null 走兼容。
        // 审查发现（组级审查）：缺省即入兼容模式会让「忘传 --baseline」与「明确要兼容模式」
        // 在 exit code / stdout 上完全同形——lead 真实 run 漏传 --baseline 时，基线闸/快照闸/
        // 凭证闸三道 P0 新闸会静默全部不生效，且无任何区分信号。CLI 层无法强制必填
        // （tests/e2e-dryrun.test.mjs 明确不改范围、不传 --baseline，强制必填会破坏该测试）；
        // 折中：缺省时把降级动作打成显式 stderr 警告（不改变 exit code / stdout，不破坏既有
        // 断言），让「三道新闸未生效」这件事在任何真实调用现场都可见，不再只是代码注释里的说明。
        if (flags.baseline === undefined) {
          console.error(
            'run-ledger: [WARN] init 未传 --baseline，台账进入兼容模式（baseline_tip=null）：'
            + 'sc-p0a 基线漂移闸 / sc-p0b 派发内存快照闸 / sc-p0c 出包凭证闸三道 P0 新闸全部不生效。'
            + '真实执行请显式传 --baseline <40hex>；仅 e2e-dryrun 等无基线语义的旧路径应缺省此 flag。'
          );
        }
        initLedger({
          ledgerPath,
          manifestPath: flags.manifest,
          runId: flags['run-id'],
          now: flags.now,
          baseline: flags.baseline ?? null,
        });
        console.log(`init: 台账已创建 ${ledgerPath}（version=0, phase=splitting, baseline=${flags.baseline ?? 'null（兼容模式）'}）`);
        return 0;
      }
      case 'validate': {
        assertKnownFlags('validate', flags); // ③：validate 不接受任何 flag
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
        // F-F：--ready-check-exit0 布尔凭据已移除（→ready 只能由 ready-check 写入的 receipt 驱动）
        if (flags['ready-check-exit0'] !== undefined) {
          throw new LedgerError('ARGS', '--ready-check-exit0 布尔凭据已移除：→ready 只能由 ready-check 写入的 receipt 驱动（--ready-receipt <path>）');
        }
        // F-H：--verify-status/--verify-evidence-ref 手工写入口已移除（与 --unresolved 同类漏洞）
        if (flags['verify-status'] !== undefined || flags['verify-evidence-ref'] !== undefined) {
          throw new LedgerError('ARGS', '--verify-status/--verify-evidence-ref 手工写入口已移除：verified 的 pass 凭据只能由验收组 record-delivery 写入');
        }
        // ③：未知 flag 先拒再执行业务（放已移除/已拒 flag 点名之后——那些 flag 有更明确的
        // 语义点名，不允许被通用「未知 flag」顶掉）
        assertKnownFlags('set-state', flags);
        const usedIdentity = flags.identity !== undefined;
        // F-F：receipt 由 CLI 读文件 → 解析对象（文件级错误 → READY_RECEIPT，等同参数错误不落事件）
        let readyReceipt;
        if (flags['ready-receipt'] !== undefined) {
          readyReceipt = readReadyReceipt(resolve(flags['ready-receipt']));
        }
        let prOpenReceipt;
        if (flags['pr-open-receipt'] !== undefined) {
          prOpenReceipt = readPrOpenReceipt(resolve(flags['pr-open-receipt']));
        }
        let cleanupReceipt;
        if (flags['cleanup-receipt'] !== undefined) {
          cleanupReceipt = readCleanupReceipt(resolve(flags['cleanup-receipt']));
        }
        let archiveReceipt;
        if (flags['archive-receipt'] !== undefined) {
          archiveReceipt = readArchiveReceipt(resolve(flags['archive-receipt']));
        }
        setState({
          ledgerPath,
          now: flags.now,
          group: flags.group,
          to: flags.to,
          workerLabel: flags['worker-label'],
          tipSha: flags['tip-sha'],
          event: flags.event,
          detail: flags.detail,
          identity: usedIdentity ? flags.identity ?? undefined : undefined,
          phase: flags.phase,
          wave: flags.wave === undefined ? undefined : Number(flags.wave),
          integrate: flags.integrate,
          readyReceipt,
          memSnapshot: flags['mem-snapshot'],
          prOpenReceipt,
          cleanupReceipt,
          archiveReceipt,
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
        assertKnownFlags('render-packet', flags); // ③：未知 flag 先拒（放身份字段点名之后）
        const out = renderPacket({
          ledgerPath,
          group: flags.group,
          manifestPath: flags.manifest,
          now: flags.now,
        });
        process.stdout.write(out);
        return 0;
      }
      case 'record-delivery': {
        assertKnownFlags('record-delivery', flags); // ③：未知 flag 先拒
        recordDelivery({
          ledgerPath,
          group: flags.group,
          payload: flags.payload,
          now: flags.now,
        });
        console.log(`record-delivery: group ${flags.group} 交卷已入账（version+1）`);
        return 0;
      }
      case 'note-event': {
        assertKnownFlags('note-event', flags);
        noteEvent({
          ledgerPath,
          now: flags.now,
          event: flags.event,
          detail: flags.detail,
        });
        console.log(`note-event: ${flags.event} 已入账（version+1）`);
        return 0;
      }
      case 'staleness': {
        assertKnownFlags('staleness', flags); // ③：未知 flag 先拒（只读命令同样 exact）
        const out = staleness({ ledgerPath, now: flags.now });
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
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

// main-module guard：作为 CLI 入口才执行主流程；被测试 import（LedgerError/readLedger 等）时静默返回。
// import.meta.url 已被 ESM loader 规范化（symlink/逻辑路径解析后的真实路径），而 process.argv[1] 是调用方
// 原样路径——macOS 上 /tmp → /private/tmp、/var → /private/var 这类 symlink 会让两者恒不相等（旧实现
// resolve(argv[1]) 不解析 symlink），guard 静默不执行（exit 0 + 零输出，与写成功长得一模一样，台账操作
// 直接变假）。必须先 realpathSync 归一 argv[1] 再比较。
// 分叉语义：argv[1] 缺失（node --input-type=module --eval 'import ...' 纯 import，无入口文件）→ 不可能是
// CLI 调用，静默返回——run-ledger 必须支持被 import，库被加载不得杀死宿主进程；
// argv[1] 存在但 realpath 失败 → fail-closed exit 2 点名（本该是 CLI 却无法验证，不静默假绿）。
// 与 mem-probe.mjs / selfcheck.mjs / run-tests.mjs 同型（四处各自持有组F-1 回归测试；漂移预警：改一处
// 必须同步其余三处）。
if (process.argv[1] !== undefined) {
  let entryReal;
  try {
    entryReal = realpathSync(process.argv[1]);
  } catch (e) {
    console.error(`run-ledger: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}

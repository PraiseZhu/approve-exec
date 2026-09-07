#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs, fail, isMain, writeJsonAtomic, readJson, nowIso, hashObject } from '../lib/common.mjs';
import { loadMiniWatchConfig, miniHost, assertAutoMergeDisabled } from '../lib/mini-watch-config.mjs';
import { evaluate, emptyCursors, validateLeadSignal, validateSnapshot, cloudReady, OWNER_STANDING_AUTH } from './gate.mjs';
import { stateFileName, migrateAllLegacyStateFiles, STATE_FILE_NAME_RE, unregisterPr, identityMatches } from './register.mjs';
import { withLock } from '../lib/state-lock.mjs';

const MINI = miniHost();
const FINALIZE_ENTRY = '/Users/praise/AI-Agent/Claude/capabilities/source/approve-exec-src/scripts/pr-watch/finalize.mjs';
export const MINI_WATCH_PROVIDER = MINI.provider_id;
export const MINI_WATCH_MODEL = MINI.model;
export const MINI_WATCH_AGENT = MINI.agent_kind;
export const MINI_WATCH_EFFORT = MINI.effort;
export const OLD_WATCH_SCHEDULE_IDS = Object.freeze([
  ...loadMiniWatchConfig().old_schedule_ids_blocklist,
]);
export const CREATE_CLAIM_TTL_MS = 10 * 60_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function claimAgeMs(claim, nowMs) {
  if (!claim || typeof claim !== 'object') return null;
  const time = Date.parse(claim.claimed_at);
  if (!Number.isFinite(time)) return null;
  return nowMs - time;
}

export function createClaimStale(claim, { nowMs = Date.now(), ttlMs = CREATE_CLAIM_TTL_MS } = {}) {
  const age = claimAgeMs(claim, nowMs);
  if (age === null || age < ttlMs) return false;
  if (!Number.isInteger(claim.owner_pid) || claim.owner_pid <= 0) return false;
  return !pidAlive(claim.owner_pid);
}

function runSnapshot(snapshotCmd, owner, repo, pr) {
  const parts = snapshotCmd.trim().split(/\s+/).map((part) =>
    part.replace('{owner}', owner).replace('{repo}', repo).replace('{pr}', String(pr)));
  return JSON.parse(execFileSync(parts[0], parts.slice(1), { encoding: 'utf8' }));
}

function statePath(stateDir, owner, repo, prNumber) {
  return join(stateDir, stateFileName(owner, repo, prNumber));
}

function errorRecord(state, phase, error) {
  return {
    owner: state?.owner,
    repo: state?.repo,
    pr: state?.pr_number,
    phase,
    error: error instanceof Error ? error.message : String(error),
  };
}

function signalAuth(signal) {
  return (signal?.standing_authorization ?? signal?.owner_standing_auth) === OWNER_STANDING_AUTH;
}

function feedbackIds({ signals = [], newItems = {} } = {}) {
  const ids = [];
  for (const review of newItems.reviews ?? []) {
    if (typeof review?.id === 'string' && review.id) ids.push(review.id);
  }
  for (const comment of newItems.comments ?? []) {
    if (typeof comment?.id === 'string' && comment.id) ids.push(comment.id);
  }
  if (signals.includes('ci-red')) ids.push('ci-red');
  if (signals.includes('conflict')) ids.push('conflict');
  return [...new Set(ids)];
}

function addedCursorIds(before, after, key) {
  const seen = new Set(before?.[key] ?? []);
  return (after?.[key] ?? []).filter((id) => !seen.has(id));
}

function pendingFeedbackIds(state, pending) {
  if (Array.isArray(pending?.feedback_ids)) return [...new Set(pending.feedback_ids)];
  const before = state?.cursors ?? emptyCursors();
  const after = pending?.next_cursors ?? {};
  const ids = [
    ...addedCursorIds(before, after, 'review_ids'),
    ...addedCursorIds(before, after, 'comment_ids'),
  ];
  if (after.ci_red_key && after.ci_red_key !== before.ci_red_key) ids.push('ci-red');
  if (after.conflict_sha && after.conflict_sha !== before.conflict_sha) ids.push('conflict');
  return [...new Set(ids)];
}

function postFixEntries(state) {
  if (Array.isArray(state?.post_fix_pending)) return state.post_fix_pending;
  return state?.post_fix_pending ? [state.post_fix_pending] : [];
}

function validEvidenceValue(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(validEvidenceValue);
  if (!value || typeof value !== 'object') return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, item]) => key.trim().length > 0 && validEvidenceValue(item));
}

function validEvidence(evidence) {
  return Array.isArray(evidence) && evidence.length > 0 && evidence.every(validEvidenceValue);
}

export function planDispatch({ decision, state, signals, newItems, watchConfig, gatewayAvailable, snapshot, stateDir } = {}) {
  assertAutoMergeDisabled(watchConfig);
  if (decision === 'none' || decision === 'blocked-external') return null;
  if (decision === 'terminal') {
    return { action: 'unregister', owner: state.owner, repo: state.repo, pr: state.pr_number };
  }
  if (decision !== 'actionable') return null;
  const lead = validateLeadSignal(state);
  if (!lead.valid) {
    const error = new Error('lead signal 无效: ' + lead.errors.join('；'));
    error.code = 'LEAD_SIGNAL_INVALID';
    throw error;
  }
  if (state.cloud_signal_id && state.cloud_signal_id !== lead.signal.signal_id) {
    const error = new Error('lead_signal.signal_id 在盯梢期间发生变化，拒绝换授权');
    error.code = 'LEAD_SIGNAL_CHANGED';
    throw error;
  }
  if (!signalAuth(lead.signal)) {
    const error = new Error('lead signal 未授权 PR_PUSH_AND_REPLY');
    error.code = 'LEAD_AUTH_MISSING';
    throw error;
  }
  if (gatewayAvailable === false) {
    const error = new Error('Mini host gateway 不可用');
    error.code = 'HOST_GATEWAY_MISSING';
    throw error;
  }
  const sessionId = typeof state.session_id === 'string' && state.session_id.length > 0
    ? state.session_id
    : null;
  const headSha = snapshot?.head_sha || state.cloud_head_sha || lead.signal.head_sha;
  return {
    action: sessionId ? 'jump' : 'create',
    wake_kind: sessionId ? 'jump' : 'create',
    owner: state.owner,
    repo: state.repo,
    pr: state.pr_number,
    state_dir: stateDir,
    branch: state.branch,
    push_repo: state.push_repo ?? null,
    push_remote: state.push_remote,
    head_sha: headSha,
    draft: false,
    session_id: sessionId,
    signals,
    newItems,
    feedback_ids: feedbackIds({ signals, newItems }),
    lead_signal: {
      signal_id: lead.signal.signal_id,
      lead_session_id: lead.signal.lead_session_id,
      owner_session_id: lead.signal.owner_session_id,
      owner_title: lead.signal.owner_title,
      head_sha: lead.signal.head_sha,
      issued_at: lead.signal.issued_at,
      standing_authorization: lead.signal.standing_authorization ?? lead.signal.owner_standing_auth,
    },
    title: lead.signal.owner_title,
    provider_id: MINI.provider_id,
    model: MINI.model,
    agent_kind: MINI.agent_kind,
    effort: MINI.effort,
  };
}

export function buildDispatchMessage(plan) {
  if (!plan?.lead_signal || (plan.lead_signal.standing_authorization ?? plan.lead_signal.owner_standing_auth) !== OWNER_STANDING_AUTH) {
    throw new Error('拒绝构造无 PR_PUSH_AND_REPLY 授权的 Mini 派发包');
  }
  const bodies = [];
  for (const review of plan.newItems?.reviews ?? []) bodies.push('review ' + review.id + ': ' + review.body);
  for (const comment of plan.newItems?.comments ?? []) bodies.push('comment ' + comment.id + ': ' + comment.body);
  if (plan.newItems?.ci_failing?.length) bodies.push('ci failing[]: ' + JSON.stringify(plan.newItems.ci_failing));
  if (typeof plan.dispatch_id !== 'string' || plan.dispatch_id.length === 0) {
    throw new Error('派发包缺 dispatch_id；必须先 prepare outbox 再构造消息');
  }
  return [
    'PR ' + plan.owner + '/' + plan.repo + '#' + plan.pr + ' 有新云端反馈（' + (plan.signals ?? []).join('/') + '）。',
    'DISPATCH_ID: ' + plan.dispatch_id,
    'PR_REPO: ' + plan.owner + '/' + plan.repo,
    'PR_BRANCH: ' + plan.branch,
    'PR_PUSH_REPO: ' + (plan.push_repo ?? ''),
    'PR_PUSH_REMOTE: ' + plan.push_remote,
    'PR_HEAD_SHA: ' + plan.head_sha,
    'PR_STATE: OPEN',
    'PR_DRAFT: false',
    '--until-sc',
    'OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY',
    '用 goal skill 执行。',
    'kind: pr-fix；触发：从反馈提炼 SC。',
    '第一步：从宿主身份/回执取得实际 Mini session ID；绑定迟到时等待，不改代码。然后调用 scripts/pr-watch/prepare-worktree.mjs --state-dir ' + plan.state_dir + ' --owner ' + plan.owner + ' --repo ' + plan.repo + ' --pr ' + plan.pr + ' --session-id ' + (plan.session_id || '<宿主回执绑定后的实际 session id>') + ' --head ' + plan.head_sha + '，由 Mini runtime 私有 repos/worktrees 入口验证 remote、branch、head 并准备独立 worktree；禁止自报 session ID、猜目录或在当前 cwd 改代码。',
    'SC_IDS: ' + (plan.feedback_ids ?? feedbackIds(plan)).join(','),
    '接收方先把反馈 SC 保存到 ' + plan.state_dir + '/receipts/' + (plan.dispatch_id || '<dispatch_id>') + '.json，JSON 含 dispatch_id、session_id、head_sha、sc_receipt:{sc_id,recorded_at} 和 scs:[{id,verify}]，且 scs.id 必须精确覆盖 SC_IDS；随后用实际 session ID 执行 session-watch.mjs ack-received --state-dir <同一目录> --owner <owner> --repo <repo> --pr <pr> --session-id <实际ID> --dispatch-id <本次ID> --head <本次SHA> --receipt @<该JSON路径>。该 ack 只表示接收 SC，不表示修复完成。',
    'ARTIFACT_COMPLETION_RECEIPT_REQUIRED: head_sha',
    '完成回执必须包含 artifact head_sha；不得把完成回执当作 merge。',
    '修复完成后另存 SC PASS 输入 JSON（dispatch_id、session_id、head_sha、scs:[{id,status:PASS,evidence:[非空证据]}]），不得覆盖已接收的原 SC 文件。运行 node ' + FINALIZE_ENTRY + ' --state-dir <同一目录> --owner <owner> --repo <repo> --pr <pr> --session-id <实际ID> --dispatch-id <本次ID> --feedback-head <派发SHA> --receipt @<SC-PASS输入路径>。该入口校验当前PR、分支、remote与全部SC后普通push，独立生成 receipts/<dispatch_id>.post-fix.json；不得自行编写finalizer输出。无代码改动时允许same-head no_changes:true，禁止空commit。随后执行 session-watch.mjs ack-post-fix --state-dir <同一目录> --owner <owner> --repo <repo> --pr <pr> --session-id <实际ID> --dispatch-id <本次ID> --head <完成SHA> --receipt @<finalizer输出路径>。禁止直接 git push；只有用户对指定PR当次明确授权才允许合并，当前流程不合并。',
    ...bodies,
  ].join('\n');
}

export function sessionsDispatchParams(plan) {
  const params = {
    message: buildDispatchMessage(plan),
    title: plan.title,
  };
  if (plan.session_id) params.target_session_id = plan.session_id;
  return params;
}

export function bindSessionId({ stateDir, owner, repo, prNumber, sessionId, claimId = null }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('bindSessionId 缺 sessionId');
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('bindSessionId 身份不符');
    if (claimId !== null && state.create_claim?.claim_id !== claimId) throw new Error('bindSessionId claim 不符');
    if (state.session_id && state.session_id !== sessionId) throw new Error('已绑定其他 session，拒绝改绑');
    const next = { ...state, session_id: sessionId, create_pending: false, create_claim: null };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function claimCreate({ stateDir, owner, repo, prNumber, nowMs = Date.now(), ownerPid = process.pid }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('claimCreate 身份不符');
    if (typeof state.session_id === 'string' && state.session_id.length > 0) return { claimed: false, session_id: state.session_id, state };
    if (state.create_pending === true) {
      const claim = state.create_claim;
      const detail = claim?.claim_id ? 'claim ' + claim.claim_id + ' 结果未完成绑定' : '旧版 claim 缺少可恢复凭据';
      throw new Error('已有 create 在途（' + detail + '，拒绝并发再建）');
    }
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error('claimCreate ownerPid 非法');
    const next = {
      ...state,
      create_pending: true,
      create_claim: {
        claim_id: randomBytes(12).toString('hex'),
        claimed_at: new Date(nowMs).toISOString(),
        owner_pid: ownerPid,
      },
    };
    writeJsonAtomic(file, next);
    return { claimed: true, session_id: null, state: next };
  });
}

export function releaseCreateClaim({ stateDir, owner, repo, prNumber, claimId = null }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (state.create_pending !== true && !state.create_claim) return state;
    if (claimId !== null && state.create_claim?.claim_id !== claimId) return state;
    const next = { ...state, create_pending: false, create_claim: null };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function preparePendingDispatch({ stateDir, owner, repo, prNumber, pending }) {
  if (!pending || typeof pending !== 'object') throw new Error('preparePendingDispatch 缺 pending');
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('preparePendingDispatch 身份不符');
    if (state.pending_dispatch) return { prepared: false, state, pending: state.pending_dispatch };
    const nextPending = {
      ...pending,
      dispatch_id: pending.dispatch_id || randomBytes(12).toString('hex'),
      status: 'prepared',
      prepared_at: pending.prepared_at || nowIso(),
      host_receipt: null,
      feedback_ids: Array.isArray(pending.feedback_ids) ? [...new Set(pending.feedback_ids)] : pending.feedback_ids,
    };
    const next = { ...state, pending_dispatch: nextPending };
    writeJsonAtomic(file, next);
    return { prepared: true, state: next, pending: nextPending };
  });
}

function receiptStatus(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'unknown';
  const status = receipt.status || receipt.state || receipt.delivery_status;
  if (typeof status === 'string') {
    const normalized = status.toLowerCase();
    if (['queued', 'pending', 'accepted', 'submitted', 'in_progress', 'running'].includes(normalized)) return 'queued';
    if (['success', 'succeeded', 'done', 'delivered', 'completed', 'complete'].includes(normalized)) return 'delivered';
    return 'host-' + normalized;
  }
  return 'unknown';
}

export function isDispatchCompleted(receipt) {
  return false;
}

function receiptSessionId(receipt) {
  for (const key of ['target_session_id', 'session_id', 'targetSessionId']) {
    if (typeof receipt?.[key] === 'string' && receipt[key].length > 0) return receipt[key];
  }
  return null;
}

export function recordDispatchReceipt({ stateDir, owner, repo, prNumber, dispatchId, receipt }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('recordDispatchReceipt 身份不符');
    const pending = state.pending_dispatch;
    if (!pending || pending.dispatch_id !== dispatchId) throw new Error('recordDispatchReceipt 找不到匹配 outbox');
    const status = receiptStatus(receipt);
    const sessionId = receiptSessionId(receipt);
    if (state.session_id && sessionId && state.session_id !== sessionId) throw new Error('回执 session_id 与名册不一致');
    const nextPending = { ...pending, status, host_receipt: receipt, receipt_at: nowIso(), host_session_id: sessionId };
    const next = {
      ...state,
      ...(sessionId ? { session_id: sessionId, create_pending: false, create_claim: null } : {}),
      pending_dispatch: nextPending,
    };
    writeJsonAtomic(file, next);
    return { bound: Boolean(sessionId), status, state: next, pending: nextPending, session_id: sessionId || state.session_id || null };
  });
}

export function settleDispatch(args) {
  return recordDispatchReceipt(args);
}

function validScReceipt({ state, stateDir, receipt, pending, sessionId, dispatchId, headSha }) {
  const scReceipt = receipt?.sc_receipt ?? receipt?.sc ?? receipt?.received_sc;
  if (!scReceipt || typeof scReceipt !== 'object' || Array.isArray(scReceipt)) throw new Error('ack-received 缺已落盘 sc_receipt');
  const scId = scReceipt.sc_id ?? scReceipt.id;
  if (typeof scId !== 'string' || scId.length === 0) throw new Error('ack-received 缺 sc_receipt.sc_id');
  if (typeof scReceipt.recorded_at !== 'string' || Number.isNaN(Date.parse(scReceipt.recorded_at))) throw new Error('ack-received 缺有效 sc_receipt.recorded_at');
  if (receipt.dispatch_id !== dispatchId) throw new Error('ack-received dispatch_id 不一致');
  if (receipt.session_id !== sessionId) throw new Error('ack-received session_id 不一致');
  if (receipt.head_sha !== headSha) throw new Error('ack-received head_sha 不一致');
  if (scReceipt.head_sha && scReceipt.head_sha !== headSha) throw new Error('sc_receipt.head_sha 不一致');
  if (!/^[a-f0-9]{24}$/.test(dispatchId)) throw new Error('dispatch_id 非法');
  const recorded = readJson(join(stateDir, 'receipts', dispatchId + '.json'));
  const expectedIds = pendingFeedbackIds(state, pending);
  const recordedScs = recorded.scs;
  const recordedIds = Array.isArray(recordedScs) ? recordedScs.map((entry) => entry?.id) : [];
  const receiptIds = Array.isArray(receipt.scs) ? receipt.scs.map((entry) => entry?.id) : null;
  const exactIds = (ids) => ids.length === expectedIds.length
    && new Set(ids).size === ids.length
    && ids.every((id) => typeof id === 'string' && expectedIds.includes(id));
  if (recorded.session_id !== sessionId || recorded.dispatch_id !== dispatchId || recorded.head_sha !== headSha
    || recorded.sc_receipt?.sc_id !== scId || !exactIds(recordedIds)
    || !Array.isArray(recordedScs)
    || recordedScs.some((entry) => typeof entry.id !== 'string' || !entry.id || typeof entry.verify !== 'string' || !entry.verify)
    || (receiptIds && (!exactIds(receiptIds) || receiptIds.some((id, index) => id !== recordedIds[index])))) {
    throw new Error('ack-received 没有本次反馈的真实 SC 清单');
  }
  scReceipt.sc_digest = hashObject(recorded);
  return scReceipt;
}

export function acknowledgeReceived({ stateDir, owner, repo, prNumber, sessionId, dispatchId, headSha, receipt }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('acknowledgeReceived 身份不符');
    if (state.session_id !== sessionId) throw new Error('ack-received 必须使用宿主返回的真实 session_id');
    const pending = state.pending_dispatch;
    if (!pending || pending.dispatch_id !== dispatchId) throw new Error('ack-received 找不到匹配 pending_dispatch');
    if (pending.head_sha !== headSha) throw new Error('ack-received head_sha 与 pending 不一致');
    const expectedIds = pendingFeedbackIds(state, pending);
    const sourceScPath = join(stateDir, 'receipts', dispatchId + '.json');
    const postFixReceiptPath = join(stateDir, 'receipts', dispatchId + '.post-fix.json');
    const scReceipt = validScReceipt({ state, stateDir, receipt, pending, sessionId, dispatchId, headSha });
    const postFixPending = postFixEntries(state).filter((entry) => entry.dispatch_id !== pending.dispatch_id);
    postFixPending.push({
      dispatch_id: pending.dispatch_id,
      session_id: sessionId,
      base_head_sha: pending.head_sha,
      feedback_ids: expectedIds,
      source_sc_path: sourceScPath,
      source_sc_digest: scReceipt.sc_digest,
      post_fix_receipt_path: postFixReceiptPath,
      sc_id: scReceipt.sc_id ?? scReceipt.id,
      received_at: nowIso(),
    });
    const next = {
      ...state,
      cursors: pending.next_cursors,
      pending_dispatch: null,
      create_pending: false,
      create_claim: null,
      cloud_head_sha: pending.head_sha,
      post_fix_pending: postFixPending,
      last_dispatch_ack: {
        dispatch_id: pending.dispatch_id,
        status: 'sc-received',
        head_sha: pending.head_sha,
        sc_id: scReceipt.sc_id ?? scReceipt.id,
        feedback_ids: expectedIds,
        sc_digest: scReceipt.sc_digest,
        at: nowIso(),
      },
    };
    writeJsonAtomic(file, next);
    return { acknowledged: true, state: next, session_id: sessionId, dispatch_id: dispatchId };
  });
}

export function acknowledgePostFix({ stateDir, owner, repo, prNumber, sessionId, dispatchId, headSha, receipt }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('acknowledgePostFix 身份不符');
    if (state.session_id !== sessionId) throw new Error('ack-post-fix 必须使用宿主返回的真实 session_id');
    const pending = postFixEntries(state).find((entry) => entry.dispatch_id === dispatchId);
    const fallback = state.last_dispatch_ack?.dispatch_id === dispatchId && state.last_dispatch_ack.status === 'sc-received'
      ? {
        dispatch_id: dispatchId,
        session_id: sessionId,
        base_head_sha: state.last_dispatch_ack.head_sha,
        feedback_ids: state.last_dispatch_ack.feedback_ids,
        source_sc_path: join(stateDir, 'receipts', dispatchId + '.json'),
        source_sc_digest: state.last_dispatch_ack.sc_digest,
        post_fix_receipt_path: join(stateDir, 'receipts', dispatchId + '.post-fix.json'),
      }
      : null;
    const expected = pending ?? fallback;
    if (!expected) throw new Error('ack-post-fix 找不到待确认的 SC 接收记录');
    if (!receipt || receipt.dispatch_id !== dispatchId || receipt.session_id !== sessionId || receipt.head_sha !== headSha) {
      throw new Error('ack-post-fix 回执身份不一致');
    }
    if (!/^[a-f0-9]{40}$/.test(headSha)) {
      throw new Error('ack-post-fix head_sha 非法');
    }
    if (receipt.base_head_sha !== expected.base_head_sha || receipt.artifact_head_sha !== headSha || receipt.finalizer_entry !== FINALIZE_ENTRY) {
      throw new Error('ack-post-fix finalizer 或 base head 不符合契约');
    }
    if (typeof receipt.no_changes !== 'boolean' || (headSha === expected.base_head_sha ? receipt.no_changes !== true : receipt.no_changes !== false)) {
      throw new Error('ack-post-fix no_changes 与 head_sha 不一致');
    }
    if (receipt.empty_commit === true) throw new Error('ack-post-fix 禁止空 commit');
    const recorded = readJson(expected.post_fix_receipt_path);
    if (hashObject(recorded) !== hashObject(receipt)
      || recorded.dispatch_id !== dispatchId || recorded.session_id !== sessionId || recorded.head_sha !== headSha) {
      throw new Error('ack-post-fix 没有匹配的独立 post-fix 回执');
    }
    const source = readJson(expected.source_sc_path);
    const sourceIds = Array.isArray(source.scs) ? source.scs.map((entry) => entry?.id) : [];
    const finalScs = recorded.scs;
    const expectedIds = expected.feedback_ids ?? [];
    const exactIds = (ids) => ids.length === expectedIds.length
      && new Set(ids).size === ids.length
      && ids.every((id) => typeof id === 'string' && expectedIds.includes(id));
    if (recorded.source_sc_digest !== expected.source_sc_digest || hashObject(source) !== expected.source_sc_digest
      || source.dispatch_id !== dispatchId || source.session_id !== sessionId
      || sourceIds.some((id, index) => id !== expectedIds[index]) || !exactIds(sourceIds)
      || !Array.isArray(finalScs) || !exactIds(finalScs.map((entry) => entry?.id))
      || finalScs.some((entry) => entry?.status !== 'pass' || !validEvidence(entry.evidence))) {
      throw new Error('ack-post-fix SC source digest、集合或 PASS evidence 不符合契约');
    }
    const next = {
      ...state,
      post_fix_pending: postFixEntries(state).filter((entry) => entry.dispatch_id !== dispatchId),
      cloud_head_sha: headSha,
      last_post_fix_ack: { dispatch_id: dispatchId, base_head_sha: expected.base_head_sha, head_sha: headSha, receipt_digest: hashObject(recorded), at: nowIso() },
    };
    writeJsonAtomic(file, next);
    return { acknowledged: true, state: next, session_id: sessionId, dispatch_id: dispatchId, head_sha: headSha };
  });
}

export function persistCursors({ stateDir, owner, repo, prNumber, cursors }) {
  if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors)) throw new Error('persistCursors 缺 cursors');
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('persistCursors 身份不符');
    if (state.pending_dispatch) throw new Error('存在未确认 outbox，拒绝直接推进游标');
    const next = { ...state, cursors };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function acknowledgeFirstScan({ stateDir, owner, repo, prNumber, at = nowIso() }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('acknowledgeFirstScan 身份不符');
    if (state.first_scan_ack) return state;
    const next = { ...state, first_scan_ack: at };
    writeJsonAtomic(file, next);
    return next;
  });
}

function recordCloudObservation({ stateDir, owner, repo, prNumber, signalId, headSha }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('recordCloudObservation 身份不符');
    if (state.cloud_signal_id && state.cloud_signal_id !== signalId) throw new Error('lead_signal.signal_id 发生变化');
    const next = {
      ...state,
      cloud_signal_id: state.cloud_signal_id || signalId,
      cloud_head_sha: headSha,
      cloud_last_seen_at: nowIso(),
    };
    if (state.cloud_head_sha !== headSha || state.cloud_signal_id !== signalId) writeJsonAtomic(file, next);
    return next;
  });
}

function invalidateCloudReady({ stateDir, owner, repo, prNumber }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('invalidateCloudReady 身份不符');
    if (!state.cloud_ready) return state;
    const next = { ...state, cloud_ready: null };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function markCloudReady({ stateDir, owner, repo, prNumber, snapshot }) {
  const file = statePath(stateDir, owner, repo, prNumber);
  return withLock(file + '.lock', () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) throw new Error('markCloudReady 身份不符');
    if (!validateSnapshot(snapshot).cloud_ready || state.pending_dispatch || postFixEntries(state).length) {
      throw new Error('尚有未完成反馈或快照门禁未通过，不能标记 cloud_ready');
    }
    const marker = {
      head_sha: snapshot.head_sha,
      ci_green: true,
      review_complete: true,
      unresolved_review_count: 0,
      draft: false,
      marked_at: nowIso(),
    };
    const next = { ...state, cloud_ready: marker };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function scanWatch({ stateDir, snapshotCmd, hmacKey = null, gatewayAvailable } = {}) {
  const result = { scanned: 0, dispatches: [], terminals: [], cloud_ready: [], errors: [], observed: [] };
  if (!existsSync(stateDir)) return result;
  migrateAllLegacyStateFiles(stateDir, null);
  const files = readdirSync(stateDir).filter((file) =>
    STATE_FILE_NAME_RE.test(file) && !file.startsWith('manifest-') && !file.startsWith('receipt-'));
  result.scanned = files.length;
  for (const fileName of files) {
    let state;
    try {
      state = JSON.parse(readFileSync(join(stateDir, fileName), 'utf8'));
    } catch (error) {
      result.errors.push({ file: fileName, phase: 'read-state', error: error.message });
      continue;
    }
    if (stateFileName(state.owner, state.repo, state.pr_number) !== fileName) {
      result.errors.push(errorRecord(state, 'identity', '状态文件名与内容身份不一致'));
      continue;
    }
    result.observed.push({ owner: state.owner, repo: state.repo, pr: state.pr_number });
    let snapshot;
    try {
      snapshot = runSnapshot(snapshotCmd, state.owner, state.repo, state.pr_number);
    } catch (error) {
      try {
        state = invalidateCloudReady({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number });
      } catch (clearError) {
        result.errors.push(errorRecord(state, 'cloud-ready-invalidation', clearError));
      }
      result.errors.push(errorRecord(state, 'snapshot', error));
      continue;
    }
    const snapshotCheck = validateSnapshot(snapshot);
    if (snapshot.state === 'merged' || snapshot.state === 'closed') {
      result.terminals.push({ action: 'unregister', owner: state.owner, repo: state.repo, pr: state.pr_number });
      continue;
    }
    if (!snapshotCheck.valid) {
      try {
        state = invalidateCloudReady({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number });
      } catch (error) {
        result.errors.push(errorRecord(state, 'cloud-ready-invalidation', error));
      }
      result.errors.push({ ...errorRecord(state, 'snapshot-validation', snapshotCheck.errors.join('；')), details: snapshotCheck.errors });
      continue;
    }
    try {
      if (state.cloud_ready && (state.cloud_ready.head_sha !== snapshot.head_sha || state.pending_dispatch || postFixEntries(state).length)) {
        state = invalidateCloudReady({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number });
      }
      acknowledgeFirstScan({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number });
    } catch (error) {
      result.errors.push(errorRecord(state, 'first-scan-ack', error));
      continue;
    }
    const lead = validateLeadSignal(state);
    if (!lead.valid) {
      result.errors.push({ ...errorRecord(state, 'lead-signal', lead.errors.join('；')), details: lead.errors });
      continue;
    }
    if (state.cloud_signal_id && state.cloud_signal_id !== lead.signal.signal_id) {
      result.errors.push(errorRecord(state, 'lead-signal', 'lead_signal.signal_id 在盯梢期间发生变化'));
      continue;
    }
    if (!state.cloud_head_sha && lead.signal.head_sha !== snapshot.head_sha) {
      result.errors.push(errorRecord(state, 'head', '首次云端快照 head_sha 与 lead_signal.head_sha 不一致'));
      continue;
    }
    if (state.pending_dispatch) {
      const pendingError = state.pending_dispatch.head_sha !== snapshot.head_sha
        ? '存在未确认 outbox 且当前 head_sha 已变化，拒绝重派并保留 pending'
        : '存在未确认 outbox，等待宿主 completed 回执，不重复派发';
      result.errors.push(errorRecord(state, 'outbox', pendingError));
      continue;
    }
    if (state.create_pending === true) {
      result.errors.push(errorRecord(state, 'create-claim', '存在无 outbox 的 create claim，拒绝恢复性重复 create'));
      continue;
    }
    try {
      recordCloudObservation({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number, signalId: lead.signal.signal_id, headSha: snapshot.head_sha });
    } catch (error) {
      result.errors.push(errorRecord(state, 'cloud-observation', error));
      continue;
    }
    const evaluated = evaluate(state.cursors ?? emptyCursors(), snapshot, { hmacKey });
    const hasNewFeedback = evaluated.signals.length > 0 || Object.values(evaluated.newItems).some((items) => items.length);
    const isCloudReady = snapshotCheck.cloud_ready && cloudReady(snapshot);
    if (state.cloud_ready && (!isCloudReady || state.cloud_ready.head_sha !== snapshot.head_sha || hasNewFeedback)) {
      try {
        state = invalidateCloudReady({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number });
      } catch (error) {
        result.errors.push(errorRecord(state, 'cloud-ready-invalidation', error));
        continue;
      }
    }
    if (!hasNewFeedback && isCloudReady) {
      try {
        const marker = markCloudReady({ stateDir, owner: state.owner, repo: state.repo, prNumber: state.pr_number, snapshot });
        result.cloud_ready.push({ action: 'cloud-ready', owner: marker.owner, repo: marker.repo, pr: marker.pr_number, marker: marker.cloud_ready });
      } catch (error) {
        result.errors.push(errorRecord(state, 'cloud-ready', error));
      }
      continue;
    }
    let plan;
    try {
      plan = planDispatch({ decision: evaluated.decision, state, signals: evaluated.signals, newItems: evaluated.newItems, watchConfig: undefined, gatewayAvailable, snapshot, stateDir });
    } catch (error) {
      result.errors.push(errorRecord(state, 'plan', error));
      continue;
    }
    if (!plan) continue;
    plan.next_cursors = evaluated.cursors;
    plan.feedback_ids = feedbackIds(evaluated);
    result.dispatches.push(plan);
  }
  return result;
}

export function applyWatchRound({ stateDir, snapshotCmd, hmacKey = null, dispatchFn, unregisterFn = unregisterPr, gatewayAvailable } = {}) {
  if (typeof dispatchFn !== 'function') throw new Error('applyWatchRound 缺 dispatchFn');
  const scan = scanWatch({ stateDir, snapshotCmd, hmacKey, gatewayAvailable });
  const applied = [];
  const errors = [...scan.errors];
  for (const plan of scan.dispatches) {
    try {
      let livePlan = { ...plan };
      let createClaimId = null;
      if (livePlan.action === 'create') {
        const claim = claimCreate({ stateDir, owner: livePlan.owner, repo: livePlan.repo, prNumber: livePlan.pr });
        if (!claim.claimed) {
          if (!claim.session_id) throw new Error('create claim 未返回 session_id');
          livePlan = { ...livePlan, action: 'jump', wake_kind: 'jump', session_id: claim.session_id };
        } else {
          createClaimId = claim.state?.create_claim?.claim_id ?? null;
        }
      }
      const prepared = preparePendingDispatch({
        stateDir,
        owner: livePlan.owner,
        repo: livePlan.repo,
        prNumber: livePlan.pr,
        pending: {
          action: livePlan.action,
          owner: livePlan.owner,
          repo: livePlan.repo,
          pr: livePlan.pr,
          head_sha: livePlan.head_sha,
          signal_id: livePlan.lead_signal.signal_id,
          title: livePlan.title,
          next_cursors: livePlan.next_cursors,
          feedback_ids: livePlan.feedback_ids,
          create_claim_id: createClaimId,
        },
      });
      if (!prepared.prepared) {
        errors.push(errorRecord(livePlan, 'outbox', '并发轮次已持有 pending_dispatch，拒绝重复派发'));
        continue;
      }
      livePlan.dispatch_id = prepared.pending.dispatch_id;
      let receipt;
      try {
        receipt = dispatchFn(sessionsDispatchParams(livePlan)) ?? {};
      } catch (error) {
        errors.push(errorRecord(livePlan, 'host-dispatch', error));
        continue;
      }
      const recorded = recordDispatchReceipt({ stateDir, owner: livePlan.owner, repo: livePlan.repo, prNumber: livePlan.pr, dispatchId: livePlan.dispatch_id, receipt });
      if (!recorded.bound) {
        errors.push(errorRecord(livePlan, 'host-receipt', '宿主回执未返回可绑定 session_id，pending_dispatch 已保留，等待人工恢复'));
        continue;
      }
      applied.push({ ...livePlan, session_id: recorded.session_id, ack_pending: true, host_status: recorded.status });
    } catch (error) {
      errors.push(errorRecord(plan, 'dispatch', error));
    }
  }
  const unregistered = [];
  for (const terminal of scan.terminals) {
    try {
      const out = unregisterFn({ stateDir, owner: terminal.owner, repo: terminal.repo, prNumber: terminal.pr, reason: 'terminal' });
      unregistered.push({ ...terminal, removed: out?.removed !== false });
    } catch (error) {
      errors.push({ ...terminal, phase: 'unregister', error: error.message });
    }
  }
  return { scanned: scan.scanned, dispatches: applied, errors, terminals: scan.terminals, cloud_ready: scan.cloud_ready, unregistered };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'bind') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args['session-id']) fail('bind 参数不完整');
    bindSessionId({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, sessionId: args['session-id'], claimId: args['claim-id'] });
    process.stdout.write('BOUND\n');
  } else if (command === 'persist-cursors') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args.cursors) fail('persist-cursors 参数不完整');
    persistCursors({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, cursors: JSON.parse(args.cursors) });
    process.stdout.write('CURSORS\n');
  } else if (command === 'prepare-dispatch') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args.pending) fail('prepare-dispatch 参数不完整');
    const out = preparePendingDispatch({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, pending: JSON.parse(args.pending) });
    process.stdout.write(JSON.stringify(out) + '\n');
  } else if (command === 'build-dispatch') {
    if (!args.plan) fail('build-dispatch 缺 --plan');
    process.stdout.write(JSON.stringify(sessionsDispatchParams(JSON.parse(args.plan))) + '\n');
  } else if (command === 'record-dispatch' || command === 'ack-dispatch') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args['dispatch-id'] || !args.receipt) fail('ack-dispatch 参数不完整');
    const out = recordDispatchReceipt({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, dispatchId: args['dispatch-id'], receipt: JSON.parse(args.receipt) });
    process.stdout.write(JSON.stringify({ bound: out.bound, status: out.status, session_id: out.session_id }) + '\n');
  } else if (command === 'ack-received') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args['session-id'] || !args['dispatch-id'] || !args.head || !args.receipt) fail('ack-received 参数不完整');
    const receipt = args.receipt.startsWith('@') ? readJson(args.receipt.slice(1)) : JSON.parse(args.receipt);
    const out = acknowledgeReceived({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, sessionId: args['session-id'], dispatchId: args['dispatch-id'], headSha: args.head, receipt });
    process.stdout.write(JSON.stringify({ acknowledged: out.acknowledged, session_id: out.session_id, dispatch_id: out.dispatch_id }) + '\n');
  } else if (command === 'ack-post-fix') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args['session-id'] || !args['dispatch-id'] || !args.head || !args.receipt) fail('ack-post-fix 参数不完整');
    const receipt = args.receipt.startsWith('@') ? readJson(args.receipt.slice(1)) : JSON.parse(args.receipt);
    const out = acknowledgePostFix({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, sessionId: args['session-id'], dispatchId: args['dispatch-id'], headSha: args.head, receipt });
    process.stdout.write(JSON.stringify({ acknowledged: out.acknowledged, session_id: out.session_id, dispatch_id: out.dispatch_id, head_sha: out.head_sha }) + '\n');
  } else if (command === 'unregister') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr) fail('unregister 参数不完整');
    const out = unregisterPr({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, reason: args.reason ?? 'terminal' });
    process.stdout.write(out.removed ? 'UNREGISTERED\n' : 'NOT-FOUND\n');
  } else if (command === 'claim-create') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr) fail('claim-create 参数不完整');
    const out = claimCreate({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, ownerPid: args['owner-pid'] === undefined ? process.pid : Number(args['owner-pid']) });
    process.stdout.write(JSON.stringify({ claimed: out.claimed, session_id: out.session_id, claim_id: out.state?.create_claim?.claim_id ?? null }) + '\n');
  } else if (command === 'release-create') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr) fail('release-create 参数不完整');
    releaseCreateClaim({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, prNumber: args.pr, claimId: args['claim-id'] ?? null });
    process.stdout.write('RELEASED\n');
  } else {
    if (!args['state-dir'] || !args['snapshot-cmd']) fail('需要 --state-dir 与 --snapshot-cmd');
    const out = scanWatch({ stateDir: args['state-dir'], snapshotCmd: args['snapshot-cmd'], hmacKey: process.env.PR_AUTOPILOT_HMAC_KEY ?? null, gatewayAvailable: process.env.AE_WATCH_ALLOW_CREATE === '1' ? true : undefined });
    process.stdout.write(JSON.stringify(out) + '\n');
  }
}

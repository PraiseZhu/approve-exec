#!/usr/bin/env node
// 信号判定 — 计划依据: W-3
// 审②-F7 重写: 指纹改为「按类游标 + exact-head 过滤」，不再用全历史 digest:
//   - review: 只计 commitOid === 当前 head 且 state ∈ {CHANGES_REQUESTED, COMMENTED} 且
//     非 outdated/dismissed 且 node id 不在游标里的新 review
//   - comment: 只计 node id 不在游标里、且非自家 provenance（HMAC 验证）的新评论
//   - ci: 只看当前 head 的红（ci.head_sha 必须等于 snapshot.head_sha）
//   - 旧评论 + head 前进 → 游标已含其 id → 不唤醒（堵「自己 push 重新唤醒旧反馈」）
// decision ∈ none | blocked-external | actionable | terminal
// 游标推进由引擎在 durable ack 后执行（F6），本模块只计算不落盘。
import { readJson, parseArgs, isMain, canonicalJson } from '../lib/common.mjs';
import { verifyMarker } from './provenance.mjs';
import { assertLeadSignalShape } from './lead-signal.mjs';

const HOLD_LABELS = ['hold', 'do-not-merge', 'blocked', 'needs-sign-off'];
export const OWNER_STANDING_AUTH = 'PR_PUSH_AND_REPLY';

// cursors: { review_ids: [], comment_ids: [], ci_red_sha: null, conflict_sha: null }
export function emptyCursors() {
  return { review_ids: [], comment_ids: [], ci_red_sha: null, ci_red_key: null, conflict_sha: null };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateLeadSignal(state) {
  const signal = state?.lead_signal;
  const errors = [];
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    errors.push('缺少 lead_signal');
    return { valid: false, errors, signal: null };
  }
  try {
    assertLeadSignalShape(signal);
  } catch (error) {
    errors.push('lead_signal 完整校验失败: ' + error.message);
  }
  for (const field of ['signal_id', 'group_id', 'repository', 'pr_url', 'branch', 'lead_session_id', 'owner_session_id', 'owner_title', 'head_sha', 'issued_at']) {
    if (!nonEmptyString(signal[field])) errors.push('lead_signal.' + field + ' 缺失或为空');
  }
  if (signal.version !== 1) errors.push('lead_signal.version 必须为 1');
  if (!Number.isSafeInteger(signal.pr_number) || signal.pr_number < 1) errors.push('lead_signal.pr_number 非法');
  if (!Number.isSafeInteger(signal.ledger_version) || signal.ledger_version < 0) errors.push('lead_signal.ledger_version 非法');
  if (!Number.isSafeInteger(signal.assignment_seq) || signal.assignment_seq < 0) errors.push('lead_signal.assignment_seq 非法');
  if (!signal.evidence || typeof signal.evidence !== 'object' || Array.isArray(signal.evidence)) errors.push('lead_signal.evidence 缺失或非法');
  if (!signal.sender || typeof signal.sender !== 'object' || Array.isArray(signal.sender)) errors.push('lead_signal.sender 缺失或非法');
  const authorization = signal.standing_authorization ?? signal.owner_standing_auth;
  if (authorization !== OWNER_STANDING_AUTH) {
    errors.push('lead_signal.standing_authorization 必须为 ' + OWNER_STANDING_AUTH);
  }
  if (state.owner_session_id && signal.owner_session_id !== state.owner_session_id) {
    errors.push('lead_signal.owner_session_id 与状态 owner_session_id 不一致');
  }
  if (signal.lead_session_id === signal.owner_session_id) errors.push('lead_session_id 不得等于 owner_session_id');
  if (signal.issued_at && Number.isNaN(Date.parse(signal.issued_at))) {
    errors.push('lead_signal.issued_at 不是有效时间');
  }
  return { valid: errors.length === 0, errors, signal };
}

export function ciFailureSignature(failing) {
  return canonicalJson(failing ?? []);
}

export function cloudReady(snapshot) {
  return snapshot?.state === 'open'
    && typeof snapshot?.head_sha === 'string'
    && snapshot?.draft === false
    && snapshot?.ci?.green === true
    && snapshot?.ci?.pending === false
    && snapshot?.ci?.blocked === false
    && snapshot?.ci?.head_sha === snapshot.head_sha
    && Array.isArray(snapshot?.ci?.failing)
    && snapshot?.review_complete === true
    && snapshot?.unresolved_review_count === 0
    && snapshot?.mergeable === true;
}

export function validateSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { valid: false, errors: ['snapshot 不是对象'], cloud_ready: false };
  }
  if (snapshot.state !== 'open' && snapshot.state !== 'merged' && snapshot.state !== 'closed') {
    errors.push('snapshot.state 非法: ' + JSON.stringify(snapshot.state));
  }
  if (snapshot.state !== 'merged' && snapshot.state !== 'closed') {
    if (!nonEmptyString(snapshot.head_sha)) errors.push('snapshot.head_sha 缺失或为空');
    if (typeof snapshot.draft !== 'boolean') errors.push('snapshot.draft 缺失或非 boolean');
    else if (snapshot.draft === true) errors.push('PR 仍是 draft，拒绝云端修复派发');
    if (!snapshot.ci || typeof snapshot.ci !== 'object' || Array.isArray(snapshot.ci)) {
      errors.push('snapshot.ci 缺失或非对象');
    } else {
      if (typeof snapshot.ci.green !== 'boolean') errors.push('snapshot.ci.green 缺失或非 boolean');
      if (!Array.isArray(snapshot.ci.failing)) errors.push('snapshot.ci.failing 缺失或非数组');
      if (typeof snapshot.ci.pending !== 'boolean') errors.push('snapshot.ci.pending 缺失或非 boolean');
      if (typeof snapshot.ci.blocked !== 'boolean') errors.push('snapshot.ci.blocked 缺失或非 boolean');
      if (!nonEmptyString(snapshot.ci.head_sha)) errors.push('snapshot.ci.head_sha 缺失或为空');
      if (snapshot.ci.pending === true) errors.push('CI pending，等待取数完成，不派修代码');
      if (snapshot.ci.blocked === true) errors.push('CI blocked，等待解除阻塞，不派修代码');
      if (snapshot.ci.green === false && Array.isArray(snapshot.ci.failing) && snapshot.ci.failing.length === 0) {
        errors.push('CI 为红但 ci.failing[] 为空，拒绝派发不完整反馈');
      }
      if (Array.isArray(snapshot.ci.failing)) {
        for (const item of snapshot.ci.failing) {
          if (item === null || item === undefined || (typeof item === 'string' && item.trim().length === 0)) {
            errors.push('ci.failing[] 含空反馈');
          }
        }
      }
      if (nonEmptyString(snapshot.head_sha) && snapshot.ci.head_sha !== snapshot.head_sha) {
        errors.push('CI head_sha 与 snapshot.head_sha 不一致');
      }
    }
    if (typeof snapshot.review_complete !== 'boolean') errors.push('snapshot.review_complete 缺失或非 boolean');
    if (!Number.isInteger(snapshot.unresolved_review_count) || snapshot.unresolved_review_count < 0) {
      errors.push('snapshot.unresolved_review_count 缺失或非法');
    }
    for (const review of snapshot.reviews ?? []) {
      if (!nonEmptyString(review.id) || /^(?:(?:review|issue):)?(?:undefined|null)$/.test(review.id)) errors.push('review 缺少有效 id');
      if (!nonEmptyString(review.commitOid)) errors.push('review 缺少 commitOid');
      if (review.commitOid === snapshot.head_sha && ['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state)
        && review.dismissed !== true && review.outdated !== true && !nonEmptyString(review.body)) {
        errors.push('review:' + (review.id ?? 'unknown') + ' 缺少完整正文');
      }
    }
    for (const comment of snapshot.comments ?? []) {
      if (!nonEmptyString(comment.id) || /^(?:(?:review|issue):)?(?:undefined|null)$/.test(comment.id)) errors.push('comment 缺少有效 id');
      if (!nonEmptyString(comment.body)) errors.push('issue:' + (comment.id ?? 'unknown') + ' 缺少完整正文');
    }
  }
  return { valid: errors.length === 0, errors, cloud_ready: errors.length === 0 && cloudReady(snapshot) };
}

// snapshot 契约（adapter 归一化 / fixture 同构）:
// { state, head_sha,
//   ci: { green, failing[], head_sha },
//   reviews: [{ id, state, commitOid, outdated?, dismissed?, body }],
//   comments: [{ id, body, author_is_self? }],
//   labels: [], mergeable }
export function evaluate(cursors, snapshot, opts = {}) {
  const hmacKey = opts.hmacKey ?? null;
  cursors = cursors ?? emptyCursors();

  if (snapshot.state === 'merged' || snapshot.state === 'closed') {
    return { decision: 'terminal', cursors, signals: [snapshot.state], newItems: {} };
  }

  const head = snapshot.head_sha;
  const signals = [];
  const newItems = { reviews: [], comments: [], ci_failing: [] };

  // reviews: exact-head + 非 stale + 新 id
  const seenReviews = new Set(cursors.review_ids);
  for (const r of snapshot.reviews ?? []) {
    if (!nonEmptyString(r.id)) continue;
    const cursorId = 'review:' + r.id;
    if (seenReviews.has(cursorId) || seenReviews.has(String(r.id))) continue;
    if (r.outdated === true || r.dismissed === true) continue;
    if (!nonEmptyString(r.commitOid) || r.commitOid !== head) continue; // 缺 head 绑定或旧 head 的 review 不唤醒
    if (!['CHANGES_REQUESTED', 'COMMENTED'].includes(r.state)) continue;
    newItems.reviews.push({ id: cursorId, source_id: String(r.id), body: typeof r.body === 'string' ? r.body : '' });
  }
  if (newItems.reviews.length) signals.push('review');

  // comments: 新 id + 非自家 provenance
  const seenComments = new Set(cursors.comment_ids);
  for (const c of snapshot.comments ?? []) {
    if (!nonEmptyString(c.id)) continue;
    const cursorId = 'issue:' + c.id;
    if (seenComments.has(cursorId) || seenComments.has(String(c.id))) continue;
    if (c.body && verifyMarker(c.body, hmacKey)) continue; // 自家签名评论不算反馈
    newItems.comments.push({ id: cursorId, source_id: String(c.id), body: typeof c.body === 'string' ? c.body : '' });
  }
  if (newItems.comments.length) signals.push('comment');

  // ci: 当前 head 的红，且未对同一红派过活
  const ciKey = head + ':' + ciFailureSignature(snapshot.ci?.failing ?? []);
  if (snapshot.ci && snapshot.ci.green === false && snapshot.ci.head_sha === head && cursors.ci_red_key !== ciKey) {
    signals.push('ci-red');
    newItems.ci_failing = snapshot.ci.failing ?? [];
  }
  // conflict: 同一 head 只唤醒一次
  if (snapshot.mergeable === false && cursors.conflict_sha !== head) {
    signals.push('conflict');
  }

  // 推进后的游标（引擎在 ack 后才持久化，F6）
  const nextCursors = {
    review_ids: [...seenReviews, ...newItems.reviews.map((r) => (typeof r === 'object' ? r.id : r))],
    comment_ids: [...seenComments, ...newItems.comments.map((c) => (typeof c === 'object' ? c.id : c))],
    ci_red_sha: signals.includes('ci-red') ? head : cursors.ci_red_sha,
    ci_red_key: signals.includes('ci-red') ? ciKey : cursors.ci_red_key,
    conflict_sha: signals.includes('conflict') ? head : cursors.conflict_sha
  };

  const hold = (snapshot.labels ?? []).some((l) => HOLD_LABELS.includes(String(l).toLowerCase()));
  if (hold) {
    // blocked-external: 静默等，且**游标不推进**（审③-F7-R: hold 期间到达的反馈
    // 必须在解除 hold 后仍能被识别为新信号——推进游标会把它们永久吞掉）。
    // 持续 hold 期间每轮都会重新看到这些信号，但因不投递也就不会重复派活。
    return { decision: 'blocked-external', cursors, signals: ['hold-label', ...signals], newItems };
  }
  if (signals.length === 0) {
    return { decision: 'none', cursors, signals: [], newItems };
  }
  return { decision: 'actionable', cursors: nextCursors, signals, newItems };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot) { process.stderr.write('用法: gate.mjs --snapshot <snap.json> [--cursors <cursors.json>]\n'); process.exit(1); }
  const res = evaluate(args.cursors ? readJson(args.cursors) : null, readJson(args.snapshot), { hmacKey: process.env.PR_AUTOPILOT_HMAC_KEY });
  process.stdout.write(JSON.stringify(res) + '\n');
}

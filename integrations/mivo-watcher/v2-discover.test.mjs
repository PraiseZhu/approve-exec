import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { END_TURN_RULE, pollFingerprint, normalizePollSnapshot, scanOnce, watcherPaths, watchGuideMessage, watchSuccessorMessage } from './bin/mivo-watcher.mjs';
import { clearOwnerUnknown } from './bin/mivo-repair.mjs';
import { repairSessionTitle } from './bin/session-title.mjs';
import { acquireLock, readPr, statePaths, writePr } from './bin/mivo-state.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const nodeId = 'PR_790';
const listed = { number: 790, id: nodeId, headRefOid: HEAD, headRefName: 'fix/x', title: 'fix', isDraft: false, labels: [] };

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-discover-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { home, paths };
}

function collectFail() {
  return {
    pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
    ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  };
}

// One-query poll snapshot a bound PR gets inside discover.
function graphqlNode(extra = {}) {
  return {
    state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
    labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...extra,
  };
}
const SNAP_FINGERPRINT = pollFingerprint(normalizePollSnapshot({ data: { node: graphqlNode() } }));

function discover(paths, { now = '2026-09-28T00:00:00Z', prs = [listed], collect, dispatchFn, maxPrs, clock, budgetMs, perPrBudgetMs, ghExtra, node = graphqlNode(), git } = {}) {
  let collected = 0;
  // Closedown runs git cleanup; never let a test reach the real plugin repo.
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-discover-plugin-'));
  const gitCalls = [];
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now,
    gitFn: git ?? ((_bin, args) => { gitCalls.push(args); return ''; }),
    env: { MIVO_PLUGIN_REPO: plugin },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (typeof ghExtra === 'function') {
        const extra = ghExtra(args);
        if (extra !== undefined) return extra;
      }
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node } });
      return '[]';
    },
    collect: (...args) => {
      collected += 1;
      if (typeof collect === 'function') return collect(...args);
      throw new Error('collect should not run');
    },
    dispatchFn, maxPrs, clock, budgetMs, perPrBudgetMs,
    ownershipSnapshot: function* () {
      return { pr: { state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' } };
    },
  });
  fs.rmSync(plugin, { recursive: true, force: true });
  return { result, collected, gitCalls, entry: readPr(paths.home, nodeId) };
}

function seedBound(paths, extra = {}) {
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', claimedAt: '2026-09-27T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: 'e',
    activeTask: { status: 'complete' }, headRefName: 'fix/x', title: 'fix', ...extra,
  });
}

test('unbound admitted PR creates a session without any schedule step', (t) => {
  const { paths } = homeOf(t);
  let params;
  const { result, collected, entry } = discover(paths, {
    collect: collectFail,
    dispatchFn: (p) => { params = p; return { target_session_id: 'sess-new' }; },
  });
  assert.equal(collected, 1);
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(params.target_session_id, undefined);
  assert.doesNotMatch(params.message, /schedule-params|bind-schedule|schedule_create/);
  assert.match(params.message, /watcher 脚本每 5 分钟检查本 PR/);
  assert.ok(params.message.includes(END_TURN_RULE));
  // The first confirmed receipt is the claim.
  assert.equal(entry.sessionId, 'sess-new');
  assert.equal(entry.claimedAt, '2026-09-28T00:00:00Z');
  assert.equal(entry.pendingDispatch, null);
});

test('relock failure after dispatch does not overwrite PR state', (t) => {
  const { paths, home } = homeOf(t);
  let held;
  discover(paths, {
    collect: collectFail,
    dispatchFn: () => {
      held = acquireLock(home, `pr-${nodeId}`);
      return { target_session_id: 'sess-new' };
    },
  });
  t.after(() => held?.release?.());
  const entry = readPr(home, nodeId);
  assert.ok(!entry.sessionId);
  assert.ok(entry.pendingDispatch?.dispatchId);
  assert.notEqual(entry.pendingDispatch?.status, 'awaiting-claim');
});

test('discover releases pr lock during create dispatch', (t) => {
  const { paths, home } = homeOf(t);
  let heldDuringDispatch;
  discover(paths, {
    collect: collectFail,
    dispatchFn: () => {
      const lock = acquireLock(home, `pr-${nodeId}`);
      heldDuringDispatch = lock.held;
      if (!lock.held) lock.release();
      return { target_session_id: 'sess-new' };
    },
  });
  assert.equal(heldDuringDispatch, false);
});

test('create receipt timeout recreates once then needsHuman', (t) => {
  const { paths, home } = homeOf(t);
  const boom = () => { throw new Error('Cindy dispatch receipt timed out; pending dispatch retained'); };
  const first = discover(paths, { now: '2026-09-28T00:00:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(first.entry.pendingDispatch.status, 'awaiting-claim');
  const oldId = first.entry.pendingDispatch.dispatchId;
  const mid = discover(paths, { now: '2026-09-28T00:59:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(mid.collected, 0);
  assert.equal(mid.result.prs[0].dispatch.reason, 'awaiting-claim');
  const later = discover(paths, { now: '2026-09-28T01:01:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(later.collected, 1);
  assert.equal(later.result.prs[0].dispatch.reason, 'claim-retry-recreate');
  assert.ok(later.entry.abandonedDispatches.includes(oldId));
  assert.equal(later.entry.pendingDispatch.status, 'awaiting-claim');
  assert.notEqual(later.entry.pendingDispatch.dispatchId, oldId);
  const still = discover(paths, { now: '2026-09-28T02:02:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(still.collected, 0);
  assert.equal(still.entry.needsHuman.reason, 'owner-unknown');
  assert.equal(still.result.prs[0].dispatch.reason, 'needs-human');
  clearOwnerUnknown({ home, pr: 790, nodeId });
  const after = discover(paths, {
    now: '2026-09-28T02:03:00Z', collect: collectFail,
    dispatchFn: () => ({ target_session_id: 'sess-new' }),
  });
  assert.equal(after.collected, 1);
  assert.equal(after.entry.sessionId, 'sess-new');
  assert.equal(after.entry.needsHuman, null);
});

test('bound PR with unchanged fingerprint costs one query: no collect, no dispatch', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, { pollFingerprint: SNAP_FINGERPRINT });
  const { result, collected } = discover(paths, {
    now: '2026-09-28T00:16:00Z',
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal(readPr(paths.home, nodeId).heartbeatAt, '2026-09-28T00:16:00Z');
});

test('bound PR with changed fingerprint collects and dispatches to the bound session', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, { pollFingerprint: 'old' });
  const calls = [];
  const { result, collected, entry } = discover(paths, {
    collect: collectFail,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(collected, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target_session_id, 'sess-790');
  assert.doesNotMatch(calls[0].message, /schedule/);
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(entry.pollFingerprint, SNAP_FINGERPRINT);
});

test('ARCHIVED delivery starts successor and records predecessors', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, { sessionId: 'sess-old' });
  const calls = [];
  const { collected, entry } = discover(paths, {
    now: '2026-09-28T00:16:00Z',
    collect: collectFail,
    dispatchFn: (p) => {
      calls.push(p);
      if (p.target_session_id) throw new Error('target ARCHIVED');
      return { target_session_id: 'sess-next' };
    },
  });
  // Once for the bound delivery, once more on the successor's behalf.
  assert.equal(collected, 2);
  assert.equal(calls[0].target_session_id, 'sess-old');
  assert.equal(calls[1].target_session_id, undefined);
  assert.match(calls[1].message, /接班修复 session/);
  assert.doesNotMatch(calls[1].message, /schedule-params|bind-schedule/);
  assert.match(calls[1].message, /sess-old/);
  assert.equal(entry.predecessors[0].sessionId, 'sess-old');
  assert.equal(entry.sessionId, 'sess-next');
});

test('bound PR with nothing to deliver never probes the session', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, {
    lastDispatch: { dispatchId: 'old-dispatch' },
    activeTask: { status: 'running', dispatchId: 'old-dispatch' },
    feedbackCursor: { 'comment:1': 't1' },
  });
  const calls = [];
  const { entry } = discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (p) => { calls.push(p); throw new Error('ARCHIVED'); },
  });
  assert.equal(calls.length, 0);
  assert.equal(entry.sessionId, 'sess-790');
  assert.equal(entry.feedbackCursor['comment:1'], 't1');
});

test('merge-ready bound PR is not woken even if its session is gone', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, { sessionId: 'sess-old' });
  const calls = [];
  const { entry, result } = discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: ['review:merge-ready'], mergeReady: true,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (p) => { calls.push(p); throw new Error('ARCHIVED'); },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.prs[0].dispatch.reason, 'merge-ready');
  assert.equal(entry.sessionId, 'sess-old');
});

test('discover releases pr lock while dispatching to a bound session', (t) => {
  const { paths, home } = homeOf(t);
  seedBound(paths, { pollFingerprint: 'old' });
  let heldDuringDispatch;
  const { entry } = discover(paths, {
    collect: collectFail,
    dispatchFn: () => {
      const lock = acquireLock(home, `pr-${nodeId}`);
      heldDuringDispatch = lock.held;
      if (!lock.held) lock.release();
      return { target_session_id: 'sess-790' };
    },
  });
  assert.equal(heldDuringDispatch, false);
  assert.equal(entry.sessionId, 'sess-790');
});

test('bound PR: 20s collection under the per-PR cap still dispatches with the round budget', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, { pollFingerprint: 'old' });
  let clock = 0;
  const calls = [];
  const { result } = discover(paths, {
    budgetMs: 120000, perPrBudgetMs: 75000, clock: () => clock,
    collect: (...args) => { clock += 20000; return collectFail(...args); },
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 1);
  assert.notEqual(result.prs[0].dispatch.reason, 'dispatch-budget-deferred');
});

test('discover skips a PR whose pr lock is held', (t) => {
  const { paths, home } = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, `pr-${nodeId}.lock`), `${process.pid} 2026-09-28T00:00:00.000Z\n`);
  const { result, collected } = discover(paths, {
    collect: collectFail,
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'pr-lock-held');
});

test('discover fair cursor continues after last visited PR', (t) => {
  const { paths } = homeOf(t);
  const second = { number: 791, id: 'PR_791', headRefOid: HEAD, headRefName: 'fix/y', title: 'fix', isDraft: false, labels: [] };
  const seen = [];
  const run = () => discover(paths, {
    prs: [listed, second], maxPrs: 1,
    collect: (pr) => { seen.push(pr.number); return collectFail(); },
    dispatchFn: () => ({ target_session_id: 'sess-new' }),
  });
  const first = run();
  assert.deepEqual(seen, [790]);
  assert.equal(first.result.scan.cursor, 790);
  run();
  assert.deepEqual(seen, [790, 791]);
});

test('discover summary lists closedownManual items', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, 'PR_closed', {
    number: 2, nodeId: 'PR_closed', closedownManual: { scheduleId: 'sched-old', reason: 'ARCHIVED', at: '2026-09-28T00:00:00Z' },
  });
  const { result } = discover(paths, {
    collect: collectFail,
    dispatchFn: () => ({ target_session_id: 'sess-new' }),
  });
  assert.equal(result.closedownManual[0].scheduleId, 'sched-old');
  assert.equal(result.closedownManual[0].nodeId, 'PR_closed');
});

test('dispatch receipt conflict keeps the first owner, alerts once, does not set needsHuman', (t) => {
  const { paths, home } = homeOf(t);
  const calls = [];
  const first = discover(paths, {
    collect: collectFail,
    dispatchFn: (params) => {
      calls.push(params);
      if (params.target_session_id === 'sess-bound') return { target_session_id: 'sess-bound' };
      // Another writer claimed the PR while this create dispatch was in flight.
      writePr(home, nodeId, { ...readPr(home, nodeId), sessionId: 'sess-bound', claimedAt: '2026-09-28T00:00:00Z' });
      return { target_session_id: 'sess-receipt' };
    },
  });
  const entry = readPr(home, nodeId);
  assert.equal(entry.sessionId, 'sess-bound');
  assert.ok(!entry.needsHuman);
  assert.equal(entry.dispatchConflict.bindSession, 'sess-bound');
  assert.equal(entry.dispatchConflict.receiptSession, 'sess-receipt');
  assert.ok(entry.dispatchConflict.dispatchId);
  assert.equal(first.result.prs[0].dispatch.conflict, true);
  assert.equal(calls.filter((p) => /回执冲突/.test(p.message)).length, 1);
  assert.equal(entry.dispatchConflict.notifiedAt, '2026-09-28T00:00:00Z');
  const later = discover(paths, {
    now: '2026-09-28T00:10:00Z',
    collect: collectFail,
    dispatchFn: (params) => {
      assert.equal(params.target_session_id, 'sess-bound');
      assert.doesNotMatch(params.message, /回执冲突/);
      return { target_session_id: 'sess-bound' };
    },
  });
  assert.notEqual(later.result.prs[0].dispatch.reason, 'needs-human');
});

test('discover resets closedHandled when listed PR is OPEN', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', closedHandled: true, heartbeatAt: '2026-09-28T00:00:00Z',
  });
  const { entry } = discover(paths, {
    now: '2026-09-28T00:05:00Z',
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(entry.closedHandled, false);
  assert.equal(entry.reopenedAt, '2026-09-28T00:05:00Z');
});

test('opt-out label skips discover work', (t) => {
  const { paths } = homeOf(t);
  const { result, collected } = discover(paths, {
    prs: [{ ...listed, labels: [{ name: 'mivo-watch:off' }] }],
    collect: collectFail,
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'opt-out');
});

function collectFor(pr) {
  return {
    ...collectFail(),
    pr: { id: pr.id, number: pr.number, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  };
}

test('discover dispatches after 20s collection when global remaining exceeds 65s', (t) => {
  const { paths } = homeOf(t);
  let clock = 0;
  const calls = [];
  const { result } = discover(paths, {
    budgetMs: 120000,
    perPrBudgetMs: 75000,
    clock: () => clock,
    collect: (pr) => {
      clock += 20000;
      return collectFor(pr);
    },
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-new' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.notEqual(result.prs[0].dispatch.reason, 'dispatch-budget-deferred');
});

test('discover still defers dispatch when global remaining is under 65s', (t) => {
  const { paths } = homeOf(t);
  let clock = 0;
  const calls = [];
  const { result } = discover(paths, {
    budgetMs: 84000,
    perPrBudgetMs: 75000,
    clock: () => clock,
    collect: (pr) => {
      clock += 20000;
      return collectFor(pr);
    },
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-new' }; },
  });
  assert.equal(calls.length, 0);
  assert.equal(result.prs[0].dispatch.attempted, false);
  assert.equal(result.prs[0].dispatch.reason, 'dispatch-budget-deferred');
});

test('discover defers later PRs after the first dispatch exhausts global remaining', (t) => {
  const { paths } = homeOf(t);
  const second = { number: 791, id: 'PR_791', headRefOid: HEAD, headRefName: 'fix/y', title: 'fix', isDraft: false, labels: [] };
  let clock = 0;
  const calls = [];
  const { result } = discover(paths, {
    prs: [listed, second],
    budgetMs: 120000,
    perPrBudgetMs: 75000,
    clock: () => clock,
    collect: (pr) => {
      clock += 20000;
      return collectFor(pr);
    },
    dispatchFn: (p) => {
      calls.push(p);
      clock += 40000;
      return { target_session_id: `sess-${calls.length}` };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(result.prs[1].dispatch.attempted, false);
  assert.equal(result.prs[1].dispatch.reason, 'dispatch-budget-deferred');
});

const BAN = /不要创建、恢复、修改或查询任何调度（包括名为 Mivo watcher 的共享调度）/;

test('guide and successor messages forbid every schedule operation', () => {
  const guide = watchGuideMessage({ prNumber: 790 });
  assert.match(guide, BAN);
  assert.doesNotMatch(guide, /schedule-params|bind-schedule|第 0 步/);
  const successor = watchSuccessorMessage({ prNumber: 790, predecessorId: 'old', reason: 'ARCHIVED' });
  assert.match(successor, BAN);
  assert.doesNotMatch(successor, /第 0 步/);
});

test('changelog bot PRs are skipped before any lock, collect or dispatch', (t) => {
  const { paths } = homeOf(t);
  const { result, collected } = discover(paths, {
    prs: [{ ...listed, headRefName: 'chore/changelog-20261002' }],
    collect: collectFail,
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'excluded-head');
  assert.equal(readPr(paths.home, nodeId), null);
});

test('discover closedown for ledger PR missing from open list is done by the script', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', closedHandled: false,
  });
  const calls = [];
  const { result, collected, entry, gitCalls } = discover(paths, {
    prs: [],
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
    ghExtra: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ state: 'MERGED', id: nodeId });
      }
      return undefined;
    },
  });
  assert.equal(collected, 0);
  assert.equal(calls.length, 0);
  assert.equal(entry.closedHandled, true);
  assert.equal(entry.autoCleanup.removed, true);
  assert.ok(gitCalls.some((args) => args.includes('watch/pr-790')));
  assert.equal(entry.closedownManual, undefined);
  assert.equal(result.prs.find((item) => item.nodeId === nodeId).dispatch.reason, 'closedown-script');
});

test('discover closedown without session just marks closedHandled', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, { number: 790, nodeId, sessionId: null, closedHandled: false });
  const { collected, entry } = discover(paths, {
    prs: [],
    dispatchFn: () => { throw new Error('should not dispatch'); },
    ghExtra: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED', id: nodeId });
      return undefined;
    },
  });
  assert.equal(collected, 0);
  assert.equal(entry.closedHandled, true);
});

test('discover does not closedown still-open PR missing from list', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', closedHandled: false,
  });
  const { collected, entry, result } = discover(paths, {
    prs: [],
    dispatchFn: () => { throw new Error('should not dispatch'); },
    ghExtra: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'OPEN', id: nodeId });
      return undefined;
    },
  });
  assert.equal(collected, 0);
  assert.equal(entry.closedHandled, false);
  assert.equal(result.prs.find((item) => item.nodeId === nodeId).dispatch.reason, 'stale-still-open');
});

test('claim timeout with known session wakes it once', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId,
    pendingDispatch: {
      status: 'awaiting-claim',
      dispatchId: 'live-790-old',
      claimDeadline: '2026-09-28T00:00:00Z',
      createdSessionId: 'sess-known',
      params: { title: 't', message: 'step 0', target_session_id: 'sess-known' },
    },
  });
  const calls = [];
  const { collected, entry, result } = discover(paths, {
    now: '2026-09-28T01:01:00Z',
    collect: collectFail,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-known', dispatch_id: 'live-790-old' }; },
  });
  assert.equal(collected, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target_session_id, 'sess-known');
  assert.equal(result.prs[0].dispatch.reason, 'claim-retry-wakeup');
  assert.equal(entry.sessionId, 'sess-known');
  assert.equal(entry.pendingDispatch, null);
});

test('claim-retry-wakeup without cached params falls back to repairSessionTitle', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId,
    pendingDispatch: {
      status: 'awaiting-claim',
      dispatchId: 'live-790-old',
      claimDeadline: '2026-09-28T00:00:00Z',
      createdSessionId: 'sess-known',
      // params intentionally absent so the `?? { title: ..., message: guide }` default is evaluated.
    },
  });
  const calls = [];
  const { result } = discover(paths, {
    now: '2026-09-28T01:01:00Z',
    collect: collectFail,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-known', dispatch_id: 'live-790-old' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.prs[0].dispatch.reason, 'claim-retry-wakeup');
  assert.equal(calls[0].title, repairSessionTitle({ task: listed.title, prNumber: 790, createdAt: '2026-09-28T01:01:00Z' }));
});

test('bound Draft PR with stale heartbeat is left to the author, not woken', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', heartbeatAt: '2026-09-27T00:00:00Z', scheduleId: 'sch-790',
    activeTask: { dispatchId: 'live-790-a', status: 'accepted' },
  });
  const { result, collected, entry } = discover(paths, {
    prs: [{ ...listed, isDraft: true }],
    dispatchFn: () => { throw new Error('draft must not wake the watcher session'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'draft-author-owned');
  assert.equal(entry.lastLostReminderAt, undefined);
});

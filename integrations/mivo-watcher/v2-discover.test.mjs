import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanOnce, watcherPaths, watchGuideMessage, watchPollLostMessage, watchSuccessorMessage } from './bin/mivo-watcher.mjs';
import { bindSchedule, clearOwnerUnknown } from './bin/mivo-repair.mjs';
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

function discover(paths, { now = '2026-09-28T00:00:00Z', prs = [listed], collect, dispatchFn, maxPrs, clock, budgetMs, perPrBudgetMs, ghExtra } = {}) {
  let collected = 0;
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now,
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (typeof ghExtra === 'function') return ghExtra(args);
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
  return { result, collected, entry: readPr(paths.home, nodeId) };
}

test('unbound admitted PR creates with schedule-params and bind-schedule', (t) => {
  const { paths } = homeOf(t);
  let params;
  const { result, collected } = discover(paths, {
    collect: collectFail,
    dispatchFn: (p) => { params = p; return { target_session_id: 'sess-new' }; },
  });
  assert.equal(collected, 1);
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(params.target_session_id, undefined);
  assert.match(params.message, /schedule-params/);
  assert.match(params.message, /bind-schedule/);
  assert.match(params.message, /--dispatch-id live-790-/);
  const spaced = watchGuideMessage({ home: '/tmp/Project Mivo Canvas-Plugin/_ops/mivo-watcher', prNumber: 790, nodeId });
  assert.match(spaced, /第 0 步/);
  assert.match(spaced, /busy/);
  assert.match(spaced, /owner-conflict/);
  assert.match(spaced, /'\/tmp\/Project Mivo Canvas-Plugin\/_ops\/mivo-watcher'/);
});

test('bind during dispatch keeps scheduleId and claimedAt after receipt', (t) => {
  const { paths, home } = homeOf(t);
  discover(paths, {
    collect: collectFail,
    dispatchFn: (params) => {
      const dispatchId = /--dispatch-id ([^\s`]+)/.exec(params.message)[1];
      const resultPath = path.join(home, 'sched.json');
      fs.writeFileSync(resultPath, JSON.stringify({
        ok: true, id: 'sched-bind', executionMode: 'script', status: 'active',
        targetSessionId: 'sess-new', scriptConfig: { command: `python3 x.py --mode poll --pr 790 --node-id ${nodeId}` },
      }));
      bindSchedule({ home, pr: 790, nodeId, resultPath, dispatchId, retryMs: 0 });
      return { target_session_id: 'sess-new', dispatch_id: dispatchId };
    },
  });
  const entry = readPr(home, nodeId);
  assert.equal(entry.sessionId, 'sess-new');
  assert.equal(entry.scheduleId, 'sched-bind');
  assert.ok(entry.claimedAt);
  assert.equal(entry.pendingDispatch, null);
});

test('LOCK_HELD after bind leaves disk bytes unchanged and next round recovers', (t) => {
  const { paths, home } = homeOf(t);
  const prFile = path.join(statePaths(home).prsDir, `${nodeId}.json`);
  let held;
  let bytesBefore;
  const first = discover(paths, {
    now: '2026-09-28T08:40:00.000Z',
    collect: collectFail,
    dispatchFn: (params) => {
      const dispatchId = /--dispatch-id ([^\s`]+)/.exec(params.message)[1];
      const resultPath = path.join(home, 'sched.json');
      fs.writeFileSync(resultPath, JSON.stringify({
        ok: true, id: 'sched-lock', executionMode: 'script', status: 'active',
        targetSessionId: 'sess-bound-lock',
        scriptConfig: { command: `python3 x.py --mode poll --pr 790 --node-id ${nodeId}` },
      }));
      bindSchedule({ home, pr: 790, nodeId, resultPath, dispatchId, retryMs: 0 });
      bytesBefore = fs.readFileSync(prFile);
      held = acquireLock(home, `pr-${nodeId}`);
      return { target_session_id: 'sess-bound-lock', dispatch_id: dispatchId };
    },
  });
  t.after(() => held?.release?.());
  assert.equal(first.result.prs[0].dispatch.reason, 'dispatch-lock-retry');
  assert.equal(createHash('sha256').update(fs.readFileSync(prFile)).digest('hex'), createHash('sha256').update(bytesBefore).digest('hex'));
  const bound = readPr(home, nodeId);
  assert.equal(bound.sessionId, 'sess-bound-lock');
  assert.equal(bound.scheduleId, 'sched-lock');
  assert.ok(bound.claimedAt);
  held.release();
  const second = discover(paths, {
    now: '2026-09-28T08:41:00.000Z',
    collect: collectFail,
    dispatchFn: () => { throw new Error('should not create'); },
  });
  assert.notEqual(second.result.prs[0].dispatch.reason, 'pending-dispatch-unknown');
  assert.equal(readPr(home, nodeId).sessionId, 'sess-bound-lock');
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

test('bound stale heartbeat reminds at most once per 30 minutes', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', heartbeatAt: '2026-09-28T00:00:00Z',
  });
  const calls = [];
  const first = discover(paths, {
    now: '2026-09-28T00:16:00Z',
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(first.collected, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /轮询调度失联/);
  assert.match(calls[0].message, /schedule-params/);
  assert.match(calls[0].message, /bind-schedule/);
  assert.doesNotMatch(calls[0].message, /schedule_resume/);
  assert.equal(calls[0].target_session_id, 'sess-790');
  const second = discover(paths, {
    now: '2026-09-28T00:40:00Z',
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(second.collected, 0);
  assert.equal(calls.length, 1);
});

test('ARCHIVED lost delivery starts successor and records predecessors', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-old', heartbeatAt: '2026-09-28T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: 'e',
    activeTask: { status: 'complete' },
  });
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
  assert.equal(collected, 1);
  assert.equal(calls[0].target_session_id, 'sess-old');
  assert.equal(calls[1].target_session_id, undefined);
  assert.match(calls[1].message, /接班修复 session/);
  assert.match(calls[1].message, /sess-old/);
  assert.equal(entry.predecessors[0].sessionId, 'sess-old');
  assert.equal(entry.sessionId, 'sess-next');
});

test('successor create ignores inFlight and empty fresh', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-old', heartbeatAt: '2026-09-28T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: 'e',
    lastDispatch: { dispatchId: 'old-dispatch' },
    activeTask: { status: 'running', dispatchId: 'old-dispatch' },
    feedbackCursor: { 'comment:1': 't1' },
  });
  const calls = [];
  const { entry } = discover(paths, {
    now: '2026-09-28T00:16:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (p) => {
      calls.push(p);
      if (p.target_session_id) throw new Error('ARCHIVED');
      return { target_session_id: 'sess-next' };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].target_session_id, undefined);
  assert.match(calls[1].message, /old-dispatch/);
  assert.equal(entry.predecessors[0].activeTask.status, 'running');
  assert.equal(entry.feedbackCursor['comment:1'], 't1');
  assert.equal(entry.sessionId, 'sess-next');
});

test('ARCHIVED plus merge-ready still creates successor', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-old', heartbeatAt: '2026-09-28T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: 'e',
    activeTask: { status: 'complete' },
  });
  const calls = [];
  const { entry } = discover(paths, {
    now: '2026-09-28T00:16:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: ['review:merge-ready'], mergeReady: true,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (p) => {
      calls.push(p);
      if (p.target_session_id) throw new Error('ARCHIVED');
      return { target_session_id: 'sess-next' };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].target_session_id, undefined);
  assert.match(calls[1].message, /merge-ready/);
  assert.equal(entry.sessionId, 'sess-next');
});

test('bound PR with fresh heartbeat skips collect', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', heartbeatAt: '2026-09-28T00:00:00Z',
  });
  const { result, collected } = discover(paths, {
    now: '2026-09-28T00:05:00Z',
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'bound-heartbeat-ok');
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

test('dispatch receipt conflict keeps bind owner, alerts once, does not set needsHuman', (t) => {
  const { paths, home } = homeOf(t);
  const calls = [];
  const first = discover(paths, {
    collect: collectFail,
    dispatchFn: (params) => {
      calls.push(params);
      if (params.target_session_id === 'sess-bound') return { target_session_id: 'sess-bound' };
      const dispatchId = /--dispatch-id ([^\s`]+)/.exec(params.message)[1];
      const resultPath = path.join(home, 'sched.json');
      fs.writeFileSync(resultPath, JSON.stringify({
        ok: true, id: 'sched-conflict', executionMode: 'script', status: 'active',
        targetSessionId: 'sess-bound',
        scriptConfig: { command: `python3 x.py --mode poll --pr 790 --node-id ${nodeId}` },
      }));
      bindSchedule({ home, pr: 790, nodeId, resultPath, dispatchId, retryMs: 0 });
      return { target_session_id: 'sess-receipt', dispatch_id: dispatchId };
    },
  });
  const entry = readPr(home, nodeId);
  assert.equal(entry.sessionId, 'sess-bound');
  assert.equal(entry.needsHuman, null);
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
  assert.equal(later.collected, 0);
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

const BAN = /禁止恢复、修改或新建任何其它调度，尤其是名为 Mivo watcher 的共享调度/;

test('lost reminder with null scheduleId embeds step 0 and does not resume', () => {
  const home = '/tmp/Project Mivo Canvas-Plugin/_ops/mivo-watcher';
  const text = watchPollLostMessage({
    prNumber: 790, heartbeatAt: '2026-09-28T00:00:00Z', scheduleId: null, home, nodeId,
  });
  assert.match(text, /schedule-params/);
  assert.match(text, /bind-schedule/);
  assert.match(text, /--pr 790 --node-id PR_790 --result/);
  assert.doesNotMatch(text, /--dispatch-id/);
  assert.doesNotMatch(text, /schedule_resume/);
  assert.doesNotMatch(text, /schedule_get/);
  assert.match(text, BAN);
});

test('lost reminder with scheduleId only resumes that id', () => {
  const home = '/tmp/Project Mivo Canvas-Plugin/_ops/mivo-watcher';
  const text = watchPollLostMessage({
    prNumber: 790, heartbeatAt: '2026-09-28T00:00:00Z', scheduleId: 'sched-790', home, nodeId,
  });
  assert.match(text, /schedule_get sched-790/);
  assert.match(text, /只对该 scheduleId 调用 schedule_resume/);
  assert.doesNotMatch(text, /schedule_get (?!sched-790)/);
  assert.match(text, BAN);
});

test('guide, lost, and successor messages all ban shared watcher schedules', () => {
  const home = '/tmp/Project Mivo Canvas-Plugin/_ops/mivo-watcher';
  assert.match(watchGuideMessage({ home, prNumber: 790, nodeId }), BAN);
  assert.match(watchPollLostMessage({ prNumber: 790, heartbeatAt: 't', scheduleId: 's', home, nodeId }), BAN);
  assert.match(watchSuccessorMessage({ prNumber: 790, predecessorId: 'old', reason: 'ARCHIVED' }), BAN);
});

test('discover closedown for ledger PR missing from open list', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', scheduleId: 'sched-790', closedHandled: false,
  });
  const calls = [];
  const { result, collected, entry } = discover(paths, {
    prs: [],
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
    ghExtra: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({ state: 'MERGED', id: nodeId });
      }
      return '[]';
    },
  });
  assert.equal(collected, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /已合并/);
  assert.equal(calls[0].target_session_id, 'sess-790');
  assert.equal(entry.closedHandled, true);
  assert.equal(result.prs.find((item) => item.nodeId === nodeId).dispatch.reason, 'closedown');
});

test('discover closedown without session just marks closedHandled', (t) => {
  const { paths } = homeOf(t);
  writePr(paths.home, nodeId, { number: 790, nodeId, sessionId: null, closedHandled: false });
  const { collected, entry } = discover(paths, {
    prs: [],
    dispatchFn: () => { throw new Error('should not dispatch'); },
    ghExtra: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: 'CLOSED', id: nodeId });
      return '[]';
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
      return '[]';
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

test('abandoned dispatch-id cannot bind after recreate', (t) => {
  const { paths, home } = homeOf(t);
  const boom = () => { throw new Error('Cindy dispatch receipt timed out; pending dispatch retained'); };
  const first = discover(paths, { now: '2026-09-28T00:00:00Z', collect: collectFail, dispatchFn: boom });
  const oldId = first.entry.pendingDispatch.dispatchId;
  discover(paths, { now: '2026-09-28T01:01:00Z', collect: collectFail, dispatchFn: boom });
  const resultPath = path.join(home, 'sched.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-old', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-old', scriptConfig: { command: `python3 x.py --mode poll --pr 790 --node-id ${nodeId}` },
  }));
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId, resultPath, dispatchId: oldId, retryMs: 0 }),
    /dispatch-id 已作废/,
  );
});

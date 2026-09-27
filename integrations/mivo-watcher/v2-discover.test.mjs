import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanOnce, watcherPaths, watchGuideMessage } from './bin/mivo-watcher.mjs';
import { clearOwnerUnknown } from './bin/mivo-repair.mjs';
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

function discover(paths, { now = '2026-09-28T00:00:00Z', prs = [listed], collect, dispatchFn, maxPrs } = {}) {
  let collected = 0;
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now,
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      return '[]';
    },
    collect: (...args) => {
      collected += 1;
      if (typeof collect === 'function') return collect(...args);
      throw new Error('collect should not run');
    },
    dispatchFn, maxPrs,
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
  const spaced = watchGuideMessage({ home: '/tmp/Project Mivo Canvas-Plugin/_ops/mivo-watcher', prNumber: 790, nodeId });
  assert.match(spaced, /第 0 步/);
  assert.match(spaced, /busy/);
  assert.match(spaced, /owner-conflict/);
  assert.match(spaced, /"\/tmp\/Project Mivo Canvas-Plugin\/_ops\/mivo-watcher"/);
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

test('create receipt timeout never auto-recreates; needsHuman until clear-owner-unknown', (t) => {
  const { paths, home } = homeOf(t);
  const boom = () => { throw new Error('Cindy dispatch receipt timed out; pending dispatch retained'); };
  const first = discover(paths, { now: '2026-09-28T00:00:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(first.entry.pendingDispatch.status, 'awaiting-claim');
  const mid = discover(paths, { now: '2026-09-28T00:59:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(mid.collected, 0);
  assert.equal(mid.result.prs[0].dispatch.reason, 'awaiting-claim');
  const later = discover(paths, { now: '2026-09-28T01:01:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(later.collected, 0);
  assert.equal(later.entry.needsHuman.reason, 'owner-unknown');
  assert.equal(later.result.prs[0].dispatch.reason, 'needs-human');
  const still = discover(paths, { now: '2026-09-28T03:00:00Z', collect: collectFail, dispatchFn: boom });
  assert.equal(still.collected, 0);
  clearOwnerUnknown({ home, pr: 790, nodeId });
  const after = discover(paths, {
    now: '2026-09-28T03:01:00Z', collect: collectFail,
    dispatchFn: (p) => ({ target_session_id: 'sess-new' }),
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

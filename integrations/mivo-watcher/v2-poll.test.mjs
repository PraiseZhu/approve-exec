import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePollSnapshot, pollFingerprint, scanOnce, watcherPaths, watchClosedownMessage } from './bin/mivo-watcher.mjs';
import { planSessionTitle, repairSessionTitle } from './bin/session-title.mjs';
import { readPr, writePr as writePrState } from './bin/mivo-state.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const now = '2026-09-28T00:00:00Z';
const nodeId = 'PR_790';

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-poll-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { home, paths };
}

function snap(extra = {}) {
  return {
    state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: now,
    mergeable: 'MERGEABLE', labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 0,
    commentUpdatedAt: now, reviewUpdatedAt: null, unresolvedThreads: 0, ...extra,
  };
}

function seed(paths, extra = {}) {
  writePrState(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: 'e', activeTask: { status: 'complete' },
    headRefName: 'fix/x', title: 'fix', ...extra,
  });
}

function poll(paths, { snapshot, collect, dispatchFn, enabled = true, recheckFn } = {}) {
  let collected = 0;
  const result = scanOnce({
    mode: 'poll', enabled, allowDispatch: true, paths, now, nodeId, prNumber: 790,
    snapshotFn: () => snapshot,
    ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: (...args) => {
      collected += 1;
      if (typeof collect === 'function') return collect(...args);
      throw new Error('collect should not run');
    },
    dispatchFn, recheckFn,
    ownershipSnapshot: function* () {
      return { pr: { state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' } };
    },
  });
  return { result, collected, entry: readPr(paths.home, nodeId) };
}

test('same SHA pending to failed changes fingerprint', () => {
  const pending = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'IN_PROGRESS', conclusion: null, id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/1' }],
  }));
  const failed = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/1' }],
  }));
  assert.notEqual(pending, failed);
});

test('rerun with new attempt changes fingerprint', () => {
  const first = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/1' }],
  }));
  const rerun = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/2' }],
  }));
  assert.notEqual(first, rerun);
});

test('new unresolved thread changes fingerprint', () => {
  const none = pollFingerprint(snap({
    reviewThreads: [], unresolvedThreads: 0,
  }));
  const added = pollFingerprint(normalizePollSnapshot({
    ...snap(),
    reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ updatedAt: '2026-09-28T03:00:00Z' }] } }] },
  }));
  assert.notEqual(none, added);
});

test('graphql overflow forces full collect', (t) => {
  const { paths } = homeOf(t);
  const fingerprint = pollFingerprint(snap({ overflow: true }));
  seed(paths, { pollFingerprint: fingerprint });
  const { collected } = poll(paths, {
    snapshot: snap({ overflow: true }),
    collect: () => { throw new Error('forced collect'); },
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(collected, 1);
});

test('unchanged fingerprint writes heartbeat and skips collect', (t) => {
  const { paths } = homeOf(t);
  const fingerprint = pollFingerprint(snap());
  seed(paths, { pollFingerprint: fingerprint });
  const { result, collected, entry } = poll(paths, { snapshot: snap() });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal(entry.heartbeatAt, now);
});

test('fingerprint change dispatches to bound session', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pollFingerprint: pollFingerprint(snap()) });
  let params;
  const { result, collected } = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T01:00:00Z', commentCount: 2 }),
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true,
      checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
      ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
      policy: { status: 'verified', required: [{ context: 'unit' }] },
      comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
    }),
    dispatchFn: (p) => { params = p; return { target_session_id: 'sess-790' }; },
  });
  assert.equal(collected, 1);
  assert.equal(params.target_session_id, 'sess-790');
  assert.equal(result.prs[0].dispatch.attempted, true);
});

test('MERGED delivers closedown once', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { scheduleId: 'sched-1' });
  const calls = [];
  const first = poll(paths, {
    snapshot: snap({ state: 'MERGED' }),
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /已合并/);
  assert.match(calls[0].message, /schedule_delete/);
  assert.equal(calls[0].target_session_id, 'sess-790');
  assert.equal(first.entry.closedHandled, true);
  const second = poll(paths, {
    snapshot: snap({ state: 'MERGED' }),
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(second.result.prs[0].dispatch.reason, 'closed-handled');
  assert.match(watchClosedownMessage({ prNumber: 790, state: 'MERGED', scheduleId: 'sched-1', home: paths.home }), /cleanup --pr 790/);
});

test('MERGED unknown receipt retries closedown', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { scheduleId: 'sched-1' });
  const first = poll(paths, {
    snapshot: snap({ state: 'MERGED' }),
    dispatchFn: () => { throw new Error('Cindy dispatch receipt timed out'); },
  });
  assert.equal(first.entry.closedHandled, false);
  assert.equal(first.result.prs[0].dispatch.reason, 'closedown-unconfirmed');
  const second = poll(paths, {
    snapshot: snap({ state: 'MERGED' }),
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(second.entry.closedHandled, true);
  assert.equal(second.result.prs[0].dispatch.reason, 'closedown');
});

test('MERGED ARCHIVED marks closedHandled for manual schedule cleanup', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { scheduleId: 'sched-gone' });
  const { entry, result } = poll(paths, {
    snapshot: snap({ state: 'CLOSED' }),
    dispatchFn: () => { throw new Error('target NOT_FOUND'); },
  });
  assert.equal(entry.closedHandled, true);
  assert.equal(result.prs[0].dispatch.reason, 'closedown-session-gone');
  assert.equal(entry.closedownManual.scheduleId, 'sched-gone');
});

test('mivo-watch:off does not dispatch', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  let sent = 0;
  const { result, collected, entry } = poll(paths, {
    snapshot: snap({ labels: ['mivo-watch:off'] }),
    dispatchFn: () => { sent += 1; return { target_session_id: 'sess-790' }; },
  });
  assert.equal(sent, 0);
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'opt-out');
  assert.equal(entry.optOut, true);
  assert.equal(entry.heartbeatAt, now);
});

test('recheck failure does not commit fingerprint', (t) => {
  const { paths } = homeOf(t);
  const oldFp = pollFingerprint(snap());
  seed(paths, {
    pollFingerprint: oldFp,
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'd1', head: HEAD },
    lastDispatch: { dispatchId: 'd1' },
  });
  const { entry } = poll(paths, {
    snapshot: snap({ commentCount: 8, commentUpdatedAt: '2026-09-28T05:00:00Z' }),
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
    recheckFn: () => { throw new Error('PR 状态锁占用，请稍后重试写结果'); },
  });
  assert.equal(entry.pollFingerprint, oldFp);
  assert.equal(entry.collectRetry, true);
  assert.equal(entry.lastRecheckError.at, now);
});

test('collect failure does not commit fingerprint and retries next round', (t) => {
  const { paths } = homeOf(t);
  const oldFp = pollFingerprint(snap());
  seed(paths, { pollFingerprint: oldFp });
  const changed = snap({ commentCount: 9, commentUpdatedAt: '2026-09-28T04:00:00Z' });
  const first = poll(paths, {
    snapshot: changed,
    collect: () => { throw new Error('gh timeout'); },
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(first.result.prs[0].dispatch.reason, 'collection-failed');
  assert.equal(first.entry.pollFingerprint, oldFp);
  assert.equal(first.entry.collectRetry, true);
  let collected = 0;
  const second = poll(paths, {
    snapshot: changed,
    collect: () => {
      collected += 1;
      throw new Error('gh timeout again');
    },
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(collected, 1);
  assert.equal(second.entry.pollFingerprint, oldFp);
});

test('missing sessionId records needsOwner and does not create', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { sessionId: null });
  let sent = 0;
  const { result, collected, entry } = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T02:00:00Z' }),
    dispatchFn: () => { sent += 1; return { target_session_id: 'new' }; },
  });
  assert.equal(sent, 0);
  assert.equal(collected, 0);
  assert.equal(result.prs[0].needsOwner, true);
  assert.equal(entry.needsOwner, true);
  assert.equal(entry.sessionId, null);
});

test('repairSessionTitle uses MivoPlugin-#N-task format', () => {
  assert.equal(
    repairSessionTitle({ task: '终态回执修复', prNumber: 558, createdAt: '2026-09-28' }),
    'MivoPlugin-#558-终态回执修复丨 0928',
  );
});

test('planSessionTitle keeps new titles and rewrites old titles', () => {
  const pr = { id: 'PR_558', number: 558, title: '终态回执修复' };
  const kept = planSessionTitle({
    pr, existing: { title: 'MivoPlugin-#558-终态回执修复丨 0928', titleDate: '2026-09-28' }, createdAt: '2026-09-28',
  });
  assert.equal(kept.title, 'MivoPlugin-#558-终态回执修复丨 0928');
  const rewritten = planSessionTitle({
    pr, existing: { title: 'MivoPlugin-终态回执修复丨 0928', titleDate: '2026-09-28' }, createdAt: '2026-09-28',
  });
  assert.equal(rewritten.title, 'MivoPlugin-#558-终态回执修复丨 0928');
});

test('maintenance script treats only the new title as canonical', () => {
  const src = fs.readFileSync(new URL('./bin/session-title-maintenance.py', import.meta.url), 'utf8');
  const match = src.match(/re\.fullmatch\(r"(MivoPlugin-[^"]+)"/);
  assert.ok(match);
  const re = new RegExp(`^${match[1]}$`, 'u');
  assert.equal(re.test('MivoPlugin-#558-终态回执修复丨 0928'), true);
  assert.equal(re.test('MivoPlugin-终态回执修复丨 0928'), false);
});

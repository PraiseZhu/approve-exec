import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanOnce, watcherPaths, normalizePollSnapshot, pollFingerprint } from './bin/cindy-watcher.mjs';
import { readPr, writePr } from './bin/cindy-state.mjs';
import { evaluateCindyReview } from './bin/cindy-review-status.mjs';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), ID = 'PR_progress', SESSION = 'session-progress', DISPATCH = 'live-progress';
const now = '2026-10-01T12:00:00Z';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-progress-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  const pr = { id: ID, number: 790, state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE,
    headRefName: 'fix/progress', title: 'progress', author: { login: 'owner' },
    headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, isCrossRepository: true, releaseEpoch: 'e' };
  const snapshot = { ...pr, mergeable: 'MERGEABLE', labels: [], checks: [], commentCount: 0, reviewCount: 0, unresolvedThreads: 0 };
  const collected = { pr, mergeable: 'MERGEABLE', labels: [], checks: [], comments: [], reviews: [], threads: [],
    requiredChecksGreen: true, ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] }, admissionVerified: true };
  const entry = { number: 790, nodeId: ID, sessionId: SESSION, headRefOid: HEAD, headRefName: pr.headRefName,
    admissionVerified: true, admissionEpoch: 'e', eligibility: 'active', repairRounds: 1,
    activeTask: { dispatchId: DISPATCH, sessionId: SESSION, head: HEAD, status: 'accepted' },
    lastDispatch: { dispatchId: DISPATCH, at: '2026-10-01T00:00:00Z', recoveryCount: 0 },
    pollFingerprint: pollFingerprint(normalizePollSnapshot(snapshot)) };
  writePr(home, ID, entry);
  const resultFile = path.join(home, 'state/results', DISPATCH + '.json');
  const result = (status, extra = {}) => {
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({ schemaVersion: 2, dispatchId: DISPATCH, nodeId: ID,
      sessionId: SESSION, head: HEAD, status, ci: { head: HEAD, requiredGreen: status === 'complete' },
      verification: { status: 'pass' }, receiptId: 'receipt-' + status, ...extra }));
  };
  const calls = [];
  const poll = (extra = {}) => scanOnce({ mode: 'poll', paths, nodeId: ID, prNumber: 790, now,
    enabled: true, allowDispatch: true, snapshotFn: () => snapshot, ghFn: () => 'owner',
    collect: () => { const v = evaluateCindyReview({ snapshot: collected, ci: collected.ci }); return { ...collected, mergeReady: v.ready, reviewReason: v.reason }; },
    dispatchFn: p => { calls.push(p); return { target_session_id: SESSION }; },
    ownershipSnapshot: function* () { return { pr }; }, ...extra });
  return { home, paths, pr, snapshot, collected, entry, resultFile, result, poll, calls, read: () => readPr(home, ID) };
}

for (const status of ['complete', 'blocked']) test(`unchanged GitHub consumes new ${status} receipt`, t => {
  const f = fixture(t);
  f.result(status, status === 'blocked' ? { blockedKind: 'external', reason: 'external failure' } : {});
  const out = f.poll();
  assert.equal(f.read().activeTask.status, status);
  assert.equal(f.calls.length, 0);
  if (status === 'blocked') assert.equal(out.events[0].kind, 'repair-blocked');
  const next = f.poll({ collect: () => assert.fail('unchanged consumed receipt needs no collection') });
  assert.equal(next.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal((next.events ?? []).length, 0);
});

test('unchanged GitHub retries waiting-ci to complete without another remote event', t => {
  const f = fixture(t);
  f.result('waiting-ci');
  let rechecks = 0;
  const recheckFn = () => { rechecks++; if (rechecks === 2) f.result('complete'); };
  f.poll({ recheckFn });
  assert.equal(f.read().activeTask.status, 'waiting-ci');
  f.poll({ recheckFn });
  assert.equal(rechecks, 2);
  assert.equal(f.read().activeTask.status, 'complete');
  assert.equal(f.calls.length, 0);
});

test('unchanged GitHub rejects malformed or mismatched receipt instead of hiding it', t => {
  const f = fixture(t);
  f.result('complete', { sessionId: 'another-session' });
  const out = f.poll();
  assert.equal(f.read().activeTask.blockedKind, 'invalid-result');
  assert.equal(out.events[0].kind, 'repair-blocked');
  assert.equal(f.calls.length, 0);
});

for (const surface of ['comments', 'reviews']) for (const severity of ['P0', 'P1', 'P2', 'P3', 'unknown']) {
  test(`${surface} ${severity} respects repair scope even when GitHub is mergeable`, t => {
    const f = fixture(t);
    writePr(f.home, ID, { ...f.entry, activeTask: { status: 'complete' }, lastDispatch: null, pollFingerprint: 'old' });
    f.collected[surface] = [{ id: 'finding-1', author: { login: 'greptile-apps', __typename: 'Bot' },
      body: `${severity}: example finding`, state: 'COMMENTED', commit: { oid: HEAD }, updatedAt: now, submittedAt: now }];
    const authorized = ['P0', 'P1', 'P2'].includes(severity);
    const out = f.poll();
    assert.equal(f.calls.length, authorized ? 1 : 0);
    if (!authorized) return;
    assert.equal(f.calls[0].target_session_id, SESSION);
    assert.equal(out.prs[0].mergeReady, false);
    const e = f.read();
    const file = path.join(f.home, 'state/results', e.activeTask.dispatchId + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, dispatchId: e.activeTask.dispatchId, nodeId: ID,
      sessionId: SESSION, head: HEAD, status: 'complete', ci: { head: HEAD, requiredGreen: true }, verification: { status: 'pass' } }));
    f.poll();
    assert.equal(f.read().activeTask.status, 'complete');
    // A later unrelated remote event must not reopen already consumed feedback.
    f.snapshot.commentCount = 2;
    f.poll();
    assert.equal(f.calls.length, 1);
    assert.equal(f.read().mergeReady, true);
  });
}

test('standalone finding remains pending while its owner has not returned a result', t => {
  const f = fixture(t);
  writePr(f.home, ID, { ...f.entry, activeTask: { status: 'complete' }, lastDispatch: null, pollFingerprint: 'old' });
  f.collected.comments = [{ id: 'finding-recover', author: { login: 'greptile-apps', __typename: 'Bot' },
    body: 'P1: repair must not disappear when its cursor is consumed', updatedAt: now }];
  f.poll();
  assert.equal(f.calls.length, 1);
  const out = f.poll({ now: '2026-10-01T12:31:00Z' });
  assert.equal(out.prs[0].dispatch.reason, 'missing-result-recovery');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].target_session_id, SESSION);
  assert.equal(f.read().mergeReady, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackItems } from './bin/cindy-watcher.mjs';
import { isAutoCloseEligible, isThreadAutoCloseEligible, partitionAutoClose, autoCloseThreads, autoCloseReplyText } from './bin/cindy-review-resolve.mjs';
import { dispatchParams, newFeedback, scanOnce, watcherPaths } from './bin/cindy-watcher.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEAD = 'a'.repeat(40);
const PR = { headRefOid: HEAD };
const GREPTILE_AUTHOR = { login: 'greptile-apps[bot]' };
const HUMAN_AUTHOR = { login: 'some-human' };

function threadItems({ threadId = 't1', isResolved = false, body, author = GREPTILE_AUTHOR, commentId = 'c1' } = {}) {
  const threads = [{
    id: threadId, isResolved, isOutdated: false, path: 'src/a.ts',
    comments: [{ id: commentId, author, body, createdAt: '2026-09-10T00:00:00Z' }],
  }];
  return feedbackItems({ pr: PR, threads });
}

test('P3 greptile thread item is auto-close eligible', () => {
  const [item] = threadItems({ body: 'P3: naming nit, consider renaming' });
  assert.equal(item.category, 'reply-resolve');
  assert.equal(item.repairPolicy.action, 'reply-only');
  assert.equal(item.threadId, 't1');
  assert.equal(isAutoCloseEligible(item), true);
});

test('P2 greptile thread item is authorized fix, not auto-close', () => {
  const [item] = threadItems({ body: 'P2: must-fix this PR' });
  assert.equal(item.category, 'actionable-fix');
  assert.equal(isAutoCloseEligible(item), false);
});

test('P0/P1 thread item is never auto-close eligible', () => {
  const [item] = threadItems({ body: 'P0: crash on null input, must fix before merge' });
  assert.equal(item.category, 'actionable-fix');
  assert.equal(isAutoCloseEligible(item), false);
});

test('severity-unconfirmed thread item is not auto-close eligible', () => {
  const [item] = threadItems({ body: 'thanks for the update, looks fine to me' });
  assert.equal(item.repairPolicy.reason, 'severity-unconfirmed');
  assert.equal(isAutoCloseEligible(item), false);
});

test('untrusted-source P3-looking thread item is not auto-close eligible', () => {
  const [item] = threadItems({ body: 'P3: naming nit', author: HUMAN_AUTHOR });
  assert.equal(item.repairPolicy.reason, 'unverified-review-source');
  assert.equal(isAutoCloseEligible(item), false);
});

test('mixed P0+P3 on same line is not auto-close eligible (needs-triage)', () => {
  const [item] = threadItems({ body: 'P0 crash here, also P3 naming nit on the same line' });
  assert.equal(item.repairPolicy.action, 'needs-triage');
  assert.equal(isAutoCloseEligible(item), false);
});

test('partitionAutoClose splits eligible P3 threads from everything else', () => {
  const items = [
    ...threadItems({ threadId: 't-p3', body: 'P3: naming nit' }),
    ...threadItems({ threadId: 't-p0', body: 'P0: crash on null input' }),
  ];
  const { eligible, remaining } = partitionAutoClose(items);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].threadId, 't-p3');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].threadId, 't-p0');
});

function mixedThread({ threadId = 't-mix', isResolved = false, commentsHasNextPage = false } = {}) {
  return {
    id: threadId, isResolved, isOutdated: false, path: 'src/a.ts', commentsHasNextPage,
    comments: [
      { id: 'c-p1', author: GREPTILE_AUTHOR, body: 'P1: crash on null', createdAt: '2026-09-10T00:00:00Z' },
      { id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:01:00Z' },
    ],
  };
}

test('same thread mixed P1+P3 is not auto-closed and P1 stays in remaining', () => {
  const items = feedbackItems({ pr: PR, threads: [mixedThread()] });
  const { eligible, remaining } = partitionAutoClose(items, { allItems: items, threads: [mixedThread()] });
  assert.equal(eligible.length, 0);
  assert.equal(isThreadAutoCloseEligible(items, {}), false);
  assert.equal(remaining.some((item) => item.repairPolicy?.severities?.includes('P1')), true);
  assert.equal(remaining.some((item) => item.repairPolicy?.severities?.includes('P3')), true);
});

test('old P1 plus new P3 on the same thread is not auto-closed', () => {
  const allItems = feedbackItems({ pr: PR, threads: [mixedThread()] });
  const p3 = allItems.filter((item) => item.repairPolicy?.severities?.includes('P3'));
  const { eligible, remaining } = partitionAutoClose(p3, { allItems, threads: [mixedThread()] });
  assert.equal(eligible.length, 0);
  assert.equal(remaining.length, p3.length);
});

test('incomplete thread comment pagination is fail-closed', () => {
  const thread = mixedThread({ commentsHasNextPage: true });
  thread.comments = [{ id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:00:00Z' }];
  const items = feedbackItems({ pr: PR, threads: [thread] });
  const { eligible } = partitionAutoClose(items, { allItems: items, threads: [thread] });
  assert.equal(eligible.length, 0);
  assert.equal(isThreadAutoCloseEligible(items, { commentsHasNextPage: true }), false);
});

test('bot P3 plus author do-not-resolve comment is not auto-closed', () => {
  const thread = {
    id: 't-author', isResolved: false, comments: [
      { id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:00:00Z' },
      { id: 'c-owner', author: { login: 'owner' }, body: 'P1 security bug remains; do not resolve', createdAt: '2026-09-10T00:02:00Z' },
    ],
  };
  const items = feedbackItems({ pr: PR, threads: [thread] });
  assert.equal(isThreadAutoCloseEligible(items), false);
  const { eligible, remaining } = partitionAutoClose(items, { allItems: items, threads: [thread] });
  assert.equal(eligible.length, 0);
  assert.ok(remaining.length >= 1);
  assert.equal(items.find((item) => item.nativeId.endsWith('c-owner')).repairPolicy.canChangeCode, false);
});

test('bot P3 plus author ack is not auto-closed', () => {
  const thread = {
    id: 't-ack', isResolved: false, comments: [
      { id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:00:00Z' },
      { id: 'c-owner', author: { login: 'owner' }, body: 'ack, will consider later', createdAt: '2026-09-10T00:02:00Z' },
    ],
  };
  const items = feedbackItems({ pr: PR, threads: [thread] });
  const { eligible } = partitionAutoClose(items, { allItems: items, threads: [thread] });
  assert.equal(eligible.length, 0);
});

test('resolved outdated P1 on old head is handled and not dispatched', () => {
  const shaA = 'c'.repeat(40);
  const shaB = HEAD;
  const items = feedbackItems({
    pr: { headRefOid: shaB },
    threads: [{ id: 't-old', isResolved: true, isOutdated: true, comments: [
      { id: 'c-p1', author: GREPTILE_AUTHOR, body: 'P1: crash on null', originalCommit: { oid: shaA }, createdAt: '2026-09-10T00:00:00Z' },
      { id: 'c-fix', author: { login: 'owner' }, body: 'Fixed in B', createdAt: '2026-09-10T00:03:00Z' },
    ] }],
  });
  assert.equal(items[0].actionable, false);
  assert.equal(items[0].sha, shaA);
  assert.equal(items[0].repairPolicy.reason, 'non-actionable-or-resolved');
  assert.equal(newFeedback({}, items).fresh.length, 0);
});

function scanHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-close-scan-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.statePath, JSON.stringify({
    version: 2, repo: 'makecindy/cindy', prs: {
      PR_1: {
        number: 1, nodeId: 'PR_1', sessionId: 's1', eligibilityInitialized: true, eligibility: 'active',
        admissionVerified: true, admissionEpoch: 'e', activeTask: { status: 'complete' },
      },
    },
  }));
  return paths;
}

const listed = { number: 1, id: 'PR_1', headRefOid: HEAD, headRefName: 'fix/x', title: 't', isDraft: false, labels: [] };
const OWNER_PR = {
  id: 'PR_1', number: 1, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true,
  author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' },
  headRefOid: HEAD, baseRefOid: 'b'.repeat(40), releaseEpoch: 'e',
};
function mixedCollect() {
  return {
    pr: OWNER_PR, admissionVerified: true,
    threads: [mixedThread({ threadId: 'TH_mix' })],
    mergeReady: false,
  };
}
function scanOpts(paths, extra = {}) {
  return {
    enabled: true, allowDispatch: true, paths, now: '2026-09-10T00:00:00Z',
    ghFn: (args) => args[0] === 'api' ? 'owner' : JSON.stringify([listed]),
    ownershipSnapshot: function* () { return { pr: OWNER_PR }; },
    ...extra,
  };
}

test('scanOnce mixed P1+P3 thread does not auto-close and dispatches P1', (t) => {
  const paths = scanHome(t);
  let sent = 0;
  let payload;
  const result = scanOnce(scanOpts(paths, {
    collect: mixedCollect,
    dispatchFn: (params) => { sent += 1; payload = params; return { target_session_id: 's1' }; },
  }));
  assert.equal(sent, 1);
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(result.prs[0].autoClosed, undefined);
  assert.match(JSON.stringify(payload), /P1/);
});

test('dispatch-budget-deferred then next round still repairs mixed-thread P1', (t) => {
  const paths = scanHome(t);
  let clock = 0;
  let sent = 0;
  const first = scanOnce(scanOpts(paths, {
    budgetMs: 84000, perPrBudgetMs: 75000, clock: () => clock,
    collect: () => { clock += 20000; return mixedCollect(); },
    dispatchFn: () => { sent += 1; return { target_session_id: 's1' }; },
  }));
  assert.equal(sent, 0);
  assert.equal(first.prs[0].dispatch.reason, 'dispatch-budget-deferred');
  clock = 0;
  const second = scanOnce(scanOpts(paths, {
    budgetMs: 120000, clock: () => clock,
    collect: mixedCollect,
    dispatchFn: () => { sent += 1; return { target_session_id: 's1' }; },
  }));
  assert.equal(sent, 1);
  assert.equal(second.prs[0].dispatch.attempted, true);
  assert.equal(second.prs[0].autoClosed, undefined);
});

const SHA_A = 'c'.repeat(40);
function p1Comment(extra = {}) {
  return { id: 'c-p1', author: GREPTILE_AUTHOR, body: 'P1: crash on null', createdAt: '2026-09-10T00:00:00Z', originalCommit: { oid: SHA_A }, ...extra };
}

test('resolved flip does not create fresh; reopen of P1 does', () => {
  const open = feedbackItems({ pr: { headRefOid: HEAD }, threads: [{ id: 't-flip', isResolved: false, isOutdated: false, comments: [p1Comment()] }] });
  const first = newFeedback({}, open);
  assert.equal(first.fresh.length, 1);
  const closed = feedbackItems({ pr: { headRefOid: HEAD }, threads: [{ id: 't-flip', isResolved: true, isOutdated: false, comments: [p1Comment()] }] });
  const afterResolve = newFeedback(first.cursor, closed);
  assert.equal(afterResolve.fresh.length, 0);
  const reopened = feedbackItems({ pr: { headRefOid: HEAD }, threads: [{ id: 't-flip', isResolved: false, isOutdated: false, comments: [p1Comment()] }] });
  const afterReopen = newFeedback(afterResolve.cursor, reopened);
  assert.equal(afterReopen.fresh.length, 1);
  assert.equal(afterReopen.fresh[0].repairPolicy.canChangeCode, true);
});

test('scanOnce resolved outdated P1 on old commit does not dispatch', (t) => {
  const paths = scanHome(t);
  let sent = 0;
  const result = scanOnce(scanOpts(paths, {
    collect: () => ({
      pr: { ...OWNER_PR, headRefOid: HEAD },
      admissionVerified: true,
      threads: [{ id: 'TH_old', isResolved: true, isOutdated: true, comments: [
        p1Comment(),
        { id: 'c-fix', author: { login: 'owner' }, body: 'Fixed in B', createdAt: '2026-09-10T00:03:00Z' },
      ] }],
      mergeReady: false,
    }),
    dispatchFn: () => { sent += 1; return { target_session_id: 's1' }; },
  }));
  assert.equal(sent, 0);
  assert.equal(result.prs[0].dispatch.attempted, false);
});

test('outdated unresolved P1 dispatches with original sha and verify instruction', (t) => {
  const paths = scanHome(t);
  let payload;
  const result = scanOnce(scanOpts(paths, {
    collect: () => ({
      pr: { ...OWNER_PR, headRefOid: HEAD },
      admissionVerified: true,
      threads: [{ id: 'TH_out', isResolved: false, isOutdated: true, comments: [p1Comment()] }],
      mergeReady: false,
    }),
    dispatchFn: (params) => { payload = params; return { target_session_id: 's1' }; },
  }));
  assert.equal(result.prs[0].dispatch.attempted, true);
  const text = JSON.stringify(payload);
  assert.match(text, new RegExp(SHA_A));
  assert.match(text, /针对旧提交/);
  assert.match(text, /核实/);
  assert.doesNotMatch(text, new RegExp(`"sha":"${HEAD}"`));
  const item = feedbackItems({
    pr: { headRefOid: HEAD },
    threads: [{ id: 'TH_out', isResolved: false, isOutdated: true, comments: [p1Comment()] }],
  })[0];
  assert.equal(item.sha, SHA_A);
  assert.equal(item.isOutdated, true);
  const params = dispatchParams({ pr: OWNER_PR, mapping: { sessionId: 's1' }, fresh: [{ ...item, key: 'thread:x' }], now: '2026-09-10T00:00:00Z' });
  assert.match(params.message, /针对旧提交 c{40}/);
});

test('autoCloseReplyText does not restate a specific bot original verbatim', () => {
  const text = autoCloseReplyText();
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  assert.ok(!text.includes('naming nit'));
});

function collectYields(gen) {
  const calls = [];
  let step = gen.next();
  while (!step.done) {
    const value = step.value();
    calls.push(value);
    step = gen.next(value);
  }
  return { calls, result: step.value };
}

test('autoCloseThreads posts a reply then resolves, and records a durable receipt', () => {
  const [item] = threadItems({ threadId: 't-p2', body: 'P3: naming nit' });
  const ghCalls = [];
  const ghFn = (args) => { ghCalls.push(args); return '{}'; };
  const { calls, result } = collectYields(autoCloseThreads({ eligible: [item], previous: {}, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(calls.length, 2);
  assert.ok(ghCalls[0].some((a) => typeof a === 'string' && a.startsWith('query=') && a.includes('addPullRequestReviewThreadReply')));
  assert.ok(ghCalls[1].some((a) => typeof a === 'string' && a.startsWith('query=') && a.includes('resolveReviewThread')));
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].threadId, 't-p2');
  assert.ok(result.previous.autoClosedThreads['t-p2']);
});

test('autoCloseThreads is idempotent: already-closed thread is skipped on a re-run', () => {
  const [item] = threadItems({ threadId: 't-p2', body: 'P3: naming nit' });
  const previous = { autoClosedThreads: { 't-p2': { at: '2026-09-28T00:00:00Z', key: null, nativeId: null } } };
  const ghFn = () => { throw new Error('must not call GitHub for an already-closed thread'); };
  const { calls, result } = collectYields(autoCloseThreads({ eligible: [item], previous, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(calls.length, 0);
  assert.equal(result.closed.length, 0);
  assert.ok(result.previous.autoClosedThreads['t-p2']);
});

test('autoCloseThreads never touches non-eligible items even if forced into eligible list', () => {
  // Defensive: eligible list should only ever contain reply-resolve items in production
  // (enforced by partitionAutoClose), but the generator itself must not assume threadId shape.
  const [item] = threadItems({ threadId: 't-p2', body: 'P3: naming nit' });
  const ghCalls = [];
  const ghFn = (args) => { ghCalls.push(args); return '{}'; };
  const { result } = collectYields(autoCloseThreads({ eligible: [item, item], previous: {}, ghFn, now: '2026-09-29T00:00:00Z' }));
  // Duplicate same threadId within one round must only be closed once.
  assert.equal(ghCalls.length, 2);
  assert.equal(result.closed.length, 1);
});

test('403 on reply degrades instead of throwing', () => {
  const [item] = threadItems({ threadId: 't-p3', body: 'P3: naming nit' });
  const ghFn = () => {
    const error = new Error('GraphQL: Resource not accessible by integration');
    error.status = 403;
    throw error;
  };
  const { result } = collectYields(autoCloseThreads({ eligible: [item], previous: {}, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].degraded, true);
  assert.equal(result.closed[0].reason, 'permission-denied');
  assert.equal(result.previous.autoClosedThreads?.['t-p3'], undefined);
});

test('live unresolved thread from an older head keeps code authority through task and helper', async (t) => {
  const { taskRepairPolicy, feedbackRepairPolicy } = await import('./bin/cindy-feedback-policy.mjs');
  const { validateScs, assertTaskRepairScope } = await import('./bin/cindy-repair.mjs');
  const paths = scanHome(t);
  let payload;
  const threads = [{ id: 'TH_live', isResolved: false, isOutdated: false, comments: [p1Comment()] }];
  const result = scanOnce(scanOpts(paths, {
    collect: () => ({ pr: { ...OWNER_PR, headRefOid: HEAD }, admissionVerified: true, threads, mergeReady: false }),
    dispatchFn: (params) => { payload = params; return { target_session_id: 's1' }; },
  }));
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.doesNotMatch(payload.message, /NO_CODE_NO_PUSH_NO_EXTERNAL_REPLY/);
  assert.match(payload.message, new RegExp(`thread TH_live 针对旧提交 ${SHA_A}，先核实`));

  const [item] = feedbackItems({ pr: { headRefOid: HEAD }, threads });
  assert.equal(item.sha, SHA_A);
  const task = { headRefOid: HEAD, feedback: [{ ...item, key: 'thread:TH_live' }] };
  const policy = taskRepairPolicy(task);
  assert.equal(policy.canChangeCode, true);
  assert.deepEqual(policy.allowedFeedbackKeys, ['thread:TH_live']);
  assert.doesNotThrow(() => validateScs({ scs: [{ id: 'SC-1', status: 'pass', evidence: ['fixed null crash'], feedbackKeys: ['thread:TH_live'] }] }, task));
  if (typeof assertTaskRepairScope === 'function') assert.doesNotThrow(() => assertTaskRepairScope(task, HEAD));

  // Non-thread review on an older commit keeps the stale-head guard.
  const staleReview = feedbackRepairPolicy({ source: 'greptile', nativeId: 'r1', sha: SHA_A, body: 'P1: crash', author: GREPTILE_AUTHOR, __typename: 'Bot' }, { headSha: HEAD });
  assert.equal(staleReview.reason, 'stale-head');
  assert.equal(staleReview.canChangeCode, false);
});

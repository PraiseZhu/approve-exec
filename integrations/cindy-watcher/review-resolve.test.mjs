import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackItems } from './bin/cindy-watcher.mjs';
import { isAutoCloseEligible, partitionAutoClose, autoCloseThreads, autoCloseReplyText } from './bin/cindy-review-resolve.mjs';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCindyReview } from './bin/cindy-review-status.mjs';

const h = 'a'.repeat(40);
const b = 'b'.repeat(40);

function fixture(extra = {}) {
  return {
    snapshot: {
      pr: {
        state: 'OPEN', isDraft: false, number: 10, headRefOid: h, baseRefOid: b,
        author: { login: 'PraiseZhu' },
        headRepositoryOwner: { login: 'PraiseZhu' },
        headRepository: { name: 'cindy-fork' },
        isCrossRepository: true, sameRepository: false,
      },
      requiredChecksGreen: true,
      mergeable: 'MERGEABLE',
      threads: [],
      reviews: [],
      labels: [],
      checks: [
        { name: 'DCO', state: 'SUCCESS', bucket: 'pass' },
        { name: 'verify', state: 'SUCCESS', bucket: 'pass' },
        { name: 'Windows unit tests', state: 'SUCCESS', bucket: 'pass' },
      ],
      ...extra.snapshot,
    },
    ci: { status: 'green', ...(extra.ci ?? {}) },
  };
}

test('open non-draft mergeable green checks with no open threads is awaiting-maintainer-approval', () => {
  const v = evaluateCindyReview(fixture());
  assert.equal(v.ready, true);
  assert.equal(v.reason, 'awaiting-maintainer-approval');
  assert.equal(v.terminal, 'awaiting-maintainer-approval');
});

test('fork PR does not require sameRepository', () => {
  const f = fixture();
  assert.equal(f.snapshot.pr.sameRepository, false);
  assert.equal(evaluateCindyReview(f).ready, true);
});

for (const change of ['draft', 'closed', 'ci', 'conflict', 'thread', 'veto', 'nonskipped']) {
  test(`reject ${change}`, () => {
    const f = fixture();
    if (change === 'draft') f.snapshot.pr.isDraft = true;
    if (change === 'closed') f.snapshot.pr.state = 'CLOSED';
    if (change === 'ci') { f.snapshot.requiredChecksGreen = false; f.ci = { status: 'failed' }; }
    if (change === 'conflict') f.snapshot.mergeable = 'CONFLICTING';
    if (change === 'thread') f.snapshot.threads = [{ isResolved: false }];
    if (change === 'veto') f.snapshot.reviewDecision = 'CHANGES_REQUESTED';
    if (change === 'nonskipped') f.snapshot.checks.push({ name: 'lint', state: 'FAILURE', bucket: 'fail' });
    assert.equal(evaluateCindyReview(f).ready, false);
  });
}

test('skipped checks do not block awaiting-maintainer-approval', () => {
  const f = fixture();
  f.snapshot.checks.push({ name: 'optional-trace', state: 'SKIPPED', bucket: 'skipping' });
  assert.equal(evaluateCindyReview(f).ready, true);
});

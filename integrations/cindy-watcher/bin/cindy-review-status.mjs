// Cindy public-review analogue: no server 三审, no code-review.yml, no merge-ready labels.
// Ready means the watcher has nothing left to fix; a maintainer approve is still required.
import { collectPrSnapshot } from './cindy-pr-snapshot.mjs';
import { collectCindyCiSteps } from './cindy-ci.mjs';

export const REPO = 'makecindy/cindy';
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function checkName(check) {
  return String(check?.name ?? check?.context ?? '');
}
function isSkippedCheck(check) {
  const bucket = String(check?.bucket ?? '').toLowerCase();
  const state = String(check?.state ?? check?.conclusion ?? '').toUpperCase();
  const status = String(check?.status ?? '').toUpperCase();
  return bucket === 'skipping' || ['SKIPPED', 'NEUTRAL'].includes(state) || status === 'SKIPPED';
}
function isGreenCheck(check) {
  const bucket = String(check?.bucket ?? '').toLowerCase();
  const state = String(check?.state ?? '').toUpperCase();
  const conclusion = String(check?.conclusion ?? '').toUpperCase();
  return bucket === 'pass' || ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(state) || ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion);
}

export function evaluateCindyReview({ snapshot: s, ci } = {}) {
  const no = (reason) => ({ ready: false, reason, terminal: null });
  if (!s?.pr) return no('inactive');
  if (s.pr.state !== 'OPEN' || s.pr.isDraft) return no('inactive');
  const requiredGreen = ci?.status === 'green' || s.requiredChecksGreen === true;
  if (!requiredGreen) return no(ci?.status === 'failed' || s.ciStatus === 'failed' ? 'required-ci-failed' : 'waiting-ci');
  const checks = Array.isArray(s.checks) ? s.checks : [];
  const blocking = checks.filter((check) => checkName(check) && !isSkippedCheck(check));
  if (blocking.some((check) => !isGreenCheck(check))) return no('non-skipped-check-not-green');
  if (s.mergeable !== 'MERGEABLE') return no('merge-conflict-or-unknown');
  const threads = Array.isArray(s.threads) ? s.threads : [];
  if (threads.some((thread) => thread.isResolved === false)) return no('unresolved-threads');
  const reviews = Array.isArray(s.reviews) ? s.reviews : [];
  const latest = new Map();
  for (const review of reviews) {
    const key = review.author?.login;
    if (!key) return no('review-author-unknown');
    if (!latest.has(key) || Date.parse(review.submittedAt) > Date.parse(latest.get(key).submittedAt)) latest.set(key, review);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED' || [...latest.values()].some((review) => review.state === 'CHANGES_REQUESTED')) {
    return no('review-veto');
  }
  return { ready: true, reason: 'awaiting-maintainer-approval', terminal: 'awaiting-maintainer-approval' };
}

export function* collectCindyReview(pr, ghFn) {
  const snapshot = yield* collectPrSnapshot({ pr: { ...pr, repo: pr.repo ?? REPO }, ghFn });
  const ci = yield* collectCindyCiSteps({ pr: snapshot.pr, ghFn });
  snapshot.requiredChecksGreen = ci.status === 'green';
  const verdict = evaluateCindyReview({ snapshot, ci });
  const latest = parse(yield () => ghFn([
    'pr', 'view', String(pr.number), '--repo', snapshot.pr.repo,
    '--json', 'id,state,isDraft,headRefOid,baseRefOid,author,isCrossRepository,headRepository,headRepositoryOwner',
  ]));
  if (['id', 'state', 'isDraft', 'headRefOid', 'baseRefOid'].some((key) => latest[key] !== snapshot.pr[key])
    || latest.author?.login !== snapshot.pr.author.login) {
    throw Error('PR changed during review collection');
  }
  const admissionVerified = snapshot.pr.state === 'OPEN' && snapshot.pr.isDraft !== true && snapshot.requiredChecksGreen === true;
  return {
    ...snapshot,
    ci,
    admissionVerified,
    admissionReason: admissionVerified ? 'required-ci-green' : (snapshot.requiredChecksGreen ? 'inactive' : 'required-ci-not-green'),
    mergeReady: verdict.ready === true,
    reviewReason: verdict.reason,
    reviewEvidence: verdict,
    headOwner: snapshot.pr.headRepositoryOwner?.login ?? null,
    headRepo: snapshot.pr.headRepositoryOwner?.login && snapshot.pr.headRepository?.name
      ? `${snapshot.pr.headRepositoryOwner.login}/${snapshot.pr.headRepository.name}`
      : null,
  };
}

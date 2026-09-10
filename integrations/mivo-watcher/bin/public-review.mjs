// Consume the production review publisher's public contract; never invoke or mutate it.
import { collectPrSnapshot } from './mivo-pr-snapshot.mjs';
import { collectMivoCiSteps } from './mivo-ci.mjs';
const REPO = 'xindong/mivo-canvas-plugin';
const BOT = 41898282;
const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
const at = c => Date.parse(c.created_at ?? c.createdAt);
export function verdictComment(c) {
  if (c.user?.id !== BOT || c.user.login !== 'github-actions[bot]' || c.user.type !== 'Bot') return null;
  const body = c.body ?? '';
  const headings = [...body.matchAll(/^## 🤖 自动 Review 结论[：:]\s*(\S+)\s*$/gm)];
  if (headings.length !== 1 || !Number.isFinite(at(c))) return null;
  const markers = [...body.matchAll(/review-complete head_sha=([a-f0-9]{40}) base_sha=([a-f0-9]{40})/g)];
  const headOnly = /mivo-code-review depth=\S+ head_sha=([a-f0-9]{40})/.exec(body);
  return { id: c.id, verdict: headings[0][1], head: markers[0]?.[1] ?? headOnly?.[1], base: markers[0]?.[2],
    sealed: markers.length === 1, edited: c.updated_at !== c.created_at, at: at(c), body };
}
export function evaluatePublicReview({ snapshot: s, comments = s.comments, runs, jobs = {} }) {
  const no = reason => ({ ready: false, reason });
  if (s.pr.state !== 'OPEN' || s.pr.isDraft || !s.pr.sameRepository) return no('inactive');
  const all = comments.map(verdictComment).filter(Boolean).sort((a,b) => b.at-a.at || b.id-a.id);
  const current = all.find(c => c.head === s.pr.headRefOid && (!c.base || c.base === s.pr.baseRefOid));
  if (!current) return no('waiting-review');
  if (!current.sealed || current.edited) return no('review-incomplete-or-edited');
  // COMMENT is a finished review round with MEDIUM findings, not a clean pass.
  if (!['APPROVE', 'SKIP-LLM', 'SKIP-LOCAL'].includes(current.verdict)) return no(`review-${current.verdict.toLowerCase()}`);
  if (current.verdict === 'APPROVE') {
    const counts = [...current.body.matchAll(/三席聚合：(CRITICAL|P0) (\d+) · (HIGH|P1) (\d+) · (MEDIUM|P2) (\d+)/g)];
    if (counts.length !== 1 || [2,4,6].some(i => Number(counts[0][i]) !== 0)) return no('review-counts-not-clean');
  }
  const epoch = /(\d{4}-\d\d-\d\dT[^:]+:\d\d:[^:]+)$/.exec(s.pr.releaseEpoch ?? '')?.[1];
  if (!epoch || current.at < Date.parse(epoch)) return no('review-before-release');
  // GitHub run metadata binds the PR head; workflow source still executes from trusted BASE.
  const relevant = runs.filter(r => r.display_title === `Code Review [pr:${s.pr.number}]`
    && r.event === 'pull_request_target' && r.path === '.github/workflows/code-review.yml'
    && r.repository?.full_name === REPO && r.head_sha === s.pr.headRefOid
    && r.pull_requests?.some(p => p.number === s.pr.number && p.head?.sha === s.pr.headRefOid && p.base?.sha === s.pr.baseRefOid));
  const producer = relevant.filter(r => r.status === 'completed' && r.conclusion === 'success'
    && Date.parse(r.run_started_at ?? r.created_at) <= current.at && Date.parse(r.updated_at) >= current.at);
  if (producer.length !== 1) return no('producer-unverified');
  if (relevant.some(r => Date.parse(r.run_started_at ?? r.created_at) > current.at
    && !(r.status === 'completed' && r.conclusion === 'skipped'))) return no('newer-review-round');
  const required = current.verdict === 'APPROVE' ? ['gate', 'seat1', 'seat2', 'seat3', 'publish'] : ['gate'];
  const producerJobs = jobs[producer[0].id] ?? [];
  if (required.some(name => producerJobs.filter(j => j.name === name && j.run_id === producer[0].id && j.run_attempt === producer[0].run_attempt && j.status === 'completed' && j.conclusion === 'success').length !== 1)) return no('producer-jobs-incomplete');
  if (!s.requiredChecksGreen) return no('waiting-ci');
  if (s.mergeable !== 'MERGEABLE') return no('merge-conflict-or-unknown');
  if (s.threads.some(t => !t.isResolved)) return no('unresolved-threads');
  const latest = new Map();
  for (const r of s.reviews) {
    const key = r.author?.login;
    if (!key) return no('review-author-unknown');
    if (!latest.has(key) || Date.parse(r.submittedAt) > Date.parse(latest.get(key).submittedAt)) latest.set(key,r);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED' || [...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) return no('review-veto');
  if (s.labels.includes('awaiting-discussion')) return no('discussion-hold');
  if (comments.some(c => at(c) > current.at && c.user?.login !== s.pr.author.login && !verdictComment(c) && c.body?.trim())) return no('new-feedback');
  return { ready: true, reason: current.verdict === 'APPROVE' ? 'current-approve' : 'current-classifier-skip', commentId: current.id, runId: producer[0].id };
}

export function* collectPublicReview(pr, ghFn) {
  const snapshot = yield* collectPrSnapshot({pr: {...pr, repo: REPO}, ghFn});
  const ci = yield* collectMivoCiSteps({pr:snapshot.pr, ghFn});
  snapshot.requiredChecksGreen = ci.status === 'green';
  const pages = parse(yield () => ghFn(['api', `repos/${REPO}/actions/workflows/code-review.yml/runs?per_page=100&head_sha=${snapshot.pr.headRefOid}&event=pull_request_target`, '--paginate', '--slurp']));
  if (!Array.isArray(pages) || !pages.every(p => Array.isArray(p.workflow_runs))) throw Error('review run pagination incomplete');
  const runs = pages.flatMap(p => p.workflow_runs);
  const current = snapshot.comments.map(verdictComment).filter(c => c?.head === snapshot.pr.headRefOid && c.base === snapshot.pr.baseRefOid).sort((a,b) => b.at-a.at)[0];
  const jobs = {};
  if (current) for (const r of runs.filter(r => r.display_title === `Code Review [pr:${pr.number}]` && r.status === 'completed' && r.conclusion === 'success'
    && Date.parse(r.run_started_at ?? r.created_at) <= current.at && Date.parse(r.updated_at) >= current.at)) {
    const jp = parse(yield () => ghFn(['api', `repos/${REPO}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100`, '--paginate', '--slurp']));
    if (!Array.isArray(jp) || !jp.every(p => Array.isArray(p.jobs))) throw Error('review job pagination incomplete');
    jobs[r.id] = jp.flatMap(p => p.jobs);
  }
  const verdict = evaluatePublicReview({snapshot, runs, jobs});
  const reviewIngress = runs.some(r => r.display_title === `Code Review [pr:${pr.number}]` && r.event === 'pull_request_target' && r.head_sha === snapshot.pr.headRefOid);
  const handled = snapshot.comments.filter(c => {
    const v = verdictComment(c);
    return v && (v.head !== snapshot.pr.headRefOid || !['COMMENT','REQUEST_CHANGES','CHANGES_REQUESTED'].includes(v.verdict));
  }).map(c => c.id);
  const latest = parse(yield () => ghFn(['pr','view',String(pr.number),'--repo',REPO,'--json','id,state,isDraft,headRefOid,baseRefOid,author']));
  if (['id','state','isDraft','headRefOid','baseRefOid'].some(k=>latest[k] !== snapshot.pr[k]) || latest.author?.login !== snapshot.pr.author.login) throw Error('PR changed during review collection');
  return {...snapshot, comments: snapshot.comments.filter(c => !handled.includes(c.id)),
    // Review infrastructure failures belong to its maintainer, never a business repair owner.
    checks: snapshot.checks.filter(c => !['gate','seat1','seat2','seat3','publish','native_attestation','control_attestation'].includes(c.name)),
    admissionVerified: snapshot.requiredChecksGreen && reviewIngress,
    admissionReason: snapshot.requiredChecksGreen ? (reviewIngress ? 'required-ci-and-review-ingress' : 'review-ingress-missing') : 'required-ci-not-green',
    mergeReady: verdict.ready, reviewReason: verdict.reason, reviewEvidence: verdict};
}

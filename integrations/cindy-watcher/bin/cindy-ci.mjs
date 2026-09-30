import { createHash } from 'node:crypto';
import { collectCindyPolicySteps, evaluateCindyCi } from './cindy-pr-policy.mjs';

const parse = raw => typeof raw === 'string' ? JSON.parse(raw) : raw;
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function* collectCindyCiSteps({ pr, ghFn }) {
  const policy = yield* collectCindyPolicySteps({ repo: pr.repo, number: pr.number, gh: ghFn });
  if (policy.status !== 'verified' || policy.prNodeId !== pr.id || policy.headSha !== pr.headRefOid
    || policy.baseSha !== pr.baseRefOid) return { policy, status: 'unknown', required: [], reason: 'policy-or-snapshot-unverified' };
  try {
    const pages = parse(yield () => ghFn(['api', `repos/${pr.repo}/commits/${pr.headRefOid}/check-runs?per_page=100&filter=all`, '--paginate', '--slurp']));
    check(Array.isArray(pages) && pages.every(p => Array.isArray(p.check_runs)), 'check pagination incomplete');
    const checks = pages.flatMap(p => p.check_runs);
    const jobs = new Map();
    const runs = new Map();
    for (const item of checks) {
      check(item && item.head_sha === pr.headRefOid, 'check head drift');
      if (!policy.required.some(rule => rule.context === item.name && (rule.appId === null || rule.appId === item.app?.id))) continue;
      const time = Date.parse(item.started_at ?? item.created_at);
      if (Number.isFinite(time) && checks.some(other => other.name === item.name && other.app?.id === item.app?.id
        && Date.parse(other.started_at ?? other.created_at) > time)) continue;
      if (item.app?.slug !== 'github-actions') continue;
      const url = new URL(item.details_url);
      check(url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password, 'invalid check job URL');
      const match = new RegExp(`^/${pr.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/(\\d+)/job/(\\d+)/?$`).exec(url.pathname);
      check(match, 'Actions check has no bound job URL');
      const [, runId, jobId] = match;
      if (!jobs.has(jobId)) jobs.set(jobId, parse(yield () => ghFn(['api', `repos/${pr.repo}/actions/jobs/${jobId}`])));
      const job = jobs.get(jobId);
      check(job.id === Number(jobId) && job.run_id === Number(runId) && job.head_sha === pr.headRefOid
        && job.check_run_url === `https://api.github.com/repos/${pr.repo}/check-runs/${item.id}`, 'Actions job/check mismatch');
      if (!runs.has(runId)) runs.set(runId, parse(yield () => ghFn(['api', `repos/${pr.repo}/actions/runs/${runId}`])));
      const run = runs.get(runId);
      check(run.id === Number(runId) && run.repository?.full_name === pr.repo && run.head_sha === pr.headRefOid
        && job.run_attempt === run.run_attempt, 'Actions workflow/head/attempt mismatch');
      Object.assign(item, { workflowHeadSha: run.head_sha, runId: run.id, runAttempt: run.run_attempt });
    }
    const statusPages = parse(yield () => ghFn(['api', `repos/${pr.repo}/commits/${pr.headRefOid}/statuses?per_page=100`, '--paginate', '--slurp']));
    check(Array.isArray(statusPages) && statusPages.every(Array.isArray), 'status pagination incomplete');
    const statuses = statusPages.flat().map(s => ({ ...s, sha: pr.headRefOid }));
    const result = evaluateCindyCi({ policy, headSha: pr.headRefOid, checks, statuses });
    const after = parse(yield () => ghFn(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'id,headRefOid,baseRefOid,state,isDraft']));
    check(after.id === pr.id && after.headRefOid === pr.headRefOid && after.baseRefOid === pr.baseRefOid
      && after.state === pr.state && after.isDraft === pr.isDraft, 'PR changed during CI collection');
    return { ...result, policy, checks, statuses, ciHash: digest(result.required) };
  } catch (error) { return { status: 'unknown', policy, required: [], reason: error.message }; }
}

export function collectCindyCiSync(options) {
  const iterator = collectCindyCiSteps(options);
  let step = iterator.next();
  while (!step.done) {
    try {
      const value = step.value();
      if (value?.then) throw new Error('async transport used with synchronous CI collection');
      step = iterator.next(value);
    } catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}

export async function collectCindyCi(options) {
  const iterator = collectCindyCiSteps(options);
  let step = iterator.next();
  while (!step.done) {
    try { step = iterator.next(await step.value()); }
    catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}

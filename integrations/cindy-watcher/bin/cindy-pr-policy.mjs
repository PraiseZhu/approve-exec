import { createHash } from 'node:crypto';

const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

function requiredKeySet(map) {
  return [...map.keys()].sort().join('\n');
}

function addRequired(required, context, appId, source) {
  assert(typeof context === 'string' && context.trim() === context && context.length > 0, 'invalid required context');
  assert(appId === null || Number.isSafeInteger(appId) && appId > 0, 'invalid required app');
  if (appId === null) {
    const scoped = [...required.values()].filter((item) => item.context === context && item.appId != null);
    if (scoped.length) {
      for (const item of scoped) {
        if (!item.sources.includes(source)) item.sources.push(source);
      }
      return;
    }
  }
  const key = JSON.stringify([context, appId]);
  if (!required.has(key)) required.set(key, { context, appId, sources: [] });
  const item = required.get(key);
  if (!item.sources.includes(source)) item.sources.push(source);
}

function* loadBranchRequired({ gh, repo, baseRefName, branchPath, isProtected, into }) {
  const rulesPages = parse(yield () => gh(['api', `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}?per_page=100`, '--paginate', '--slurp']));
  assert(Array.isArray(rulesPages) && rulesPages.every(Array.isArray), 'incomplete effective rules');
  for (const rule of rulesPages.flat()) {
    assert(rule && typeof rule.type === 'string', 'invalid effective rule');
    if (rule.type !== 'required_status_checks') continue;
    assert(Array.isArray(rule.parameters?.required_status_checks), 'invalid ruleset required checks');
    for (const check of rule.parameters.required_status_checks) addRequired(into, check.context, check.integration_id ?? null, `ruleset:${rule.ruleset_id ?? 'effective'}`);
  }
  if (!isProtected) return into;
  let protection;
  try { protection = parse(yield () => gh(['api', `${branchPath}/protection`])); }
  catch (error) {
    if (error.status === 404 && error.apiMessage === 'Branch not protected') protection = { required_status_checks: null };
    else throw error;
  }
  assert(protection && typeof protection === 'object', 'unknown classic protection');
  const classic = protection.required_status_checks;
  if (classic !== null) {
    assert(classic && Array.isArray(classic.contexts) && Array.isArray(classic.checks), 'unknown classic checks');
    for (const check of classic.checks) addRequired(into, check.context, check.app_id === -1 ? null : check.app_id ?? null, 'classic');
    for (const context of classic.contexts) if (!classic.checks.some((check) => check.context === context)) addRequired(into, context, null, 'classic');
  }
  return into;
}

export function* collectCindyPolicySteps({ repo, number, gh }) {
  const checkedAt = new Date().toISOString();
  try {
    assert(/^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isSafeInteger(Number(number)) && Number(number) > 0, 'invalid PR identity');
    const viewArgs = ['pr', 'view', String(number), '--repo', repo, '--json', 'id,number,headRefOid,baseRefOid,baseRefName'];
    const before = parse(yield () => gh(viewArgs));
    assert(before.id && before.number === Number(number) && sha(before.headRefOid) && sha(before.baseRefOid) && before.baseRefName, 'incomplete PR identity');
    const branchPath = `repos/${repo}/branches/${encodeURIComponent(before.baseRefName)}`;
    const branch = parse(yield () => gh(['api', branchPath]));
    assert(typeof branch.protected === 'boolean', 'unknown protection');
    const required = new Map();
    const branchArgs = { gh, repo, baseRefName: before.baseRefName, branchPath, isProtected: branch.protected, into: required };
    yield* loadBranchRequired(branchArgs);
    const firstKeys = requiredKeySet(required);
    if (!required.size) return { status: 'unknown', reason: 'no-required-checks-from-rules', repo, prNodeId: before.id, number: Number(number), headSha: before.headRefOid, baseSha: before.baseRefOid, baseRefName: before.baseRefName, checkedAt };
    const second = yield* loadBranchRequired({ ...branchArgs, into: new Map() });
    const after = parse(yield () => gh(viewArgs));
    const identity = { repo, prNodeId: before.id, number: Number(number), headSha: before.headRefOid, baseSha: before.baseRefOid, baseRefName: before.baseRefName };
    if (['id', 'number', 'headRefOid', 'baseRefOid', 'baseRefName'].some((key) => before[key] !== after[key])) return { status: 'stale', reason: 'PR identity changed', ...identity, checkedAt };
    if (requiredKeySet(second) !== firstKeys) return { status: 'stale', reason: 'required-policy-changed', ...identity, checkedAt };
    const entries = [...required.values()].map((entry) => ({ ...entry, sources: entry.sources.sort() })).sort((a, b) => a.context.localeCompare(b.context) || (a.appId ?? 0) - (b.appId ?? 0));
    return { status: 'verified', source: 'rules-api', ...identity, required: entries, policyHash: digest({ baseSha: identity.baseSha, required: entries }), checkedAt };
  } catch (error) {
    return { status: 'unknown', reason: error.message, repo, number: Number(number), checkedAt };
  }
}

export function collectCindyPolicySync(options) {
  const iterator = collectCindyPolicySteps(options);
  let step = iterator.next();
  while (!step.done) {
    let value;
    try {
      value = step.value();
      assert(!value || typeof value.then !== 'function', 'async transport used with sync policy collector');
    } catch (error) { step = iterator.throw(error); continue; }
    step = iterator.next(value);
  }
  return step.value;
}

export async function collectCindyPolicy(options) {
  const iterator = collectCindyPolicySteps(options);
  let step = iterator.next();
  while (!step.done) {
    let value;
    try { value = await step.value(); }
    catch (error) { step = iterator.throw(error); continue; }
    step = iterator.next(value);
  }
  return step.value;
}

export function evaluateCindyCi({ policy, headSha, checks = [], statuses = [] }) {
  if (policy?.status !== 'verified' || !sha(headSha) || policy.headSha !== headSha || !Array.isArray(policy.required) || !policy.required.length || !Array.isArray(checks) || !Array.isArray(statuses)) return { status: 'unknown', reason: 'unverified-policy-or-head', required: [] };
  const required = policy.required.map((rule) => {
    const candidates = [
      ...checks.filter((check) => check.name === rule.context).map((check) => ({ ...check, kind: 'check', producer: check.app?.id ?? check.appId, head: check.head_sha ?? check.headSha, time: check.started_at ?? check.startedAt ?? check.created_at, result: check.conclusion, workflowHead: check.workflowHeadSha ?? check.workflow?.head_sha, isActions: check.app?.slug === 'github-actions' || check.isActions === true })),
      ...statuses.filter((status) => status.context === rule.context).map((status) => ({ ...status, kind: 'status', producer: status.app?.id ?? status.appId ?? null, head: status.sha ?? status.headSha, time: status.created_at ?? status.createdAt, result: status.state === 'success' ? 'SUCCESS' : status.state === 'failure' || status.state === 'error' ? 'FAILURE' : status.state }))
    ].filter((item) => item.head === headSha && (rule.appId === null || item.producer === rule.appId));
    const result = (status, reason, item) => ({ context: rule.context, appId: rule.appId, status, reason, evidence: item ? { kind: item.kind, id: item.id, sha: item.head, runId: item.runId ?? item.workflow?.id ?? null, attempt: item.runAttempt ?? item.workflow?.run_attempt ?? null, url: item.html_url ?? item.details_url ?? item.target_url ?? null } : null });
    if (!candidates.length) return result('unknown', 'required-check-missing');
    if (candidates.some((item) => !item.id || !Number.isFinite(Date.parse(item.time)))) return result('unknown', 'unorderable-check-evidence');
    const producers = new Set(candidates.map((item) => `${item.kind}:${item.producer ?? item.creator?.id ?? 'unknown'}`));
    if (producers.size !== 1) return result('unknown', 'ambiguous-check-producer');
    candidates.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const latest = candidates[0];
    if (candidates[1] && Date.parse(latest.time) === Date.parse(candidates[1].time) && latest.id !== candidates[1].id) return result('unknown', 'ambiguous-check-attempt');
    if (latest.isActions && latest.workflowHead !== headSha) return result('unknown', 'workflow-head-unverified', latest);
    if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'].includes(String(latest.status ?? latest.result).toUpperCase())) return result('pending', 'required-check-pending', latest);
    if (String(latest.result).toUpperCase() === 'SUCCESS' && (latest.kind === 'status' || String(latest.status).toUpperCase() === 'COMPLETED')) return result('green', 'required-check-success', latest);
    if (['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR'].includes(String(latest.result).toUpperCase())) return result('failed', 'required-check-failed', latest);
    return result('unknown', 'required-check-not-success', latest);
  });
  return { status: required.some((item) => item.status === 'failed') ? 'failed' : required.some((item) => item.status === 'unknown') ? 'unknown' : required.some((item) => item.status === 'pending') ? 'pending' : 'green', required, policyHash: policy.policyHash, headSha };
}

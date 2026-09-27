import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMivoPolicy, collectMivoPolicySync, evaluateMivoCi } from '../scripts/mivo-pr-policy.mjs';
const head = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture({ protectedBranch = false, drift = false, fail = false, advancedTip = false } = {}) {
  const calls = [];
  let views = 0;
  const tip = 'd'.repeat(40);
  const gh = (args) => {
    calls.push(args);
    if (fail) throw new Error('API unavailable');
    if (args[0] === 'pr') return { id: 'PR1', number: 1, headRefOid: drift && views++ ? 'c'.repeat(40) : head, baseRefOid: base, baseRefName: 'stack/topic' };
    if (args[1].includes('/rules/')) return [[{ type: 'required_status_checks', ruleset_id: 4, parameters: { required_status_checks: [{ context: 'verify', integration_id: 7 }] } }]];
    if (args[1].endsWith('/protection')) return { required_status_checks: { contexts: ['classic'], checks: [{ context: 'classic', app_id: 7 }] } };
    if (args[1].includes('/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: ['size'] })).toString('base64') };
    return { protected: protectedBranch, commit: { sha: advancedTip ? tip : base } };
  };
  return { gh, calls, tip };
}
const policy = { status: 'verified', headSha: head, baseSha: base, policyHash: 'hash', required: [{ context: 'verify', appId: 7 }] };
const check = (extra = {}) => ({ id: 1, name: 'verify', head_sha: head, app: { id: 7, slug: 'github-actions' }, workflowHeadSha: head, status: 'completed', conclusion: 'SUCCESS', started_at: '2026-09-09T00:00:00Z', ...extra });
test('collect actual stack base policy and explicit file union', async () => {
  const { gh, calls } = fixture({ protectedBranch: true });
  const result = await collectMivoPolicy({ repo: 'owner/repo', number: 1, gh });
  assert.equal(result.status, 'verified');
  assert.deepEqual([...new Set(result.required.map((item) => item.context))].sort(), ['classic', 'size', 'verify']);
  assert.ok(calls.some((args) => args[1]?.includes('branches/stack%2Ftopic')));
  assert.ok(calls.some((args) => args[1]?.endsWith(`?ref=${base}`)));
});
test('advanced main tip still verifies policy from current branch rules and PR-base file', async () => {
  const { gh, calls, tip } = fixture({ protectedBranch: true, advancedTip: true });
  const result = await collectMivoPolicy({ repo: 'owner/repo', number: 1, gh });
  assert.equal(result.status, 'verified');
  assert.equal(result.baseSha, base);
  assert.notEqual(result.baseSha, tip);
  assert.deepEqual([...new Set(result.required.map((item) => item.context))].sort(), ['classic', 'size', 'verify']);
  assert.ok(calls.some((args) => args[1]?.endsWith(`?ref=${base}`)));
  assert.equal(calls.some((args) => args[1]?.endsWith(`?ref=${tip}`)), false);
});
test('unknown API and identity drift fail closed', async () => {
  assert.equal((await collectMivoPolicy({ repo: 'owner/repo', number: 1, ...fixture({ fail: true }) })).status, 'unknown');
  assert.equal((await collectMivoPolicy({ repo: 'owner/repo', number: 1, ...fixture({ drift: true }) })).status, 'stale');
});
test('only current head, app, workflow and strict success can pass', () => {
  const evaluate = (checks) => evaluateMivoCi({ policy, headSha: head, checks }).status;
  assert.equal(evaluate([check()]), 'green');
  for (const extra of [{ head_sha: base }, { app: { id: 9 } }, { workflowHeadSha: base }, { conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }]) assert.equal(evaluate([check(extra)]), 'unknown');
  assert.equal(evaluate([]), 'unknown');
  assert.equal(evaluate([check({ conclusion: 'FAILURE' })]), 'failed');
  assert.equal(evaluate([check({ status: 'in_progress', conclusion: null })]), 'pending');
});
test('new attempt supersedes old green and ambiguous evidence cannot pass', () => {
  assert.equal(evaluateMivoCi({ policy, headSha: head, checks: [check(), check({ id: 2, started_at: '2026-09-09T01:00:00Z', conclusion: null, status: 'queued' })] }).status, 'pending');
  assert.equal(evaluateMivoCi({ policy, headSha: head, checks: [check(), check({ id: 2 })] }).status, 'unknown');
});
test('commit status compatible but unbound SHA cannot pass', () => {
  const p = { ...policy, required: [{ context: 'verify', appId: null }] };
  const status = { id: 1, context: 'verify', sha: head, state: 'success', created_at: '2026-09-09T00:00:00Z' };
  assert.equal(evaluateMivoCi({ policy: p, headSha: head, statuses: [status] }).status, 'green');
  assert.equal(evaluateMivoCi({ policy: p, headSha: head, statuses: [{ ...status, sha: undefined }] }).status, 'unknown');
});
test('ruleset-only protected branch requires classified missing classic response', async () => {
  const { gh } = fixture({ protectedBranch: true });
  const collect = (error) => collectMivoPolicy({ repo: 'owner/repo', number: 1, gh: (args) => {
    if (args[1]?.endsWith('/protection')) throw error;
    return gh(args);
  } });
  assert.equal((await collect(Object.assign(new Error('Branch not protected'), { status: 404, apiMessage: 'Branch not protected' }))).status, 'verified');
  assert.equal((await collect(Object.assign(new Error('Not Found'), { status: 404 }))).status, 'unknown');
});
test('effective rules must contain complete paginated data', async () => {
  const { gh } = fixture();
  assert.equal((await collectMivoPolicy({ repo: 'owner/repo', number: 1, gh: (args) => args[1]?.includes('/rules/') ? {} : gh(args) })).status, 'unknown');
});
test('unrestricted context with two app producers is ambiguous', () => {
  assert.equal(evaluateMivoCi({ policy: { ...policy, required: [{ context: 'verify', appId: null }] }, headSha: head, checks: [check(), check({ id: 2, app: { id: 8 }, started_at: '2026-09-09T01:00:00Z' })] }).status, 'unknown');
});

test('sync and async collectors share policy and classified error semantics', async () => {
  const sync = collectMivoPolicySync({ repo: 'owner/repo', number: 1, ...fixture() });
  const { gh } = fixture();
  const asyncResult = await collectMivoPolicy({ repo: 'owner/repo', number: 1, gh: async (args) => gh(args) });
  assert.deepEqual({ ...sync, checkedAt: null }, { ...asyncResult, checkedAt: null });
  const transport = fixture({ protectedBranch: true });
  const classified = (args) => {
    if (args[1]?.endsWith('/protection')) throw Object.assign(new Error('Branch not protected'), { status: 404, apiMessage: 'Branch not protected' });
    return transport.gh(args);
  };
  assert.equal(collectMivoPolicySync({ repo: 'owner/repo', number: 1, gh: classified }).status, 'verified');
  assert.equal((await collectMivoPolicy({ repo: 'owner/repo', number: 1, gh: async (args) => classified(args) })).status, 'verified');
  assert.equal(collectMivoPolicySync({ repo: 'owner/repo', number: 1, ...fixture({ fail: true }) }).status, 'unknown');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareMivoPr, releaseMivoPr, confirmMivoRelease, MIVO_REPO, validateMivoV2 } from '../scripts/release-mivo-pr.mjs';
import { readPrOpenReceipt } from '../scripts/run-ledger.mjs';
import { wrapupCleanup } from '../scripts/wrapup-cleanup.mjs';
const at = '2026-09-09T10:00:00Z', released = '2026-09-09T10:01:00Z';
function fixture(t, native = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-release-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (args, cwd = repo) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); fs.writeFileSync(path.join(repo, '.gitignore'), '.worktrees/\n'); fs.writeFileSync(path.join(repo, 'base'), 'a'); git(['add', '.']); git(['commit', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  const bare = path.join(root, 'remote.git'); git(['init', '--bare', bare]); git(['remote', 'add', 'origin', bare]);
  const branch = 'feature/test', wt = path.join(repo, '.worktrees/owner'); git(['worktree', 'add', '-b', branch, wt]);
  fs.writeFileSync(path.join(wt, 'feature'), 'A'); git(['add', '.'], wt); git(['commit', '-m', 'delivery A'], wt);
  const head = git(['rev-parse', 'HEAD'], wt); git(['push', 'origin', `HEAD:refs/heads/${branch}`], wt);
  const live = { id: 'PR_fixture', number: 563, headRefOid: head, baseRefOid: base, headRefName: branch, baseRefName: 'main',
    state: 'OPEN', isDraft: true, createdAt: '2026-09-08T00:00:00Z', author: { login: 'owner' }, isCrossRepository: false,
    headRepository: { name: 'mivo-canvas-plugin' }, headRepositoryOwner: { login: 'xindong' } };
  let mutations = 0, lost = false, deliver = true, ciState = 'success';
  const events = [];
  const controls = { '.github/workflows/code-review.yml': 'on:\n  workflow_dispatch:\n  pull_request_target:\n    types: [ready_for_review]\n',
    '.github/scripts/build_control_manifest.mjs': 'fixture', '.github/scripts/review_dispatch_context.py': 'fixture', '.github/scripts/review_public_evidence.py': 'fixture' };
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  if (native) {
    delete controls['.github/scripts/review_dispatch_context.py']; delete controls['.github/scripts/review_public_evidence.py'];
    controls['.github/scripts/review_native_export.mjs'] = 'native export'; controls['.github/scripts/review_native_history.mjs'] = 'native history';
    controls['.github/workflows/code-review.yml'] = 'on:\n  pull_request_target:\n    types: [ready_for_review]\njobs:\n  native_attestation:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/attest-build-provenance@pinned\n    env:\n      PIN: vars.REVIEW_PR_CONTROL_SHA\n      HISTORY: vars.NATIVE_EVIDENCE_TRUST_JSON\n';
  }
  const reviewTrust = { repo: MIVO_REPO, codeSha: base, workflowId: 100, workflowPath: '.github/workflows/code-review.yml', dispatchCompatible: true,
    workflowSha256: digest(controls['.github/workflows/code-review.yml']), sourceManifest: Object.fromEntries(Object.entries(controls).map(([k,v]) => [k,digest(v)])) };
  if (native) { reviewTrust.protocol = 'current-review-v1'; delete reviewTrust.dispatchCompatible; reviewTrust.native = { sourceSha: 'a'.repeat(40) }; }
  const variables = { REVIEW_PR_CONTROL_SHA: 'a'.repeat(40), NATIVE_EVIDENCE_TRUST_JSON: JSON.stringify({ sourceManifest: reviewTrust.sourceManifest }) };
  const gh = args => {
    const key = args[1];
    if (key === 'view') return { ...live };
    if (key === 'user') return { login: 'owner' };
    if (key === 'graphql') {
      const query = args.find(a => a.startsWith('query='));
      if (query.includes('repository(owner:')) { const repository = {}; for (const arg of args.filter(a => /^e\d+=/.test(a))) { const [key, value] = arg.split('='); const body = controls[value.slice(value.indexOf(':') + 1)]; repository[key.replace('e', 'f')] = { __typename: 'Blob', isBinary: false, byteSize: Buffer.byteLength(body), text: body }; } return { data: { repository } }; }
      if (query.includes('markPullRequestReadyForReview')) {
        mutations++;
        if (deliver) { live.isDraft = false; events.push({ __typename: 'ReadyForReviewEvent', id: 'READY_EVENT', createdAt: released }); }
        if (lost || !deliver) throw new Error('response unknown'); return {};
      }
      if (query.includes('timelineItems')) return { data: { node: { timelineItems: { nodes: [...events], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      return { data: { node: { id: 'READY_EVENT', createdAt: released, actor: { login: 'owner' } } } };
    }
    if (key.includes('/git/trees/')) return { truncated: false, tree: Object.keys(controls).map(path => ({ path, type: 'blob', mode: '100644' })) };
    if (key.includes('/contents/agent-use/docs/pr-rules.json')) return { type: 'file', encoding: 'base64', content: Buffer.from('{}').toString('base64') };
    if (key.includes('/rules/branches/')) return [[]];
    if (key.includes('/branches/')) return { protected: false, commit: { sha: live.baseRefOid } };
    if (key.includes('/contents/docs/sync/required-checks.json')) return { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['unit'], pr_only: [] })).toString('base64') };
    if (key.includes('/check-runs?')) return [{ check_runs: [{ id: 1, name: 'unit', head_sha: live.headRefOid, status: 'completed', conclusion: ciState, started_at: at, app: { id: 2, slug: 'fixture' } }] }];
    if (key.includes('/statuses?')) return [[]];
    if (key.includes('/actions/variables/')) { const name = key.split('/').at(-1); return { name, value: variables[name] }; }
    if (key.includes('/actions/workflows/')) return { id: 100, path: '.github/workflows/code-review.yml', state: 'active' };
    if (key.includes('/contents/.github/workflows/')) return { type: 'file', encoding: 'base64', content: Buffer.from(controls['.github/workflows/code-review.yml']).toString('base64') };
    throw new Error(`unexpected mock ${args}`);
  };
  const report = { schemaVersion: 1, kind: 'mivo-local-validation', repo: MIVO_REPO, number: 563, head,
    scs: [{ id: 'SC-1', status: 'pass', evidence: ['unit suite exit 0'] }], e2e: { status: 'pass', evidence: ['host fixture pass'] } };
  const validationReport = path.join(root, 'validation.json'), candidate = path.join(root, 'candidate.json'), release = path.join(root, 'release.json');
  fs.writeFileSync(validationReport, JSON.stringify(report));
  const prepare = () => prepareMivoPr({ repo: MIVO_REPO, pr: 563, head, validationReport, reviewTrust, out: candidate, now: at, gh });
  const releasePr = () => releaseMivoPr({ candidateReceipt: candidate, out: release, now: released, gh });
  return { variables, controls, root, repo, bare, wt, head, branch, git, live, gh, events, prepare, releasePr, candidate, release, report, validationReport, reviewTrust,
    mutations: () => mutations, lose: () => { lost = true; }, nondeliver: () => { deliver = false; }, red: () => { ciState = 'failure'; } };
}
test('Draft A release then Mini B permits v2 confirm and local-only cleanup despite B red CI', t => {
  const f = fixture(t); f.prepare(); f.releasePr();
  const mini = path.join(f.root, 'mini-clone'); f.git(['clone', '--branch', f.branch, f.bare, mini]);
  fs.writeFileSync(path.join(mini, 'mini'), 'B'); f.git(['add', '.'], mini); f.git(['commit', '-m', 'Mini B'], mini);
  const b = f.git(['rev-parse', 'HEAD'], mini); f.git(['push', 'origin', `HEAD:refs/heads/${f.branch}`], mini); f.live.headRefOid = b; f.red();
  assert.throws(() => f.git(['cat-file', '-e', b]));
  const receipt = confirmMivoRelease({ releaseReceipt: f.release, branch: f.branch, head: f.head, now: '2026-09-09T10:02:00Z', ledgerVersion: 1, assignmentSeq: 0, gh: f.gh, worktree: f.wt });
  assert.equal(receipt.deliveryHeadSha, f.head); assert.equal(receipt.observedHeadSha, b); assert.equal(receipt.ancestry, 'ancestor');
  const receiptPath = path.join(f.root, 'confirmed.json'); fs.writeFileSync(receiptPath, JSON.stringify(receipt)); assert.deepEqual(readPrOpenReceipt(receiptPath), receipt);
  const deliveryInput = { mode: 'delivery', receipt: receiptPath, release: f.release, branch: f.branch, head: f.head, assignmentSeq: 0 };
  const evidenceCli = new URL('../scripts/owner-continuation-evidence.mjs', import.meta.url).pathname;
  assert.equal(JSON.parse(execFileSync('node', [evidenceCli], { input: JSON.stringify(deliveryInput), encoding: 'utf8' })).verified, true);
  assert.throws(() => execFileSync('node', [evidenceCli], { input: JSON.stringify({ ...deliveryInput, head: b }), stdio: ['pipe', 'pipe', 'pipe'] }));
  const ledgerPath = path.join(f.root, 'ledger.json'); fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1,
    waves: [{ groups: [{ group_id: 'g1', state: 'pr-open', tip_sha: f.head, assignment_seq: 0, pr_url: receipt.url }] }], events: [
      { type: 'delivery', detail: { group_id: 'g1', assignment_seq: 0, branch: f.branch, tip_sha: f.head, scs: [{ id: 'SC-1', status: 'pass' }], e2e: { status: 'pass', candidate_sha: f.head }, size_gate: { result: 'PASS', candidate_sha: f.head } } },
      { type: 'pr_ready', detail: { group_id: 'g1', assignment_seq: 0, receipt: receiptPath } },
    ] }));
  const cleaned = wrapupCleanup({ worktree: f.wt, branch: f.branch, now: '2026-09-09T10:03:00Z', ledgerVersion: 1, assignmentSeq: 0,
    mode: 'delivered-local-only', ledgerPath, group: 'g1', repo: MIVO_REPO, ghRunner: (_binary, args) => ({ status: 0, stdout: JSON.stringify(f.gh(args)) }) });
  assert.equal(cleaned.ok, true); assert.equal(fs.existsSync(f.wt), false); assert.equal(cleaned.remoteDeleted, false);
  assert.equal(f.git(['ls-remote', 'origin', `refs/heads/${f.branch}`]).split(/\s/)[0], b);
});
test('unknown mutation reconciles actual Ready event exactly once, replay does not mutate', t => {
  const f = fixture(t); f.prepare(); f.lose(); f.releasePr(); f.releasePr(); assert.equal(f.mutations(), 1);
});
test('unobserved mutation remains blocked without automatic repeat', t => {
  const f = fixture(t); f.prepare(); f.nondeliver();
  assert.throws(f.releasePr, /unconfirmed/); assert.throws(f.releasePr, /unconfirmed/); assert.equal(f.mutations(), 1);
  assert.equal(fs.existsSync(f.release), false);
});
test('drift before Ready and incomplete validation cannot manufacture release', t => {
  const f = fixture(t); f.prepare(); f.live.baseRefOid = 'f'.repeat(40);
  assert.throws(f.releasePr, /drift/); assert.equal(f.mutations(), 0);
  const receipt = { schemaVersion: 2, kind: 'mivo-pr-open' }; assert.throws(() => validateMivoV2(receipt), /schema/);
});
test('failed validation blocks prepare while explicit scoped exception preserves original evidence', t => {
  const f = fixture(t);
  f.report.e2e.status = 'incomplete'; fs.writeFileSync(f.validationReport, JSON.stringify(f.report));
  assert.throws(f.prepare, /not passed/);
  f.report.e2e = { ...f.report.e2e, status: 'approved-exception', originalStatus: 'incomplete', approvalRef: 'user-approved-amendment', scope: 'host unavailable' };
  fs.writeFileSync(f.validationReport, JSON.stringify(f.report));
  const candidate = f.prepare(); assert.equal(candidate.validation.report.e2e.originalStatus, 'incomplete');
});
test('red required CI cannot prepare and candidate byte tampering cannot release', t => {
  const f = fixture(t); f.red(); assert.throws(f.prepare, /CI is not green/); assert.equal(f.mutations(), 0);
  const g = fixture(t); g.prepare(); const candidate = JSON.parse(fs.readFileSync(g.candidate)); candidate.validation.sourceBytes = Buffer.from('{}').toString('base64');
  fs.writeFileSync(g.candidate, JSON.stringify(candidate)); assert.throws(g.releasePr, /bytes changed/); assert.equal(g.mutations(), 0);
});
test('new ownership epoch invalidates prior release and divergent Mini head cannot confirm', t => {
  const f = fixture(t); f.prepare(); f.releasePr();
  const confirm = () => confirmMivoRelease({ releaseReceipt: f.release, branch: f.branch, head: f.head, now: '2026-09-09T10:02:00Z', ledgerVersion: 1, assignmentSeq: 0, gh: f.gh, git: f.git });
  f.live.headRefOid = f.live.baseRefOid; assert.throws(confirm);
  f.live.headRefOid = f.head; f.events.push({ __typename: 'ConvertToDraftEvent', id: 'DRAFT_AGAIN', createdAt: '2026-09-09T10:01:30Z' }); f.live.isDraft = true;
  assert.throws(confirm, /epoch drift/);
});

test('GitHub second precision accepts same-second Ready but rejects older events', t => {
  const f = fixture(t); f.prepare();
  const result = releaseMivoPr({ candidateReceipt: f.candidate, out: f.release, now: '2026-09-09T10:01:00.500Z', gh: f.gh });
  assert.equal(result.releasedAt, released);
  const g = fixture(t); g.prepare();
  assert.throws(() => releaseMivoPr({ candidateReceipt: g.candidate, out: g.release, now: '2026-09-09T10:01:01.001Z', gh: g.gh }), /predates/);
});
test('successful mutation A proof survives immediate independent Mini B and replay', t => {
  const f = fixture(t); f.prepare();
  const gh = args => {
    const result = f.gh(args);
    if (args.some(arg => arg.includes('markPullRequestReadyForReview'))) {
      const mini = path.join(f.root, 'fast-mini'); f.git(['clone', '--branch', f.branch, f.bare, mini]);
      fs.writeFileSync(path.join(mini, 'fast'), 'B'); f.git(['add', '.'], mini); f.git(['commit', '-m', 'fast Mini'], mini);
      f.live.headRefOid = f.git(['rev-parse', 'HEAD'], mini); f.git(['push', 'origin', `HEAD:refs/heads/${f.branch}`], mini);
      return { data: { markPullRequestReadyForReview: { pullRequest: { id: f.live.id, isDraft: false, headRefOid: f.head } } } };
    }
    return result;
  };
  const release = () => releaseMivoPr({ candidateReceipt: f.candidate, out: f.release, now: released, gh, git: f.git });
  assert.equal(release().mutationObservedHeadSha, f.head); release(); assert.equal(f.mutations(), 1);
});

test('missing trusted helper or trusted workflow mismatch blocks local release preparation', t => {
  const f = fixture(t); delete f.reviewTrust.sourceManifest['.github/scripts/review_public_evidence.py'];
  assert.throws(f.prepare, /trusted helper/); assert.equal(f.mutations(), 0);
  const g = fixture(t); g.reviewTrust.workflowSha256 = 'a'.repeat(64);
  assert.throws(g.prepare, /trusted manifest/); assert.equal(g.mutations(), 0);
});

test('lost Ready response and immediate Mini B remains unknown with one mutation', t => {
  const f = fixture(t); f.prepare();
  const gh = args => {
    const result = f.gh(args);
    if (args.some(arg => arg.includes('markPullRequestReadyForReview'))) {
      f.live.headRefOid = 'f'.repeat(40); throw new Error('response lost after Ready and Mini push');
    }
    return result;
  };
  const release = () => releaseMivoPr({ candidateReceipt: f.candidate, out: f.release, now: released, gh, worktree: f.wt });
  assert.throws(release); assert.throws(release); assert.equal(f.mutations(), 1);
  assert.equal(fs.existsSync(f.release), false); assert.equal(fs.existsSync(`${f.release}.mutation.json`), false);
});

test('current-review-v1 release accepts native PRtarget without legacy dispatch helpers', t => {
  const f = fixture(t, true); f.prepare(); f.releasePr(); assert.equal(f.mutations(), 1);
});
test('current-review-v1 rejects native source pin drift before release', t => {
  const f = fixture(t, true); f.variables.REVIEW_PR_CONTROL_SHA = 'b'.repeat(40);
  assert.throws(f.prepare, /source variable pin mismatch/); assert.equal(f.mutations(), 0);
});
test('current-review-v1 rejects history manifest drift before release', t => {
  const f = fixture(t, true); f.variables.NATIVE_EVIDENCE_TRUST_JSON = JSON.stringify({ sourceManifest: { '.github/workflows/code-review.yml': 'b'.repeat(64) } });
  assert.throws(f.prepare, /history source manifest mismatch/); assert.equal(f.mutations(), 0);
});
test('current-review-v1 rejects missing native helper and hosted attestation', t => {
  const f = fixture(t, true); delete f.reviewTrust.sourceManifest['.github/scripts/review_native_export.mjs'];
  assert.throws(f.prepare, /trusted helper missing/); assert.equal(f.mutations(), 0);
  const g = fixture(t, true);
  g.controls['.github/workflows/code-review.yml'] = g.controls['.github/workflows/code-review.yml'].replace('runs-on: ubuntu-latest', 'runs-on: self-hosted');
  g.reviewTrust.workflowSha256 = createHash('sha256').update(g.controls['.github/workflows/code-review.yml']).digest('hex');
  g.reviewTrust.sourceManifest['.github/workflows/code-review.yml'] = g.reviewTrust.workflowSha256;
  assert.throws(g.prepare, /native entry\/attestation/); assert.equal(g.mutations(), 0);
});

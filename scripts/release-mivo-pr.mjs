#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collectPrOwnershipSync } from './mivo-pr-snapshot.mjs';
import { verifyControlSourceSync, controlManifestDigest } from './mivo-control-source.mjs';
import { collectMivoCiSync } from './mivo-ci.mjs';

export const MIVO_REPO = 'xindong/mivo-canvas-plugin';
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, why) => { if (!ok) throw new Error(`Mivo delivery: ${why}`); };
const parse = raw => typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(String(raw)) : raw;
const exact = (value, keys) => check(value && Object.keys(value).sort().join() === [...keys].sort().join(), 'receipt exact schema mismatch');
const timestamp = value => check(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'invalid timestamp');
function epochTime(epoch, nodeId) {
  const prefix = `ready:${nodeId}:`;
  check(typeof epoch === 'string' && epoch.startsWith(prefix), 'invalid release epoch');
  const tail = epoch.slice(prefix.length), split = tail.indexOf(':');
  check(split > 0, 'release epoch event missing');
  const time = tail.slice(split + 1); timestamp(time); return time;
}
export function deliveryGh(args, runner = spawnSync) {
  const value = runner(process.env.GH_BIN ?? 'gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (value.status !== 0) throw new Error(`GitHub query failed: ${String(value.stderr ?? '').slice(0, 300)}`);
  return parse(value.stdout);
}
function deliveryGit(worktree, args) {
  check(typeof worktree === 'string' && path.isAbsolute(worktree), '--worktree absolute business Git path required for ancestry');
  const r = spawnSync('git', args, { cwd: worktree, encoding: 'utf8' });
  check(r.status === 0, 'delivery ancestry/fetch unavailable'); return r.stdout;
}
function immutable(file, value) {
  check(path.isAbsolute(file), 'output path must be absolute');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file)) { check(fs.readFileSync(file, 'utf8') === bytes, 'refusing to overwrite receipt'); return; }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try { fs.linkSync(temporary, file); } finally { fs.unlinkSync(temporary); }
}
function snapshot(repo, number, gh) {
  check(repo === MIVO_REPO && Number.isSafeInteger(Number(number)) && Number(number) > 0, 'only bound Mivo PR supported');
  const pr = collectPrOwnershipSync({ pr: { repo, number: Number(number) }, ghFn: gh });
  check(pr.state === 'OPEN' && pr.sameRepository === true, 'PR must be open in the same repository');
  return pr;
}
function sameCandidate(pr, candidate) {
  check(pr.id === candidate.prNodeId && pr.number === candidate.number && pr.headRefName === candidate.branch
    && pr.headRefOid === candidate.deliveryHeadSha && pr.baseRefOid === candidate.baseSha, 'candidate head/base/identity drift');
}
function prerequisites(pr, gh, trust) {
  const native = trust?.protocol === 'current-review-v1';
  check(trust?.repo === pr.repo && sha(trust.codeSha) && trust.workflowPath === '.github/workflows/code-review.yml'
    && (native || trust.protocol == null && trust.dispatchCompatible === true), 'review trust configuration required');
  if (native) check(sha(trust.native?.sourceSha), 'native Review-PR source pin required');
  const helpers = native ? ['build_control_manifest.mjs', 'review_native_export.mjs', 'review_native_history.mjs']
    : ['build_control_manifest.mjs', 'review_dispatch_context.py', 'review_public_evidence.py'];
  for (const name of helpers) check(trust.sourceManifest?.[`.github/scripts/${name}`], 'trusted helper missing');
  const control = verifyControlSourceSync({ repo: pr.repo, sha: pr.baseRefOid, gh, manifest: trust.sourceManifest });
  const rules = parse(gh(['api', `repos/${pr.repo}/contents/agent-use/docs/pr-rules.json?ref=${pr.baseRefOid}`]));
  check(rules.type === 'file' && rules.encoding === 'base64', 'BASE review rules unavailable');
  const ruleBytes = Buffer.from(rules.content, 'base64');
  check(parse(ruleBytes) && typeof parse(ruleBytes) === 'object', 'BASE review rules invalid');
  const wf = parse(gh(['api', `repos/${pr.repo}/actions/workflows/code-review.yml`]));
  check(wf.id === trust.workflowId && Number.isSafeInteger(wf.id) && wf.path === '.github/workflows/code-review.yml' && wf.state === 'active', 'review workflow unavailable');
  const source = parse(gh(['api', `repos/${pr.repo}/contents/.github/workflows/code-review.yml?ref=${pr.baseRefOid}`]));
  check(source.type === 'file' && source.encoding === 'base64' && typeof source.content === 'string', 'review workflow source unavailable');
  const bytes = Buffer.from(source.content, 'base64');
  const text = bytes.toString();
  check(bytes.length > 0 && bytes.length < 1024 * 1024 && /ready_for_review/.test(text)
    && (native ? /pull_request_target\s*:/.test(text) : /workflow_dispatch\s*:/.test(text)), 'base lacks compatible review entry points');
  if (native) {
    const attestation = text.match(/^  native_attestation:\n([\s\S]*?)(?=^  [A-Za-z_][\w-]*:|$(?![\s\S]))/m)?.[1];
    check(attestation && /^    runs-on: ubuntu-latest\s*$/m.test(attestation)
      && /actions\/attest-build-provenance@/.test(attestation)
      && /vars\.REVIEW_PR_CONTROL_SHA/.test(text) && /vars\.NATIVE_EVIDENCE_TRUST_JSON/.test(text), 'native entry/attestation configuration missing');
    const pin = parse(gh(['api', `repos/${pr.repo}/actions/variables/REVIEW_PR_CONTROL_SHA`]));
    check(pin.name === 'REVIEW_PR_CONTROL_SHA' && pin.value === trust.native.sourceSha, 'native source variable pin mismatch');
    const history = parse(gh(['api', `repos/${pr.repo}/actions/variables/NATIVE_EVIDENCE_TRUST_JSON`]));
    check(history.name === 'NATIVE_EVIDENCE_TRUST_JSON' && typeof history.value === 'string', 'native history trust variable missing');
    check(controlManifestDigest(parse(history.value).sourceManifest) === controlManifestDigest(trust.sourceManifest), 'native history source manifest mismatch');
  }
  check(hash(bytes) === trust.workflowSha256 && trust.sourceManifest[wf.path] === trust.workflowSha256, 'workflow does not match trusted manifest');
  return { workflowId: wf.id, workflowPath: wf.path, baseSha: pr.baseRefOid, workflowSha256: hash(bytes), control, rulesSha256: hash(ruleBytes), trust };
}
function deliveryCi(pr, gh) {
  const ci = collectMivoCiSync({ pr, ghFn: gh });
  check(ci.status === 'green', 'required CI is not green');
  const failed = item => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(String(item.conclusion ?? item.state).toLowerCase());
  for (const item of ci.checks.filter(failed)) {
    const runId = String(item.details_url ?? '').match(/github\.com\/xindong\/mivo-canvas-plugin\/actions\/runs\/(\d+)\/job\/\d+/)?.[1];
    check(runId, 'non-required product check failed');
    const run = parse(gh(['api', `repos/${pr.repo}/actions/runs/${runId}`]));
    check(run.id === Number(runId) && run.repository?.full_name === pr.repo
      && run.path === '.github/workflows/code-review.yml', 'non-required product CI failed');
  }
  check(!ci.statuses.some(failed), 'commit status failure blocks local delivery');
  return ci;
}
function validateReport(report, pr) {
  check(report?.schemaVersion === 1 && report.kind === 'mivo-local-validation' && report.repo === pr.repo
    && report.number === pr.number && report.head === pr.headRefOid, 'validation report identity mismatch');
  check(Array.isArray(report.scs) && report.scs.length > 0 && new Set(report.scs.map(sc => sc.id)).size === report.scs.length, 'SC coverage missing or duplicate');
  check(report.scs.every(sc => typeof sc.id === 'string' && sc.id.trim()), 'SC identity missing');
  for (const item of [...report.scs, report.e2e]) {
    check(item && Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.every(e => typeof e === 'string' && e.trim()), 'validation evidence missing');
    check(item.status === 'pass' || item.status === 'approved-exception' && typeof item.approvalRef === 'string'
      && item.approvalRef.trim() && typeof item.scope === 'string' && item.scope.trim()
      && ['fail', 'not_run', 'incomplete'].includes(item.originalStatus), 'SC/E2E not passed or explicitly excepted');
  }
}
export function prepareMivoPr({ repo = MIVO_REPO, pr: number, head, validationReport, reviewTrust, out, gh = deliveryGh,
  now = new Date().toISOString() } = {}) {
  timestamp(now); check(sha(head), 'validated head required');
  const pr = snapshot(repo, number, gh);
  check(pr.isDraft === true && pr.headRefOid === head, 'prepare requires Draft at validated head');
  const bytes = fs.readFileSync(validationReport);
  const report = parse(bytes); validateReport(report, pr);
  const ci = deliveryCi(pr, gh);
  const review = prerequisites(pr, gh, typeof reviewTrust === 'string' ? parse(fs.readFileSync(reviewTrust)) : reviewTrust);
  const after = snapshot(repo, number, gh);
  check(after.isDraft === true && after.releaseEpoch === pr.releaseEpoch, 'ownership changed during prepare');
  const candidate = { schemaVersion: 1, kind: 'mivo-local-candidate', repo, prNodeId: pr.id, number: pr.number,
    branch: pr.headRefName, deliveryHeadSha: head, baseSha: pr.baseRefOid,
    validation: { sha256: hash(bytes), sourceBytes: bytes.toString('base64'), report }, policy: ci.policy, ci, review, checkedAt: now };
  sameCandidate(after, candidate); immutable(out, candidate); return candidate;
}
export function readCandidate(file) {
  const value = parse(fs.readFileSync(file));
  exact(value, ['schemaVersion', 'kind', 'repo', 'prNodeId', 'number', 'branch', 'deliveryHeadSha', 'baseSha', 'validation', 'policy', 'ci', 'review', 'checkedAt']);
  check(value.schemaVersion === 1 && value.kind === 'mivo-local-candidate' && value.repo === MIVO_REPO && sha(value.deliveryHeadSha)
    && sha(value.baseSha) && value.ci?.status === 'green' && value.policy?.status === 'verified'
    && value.ci.policy?.policyHash === value.policy.policyHash && value.policy.headSha === value.deliveryHeadSha
    && value.policy.baseSha === value.baseSha && value.policy.prNodeId === value.prNodeId, 'candidate proof invalid');
  timestamp(value.checkedAt);
  check(typeof value.validation.sourceBytes === 'string' && hash(Buffer.from(value.validation.sourceBytes, 'base64')) === value.validation.sha256
    && JSON.stringify(parse(Buffer.from(value.validation.sourceBytes, 'base64'))) === JSON.stringify(value.validation.report), 'validation report bytes changed');
  validateReport(value.validation.report, { repo: value.repo, number: value.number, headRefOid: value.deliveryHeadSha });
  return value;
}
export function releaseMivoPr({ candidateReceipt, out, gh = deliveryGh, worktree, git = args => deliveryGit(worktree, args), now = new Date().toISOString() } = {}) {
  timestamp(now);
  const candidate = readCandidate(candidateReceipt), candidateReceiptSha256 = hash(fs.readFileSync(candidateReceipt));
  check(Date.parse(now) >= Date.parse(candidate.checkedAt), 'release precedes candidate');
  const journalPath = `${out}.operation.json`;
  const lock = `${out}.lock`; fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    let journal = fs.existsSync(journalPath) ? parse(fs.readFileSync(journalPath)) : null;
    const pr = snapshot(candidate.repo, candidate.number, gh);
    const mutationProofPath = `${out}.mutation.json`;
    if (fs.existsSync(out)) { const receipt = readRelease(out); check(receipt.candidateReceiptSha256 === candidateReceiptSha256
      && receipt.releaseEpoch === pr.releaseEpoch && pr.id === candidate.prNodeId && pr.headRefName === candidate.branch && !pr.isDraft, 'released receipt is no longer current'); return receipt; }
    if (!journal) {
      sameCandidate(pr, candidate);
      check(pr.isDraft === true, 'release requires a Draft candidate');
      deliveryCi(pr, gh);
      prerequisites(pr, gh, candidate.review.trust);
      const final = snapshot(candidate.repo, candidate.number, gh); sameCandidate(final, candidate);
      check(final.isDraft === true && final.releaseEpoch === pr.releaseEpoch, 'ownership changed before release');
      const actor = parse(gh(['api', 'user'])); check(typeof actor.login === 'string' && actor.login, 'release actor unknown');
      journal = { kind: 'mivo-release-operation', candidateReceiptSha256, previousEpoch: pr.releaseEpoch, attemptedAt: now, actor: actor.login };
      immutable(journalPath, journal);
      // Persist before the non-CAS mutation. Unknown responses are reconciled, never blindly repeated.
      let mutation;
      try { mutation = parse(gh(['api', 'graphql', '-f', `query=mutation{markPullRequestReadyForReview(input:{pullRequestId:${JSON.stringify(pr.id)}}){pullRequest{id isDraft headRefOid}}}`])); } catch {}
      const observed = mutation?.data?.markPullRequestReadyForReview?.pullRequest;
      if (!mutation?.errors && observed?.id === candidate.prNodeId && observed.isDraft === false && observed.headRefOid === candidate.deliveryHeadSha)
        immutable(mutationProofPath, { candidateReceiptSha256, prNodeId: observed.id, head: observed.headRefOid, isDraft: false });
    }
    exact(journal, ['kind', 'candidateReceiptSha256', 'previousEpoch', 'attemptedAt', 'actor']);
    timestamp(journal.attemptedAt);
    check(journal.kind === 'mivo-release-operation' && typeof journal.actor === 'string' && journal.actor && journal.candidateReceiptSha256 === candidateReceiptSha256, 'operation belongs to another candidate');
    const after = snapshot(candidate.repo, candidate.number, gh);
    if (after.headRefOid === candidate.deliveryHeadSha) sameCandidate(after, candidate);
    else {
      const proof = fs.existsSync(mutationProofPath) ? parse(fs.readFileSync(mutationProofPath)) : null;
      exact(proof, ['candidateReceiptSha256', 'prNodeId', 'head', 'isDraft']);
      check(proof.candidateReceiptSha256 === candidateReceiptSha256 && proof.prNodeId === candidate.prNodeId && proof.head === candidate.deliveryHeadSha && proof.isDraft === false
        && after.id === candidate.prNodeId && after.headRefName === candidate.branch && after.baseRefOid === candidate.baseSha, 'post-release head drift lacks mutation evidence');
      git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', after.headRefOid]);
      git(['merge-base', '--is-ancestor', candidate.deliveryHeadSha, after.headRefOid]);
    }
    check(!after.isDraft && after.releaseEpoch.startsWith(`ready:${after.id}:`) && after.releaseEpoch !== journal.previousEpoch, 'Ready response unconfirmed; preserve journal without retry');
    // Current epoch embeds GitHub event time; a stale ready event cannot establish this operation.
    const eventTime = after.releaseEpoch.match(/\d{4}-\d\d-\d\dT.*$/)?.[0];
    check(Number.isFinite(Date.parse(eventTime)) && Date.parse(eventTime) >= Math.floor(Date.parse(journal.attemptedAt) / 1000) * 1000, 'Ready event predates operation');
    const eventId = after.releaseEpoch.slice(`ready:${after.id}:`.length).split(':')[0];
    const event = parse(gh(['api', 'graphql', '-f', `query=query{node(id:${JSON.stringify(eventId)}){... on ReadyForReviewEvent{id createdAt actor{login}}}}`]));
    check(!event.errors && event.data?.node?.id === eventId && event.data.node.createdAt === eventTime
      && event.data.node.actor?.login === journal.actor, 'Ready event actor cannot confirm this operation');
    const stable = snapshot(candidate.repo, candidate.number, gh);
    check(stable.headRefOid === after.headRefOid && stable.baseRefOid === after.baseRefOid && stable.releaseEpoch === after.releaseEpoch && !stable.isDraft, 'PR changed while confirming mutation evidence');
    const receipt = { schemaVersion: 1, kind: 'mivo-local-release', repo: candidate.repo, prNodeId: candidate.prNodeId,
      number: candidate.number, branch: candidate.branch, deliveryHeadSha: candidate.deliveryHeadSha, baseSha: candidate.baseSha,
      candidateReceiptPath: path.resolve(candidateReceipt), candidateReceiptSha256, releaseEpoch: after.releaseEpoch,
      releasedAt: eventTime, mutationObservedHeadSha: candidate.deliveryHeadSha };
    immutable(out, receipt); return receipt;
  } finally { fs.unlinkSync(lock); }
}
export function readRelease(file) {
  const value = parse(fs.readFileSync(file));
  exact(value, ['schemaVersion', 'kind', 'repo', 'prNodeId', 'number', 'branch', 'deliveryHeadSha', 'baseSha', 'candidateReceiptPath', 'candidateReceiptSha256', 'releaseEpoch', 'releasedAt', 'mutationObservedHeadSha']);
  check(value.schemaVersion === 1 && value.kind === 'mivo-local-release' && value.repo === MIVO_REPO
    && value.mutationObservedHeadSha === value.deliveryHeadSha && value.releaseEpoch?.startsWith(`ready:${value.prNodeId}:`), 'release proof invalid');
  timestamp(value.releasedAt);
  check(epochTime(value.releaseEpoch, value.prNodeId) === value.releasedAt, 'release time/epoch mismatch');
  const candidate = readCandidate(value.candidateReceiptPath);
  check(hash(fs.readFileSync(value.candidateReceiptPath)) === value.candidateReceiptSha256
    && ['repo', 'prNodeId', 'number', 'branch', 'deliveryHeadSha', 'baseSha'].every(k => value[k] === candidate[k]), 'candidate/release binding mismatch');
  return value;
}
export const MIVO_V2_KEYS = ['schemaVersion', 'kind', 'repo', 'url', 'number', 'branch', 'prNodeId', 'deliveryHeadSha', 'observedHeadSha', 'releaseEpoch',
  'candidateReceiptSha256', 'releaseReceiptSha256', 'ancestry', 'isDraft', 'state', 'checked_at', 'ledger_version', 'assignment_seq'];
export function validateMivoV2(value) {
  exact(value, MIVO_V2_KEYS);
  check(value.schemaVersion === 2 && value.kind === 'mivo-pr-open' && value.repo === MIVO_REPO && value.url === `https://github.com/${MIVO_REPO}/pull/${value.number}`
    && Number.isSafeInteger(value.number) && value.number > 0 && typeof value.branch === 'string' && value.branch
    && typeof value.prNodeId === 'string' && value.prNodeId && sha(value.deliveryHeadSha) && sha(value.observedHeadSha)
    && typeof value.releaseEpoch === 'string' && value.releaseEpoch.startsWith(`ready:${value.prNodeId}:`) && value.state === 'OPEN' && value.isDraft === false
    && /^[a-f0-9]{64}$/.test(value.candidateReceiptSha256) && /^[a-f0-9]{64}$/.test(value.releaseReceiptSha256)
    && value.ancestry === (value.deliveryHeadSha === value.observedHeadSha ? 'equal' : 'ancestor'), 'v2 identity/hash/ancestry invalid');
  timestamp(value.checked_at);
  check(Date.parse(value.checked_at) >= Date.parse(epochTime(value.releaseEpoch, value.prNodeId)), 'confirmation precedes release');
  check(Number.isSafeInteger(value.ledger_version) && value.ledger_version >= 0 && Number.isSafeInteger(value.assignment_seq) && value.assignment_seq >= 0, 'v2 ledger stamps invalid');
  return value;
}
export function verifyDeliveryEpoch(receipt, gh = deliveryGh) {
  validateMivoV2(receipt);
  const current = snapshot(receipt.repo, receipt.number, gh);
  check(current.id === receipt.prNodeId && current.headRefName === receipt.branch && !current.isDraft
    && current.releaseEpoch === receipt.releaseEpoch, 'delivery epoch/PR changed');
  return current;
}
export function confirmMivoRelease({ releaseReceipt, branch, head, now, ledgerVersion, assignmentSeq, gh = deliveryGh, worktree,
  git = args => deliveryGit(worktree, args) }) {
  const release = readRelease(releaseReceipt), pr = snapshot(release.repo, release.number, gh);
  check(pr.id === release.prNodeId && pr.headRefName === branch && branch === release.branch && head === release.deliveryHeadSha
    && !pr.isDraft && pr.releaseEpoch === release.releaseEpoch, 'released PR identity/epoch drift');
  if (head !== pr.headRefOid) {
    git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', pr.headRefOid]);
    git(['merge-base', '--is-ancestor', head, pr.headRefOid]);
  }
  const after = snapshot(release.repo, release.number, gh);
  check(after.headRefOid === pr.headRefOid && after.releaseEpoch === pr.releaseEpoch && !after.isDraft, 'PR changed during ancestry check');
  const value = { schemaVersion: 2, kind: 'mivo-pr-open', repo: release.repo, url: `https://github.com/${release.repo}/pull/${release.number}`,
    number: release.number, branch, prNodeId: pr.id, deliveryHeadSha: head, observedHeadSha: pr.headRefOid, releaseEpoch: pr.releaseEpoch,
    candidateReceiptSha256: release.candidateReceiptSha256, releaseReceiptSha256: hash(fs.readFileSync(releaseReceipt)), ancestry: head === pr.headRefOid ? 'equal' : 'ancestor',
    isDraft: false, state: 'OPEN', checked_at: now, ledger_version: Number(ledgerVersion), assignment_seq: Number(assignmentSeq) };
  return validateMivoV2(value);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2), flags = {};
  for (let i = 0; i < args.length; i += 2) flags[args[i].replace(/^--/, '')] = args[i + 1];
  try {
    const result = mode === 'prepare' ? prepareMivoPr({ repo: flags.repo, pr: Number(flags.pr), head: flags.head, validationReport: flags['validation-report'], reviewTrust: flags['review-trust'], out: flags.out })
      : mode === 'release' ? releaseMivoPr({ candidateReceipt: flags['candidate-receipt'], worktree: flags.worktree, out: flags.out }) : (() => { throw new Error('use prepare or release'); })();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

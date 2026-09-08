#!/usr/bin/env node
// Preserve an approved acceptance exception without rewriting failed SC history.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hashObject, isMain, parseArgs, sha256, writeJsonAtomic } from './lib/common.mjs';

const SHA = /^[0-9a-f]{40}$/;
const FILES = ['ledger', 'claim', 'create_result', 'amendment', 'delivery', 'acceptance'];
const fail = (message) => { throw new Error(message); };
const need = (value, message) => { if (!value) fail(message); };
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inside = (parent, child) => { const rel = relative(parent, child); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); };

function unwrap(raw) {
  if (typeof raw === 'string') return unwrap(JSON.parse(raw));
  need(raw && raw.isError !== true && raw.ok !== false, 'Host result failed');
  if (raw.structuredContent) return unwrap(raw.structuredContent);
  if (raw.content) {
    const texts = raw.content.filter((part) => part.type === 'text');
    need(texts.length === 1, 'Host result must contain one JSON receipt');
    return unwrap(texts[0].text);
  }
  return raw;
}

export function verifySupplementalEvidence(input) {
  need(input.schema === 'approve-exec-supplemental-cleanup-v1', 'Unsupported supplemental cleanup schema');
  need(input.repo === 'xindong/mivo-canvas-plugin' && input.pr_number === 563 && input.group_id === 'PR01', 'This supplemental exception is scoped to Mivo PR563 / PR01');
  const source = {};
  for (const key of FILES) {
    const ref = input.sources?.[key];
    need(ref && isAbsolute(ref.path) && /^[0-9a-f]{64}$/.test(ref.sha256), `Missing pinned source: ${key}`);
    const bytes = readFileSync(ref.path);
    need(sha256(bytes) === ref.sha256, `Source hash changed: ${key}`);
    source[key] = key === 'amendment' ? bytes.toString('utf8') : JSON.parse(bytes);
  }
  const { ledger, claim, delivery, acceptance } = source;
  const group = ledger.waves?.flatMap((wave) => wave.groups).find((item) => item.group_id === input.group_id);
  need(group && claim.status === 'bound' && group.session_id === claim.session_id, 'Owner claim is not bound to group');
  need(claim.ledger === input.sources.ledger.path && claim.run_id === ledger.run_id && claim.group_id === group.group_id
    && claim.assignment_seq === group.assignment_seq && claim.manifest_core_hash === ledger.manifest_core_hash
    && claim.execution_plan_hash === ledger.pr_plan?.plan_hash, 'Claim generation or manifest mismatch');
  for (const key of ['worktree', 'branch', 'base', 'title']) need(claim.identity?.[key] === group[key], `Claim identity mismatch: ${key}`);
  need(hashObject(source.create_result) === claim.result_hash, 'Original create receipt does not match claim');
  const created = unwrap(source.create_result);
  need(created.ok === true && created.target_session_id === group.session_id, 'Original create receipt owner mismatch');
  need(group.state === 'review' && group.pr_url === null, 'Supplemental entry only handles retained exception history');
  need(delivery.owner_session === group.session_id && acceptance.owner_session === group.session_id, 'Acceptance owner mismatch');
  need(delivery.amendment?.path === input.sources.amendment.path && delivery.amendment.sha256 === input.sources.amendment.sha256
    && acceptance.amendment_path === input.sources.amendment.path && acceptance.amendment_sha256 === input.sources.amendment.sha256
    && acceptance.owner_delivery_path === input.sources.delivery.path, 'Acceptance amendment binding mismatch');
  need(delivery.amended_acceptance?.status === 'pass_under_user_exception'
    && acceptance.kind === 'lead_acceptance_under_user_approved_pr01_exception'
    && acceptance.conclusion?.amended_acceptance === 'accepted', 'User exception was not accepted by lead');
  const accepted = delivery.original?.candidate_sha;
  need(SHA.test(accepted) && accepted === group.tip_sha && accepted === acceptance.candidate_sha, 'Accepted candidate mismatch');
  need(delivery.original?.accept_p0_a_pr01 === 'fail' && delivery.original?.host_evidence === 'incomplete'
    && acceptance.conclusion?.original_accept_p0_a_pr01 === 'fail' && acceptance.conclusion?.original_host_evidence === 'incomplete', 'Original failed host evidence must remain explicit');
  need(delivery.required_checks?.all_required_pass === true && delivery.required_checks.items?.length > 0
    && delivery.required_checks.items.every((item) => item.bucket === 'pass' && item.state === 'SUCCESS')
    && acceptance.conclusion?.all_required_checks_pass === true, 'Historical delivered candidate lacks required CI evidence');
  need(delivery.pr?.number === input.pr_number && delivery.pr.url === `https://github.com/${input.repo}/pull/${input.pr_number}`
    && delivery.pr.state === 'OPEN' && delivery.pr.draft === false && delivery.pr.head === accepted
    && delivery.original.branch === group.branch, 'Historical PR identity mismatch');
  need(ledger.events.some((event) => event.type === 'replan_note' && event.detail?.group_id === group.group_id), 'Original exception event missing');
  need(Array.isArray(input.writer_session_ids) && input.writer_session_ids.includes(group.session_id)
    && new Set(input.writer_session_ids).size === input.writer_session_ids.length, 'Known writer identities must include owner exactly once');
  need(SHA.test(input.expected_local_sha), 'Explicit expected local HEAD required');
  return { group, accepted, ledger_version: ledger.version };
}

export function verifyInactiveWriters(input, now = Date.now()) {
  const bundle = json(input.runtime_bundle);
  const age = now - Date.parse(bundle.checked_at);
  need(Number.isFinite(age) && age >= 0 && age <= 60_000, 'Runtime receipts must be refreshed within 60 seconds');
  const runtimes = bundle.results?.map(unwrap);
  need(Array.isArray(runtimes) && runtimes.length === input.writer_session_ids.length, 'Every known writer requires a runtime receipt');
  for (const id of input.writer_session_ids) {
    const hits = runtimes.filter((item) => item.session_id === id);
    need(hits.length === 1 && hits[0].ok === true && hits[0].active === false
      && hits[0].phase === 'completed' && !hits[0].pending, `Writer is active, pending or unknown: ${id}`);
  }
  return runtimes.map(({ session_id, phase, active, record_status, last_activity_at }) => ({ session_id, phase, active, record_status, last_activity_at }));
}

function command(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  need(result.status === 0, `${bin} ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  return result.stdout.trim();
}

function parseTrees(text) {
  return text.trim().split('\n\n').map((block) => Object.fromEntries(block.split('\n').map((line) => {
    const index = line.indexOf(' '); return index < 0 ? [line, true] : [line.slice(0, index), line.slice(index + 1)];
  })));
}

export function supplementalPreflight(input, { run = command, now = Date.now() } = {}) {
  const evidence = verifySupplementalEvidence(input);
  const { group, accepted } = evidence;
  const writers = verifyInactiveWriters(input, now);
  const wt = realpathSync(group.worktree);
  const git = (args, cwd = wt) => run('git', args, cwd);
  need(group.branch !== 'main' && group.branch !== 'master', 'Default branch cannot be cleaned');
  need(git(['rev-parse', '--abbrev-ref', 'HEAD']) === group.branch, 'Worktree branch changed');
  const local = git(['rev-parse', 'HEAD']);
  need(local === input.expected_local_sha, 'Local HEAD changed since explicit cleanup scope');
  need(git(['status', '--porcelain', '--untracked-files=all']) === '', 'Worktree is dirty or has untracked files');
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = realpathSync(dirname(common));
  need(inside(main, wt), 'Worktree must be inside the identified main repository');
  const tree = parseTrees(git(['worktree', 'list', '--porcelain'], main)).find((item) => item.worktree === wt);
  need(tree && tree.branch === `refs/heads/${group.branch}` && tree.HEAD === local, 'Independent worktree registration mismatch');
  need(!tree.locked && !['.keep', '.worktree-keep', '.cleanup.lock'].some((path) => existsSync(join(wt, path))), 'Worktree has keep/lock protection');
  const remoteText = git(['ls-remote', 'origin', `refs/heads/${group.branch}`]);
  const [remote, ref, extra] = remoteText.split(/\s+/);
  need(SHA.test(remote) && ref === `refs/heads/${group.branch}` && extra === undefined, 'Exact remote branch missing or ambiguous');
  git(['merge-base', '--is-ancestor', accepted, local]);
  git(['merge-base', '--is-ancestor', local, remote]);
  const pr = JSON.parse(run('gh', ['pr', 'view', String(input.pr_number), '--repo', input.repo, '--json', 'number,url,state,isDraft,headRefOid,headRefName,headRepository'], main));
  need(pr.state === 'OPEN' && pr.isDraft === false && pr.number === input.pr_number
    && pr.headRefOid === remote && pr.headRefName === group.branch && pr.headRepository?.nameWithOwner === input.repo, 'Live PR identity or head mismatch');
  // Ignored artifacts are retained byte-for-byte by same-filesystem directory rename.
  const selectedArtifacts = input.retained_artifacts ?? ['node_modules', 'cindyplugin/dist'];
  need(Array.isArray(selectedArtifacts) && new Set(selectedArtifacts).size === selectedArtifacts.length
    && selectedArtifacts.every((path) => ['node_modules', 'cindyplugin/dist', '_tmp'].includes(path)), 'Retention paths must be explicitly reviewed PR563 directories');
  const allowedArtifacts = selectedArtifacts.map((path) => `${path}/`);
  const unknownIgnored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.', ...selectedArtifacts.map((path) => `:(exclude)${path}`)]);
  const ignoredDirectories = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean);
  need(unknownIgnored === '' && ignoredDirectories.every((path) => allowedArtifacts.some((root) => root.startsWith(path))), 'Unknown ignored content must be retained and reviewed separately');
  const ignored = allowedArtifacts.filter((path) => existsSync(join(wt, path)));
  const retention = resolve(input.retained_dir);
  need(isAbsolute(input.retained_dir) && inside(main, retention) && !inside(wt, retention)
    && retention !== wt && inside(realpathSync(dirname(retention)), retention) && !existsSync(retention), 'Retention directory must be a new sibling path inside this repository');
  need(git(['check-ignore', retention], main) === retention, 'Retention path must already be ignored by this repository');
  const artifacts = ignored.map((path) => {
    const from = join(wt, path);
    const stat = lstatSync(from);
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'Ignored artifact must be an ordinary directory');
    return { from, to: join(retention, path), type: 'directory', action: 'retain', device: stat.dev, inode: stat.ino };
  });
  return { schema: 'approve-exec-supplemental-cleanup-preview-v1', ready: true, official_ledger_migrated: false,
    ledger_version: evidence.ledger_version, assignment_seq: group.assignment_seq, owner_session_id: group.session_id,
    group_id: group.group_id, repo: input.repo, pr_number: input.pr_number, worktree: wt, main_repo: main,
    branch: group.branch, accepted_sha: accepted, local_sha: local, remote_sha: remote,
    checked_at: new Date(now).toISOString(), writers, artifacts, retained_dir: retention, sources: input.sources };
}

export function supplementalCleanup(input, { execute = false, receiptPath, run = command, now } = {}) {
  const preview = supplementalPreflight(input, { run, now });
  if (!execute) return preview;
  need(isAbsolute(receiptPath ?? '') && !inside(preview.worktree, receiptPath) && !existsSync(receiptPath), 'New receipt path outside worktree is required');
  const receipt = { ...preview, schema: 'approve-exec-supplemental-cleanup-receipt-v1', status: 'started', remote_deleted: false,
    original_host_evidence: 'incomplete', original_acceptance: 'fail', moved: [] };
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const git = (args, cwd = preview.main_repo) => run('git', args, cwd);
  try {
    const final = supplementalPreflight(input, { run, now });
    need(final.local_sha === preview.local_sha && final.accepted_sha === preview.accepted_sha, 'Final local identity changed');
    receipt.remote_sha = final.remote_sha;
    for (const artifact of final.artifacts) {
      mkdirSync(dirname(artifact.to), { recursive: true });
      need(!existsSync(artifact.to), 'Retention destination appeared concurrently');
      const before = lstatSync(artifact.from);
      need(before.dev === artifact.device && before.ino === artifact.inode && !before.isSymbolicLink(), 'Artifact directory changed before retention');
      renameSync(artifact.from, artifact.to);
      receipt.moved.push(artifact);
      writeJsonAtomic(receiptPath, receipt);
      const after = lstatSync(artifact.to);
      need(after.dev === before.dev && after.ino === before.ino, 'Retained directory identity changed');
    }
    need(git(['status', '--porcelain', '--ignored'], preview.worktree) === '', 'New local content appeared before deletion');
    verifySupplementalEvidence(input);
    verifyInactiveWriters(input, now);
    const currentRemote = git(['ls-remote', 'origin', `refs/heads/${preview.branch}`]).split(/\s+/)[0];
    need(SHA.test(currentRemote), 'Remote vanished before deletion');
    git(['merge-base', '--is-ancestor', preview.local_sha, currentRemote]);
    const currentPr = JSON.parse(run('gh', ['pr', 'view', String(input.pr_number), '--repo', input.repo, '--json', 'state,isDraft,headRefOid,headRefName,headRepository'], preview.main_repo));
    need(currentPr.state === 'OPEN' && currentPr.isDraft === false && currentPr.headRefOid === currentRemote
      && currentPr.headRefName === preview.branch && currentPr.headRepository?.nameWithOwner === input.repo, 'PR changed before deletion');
    need(git(['rev-parse', 'HEAD'], preview.worktree) === preview.local_sha
      && git(['rev-parse', '--abbrev-ref', 'HEAD'], preview.worktree) === preview.branch, 'Local identity changed before deletion');
    need(!['.keep', '.worktree-keep', '.cleanup.lock'].some((path) => existsSync(join(preview.worktree, path)))
      && !parseTrees(git(['worktree', 'list', '--porcelain'])).find((tree) => tree.worktree === preview.worktree)?.locked, 'Late keep/lock protection');
    git(['worktree', 'remove', preview.worktree]);
    git(['update-ref', '-d', `refs/heads/${preview.branch}`, preview.local_sha]);
    need(!existsSync(preview.worktree) && git(['branch', '--list', preview.branch]) === '', 'Local cleanup did not finish');
    verifySupplementalEvidence(input);
    receipt.remote_sha = currentRemote;
    receipt.status = 'local_cleaned';
    receipt.completed_at = new Date(now ?? Date.now()).toISOString();
    writeJsonAtomic(receiptPath, receipt);
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = error.message;
    receipt.recovery = [];
    if (!existsSync(preview.worktree)) receipt.recovery.push('Worktree removed; inspect remaining local branch before retry. Retained artifacts were preserved.');
    for (const artifact of [...receipt.moved].reverse()) {
      if (existsSync(preview.worktree) && !existsSync(artifact.from) && existsSync(artifact.to)) {
        try { renameSync(artifact.to, artifact.from); }
        catch (rollback) { receipt.recovery.push(`Retained at ${artifact.to}: ${rollback.message}`); }
      }
    }
    writeJsonAtomic(receiptPath, receipt);
    throw error;
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    need(args.input, 'Usage: supplemental-cleanup.mjs --input <pinned-input.json> [--execute --receipt <new-path>]');
    process.stdout.write(`${JSON.stringify(supplementalCleanup(json(args.input), { execute: args.execute === true, receiptPath: args.receipt }), null, 2)}\n`);
  } catch (error) { process.stderr.write(`supplemental-cleanup: ${error.message}\n`); process.exitCode = 2; }
}

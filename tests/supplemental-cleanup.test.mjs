import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashObject, sha256 } from '../scripts/lib/common.mjs';
import { supplementalCleanup } from '../scripts/supplemental-cleanup.mjs';
import { wrapupCleanup } from '../scripts/wrapup-cleanup.mjs';

const NOW = Date.parse('2026-09-09T00:00:00Z');
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function fixture(t, { ignored = false, advance = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'supplemental-cleanup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const wt = join(repo, '.worktrees', 'owner');
  const branch = 'feat/exception';
  mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(['init', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\nnode_modules/\ncindyplugin/dist/\n_tmp/\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  git(['init', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['worktree', 'add', '-b', branch, wt]);
  writeFileSync(join(wt, 'feature.txt'), 'accepted\n');
  git(['add', 'feature.txt'], wt);
  git(['commit', '-m', 'accepted'], wt);
  const accepted = git(['rev-parse', 'HEAD'], wt);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`], wt);
  let remoteSha = accepted;
  if (advance) {
    git(['checkout', '-b', 'remote-fix', accepted]);
    writeFileSync(join(repo, 'remote-fix.txt'), 'remote fix\n');
    git(['add', 'remote-fix.txt']);
    git(['commit', '-m', 'remote fix']);
    remoteSha = git(['rev-parse', 'HEAD']);
    git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  }
  const owner = 'owner-session';
  const repair = 'repair-session';
  const ledgerPath = join(root, 'ledger.json');
  const amendmentPath = join(root, 'amendment.md');
  const deliveryPath = join(root, 'delivery.json');
  const acceptancePath = join(root, 'acceptance.json');
  const runtimePath = join(root, 'runtimes.json');
  const create = { content: [{ type: 'text', text: JSON.stringify({ ok: true, target_session_id: owner }) }] };
  const group = { group_id: 'PR01', session_id: owner, state: 'review', pr_url: null, assignment_seq: 0,
    branch, worktree: wt, base, title: 'Original owner', tip_sha: accepted };
  const ledger = { run_id: 'fixture', version: 13, manifest_core_hash: 'a'.repeat(64), pr_plan: { plan_hash: 'b'.repeat(64) },
    waves: [{ groups: [group] }], events: [{ type: 'replan_note', detail: { group_id: 'PR01' } }] };
  const claim = { status: 'bound', ledger: ledgerPath, run_id: ledger.run_id, group_id: group.group_id, assignment_seq: 0,
    manifest_core_hash: ledger.manifest_core_hash, execution_plan_hash: ledger.pr_plan.plan_hash, session_id: owner,
    identity: { worktree: wt, branch, base, title: group.title }, result_hash: hashObject(create) };
  writeFileSync(amendmentPath, 'User approved PR01 foundation evidence; host evidence remains incomplete.\n');
  const amendmentHash = sha256(readFileSync(amendmentPath));
  const delivery = { owner_session: owner, amendment: { path: amendmentPath, sha256: amendmentHash },
    original: { candidate_sha: accepted, branch, accept_p0_a_pr01: 'fail', host_evidence: 'incomplete' },
    amended_acceptance: { status: 'pass_under_user_exception' },
    required_checks: { all_required_pass: true, items: [{ bucket: 'pass', state: 'SUCCESS' }] },
    pr: { number: 563, url: 'https://github.com/xindong/mivo-canvas-plugin/pull/563', state: 'OPEN', draft: false, head: accepted } };
  const acceptance = { owner_session: owner, amendment_path: amendmentPath, amendment_sha256: amendmentHash,
    owner_delivery_path: deliveryPath, kind: 'lead_acceptance_under_user_approved_pr01_exception', candidate_sha: accepted,
    conclusion: { amended_acceptance: 'accepted', original_accept_p0_a_pr01: 'fail', original_host_evidence: 'incomplete', all_required_checks_pass: true } };
  write(ledgerPath, ledger);
  write(join(root, 'claim.json'), claim);
  write(join(root, 'create.json'), create);
  write(deliveryPath, delivery);
  write(acceptancePath, acceptance);
  const runtimes = { checked_at: new Date(NOW).toISOString(), results: [owner, repair].map((session_id) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, session_id, phase: 'completed', active: false, pending: null }) }] })) };
  write(runtimePath, runtimes);
  const input = { schema: 'approve-exec-supplemental-cleanup-v1', repo: 'xindong/mivo-canvas-plugin', pr_number: 563,
    group_id: 'PR01', expected_local_sha: accepted, writer_session_ids: [owner, repair], runtime_bundle: runtimePath,
    retained_dir: join(repo, '.worktrees', 'pr563-retained'), sources: {} };
  for (const [key, path] of Object.entries({ ledger: ledgerPath, claim: join(root, 'claim.json'), create_result: join(root, 'create.json'), amendment: amendmentPath, delivery: deliveryPath, acceptance: acceptancePath })) {
    input.sources[key] = { path, sha256: sha256(readFileSync(path)) };
  }
  if (ignored) {
    for (const path of ['node_modules', 'cindyplugin/dist']) {
      mkdirSync(join(wt, path), { recursive: true });
      writeFileSync(join(wt, path, 'retained.txt'), `keep ${path}\n`);
    }
  }
  const run = (bin, args, cwd) => {
    if (bin === 'gh') return JSON.stringify({ number: 563, url: delivery.pr.url, state: 'OPEN', isDraft: false,
      headRefOid: remoteSha, headRefName: branch, headRepository: { nameWithOwner: input.repo } });
    const r = spawnSync(bin, args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  return { root, repo, wt, remote, accepted, remoteSha, branch, input, run, git, runtimes, runtimePath, ledgerPath };
}

test('supplemental cleanup previews accepted ancestor without mutations', (t) => {
  const f = fixture(t, { advance: true, ignored: true });
  const result = supplementalCleanup(f.input, { run: f.run, now: NOW });
  assert.equal(result.ready, true);
  assert.equal(result.accepted_sha, f.accepted);
  assert.equal(result.remote_sha, f.remoteSha);
  assert.equal(result.artifacts.length, 2);
  assert.equal(existsSync(f.input.retained_dir), false);
  assert.equal(existsSync(f.wt), true);
  assert.equal(sha256(readFileSync(f.ledgerPath)), f.input.sources.ledger.sha256);
});

test('supplemental cleanup retains ignored bytes and remote branch, leaving original failed ledger unchanged', (t) => {
  const f = fixture(t, { advance: true, ignored: true });
  const result = supplementalCleanup(f.input, { execute: true, receiptPath: join(f.root, 'cleanup-receipt.json'), run: f.run, now: NOW });
  assert.equal(result.status, 'local_cleaned');
  assert.equal(result.official_ledger_migrated, false);
  assert.equal(existsSync(f.wt), false);
  assert.equal(f.git(['branch', '--list', f.branch]), '');
  assert.equal(f.git(['ls-remote', 'origin', `refs/heads/${f.branch}`]).split(/\s+/)[0], f.remoteSha);
  assert.equal(readFileSync(join(f.input.retained_dir, 'node_modules/retained.txt'), 'utf8'), 'keep node_modules\n');
  assert.equal(readFileSync(join(f.input.retained_dir, 'cindyplugin/dist/retained.txt'), 'utf8'), 'keep cindyplugin/dist\n');
  assert.equal(sha256(readFileSync(f.ledgerPath)), f.input.sources.ledger.sha256);
});

for (const scenario of ['active writer', 'stale runtime', 'changed evidence', 'dirty', 'keep', 'worktree keep', 'locked', 'unknown ignored', 'unpushed local', 'remote divergence']) {
  test(`supplemental cleanup refuses ${scenario} before deletion`, (t) => {
    const f = fixture(t);
    if (scenario === 'active writer') {
      f.runtimes.results[1] = { ok: true, session_id: 'repair-session', active: true, phase: 'running' };
      write(f.runtimePath, f.runtimes);
    } else if (scenario === 'stale runtime') {
      f.runtimes.checked_at = new Date(NOW - 60_001).toISOString(); write(f.runtimePath, f.runtimes);
    } else if (scenario === 'changed evidence') writeFileSync(f.input.sources.amendment.path, 'changed');
    else if (scenario === 'dirty') writeFileSync(join(f.wt, 'feature.txt'), 'changed');
    else if (scenario === 'keep') writeFileSync(join(f.wt, '.keep'), 'keep');
    else if (scenario === 'worktree keep') writeFileSync(join(f.wt, '.worktree-keep'), 'keep');
    else if (scenario === 'locked') f.git(['worktree', 'lock', f.wt]);
    else if (scenario === 'unknown ignored') {
      mkdirSync(join(f.wt, '.worktrees')); writeFileSync(join(f.wt, '.worktrees/unknown.txt'), 'unknown');
    } else if (scenario === 'unpushed local') {
      writeFileSync(join(f.wt, 'feature.txt'), 'unpublished'); f.git(['add', '.'], f.wt); f.git(['commit', '-m', 'unpublished'], f.wt);
      f.input.expected_local_sha = f.git(['rev-parse', 'HEAD'], f.wt);
    } else if (scenario === 'remote divergence') f.git(['update-ref', `refs/heads/${f.branch}`, f.git(['rev-parse', 'refs/heads/main'])], f.remote);
    assert.throws(() => supplementalCleanup(f.input, { execute: true, receiptPath: join(f.root, 'receipt.json'), run: f.run, now: NOW }));
    assert.equal(existsSync(f.wt), true);
    assert.notEqual(f.git(['branch', '--list', f.branch]), '');
    assert.equal(existsSync(join(f.root, 'receipt.json')), false);
  });
}

test('supplemental cleanup restores branch and retained directories if worktree removal fails', (t) => {
  const f = fixture(t, { ignored: true });
  const run = (bin, args, cwd) => {
    if (bin === 'git' && args[0] === 'worktree' && args[1] === 'remove') throw new Error('simulated removal failure');
    return f.run(bin, args, cwd);
  };
  const receiptPath = join(f.root, 'receipt.json');
  assert.throws(() => supplementalCleanup(f.input, { execute: true, receiptPath, run, now: NOW }), /simulated removal failure/);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.wt), f.accepted);
  assert.equal(readFileSync(join(f.wt, 'node_modules/retained.txt'), 'utf8'), 'keep node_modules\n');
  assert.equal(JSON.parse(readFileSync(receiptPath)).status, 'failed');
});

test('standard delivered-local-only cleanup succeeds against a real clean Git worktree', (t) => {
  const f = fixture(t);
  const ledger = JSON.parse(readFileSync(f.ledgerPath));
  const group = ledger.waves[0].groups[0];
  group.state = 'pr-open';
  const prReceiptPath = join(f.root, 'pr-ready.json');
  const pr = { state: 'OPEN', isDraft: false, headRefOid: f.accepted, branch: f.branch,
    headRepositoryOwner: { login: 'xindong' }, headRepository: { name: 'mivo-canvas-plugin' } };
  write(prReceiptPath, pr);
  ledger.events.push({ type: 'delivery', detail: { group_id: 'PR01', assignment_seq: 0, branch: f.branch, tip_sha: f.accepted,
    e2e: { status: 'pass', candidate_sha: f.accepted }, size_gate: { result: 'PASS', candidate_sha: f.accepted } } });
  ledger.events.push({ type: 'pr_ready', detail: { group_id: 'PR01', assignment_seq: 0, receipt: prReceiptPath } });
  ledger.events.push({ type: 'goal_report', at: '2026-09-25T00:00:01Z', detail: { group_id: 'PR01', assignment_seq: 0, head_sha: f.accepted, all_achieved: true } });
  ledger.events.push({ type: 'final_acceptance', at: '2026-09-25T00:00:02Z', detail: { group_id: 'PR01', assignment_seq: 0, head_sha: f.accepted, verdict: 'accepted', goal_report_at: '2026-09-25T00:00:01Z' } });
  write(f.ledgerPath, ledger);
  const ghBin = join(f.root, 'gh-fixture');
  writeFileSync(ghBin, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(pr))});\n`);
  chmodSync(ghBin, 0o755);
  const result = wrapupCleanup({ worktree: f.wt, branch: f.branch, now: new Date(NOW).toISOString(), ledgerVersion: 13,
    assignmentSeq: 0, mode: 'delivered-local-only', ledgerPath: f.ledgerPath, group: 'PR01', repo: f.input.repo, ghBin });
  assert.equal(result.ok, true);
  assert.equal(result.remoteDeleted, false);
  assert.equal(existsSync(f.wt), false);
  assert.equal(f.git(['branch', '--list', f.branch]), '');
  assert.equal(f.git(['ls-remote', 'origin', `refs/heads/${f.branch}`]).split(/\s+/)[0], f.accepted);
});

test('explicit retained _tmp keeps unknown files and enclosed symlinks without following them', (t) => {
  const f = fixture(t);
  const external = join(f.root, 'external.txt');
  writeFileSync(external, 'external is unchanged\n');
  mkdirSync(join(f.wt, '_tmp'));
  writeFileSync(join(f.wt, '_tmp/unknown.txt'), 'retain unknown bytes\n');
  symlinkSync(external, join(f.wt, '_tmp/external-link'));
  f.input.retained_artifacts = ['node_modules', 'cindyplugin/dist', '_tmp'];
  supplementalCleanup(f.input, { execute: true, receiptPath: join(f.root, 'receipt.json'), run: f.run, now: NOW });
  assert.equal(readFileSync(join(f.input.retained_dir, '_tmp/unknown.txt'), 'utf8'), 'retain unknown bytes\n');
  assert.equal(lstatSync(join(f.input.retained_dir, '_tmp/external-link')).isSymbolicLink(), true);
  assert.equal(readFileSync(external, 'utf8'), 'external is unchanged\n');
});

test('retention refuses a symlink artifact root', (t) => {
  const f = fixture(t);
  symlinkSync(f.root, join(f.wt, 'node_modules'));
  assert.throws(() => supplementalCleanup(f.input, { run: f.run, now: NOW }));
  assert.equal(existsSync(f.wt), true);
});

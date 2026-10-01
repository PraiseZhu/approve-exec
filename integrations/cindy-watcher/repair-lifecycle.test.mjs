// Real Git/checkout/commit/preflight/push/receipt flow; GitHub and Host are
// deterministic transport fixtures. No network or live scheduler is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanOnce, watcherPaths } from './bin/cindy-watcher.mjs';
import { evaluateCindyReview } from './bin/cindy-review-status.mjs';
import { prepare, validate, finalize, recheck, cleanupWatch } from './bin/cindy-repair.mjs';
import { readPr } from './bin/cindy-state.mjs';

const REPO = 'makecindy/cindy', ID = 'PR_lifecycle', NUMBER = 790, SESSION = 'lifecycle-owner';
test('discover → bind → prepare → failing preflight → repair → DCO → push → waiting CI → recheck → consume → cleanup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-lifecycle-'));
  const home = path.join(root, 'watcher'), plugin = path.join(root, 'plugin');
  const originUrl = path.join(root, 'fork.git'), seed = path.join(root, 'seed');
  const oldRepo = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => {
    if (oldRepo === undefined) delete process.env.CINDY_WATCHER_REPO;
    else process.env.CINDY_WATCHER_REPO = oldRepo;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Lifecycle fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Lifecycle fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    PREFLIGHT_SKIP: '0', CINDY_PREFLIGHT_SKIP: '0', CINDY_PREFLIGHT_FAST: '0' };
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', originUrl);
  git('init', '-b', 'fix/lifecycle', seed);
  fs.writeFileSync(path.join(seed, 'add.mjs'), 'export default (a, b) => a - b;\n');
  fs.writeFileSync(path.join(seed, 'check.mjs'), "import assert from 'node:assert/strict'; import add from './add.mjs'; assert.equal(add(1,2),3);\n");
  git('-C', seed, 'add', '.');
  git('-C', seed, '-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'fixture input');
  const sourceHead = git('-C', seed, 'rev-parse', 'HEAD');
  git('-C', seed, 'remote', 'add', 'origin', originUrl);
  git('-C', seed, 'push', 'origin', 'HEAD:refs/heads/fix/lifecycle');
  const remoteHead = () => git('--git-dir', originUrl, 'rev-parse', 'refs/heads/fix/lifecycle');
  let state = 'OPEN', ciGreen = true, pushes = 0, deliveries = 0;
  const pr = () => ({ id: ID, number: NUMBER, state, isDraft: false, title: 'lifecycle',
    headRefOid: remoteHead(), headRefName: 'fix/lifecycle', baseRefOid: sourceHead, baseRefName: 'main',
    author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' },
    isCrossRepository: true, releaseEpoch: 'e' });
  const finding = { id: 'standalone-p1', body: 'P1: add subtracts instead of adding',
    author: { login: 'greptile-apps', __typename: 'Bot' }, updatedAt: '2026-10-01T00:00:00Z' };
  const collect = () => {
    const s = { pr: pr(), checks: [], comments: [finding], reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE',
      requiredChecksGreen: ciGreen, ci: { status: ciGreen ? 'green' : 'pending', required: [] },
      policy: { status: 'verified', required: [] }, admissionVerified: ciGreen };
    const v = evaluateCindyReview({ snapshot: s, ci: s.ci });
    return { ...s, mergeReady: v.ready, reviewReason: v.reason };
  };
  const ghFn = (_binary, args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr());
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([pr()]);
    const endpoint = args[1];
    if (endpoint === 'user') return 'owner';
    if (endpoint === `repos/${REPO}/rules/branches/main`) return '[[]]';
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ required_status_checks: {
      contexts: ['verify'], checks: [{ context: 'verify', app_id: 123 }] } });
    if (endpoint === `repos/${REPO}/commits/${remoteHead()}/check-runs?per_page=100&filter=all`) return JSON.stringify([{check_runs:[{
      id: 101, name: 'verify', head_sha: remoteHead(), app: { id: 123, slug: 'fixture-ci' },
      status: ciGreen ? 'completed' : 'in_progress', conclusion: ciGreen ? 'success' : null,
      started_at: '2026-10-01T00:00:00Z', details_url: 'https://example.invalid/fixture-ci' }] }]);
    if (endpoint === `repos/${REPO}/commits/${remoteHead()}/statuses?per_page=100`) return '[[]]';
    assert.fail(`unhandled API fixture: ${JSON.stringify(args)}`);
  };
  const paths = watcherPaths(home);
  const common = { paths, enabled: true, allowDispatch: true, now: '2026-10-01T12:00:00Z', collect,
    ghFn: args => ghFn('gh', args), ownershipSnapshot: function* () { return { pr: pr() }; },
    dispatchFn: () => { deliveries++; return { target_session_id: SESSION }; } };
  const discover = scanOnce({ ...common, mode: 'discover' });
  assert.equal(deliveries, 1, 'standalone P1 must create the owner even with green CI and no threads');
  const entry = readPr(home, ID);
  const dispatchId = entry.activeTask.dispatchId;
  const taskPath = path.join(home, 'state/tasks', dispatchId + '.json');
  const task = JSON.parse(fs.readFileSync(taskPath));
  assert.equal(task.headRepo, 'owner/cindy-fork');
  // sessionId is bound straight off the first dispatch receipt (applyDispatchReceipt),
  // there is no separate schedule-claim step to run here anymore.
  assert.equal(entry.sessionId, SESSION);
  const gitFn = (_binary, args) => {
    if (args.includes('push')) {
      assert.equal(args.at(-2), 'origin');
      assert.match(args.at(-1), /^[a-f0-9]{40}:refs\/heads\/fix\/lifecycle$/);
      pushes++; ciGreen = false;
    }
    return git(...args);
  };
  const options = { home, taskPath, ghFn, gitFn, originUrl, cloneUrl: originUrl, viewer: 'owner' };
  const prepared = prepare(options);
  assert.equal(prepared.status, 'prepared');
  const worktree = prepared.worktree;
  const preflight = path.join(root, 'preflight.sh');
  fs.writeFileSync(preflight, '#!/bin/bash\nset -eu\nnode check.mjs\n');
  const validationEnv = { ...env, CINDY_PREFLIGHT_BIN: preflight };
  assert.equal(validate({ ...options, env: validationEnv, validatedHead: sourceHead }).status, 'fail');
  assert.equal(pushes, 0);
  fs.writeFileSync(path.join(worktree, 'add.mjs'), 'export default (a, b) => a + b;\n');
  git('-C', worktree, 'add', 'add.mjs');
  git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'fix fixture finding');
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  assert.notEqual(head, sourceHead);
  assert.match(git('-C', worktree, 'log', '-1', '--format=%B'), /Signed-off-by:/);
  const local = validate({ ...options, env: validationEnv, validatedHead: head });
  assert.equal(local.status, 'pass');
  const scReport = path.join(root, 'sc.json');
  fs.writeFileSync(scReport, JSON.stringify({ scs: [{ id: 'SC-add', status: 'pass',
    feedbackKeys: task.feedback.map(f => f.key), evidence: ['Actual node check.mjs fails before fix and passes after fix'] }] }));
  const finalOptions = { ...options, env: validationEnv, scReport, validatedHead: head };
  const waiting = finalize(finalOptions);
  assert.equal(waiting.status, 'waiting-ci');
  assert.equal(waiting.pushed, true);
  assert.equal(remoteHead(), head);
  assert.equal(pushes, 1);
  let rechecks = 0;
  const snapshot = { ...pr(), mergeable: 'MERGEABLE', checks: [], comments: [finding], reviews: [], threads: [], labels: [] };
  const poll = () => scanOnce({ ...common, mode: 'poll', nodeId: ID, prNumber: NUMBER, snapshotFn: () => snapshot,
    recheckFn: () => { rechecks++; return recheck(finalOptions); } });
  poll();
  assert.equal(readPr(home, ID).activeTask.status, 'waiting-ci');
  ciGreen = true;
  poll(); // Same lightweight snapshot; helper must recheck the actual CI API.
  assert.equal(rechecks, 2);
  assert.equal(readPr(home, ID).activeTask.status, 'complete');
  assert.equal(readPr(home, ID).activeTask.head, head);
  assert.equal(readPr(home, ID).mergeReady, true);
  assert.equal(poll().prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal(deliveries, 1);
  assert.equal(pushes, 1);
  state = 'MERGED'; snapshot.state = state;
  let closeInstructions = 0;
  const closedown = scanOnce({ ...common, mode: 'poll', nodeId: ID, prNumber: NUMBER, snapshotFn: () => snapshot, gitFn,
    dispatchFn: () => { closeInstructions++; return { target_session_id: SESSION }; } });
  // Closedown is now entirely script-driven: no session is woken, autoCleanupWatch
  // runs inline inside the poll and removes the worktree itself.
  assert.equal(closeInstructions, 0, 'MERGED/CLOSED closedown must not dispatch to a session');
  assert.equal(closedown.prs[0].dispatch.attempted, false);
  assert.equal(closedown.prs[0].dispatch.reason, 'closedown-script');
  assert.equal(fs.existsSync(worktree), false, 'autoCleanupWatch removes the worktree during the MERGED poll itself');
  assert.equal(remoteHead(), head, 'cleanup must preserve the remote branch');
  const cleanup = cleanupWatch({ home, pr: NUMBER, ghFn, gitFn, env: { ...env, CINDY_WATCHER_REPO: plugin } });
  assert.deepEqual(cleanup, { removed: false, reason: 'missing', worktree, branch: cleanup.branch });
  assert.ok(discover.prs.length && cleanup);
});

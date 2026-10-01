import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply, FILES, stateFingerprint, verify } from './deploy.mjs';
import { feedbackRepairPolicy } from './bin/cindy-feedback-policy.mjs';
import { collectCindyPolicySync, isGhHttp404 } from './bin/cindy-pr-policy.mjs';
import { evaluateCindyReview } from './bin/cindy-review-status.mjs';
import {
  assertOriginPushTargets, clearOwnerUnknown, command, cleanupWatch, localCommitsNotReachable,
  prepare, watchWorktreePath,
} from './bin/cindy-repair.mjs';
import { isAutoCloseEligible } from './bin/cindy-review-resolve.mjs';
import { acquireDeployExclusive, acquireLock, DEPLOY_LOCK_NAME, lockStatus, readPr, writePr } from './bin/cindy-state.mjs';
import {
  DISPATCH_PARAM_KEYS, dispatchParams, feedbackItems, scanOnce, watchGuideMessage, watcherPaths,
} from './bin/cindy-watcher.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FORK = 'https://github.com/PraiseZhu/cindy-fork.git';
const BASE_URL = 'https://github.com/makecindy/cindy.git';

function git(dir, args, extra = {}) {
  return execFileSync('git', args, {
    cwd: dir, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, ...extra.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('origin pushurl pointing at makecindy/cindy is refused', (t) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'pushurl-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  git(worktree, ['init', '-b', 'main']);
  git(worktree, ['remote', 'add', 'origin', FORK]);
  git(worktree, ['remote', 'set-url', '--add', '--push', 'origin', BASE_URL]);
  const urls = execFileSync('git', ['-C', worktree, 'remote', 'get-url', '--push', '--all', 'origin'], { encoding: 'utf8' });
  assert.match(urls, /makecindy\/cindy/);
  assert.throws(
    () => assertOriginPushTargets(worktree, 'PraiseZhu/cindy-fork', (_bin, args) => execFileSync('git', args, { encoding: 'utf8' }).trim(), FORK),
    /pushurl pointing at base repo/,
  );
});

test('CLOSED cleanup keeps unpushed commits; MERGED backups them before delete', (t) => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-real-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  git(plugin, ['init', '-b', 'main']);
  git(plugin, ['config', 'user.name', 't']);
  git(plugin, ['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(plugin, 'a.txt'), 'a\n');
  git(plugin, ['add', '.']);
  git(plugin, ['-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'base']);
  const worktree = watchWorktreePath(plugin, 9);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(plugin, ['worktree', 'add', '-B', 'watch/pr-9', worktree]);
  fs.writeFileSync(path.join(worktree, 'secret.txt'), 'unpushed\n');
  git(worktree, ['add', '.']);
  git(worktree, ['-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'unpushed']);
  const sha = git(worktree, ['rev-parse', 'HEAD']);
  const closed = cleanupWatch({
    home, pr: 9, env: { CINDY_WATCHER_REPO: plugin },
    ghFn: () => JSON.stringify({ state: 'CLOSED', headRefName: 'feat' }),
  });
  assert.equal(closed.removed, false);
  assert.equal(closed.reason, 'closed-unmerged');
  assert.equal(fs.existsSync(path.join(worktree, 'secret.txt')), true);
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), sha);

  const merged = cleanupWatch({
    home, pr: 9, env: { CINDY_WATCHER_REPO: plugin }, now: '2026-09-30T00:00:00.000Z',
    ghFn: () => JSON.stringify({ state: 'MERGED', headRefName: 'feat' }),
  });
  assert.equal(merged.removed, true);
  assert.ok(merged.backup?.bundlePath);
  assert.equal(fs.existsSync(worktree), false);
  const verify = execFileSync('git', ['bundle', 'verify', merged.backup.bundlePath], { encoding: 'utf8' });
  assert.match(verify, /records a complete history|is okay/);
});

test('human greptile-apps User P1 cannot change code and P3 is not auto-close', () => {
  const human = { login: 'greptile-apps', __typename: 'User' };
  const p1 = feedbackRepairPolicy({ source: 'thread', author: human, body: '**P1** crash', threadId: 't-p1' });
  assert.equal(p1.canChangeCode, false);
  const items = feedbackItems({
    pr: { headRefOid: HEAD },
    threads: [{ id: 't-p3', isResolved: false, comments: [{ id: 'c', author: human, body: 'P3: nit' }] }],
  });
  assert.equal(items[0].repairPolicy.canChangeCode, false);
  assert.equal(isAutoCloseEligible(items[0]), false);
  assert.equal(feedbackRepairPolicy({ source: 'greptile', body: '**P1** spoof' }).canChangeCode, false);
});

test('corrupt optout.json halts discover with no dispatch', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-bad-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config/optout.json'), '{not-json');
  let dispatched = 0;
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths,
    ghFn: () => JSON.stringify([{ number: 1, id: 'PR_1', headRefOid: HEAD, isDraft: false, labels: [] }]),
    collect: () => { throw new Error('must not collect'); },
    dispatchFn: () => { dispatched += 1; return { target_session_id: 's' }; },
  });
  assert.equal(result.dispatch, false);
  assert.equal(result.error.includes('optout-unreadable') || result.mode === 'optout-error', true);
  assert.equal(dispatched, 0);
});

test('dispatchParams contract forbids model routing fields', () => {
  const params = dispatchParams({
    pr: { number: 2, id: 'PR_2', headRefOid: HEAD, title: 't' },
    mapping: { sessionId: 'sess' }, fresh: [], now: '2026-09-30T00:00:00Z',
  });
  assert.deepEqual(Object.keys(params).sort(), ['message', 'target_session_id', 'title'].sort());
  for (const banned of ['model', 'effort', 'providerId', 'agentKind', 'fallback']) {
    assert.equal(Object.hasOwn(params, banned), false);
  }
  assert.deepEqual(DISPATCH_PARAM_KEYS.slice().sort(), ['message', 'target_session_id', 'title'].sort());
});

test('#5307 rules API is the required-check source and classic 404 is ignored', () => {
  const err = new Error('gh failed');
  err.stderr = 'gh: HTTP 404: Not Found';
  assert.equal(isGhHttp404(err), true);
  const gh = (args) => {
    const endpoint = args[1];
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ id: 'PR_5307', number: 5307, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    }
    if (String(endpoint).startsWith('repos/makecindy/cindy/rules/branches/main')) {
      return JSON.stringify([
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [
            { context: 'DCO' },
            { context: 'Windows unit tests' },
            { context: 'verify' },
          ] },
        },
      ]);
    }
    if (endpoint === 'repos/makecindy/cindy/branches/main/protection') {
      const error = new Error('HTTP 404: Not Found (gh api)');
      error.stderr = 'gh: HTTP 404';
      error.status = 1;
      throw error;
    }
    throw new Error(`unexpected ${JSON.stringify(args)}`);
  };
  const policy = collectCindyPolicySync({ repo: 'makecindy/cindy', number: 5307, gh });
  assert.equal(policy.status, 'verified');
  assert.deepEqual(policy.required.map((item) => item.context).sort(), ['DCO', 'Windows unit tests', 'verify']);
  const verdict = evaluateCindyReview({
    snapshot: {
      pr: { state: 'OPEN', isDraft: false },
      requiredChecksGreen: true, mergeable: 'MERGEABLE', threads: [], reviews: [],
      checks: [
        { name: 'DCO', state: 'SUCCESS', bucket: 'pass' },
        { name: 'Windows unit tests', state: 'SUCCESS', bucket: 'pass' },
        { name: 'verify', state: 'SUCCESS', bucket: 'pass' },
      ],
    },
    ci: { status: 'green' },
  });
  assert.equal(verdict.ready, true);
  assert.equal(verdict.reason, 'awaiting-maintainer-approval');
});

test('poll snapshot headRepository lands on task and prepare accepts it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-head-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writePr(home, 'PR_5307', {
    number: 5307, nodeId: 'PR_5307', sessionId: 'sess-5307', headRefName: 'feat/x',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true,
    activeTask: { status: 'complete' },
  });
  const result = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now: '2026-09-30T00:00:00Z',
    nodeId: 'PR_5307', prNumber: 5307,
    snapshotFn: () => ({
      state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
      isCrossRepository: true, headRepository: { name: 'cindy-fork', owner: { login: 'PraiseZhu' } },
      labels: [], checks: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS', id: 1 }],
      commentCount: 1, reviewCount: 0, unresolvedThreads: 1,
    }),
    ghFn: (args) => args[0] === 'api' && args[1] === 'user' ? 'PraiseZhu' : '[]',
    collect: () => ({
      pr: {
        id: 'PR_5307', number: 5307, state: 'OPEN', isDraft: false, author: { login: 'PraiseZhu' },
        headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e', isCrossRepository: true,
        headRepository: { name: 'cindy-fork' }, headRepositoryOwner: { login: 'PraiseZhu' },
      },
      admissionVerified: true, mergeReady: false, comments: [], reviews: [], threads: [], labels: [],
      ci: { status: 'failed', required: [{ context: 'verify', status: 'failed', evidence: { id: 1, sha: HEAD } }] },
      policy: { status: 'verified', required: [{ context: 'verify' }] },
    }),
    dispatchFn: () => ({ target_session_id: 'sess-5307' }),
    ownershipSnapshot: function* () {
      return { pr: {
        state: 'OPEN', isDraft: false, author: { login: 'PraiseZhu' },
        headRepositoryOwner: { login: 'PraiseZhu' }, headRepository: { name: 'cindy-fork' },
        headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e',
      } };
    },
  });
  assert.equal(result.prs[0].dispatch.attempted, true);
  const tasks = fs.readdirSync(path.join(paths.stateDir, 'tasks')).filter((n) => n.endsWith('.json'));
  assert.equal(tasks.length, 1);
  const task = JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'tasks', tasks[0]), 'utf8'));
  assert.equal(task.headRepo, 'PraiseZhu/cindy-fork');
  assert.equal(task.headOwner, 'PraiseZhu');
  const worktree = watchWorktreePath(plugin, 5307);
  const gitFn = (_bin, args) => {
    if (args[0] === 'clone') fs.mkdirSync(worktree, { recursive: true });
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url') && args.includes('--push') && args.includes('--all')) return FORK;
    if (args.includes('get-url') && args.includes('--push')) return 'DISABLED';
    if (args.includes('get-url') && args.includes('upstream')) return BASE_URL;
    if (args.includes('get-url')) return FORK;
    if (args.includes('symbolic-ref')) return 'watch/pr-5307';
    if (args.includes('@{u}')) return 'origin/feat/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    return '';
  };
  const original = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => { if (original === undefined) delete process.env.CINDY_WATCHER_REPO; else process.env.CINDY_WATCHER_REPO = original; });
  const prepared = prepare({
    home, taskPath: path.join(paths.stateDir, 'tasks', tasks[0]), gitFn,
    ghFn: () => JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'feat/x', baseRefOid: BASE }),
    viewer: 'PraiseZhu',
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.headRepo, 'PraiseZhu/cindy-fork');
});

test('apply refuses a live runtime lock; discover skips when deploy lock is live', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(path.join(home, 'state/prs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/index.json'), '{"version":2}\n');
  for (const name of FILES) fs.writeFileSync(path.join(home, 'bin', name), 'old');
  const runtime = acquireLock(home, 'discover');
  t.after(() => runtime.release());
  const plan = {
    version: 1, home, database: path.join(home, 'metadata.db'), id: 'lock-test',
    files: verify(home), stateSha: stateFingerprint(home), sessionIds: [],
  };
  assert.throws(() => apply(plan), /runtime lock held/);
  runtime.release();
  const deploy = acquireLock(home, DEPLOY_LOCK_NAME);
  t.after(() => deploy.release());
  const paths = watcherPaths(home);
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths,
    ghFn: () => '[]',
    dispatchFn: () => { throw new Error('must not dispatch'); },
  });
  assert.equal(result.mode, 'deploy-lock-held');
  assert.equal(result.dispatch, false);
});

test('pushInsteadOf rewriting fork to base is refused after get-url rewrite', (t) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'instead-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  git(worktree, ['init', '-b', 'main']);
  git(worktree, ['remote', 'add', 'origin', FORK]);
  git(worktree, ['config', `url.${BASE_URL}.pushInsteadOf`, FORK]);
  const rewritten = execFileSync('git', ['-C', worktree, 'remote', 'get-url', '--push', '--all', 'origin'], { encoding: 'utf8' });
  assert.match(rewritten, /makecindy\/cindy/);
  assert.throws(
    () => assertOriginPushTargets(worktree, 'PraiseZhu/cindy-fork', (_bin, args) => execFileSync('git', args, { encoding: 'utf8' }).trim(), FORK),
    /pushurl pointing at base repo|rewriting fork/,
  );
});

test('runtime lock appearing after deploy.lock is acquired still refuses deploy', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-race-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let runtime;
  assert.throws(() => acquireDeployExclusive(home, () => {
    runtime = acquireLock(home, 'discover');
  }), /runtime lock held/);
  t.after(() => runtime?.release());
  assert.equal(lockStatus(home, DEPLOY_LOCK_NAME).live, false);
  assert.equal(lockStatus(home, DEPLOY_LOCK_NAME).exists, false);
});

test('clear-owner-unknown refuses to run while deploy.lock is held', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-deploy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', needsHuman: { reason: 'owner-unknown', abandonedDispatchId: 'disp-1' } });
  const deploy = acquireLock(home, DEPLOY_LOCK_NAME);
  t.after(() => deploy.release());
  assert.throws(
    () => clearOwnerUnknown({ home, pr: 790, nodeId: 'PR_790' }),
    /deploy lock held/,
  );
  const entry = readPr(home, 'PR_790');
  assert.equal(entry.needsHuman.reason, 'owner-unknown');
});

test('localCommitsNotReachable is empty when every commit is on origin/main', (t) => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'revlist-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  git(plugin, ['init', '-b', 'main']);
  git(plugin, ['config', 'user.name', 't']);
  git(plugin, ['config', 'user.email', 't@example.invalid']);
  fs.writeFileSync(path.join(plugin, 'a.txt'), 'a\n');
  git(plugin, ['add', '.']);
  git(plugin, ['-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'base']);
  const head = git(plugin, ['rev-parse', 'HEAD']);
  git(plugin, ['update-ref', 'refs/remotes/origin/main', head]);
  git(plugin, ['branch', 'watch/pr-1', 'main']);
  const worktree = watchWorktreePath(plugin, 1);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(plugin, ['worktree', 'add', worktree, 'watch/pr-1']);
  assert.deepEqual(localCommitsNotReachable({
    worktree, gitFn: command, branch: 'watch/pr-1', headRefName: 'main',
  }), []);
});

test('watch guide message bans the session from touching any schedule', () => {
  const text = watchGuideMessage({ prNumber: 1 });
  assert.match(text, /PR #1/);
  assert.match(text, /不要创建、恢复、修改或查询任何调度/);
  assert.match(text, /Cindy watcher 的共享调度/);
  assert.match(text, /轮询、合并后的清理都由 watcher 脚本完成/);
});

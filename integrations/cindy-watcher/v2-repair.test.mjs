import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupWatch, clearOwnerUnknown, cloneWorktree, DEFAULT_PLUGIN_REPO, lockDoctor, lockDoctorClearGuard, prepare, pushIfNeeded,
  repairPaths, shellQuote, watchBranchName, watchWorktreePath,
} from './bin/cindy-repair.mjs';
import { acquireDeployExclusive, acquireLock, helperLockName, readPr, statePaths, writePr } from './bin/cindy-state.mjs';

const HEAD = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-repair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('shellQuote uses POSIX single quotes and escapes apostrophes', () => {
  assert.equal(shellQuote('hello'), "'hello'");
  assert.equal(JSON.stringify(shellQuote("a'b")), JSON.stringify("'a'\\''b'"));
});

test('clear-owner-unknown clears needsHuman and abandons the unknown dispatch', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', needsHuman: { reason: 'owner-unknown', abandonedDispatchId: 'live-790-x' } });
  const entry = clearOwnerUnknown({ home, pr: 790, nodeId: 'PR_790', now: '2026-10-02T00:00:00Z' });
  assert.equal(entry.needsHuman, null);
  assert.deepEqual(entry.abandonedDispatches, ['live-790-x']);
  assert.deepEqual(readPr(home, 'PR_790').abandonedDispatches, ['live-790-x']);
  assert.throws(() => clearOwnerUnknown({ home, pr: 790, nodeId: 'PR_790' }), /没有 owner-unknown/);
});

test('cloneWorktree clones the PR fork and adds fetch-only upstream', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const task = { number: 790, headRefName: 'fix/x', headRefOid: HEAD, repo: 'makecindy/cindy', headRepo: 'PraiseZhu/cindy-fork' };
  const calls = [];
  const gitFn = (_bin, args) => {
    calls.push(args);
    const worktree = watchWorktreePath(plugin, 790);
    if (args[0] === 'clone') fs.mkdirSync(worktree, { recursive: true });
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url') && args.includes('--push') && args.includes('--all') && args.at(-1) === 'origin') return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('get-url') && args.includes('--push')) return 'DISABLED';
    if (args.includes('get-url') && args.includes('upstream')) return 'https://github.com/makecindy/cindy.git';
    if (args.includes('get-url')) return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('symbolic-ref')) return watchBranchName(790);
    if (args.includes('@{u}')) return 'origin/fix/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    return '';
  };
  const result = cloneWorktree(repairPaths(home), task, gitFn, undefined, undefined, HEAD, { CINDY_WATCHER_REPO: plugin });
  assert.equal(result.worktree, watchWorktreePath(plugin, 790));
  assert.ok(calls.some((args) => args[0] === 'clone' && args.includes('--branch') && args.includes('fix/x')));
  // Objects come from the local Cindy repo; only the PR's new commits cross the network.
  const clone = calls.find((args) => args[0] === 'clone');
  assert.equal(clone[clone.indexOf('--reference-if-able') + 1], plugin);
  assert.ok(clone.includes('--dissociate'), 'borrowed objects must be copied in');
  assert.ok(calls.some((args) => args.includes('remote') && args.includes('add') && args.includes('upstream')));
  assert.ok(calls.some((args) => args.includes('set-url') && args.includes('--push') && args.includes('DISABLED')));
  assert.equal(calls.some((args) => args.includes('push') && String(args).includes('makecindy/cindy')), false);
});

test('pushIfNeeded pushes HEAD:refs/heads/<headRef> to the fork, never the base', (t) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const task = { number: 1, headRefName: 'fix/x', headRefOid: HEAD, repo: 'makecindy/cindy', headRepo: 'PraiseZhu/cindy-fork' };
  const calls = [];
  let pushed = false;
  const gitFn = (_bin, args) => {
    calls.push(args);
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url') && args.includes('--push') && args.includes('--all') && args.at(-1) === 'origin') return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('get-url') && args.includes('--push')) return 'DISABLED';
    if (args.includes('get-url') && args.includes('upstream')) return 'https://github.com/makecindy/cindy.git';
    if (args.includes('get-url')) return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('symbolic-ref')) return 'watch/pr-1';
    if (args.includes('@{u}')) return 'origin/fix/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    if (args.includes('ls-remote')) return pushed ? HEAD : REMOTE;
    if (args.includes('merge-base')) return '';
    if (args.includes('push')) { pushed = true; return ''; }
    return '';
  };
  pushIfNeeded(worktree, task, HEAD, REMOTE, gitFn);
  assert.ok(calls.some((args) => args.includes('push') && args.includes('origin') && args.includes(`${HEAD}:refs/heads/fix/x`)));
  assert.throws(
    () => pushIfNeeded(worktree, task, HEAD, REMOTE, gitFn, 'https://github.com/makecindy/cindy.git'),
    /refusing to push to base repo/,
  );
});

test('cleanup removes only a clean worktree', (t) => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const worktree = watchWorktreePath(plugin, 790);
  fs.mkdirSync(worktree, { recursive: true });
  const home = homeOf(t);
  const dirtyFn = (_bin, args) => {
    if (args.includes('--porcelain')) return ' M file';
    return '';
  };
  assert.throws(
    () => cleanupWatch({ home, pr: 790, ghFn: () => JSON.stringify({ state: 'MERGED' }), gitFn: dirtyFn, env: { CINDY_WATCHER_REPO: plugin } }),
    /dirty/,
  );
  const calls = [];
  cleanupWatch({
    home, pr: 790,
    ghFn: () => JSON.stringify({ state: 'MERGED', headRefName: 'fix/x' }),
    gitFn: (_bin, args) => {
      calls.push(args);
      if (args.includes('--porcelain')) return '';
      if (args.includes('rev-list')) return '';
      if (args.includes('--git-common-dir')) throw new Error('not a linked worktree');
      return '';
    },
    env: { CINDY_WATCHER_REPO: plugin },
  });
  assert.equal(fs.existsSync(worktree), false);
});

function writeTask(home, extra = {}) {
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: 'live-790', nodeId: 'PR_790', number: 790, repo: 'makecindy/cindy',
    sessionId: 'sess-a', headRefOid: HEAD, headRefName: 'fix/x',
    headRepo: 'PraiseZhu/cindy-fork', headOwner: 'PraiseZhu', ...extra,
  };
  const taskPath = path.join(paths.tasks, `${task.dispatchId}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task));
  return { paths, taskPath, task };
}

function prepareFns(plugin, worktree) {
  const ghFn = (_bin, args) => {
    if (Array.isArray(args) && args[0] === 'api' && args[1] === 'user') return 'PraiseZhu';
    return JSON.stringify({
      state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'fix/x', baseRefOid: REMOTE,
    });
  };
  const gitFn = (_bin, args) => {
    if (args[0] === 'clone') fs.mkdirSync(worktree, { recursive: true });
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url') && args.includes('--push') && args.includes('--all') && args.at(-1) === 'origin') return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('get-url') && args.includes('--push')) return 'DISABLED';
    if (args.includes('get-url') && args.includes('upstream')) return 'https://github.com/makecindy/cindy.git';
    if (args.includes('get-url')) return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('symbolic-ref')) return 'watch/pr-790';
    if (args.includes('@{u}')) return 'origin/fix/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    return '';
  };
  return { ghFn, gitFn, env: { CINDY_WATCHER_REPO: plugin } };
}

test('prepare reads v2 per-PR state without ReferenceError', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const { taskPath } = writeTask(home);
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a', activeTask: { dispatchId: 'live-790' } });
  const worktree = watchWorktreePath(plugin, 790);
  const { ghFn, gitFn, env } = prepareFns(plugin, worktree);
  const original = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => { if (original === undefined) delete process.env.CINDY_WATCHER_REPO; else process.env.CINDY_WATCHER_REPO = original; });
  const result = prepare({ home, taskPath, ghFn, gitFn });
  assert.equal(result.sessionId, 'sess-a');
  assert.equal(result.status, 'prepared');
  assert.equal(result.worktree, worktree);
});

test('prepare reads legacy state.json without ReferenceError', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const { paths, taskPath } = writeTask(home);
  fs.mkdirSync(path.dirname(paths.state), { recursive: true });
  fs.writeFileSync(paths.state, JSON.stringify({
    prs: { PR_790: { number: 790, nodeId: 'PR_790', sessionId: 'sess-a', activeTask: { dispatchId: 'live-790' } } },
  }));
  const worktree = watchWorktreePath(plugin, 790);
  const { ghFn, gitFn } = prepareFns(plugin, worktree);
  const original = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => { if (original === undefined) delete process.env.CINDY_WATCHER_REPO; else process.env.CINDY_WATCHER_REPO = original; });
  const result = prepare({ home, taskPath, ghFn, gitFn });
  assert.equal(result.sessionId, 'sess-a');
  assert.equal(result.status, 'prepared');
});

test('prepare refuses a task superseded by the author reclaiming the PR', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const { taskPath } = writeTask(home);
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a',
    activeTask: { dispatchId: 'live-790', status: 'blocked', blockedKind: 'author-reclaimed' } });
  const { ghFn, gitFn } = prepareFns(plugin, watchWorktreePath(plugin, 790));
  assert.throws(() => prepare({ home, taskPath, ghFn, gitFn }), /task superseded: the author reclaimed this PR/);
});

test('PR A long preflight does not block PR B prepare; same PR returns busy', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const a = writeTask(home, { dispatchId: 'live-790', nodeId: 'PR_790', number: 790, sessionId: 'sess-a' });
  const b = writeTask(home, { dispatchId: 'live-791', nodeId: 'PR_791', number: 791, sessionId: 'sess-b' });
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a', activeTask: { dispatchId: 'live-790' } });
  writePr(home, 'PR_791', { number: 791, nodeId: 'PR_791', sessionId: 'sess-b', activeTask: { dispatchId: 'live-791' } });
  const original = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => { if (original === undefined) delete process.env.CINDY_WATCHER_REPO; else process.env.CINDY_WATCHER_REPO = original; });
  const ghFn = (_bin, args) => {
    if (Array.isArray(args) && args[0] === 'api' && args[1] === 'user') return 'PraiseZhu';
    return JSON.stringify({
      state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'fix/x', baseRefOid: REMOTE,
    });
  };
  const gitFn = (_bin, args) => {
    const cIndex = args.indexOf('-C');
    const worktree = cIndex >= 0 ? args[cIndex + 1] : args[0] === 'clone' ? args.at(-1) : null;
    const number = String(worktree ?? '').match(/pr-(\d+)/)?.[1];
    if (args[0] === 'clone') fs.mkdirSync(worktree, { recursive: true });
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url') && args.includes('--push') && args.includes('--all') && args.at(-1) === 'origin') {
      return 'https://github.com/PraiseZhu/cindy-fork.git';
    }
    if (args.includes('get-url') && args.includes('--push')) return 'DISABLED';
    if (args.includes('get-url') && args.includes('upstream')) return 'https://github.com/makecindy/cindy.git';
    if (args.includes('get-url')) return 'https://github.com/PraiseZhu/cindy-fork.git';
    if (args.includes('symbolic-ref')) return `watch/pr-${number ?? '790'}`;
    if (args.includes('@{u}')) return 'origin/fix/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    return '';
  };
  const preflight = acquireLock(home, helperLockName(790));
  t.after(() => preflight.release());
  assert.equal(preflight.held, false);
  const preparedB = prepare({ home, taskPath: b.taskPath, ghFn, gitFn });
  assert.equal(preparedB.status, 'prepared');
  assert.equal(preparedB.number, 791);
  try {
    prepare({ home, taskPath: a.taskPath, ghFn, gitFn });
    assert.fail('expected busy');
  } catch (error) {
    assert.match(error.message, /^busy:/);
    assert.equal(error.exitCode, 2);
  }
  assert.throws(() => acquireDeployExclusive(home), /runtime lock held/);
  preflight.release();
  const preparedA = prepare({ home, taskPath: a.taskPath, ghFn, gitFn });
  assert.equal(preparedA.status, 'prepared');
  assert.equal(preparedA.number, 790);
});

test('lock-doctor lists locks and refuses to clear a live guard', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  const guardPath = path.join(locksDir, 'discover.lock.reclaim');
  fs.mkdirSync(guardPath);
  fs.writeFileSync(path.join(guardPath, 'owner'), `${JSON.stringify({
    pid: process.pid, token: 'live', createdAt: new Date().toISOString(),
  })}\n`);
  const listed = lockDoctor({ home });
  assert.equal(listed.guards.length, 1);
  assert.equal(listed.guards[0].live, true);
  assert.equal(listed.orphanGuards.length, 0);
  const refused = lockDoctorClearGuard({ home, lockName: 'discover' });
  assert.equal(refused.cleared, false);
  assert.equal(refused.reason, 'owner-alive');
});

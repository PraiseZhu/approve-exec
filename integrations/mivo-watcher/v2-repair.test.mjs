import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupWatch, clearOwnerUnknown, cloneWorktree, DEFAULT_PLUGIN_REPO, prepare, pushIfNeeded,
  repairPaths, shellQuote, watchBranchName, watchWorktreePath,
} from './bin/mivo-repair.mjs';
import { readPr, statePaths, writePr } from './bin/mivo-state.mjs';

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

test('cloneWorktree uses git worktree add -B watch/pr-N under plugin repo', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const task = { number: 790, headRefName: 'fix/x', headRefOid: HEAD, repo: 'xindong/mivo-canvas-plugin' };
  const calls = [];
  const gitFn = (_bin, args) => {
    calls.push(args);
    const worktree = watchWorktreePath(plugin, 790);
    if (args.includes('worktree') && args.includes('add')) fs.mkdirSync(worktree, { recursive: true });
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url')) return 'https://github.com/xindong/mivo-canvas-plugin.git';
    if (args.includes('symbolic-ref')) return watchBranchName(790);
    if (args.includes('@{u}')) return 'origin/fix/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    return '';
  };
  const result = cloneWorktree(repairPaths(home), task, gitFn, undefined, undefined, HEAD, { MIVO_PLUGIN_REPO: plugin });
  assert.equal(result.worktree, watchWorktreePath(plugin, 790));
  assert.ok(calls.some((args) => args.includes('worktree') && args.includes('add') && args.includes('-B') && args.includes('watch/pr-790')));
  assert.ok(calls.some((args) => args[0] === '-C' && args[1] === plugin && args.includes('fetch')));
});

test('pushIfNeeded pushes HEAD:refs/heads/<headRef>', (t) => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const task = { number: 1, headRefName: 'fix/x', headRefOid: HEAD, repo: 'xindong/mivo-canvas-plugin' };
  const calls = [];
  let pushed = false;
  const gitFn = (_bin, args) => {
    calls.push(args);
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url')) return 'https://github.com/xindong/mivo-canvas-plugin.git';
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
  assert.ok(calls.some((args) => args.includes('push') && args.includes('origin') && args.includes('HEAD:refs/heads/fix/x')));
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
    () => cleanupWatch({ home, pr: 790, ghFn: () => JSON.stringify({ state: 'MERGED' }), gitFn: dirtyFn, env: { MIVO_PLUGIN_REPO: plugin } }),
    /dirty/,
  );
  const calls = [];
  cleanupWatch({
    home, pr: 790,
    ghFn: () => JSON.stringify({ state: 'CLOSED' }),
    gitFn: (_bin, args) => {
      calls.push(args);
      if (args.includes('--porcelain')) return '';
      return '';
    },
    env: { MIVO_PLUGIN_REPO: plugin },
  });
  assert.ok(calls.some((args) => args.includes('worktree') && args.includes('remove')));
  assert.ok(calls.some((args) => args.includes('branch') && args.includes('-d') && args.includes('watch/pr-790')));
});

function writeTask(home, extra = {}) {
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: 'live-790', nodeId: 'PR_790', number: 790, repo: 'xindong/mivo-canvas-plugin',
    sessionId: 'sess-a', headRefOid: HEAD, headRefName: 'fix/x', ...extra,
  };
  const taskPath = path.join(paths.tasks, 'live-790.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  return { paths, taskPath, task };
}

function prepareFns(plugin, worktree) {
  const ghFn = () => JSON.stringify({
    state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'fix/x', baseRefOid: REMOTE,
  });
  const gitFn = (_bin, args) => {
    if (args.includes('worktree') && args.includes('add')) fs.mkdirSync(worktree, { recursive: true });
    if (args.includes('--show-toplevel')) return worktree;
    if (args.includes('get-url')) return 'https://github.com/xindong/mivo-canvas-plugin.git';
    if (args.includes('symbolic-ref')) return 'watch/pr-790';
    if (args.includes('@{u}')) return 'origin/fix/x';
    if (args.includes('--porcelain')) return '';
    if (args.includes('rev-parse') && args.includes('HEAD')) return HEAD;
    return '';
  };
  return { ghFn, gitFn, env: { MIVO_PLUGIN_REPO: plugin } };
}

test('prepare reads v2 per-PR state without ReferenceError', (t) => {
  const home = homeOf(t);
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const { taskPath } = writeTask(home);
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a', activeTask: { dispatchId: 'live-790' } });
  const worktree = watchWorktreePath(plugin, 790);
  const { ghFn, gitFn, env } = prepareFns(plugin, worktree);
  const original = process.env.MIVO_PLUGIN_REPO;
  process.env.MIVO_PLUGIN_REPO = plugin;
  t.after(() => { if (original === undefined) delete process.env.MIVO_PLUGIN_REPO; else process.env.MIVO_PLUGIN_REPO = original; });
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
  const original = process.env.MIVO_PLUGIN_REPO;
  process.env.MIVO_PLUGIN_REPO = plugin;
  t.after(() => { if (original === undefined) delete process.env.MIVO_PLUGIN_REPO; else process.env.MIVO_PLUGIN_REPO = original; });
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindSchedule, cleanupWatch, cloneWorktree, DEFAULT_PLUGIN_REPO, prepare, pushIfNeeded,
  repairPaths, scheduleParams, watchBranchName, watchWorktreePath,
} from './bin/mivo-repair.mjs';
import { writePr } from './bin/mivo-state.mjs';

const HEAD = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-repair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('schedule-params matches v2 fields and omits silentWhenIdle', (t) => {
  const home = homeOf(t);
  const out = scheduleParams({ home, pr: 790, nodeId: 'PR_790' });
  assert.equal(out.name, 'Mivo watch #790');
  assert.equal(out.executionMode, 'script');
  assert.deepEqual(out.scriptConfig.capabilities, ['sessions.dispatch']);
  assert.equal(out.scriptConfig.timeoutMs, 180000);
  assert.equal(out.cronExpr, '*/5 * * * *');
  assert.equal(out.timezone, 'Asia/Shanghai');
  assert.equal(out.recurring, true);
  assert.equal(out.agentKind, 'codex');
  assert.equal(out.kind, 'cron');
  assert.equal(out.workingDir, DEFAULT_PLUGIN_REPO);
  assert.equal(out.useWorktree, false);
  assert.equal(out.bindToCurrentSession, true);
  assert.deepEqual(out.notify, { desktop: false, feishu: false });
  assert.equal(Object.hasOwn(out, 'silentWhenIdle'), false);
  assert.match(out.scriptConfig.command, /--mode poll --pr 790 --node-id PR_790/);
  assert.match(out.scriptConfig.command, /mivo-watch-script\.py/);
});

test('bind-schedule accepts first owner and rejects a second live owner', (t) => {
  const home = homeOf(t);
  const resultPath = path.join(home, 'sched.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-1', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-a', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
  }));
  const first = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, now: '2026-09-28T00:00:00Z' });
  assert.equal(first.sessionId, 'sess-a');
  assert.equal(first.scheduleId, 'sched-1');
  assert.equal(first.pendingDispatch, null);
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-2', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-b', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
  }));
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, now: '2026-09-28T00:01:00Z' }),
    /本 PR 已由 sess-a 持有/,
  );
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

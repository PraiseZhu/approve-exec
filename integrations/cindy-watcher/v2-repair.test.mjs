import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindSchedule, cleanupWatch, clearOwnerUnknown, cloneWorktree, DEFAULT_PLUGIN_REPO, prepare, pushIfNeeded,
  repairPaths, scheduleCreatePayload, scheduleModelFromResult, scheduleParams, shellQuote,
  SCHEDULE_MODEL_FALLBACK, SCHEDULE_MODEL_PRIMARY, watchBranchName, watchWorktreePath,
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

test('schedule-params matches v2 fields and omits silentWhenIdle', (t) => {
  const home = homeOf(t);
  const out = scheduleParams({ home, pr: 790, nodeId: 'PR_790' });
  assert.equal(out.name, 'Cindy watch #790');
  assert.equal(out.executionMode, 'script');
  assert.deepEqual(out.scriptConfig.capabilities, ['sessions.dispatch']);
  assert.equal(out.scriptConfig.timeoutMs, 180000);
  assert.equal(out.cronExpr, '*/5 * * * *');
  assert.equal(out.timezone, 'Asia/Shanghai');
  assert.equal(out.recurring, true);
  assert.equal(out.agentKind, SCHEDULE_MODEL_PRIMARY.agentKind);
  assert.equal(out.model, 'openai/gpt-6-luna');
  assert.equal(out.providerId, 'xd');
  assert.equal(out.effort, 'max');
  assert.deepEqual(out.fallback, { ...SCHEDULE_MODEL_FALLBACK });
  assert.equal(out.fallback.model, 'gpt-6-luna');
  assert.equal(out.fallback.providerId, 'art-cindy');
  assert.equal(out.fallback.effort, 'max');
  assert.equal(Object.hasOwn(scheduleCreatePayload(out), 'fallback'), false);
  assert.equal(out.kind, 'cron');
  assert.equal(out.workingDir, DEFAULT_PLUGIN_REPO);
  assert.equal(out.useWorktree, false);
  assert.equal(out.bindToCurrentSession, true);
  assert.deepEqual(out.notify, { desktop: false, feishu: false });
  assert.equal(Object.hasOwn(out, 'silentWhenIdle'), false);
  assert.match(out.scriptConfig.command, /--mode poll --pr 790 --node-id PR_790/);
  assert.match(out.scriptConfig.command, /CINDY_WATCHER_LIVE=1/);
  assert.match(out.scriptConfig.command, /CINDY_WATCHER_HOME=/);
  assert.match(out.scriptConfig.command, /CINDY_NODE_BIN=\/opt\/homebrew\/bin\/node/);
  assert.match(out.scriptConfig.command, /GH_BIN=\/opt\/homebrew\/bin\/gh/);
  assert.match(out.scriptConfig.command, /cindy-watch-script\.py/);
});

function schedFile(home, extra = {}) {
  const resultPath = path.join(home, 'sched.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-1', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-a', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' }, ...extra,
  }));
  return resultPath;
}
function seedPending(home, dispatchId = 'disp-1', extra = {}) {
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', pendingDispatch: { status: 'awaiting-claim', dispatchId }, ...extra });
}

test('bind-schedule records primary model when scheduler does not echo route', (t) => {
  const home = homeOf(t);
  seedPending(home);
  const first = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath: schedFile(home), dispatchId: 'disp-1', now: '2026-09-28T00:00:00Z' });
  assert.deepEqual(first.scheduleModel, { ...SCHEDULE_MODEL_PRIMARY, fallback: false, reason: null });
});

test('bind-schedule records fallback reason and refuses unknown models', (t) => {
  const home = homeOf(t);
  seedPending(home);
  const resultPath = schedFile(home, {
    ...SCHEDULE_MODEL_FALLBACK, fallbackUsed: true, fallbackReason: 'NO_PROVIDER_FOR_AGENT: xd',
  });
  const entry = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-1', now: '2026-09-28T00:00:00Z' });
  assert.equal(entry.scheduleModel.fallback, true);
  assert.equal(entry.scheduleModel.providerId, 'art-cindy');
  assert.equal(entry.scheduleModel.model, 'gpt-6-luna');
  assert.equal(entry.scheduleModel.effort, 'max');
  assert.equal(entry.scheduleModel.reason, 'NO_PROVIDER_FOR_AGENT: xd');
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', pendingDispatch: { status: 'awaiting-claim', dispatchId: 'disp-2' } });
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-x', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-a', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
    ...SCHEDULE_MODEL_FALLBACK, fallbackUsed: true,
  }));
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-2', retryMs: 0 }),
    /fallbackReason/,
  );
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-y', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-a', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
    model: 'gpt-4', providerId: 'other', effort: 'max',
  }));
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', pendingDispatch: { status: 'awaiting-claim', dispatchId: 'disp-3' } });
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-3', retryMs: 0 }),
    /neither primary nor fallback/,
  );
});

test('bind-schedule accepts first owner and rejects a second live owner', (t) => {
  const home = homeOf(t);
  seedPending(home);
  const resultPath = schedFile(home);
  const first = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-1', now: '2026-09-28T00:00:00Z' });
  assert.equal(first.sessionId, 'sess-a');
  assert.equal(first.scheduleId, 'sched-1');
  assert.equal(first.pendingDispatch, null);
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-2', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-b', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
  }));
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-1', now: '2026-09-28T00:01:00Z' }),
    /本 PR 已由 sess-a 持有/,
  );
});

test('late bind-schedule can claim owner-unknown and clears needsHuman', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_790', {
    number: 790, nodeId: 'PR_790',
    needsHuman: { reason: 'owner-unknown', at: '2026-09-28T01:01:00Z', abandonedDispatchId: 'old-disp' },
  });
  const resultPath = schedFile(home, { id: 'sched-late', targetSessionId: 'sess-late' });
  const entry = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'old-disp', now: '2026-09-28T03:00:00Z' });
  assert.equal(entry.sessionId, 'sess-late');
  assert.equal(entry.needsHuman, null);
});

test('bind-schedule busy vs owner-conflict', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'pr-PR_790.lock'), `${process.pid} 2026-09-28T00:00:00.000Z\n`);
  const resultPath = path.join(home, 'sched.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-1', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-a', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
  }));
  try {
    bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, retryMs: 0, retryDelayMs: 0, sleepFn: () => {} });
    assert.fail('expected busy');
  } catch (error) {
    assert.match(error.message, /^busy:/);
    assert.equal(error.exitCode, 2);
  }
  fs.unlinkSync(path.join(locksDir, 'pr-PR_790.lock'));
  seedPending(home);
  bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-1', now: '2026-09-28T00:00:00Z', retryMs: 0 });
  try {
    fs.writeFileSync(resultPath, JSON.stringify({
      ok: true, id: 'sched-2', executionMode: 'script', status: 'active',
      targetSessionId: 'sess-b', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
    }));
    bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-1', now: '2026-09-28T00:01:00Z', retryMs: 0 });
    assert.fail('expected owner-conflict');
  } catch (error) {
    assert.match(error.message, /^owner-conflict:/);
    assert.equal(error.exitCode, 3);
  }
});

test('bind-schedule retries until lock is released', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  const lockFile = path.join(locksDir, 'pr-PR_790.lock');
  fs.writeFileSync(lockFile, `${process.pid} 2026-09-28T00:00:00.000Z\n`);
  const resultPath = path.join(home, 'sched.json');
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-1', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-a', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
  }));
  let slept = 0;
  seedPending(home);
  const entry = bindSchedule({
    home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'disp-1', retryMs: 1000, retryDelayMs: 1,
    sleepFn: () => { slept += 1; try { fs.unlinkSync(lockFile); } catch {} },
  });
  assert.equal(entry.sessionId, 'sess-a');
  assert.ok(slept >= 1);
});

test('old bind after clear-owner-unknown is rejected; new bind succeeds', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_790', {
    number: 790, nodeId: 'PR_790',
    needsHuman: { reason: 'owner-unknown', at: '2026-09-28T01:01:00Z', abandonedDispatchId: 'old-disp' },
  });
  clearOwnerUnknown({ home, pr: 790, nodeId: 'PR_790' });
  const afterClear = readPr(home, 'PR_790');
  writePr(home, 'PR_790', {
    ...afterClear,
    pendingDispatch: { status: 'awaiting-claim', dispatchId: 'new-disp' },
  });
  const resultPath = schedFile(home, { targetSessionId: 'sess-old' });
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'old-disp', retryMs: 0 }),
    /dispatch-id 已作废/,
  );
  fs.writeFileSync(resultPath, JSON.stringify({
    ok: true, id: 'sched-new', executionMode: 'script', status: 'active',
    targetSessionId: 'sess-new', scriptConfig: { command: 'python3 x.py --mode poll --pr 790 --node-id PR_790' },
  }));
  const ok = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, dispatchId: 'new-disp', retryMs: 0 });
  assert.equal(ok.sessionId, 'sess-new');
});

test('migrated owner can bind-schedule without dispatch-id', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a' });
  const resultPath = schedFile(home);
  const entry = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, now: '2026-09-28T00:00:00Z', retryMs: 0 });
  assert.equal(entry.sessionId, 'sess-a');
  assert.equal(entry.scheduleId, 'sched-1');
  assert.equal(entry.pendingDispatch, null);
});

test('bind without dispatch-id is idempotent when scheduleId already matches', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_790', {
    number: 790, nodeId: 'PR_790', sessionId: 'sess-a', scheduleId: 'sched-1', claimedAt: '2026-09-28T00:00:00Z',
  });
  const prFile = path.join(statePaths(home).prsDir, 'PR_790.json');
  const before = fs.readFileSync(prFile);
  const resultPath = schedFile(home);
  const entry = bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, now: '2026-09-28T01:00:00Z', retryMs: 0 });
  assert.equal(entry.scheduleId, 'sched-1');
  assert.equal(entry.claimedAt, '2026-09-28T00:00:00Z');
  assert.equal(fs.readFileSync(prFile).equals(before), true);
});

test('bind without dispatch-id rejects a second schedule and leaves bytes unchanged', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_790', {
    number: 790, nodeId: 'PR_790', sessionId: 'sess-a', scheduleId: 'sched-old', claimedAt: '2026-09-28T00:00:00Z',
  });
  const prFile = path.join(statePaths(home).prsDir, 'PR_790.json');
  const before = fs.readFileSync(prFile);
  const resultPath = schedFile(home);
  try {
    bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, now: '2026-09-28T01:00:00Z', retryMs: 0 });
    assert.fail('expected owner-conflict');
  } catch (error) {
    assert.match(error.message, /本 PR 已有轮询调度 sched-old/);
    assert.match(error.message, /不要新建第二条/);
    assert.equal(error.exitCode, 3);
  }
  assert.equal(fs.readFileSync(prFile).equals(before), true);
});

test('bind-schedule without dispatch-id still rejects strangers and pending claims', (t) => {
  const home = homeOf(t);
  const resultPath = schedFile(home);
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, retryMs: 0 }),
    /需要 --dispatch-id/,
  );
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-other' });
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, retryMs: 0 }),
    /需要 --dispatch-id/,
  );
  writePr(home, 'PR_790', {
    number: 790, nodeId: 'PR_790', sessionId: 'sess-a',
    pendingDispatch: { status: 'awaiting-claim', dispatchId: 'disp-1' },
  });
  assert.throws(
    () => bindSchedule({ home, pr: 790, nodeId: 'PR_790', resultPath, retryMs: 0 }),
    /需要 --dispatch-id/,
  );
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

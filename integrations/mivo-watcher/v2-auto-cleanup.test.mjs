import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  autoCleanupWatch, backupWatchBranch, branchAncestorOfMain, command, watchWorktreePath,
} from './bin/mivo-repair.mjs';

// 这组测试用真实临时 git 仓（不是 stub gitFn）驱动 branchAncestorOfMain /
// backupWatchBranch / autoCleanupWatch，覆盖任务要求的“真实 git 仓 + worktree
// 验证：干净时被删、有未推送提交时先生成 bundle 再删、判断不了时不删”。

function run(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function initPluginRepo(t) {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-real-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  run(plugin, ['init', '-q', '-b', 'main']);
  run(plugin, ['config', 'user.email', 'test@example.com']);
  run(plugin, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(plugin, 'README.md'), 'root\n');
  run(plugin, ['add', '.']);
  run(plugin, ['commit', '-q', '-m', 'init']);
  const head = run(plugin, ['rev-parse', 'HEAD']);
  // 没有真实远程，用 update-ref 伪造 origin/main 指向当前 main，
  // 模拟“这个仓已经 fetch 过 origin/main”的状态。
  run(plugin, ['update-ref', 'refs/remotes/origin/main', head]);
  return { plugin, head };
}

function createBranch(plugin, branch, { extraCommit } = {}) {
  run(plugin, ['branch', branch, 'main']);
  if (extraCommit) {
    const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    run(plugin, ['worktree', 'add', '-q', tmpWorktree, branch]);
    fs.writeFileSync(path.join(tmpWorktree, 'extra.txt'), 'unmerged change\n');
    run(tmpWorktree, ['add', '.']);
    run(tmpWorktree, ['commit', '-q', '-m', 'extra unmerged commit']);
    run(plugin, ['worktree', 'remove', '--force', tmpWorktree]);
  }
}

test('branchAncestorOfMain: 分支等于 main 时为 true，含未合入提交时为 false', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-1');
  createBranch(plugin, 'watch/pr-2', { extraCommit: true });
  assert.equal(branchAncestorOfMain(plugin, 'watch/pr-1', command), true);
  assert.equal(branchAncestorOfMain(plugin, 'watch/pr-2', command), false);
});

test('backupWatchBranch: 在 _backup/pr<N>-<日期>/ 下生成可用的 git bundle', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-3', { extraCommit: true });
  const now = '2026-09-29T03:04:05.000Z';
  const result = backupWatchBranch({ plugin, number: 3, branch: 'watch/pr-3', gitFn: command, now });
  assert.equal(result.bundlePath, path.join(plugin, '_backup', 'pr3-2026-09-29', 'watch-pr-3.bundle'));
  assert.ok(fs.existsSync(result.bundlePath));
  // bundle 本身要能被 git 校验，不是空文件或坏文件。
  const verify = run(plugin, ['bundle', 'verify', result.bundlePath]);
  assert.match(verify, /records a complete history|is okay/);
});

test('autoCleanupWatch: 未合并时不动手，只记录', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-4');
  const worktree = watchWorktreePath(plugin, 4);
  run(plugin, ['worktree', 'add', '-q', worktree, 'watch/pr-4']);
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const ghFn = () => JSON.stringify({ state: 'OPEN' });
  const result = autoCleanupWatch({ home: '/tmp/unused', pr: 4, plugin, gitFn: command, ghFn, knownMerged: false });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'not-merged');
  assert.ok(fs.existsSync(worktree), 'worktree 不应被删除');
});

test('autoCleanupWatch: worktree 不存在时只删本地分支（能删则删）', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-5');
  const result = autoCleanupWatch({ home: '/tmp/unused', pr: 5, plugin, gitFn: command, knownMerged: true });
  assert.equal(result.removed, true);
  assert.equal(result.note, 'worktree-missing');
  const branches = run(plugin, ['branch', '--list', 'watch/pr-5']);
  assert.equal(branches, '');
});

test('autoCleanupWatch: worktree 脏时不删除，只记录 dirty', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-6');
  const worktree = watchWorktreePath(plugin, 6);
  run(plugin, ['worktree', 'add', '-q', worktree, 'watch/pr-6']);
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'uncommitted\n');
  const result = autoCleanupWatch({ home: '/tmp/unused', pr: 6, plugin, gitFn: command, knownMerged: true });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'dirty');
  assert.ok(fs.existsSync(worktree), '脏 worktree 不应被删除');
  assert.ok(fs.existsSync(path.join(plugin, '.git')));
});

test('autoCleanupWatch: 干净且已并入 main 时直接删除，不生成备份', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-7');
  const worktree = watchWorktreePath(plugin, 7);
  run(plugin, ['worktree', 'add', '-q', worktree, 'watch/pr-7']);
  const result = autoCleanupWatch({ home: '/tmp/unused', pr: 7, plugin, gitFn: command, knownMerged: true });
  assert.equal(result.removed, true);
  assert.equal(result.backup, null);
  assert.equal(fs.existsSync(worktree), false);
  const branches = run(plugin, ['branch', '--list', 'watch/pr-7']);
  assert.equal(branches, '');
  assert.equal(fs.existsSync(path.join(plugin, '_backup')), false);
});

test('autoCleanupWatch: 干净但有未推送提交时先 bundle 备份再强制删除', (t) => {
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-8', { extraCommit: true });
  const worktree = watchWorktreePath(plugin, 8);
  run(plugin, ['worktree', 'add', '-q', worktree, 'watch/pr-8']);
  const result = autoCleanupWatch({ home: '/tmp/unused', pr: 8, plugin, gitFn: command, knownMerged: true });
  assert.equal(result.removed, true);
  assert.ok(result.backup && result.backup.bundlePath);
  assert.ok(fs.existsSync(result.backup.bundlePath), '应先生成 bundle 备份');
  const verify = run(plugin, ['bundle', 'verify', result.backup.bundlePath]);
  assert.match(verify, /records a complete history|is okay/);
  assert.equal(fs.existsSync(worktree), false);
  const branches = run(plugin, ['branch', '--list', 'watch/pr-8']);
  assert.equal(branches, '');
});

test('autoCleanupWatch: 异常时不抛出，转成 removed:false 记录', (t) => {
  // status --porcelain 检查（第 724 行）没有内层 try/catch 兜底，
  // 用它来触发真正会被外层 catch 捕获的异常，而不是被
  // worktree-missing / branch -d 那两处内层 try{}catch{} 悄悄吞掉。
  const { plugin } = initPluginRepo(t);
  createBranch(plugin, 'watch/pr-9');
  const worktree = watchWorktreePath(plugin, 9);
  run(plugin, ['worktree', 'add', '-q', worktree, 'watch/pr-9']);
  const throwingGitFn = (bin, args) => {
    if (args.includes('status') && args.includes('--porcelain')) throw new Error('boom');
    return command(bin, args);
  };
  const result = autoCleanupWatch({ home: '/tmp/unused', pr: 9, plugin, gitFn: throwingGitFn, knownMerged: true });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'error');
  assert.match(result.error, /boom/);
  assert.equal(result.worktree, worktree);
  assert.ok(fs.existsSync(worktree), '出错时不应删除 worktree');
});

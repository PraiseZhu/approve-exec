#!/usr/bin/env node
// wrapup-cleanup.mjs — 远端 PR 已 open 后只清本地 worktree/分支。不删远端。不用 cleanup-branch。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LedgerError } from './run-ledger.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;

export function parseWrapupArgs(argv) {
  const flags = { remote: 'origin' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new LedgerError('ARGS', `参数 --${key} 缺值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function git(args, { cwd, allowFailure = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFailure) {
    throw new LedgerError('PRECONDITION', `git ${args.join(' ')} 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

export function wrapupCleanup({ worktree, branch, remote = 'origin', gitRunner = git, now } = {}) {
  if (typeof worktree !== 'string' || !worktree.startsWith('/')) {
    throw new LedgerError('ARGS', `worktree 必须是绝对路径（当前: ${worktree}）`);
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new LedgerError('ARGS', 'branch 必须是非空字符串');
  }
  if (branch === 'main' || branch === 'master') {
    throw new LedgerError('PRECONDITION', `拒绝清理主分支 ${branch}`);
  }
  if (typeof now !== 'string' || now.length === 0) {
    throw new LedgerError('ARGS', 'now 必须是非空时间戳（--now；写入 cleanup-receipt.checked_at）');
  }
  const localSha = gitRunner(['rev-parse', 'HEAD'], { cwd: worktree });
  if (!SHA_RE.test(localSha)) {
    throw new LedgerError('PRECONDITION', `本地 HEAD 不是 40hex: ${localSha}`);
  }
  const remoteLine = gitRunner(['ls-remote', remote, branch], { cwd: worktree });
  const remoteSha = (remoteLine.split(/\s+/)[0] || '').trim();
  if (!SHA_RE.test(remoteSha)) {
    throw new LedgerError('PRECONDITION', `远端 ${remote}/${branch} 读不到 SHA（当前: ${remoteLine || '空'}）`);
  }
  if (remoteSha !== localSha) {
    return {
      ok: false,
      skipped: true,
      reason: `远端 SHA ${remoteSha} 对不上本地 ${localSha}，跳过删除`,
      branch,
      worktree,
      checked_at: now,
    };
  }
  const commonDir = gitRunner(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree });
  const mainRepo = commonDir.replace(/\/\.git$/, '');
  gitRunner(['worktree', 'remove', '--force', worktree], { cwd: mainRepo });
  gitRunner(['branch', '-D', branch], { cwd: mainRepo, allowFailure: true });
  return {
    ok: true,
    skipped: false,
    branch,
    worktree,
    sha: localSha,
    remoteDeleted: false,
    checked_at: now,
  };
}

function runCli(argv) {
  try {
    const flags = parseWrapupArgs(argv);
    const out = wrapupCleanup({
      worktree: flags.worktree,
      branch: flags.branch,
      remote: flags.remote ?? 'origin',
      now: flags.now,
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return out.ok ? 0 : 2;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`wrapup-cleanup: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`wrapup-cleanup: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`wrapup-cleanup: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}

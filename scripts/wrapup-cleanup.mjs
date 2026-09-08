#!/usr/bin/env node
// wrapup-cleanup.mjs — 远端 PR 已 open 后只清本地 worktree/分支。不删远端。不用 cleanup-branch。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LedgerError, latestGroupEvent, latestPrHandoffDelivery, parseTimestamp } from './run-ledger.mjs';

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

function requireStamp(value, name) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new LedgerError('ARGS', `${name} 必须是非负安全整数（当前: ${value}）`);
  }
  return n;
}

function parseWorktrees(value) {
  const rows = [];
  let row = null;
  for (const line of value.split('\n')) {
    if (line === '') { if (row) rows.push(row); row = null; continue; }
    const i = line.indexOf(' ');
    if (i < 0) continue;
    row ??= {};
    row[line.slice(0, i)] = line.slice(i + 1);
  }
  if (row) rows.push(row);
  return rows;
}

function ghPr({ repo, branch, ghBin = process.env.GH_BIN ?? 'gh', runner = spawnSync }) {
  const result = runner(ghBin, ['pr', 'view', branch, '--repo', repo, '--json', 'state,isDraft,headRefOid,headRepositoryOwner,headRepository'], { encoding: 'utf8' });
  if (result.status !== 0) throw new LedgerError('PRECONDITION', `gh pr view 失败: ${(result.stderr || result.stdout || '').trim()}`);
  return JSON.parse(result.stdout);
}

function assertDeliveredEvidence({ delivery, branch, localSha, ledgerPath, group, repo, ghBin }) {
  if (repo !== 'xindong/mivo-canvas-plugin') throw new LedgerError('PRECONDITION', 'delivered-local-only 仅允许指定 Mivo 仓库');
  if (typeof ledgerPath !== 'string' || typeof group !== 'string') throw new LedgerError('ARGS', 'newmode 必须提供 --ledger 与 --group');
  let ledger;
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch (err) { throw new LedgerError('PRECONDITION', `无法读取 ledger: ${err.message}`); }
  const groups = ledger.waves?.flatMap((wave) => wave.groups ?? []) ?? [];
  const record = groups.find((item) => item.group_id === group);
  const deliveryEvidence = latestPrHandoffDelivery(ledger, group);
  const prEvent = latestGroupEvent(ledger, group, 'pr_ready');
  let prReceipt;
  try { prReceipt = prEvent?.detail?.receipt ? JSON.parse(readFileSync(prEvent.detail.receipt, 'utf8')) : null; } catch (err) { throw new LedgerError('PRECONDITION', `无法读取 PR receipt: ${err.message}`); }
  const e2e = deliveryEvidence?.e2e;
  if (!record || !['pr-open', 'local-cleaned'].includes(record.state) || record.tip_sha !== localSha || e2e?.status !== 'pass' || e2e.candidate_sha !== localSha || deliveryEvidence?.tip_sha !== localSha || !prReceipt || prReceipt.branch !== branch || prReceipt.headRefOid !== localSha || prReceipt.isDraft !== false || prReceipt.state !== 'OPEN') {
    throw new LedgerError('PRECONDITION', 'ledger 未证明本组同一提交已通过 e2e 且已建立 PR 回执');
  }
  const pr = ghPr({ repo, branch, ghBin });
  if (pr.state !== 'OPEN' || pr.isDraft !== false || pr.headRefOid !== localSha || pr.headRepositoryOwner?.login !== 'xindong' || pr.headRepository?.name !== 'mivo-canvas-plugin') throw new LedgerError('PRECONDITION', '实时 PR 已漂移、关闭、draft 或仓库不匹配');
  if (delivery !== undefined) throw new LedgerError('PRECONDITION', 'newmode 不接受调用者 delivery 证据');
}

export function wrapupCleanup({ worktree, branch, remote = 'origin', gitRunner = git, now, ledgerVersion, assignmentSeq, mode, delivery, ledgerPath, group, repo, ghBin } = {}) {
  if (typeof worktree !== 'string' || !worktree.startsWith('/')) {
    throw new LedgerError('ARGS', `worktree 必须是绝对路径（当前: ${worktree}）`);
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new LedgerError('ARGS', 'branch 必须是非空字符串');
  }
  if (branch === 'main' || branch === 'master') {
    throw new LedgerError('PRECONDITION', `拒绝清理主分支 ${branch}`);
  }
  parseTimestamp(now, 'wrapup-cleanup --now');
  const version = requireStamp(ledgerVersion, 'ledger-version');
  const seq = requireStamp(assignmentSeq, 'assignment-seq');
  if (mode === 'delivered-local-only') {
    if (delivery !== undefined) throw new LedgerError('PRECONDITION', 'newmode 不接受调用者 delivery 证据');
  } else if (mode !== undefined) throw new LedgerError('ARGS', `不支持的 wrapup mode: ${mode}`);
  const currentBranch = gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
  if (currentBranch !== branch) {
    throw new LedgerError('PRECONDITION', `worktree 当前分支 ${currentBranch} 对不上 ${branch}`);
  }
  const porcelain = gitRunner(['status', '--porcelain'], { cwd: worktree });
  if (porcelain.length > 0) {
    throw new LedgerError('PRECONDITION', `worktree dirty，拒绝清理（${porcelain.split('\n')[0]}）`);
  }
  const localSha = gitRunner(['rev-parse', 'HEAD'], { cwd: worktree });
  if (!SHA_RE.test(localSha)) {
    throw new LedgerError('PRECONDITION', `本地 HEAD 不是 40hex: ${localSha}`);
  }
  if (mode === 'delivered-local-only') assertDeliveredEvidence({ delivery, branch, localSha, ledgerPath, group, repo, ghBin });
  let mainRepo;
  if (mode === 'delivered-local-only') {
    const commonDir = gitRunner(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree });
    mainRepo = commonDir.replace(/\/\.git$/, '');
    const realWorktree = realpathSync(worktree);
    const trees = parseWorktrees(gitRunner(['worktree', 'list', '--porcelain'], { cwd: mainRepo }));
    const tree = trees.find((item) => item.worktree && realpathSync(item.worktree) === realWorktree);
    if (!tree || tree.branch !== `refs/heads/${branch}` || tree.HEAD !== localSha || realWorktree === realpathSync(mainRepo)) throw new LedgerError('PRECONDITION', '目标不是该仓库的独立非主 worktree');
    if (gitRunner(['status', '--porcelain', '--ignored'], { cwd: worktree }).length > 0) throw new LedgerError('PRECONDITION', '存在未跟踪或 ignored 内容，拒绝删除');
    if (existsSync(`${realWorktree}/.keep`) || existsSync(`${realWorktree}/.cleanup.lock`) || tree.locked !== undefined) throw new LedgerError('PRECONDITION', 'worktree 被 keep/lock 占用');
  } else {
    const commonDir = gitRunner(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: worktree });
    mainRepo = commonDir.replace(/\/\.git$/, '');
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
      ledger_version: version,
      assignment_seq: seq,
    };
  }
  const finalBranch = gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
  const finalSha = gitRunner(['rev-parse', 'HEAD'], { cwd: worktree });
  const finalStatus = gitRunner(['status', '--porcelain'], { cwd: worktree });
  const finalRemoteLine = gitRunner(['ls-remote', remote, `refs/heads/${branch}`], { cwd: worktree });
  const finalRemoteSha = (finalRemoteLine.split(/\s+/)[0] || '').trim();
  if (finalBranch !== branch || finalSha !== localSha || finalStatus.length > 0 || finalRemoteSha !== remoteSha) throw new LedgerError('PRECONDITION', '删除前末刻复核失败，保留本地内容');
  if (mode === 'delivered-local-only') {
    gitRunner(['update-ref', '-d', `refs/heads/${branch}`, localSha], { cwd: mainRepo });
    try {
      gitRunner(['worktree', 'remove', worktree], { cwd: mainRepo });
    } catch (error) {
      try { gitRunner(['update-ref', `refs/heads/${branch}`, localSha], { cwd: mainRepo }); } catch (rollbackError) {
        throw new LedgerError('PRECONDITION', `清理半失败且本地分支恢复失败: ${rollbackError.message}`);
      }
      throw error;
    }
  } else {
    gitRunner(['worktree', 'remove', worktree], { cwd: mainRepo });
    gitRunner(['branch', '-D', branch], { cwd: mainRepo });
  }
  const remainingTrees = gitRunner(['worktree', 'list', '--porcelain'], { cwd: mainRepo });
  if (remainingTrees.split('\n').some((line) => line === `worktree ${worktree}`)) {
    throw new LedgerError('PRECONDITION', `worktree 删除后仍在 git worktree list：${worktree}`);
  }
  const remainingBranch = gitRunner(['branch', '--list', branch], { cwd: mainRepo });
  if (remainingBranch.length > 0) {
    throw new LedgerError('PRECONDITION', `本地分支删除后仍在：${remainingBranch}`);
  }
  if (existsSync(worktree)) {
    throw new LedgerError('PRECONDITION', `worktree 路径删除后仍存在：${worktree}`);
  }
  return {
    ok: true,
    skipped: false,
    branch,
    worktree,
    sha: localSha,
    remoteDeleted: false,
    checked_at: now,
    ledger_version: version,
    assignment_seq: seq,
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
      ledgerVersion: flags['ledger-version'],
      assignmentSeq: flags['assignment-seq'],
      mode: flags.mode,
      ledgerPath: flags.ledger,
      group: flags.group,
      repo: flags.repo,
      ghBin: flags['gh-bin'],
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

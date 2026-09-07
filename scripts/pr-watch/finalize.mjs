#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hashObject, isMain, nowIso, parseArgs, readJson, writeJsonAtomic } from '../lib/common.mjs';
import { stateFileName } from './register.mjs';
import { assertLeadSignalShape } from './lead-signal.mjs';
import { urlMatchesRepo } from '../lib/git-checks.mjs';

export const FINALIZE_ENTRY = '/Users/praise/AI-Agent/Claude/capabilities/source/approve-exec-src/scripts/pr-watch/finalize.mjs';
const SHA_RE = /^[a-f0-9]{40}$/;
const DISPATCH_RE = /^[a-f0-9]{24}$/;

export function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function reject(message) {
  const error = new Error(message);
  error.code = 'FINALIZE_REJECTED';
  throw error;
}

function stringValue(value, label, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) reject(label + ' 非法');
  return value;
}

function sha(value, label) {
  const normalized = stringValue(value, label, 40).toLowerCase();
  if (!SHA_RE.test(normalized)) reject(label + ' 必须是 40 位十六进制 SHA');
  return normalized;
}

function dispatch(value) {
  const normalized = stringValue(value, 'dispatch_id', 24).toLowerCase();
  if (!DISPATCH_RE.test(normalized)) reject('dispatch_id 必须是 24 位小写十六进制');
  return normalized;
}

function prNumber(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  reject('pr 必须是无前导零的安全正整数');
}

function absolutePath(value, label) {
  const path = stringValue(value, label, 4096);
  if (!isAbsolute(path)) reject(label + ' 必须是绝对路径');
  return path;
}

function jsonFile(path, label) {
  try { return readJson(path); }
  catch (error) { reject(label + ' 读取失败（fail-closed）: ' + error.message); }
}

function exec(runner, file, args) {
  try {
    const result = runner(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return Buffer.isBuffer(result) ? result.toString('utf8').trim() : String(result ?? '').trim();
  } catch (error) {
    reject(file + ' ' + args.join(' ') + ' 执行失败（fail-closed）: ' + error.message);
  }
}

function samePath(left, right) {
  try { return realpathSync(left) === realpathSync(right); }
  catch { return left === right; }
}

function repoName(owner, repo) {
  stringValue(owner, 'owner', 39);
  stringValue(repo, 'repo', 100);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) reject('owner 非法');
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo.includes('..') || repo.endsWith('.git') || repo.endsWith('.')) reject('repo 非法');
  return owner + '/' + repo;
}

function fullRepoName(value, label) {
  if (typeof value !== 'string' || value.split('/').length !== 2) reject(label + ' 必须是单一 owner/repo');
  const parts = value.split('/');
  return repoName(parts[0], parts[1]);
}

function checkBranch(runner, branch) {
  stringValue(branch, 'branch', 255);
  if (/^[-+]/.test(branch) || branch === '@' || branch.includes('..') || branch.endsWith('/')) reject('branch 非法');
  exec(runner, 'git', ['check-ref-format', '--branch', branch]);
}

function checkRemote(runner, remote) {
  stringValue(remote, 'push_remote', 255);
  if (/^[-+]/.test(remote)) reject('push_remote 非法');
  exec(runner, 'git', ['check-ref-format', 'refs/remotes/' + remote + '/HEAD']);
}

function exactIds(ids, expected) {
  return Array.isArray(ids) && ids.length === expected.length && new Set(ids).size === ids.length
    && ids.every((id, index) => typeof id === 'string' && id === expected[index]);
}

function idsOf(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) reject(label + ' 缺少非空数组');
  const ids = entries.map((entry) => stringValue(entry?.id, label + '.id', 256));
  if (new Set(ids).size !== ids.length) reject(label + ' 存在重复 id');
  return ids;
}

function evidenceOf(value, label) {
  if (!Array.isArray(value) || value.length === 0) reject(label + ' evidence 必须非空');
  const validValue = (item, depth = 0) => {
    if (depth > 8) return false;
    if (typeof item === 'string') return item.trim().length > 0 && item.length <= 4096 && !/[\0\r\n]/.test(item);
    if (typeof item === 'number' || typeof item === 'boolean') return Number.isFinite(item) || typeof item === 'boolean';
    if (Array.isArray(item)) return item.length > 0 && item.every((entry) => validValue(entry, depth + 1));
    if (!item || typeof item !== 'object') return false;
    return Object.entries(item).length > 0
      && Object.entries(item).every(([key, entry]) => key.trim().length > 0 && validValue(entry, depth + 1));
  };
  if (!value.every((item) => validValue(item))) reject(label + ' evidence 含空值或不安全摘要');
  return value;
}

function stateContext(options, runner) {
  const stateDir = absolutePath(options.stateDir, 'stateDir');
  if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) reject('stateDir 不存在或不是目录');
  const owner = stringValue(options.owner, 'owner', 39);
  const repo = stringValue(options.repo, 'repo', 100);
  const pr = prNumber(options.pr ?? options.prNumber);
  const sessionId = stringValue(options.sessionId, 'session_id', 256);
  const dispatchId = dispatch(options.dispatchId);
  const prRepo = repoName(owner, repo);
  const statePath = join(stateDir, stateFileName(owner, repo, pr));
  if (!existsSync(statePath)) reject('state 不存在');
  const state = jsonFile(statePath, 'state');
  assertLeadSignalShape(state?.lead_signal);
  if (state.lead_signal.repository !== prRepo || state.lead_signal.pr_number !== pr || state.lead_signal.branch !== state.branch) {
    reject('lead signal 未授权当前 PR/branch');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) reject('state 不是对象');
  if (state.owner?.toLowerCase() !== owner.toLowerCase() || state.repo?.toLowerCase() !== repo.toLowerCase()
    || Number(state.pr_number) !== pr || state.session_id !== sessionId) reject('state identity/session 不一致');
  if (!Object.prototype.hasOwnProperty.call(state, 'push_repo') || (state.push_repo !== null && typeof state.push_repo !== 'string')) reject('state.push_repo 缺失或类型非法');
  const pushRepo = fullRepoName(state.push_repo ?? prRepo, 'state.push_repo');
  checkBranch(runner, state.branch);
  checkRemote(runner, state.push_remote);
  const worktree = state.worktree;
  if (!worktree || typeof worktree !== 'object' || Array.isArray(worktree)) reject('state 缺 worktree');
  const worktreePath = absolutePath(worktree.path, 'state.worktree.path');
  if (!existsSync(worktreePath) || !statSync(worktreePath).isDirectory()) reject('worktree 不存在或不是目录');
  if (worktree.session_id !== sessionId || worktree.branch !== state.branch || worktree.push_remote !== state.push_remote || worktree.push_repo !== pushRepo) reject('worktree 未绑定同一 session/PR/branch/remote/repo');
  for (const [key, expected] of [['owner', owner], ['repo', repo], ['pr_number', pr], ['dispatch_id', dispatchId]]) {
    if (worktree[key] !== undefined && String(worktree[key]).toLowerCase() !== String(expected).toLowerCase()) reject('worktree.' + key + ' 绑定不一致');
  }
  const pendingItems = Array.isArray(state.post_fix_pending) ? state.post_fix_pending : [];
  const pending = pendingItems.find((item) => item?.dispatch_id === dispatchId);
  if (!pending || pending.session_id !== sessionId || pending.dispatch_id !== dispatchId) reject('state 缺本次 post_fix_pending 绑定');
  const baseHead = sha(pending.base_head_sha, 'base_head_sha');
  const sourcePath = join(stateDir, 'receipts', dispatchId + '.json');
  const postFixPath = join(stateDir, 'receipts', dispatchId + '.post-fix.json');
  if (typeof pending.source_sc_path !== 'string' || !samePath(pending.source_sc_path, sourcePath)) reject('source_sc_path 未绑定固定 ack receipt');
  if (typeof pending.post_fix_receipt_path !== 'string' || !samePath(pending.post_fix_receipt_path, postFixPath)) reject('post_fix_receipt_path 未绑定固定输出路径');
  if (!existsSync(pending.source_sc_path)) reject('source SC receipt 不存在');
  const source = jsonFile(pending.source_sc_path, 'source SC receipt');
  if (source.dispatch_id !== dispatchId || source.session_id !== sessionId || sha(source.head_sha, 'source.head_sha') !== baseHead) reject('source receipt identity/base head 不一致');
  const sourceIds = idsOf(source.scs, 'source.scs');
  if (!exactIds(sourceIds, pending.feedback_ids)) reject('source SC 集合与 feedback_ids 不精确对应');
  const badVerify = source.scs.findIndex((entry) => typeof entry.verify !== 'string' || entry.verify.trim().length === 0);
  if (badVerify !== -1) reject('source.scs[' + badVerify + '] 缺非空 verify');
  const sourceDigest = hashObject(source);
  if (pending.source_sc_digest !== sourceDigest) reject('source_sc_digest 不匹配 source receipt');
  return { stateDir, owner, repo, pr, prRepo, sessionId, dispatchId, statePath, state, worktreePath, branch: state.branch, pushRemote: state.push_remote, pushRepo, pending, baseHead, sourcePath, postFixPath, source, sourceIds, sourceDigest };
}

function completionReceipt(options, source) {
  if (options.receipt && typeof options.receipt === 'object' && !Array.isArray(options.receipt)) return options.receipt;
  let path = options.receiptPath ?? options.receipt;
  if (typeof path === 'string' && path.startsWith('@')) path = path.slice(1);
  if (path === undefined) return source;
  return jsonFile(absolutePath(path, 'receipt'), 'completion receipt');
}

function remoteHead(output, branch) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) reject('远程 branch 不存在');
  if (lines.length === 1 && SHA_RE.test(lines[0])) return lines[0];
  if (lines.length !== 1) reject('远程 head 返回不唯一');
  const parts = lines[0].split(/\s+/);
  if (parts[1] !== 'refs/heads/' + branch) reject('远程 head 分支不一致');
  return sha(parts[0], 'remote head');
}

function gitSnapshot(context, runner) {
  const head = sha(exec(runner, 'git', ['-C', context.worktreePath, 'rev-parse', 'HEAD']), 'local HEAD');
  const branch = exec(runner, 'git', ['-C', context.worktreePath, 'branch', '--show-current']);
  if (branch !== context.branch) reject('current branch 与 state.branch 不一致');
  if (exec(runner, 'git', ['-C', context.worktreePath, 'status', '--porcelain', '--untracked-files=all']) !== '') reject('worktree dirty');
  const remotes = exec(runner, 'git', ['-C', context.worktreePath, 'remote']).split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(context.pushRemote)) reject('push remote 未配置');
  const urls = exec(runner, 'git', ['-C', context.worktreePath, 'remote', 'get-url', '--push', '--all', '--', context.pushRemote]).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (urls.length === 0 || urls.some((url) => !urlMatchesRepo(url, context.pushRepo))) reject('push URL 与 push_repo 不一致');
  const remote = remoteHead(exec(runner, 'git', ['-C', context.worktreePath, 'ls-remote', '--heads', context.pushRemote, 'refs/heads/' + context.branch]), context.branch);
  return { head, branch, clean: true, push_remote: context.pushRemote, push_repo: context.pushRepo, push_urls: urls, remote_head: remote };
}

function ghSnapshot(context, runner) {
  const output = exec(runner, 'gh', ['pr', 'view', String(context.pr), '--repo', context.prRepo, '--json', 'state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner']);
  let raw;
  try { raw = JSON.parse(output); } catch (error) { reject('gh pr view 非 JSON: ' + error.message); }
  const headRepository = raw?.headRepository?.nameWithOwner ?? raw?.headRepository?.fullName ?? raw?.headRepository?.full_name;
  const headOwner = raw?.headRepositoryOwner?.login ?? raw?.headRepositoryOwner?.name ?? raw?.headRepositoryOwner;
  if (raw?.state !== 'OPEN' || raw?.isDraft !== false || raw?.headRefName !== context.branch) reject('PR 必须是 OPEN、非 draft 且 branch 一致');
  if (typeof headRepository !== 'string' || headRepository.toLowerCase() !== context.pushRepo.toLowerCase()) reject('PR headRepository 与 push_repo 不一致');
  if (typeof headOwner !== 'string' || headOwner.toLowerCase() !== context.pushRepo.split('/')[0].toLowerCase()) reject('PR headRepositoryOwner 与 push_repo 不一致');
  return { state: 'OPEN', isDraft: false, headRefName: context.branch, headRefOid: sha(raw.headRefOid, 'gh headRefOid'), headRepository, headRepositoryOwner: headOwner };
}

function completionScs(completion, context, candidateHead) {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) reject('completion receipt 不是对象');
  if (completion.dispatch_id !== context.dispatchId || completion.session_id !== context.sessionId) reject('completion dispatch/session 不一致');
  if (completion.base_head_sha !== undefined && sha(completion.base_head_sha, 'completion.base_head_sha') !== context.baseHead) reject('completion base_head_sha 不一致');
  const reportedHead = completion.artifact_head_sha ?? completion.candidate_head_sha ?? completion.head_sha;
  if (reportedHead === undefined || sha(reportedHead, 'completion head') !== candidateHead) reject('completion head 未绑定真实 HEAD');
  if (completion.no_changes !== undefined && completion.no_changes !== (candidateHead === context.baseHead)) reject('completion no_changes 不一致');
  if (completion.empty_commit === true) reject('禁止空 commit');
  const ids = idsOf(completion.scs, 'completion.scs');
  if (!exactIds(ids, context.sourceIds)) reject('completion SC 集合不精确对应 source receipt');
  return completion.scs.map((entry, index) => {
    if (String(entry.status ?? '').toUpperCase() !== 'PASS') reject('completion.scs[' + index + '] 不是 PASS');
    return { id: context.sourceIds[index], status: 'pass', evidence: evidenceOf(entry.evidence, 'completion.scs[' + index + ']') };
  });
}

function validateStored(receipt, context, candidateHead) {
  if (!receipt || receipt.finalizer_entry !== FINALIZE_ENTRY || receipt.dispatch_id !== context.dispatchId || receipt.session_id !== context.sessionId
    || sha(receipt.base_head_sha, 'stored base_head_sha') !== context.baseHead || sha(receipt.artifact_head_sha, 'stored artifact_head_sha') !== candidateHead
    || sha(receipt.head_sha, 'stored head_sha') !== candidateHead || receipt.no_changes !== (candidateHead === context.baseHead)
    || receipt.status !== 'pass' || receipt.sc_digest !== context.sourceDigest || receipt.empty_commit === true) reject('已有 post-fix receipt 不符合当前绑定');
  const ids = idsOf(receipt.scs, 'stored.scs');
  if (!exactIds(ids, context.sourceIds)) reject('已有 post-fix receipt SC 集合不一致');
  receipt.scs.forEach((entry, index) => {
    if (entry.status !== 'pass') reject('已有 post-fix receipt.scs[' + index + '] 状态不一致');
    evidenceOf(entry.evidence, 'stored.scs[' + index + ']');
  });
  return receipt;
}

export function validate(options = {}) {
  const runner = options.run ?? run;
  const context = stateContext(options, runner);
  const feedbackHead = options.feedbackHead === undefined ? context.baseHead : sha(options.feedbackHead, 'feedback-head');
  if (feedbackHead !== context.baseHead) reject('feedback-head 与 pending.base_head_sha 不一致');
  const completion = completionReceipt(options, context.source);
  const gitBefore = gitSnapshot(context, runner);
  const candidateHead = gitBefore.head;
  if (options.candidateHead !== undefined && sha(options.candidateHead, 'candidate-head') !== candidateHead) reject('candidate-head 不是真实 local HEAD');
  if (candidateHead !== context.baseHead) exec(runner, 'git', ['-C', context.worktreePath, 'merge-base', '--is-ancestor', context.baseHead, candidateHead]);
  const scs = completionScs(completion, context, candidateHead);
  const ghBefore = ghSnapshot(context, runner);
  if (ghBefore.headRefOid !== gitBefore.remote_head || (ghBefore.headRefOid !== context.baseHead && ghBefore.headRefOid !== candidateHead)) reject('gh before head 与远程/base/candidate 不一致');
  return { ...context, runner, completion, feedbackHead, gitBefore, candidateHead, scs, ghBefore };
}

export function finalize(options = {}) {
  const context = validate(options);
  if (existsSync(context.postFixPath)) return { ok: true, idempotent: true, pushed: false, receiptPath: context.postFixPath, receipt: validateStored(jsonFile(context.postFixPath, 'post-fix receipt'), context, context.candidateHead) };
  if (context.gitBefore.remote_head !== context.baseHead && context.gitBefore.remote_head !== context.candidateHead) reject('push 前远程 head 不匹配 base/candidate');
  const shouldPush = context.gitBefore.remote_head === context.baseHead && context.candidateHead !== context.baseHead;
  const pushRef = 'HEAD:refs/heads/' + context.branch;
  const pushCommand = ['git', '-C', context.worktreePath, 'push', context.pushRemote, pushRef];
  if (shouldPush) exec(context.runner, 'git', pushCommand.slice(1));
  const gitAfter = gitSnapshot(context, context.runner);
  if (gitAfter.head !== context.candidateHead || gitAfter.remote_head !== context.candidateHead) reject('push 后 local/remote head 不是 candidate');
  const ghAfter = ghSnapshot(context, context.runner);
  if (ghAfter.headRefOid !== context.candidateHead) reject('push 后 gh head 不是 candidate');
  const receipt = {
    schema_version: 'post-fix.v1',
    created_at: nowIso(),
    finalizer_entry: FINALIZE_ENTRY,
    state_dir: context.stateDir,
    owner: context.owner,
    repo: context.repo,
    pr: context.pr,
    dispatch_id: context.dispatchId,
    session_id: context.sessionId,
    base_head_sha: context.baseHead,
    artifact_head_sha: context.candidateHead,
    candidate_head_sha: context.candidateHead,
    head_sha: context.candidateHead,
    no_changes: context.candidateHead === context.baseHead,
    status: 'pass',
    empty_commit: false,
    sc_digest: context.sourceDigest,
    source_sc_digest: context.sourceDigest,
    scs: context.scs,
    git: { before: context.gitBefore, after: gitAfter },
    gh: { before: context.ghBefore, after: ghAfter },
    push: { executed: shouldPush, command: pushCommand, remote: context.pushRemote, branch: context.branch, ref: pushRef, force: false },
  };
  writeJsonAtomic(context.postFixPath, receipt);
  return { ok: true, idempotent: false, pushed: shouldPush, receiptPath: context.postFixPath, receipt };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args['session-id'] || !args['dispatch-id'] || !args.receipt) reject('CLI 缺 state/identity/receipt 参数');
    const result = finalize({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo, pr: args.pr, sessionId: args['session-id'], dispatchId: args['dispatch-id'], feedbackHead: args['feedback-head'], candidateHead: args['candidate-head'], receipt: args.receipt });
    process.stdout.write(JSON.stringify({ ok: result.ok, idempotent: result.idempotent, pushed: result.pushed, receipt_path: result.receiptPath }) + '\n');
  } catch (error) {
    process.stderr.write('[FAIL] ' + error.message + '\n');
    process.exitCode = 2;
  }
}

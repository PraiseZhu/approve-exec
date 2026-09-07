#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, writeJsonAtomic, isMain, parseArgs } from '../lib/common.mjs';
import { withLock } from '../lib/state-lock.mjs';
import { stateFileName, identityMatches } from './register.mjs';
import {
  validateBranchName,
  validateRemoteName,
  validateRepoFullName,
  urlMatchesRepo,
} from '../lib/git-checks.mjs';

function splitLines(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function assertPushRemote(command, repoDir, pushRemote, repository) {
  const remotes = splitLines(command('git', ['-C', repoDir, 'remote']));
  if (!remotes.includes(pushRemote)) {
    throw new Error('worktree 缺少注册的 push remote「' + pushRemote + '」');
  }
  let urls;
  try {
    urls = splitLines(command('git', ['-C', repoDir, 'remote', 'get-url', '--push', '--all', '--', pushRemote]));
  } catch (error) {
    throw new Error('push remote「' + pushRemote + '」URL 读取失败: ' + error.message);
  }
  if (urls.length === 0 || urls.some((url) => !urlMatchesRepo(url, repository))) {
    throw new Error('push remote「' + pushRemote + '」未绑定 ' + repository + '，拒绝推送到错误仓库');
  }
}

function ensurePushRemote(command, clone, pushRemote) {
  const remotes = splitLines(command('git', ['-C', clone, 'remote']));
  if (remotes.includes(pushRemote)) return;
  if (pushRemote !== 'origin' && remotes.includes('origin')) {
    command('git', ['-C', clone, 'remote', 'rename', 'origin', pushRemote]);
    return;
  }
  throw new Error('Mini clone 缺少注册的 push remote「' + pushRemote + '」');
}

function fetchPendingHead(command, clone, pushRemote, branch, expectedHead) {
  command('git', ['-C', clone, 'fetch', pushRemote, 'refs/heads/' + branch]);
  const fetched = command('git', ['-C', clone, 'rev-parse', 'FETCH_HEAD']).toLowerCase();
  if (fetched !== expectedHead) throw new Error('PR head 已变化，重新取快照后再准备 worktree');
  return fetched;
}

function assertFastForward(command, worktree, actualHead, expectedHead) {
  try {
    command('git', ['-C', worktree, 'merge-base', '--is-ancestor', actualHead, expectedHead]);
  } catch {
    throw new Error('待处理 head 不是当前 worktree HEAD 的快进后继，拒绝覆盖旧分支');
  }
}

export function prepareWorktree({ stateDir, owner, repo, prNumber, sessionId, headSha, run = execFileSync }) {
  const stateFile = join(stateDir, stateFileName(owner, repo, prNumber));
  return withLock(stateFile + '.lock', () => {
    const state = readJson(stateFile);
    if (!identityMatches(state, owner, repo, prNumber) || !sessionId || state.session_id !== sessionId) {
      throw new Error('Mini session 尚未绑定本 PR，拒绝准备 worktree');
    }
    if (!state.lead_signal?.signal_id || !state.lead_signal.owner_title || !/^[a-f0-9]{40}$/i.test(headSha ?? '')) {
      throw new Error('缺 lead 授权或本轮反馈 head');
    }
    const expectedHead = String(headSha).toLowerCase();
    const observedHead = state.pending_dispatch?.head_sha ?? state.cloud_head_sha ?? state.lead_signal.head_sha;
    if (observedHead?.toLowerCase() !== expectedHead) {
      throw new Error('反馈 head 已变化或未绑定本轮，拒绝准备 worktree');
    }
    if (validateBranchName(state.branch).length) throw new Error('PR branch 非法');
    if (typeof state.push_remote !== 'string' || state.push_remote.length === 0) {
      throw new Error('注册缺 push_remote，拒绝准备 worktree');
    }
    if (validateRemoteName(state.push_remote).length) throw new Error('PR push remote 非法');
    if (state.push_repo !== undefined && state.push_repo !== null && typeof state.push_repo !== 'string') {
      throw new Error('注册 push_repo 非法');
    }
    if (state.push_remote !== 'origin' && !state.push_repo) {
      throw new Error('非 origin push remote 必须绑定 push_repo，拒绝推送到上游');
    }
    const repository = state.push_repo ?? (state.owner + '/' + state.repo);
    if (validateRepoFullName(repository).length) throw new Error('PR push repository 非法');
    const pushRemote = state.push_remote;
    const root = dirname(realpathSync(stateDir));
    const clone = join(root, 'repos', repository);
    const worktree = join(root, 'worktrees', stateFileName(owner, repo, prNumber).replace(/\.json$/, ''));
    const command = (bin, args) => String(run(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    mkdirSync(dirname(clone), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(worktree), { recursive: true, mode: 0o700 });
    if (!existsSync(clone)) command('gh', ['repo', 'clone', repository, clone, '--', '--no-checkout']);
    ensurePushRemote(command, clone, pushRemote);
    assertPushRemote(command, clone, pushRemote, repository);
    if (existsSync(worktree)) {
      if (state.worktree?.path !== worktree || state.worktree.session_id !== sessionId
        || state.worktree.clone !== clone || state.worktree.branch !== state.branch
        || state.worktree.push_remote !== pushRemote || state.worktree.push_repo !== repository) {
        throw new Error('已有 worktree 接线不属于此 Mini session');
      }
      const branch = command('git', ['-C', worktree, 'branch', '--show-current']);
      if (branch !== state.branch) throw new Error('已有 worktree branch 变化，禁止 reset');
      assertPushRemote(command, worktree, pushRemote, repository);
      const actualHead = command('git', ['-C', worktree, 'rev-parse', 'HEAD']).toLowerCase();
      if (actualHead === expectedHead) {
        const binding = { ...state.worktree, base_sha: expectedHead };
        writeJsonAtomic(stateFile, { ...state, worktree: binding });
        return { ...binding, resumed: true };
      }
      const status = command('git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all']);
      if (status !== '') throw new Error('已有 worktree dirty，拒绝覆盖或快进旧分支');
      fetchPendingHead(command, clone, pushRemote, state.branch, expectedHead);
      assertFastForward(command, worktree, actualHead, expectedHead);
      command('git', ['-C', worktree, 'merge', '--ff-only', expectedHead]);
      const updatedHead = command('git', ['-C', worktree, 'rev-parse', 'HEAD']).toLowerCase();
      if (updatedHead !== expectedHead) throw new Error('worktree 快进后 HEAD 与待处理 head 不一致');
      const binding = { ...state.worktree, base_sha: expectedHead };
      writeJsonAtomic(stateFile, { ...state, worktree: binding });
      return { ...binding, resumed: true, fast_forwarded: true };
    }
    const fetched = fetchPendingHead(command, clone, pushRemote, state.branch, expectedHead);
    command('git', ['-C', clone, 'worktree', 'add', '-b', state.branch, worktree, fetched]);
    assertPushRemote(command, worktree, pushRemote, repository);
    const actualHead = command('git', ['-C', worktree, 'rev-parse', 'HEAD']).toLowerCase();
    if (actualHead !== expectedHead) throw new Error('新建 worktree HEAD 与待处理 head 不一致');
    const binding = { path: worktree, clone, session_id: sessionId, branch: state.branch, push_remote: pushRemote, push_repo: repository, base_sha: fetched };
    writeJsonAtomic(stateFile, { ...state, worktree: binding });
    return { ...binding, resumed: false };
  });
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(prepareWorktree({ stateDir: args['state-dir'], owner: args.owner, repo: args.repo,
      prNumber: args.pr, sessionId: args['session-id'], headSha: args.head })));
  } catch (error) {
    console.error('prepare-worktree: ' + error.message);
    process.exitCode = 2;
  }
}

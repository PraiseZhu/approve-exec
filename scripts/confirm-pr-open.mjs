#!/usr/bin/env node
// confirm-pr-open.mjs — 验收后确认远端 ready PR 已存在（零 LLM）。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LedgerError } from './run-ledger.mjs';

const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function parseConfirmArgs(argv) {
  const flags = {};
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

export function assertReadyPr({ url, state, isDraft, headRefOid, expectedHead, branch, checkedAt }) {
  if (typeof url !== 'string' || !GITHUB_PR_URL_RE.test(url)) {
    throw new LedgerError('PRECONDITION', `PR URL 非法（当前: ${url ?? '缺失'}）`);
  }
  if (state !== 'OPEN') {
    throw new LedgerError('PRECONDITION', `PR 不是 OPEN（当前: ${state}）`);
  }
  if (isDraft === true) {
    throw new LedgerError('PRECONDITION', 'PR 仍是 draft，验收后必须是 ready');
  }
  if (typeof expectedHead === 'string' && SHA_RE.test(expectedHead) && headRefOid !== expectedHead) {
    throw new LedgerError('PRECONDITION', `PR head ${headRefOid} 对不上本地 ${expectedHead}`);
  }
  const out = { url, number: Number(url.match(/\/pull\/(\d+)/)[1]), headRefOid, isDraft: false, state };
  if (typeof branch === 'string' && branch.length > 0) out.branch = branch;
  if (typeof checkedAt === 'string' && checkedAt.length > 0) out.checked_at = checkedAt;
  return out;
}

function runGh(repo, branch, ghBin = process.env.GH_BIN ?? 'gh') {
  const r = spawnSync(ghBin, [
    'pr', 'view', branch, '--repo', repo, '--json', 'url,state,headRefOid,isDraft,number',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new LedgerError('PRECONDITION', `gh pr view 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return JSON.parse(r.stdout);
}

export function confirmPrOpen({ repo, branch, head, ghBin, now } = {}) {
  if (typeof repo !== 'string' || !repo.includes('/')) {
    throw new LedgerError('ARGS', `repo 必须是 owner/name（当前: ${repo}）`);
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new LedgerError('ARGS', 'branch 必须是非空字符串');
  }
  if (typeof now !== 'string' || now.length === 0) {
    throw new LedgerError('ARGS', 'now 必须是非空时间戳（--now；写入 pr-open-receipt.checked_at）');
  }
  const raw = runGh(repo, branch, ghBin);
  return assertReadyPr({
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    headRefOid: raw.headRefOid,
    expectedHead: head,
    branch,
    checkedAt: now,
  });
}

function runCli(argv) {
  try {
    const flags = parseConfirmArgs(argv);
    const out = confirmPrOpen({
      repo: flags.repo,
      branch: flags.branch,
      head: flags.head,
      now: flags.now,
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`confirm-pr-open: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`confirm-pr-open: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`confirm-pr-open: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}

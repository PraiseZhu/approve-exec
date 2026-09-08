#!/usr/bin/env node
// confirm-pr-open.mjs — 验收后确认远端 ready PR 已存在（零 LLM）。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LedgerError, parseTimestamp } from './run-ledger.mjs';

const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MIVO_REPO = 'xindong/mivo-canvas-plugin';

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
  if (isDraft !== false) {
    throw new LedgerError('PRECONDITION', `PR isDraft 必须是 false（当前: ${isDraft ?? '缺失'}）`);
  }
  if (typeof expectedHead === 'string' && SHA_RE.test(expectedHead) && headRefOid !== expectedHead) {
    throw new LedgerError('PRECONDITION', `PR head ${headRefOid} 对不上本地 ${expectedHead}`);
  }
  const out = { url, number: Number(url.match(/\/pull\/(\d+)/)[1]), headRefOid, isDraft: false, state };
  if (typeof branch === 'string' && branch.length > 0) out.branch = branch;
  if (typeof checkedAt === 'string' && checkedAt.length > 0) out.checked_at = checkedAt;
  return out;
}

function runGh(repo, branch, ghBin = process.env.GH_BIN ?? 'gh', runner = spawnSync) {
  const r = runner(ghBin, [
    'pr', 'view', branch, '--repo', repo, '--json', 'url,state,headRefOid,isDraft,number',
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new LedgerError('PRECONDITION', `gh pr view 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return JSON.parse(r.stdout);
}

function assertMivoGreen({ repo, pr, head, ghBin = process.env.GH_BIN ?? 'gh', runner }) {
  if (!SHA_RE.test(head ?? '')) throw new LedgerError('ARGS', 'Mivo 交付必须提供有效的已验收 head SHA');
  if (pr.headRefOid !== head || pr.url !== `https://github.com/${repo}/pull/${pr.number}`) {
    throw new LedgerError('PRECONDITION', 'Mivo PR 身份或提交与交付对象不一致');
  }
  const result = runner(ghBin, ['pr', 'checks', String(pr.number), '--repo', repo,
    '--required', '--json', 'name,state,bucket'], { encoding: 'utf8' });
  if (result.status !== 0) throw new LedgerError('PRECONDITION', 'Mivo 必需 CI 未通过或查询失败，不能交付 Mini');
  const checks = JSON.parse(result.stdout);
  if (!Array.isArray(checks) || checks.length === 0 || checks.some(check =>
    typeof check.name !== 'string' || !check.name.trim() || check.bucket !== 'pass' ||
    !['SUCCESS', 'success'].includes(check.state))) {
    throw new LedgerError('PRECONDITION', 'Mivo 必需 CI 缺失、未成功或尚在等待，不能交付 Mini');
  }
}

function requireStamp(value, name) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new LedgerError('ARGS', `${name} 必须是非负安全整数（当前: ${value}）`);
  }
  return n;
}

export function confirmPrOpen({ repo, branch, head, ghBin, now, ledgerVersion, assignmentSeq, runner = spawnSync } = {}) {
  if (typeof repo !== 'string' || !repo.includes('/')) {
    throw new LedgerError('ARGS', `repo 必须是 owner/name（当前: ${repo}）`);
  }
  if (typeof branch !== 'string' || branch.length === 0) {
    throw new LedgerError('ARGS', 'branch 必须是非空字符串');
  }
  parseTimestamp(now, 'confirm-pr-open --now');
  let raw = runGh(repo, branch, ghBin, runner);
  if (repo === MIVO_REPO) {
    assertReadyPr({ ...raw, expectedHead: head });
    assertMivoGreen({ repo, pr: raw, head, ghBin, runner });
    // Required checks belong to a commit; re-read after the potentially slow query.
    const after = runGh(repo, String(raw.number), ghBin, runner);
    if (after.url !== raw.url || after.number !== raw.number || after.headRefOid !== raw.headRefOid) {
      throw new LedgerError('PRECONDITION', 'Mivo PR 在 CI 验证期间变化，必须重新验证');
    }
    raw = after;
  }
  return {
    ...assertReadyPr({
      url: raw.url,
      state: raw.state,
      isDraft: raw.isDraft,
      headRefOid: raw.headRefOid,
      expectedHead: head,
      branch,
      checkedAt: now,
    }),
    ledger_version: requireStamp(ledgerVersion, 'ledger-version'),
    assignment_seq: requireStamp(assignmentSeq, 'assignment-seq'),
  };
}

function runCli(argv) {
  try {
    const flags = parseConfirmArgs(argv);
    const out = confirmPrOpen({
      repo: flags.repo,
      branch: flags.branch,
      head: flags.head,
      now: flags.now,
      ledgerVersion: flags['ledger-version'],
      assignmentSeq: flags['assignment-seq'],
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

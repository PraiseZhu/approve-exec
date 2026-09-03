#!/usr/bin/env node
// confirm-watch-registered.mjs — 把 Mini register.mjs 的真实 stdout 封成台账回执。
// 不改 Mini。register.mjs 成功输出是 `REGISTERED <abs>` / `ALREADY <abs>`。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LedgerError, parseTimestamp, WATCH_RECEIPT_KEYS } from './run-ledger.mjs';

const STATE_NAME_RE = /^([A-Za-z0-9.%!~*'()-]+)__([A-Za-z0-9.%!~*'()-]+)__(\d+)\.json$/;
const REGISTER_LINE_RE = /^(REGISTERED|ALREADY)\s+(\/\S+\.json)\s*$/;

export function parseWatchArgs(argv) {
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

function requireStamp(value, name) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new LedgerError('ARGS', `${name} 必须是非负安全整数（当前: ${value}）`);
  }
  return n;
}

export function parseRegisterStdout(stdout) {
  const line = String(stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
  const m = REGISTER_LINE_RE.exec(line);
  if (!m) {
    throw new LedgerError('PRECONDITION', `register.mjs stdout 不是 REGISTERED/ALREADY <abs.json>（当前: ${line || '空'}）`);
  }
  return { kind: m[1], stateFile: m[2] };
}

export function identityFromStateFile(stateFile) {
  const base = stateFile.split('/').at(-1) ?? '';
  const m = STATE_NAME_RE.exec(base);
  if (!m) {
    throw new LedgerError('PRECONDITION', `state_file 文件名解析不出 owner/repo/pr（当前: ${base}）`);
  }
  try {
    return {
      owner: decodeURIComponent(m[1].replace(/%5F/g, '_')),
      repo: decodeURIComponent(m[2].replace(/%5F/g, '_')),
      pr_number: Number(m[3]),
    };
  } catch (err) {
    throw new LedgerError('PRECONDITION', `state_file 文件名解码失败: ${err.message}`);
  }
}

export function confirmWatchRegistered({
  stdout, owner, repo, prNumber, branch, now, ledgerVersion, assignmentSeq,
} = {}) {
  parseTimestamp(now, 'confirm-watch-registered --now');
  if (typeof owner !== 'string' || owner.length === 0) throw new LedgerError('ARGS', 'owner 必须是非空字符串');
  if (typeof repo !== 'string' || repo.length === 0) throw new LedgerError('ARGS', 'repo 必须是非空字符串');
  if (typeof branch !== 'string' || branch.length === 0) throw new LedgerError('ARGS', 'branch 必须是非空字符串');
  const expectedPr = Number(prNumber);
  if (!Number.isSafeInteger(expectedPr) || expectedPr <= 0) {
    throw new LedgerError('ARGS', `pr 必须是正整数（当前: ${prNumber}）`);
  }
  const parsed = parseRegisterStdout(stdout);
  const id = identityFromStateFile(parsed.stateFile);
  if (id.owner !== owner.toLowerCase() || id.repo !== repo.toLowerCase() || id.pr_number !== expectedPr) {
    throw new LedgerError('PRECONDITION', `register stdout 身份不符（${id.owner}/${id.repo}#${id.pr_number} ≠ ${owner}/${repo}#${expectedPr}）`);
  }
  const receipt = {
    ok: true,
    owner,
    repo,
    pr_number: expectedPr,
    branch,
    state_file: parsed.stateFile,
    session_id: null,
    checked_at: now,
    ledger_version: requireStamp(ledgerVersion, 'ledger-version'),
    assignment_seq: requireStamp(assignmentSeq, 'assignment-seq'),
  };
  const keys = Object.keys(receipt).sort();
  if (keys.join(',') !== [...WATCH_RECEIPT_KEYS].sort().join(',')) {
    throw new LedgerError('PRECONDITION', `watch receipt 键集不符（当前: ${keys.join(',')}）`);
  }
  return receipt;
}

function runRegister({ host, registerBin, stateDir, owner, repo, pr, branch, pushRemote }) {
  const remoteCmd = [
    'node', registerBin,
    '--state-dir', stateDir,
    '--owner', owner,
    '--repo', repo,
    '--pr', String(pr),
    '--branch', branch,
    '--push-remote', pushRemote,
  ].map((part) => `'${String(part).replace(/'/g, `'\\''`)}'`).join(' ');
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', host, remoteCmd], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new LedgerError('PRECONDITION', `ssh register.mjs 失败: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

function runCli(argv) {
  try {
    const flags = parseWatchArgs(argv);
    const stdout = flags.stdout ?? runRegister({
      host: flags.host ?? 'Praise-Mini',
      registerBin: flags['register-bin'] ?? '/Users/praise/AI-Agent/Claude/capabilities/source/pr-autopilot/scripts/pr-watch/register.mjs',
      stateDir: flags['state-dir'],
      owner: flags.owner,
      repo: flags.repo,
      pr: flags.pr,
      branch: flags.branch,
      pushRemote: flags['push-remote'] ?? 'origin',
    });
    const out = confirmWatchRegistered({
      stdout,
      owner: flags.owner,
      repo: flags.repo,
      prNumber: flags.pr,
      branch: flags.branch,
      now: flags.now,
      ledgerVersion: flags['ledger-version'],
      assignmentSeq: flags['assignment-seq'],
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`confirm-watch-registered: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`confirm-watch-registered: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`confirm-watch-registered: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}

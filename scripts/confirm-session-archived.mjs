#!/usr/bin/env node
// confirm-session-archived.mjs — 核 PI session 已 archived，产出台账回执。
// mivo-watcher 源码已迁至独立仓 Vigil（PraiseZhu/vigil），本仓不再内嵌副本。
// 运行时从 watcher 的运行目录动态加载 mivo-ownership.mjs：加载失败或文件不存在时
// fail-closed 抛 PRECONDITION，禁止归档（与原「watcher 台账不可读」语义一致）。
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerError, parseTimestamp, ARCHIVE_RECEIPT_KEYS } from './run-ledger.mjs';

const GH = process.env.GH_BIN ?? 'gh';

const DEFAULT_MIVO_WATCHER_HOME = '/Users/praise/AI-Agent/Claude/projects/Project Mivo Canvas-Plugin/_ops/mivo-watcher';

const mivoOwnershipModulePromises = new Map();

/**
 * 从 watcher 运行目录动态加载 mivo-ownership.mjs。
 * home 取 process.env.MIVO_WATCHER_HOME，未设则用 Mivo runtime 默认路径。
 * 加载失败或文件不存在时抛 PRECONDITION（fail-closed，禁止归档）。
 * 按 home 分别缓存，避免测试/多 runtime 场景下互相串缓存。
 */
function loadMivoOwnershipModule(env = process.env) {
  const home = env.MIVO_WATCHER_HOME || DEFAULT_MIVO_WATCHER_HOME;
  if (!mivoOwnershipModulePromises.has(home)) {
    const modulePath = path.join(home, 'bin', 'mivo-ownership.mjs');
    const promise = import(pathToFileURL(modulePath).href).catch((error) => {
      mivoOwnershipModulePromises.delete(home);
      throw new LedgerError(
        'PRECONDITION',
        `watcher 台账不可读，禁止归档（mivo-ownership 模块加载失败，home=${home}：${error.message}）`,
      );
    });
    mivoOwnershipModulePromises.set(home, promise);
  }
  return mivoOwnershipModulePromises.get(home);
}

function defaultGh(args) {
  return execFileSync(GH, args, {
    encoding: 'utf8', timeout: 12000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyClosedPrState({ pr, repo, sessionId, ghFn }) {
  const number = Number(pr);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new LedgerError('PRECONDITION', `session ${sessionId} 台账标记已关闭但缺少有效 PR 号，禁止归档`);
  }
  let raw;
  try {
    raw = ghFn(['pr', 'view', String(number), '--repo', repo, '--json', 'state']);
  } catch (error) {
    throw new LedgerError('PRECONDITION', `session ${sessionId} 的 PR #${number} 当前状态核实失败，禁止归档（${error.message}）`);
  }
  let state;
  try {
    state = JSON.parse(raw)?.state;
  } catch {
    throw new LedgerError('PRECONDITION', `session ${sessionId} 的 PR #${number} 当前状态不可解析，禁止归档`);
  }
  if (state !== 'MERGED' && state !== 'CLOSED') {
    throw new LedgerError(
      'PRECONDITION',
      `session ${sessionId} 是 PR #${number} 的 watcher 专属修复 session，PR 仍开着，禁止归档；如需停盯请给 PR 打 mivo-watch:off 标签`,
    );
  }
}

const BOOLEAN_FLAGS = new Set(['precheck']);

export function parseArchiveArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
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

function asRecord(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

export function extractArchiveResult(raw, sessionId) {
  const rec = asRecord(raw);
  if (rec.isError === true || rec.ok === false) {
    throw new LedgerError('PRECONDITION', 'archive_sessions 工具返回失败，不能用作归档证明');
  }
  // MCP clients may retain the text/structuredContent envelope. Consume that
  // real result directly instead of making the caller hand-transcribe a receipt.
  if (rec.structuredContent) return extractArchiveResult(rec.structuredContent, sessionId);
  if (Array.isArray(rec.content)) {
    const payloads = rec.content.filter((part) => part.type === 'text')
      .map((part) => asRecord(part.text)).filter((value) => Object.keys(value).length);
    if (payloads.length !== 1) throw new LedgerError('PRECONDITION', 'archive_sessions 结果必须能解析为唯一回执');
    return extractArchiveResult(payloads[0], sessionId);
  }
  const payload = rec.result && typeof rec.result === 'object' ? rec.result : rec;
  if (payload.ok !== true) {
    throw new LedgerError('PRECONDITION', `archive_sessions 回执 ok 必须是 true（当前: ${payload.ok ?? '缺失'}）`);
  }
  if (!Array.isArray(payload.changed) || payload.changed.length === 0) {
    throw new LedgerError('PRECONDITION', 'archive_sessions 回执必须含非空 changed[]');
  }
  const hit = payload.changed.find((item) => item && item.session_id === sessionId);
  if (!hit) {
    throw new LedgerError('PRECONDITION', `archive_sessions.changed 未包含 ${sessionId}`);
  }
  if (hit.status !== 'archived') {
    throw new LedgerError('PRECONDITION', `archive_sessions.changed[${sessionId}].status 必须是 archived（当前: ${hit.status}）`);
  }
  return { session_id: sessionId, archived: true };
}

export function confirmSessionArchived({
  sessionId, archiveResult, now, ledgerVersion, assignmentSeq,
} = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new LedgerError('ARGS', 'session-id 必须是非空字符串');
  }
  parseTimestamp(now, 'confirm-session-archived --now');
  const verified = extractArchiveResult(archiveResult, sessionId);
  const receipt = {
    session_id: verified.session_id,
    archived: true,
    checked_at: now,
    ledger_version: requireStamp(ledgerVersion, 'ledger-version'),
    assignment_seq: requireStamp(assignmentSeq, 'assignment-seq'),
  };
  const keys = Object.keys(receipt).sort();
  if (keys.join(',') !== [...ARCHIVE_RECEIPT_KEYS].sort().join(',')) {
    throw new LedgerError('PRECONDITION', `archive receipt 键集不符（当前: ${keys.join(',')}）`);
  }
  return receipt;
}

export async function assertNotWatchOwner({
  sessionId, lookup, home, repo, env, ghFn,
} = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new LedgerError('ARGS', 'session-id 必须是非空字符串');
  }
  let watchedRepo = repo;
  let query = lookup;
  if (!watchedRepo || !query) {
    const mod = await loadMivoOwnershipModule(env);
    if (!watchedRepo) watchedRepo = mod.WATCHED_REPO;
    if (!query) {
      query = (id) => mod.lookupWatchOwner({
        home, repo: watchedRepo, sessionId: id, env,
      });
    }
  }
  let result;
  try {
    result = typeof query === 'function' ? query(sessionId) : query;
  } catch (error) {
    throw new LedgerError('PRECONDITION', `session ${sessionId} 的 watcher 台账不可读，禁止归档（${error.message}）`);
  }
  if (!result || result.reason === 'state-unreadable') {
    throw new LedgerError('PRECONDITION', `session ${sessionId} 的 watcher 台账不可读，禁止归档`);
  }
  if (result.owned === true && result.closed !== true) {
    throw new LedgerError(
      'PRECONDITION',
      `session ${sessionId} 是 PR #${result.pr} 的 watcher 专属修复 session，PR 仍开着，禁止归档；如需停盯请给 PR 打 mivo-watch:off 标签`,
    );
  }
  if (result.owned === true && result.closed === true) {
    verifyClosedPrState({
      pr: result.pr, repo: watchedRepo, sessionId, ghFn: ghFn ?? defaultGh,
    });
  }
  return result;
}

export async function runCli(argv, options = {}) {
  try {
    const flags = parseArchiveArgs(argv);
    const sessionId = flags['session-id'];
    let lookup = options.lookup;
    let watchedRepo = flags.repo;
    if (!lookup || !watchedRepo) {
      const mod = await loadMivoOwnershipModule(options.env);
      if (!watchedRepo) watchedRepo = mod.WATCHED_REPO;
      if (!lookup) {
        lookup = (id) => mod.lookupWatchOwner({
          home: flags.home,
          repo: watchedRepo,
          sessionId: id,
          env: options.env,
        });
      }
    }
    if (flags.precheck === true || flags.result !== undefined) {
      await assertNotWatchOwner({ sessionId, lookup, repo: watchedRepo, ghFn: options.ghFn });
    }
    if (flags.precheck === true && flags.result === undefined) {
      process.stdout.write(`${JSON.stringify({ ok: true, precheck: true, session_id: sessionId })}\n`);
      return 0;
    }
    if (flags.result === undefined) {
      throw new LedgerError('ARGS', '必须传 --result <archive_sessions JSON>；本脚本不直接调 MCP');
    }
    const out = confirmSessionArchived({
      sessionId,
      archiveResult: flags.result,
      now: flags.now,
      ledgerVersion: flags['ledger-version'],
      assignmentSeq: flags['assignment-seq'],
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`confirm-session-archived: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`confirm-session-archived: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (e) {
    console.error(`confirm-session-archived: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    runCli(process.argv.slice(2)).then((code) => {
      process.exitCode = code;
    });
  }
}

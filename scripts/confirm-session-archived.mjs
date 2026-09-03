#!/usr/bin/env node
// confirm-session-archived.mjs — 核 PI session 已 archived，产出台账回执。
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LedgerError, parseTimestamp, ARCHIVE_RECEIPT_KEYS } from './run-ledger.mjs';

export function parseArchiveArgs(argv) {
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

function asRecord(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

export function extractArchiveResult(raw, sessionId) {
  const rec = asRecord(raw);
  const payload = rec.result && typeof rec.result === 'object' ? rec.result : rec;
  const ids = []
    .concat(payload.archived_session_ids ?? [])
    .concat(payload.session_ids ?? [])
    .concat(payload.ids ?? [])
    .concat(payload.archived ?? []);
  const status = payload.status ?? payload.sessions?.[sessionId]?.status ?? payload[sessionId]?.status;
  const listed = ids.map(String).includes(sessionId);
  const marked = status === 'archived' || payload.archived === true;
  if (!listed && !marked) {
    throw new LedgerError('PRECONDITION', `archive_sessions 回执未证明 ${sessionId} 已 archived`);
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

function runCli(argv) {
  try {
    const flags = parseArchiveArgs(argv);
    if (flags.result === undefined) {
      throw new LedgerError('ARGS', '必须传 --result <archive_sessions JSON>；本脚本不直接调 MCP');
    }
    const out = confirmSessionArchived({
      sessionId: flags['session-id'],
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
    process.exitCode = runCli(process.argv.slice(2));
  }
}

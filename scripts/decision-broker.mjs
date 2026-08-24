#!/usr/bin/env node
// decision-broker.mjs — Fable 决策 sidecar（独立 journal，不进执行台账）。
//
// 子命令：
//   check
//   open --run-id <id> --now <ts> --request <json|@file> [--journal <path>]
//   request-evidence --journal <path> --decision-id <id> --now <ts> --query <json|@file>
//   attach-evidence --journal <path> --decision-id <id> --now <ts> --bundle <json|@file>
//   resolve --journal <path> --decision-id <id> --now <ts> --result <json|@file> --worktree <path>
//   show --journal <path>
//
// 硬边界（Fable 2026-08-24 裁定 + GPT 架构纠正）：
//   - 不写 graph / routing / defaults / run-ledger events / group state / phase。
//   - 资格门 fail-closed；人独占布尔真值拒。
//   - 配额只在 decision_opened 原子成功时计数。
//   - 同 decision_key 同时只允许一个 open lease（CAS）。
//   - 晚到 / 错 nonce / context 变 → DECISION_SUPERSEDED，不覆盖。
//   - 隔离是 T1 纪律级：交卷必须带 tools_used；resolve 必传 worktree；porcelain 非空 → ABUSE。
//   - handoff 六块非空；bundle_hash = sha256(canonical(items))；requests[] exact REQUEST_RECORD_KEYS。
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, renameSync, existsSync,
  openSync, writeSync, closeSync, unlinkSync, realpathSync, mkdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLedgerLock, releaseLedgerLock, writeTmp, renameTmp, LedgerError,
} from './run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_REQUIRED = Object.freeze([
  'model', 'effort', 'agent', 'journalDir',
  'quotaPerWave', 'quotaPerRun', 'leaseTtlMs', 'rationaleMaxChars', 'isolationLevel',
]);
const REQUEST_KEYS = Object.freeze([
  'origin', 'original_question', 'why_autonomy_cannot_choose', 'human_exclusive',
  'options', 'constraints', 'active_scope', 'handoff',
]);
const SCOPE_KEYS = Object.freeze(['run_id', 'phase', 'wave', 'groups', 'manifest_core_hash', 'head_sha']);
const HANDOFF_KEYS = Object.freeze([
  'scene', 'changes', 'bottleneck', 'process', 'original_question', 'choice',
]);
const OPTION_KEYS = Object.freeze(['id', 'summary', 'consequences']);
const PHASES = Object.freeze(['executing', 'reviewing', 'validating', 'e2e', 'packaging', 'ready']);
const EVENT_TYPES = Object.freeze([
  'decision_opened',
  'evidence_requested',
  'evidence_attached',
  'decision_resolved',
  'decision_superseded',
  'decision_abused',
]);
const JOURNAL_TOP_KEYS = Object.freeze([
  'schema_version', 'run_id', 'version', 'quota', 'requests', 'events',
]);
const REQUEST_RECORD_KEYS = Object.freeze([
  'decision_id', 'decision_key', 'handoff_hash', 'context_hash', 'model_config_digest',
  'lease_nonce', 'status', 'opened_at', 'expires_at', 'wave', 'revision',
  'option_ids', 'pending_evidence', 'selected_option_id', 'rationale', 'residual', 'tools_used',
]);
const RESULT_KEYS = Object.freeze([
  'decision_id', 'handoff_hash', 'lease_nonce', 'selected_option_id',
  'rationale', 'residual', 'tools_used',
]);
const EVIDENCE_QUERY_KEYS = Object.freeze(['queries']);
const EVIDENCE_BUNDLE_KEYS = Object.freeze(['revision', 'bundle_hash', 'items']);

const BANNER = Object.freeze([
  '【决策席禁令】你只做决策和判断。禁止执行、禁止自己查证、禁止改任何文件。',
  '想要任何信息必须派只读 sub。交卷必须带 tools_used 自述。worktree 必须零 diff。',
].join(''));

let _config = null;

function expandHome(p) {
  return p.startsWith('~/') ? join(process.env.HOME || '', p.slice(2)) : p;
}

function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function assertKeys(obj, allowed, what) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new LedgerError('SCHEMA', `${what} 必须是对象`);
  }
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new LedgerError('SCHEMA', `${what} 含未列键: ${key}（exact 契约，未知键拒）`);
    }
  }
  for (const key of allowed) {
    if (!(key in obj)) {
      throw new LedgerError('SCHEMA', `${what} 缺键: ${key}`);
    }
  }
}

const ISO_NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function requireNow(now, what) {
  if (typeof now !== 'string' || now.length === 0) {
    throw new LedgerError('NOW_REQUIRED', `${what} 是写操作：必须携带 --now 时间戳`);
  }
  if (!ISO_NOW_RE.test(now) || !Number.isFinite(Date.parse(now))) {
    throw new LedgerError('NOW_REQUIRED', `${what} 的 --now 必须是可解析 ISO 时间戳（当前: ${now}）`);
  }
  return now;
}

function parseJsonArg(raw, what) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new LedgerError('ARGS', `${what} 缺 JSON`);
  }
  const text = raw.startsWith('@') ? readFileSync(resolve(raw.slice(1)), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new LedgerError('ARGS', `${what} 不是合法 JSON: ${err.message}`);
  }
}

export function readDecisionConfig() {
  if (_config) return _config;
  const path = join(ROOT, 'config/fable-decision.json');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new LedgerError('CONFIG', `fable-decision.json 不可读/不可解析: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerError('CONFIG', 'fable-decision.json 顶层必须是对象');
  }
  for (const key of CONFIG_REQUIRED) {
    if (!(key in parsed) || parsed[key] === null || parsed[key] === '') {
      throw new LedgerError('CONFIG', `fable-decision.json 缺必备键: ${key}`);
    }
  }
  if (parsed.model !== 'claude-fable-5') {
    throw new LedgerError('CONFIG', `model 必须钉死 claude-fable-5（当前 ${parsed.model}）`);
  }
  if (parsed.effort !== 'low') {
    throw new LedgerError('CONFIG', `effort 必须钉死 low（当前 ${parsed.effort}）`);
  }
  if (parsed.agent !== 'claude-code') {
    throw new LedgerError('CONFIG', `agent 必须钉死 claude-code（当前 ${parsed.agent}）`);
  }
  if (parsed.isolationLevel !== 'T1') {
    throw new LedgerError('CONFIG', `isolationLevel 必须如实声明 T1（当前 ${parsed.isolationLevel}）`);
  }
  for (const key of ['quotaPerWave', 'quotaPerRun', 'leaseTtlMs', 'rationaleMaxChars']) {
    if (!Number.isSafeInteger(parsed[key]) || parsed[key] <= 0) {
      throw new LedgerError('CONFIG', `${key} 必须是正安全整数`);
    }
  }
  _config = parsed;
  return _config;
}

export function modelConfigDigest(config = readDecisionConfig()) {
  return sha256Hex(canonical({
    model: config.model,
    effort: config.effort,
    agent: config.agent,
    isolationLevel: config.isolationLevel,
  }));
}

export function decisionPacketBanner() {
  return BANNER;
}

function emptyJournal(runId) {
  return {
    schema_version: 'decision-v1',
    run_id: runId,
    version: 0,
    quota: { per_wave: {}, per_run: 0 },
    requests: [],
    events: [],
  };
}

export function assertDecisionJournalSchema(journal) {
  assertKeys(journal, JOURNAL_TOP_KEYS, 'decision journal 顶层');
  if (journal.schema_version !== 'decision-v1') {
    throw new LedgerError('SCHEMA', `decision journal schema_version 非法: ${journal.schema_version}`);
  }
  if (typeof journal.run_id !== 'string' || journal.run_id.length === 0) {
    throw new LedgerError('SCHEMA', 'decision journal run_id 必须是非空字符串');
  }
  if (!Number.isSafeInteger(journal.version) || journal.version < 0) {
    throw new LedgerError('SCHEMA', 'decision journal version 必须是非负安全整数');
  }
  if (journal.quota === null || typeof journal.quota !== 'object' || Array.isArray(journal.quota)) {
    throw new LedgerError('SCHEMA', 'decision journal quota 必须是对象');
  }
  if (!Array.isArray(journal.requests) || !Array.isArray(journal.events)) {
    throw new LedgerError('SCHEMA', 'decision journal requests/events 必须是数组');
  }
  for (const [i, req] of journal.requests.entries()) {
    assertKeys(req, REQUEST_RECORD_KEYS, `decision requests[${i}]`);
  }
  for (const ev of journal.events) {
    if (!EVENT_TYPES.includes(ev.type)) {
      throw new LedgerError('SCHEMA', `decision event.type 未知: ${ev.type}`);
    }
    if (ev.detail?.group_id !== null) {
      throw new LedgerError('SCHEMA', 'decision event.detail.group_id 必须为 null（禁止挂到执行组）');
    }
  }
}

function readJournal(path) {
  if (!existsSync(path)) {
    throw new LedgerError('JOURNAL_MISSING', `decision journal 不存在: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new LedgerError('JOURNAL_CORRUPT', `decision journal 解析失败: ${err.message}`);
  }
  assertDecisionJournalSchema(parsed);
  return parsed;
}

function writeJournalAtomic(path, expectedVersion, buildNext) {
  const lockPath = acquireLedgerLock(path);
  try {
    const current = readJournal(path);
    if (current.version !== expectedVersion) {
      throw new LedgerError(
        'CAS_CONFLICT',
        `decision journal 乐观锁冲突：expected=${expectedVersion} disk=${current.version}`
      );
    }
    const next = buildNext(current);
    if (!Number.isSafeInteger(next.version) || next.version !== expectedVersion + 1) {
      throw new LedgerError('SCHEMA', `buildNext 必须把 version 置为 ${expectedVersion + 1}`);
    }
    assertDecisionJournalSchema(next);
    writeTmp(path, `${JSON.stringify(next, null, 2)}\n`);
    renameTmp(path);
    return next;
  } finally {
    releaseLedgerLock(lockPath);
  }
}

function ensureJournal(path, runId) {
  if (existsSync(path)) {
    const journal = readJournal(path);
    if (journal.run_id !== runId) {
      throw new LedgerError('SCHEMA', `journal run_id=${journal.run_id} 与请求 run_id=${runId} 不一致`);
    }
    return journal;
  }
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = acquireLedgerLock(path);
  try {
    if (existsSync(path)) return readJournal(path);
    const journal = emptyJournal(runId);
    writeTmp(path, `${JSON.stringify(journal, null, 2)}\n`);
    renameTmp(path);
    return journal;
  } finally {
    releaseLedgerLock(lockPath);
  }
}

function defaultJournalPath(runId, config = readDecisionConfig()) {
  if (!process.env.HOME) {
    throw new LedgerError('CONFIG', 'HOME 未设置，无法展开 journalDir');
  }
  return join(expandHome(config.journalDir), `${runId}.json`);
}

export function computeContextHash(scope) {
  return sha256Hex(canonical({
    run_id: scope.run_id,
    phase: scope.phase,
    wave: scope.wave,
    groups: [...scope.groups].sort(),
    manifest_core_hash: scope.manifest_core_hash,
    head_sha: scope.head_sha,
  }));
}

export function computeHandoffHash(handoff) {
  return sha256Hex(canonical(handoff));
}

export function computeBundleHash(items) {
  return sha256Hex(canonical(items));
}

function assertHandoffFilled(value, key) {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      throw new LedgerError('HANDOFF', `handoff.${key} 必须是非空字符串`);
    }
    return;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.keys(value).length === 0) {
      throw new LedgerError('HANDOFF', `handoff.${key} 必须是非空对象`);
    }
    return;
  }
  throw new LedgerError('HANDOFF', `handoff.${key} 必须是非空字符串或非空对象`);
}

export function computeDecisionKey({
  runId, manifestCoreHash, phase, wave, groups, originalQuestion, options, constraints, contextHash,
}) {
  return sha256Hex(canonical({
    run_id: runId,
    manifest_core_hash: manifestCoreHash,
    phase,
    wave,
    groups: [...groups].sort(),
    original_question: originalQuestion,
    options,
    constraints,
    context_hash: contextHash,
  }));
}

function assertNonEmptyString(value, what) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LedgerError('ELIGIBILITY', `${what} 必须是非空字符串`);
  }
}

export function assertEligibility(request) {
  assertKeys(request, REQUEST_KEYS, 'decision request');
  if (request.origin !== 'grok_user_choice') {
    throw new LedgerError('ELIGIBILITY', `origin 必须是 grok_user_choice（当前 ${request.origin}）`);
  }
  assertNonEmptyString(request.original_question, 'original_question');
  assertNonEmptyString(request.why_autonomy_cannot_choose, 'why_autonomy_cannot_choose');
  if (typeof request.human_exclusive !== 'boolean') {
    throw new LedgerError('ELIGIBILITY', 'human_exclusive 必须是布尔');
  }
  if (request.human_exclusive === true) {
    throw new LedgerError('HUMAN_EXCLUSIVE', '人独占事项不得进 Fable（停给用户）');
  }
  if (!Array.isArray(request.options) || request.options.length < 2) {
    throw new LedgerError('ELIGIBILITY', 'options 至少两个具 id 的选项');
  }
  const ids = new Set();
  for (const [i, opt] of request.options.entries()) {
    assertKeys(opt, OPTION_KEYS, `options[${i}]`);
    assertNonEmptyString(opt.id, `options[${i}].id`);
    assertNonEmptyString(opt.summary, `options[${i}].summary`);
    assertNonEmptyString(opt.consequences, `options[${i}].consequences`);
    if (ids.has(opt.id)) {
      throw new LedgerError('ELIGIBILITY', `options.id 重复: ${opt.id}`);
    }
    ids.add(opt.id);
  }
  if (!Array.isArray(request.constraints) || request.constraints.some((c) => typeof c !== 'string' || c.length === 0)) {
    throw new LedgerError('ELIGIBILITY', 'constraints 必须是非空字符串数组');
  }
  assertKeys(request.active_scope, SCOPE_KEYS, 'active_scope');
  assertNonEmptyString(request.active_scope.run_id, 'active_scope.run_id');
  if (!PHASES.includes(request.active_scope.phase)) {
    throw new LedgerError('ELIGIBILITY', `active_scope.phase 非法: ${request.active_scope.phase}`);
  }
  if (!Number.isSafeInteger(request.active_scope.wave) || request.active_scope.wave < 0) {
    throw new LedgerError('ELIGIBILITY', 'active_scope.wave 必须是非负安全整数（必填，禁止 global scope）');
  }
  if (!Array.isArray(request.active_scope.groups) || request.active_scope.groups.length === 0) {
    throw new LedgerError('ELIGIBILITY', 'active_scope.groups 必须是非空数组');
  }
  if (!/^[0-9a-f]{64}$/.test(request.active_scope.manifest_core_hash)) {
    throw new LedgerError('ELIGIBILITY', 'active_scope.manifest_core_hash 必须是 64 位十六进制');
  }
  if (!/^[0-9a-f]{40}$/.test(request.active_scope.head_sha)) {
    throw new LedgerError('ELIGIBILITY', 'active_scope.head_sha 必须是 40 位十六进制');
  }
  assertKeys(request.handoff, HANDOFF_KEYS, 'handoff');
  for (const key of HANDOFF_KEYS) {
    assertHandoffFilled(request.handoff[key], key);
  }
  if (request.handoff.original_question !== request.original_question) {
    throw new LedgerError('HANDOFF', 'handoff.original_question 必须与 request.original_question 逐字一致');
  }
  const q = `${request.original_question}\n${request.why_autonomy_cannot_choose}`;
  const forbidden = [
    [/要开始吗/, '确认句式不得进 Fable'],
    [/能不能并行/, '并行确认不得进 Fable'],
    [/查(一下)?资料/, '查资料不得进 Fable'],
    [/帮我执行/, '执行题不得进 Fable'],
    [/代码审查|review code/, '审查题不得进 Fable'],
  ];
  for (const [re, reason] of forbidden) {
    if (re.test(q)) throw new LedgerError('ELIGIBILITY', reason);
  }
}

export function renderDecisionPacket(request, hashes) {
  const lines = [
    BANNER,
    `decision_id=${hashes.decision_id}`,
    `handoff_hash=${hashes.handoff_hash}`,
    `context_hash=${hashes.context_hash}`,
    `model_config_digest=${hashes.model_config_digest}`,
    `run=${request.active_scope.run_id} phase=${request.active_scope.phase} wave=${request.active_scope.wave} groups=${request.active_scope.groups.join(',')}`,
    `HEAD=${request.active_scope.head_sha}`,
    '--- scene ---',
    typeof request.handoff.scene === 'string' ? request.handoff.scene : JSON.stringify(request.handoff.scene),
    '--- changes ---',
    typeof request.handoff.changes === 'string' ? request.handoff.changes : JSON.stringify(request.handoff.changes),
    '--- bottleneck ---',
    typeof request.handoff.bottleneck === 'string' ? request.handoff.bottleneck : JSON.stringify(request.handoff.bottleneck),
    '--- process ---',
    typeof request.handoff.process === 'string' ? request.handoff.process : JSON.stringify(request.handoff.process),
    '--- question ---',
    request.original_question,
    '--- options ---',
    ...request.options.map((o) => `${o.id}: ${o.summary} / ${o.consequences}`),
    '--- constraints ---',
    ...request.constraints,
  ];
  return `${lines.join('\n')}\n`;
}

function findRequest(journal, decisionId) {
  return journal.requests.find((r) => r.decision_id === decisionId);
}

function pushEvent(journal, type, now, extra) {
  journal.events.push({
    type,
    at: now,
    detail: { group_id: null, ...extra },
  });
}

export function openDecision({ journalPath, now, request }) {
  requireNow(now, 'decision-open');
  const config = readDecisionConfig();
  assertEligibility(request);
  const scope = request.active_scope;
  const path = journalPath || defaultJournalPath(scope.run_id, config);
  ensureJournal(path, scope.run_id);
  const contextHash = computeContextHash(scope);
  const handoffHash = computeHandoffHash(request.handoff);
  const decisionKey = computeDecisionKey({
    runId: scope.run_id,
    manifestCoreHash: scope.manifest_core_hash,
    phase: scope.phase,
    wave: scope.wave,
    groups: scope.groups,
    originalQuestion: request.original_question,
    options: request.options,
    constraints: request.constraints,
    contextHash,
  });
  const digest = modelConfigDigest(config);
  const waveKey = String(scope.wave);
  const lockPath = acquireLedgerLock(path);
  try {
    const cur = readJournal(path);
    const existing = cur.requests.find((r) => r.decision_key === decisionKey && r.status === 'open');
    if (existing) {
      return {
        reused: true,
        journal_path: path,
        decision_id: existing.decision_id,
        lease_nonce: existing.lease_nonce,
        handoff_hash: existing.handoff_hash,
        context_hash: existing.context_hash,
        model_config_digest: existing.model_config_digest,
        packet: renderDecisionPacket(request, existing),
      };
    }
    const waveUsed = cur.quota.per_wave[waveKey] ?? 0;
    if (waveUsed >= config.quotaPerWave) {
      throw new LedgerError('QUOTA', `wave ${scope.wave} 决策配额已满（${waveUsed}/${config.quotaPerWave}）`);
    }
    if (cur.quota.per_run >= config.quotaPerRun) {
      throw new LedgerError('QUOTA', `run 决策配额已满（${cur.quota.per_run}/${config.quotaPerRun}）`);
    }
    const decisionId = `dec_${randomBytes(8).toString('hex')}`;
    const leaseNonce = randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.parse(now) + config.leaseTtlMs).toISOString();
    cur.quota.per_wave[waveKey] = waveUsed + 1;
    cur.quota.per_run += 1;
    for (const stale of cur.requests) {
      if (stale.status === 'open' && stale.context_hash !== contextHash) {
        stale.status = 'superseded';
        pushEvent(cur, 'decision_superseded', now, {
          decision_id: stale.decision_id,
          reason: 'context_hash 已变，旧 lease 作废',
        });
      }
    }
    cur.requests.push({
      decision_id: decisionId,
      decision_key: decisionKey,
      handoff_hash: handoffHash,
      context_hash: contextHash,
      model_config_digest: digest,
      lease_nonce: leaseNonce,
      status: 'open',
      opened_at: now,
      expires_at: expiresAt,
      wave: scope.wave,
      revision: 0,
      option_ids: request.options.map((o) => o.id),
      pending_evidence: false,
      selected_option_id: null,
      rationale: null,
      residual: [],
      tools_used: [],
    });
    pushEvent(cur, 'decision_opened', now, {
      decision_id: decisionId,
      decision_key: decisionKey,
      handoff_hash: handoffHash,
      context_hash: contextHash,
      lease_nonce: leaseNonce,
      wave: scope.wave,
    });
    cur.version += 1;
    assertDecisionJournalSchema(cur);
    writeTmp(path, `${JSON.stringify(cur, null, 2)}\n`);
    renameTmp(path);
    return {
      reused: false,
      journal_path: path,
      decision_id: decisionId,
      lease_nonce: leaseNonce,
      handoff_hash: handoffHash,
      context_hash: contextHash,
      model_config_digest: digest,
      packet: renderDecisionPacket(request, {
        decision_id: decisionId,
        handoff_hash: handoffHash,
        context_hash: contextHash,
        model_config_digest: digest,
      }),
    };
  } finally {
    releaseLedgerLock(lockPath);
  }
}

export function requestEvidence({ journalPath, decisionId, now, query }) {
  requireNow(now, 'request-evidence');
  assertKeys(query, EVIDENCE_QUERY_KEYS, 'evidence query');
  if (!Array.isArray(query.queries) || query.queries.length === 0) {
    throw new LedgerError('EVIDENCE', 'queries 必须是非空数组');
  }
  const journal = readJournal(journalPath);
  const req = findRequest(journal, decisionId);
  if (!req || req.status !== 'open') {
    throw new LedgerError('NOT_OPEN', `decision ${decisionId} 非 open，拒绝要证据`);
  }
  writeJournalAtomic(journalPath, journal.version, (cur) => {
    const live = findRequest(cur, decisionId);
    if (!live || live.status !== 'open') {
      throw new LedgerError('NOT_OPEN', `decision ${decisionId} 非 open`);
    }
    live.pending_evidence = true;
    pushEvent(cur, 'evidence_requested', now, {
      decision_id: decisionId,
      queries: query.queries,
      revision: live.revision,
    });
    return { ...cur, version: journal.version + 1 };
  });
  return { ok: true };
}

export function attachEvidence({ journalPath, decisionId, now, bundle }) {
  requireNow(now, 'attach-evidence');
  assertKeys(bundle, EVIDENCE_BUNDLE_KEYS, 'evidence bundle');
  if (!Number.isSafeInteger(bundle.revision) || bundle.revision < 1) {
    throw new LedgerError('EVIDENCE', 'bundle.revision 必须是 ≥1 的安全整数');
  }
  if (!Array.isArray(bundle.items)) {
    throw new LedgerError('EVIDENCE', 'bundle.items 必须是数组');
  }
  const expectedHash = computeBundleHash(bundle.items);
  if (bundle.bundle_hash !== expectedHash) {
    throw new LedgerError(
      'EVIDENCE',
      `bundle_hash 必须等于 sha256(canonical(items))（期望 ${expectedHash.slice(0, 12)}…）`
    );
  }
  const journal = readJournal(journalPath);
  writeJournalAtomic(journalPath, journal.version, (cur) => {
    const live = findRequest(cur, decisionId);
    if (!live || live.status !== 'open') {
      throw new LedgerError('NOT_OPEN', `decision ${decisionId} 非 open`);
    }
    if (live.pending_evidence !== true) {
      throw new LedgerError('EVIDENCE', `decision ${decisionId} 未 request-evidence，拒绝 attach`);
    }
    const expectedRevision = live.revision + 1;
    if (bundle.revision !== expectedRevision) {
      throw new LedgerError(
        'EVIDENCE',
        `bundle.revision 必须是当前+1（当前 ${live.revision}，收到 ${bundle.revision}）`
      );
    }
    live.revision = bundle.revision;
    live.pending_evidence = false;
    pushEvent(cur, 'evidence_attached', now, {
      decision_id: decisionId,
      revision: bundle.revision,
      bundle_hash: bundle.bundle_hash,
    });
    return { ...cur, version: journal.version + 1 };
  });
  return { ok: true };
}

function porcelain(worktree) {
  const r = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new LedgerError('ABUSE', `无法读取 decision worktree 状态: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

export function resolveDecision({ journalPath, decisionId, now, result, worktree, optionIds }) {
  requireNow(now, 'decision-resolve');
  const config = readDecisionConfig();
  assertKeys(result, RESULT_KEYS, 'decision result');
  if (result.decision_id !== decisionId) {
    throw new LedgerError('DECISION_SUPERSEDED', 'result.decision_id 与目标不一致');
  }
  if (!Array.isArray(result.tools_used)) {
    throw new LedgerError('ABUSE', 'result.tools_used 必须在场（T1 闸一）');
  }
  if (typeof result.rationale !== 'string' || result.rationale.length === 0) {
    throw new LedgerError('SCHEMA', 'rationale 必须是非空字符串');
  }
  if (result.rationale.length > config.rationaleMaxChars) {
    throw new LedgerError('SCHEMA', `rationale 超限（>${config.rationaleMaxChars}）`);
  }
  if (!Array.isArray(result.residual)) {
    throw new LedgerError('SCHEMA', 'residual 必须是数组');
  }
  if (typeof worktree !== 'string' || worktree.trim().length === 0) {
    throw new LedgerError('ABUSE', 'resolve 必须携带 worktree（T1 闸一，省略等于没有）');
  }
  const journal = readJournal(journalPath);
  const req = findRequest(journal, decisionId);
  if (!req) throw new LedgerError('NOT_FOUND', `无此 decision_id: ${decisionId}`);
  if (req.status !== 'open') {
    throw new LedgerError('DECISION_SUPERSEDED', `decision ${decisionId} 已 ${req.status}，晚到结果不覆盖`);
  }
  if (result.lease_nonce !== req.lease_nonce || result.handoff_hash !== req.handoff_hash) {
    writeJournalAtomic(journalPath, journal.version, (cur) => {
      pushEvent(cur, 'decision_superseded', now, {
        decision_id: decisionId,
        reason: 'lease_nonce/handoff_hash 不匹配',
      });
      return { ...cur, version: journal.version + 1 };
    });
    throw new LedgerError('DECISION_SUPERSEDED', 'lease_nonce 或 handoff_hash 不匹配，晚到结果不覆盖');
  }
  if (Date.parse(now) > Date.parse(req.expires_at)) {
    writeJournalAtomic(journalPath, journal.version, (cur) => {
      const live = findRequest(cur, decisionId);
      live.status = 'superseded';
      pushEvent(cur, 'decision_superseded', now, { decision_id: decisionId, reason: 'lease 过期' });
      return { ...cur, version: journal.version + 1 };
    });
    throw new LedgerError('DECISION_SUPERSEDED', 'lease 已过期');
  }
  const allowedOptions = Array.isArray(req.option_ids) && req.option_ids.length > 0
    ? req.option_ids
    : (Array.isArray(optionIds) ? optionIds : []);
  if (allowedOptions.length === 0) {
    throw new LedgerError('SCHEMA', `decision ${decisionId} 未持久化 option_ids，拒绝裁决`);
  }
  if (!allowedOptions.includes(result.selected_option_id)) {
    throw new LedgerError('SCHEMA', `selected_option_id=${result.selected_option_id} 不在选项集`);
  }
  const dirty = porcelain(worktree);
  if (dirty.length > 0) {
    writeJournalAtomic(journalPath, journal.version, (cur) => {
      const live = findRequest(cur, decisionId);
      live.status = 'abused';
      pushEvent(cur, 'decision_abused', now, {
        decision_id: decisionId,
        reason: 'worktree porcelain 非空',
      });
      return { ...cur, version: journal.version + 1 };
    });
    throw new LedgerError('ABUSE', 'decision worker worktree 必须零 diff（T1 闸一）');
  }
  const claimedVerify = /已核实|已查证|我核实|核实过|查过了/.test(result.rationale)
    || result.tools_used.some((t) => typeof t === 'string' && /read|grep|bash|edit|write/i.test(t));
  const hasEvidence = journal.events.some((e) => e.type === 'evidence_attached' && e.detail.decision_id === decisionId);
  if (claimedVerify && !hasEvidence) {
    throw new LedgerError('ABUSE', '声称已核实但无 evidence_attached 事件（T1 闸三）');
  }
  writeJournalAtomic(journalPath, journal.version, (cur) => {
    const live = findRequest(cur, decisionId);
    if (!live || live.status !== 'open') {
      throw new LedgerError('DECISION_SUPERSEDED', '锁内状态已变，晚到结果不覆盖');
    }
    if (live.lease_nonce !== result.lease_nonce) {
      throw new LedgerError('DECISION_SUPERSEDED', '锁内 nonce 已变');
    }
    live.status = 'resolved';
    live.selected_option_id = result.selected_option_id;
    live.rationale = result.rationale;
    live.residual = result.residual;
    live.tools_used = result.tools_used;
    pushEvent(cur, 'decision_resolved', now, {
      decision_id: decisionId,
      selected_option_id: result.selected_option_id,
      handoff_hash: live.handoff_hash,
      context_hash: live.context_hash,
    });
    return { ...cur, version: journal.version + 1 };
  });
  return { ok: true, selected_option_id: result.selected_option_id };
}

export function showJournal({ journalPath }) {
  return readJournal(journalPath);
}

export function checkDecisionBroker() {
  const config = readDecisionConfig();
  const items = [
    { id: 'config', ok: true, detail: `model=${config.model} effort=${config.effort} isolation=${config.isolationLevel}` },
    { id: 'banner', ok: BANNER.includes('禁止执行') && BANNER.includes('派只读 sub'), detail: '派工包首行禁令字面量在场' },
  ];
  if (process.env.HOME) {
    const dir = expandHome(config.journalDir);
    try {
      mkdirSync(dir, { recursive: true });
      items.push({ id: 'journal-dir', ok: true, detail: dir });
    } catch (err) {
      items.push({ id: 'journal-dir', ok: false, detail: err.message });
    }
  } else {
    items.push({ id: 'journal-dir', ok: false, detail: 'HOME 未设置' });
  }
  return items;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${a}`);
    const key = a.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new LedgerError('ARGS', `参数 --${key} 缺值`);
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      throw new LedgerError('ARGS', `参数 --${key} 重复指定`);
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function usage() {
  return [
    'decision-broker <sub> [flags]',
    '  check',
    '  open --run-id <id> --now <ts> --request <json|@file> [--journal <path>]',
    '  request-evidence --journal <path> --decision-id <id> --now <ts> --query <json|@file>',
    '  attach-evidence --journal <path> --decision-id <id> --now <ts> --bundle <json|@file>',
    '  resolve --journal <path> --decision-id <id> --now <ts> --result <json|@file> --worktree <path>',
    '  show --journal <path>',
  ].join('\n');
}

export function runCli(argv) {
  if (argv.length === 0) {
    console.error(usage());
    return 1;
  }
  try {
    const [sub, ...rest] = argv;
    const flags = parseFlags(rest);
    switch (sub) {
      case 'check': {
        const items = checkDecisionBroker();
        for (const item of items) console.log(`${item.ok ? 'PASS' : 'FAIL'}: ${item.id}: ${item.detail}`);
        return items.every((i) => i.ok) ? 0 : 2;
      }
      case 'open': {
        const request = parseJsonArg(flags.request, '--request');
        if (flags['run-id'] && request.active_scope?.run_id !== flags['run-id']) {
          throw new LedgerError('ARGS', '--run-id 与 request.active_scope.run_id 不一致');
        }
        const out = openDecision({
          journalPath: flags.journal,
          now: flags.now,
          request,
        });
        process.stdout.write(`${JSON.stringify({
          reused: out.reused,
          journal_path: out.journal_path,
          decision_id: out.decision_id,
          lease_nonce: out.lease_nonce,
          handoff_hash: out.handoff_hash,
          context_hash: out.context_hash,
          model_config_digest: out.model_config_digest,
        }, null, 2)}\n`);
        process.stdout.write(out.packet);
        return 0;
      }
      case 'request-evidence': {
        requestEvidence({
          journalPath: resolve(flags.journal),
          decisionId: flags['decision-id'],
          now: flags.now,
          query: parseJsonArg(flags.query, '--query'),
        });
        console.log(`request-evidence: ${flags['decision-id']} 已入账`);
        return 0;
      }
      case 'attach-evidence': {
        attachEvidence({
          journalPath: resolve(flags.journal),
          decisionId: flags['decision-id'],
          now: flags.now,
          bundle: parseJsonArg(flags.bundle, '--bundle'),
        });
        console.log(`attach-evidence: ${flags['decision-id']} 已入账`);
        return 0;
      }
      case 'resolve': {
        if (typeof flags.worktree !== 'string' || flags.worktree.trim().length === 0) {
          throw new LedgerError('ARGS', 'resolve 必须携带 --worktree（T1 闸一，省略等于没有）');
        }
        const result = parseJsonArg(flags.result, '--result');
        resolveDecision({
          journalPath: resolve(flags.journal),
          decisionId: flags['decision-id'],
          now: flags.now,
          result,
          worktree: flags.worktree,
        });
        console.log(`resolve: ${flags['decision-id']} → ${result.selected_option_id}`);
        return 0;
      }
      case 'show': {
        const journal = showJournal({ journalPath: resolve(flags.journal) });
        process.stdout.write(`${JSON.stringify(journal, null, 2)}\n`);
        return 0;
      }
      default:
        console.error(`decision-broker: 未知子命令 ${sub}\n${usage()}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`decision-broker: [${err.code}] ${err.message}`);
      return 2;
    }
    console.error(`decision-broker: 未预期错误: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try {
    entryReal = realpathSync(process.argv[1]);
  } catch (e) {
    console.error(`decision-broker: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runCli(process.argv.slice(2));
  }
}

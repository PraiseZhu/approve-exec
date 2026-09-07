#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import * as LedgerApi from '../run-ledger.mjs';
import { LedgerError, findGroup, latestGroupEvent, latestPrHandoffDelivery, parseTimestamp, readLedger, readManifest, readPrOpenReceipt, TIP_SHA_RE } from '../run-ledger.mjs';
import { canonicalJson, hashObject } from '../lib/common.mjs';
import { assertOwnerTitle } from '../vnext-owner-contract.mjs';

export const LEAD_SIGNAL_VERSION = 1;
export const STANDING_AUTHORIZATION = 'PR_PUSH_AND_REPLY';
export const LEAD_SIGNAL_KEYS = Object.freeze([
  'version', 'signal_id', 'standing_authorization', 'group_id', 'repository', 'pr_number',
  'pr_url', 'branch', 'lead_session_id', 'owner_session_id', 'owner_title', 'head_sha',
  'issued_at', 'ledger_version', 'assignment_seq', 'evidence', 'sender',
]);
export const LEAD_SIGNAL_EVIDENCE_KEYS = Object.freeze([
  'pr_ready_event_at', 'pr_ready_digest', 'local_validated_event_at', 'local_validated_digest',
  'pr_opened_event_at', 'pr_opened_digest', 'pr_open_receipt_digest', 'pr_state',
  'pr_is_draft', 'local_tip_sha', 'base', 'manifest_core_hash', 'execution_plan_hash',
]);
export const LEAD_SIGNAL_SENDER_KEYS = Object.freeze(['session_id', 'role', 'identity_source']);
const GITHUB_PR_URL_RE = new RegExp('^https://github.com/([^/]+)/([^/]+)/pull/([0-9]+)$');
const SHA256_RE = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

function assertExactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerError('SCHEMA', `${label} 必须是对象`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new LedgerError('SCHEMA', `${label} 含未列键: ${unexpected.join(',')}`);
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new LedgerError('SCHEMA', `${label} 缺键: ${missing.join(',')}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LedgerError('SCHEMA', `${label} 必须是非空字符串`);
  }
  return value;
}

function requireSessionId(value, label) {
  requireNonEmptyString(value, label);
  if (!SESSION_ID_RE.test(value)) {
    throw new LedgerError('SCHEMA', `${label} 含非法字符`);
  }
  return value;
}

function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new LedgerError('SCHEMA', `${label} 必须是大于等于 ${minimum} 的安全整数`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !TIP_SHA_RE.test(value)) {
    throw new LedgerError('SCHEMA', `${label} 必须是 40 位十六进制`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new LedgerError('SCHEMA', `${label} 必须是 64 位十六进制`);
  }
  return value;
}

function repositoryFromPrUrl(prUrl) {
  const match = GITHUB_PR_URL_RE.exec(prUrl);
  if (!match) throw new LedgerError('PRECONDITION', `PR URL 非法: ${prUrl}`);
  return { owner: match[1], repo: match[2], prNumber: Number(match[3]), repository: `${match[1]}/${match[2]}` };
}

function equalRepository(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function resolveReceiptPath(ledgerPath, receiptPath) {
  if (typeof receiptPath !== 'string' || receiptPath.length === 0) {
    throw new LedgerError('PRECONDITION', 'pr_ready 缺 receipt 路径');
  }
  const candidates = isAbsolute(receiptPath)
    ? [receiptPath]
    : [resolve(process.cwd(), receiptPath), resolve(dirname(ledgerPath), receiptPath)];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new LedgerError('PRECONDITION', `pr_ready receipt 不存在: ${receiptPath}`);
  return path;
}

export function deriveWatchTitleFields(owner, repo, ownerTitle) {
  assertOwnerTitle(ownerTitle);
  const separator = ownerTitle.lastIndexOf('丨 ');
  if (separator <= 0 || !/^[0-9]{4}$/.test(ownerTitle.slice(separator + 2))) {
    throw new LedgerError('PRECONDITION', `owner_title 无法与 ${owner}/${repo} 的 Mini 标题规则绑定: ${ownerTitle}`);
  }
  const taskName = ownerTitle.slice(0, separator);
  const mmdd = ownerTitle.slice(separator + 2);
  if (taskName.length === 0) throw new LedgerError('PRECONDITION', 'owner_title 任务段为空');
  return { task_name: taskName, mmdd };
}

function readExecutionManifestForSignal(ledger) {
  if (typeof LedgerApi.readExecutionManifest === 'function') return LedgerApi.readExecutionManifest(ledger);
  return readManifest(ledger.manifest_path);
}

function currentEvidence({ ledgerPath, ledger, groupId }) {
  const group = findGroup(ledger, groupId);
  if (group.state !== 'pr-open') {
    throw new LedgerError('PRECONDITION', `只有本机 pr_ready 后的 pr-open 组才可发 Mini signal（当前 ${group.state}）`);
  }
  const prReadyEvent = latestGroupEvent(ledger, groupId, 'pr_ready');
  const localValidatedEvent = latestGroupEvent(ledger, groupId, 'local_validated');
  const prOpenedEvent = latestGroupEvent(ledger, groupId, 'pr_opened');
  if (!prReadyEvent || !localValidatedEvent || !prOpenedEvent) {
    throw new LedgerError('PRECONDITION', '缺真实同代 pr_ready/local_validated/pr_opened 证据，拒绝为历史 PR 自动补 signal');
  }
  const assignmentSeq = group.assignment_seq ?? 0;
  for (const [name, event] of [['pr_ready', prReadyEvent], ['local_validated', localValidatedEvent], ['pr_opened', prOpenedEvent]]) {
    if (event.detail?.assignment_seq !== assignmentSeq) {
      throw new LedgerError('PRECONDITION', `${name} 证据 assignment_seq 与当前组不一致`);
    }
  }
  if (typeof group.pr_url !== 'string' || !GITHUB_PR_URL_RE.test(group.pr_url)) {
    throw new LedgerError('PRECONDITION', '当前组缺合法 GitHub PR URL');
  }
  if (typeof group.branch !== 'string' || group.branch.length === 0) {
    throw new LedgerError('PRECONDITION', '当前组缺 branch');
  }
  requireSha(group.tip_sha, '当前组 tip_sha');
  requireNonEmptyString(group.session_id, '当前组 owner session_id');
  requireNonEmptyString(group.title, '当前组 owner title');
  const repository = repositoryFromPrUrl(group.pr_url);
  if (repository.prNumber <= 0) throw new LedgerError('PRECONDITION', 'PR number 非法');
  if (prReadyEvent.detail.pr_url !== group.pr_url || prReadyEvent.detail.current_pr_head_sha !== group.tip_sha) {
    throw new LedgerError('PRECONDITION', 'pr_ready 未绑定当前组 URL/head');
  }
  if (prOpenedEvent.detail.pr_url !== group.pr_url || prOpenedEvent.detail.headRefOid !== group.tip_sha) {
    throw new LedgerError('PRECONDITION', 'pr_opened 未绑定当前组 URL/head');
  }
  if (localValidatedEvent.detail.tip_sha !== group.tip_sha || localValidatedEvent.detail.base !== group.base
    || localValidatedEvent.detail.manifest_core_hash !== ledger.manifest_core_hash) {
    throw new LedgerError('PRECONDITION', 'local_validated 未绑定当前组提交/基线/manifest');
  }
  const receiptPath = resolveReceiptPath(ledgerPath, prReadyEvent.detail.receipt);
  const receipt = readPrOpenReceipt(receiptPath);
  if (receipt.url !== group.pr_url || receipt.number !== repository.prNumber || receipt.branch !== group.branch
    || receipt.headRefOid !== group.tip_sha || receipt.state !== 'OPEN' || receipt.isDraft !== false) {
    throw new LedgerError('PRECONDITION', 'pr_ready receipt 不是当前 OPEN 非 draft PR');
  }
  if (group.review?.unresolved !== 0) {
    throw new LedgerError('PRECONDITION', '当前组本机 review/verify 未通过，拒绝发 Mini signal');
  }
  const executionManifest = readExecutionManifestForSignal(ledger);
  const executionPacket = LedgerApi.findPacket(executionManifest, groupId);
  const executionScIds = Array.isArray(executionPacket.scs_inline)
    ? executionPacket.scs_inline.map((sc) => sc?.id).filter((id) => typeof id === 'string')
    : [];
  const groupScIds = Array.isArray(group.sc_ids) ? group.sc_ids.filter((id) => typeof id === 'string') : [];
  if (executionScIds.length === 0 || canonicalJson([...executionScIds].sort()) !== canonicalJson([...groupScIds].sort())) {
    throw new LedgerError('PRECONDITION', 'execution manifest 的当前 PR SC 集合与 ledger group.sc_ids 不一致');
  }
  const handoff = latestPrHandoffDelivery(ledger, groupId);
  const handoffScIds = Array.isArray(handoff?.scs)
    ? handoff.scs.map((sc) => sc?.sc_id ?? sc?.id).filter((id) => typeof id === 'string')
    : [];
  if (!handoff || !Array.isArray(handoff.scs) || handoff.tip_sha !== group.tip_sha
    || canonicalJson([...handoffScIds].sort()) !== canonicalJson([...executionScIds].sort())
    || handoff.scs.some((sc) => sc?.status !== 'pass') || handoff.e2e?.status !== 'pass'
    || handoff.review?.unresolved !== 0 || !['PASS', 'WARN'].includes(handoff.size_gate?.result)) {
    throw new LedgerError('PRECONDITION', '当前 PR 缺 execution manifest 对齐且全部 SC pass 的真实交卷');
  }
  const executionPlanHash = ledger.pr_plan?.plan_hash ?? null;
  if ((executionPlanHash && localValidatedEvent.detail.execution_plan_hash !== executionPlanHash)
    || (!executionPlanHash && localValidatedEvent.detail.execution_plan_hash !== undefined)) {
    throw new LedgerError('PRECONDITION', 'local_validated execution_plan_hash 与当前台账不一致');
  }
  const titleFields = deriveWatchTitleFields(repository.owner, repository.repo, group.title);
  return {
    ledger,
    group,
    repository,
    assignmentSeq,
    prReadyEvent,
    localValidatedEvent,
    prOpenedEvent,
    receipt,
    executionPlanHash,
    titleFields,
  };
}

export function readSenderRuntime(path) {
  let result = JSON.parse(readFileSync(path, 'utf8'));
  if (result.isError === true || result.ok === false) throw new LedgerError('IDENTITY', 'sender runtime 工具失败');
  if (result.structuredContent) result = result.structuredContent;
  else if (Array.isArray(result.content)) result = JSON.parse(result.content.find((item) => item.type === 'text')?.text ?? 'null');
  if (result?.ok !== true || typeof result.session_id !== 'string' || !Number.isInteger(result.generation)) {
    throw new LedgerError('IDENTITY', '须保存 get_session_runtime({}) 的真实工具回执，不接受自报 sender');
  }
  return requireSessionId(result.session_id, 'runtime session_id');
}

export function assertTaskLead({ ledgerPath, ledger, groupId, group, leadSessionId }) {
  const file = join(realpathSync(ledgerPath) + '.owners', hashObject({ groupId }) + '.json');
  if (!existsSync(file)) throw new LedgerError('IDENTITY', '缺原 owner 派窗 claim，不能证明对应任务 lead');
  const claim = JSON.parse(readFileSync(file, 'utf8'));
  const initialLead = claim.request?.message?.match(/^lead session id=([^\s]+)$/m)?.[1];
  if (claim.status !== 'bound' || claim.group_id !== groupId || claim.run_id !== ledger.run_id
    || claim.session_id !== group.session_id || claim.assignment_seq !== (group.assignment_seq ?? 0)
    || claim.manifest_core_hash !== ledger.manifest_core_hash || claim.request_hash !== hashObject(claim.request)
    || initialLead !== leadSessionId || initialLead === group.session_id
    || (claim.lead_session_id && claim.lead_session_id !== initialLead)) {
    throw new LedgerError('IDENTITY', 'sender 不是该 PR 原任务 lead，或 owner claim/代次已变化');
  }
  return claim;
}

function assertSender({ leadSessionId, senderSessionId, hostSessionId, senderRuntimePath }) {
  requireSessionId(leadSessionId, 'lead_session_id');
  requireSessionId(senderSessionId, 'sender_session_id');
  const expectedHostSessionId = senderRuntimePath ? readSenderRuntime(senderRuntimePath) : hostSessionId ?? process.env.CODEX_SESSION_ID;
  if (typeof expectedHostSessionId !== 'string' || expectedHostSessionId.length === 0) {
    throw new LedgerError('IDENTITY', '缺 sender runtime 回执或 CODEX_SESSION_ID，无法确认宿主 sender');
  }
  requireSessionId(expectedHostSessionId, 'CODEX_SESSION_ID');
  if (senderSessionId !== expectedHostSessionId || leadSessionId !== senderSessionId) {
    throw new LedgerError('IDENTITY', 'lead sender 必须是当前宿主 CODEX_SESSION_ID，且 lead_session_id 与 sender_session_id 相同');
  }
  return expectedHostSessionId;
}

export function parseLeadSignalInput(input) {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input !== 'string' || input.length === 0) {
    throw new LedgerError('ARGS', 'lead-signal 必须是 JSON 对象或 @file');
  }
  const source = input.startsWith('@') ? input.slice(1) : null;
  const text = source ? readFileSync(source, 'utf8') : input;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    throw new LedgerError('ARGS', `lead-signal JSON 解析失败: ${error.message}`);
  }
}

export function assertLeadSignalShape(signal) {
  assertExactKeys(signal, LEAD_SIGNAL_KEYS, 'lead_signal');
  if (signal.version !== LEAD_SIGNAL_VERSION) throw new LedgerError('SCHEMA', `lead_signal.version 必须是 ${LEAD_SIGNAL_VERSION}`);
  requireDigest(signal.signal_id, 'lead_signal.signal_id');
  if (signal.standing_authorization !== STANDING_AUTHORIZATION) {
    throw new LedgerError('SCHEMA', `lead_signal.standing_authorization 必须是 ${STANDING_AUTHORIZATION}`);
  }
  requireNonEmptyString(signal.group_id, 'lead_signal.group_id');
  requireNonEmptyString(signal.repository, 'lead_signal.repository');
  requireSafeInteger(signal.pr_number, 'lead_signal.pr_number', 1);
  const urlIdentity = repositoryFromPrUrl(signal.pr_url);
  if (!equalRepository(signal.repository, urlIdentity.repository) || signal.pr_number !== urlIdentity.prNumber) {
    throw new LedgerError('SCHEMA', 'lead_signal.repository/pr_number 与 pr_url 不一致');
  }
  requireNonEmptyString(signal.branch, 'lead_signal.branch');
  requireSessionId(signal.lead_session_id, 'lead_signal.lead_session_id');
  requireSessionId(signal.owner_session_id, 'lead_signal.owner_session_id');
  if (signal.lead_session_id === signal.owner_session_id) throw new LedgerError('SCHEMA', 'lead sender 不得是 owner session');
  assertOwnerTitle(signal.owner_title);
  requireSha(signal.head_sha, 'lead_signal.head_sha');
  parseTimestamp(signal.issued_at, 'lead_signal.issued_at');
  requireSafeInteger(signal.ledger_version, 'lead_signal.ledger_version');
  requireSafeInteger(signal.assignment_seq, 'lead_signal.assignment_seq');
  assertExactKeys(signal.evidence, LEAD_SIGNAL_EVIDENCE_KEYS, 'lead_signal.evidence');
  for (const key of ['pr_ready_event_at', 'local_validated_event_at', 'pr_opened_event_at']) {
    parseTimestamp(signal.evidence[key], `lead_signal.evidence.${key}`);
  }
  for (const key of ['pr_ready_digest', 'local_validated_digest', 'pr_opened_digest', 'pr_open_receipt_digest', 'manifest_core_hash']) {
    requireDigest(signal.evidence[key], `lead_signal.evidence.${key}`);
  }
  if (signal.evidence.execution_plan_hash !== null) {
    requireDigest(signal.evidence.execution_plan_hash, 'lead_signal.evidence.execution_plan_hash');
  }
  requireSha(signal.evidence.local_tip_sha, 'lead_signal.evidence.local_tip_sha');
  requireNonEmptyString(signal.evidence.base, 'lead_signal.evidence.base');
  if (signal.evidence.pr_state !== 'OPEN' || signal.evidence.pr_is_draft !== false) {
    throw new LedgerError('SCHEMA', 'lead_signal.evidence 必须绑定 OPEN 且非 draft');
  }
  assertExactKeys(signal.sender, LEAD_SIGNAL_SENDER_KEYS, 'lead_signal.sender');
  requireSessionId(signal.sender.session_id, 'lead_signal.sender.session_id');
  if (signal.sender.session_id !== signal.lead_session_id || signal.sender.role !== 'lead'
    || !['CODEX_SESSION_ID', 'get_session_runtime'].includes(signal.sender.identity_source)) {
    throw new LedgerError('SCHEMA', 'lead_signal.sender 不是 lead 的真实宿主 session 入口');
  }
  const unsigned = { ...signal };
  delete unsigned.signal_id;
  if (hashObject(unsigned) !== signal.signal_id) throw new LedgerError('REPLAY', 'lead_signal.signal_id 与内容摘要不一致');
  return signal;
}

export function assertLeadSignalForRegistration({ signal, owner, repo, prNumber, branch }) {
  const parsed = assertLeadSignalShape(parseLeadSignalInput(signal));
  if (!equalRepository(parsed.repository, `${owner}/${repo}`) || parsed.pr_number !== Number(prNumber)
    || parsed.branch !== branch) {
    throw new LedgerError('PRECONDITION', 'lead_signal 与 register 的 PR identity/branch 不一致');
  }
  return parsed;
}

export function validateLeadSignal({ ledgerPath, groupId, signal, senderSessionId, hostSessionId, senderRuntimePath, now } = {}) {
  const parsed = assertLeadSignalShape(parseLeadSignalInput(signal));
  const validationNow = now ?? new Date().toISOString();
  parseTimestamp(validationNow, 'lead-signal validation now');
  assertSender({ leadSessionId: parsed.lead_session_id, senderSessionId, hostSessionId, senderRuntimePath });
  const ledger = readLedger(ledgerPath);
  const evidence = currentEvidence({ ledgerPath, ledger, groupId });
  const { group, repository, assignmentSeq, prReadyEvent, localValidatedEvent, prOpenedEvent, receipt, executionPlanHash } = evidence;
  assertTaskLead({ ledgerPath, ledger, groupId, group, leadSessionId: parsed.lead_session_id });
  if (parsed.group_id !== groupId || !equalRepository(parsed.repository, repository.repository)
    || parsed.pr_number !== repository.prNumber || parsed.pr_url !== group.pr_url || parsed.branch !== group.branch
    || parsed.head_sha !== group.tip_sha || parsed.owner_session_id !== group.session_id || parsed.owner_title !== group.title
    || parsed.assignment_seq !== assignmentSeq || parsed.ledger_version > ledger.version) {
    throw new LedgerError('PRECONDITION', 'lead_signal 与当前 ledger/group/owner/assignment 不一致');
  }
  const expectedEvidence = {
    pr_ready_event_at: prReadyEvent.at,
    pr_ready_digest: hashObject(prReadyEvent),
    local_validated_event_at: localValidatedEvent.at,
    local_validated_digest: hashObject(localValidatedEvent),
    pr_opened_event_at: prOpenedEvent.at,
    pr_opened_digest: hashObject(prOpenedEvent),
    pr_open_receipt_digest: hashObject(receipt),
    pr_state: receipt.state,
    pr_is_draft: receipt.isDraft,
    local_tip_sha: localValidatedEvent.detail.tip_sha,
    base: localValidatedEvent.detail.base,
    manifest_core_hash: ledger.manifest_core_hash,
    execution_plan_hash: executionPlanHash,
  };
  if (canonicalJson(parsed.evidence) !== canonicalJson(expectedEvidence)) {
    throw new LedgerError('PRECONDITION', 'lead_signal evidence 摘要与当前真实 ledger/receipt 不一致');
  }
  const issuedAt = parseTimestamp(parsed.issued_at, 'lead_signal.issued_at');
  const readyAt = parseTimestamp(prReadyEvent.at, 'pr_ready.at');
  const confirmedAt = parseTimestamp(receipt.checked_at, 'pr receipt.checked_at');
  if (confirmedAt > issuedAt || issuedAt - confirmedAt > 5 * 60_000) {
    throw new LedgerError('REPLAY', '发信号前必须重新确认五分钟内的 OPEN 非 draft PR head');
  }
  if (issuedAt <= readyAt || issuedAt > parseTimestamp(validationNow, 'lead-signal validation now')) {
    throw new LedgerError('REPLAY', 'lead_signal issued_at 不在当前 pr_ready 之后且校验时间之前');
  }
  return { ok: true, signal: parsed, ledger, group, evidence };
}

export function issueLeadSignal({ ledgerPath, groupId, leadSessionId, senderSessionId, hostSessionId, senderRuntimePath, now } = {}) {
  const issuedAt = now ?? new Date().toISOString();
  parseTimestamp(issuedAt, 'lead-signal --now');
  assertSender({ leadSessionId, senderSessionId, hostSessionId, senderRuntimePath });
  const ledger = readLedger(ledgerPath);
  const evidence = currentEvidence({ ledgerPath, ledger, groupId });
  const { group, repository, assignmentSeq, prReadyEvent, localValidatedEvent, prOpenedEvent, receipt, executionPlanHash } = evidence;
  const signalWithoutId = {
    version: LEAD_SIGNAL_VERSION,
    standing_authorization: STANDING_AUTHORIZATION,
    group_id: groupId,
    repository: repository.repository,
    pr_number: repository.prNumber,
    pr_url: group.pr_url,
    branch: group.branch,
    lead_session_id: leadSessionId,
    owner_session_id: group.session_id,
    owner_title: group.title,
    head_sha: group.tip_sha,
    issued_at: issuedAt,
    ledger_version: ledger.version,
    assignment_seq: assignmentSeq,
    evidence: {
      pr_ready_event_at: prReadyEvent.at,
      pr_ready_digest: hashObject(prReadyEvent),
      local_validated_event_at: localValidatedEvent.at,
      local_validated_digest: hashObject(localValidatedEvent),
      pr_opened_event_at: prOpenedEvent.at,
      pr_opened_digest: hashObject(prOpenedEvent),
      pr_open_receipt_digest: hashObject(receipt),
      pr_state: receipt.state,
      pr_is_draft: receipt.isDraft,
      local_tip_sha: localValidatedEvent.detail.tip_sha,
      base: localValidatedEvent.detail.base,
      manifest_core_hash: ledger.manifest_core_hash,
      execution_plan_hash: executionPlanHash,
    },
    sender: { session_id: senderSessionId, role: 'lead', identity_source: senderRuntimePath ? 'get_session_runtime' : 'CODEX_SESSION_ID' },
  };
  const signal = { signal_id: hashObject(signalWithoutId), ...signalWithoutId };
  return validateLeadSignal({ ledgerPath, groupId, signal, senderSessionId, hostSessionId, senderRuntimePath, now: issuedAt });
}

function runCli(argv) {
  try {
    const flags = {};
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (!argument.startsWith('--')) throw new LedgerError('ARGS', `非法参数: ${argument}`);
      const key = argument.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new LedgerError('ARGS', `参数 --${key} 缺值`);
      flags[key] = value;
      index += 1;
    }
    const senderRuntimePath = flags['sender-runtime'];
    const senderSessionId = flags['sender-session-id'] ?? (senderRuntimePath ? readSenderRuntime(senderRuntimePath) : process.env.CODEX_SESSION_ID);
    if (!flags.ledger || !flags.group || !flags['lead-session-id'] || !senderSessionId || !flags.now) {
      throw new LedgerError('ARGS', '用法: lead-signal.mjs --ledger <path> --group <id> --lead-session-id <id> --now <ISO> [--sender-session-id <id>]');
    }
    const result = issueLeadSignal({
      ledgerPath: flags.ledger,
      groupId: flags.group,
      leadSessionId: flags['lead-session-id'],
      senderSessionId,
      hostSessionId: process.env.CODEX_SESSION_ID,
      senderRuntimePath,
      now: flags.now,
    });
    process.stdout.write(`${JSON.stringify(result.signal, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof LedgerError) {
      process.stderr.write(`lead-signal: [${error.code}] ${error.message}\n`);
    } else {
      process.stderr.write(`lead-signal: 未预期错误: ${error.message}\n`);
    }
    return 2;
  }
}

if (process.argv[1] && process.argv[1].endsWith('/lead-signal.mjs')) process.exitCode = runCli(process.argv.slice(2));

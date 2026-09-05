#!/usr/bin/env node
// T1 skill gate: recompute on-disk evidence, then CAS the existing ledger.
// This is not a host tool interceptor and cannot prove an LLM actually read text.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sha256, parseArgs, isMain } from './lib/common.mjs';
import { readLedger, findGroup, latestGroupEvent, setState, writeLedgerAtomic,
  LedgerError, readDefaults, parseTimestamp } from './run-ledger.mjs';

const GOAL = '/Users/praise/.agents/skills/goal/SKILL.md';

function teamMode(result) {
  if (!result || result.isError || result.ok === false) return null;
  if (result.worker_permission_mode) return result.worker_permission_mode;
  for (const key of ['data', 'result', 'structuredContent']) {
    const found = teamMode(result[key]); if (found) return found;
  }
  for (const part of result.content ?? []) {
    if (part.type === 'text') {
      let parsed; try { parsed = JSON.parse(part.text); } catch { continue; }
      const found = teamMode(parsed); if (found) return found;
    }
  }
  return null;
}

export function ownerGate({ ledgerPath, groupId, kind, now, teamResult, ownerModel,
  goalPath = GOAL, routingPath = readDefaults().routingPath, reason }) {
  parseTimestamp(now, 'owner-gate now');
  const ledger = readLedger(ledgerPath);
  const group = findGroup(ledger, groupId);
  if (kind === 'rework') {
    if (ledger.phase === 'ready' || !['e2e', 'review', 'accepted', 'pr-open'].includes(group.state)
      || latestGroupEvent(ledger, groupId, 'pr_ready') || latestGroupEvent(ledger, groupId, 'watch_registered')) {
      throw new LedgerError('PRECONDITION', '已移交或旧run冻结不得本机重做；只有本机验证中的同一owner可重做');
    }
    if (typeof reason !== 'string' || !reason.trim()) throw new LedgerError('ARGS', 'rework 必须说明失败证据');
    writeLedgerAtomic(ledgerPath, ledger.version, (current) => {
      const active = findGroup(current, groupId);
      active.state = 'executing'; active.tip_sha = null;
      active.review = { rounds: 0, unresolved: 0 };
      active.verify = { status: null, evidence_ref: null };
      current.events.push({ type: 'owner_rework', at: now, detail: { group_id: groupId,
        assignment_seq: group.assignment_seq ?? 0, session_id: group.session_id, reason } });
      current.version++;
      return current;
    });
    return { ok: true, kind, session_id: group.session_id, state: 'executing' };
  }
  if (kind === 'goal') {
    const hash = sha256(readFileSync(goalPath));
    if (group.state === 'executing' && latestGroupEvent(ledger, groupId, 'gate_goal')?.detail.goal_skill_sha256 === hash) {
      return { ok: true, kind, replay: true };
    }
    if (group.state !== 'dispatched') throw new LedgerError('PRECONDITION', 'goal 开工闸要求 dispatched');
    const head = spawnSync('git', ['-C', group.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const status = spawnSync('git', ['-C', group.worktree, 'status', '--porcelain'], { encoding: 'utf8' });
    const branch = spawnSync('git', ['-C', group.worktree, 'branch', '--show-current'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== group.base || status.status !== 0 || status.stdout.trim()
      || branch.status !== 0 || branch.stdout.trim() !== group.branch) {
      throw new LedgerError('PRECONDITION', 'goal 开工闸前 worktree 已变化，禁止补写收据');
    }
    setState({ ledgerPath, group: groupId, to: 'executing', now,
      detail: { goal_skill_path: goalPath, goal_skill_sha256: hash } });
    return { ok: true, kind, sha256: hash };
  }
  if (kind !== 'routing') throw new LedgerError('ARGS', 'kind 必须是 goal、routing 或 rework');
  if (!['executing', 'e2e', 'review'].includes(group.state) || !latestGroupEvent(ledger, groupId, 'gate_goal')) {
    throw new LedgerError('PRECONDITION', '派 worker 前必须已有本组 goal 开工闸');
  }
  if (teamMode(teamResult) !== 'bypassPermissions') {
    throw new LedgerError('PRECONDITION', 'start_team 实际返回必须确认 worker_permission_mode=bypassPermissions');
  }
  if (typeof ownerModel !== 'string' || !ownerModel.trim()) throw new LedgerError('ARGS', '必须提供当前 owner model 以选择 review 条件档');
  const raw = readFileSync(routingPath, 'utf8');
  const routing = JSON.parse(raw);
  const family = ownerModel.split('/').at(-1);
  const review = family.startsWith('gpt-') && routing.review?.when_lead?.gpt
    ? routing.review.when_lead.gpt : routing.review;
  const e2e = routing.e2e;
  for (const selected of [e2e, review]) for (const key of ['agent', 'model', 'effort', 'provider_id']) {
    if (typeof selected?.[key] !== 'string' || !selected[key]) throw new LedgerError('ROUTING', '现读路由缺 ' + key);
  }
  const hash = sha256(raw);
  writeLedgerAtomic(ledgerPath, ledger.version, (current) => {
    const active = findGroup(current, groupId);
    if (active.assignment_seq !== group.assignment_seq || active.session_id !== group.session_id) {
      throw new LedgerError('PRECONDITION', 'owner 身份已变化');
    }
    current.events.push({ type: 'gate_routing', at: now, detail: { group_id: groupId,
      assignment_seq: group.assignment_seq ?? 0, route_source: routingPath, routing_sha256: hash,
      e2e_model: e2e.model, review_model: review.model, worker_permission_mode: 'bypassPermissions' } });
    current.version = ledger.version + 1;
    return current;
  });
  return { ok: true, kind, routing_sha256: hash, e2e, review, worker_permission_mode: 'bypassPermissions' };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = ownerGate({ ledgerPath: args.ledger, groupId: args.group, kind: args._[0], now: args.now, reason: args.reason,
      ownerModel: args['owner-model'], teamResult: args['team-result'] ? JSON.parse(readFileSync(args['team-result'], 'utf8')) : null });
    console.log(JSON.stringify(result));
  } catch (error) { console.error('owner-gate: ' + error.message); process.exitCode = 2; }
}

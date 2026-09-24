#!/usr/bin/env node
// Skill-owned at-most-once create. No host changes, no promise of exactly-once.
// The caller executes the returned tool request ONCE and persists the real result.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withLock } from './lib/state-lock.mjs';
import { writeJsonAtomic, hashObject, sha256, isMain, parseArgs } from './lib/common.mjs';
import { readLedger, readExecutionManifest, assertManifestBound, findGroup, findPacket,
  setState, parseTimestamp, LedgerError } from './run-ledger.mjs';
import { assertHandoffComplete, handoffHash } from './vnext-owner-contract.mjs';
import { wouldCreate } from './session-dispatch.mjs';
import { checkSite } from './site-check.mjs';
import { renderScText } from './render-pr-handoff.mjs';
import { loadCollateralPolicy, renderCollateralPolicyText } from './lib/collateral.mjs';
import { findExtraStopPoints, formatStopPoints } from './lib/stop-points.mjs';
import { extractArchiveResult } from './confirm-session-archived.mjs';

function context(ledgerPath, groupId) {
  const ledger = readLedger(ledgerPath);
  const manifest = readExecutionManifest(ledger);
  assertManifestBound(ledger, manifest, 'owner-dispatch');
  const group = findGroup(ledger, groupId);
  const packet = findPacket(manifest, groupId);
  const identity = { worktree: group.worktree, branch: group.branch, base: group.base, title: group.title };
  const scope = { ledger: realpathSync(ledgerPath), run_id: ledger.run_id, group_id: groupId,
    assignment_seq: group.assignment_seq ?? 0, manifest_core_hash: ledger.manifest_core_hash, identity };
  if (ledger.pr_plan) scope.execution_plan_hash = ledger.pr_plan.plan_hash;
  return { ledger, manifest, group, packet, identity, scope, scope_hash: hashObject(scope) };
}

function claimFile(ledgerPath, groupId) {
  // Do not accept a caller-selected claim directory: changing it would evade dedup.
  return join(realpathSync(ledgerPath) + '.owners', hashObject({ groupId }) + '.json');
}

// 派窗前续跑必须已登记：owner 的 decision/blocked 只有被调度读到才会叫醒 lead。
// 2026-09-25 mivo-unlimited-import：配置绑了不存在的 lead、调度卡在 pending-receipt，owner 停下无人知道。
export function assertContinuationRegistered(ledgerPath) {
  const dir = dirname(realpathSync(ledgerPath));
  const configPath = join(dir, 'lead-continuation.json');
  const schedulePath = join(dir, 'lead-continuation-schedule.json');
  const read = (path, what) => {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
      throw new LedgerError('CONTINUATION_MISSING', `派窗前必须先登记整包续跑（${what}: ${path} 读取失败: ${err.message}）`);
    }
  };
  const config = read(configPath, 'lead-continuation.json');
  if (typeof config.lead_session_id !== 'string' || !config.lead_session_id.trim()) {
    throw new LedgerError('CONTINUATION_MISSING', 'lead-continuation.json 缺 lead_session_id');
  }
  if (config.schemaVersion !== 2 && !(config.ledger_paths ?? []).includes(realpathSync(ledgerPath))) {
    throw new LedgerError('CONTINUATION_MISSING', 'lead-continuation.json 的 ledger_paths 未包含本台账');
  }
  const schedule = read(schedulePath, 'lead-continuation-schedule.json');
  if (schedule.ok !== true || schedule.status !== 'active' || schedule.executionMode !== 'script'
    || typeof schedule.command !== 'string' || !schedule.command.includes('lead-continuation.py')
    || !schedule.command.includes(configPath)) {
    throw new LedgerError('CONTINUATION_MISSING', `续跑调度回执不是指向 ${configPath} 的 active script 调度`);
  }
  return { config_path: configPath, schedule_id: schedule.id };
}

export function prepareOwner({ ledgerPath, groupId, handoffPath, sitePath, now }) {
  parseTimestamp(now, 'prepare-owner now');
  const file = claimFile(ledgerPath, groupId);
  return withLock(file + '.lock', () => {
    const ctx = context(ledgerPath, groupId);
    const site = checkSite(ctx.manifest, JSON.parse(readFileSync(sitePath, 'utf8')));
    const text = readFileSync(handoffPath, 'utf8');
    const hash = handoffHash(text);
    if (ctx.ledger.pr_plan && !text.split('\n').includes('execution_plan_hash=' + ctx.ledger.pr_plan.plan_hash)) {
      throw new LedgerError('PACKET_STALE', '开工包未绑定当前 PR 归属');
    }
    if (ctx.packet.stages && !text.split('\n').includes(JSON.stringify(ctx.packet.stages))) {
      throw new LedgerError('PACKET_INCOMPLETE', '开工包阶段顺序或阶段授权不符');
    }
    let retired = [];
    if (existsSync(file)) {
      const prior = JSON.parse(readFileSync(file, 'utf8'));
      if (prior.status === 'retired' && ctx.scope.assignment_seq > prior.assignment_seq) {
        const { retired: history = [], ...entry } = prior;
        retired = [...history, entry];
      } else {
        if (prior.status === 'retired' || prior.scope_hash !== ctx.scope_hash || prior.handoff_hash !== hash) {
          throw new LedgerError('OWNER_CONFLICT', '已有派工记录与当前身份/开工包不同；不得换代、换目录绕过，须先裁决原 owner');
        }
        if (prior.session_id) return { action: 'resume', session_id: prior.session_id, claim_file: file };
        throw new LedgerError('UNKNOWN_CREATE_RESULT', '本 PR 已发放一次 create 请求但无持久回执；禁止自动再次 create，须核对原工具结果');
      }
    }
    if (ctx.group.state !== 'pending' || ctx.group.session_id) {
      throw new LedgerError('PRECONDITION', '只能为没有 session_id 的 pending PR 首次派窗');
    }
    const ownWave = ctx.ledger.waves.find((wave) => wave.groups.some((g) => g.group_id === groupId));
    const firstWave = ctx.ledger.waves.filter((wave) => wave.integrated_tip === null).sort((a, b) => a.wave - b.wave)[0];
    if (ownWave !== firstWave) throw new LedgerError('PRECONDITION', '前波尚未集成，禁止提前为下游创建 session');
    for (const other of ctx.ledger.waves.flatMap((wave) => wave.groups)) {
      if (other.group_id === groupId || !other.worktree) continue;
      if (other.branch === ctx.identity.branch || (existsSync(other.worktree)
        && realpathSync(other.worktree) === realpathSync(ctx.identity.worktree))) {
        throw new LedgerError('OWNER_CONFLICT', '不同 PR 不得共用分支或 worktree');
      }
    }
    const git = (args) => {
      const r = spawnSync('git', ['-C', ctx.identity.worktree, ...args], { encoding: 'utf8' });
      if (r.status !== 0) throw new LedgerError('PRECONDITION', 'owner worktree 无法校验');
      return r.stdout.trim();
    };
    if (git(['rev-parse', 'HEAD']) !== ctx.identity.base
      || git(['branch', '--show-current']) !== ctx.identity.branch
      || git(['status', '--porcelain'])) {
      throw new LedgerError('PRECONDITION', '派窗前必须已有干净的独立 worktree，HEAD/base/branch 一致');
    }
    assertHandoffComplete(text, { title: ctx.identity.title, worktree: ctx.identity.worktree,
      verify_cmds: ctx.packet.verify_cmds });
    // 手改过的开工包同样不得夹带五类停以外的停点（渲染器之外的补充也要拦）
    const extraStops = findExtraStopPoints(text);
    const forbiddenStops = (text.split('## 9. 禁做\n')[1]?.split('\n## 10.')[0] ?? '')
      .split('\n').flatMap((line) => findExtraStopPoints(line, { forbiddenItem: true }));
    if (extraStops.length || forbiddenStops.length) {
      throw new LedgerError('PACKET_EXTRA_STOP', formatStopPoints('开工包', [...extraStops, ...forbiddenStops]));
    }
    assertContinuationRegistered(ledgerPath);
    const section = (heading, next) => text.split('## ' + heading + '\n')[1]?.split('\n## ' + next)[0]?.trim();
    // 第 5 段 = 写域清单逐字，或「写域清单 + 空行 + 当前 config/collateral.json 渲染的连带策略原文」；
    // 连带策略被改写同样拒（防用第 5 段偷扩授权），旧开工包（无连带策略）仍按原样放行。
    const allowedBlock = ctx.packet.allowed_paths.map((p) => '- ' + p).join('\n');
    const section5 = section('5. allowed_paths', '6. SC 全文');
    const section5Ok = section5 === allowedBlock
      || section5 === [allowedBlock, '', renderCollateralPolicyText(loadCollateralPolicy())].join('\n');
    if (section('6. SC 全文', '7. 验证命令') !== renderScText(ctx.packet)
      || section('7. 验证命令', '8. 做完之后') !== ctx.packet.verify_cmds.join('\n').trim()
      || !section5Ok) {
      throw new LedgerError('PACKET_INCOMPLETE', '开工包 SC 全文/优先级/命令/授权路径与 final 不一致');
    }
    const witnesses = [...text.matchAll(/^source_sha256\((.+)\)=([0-9a-f]{64})$/gm)];
    if (!witnesses.length) throw new LedgerError('PACKET_INCOMPLETE', '开工包缺现场文件指纹，请用 renderer 重新出包');
    for (const [, path, expected] of witnesses) {
      const abs = realpathSync(resolve(ctx.identity.worktree, path));
      const rel = relative(realpathSync(ctx.identity.worktree), abs);
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
        || sha256(readFileSync(abs)) !== expected) throw new LedgerError('PACKET_STALE', '开工包现场已变化或越界，必须重新核对: ' + path);
    }
    for (const literal of [
      '对照树（只读）=' + ctx.identity.worktree,
      '开发基线 SHA=' + ctx.identity.base,
      '新分支名=' + ctx.identity.branch,
      'session 标题=' + ctx.identity.title,
      ...ctx.packet.scs_inline.map((sc) => 'id=' + sc.id),
      ...ctx.packet.allowed_paths.map((p) => '- ' + p),
    ]) {
      if (!text.split('\n').some((line) => line === literal || line === '- ' + literal)) {
        throw new LedgerError('PACKET_INCOMPLETE', '开工包与当前分组身份/SC/路径不符: ' + literal);
      }
    }
    const root = fileURLToPath(new URL('../', import.meta.url));
    const protocol = readFileSync(join(root, 'references/owner-protocol.md'), 'utf8');
    const bindings = '\n\n执行绑定（不得替换）：\n' + JSON.stringify({ skill_root: root,
      ledger: realpathSync(ledgerPath), manifest: ctx.ledger.manifest_path, group_id: groupId,
      assignment_seq: ctx.group.assignment_seq ?? 0, handoff_hash: hash }, null, 2);
    const request = { ...wouldCreate({ title: ctx.identity.title, working_dir: ctx.identity.worktree }),
      // Already isolated at the exact base; do not ask host to create a different tree.
      use_worktree: false, message: text + bindings + '\n\n' + protocol };
    const claim = { schema: 1, ...ctx.scope, scope_hash: ctx.scope_hash,
      claim_id: randomUUID(), site_hash: site.site_hash, handoff_hash: hash, request_hash: hashObject(request),
      status: 'call_started', call_started_at: now, session_id: null, retired, request };
    writeJsonAtomic(file, claim);
    return { action: 'create_once', claim_file: file, claim_id: claim.claim_id,
      handoff_hash: hash, tool: 'send_to_session', args: request };
  });
}

export function extractSessionId(result) {
  if (!result || typeof result !== 'object' || result.isError === true || result.ok === false) return null;
  const ids = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (value.isError === true || value.ok === false) throw new LedgerError('RECEIPT', '工具结果含失败标记');
    for (const key of ['target_session_id', 'targetSessionId']) {
      if (typeof value[key] === 'string' && value[key].trim()) ids.add(value[key]);
    }
    for (const key of ['data', 'result', 'structuredContent']) visit(value[key], depth + 1);
    if (Array.isArray(value.content)) for (const item of value.content) {
      if (item.type === 'text') { let parsed; try { parsed = JSON.parse(item.text); } catch { continue; } visit(parsed, depth + 1); }
    }
  };
  visit(result);
  if (ids.size !== 1) return null;
  return [...ids][0];
}

export function bindOwner({ ledgerPath, groupId, claimId, result, now }) {
  parseTimestamp(now, 'bind-owner now');
  const sessionId = extractSessionId(result);
  if (!sessionId) throw new LedgerError('UNKNOWN_CREATE_RESULT', '工具结果没有唯一 target session id；保留 claim，不得重发');
  const file = claimFile(ledgerPath, groupId);
  return withLock(file + '.lock', () => {
    const claim = JSON.parse(readFileSync(file, 'utf8'));
    const ctx = context(ledgerPath, groupId);
    if (claim.status === 'retired' || claim.claim_id !== claimId || claim.scope_hash !== ctx.scope_hash
      || (claim.session_id && claim.session_id !== sessionId)
      || (ctx.group.session_id && ctx.group.session_id !== sessionId)) {
      throw new LedgerError('OWNER_CONFLICT', '回执与原 claim/当前分组不同，拒绝改绑');
    }
    // Persist the result BEFORE ledger mutation. A crash can resume this binding,
    // never repeat the external create. Other groups' ledger writes are harmless.
    writeJsonAtomic(file, { ...claim, status: 'result_saved', session_id: sessionId,
      result_hash: hashObject(result), received_at: now });
    if (!ctx.group.session_id) {
      setState({ ledgerPath, group: groupId, now,
        identity: { ...ctx.identity, session_id: sessionId } });
    }
    const bound = { ...claim, status: 'bound', session_id: sessionId,
      result_hash: hashObject(result), received_at: now };
    writeJsonAtomic(file, bound);
    return { action: 'bound', session_id: sessionId, claim_file: file };
  });
}

export function retireOwner({ ledgerPath, groupId, claimId, result, now }) {
  parseTimestamp(now, 'retire-owner now');
  const file = claimFile(ledgerPath, groupId);
  return withLock(file + '.lock', () => {
    const claim = JSON.parse(readFileSync(file, 'utf8'));
    if (claim.claim_id !== claimId || !claim.session_id) {
      throw new LedgerError('UNKNOWN_CREATE_RESULT', '只允许凭真实归档回执退役已知 owner；未知 create 不得解锁');
    }
    extractArchiveResult(result, claim.session_id);
    writeJsonAtomic(file, { ...claim, status: 'retired', retired_at: now,
      archive_result_hash: hashObject(result) });
    return { action: 'retired', session_id: claim.session_id, claim_file: file };
  });
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = { ledgerPath: resolve(args.ledger), groupId: args.group, now: args.now };
    let result;
    if (args._[0] === 'prepare') result = prepareOwner({ ...input, handoffPath: resolve(args.handoff), sitePath: resolve(args.site) });
    else if (args._[0] === 'bind') result = bindOwner({ ...input, claimId: args['claim-id'],
      result: JSON.parse(readFileSync(args.result, 'utf8')) });
    else if (args._[0] === 'retire') result = retireOwner({ ...input, claimId: args['claim-id'],
      result: JSON.parse(readFileSync(args.result, 'utf8')) });
    else throw new Error('用法: owner-dispatch prepare|bind|retire --ledger --group --now；prepare --handoff；bind --claim-id --result');
    console.log(JSON.stringify(result));
  } catch (error) { console.error('owner-dispatch: ' + error.message); process.exitCode = 2; }
}

#!/usr/bin/env node
// session-watch.mjs — Mini 零 LLM 探测：复用 gate + gh-snapshot。
// 不调 engine / cindy-dispatch / queue-transport，不 merge。
// Mini Cindy 调度（人手建一次，不要 resume config/mini-watch.json 的 old_schedule_ids_blocklist）：
//   name/agent/model/effort/provider 全部从 hosts.mini 读
//   capabilities=["sessions.dispatch"]
//   command: python3 scripts/pr-watch/session-watch-script.py
//   env: AE_WATCH_STATE_DIR / AE_WATCH_SNAPSHOT_CMD 按同一配置
// 调度跑 Python 包装：探测零 token，create 必须把 target_session_id 写回名册，之后 jump。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs, fail, isMain, writeJsonAtomic, readJson, nowIso } from '../lib/common.mjs';
import { loadMiniWatchConfig, miniHost, assertAutoMergeDisabled } from '../lib/mini-watch-config.mjs';
import { evaluate, emptyCursors } from './gate.mjs';
import { stateFileName, migrateAllLegacyStateFiles, STATE_FILE_NAME_RE, unregisterPr, identityMatches } from './register.mjs';
import { withLock } from '../lib/state-lock.mjs';
import { sessionTitle, titlePrefixForRepo } from '../session-dispatch.mjs';
import { watchTaskName, mmddFromDate } from '../vnext-owner-contract.mjs';

const _mini = miniHost();
export const MINI_WATCH_PROVIDER = _mini.provider_id;
export const MINI_WATCH_MODEL = _mini.model;
export const MINI_WATCH_AGENT = _mini.agent_kind;
export const MINI_WATCH_EFFORT = _mini.effort;
export const OLD_WATCH_SCHEDULE_IDS = Object.freeze([
  ...loadMiniWatchConfig().old_schedule_ids_blocklist,
]);

// create 是「先落本地 claim、再调外部 sessions.dispatch」的两阶段动作。
// 进程若在 dispatch 返回前崩溃，旧版只留下 create_pending=true，后续每轮
// 永久拒绝重试。claim 现在带时间戳和 pid；只有 claim 已过租约且原持有进程
// 已死亡才允许回收，活进程绝不因超时被第二轮抢占（fail-closed）。script-mode
// 通过 CLI 调 Node helper 时，调用方必须传入长驻 Python 进程 pid（ownerPid），
// 否则短命 helper 退出会被误判为崩溃并放开重复 create。
export const CREATE_CLAIM_TTL_MS = 10 * 60_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

function claimAgeMs(claim, nowMs) {
  if (!claim || typeof claim !== 'object') return null;
  const t = Date.parse(claim.claimed_at);
  if (!Number.isFinite(t)) return null;
  return nowMs - t;
}

export function createClaimStale(claim, { nowMs = Date.now(), ttlMs = CREATE_CLAIM_TTL_MS } = {}) {
  const age = claimAgeMs(claim, nowMs);
  if (age === null || age < ttlMs) return false;
  if (!Number.isInteger(claim.owner_pid) || claim.owner_pid <= 0) return false;
  // 时间戳来自本地时钟；未来时间不能被当成已过期。pid 必须明确死亡，
  // 否则即使租约超时也拒绝回收，避免长 dispatch 被重复 create。
  return !pidAlive(claim.owner_pid);
}

function runSnapshot(snapshotCmd, owner, repo, pr) {
  const parts = snapshotCmd.split(' ').map((p) =>
    p.replace('{owner}', owner).replace('{repo}', repo).replace('{pr}', String(pr)));
  return JSON.parse(execFileSync(parts[0], parts.slice(1), { encoding: 'utf8' }));
}

export function planDispatch({ decision, state, signals, newItems, watchConfig, gatewayAvailable } = {}) {
  assertAutoMergeDisabled(watchConfig);
  if (decision === 'none' || decision === 'blocked-external') return null;
  if (decision === 'terminal') {
    return { action: 'unregister', owner: state.owner, repo: state.repo, pr: state.pr_number };
  }
  if (decision !== 'actionable') return null;
  const sessionId = typeof state.session_id === 'string' && state.session_id.length > 0
    ? state.session_id
    : null;
  // Planning is not dispatch: the caller must acquire the skill claim first.
  const mini = miniHost();
  return {
    action: sessionId ? 'jump' : 'create',
    wake_kind: sessionId ? 'jump' : 'create',
    owner: state.owner,
    repo: state.repo,
    pr: state.pr_number,
    session_id: sessionId,
    signals,
    newItems,
    title: sessionTitle({
      project: titlePrefixForRepo(`${state.owner}/${state.repo}`),
      task: watchTaskName(state.pr_number, state.task_name),
      mmdd: typeof state.mmdd === 'string' && /^\d{4}$/.test(state.mmdd) ? state.mmdd : mmddFromDate(),
    }),
    provider_id: mini.provider_id,
    model: mini.model,
    agent_kind: mini.agent_kind,
    effort: mini.effort,
  };
}

export function buildDispatchMessage(plan) {
  const bodies = [];
  for (const r of plan.newItems?.reviews ?? []) bodies.push(`review ${r.id}: ${r.body}`);
  for (const c of plan.newItems?.comments ?? []) bodies.push(`comment ${c.id}: ${c.body}`);
  return [
    `PR ${plan.owner}/${plan.repo}#${plan.pr} 有新反馈（${(plan.signals ?? []).join('/')}）。`,
    '第一步：在名册 clone 里 git worktree add，不要在调度 workingDir 改代码。',
    '用 goal skill 场景 E（盯梢 pr-fix）修到可合为止。merge 由人点；禁止调用 GitHub 合并。',
    ...bodies,
  ].join('\n');
}

export function sessionsDispatchParams(plan) {
  const params = {
    message: buildDispatchMessage(plan),
    title: plan.title,
  };
  if (plan.session_id) params.target_session_id = plan.session_id;
  return params;
}

export function bindSessionId({ stateDir, owner, repo, prNumber, sessionId, claimId = null }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('bindSessionId 缺 sessionId');
  }
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  return withLock(`${file}.lock`, () => {
    const state = readJson(file);
    if (stateFileName(state.owner, state.repo, state.pr_number) !== stateFileName(owner, repo, prNumber)) {
      throw new Error('bindSessionId 身份不符');
    }
    if (claimId !== null && state.create_claim?.claim_id !== claimId) {
      throw new Error(`bindSessionId claim 不符（当前 ${state.create_claim?.claim_id ?? '无'}，收到 ${claimId}）`);
    }
    if (state.session_id && state.session_id !== sessionId) {
      throw new Error(`已绑定 ${state.session_id}，拒绝改绑 ${sessionId}`);
    }
    const next = { ...state, session_id: sessionId, create_pending: false, create_claim: null };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function claimCreate({ stateDir, owner, repo, prNumber, nowMs = Date.now(), ttlMs = CREATE_CLAIM_TTL_MS, ownerPid = process.pid }) {
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  return withLock(`${file}.lock`, () => {
    const state = readJson(file);
    if (stateFileName(state.owner, state.repo, state.pr_number) !== stateFileName(owner, repo, prNumber)) {
      throw new Error('claimCreate 身份不符');
    }
    if (typeof state.session_id === 'string' && state.session_id.length > 0) {
      return { claimed: false, session_id: state.session_id, state };
    }
    if (state.create_pending === true) {
      const claim = state.create_claim;
      // A dead process does not prove the external create failed. Never reclaim.
      if (state.create_pending) {
        const detail = claim?.claim_id ? `（claim ${claim.claim_id} 结果未完成绑定，禁止按超时回收）` : '（旧版 claim 缺少可安全恢复的租约凭据）';
        throw new Error(`${owner}/${repo}#${prNumber} 已有 create 在途${detail}，拒绝并发再建`);
      }
    }
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
      throw new Error(`claimCreate ownerPid 非法（须正整数，got ${JSON.stringify(ownerPid)}）`);
    }
    const next = {
      ...state,
      create_pending: true,
      create_claim: {
        claim_id: randomBytes(12).toString('hex'),
        claimed_at: new Date(nowMs).toISOString(),
        owner_pid: ownerPid,
      },
    };
    writeJsonAtomic(file, next);
    return { claimed: true, session_id: null, state: next };
  });
}

export function releaseCreateClaim({ stateDir, owner, repo, prNumber, claimId = null }) {
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  return withLock(`${file}.lock`, () => {
    const state = readJson(file);
    if (state.create_pending !== true && !state.create_claim) return state;
    if (claimId !== null && state.create_claim?.claim_id !== claimId) {
      // A late failure from an older dispatch must not clear a newer claim
      // recovered after a crash (ABA protection).
      return state;
    }
    const next = { ...state, create_pending: false, create_claim: null };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function scanWatch({ stateDir, snapshotCmd, hmacKey = null, gatewayAvailable } = {}) {
  if (!existsSync(stateDir)) return { scanned: 0, dispatches: [], terminals: [] };
  migrateAllLegacyStateFiles(stateDir, null);
  const files = readdirSync(stateDir).filter((f) =>
    STATE_FILE_NAME_RE.test(f) && !f.startsWith('manifest-') && !f.startsWith('receipt-'));
  const dispatches = [];
  const terminals = [];
  const observed = [];
  for (const f of files) {
    let state;
    try { state = JSON.parse(readFileSync(join(stateDir, f), 'utf8')); } catch { continue; }
    if (stateFileName(state.owner, state.repo, state.pr_number) !== f) continue;
    let snapshot;
    try {
      snapshot = runSnapshot(snapshotCmd, state.owner, state.repo, state.pr_number);
    } catch {
      continue;
    }
    try {
      acknowledgeFirstScan({
        stateDir,
        owner: state.owner,
        repo: state.repo,
        prNumber: state.pr_number,
      });
    } catch {
      // State may have been concurrently unregistered or replaced. Do not
      // dispatch from a scan whose durable first-scan receipt was not written.
      continue;
    }
    const res = evaluate(state.cursors ?? emptyCursors(), snapshot, { hmacKey });
    let plan;
    try {
      plan = planDispatch({
        decision: res.decision, state, signals: res.signals, newItems: res.newItems, gatewayAvailable,
      });
    } catch (err) {
      if (err?.code === 'HOST_GATEWAY_MISSING') continue;
      throw err;
    }
    if (!plan) { observed.push({ owner: state.owner, repo: state.repo, pr: state.pr_number }); continue; }
    if (plan.action === 'unregister') {
      terminals.push(plan);
      continue;
    }
    plan.message = buildDispatchMessage(plan);
    plan.next_cursors = res.cursors;
    dispatches.push(plan);
    observed.push({ owner: state.owner, repo: state.repo, pr: state.pr_number });
  }
  return { scanned: files.length, dispatches, terminals, observed };
}

export function persistCursors({ stateDir, owner, repo, prNumber, cursors }) {
  if (!cursors || typeof cursors !== 'object' || Array.isArray(cursors)) {
    throw new Error('persistCursors 缺 cursors');
  }
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  return withLock(`${file}.lock`, () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) {
      throw new Error('persistCursors 身份不符');
    }
    const next = { ...state, cursors };
    writeJsonAtomic(file, next);
    return next;
  });
}

// Script-mode 没有 engine.mjs 的首扫写口；成功取得并解析快照后由本脚本
// 固化要素④。只写本 PR、只补空值，且经同一把 per-key 锁复核身份，避免
// 注册回执把「Mini 实际没扫到该 PR」误判为已接单。
export function acknowledgeFirstScan({ stateDir, owner, repo, prNumber, at = nowIso() }) {
  const file = join(stateDir, stateFileName(owner, repo, prNumber));
  return withLock(`${file}.lock`, () => {
    const state = readJson(file);
    if (!identityMatches(state, owner, repo, prNumber)) {
      throw new Error('acknowledgeFirstScan 身份不符');
    }
    if (state.first_scan_ack) return state;
    const next = { ...state, first_scan_ack: at };
    writeJsonAtomic(file, next);
    return next;
  });
}

export function applyWatchRound({
  stateDir,
  snapshotCmd,
  hmacKey = null,
  dispatchFn,
  unregisterFn = unregisterPr,
  gatewayAvailable,
}) {
  if (typeof dispatchFn !== 'function') {
    throw new Error('applyWatchRound 缺 dispatchFn（create 后必须能拿到 session_id）');
  }
  const scan = scanWatch({ stateDir, snapshotCmd, hmacKey, gatewayAvailable });
  const applied = [];
  const errors = [];
  for (const plan of scan.dispatches) {
    try {
      let livePlan = plan;
      let createClaimId = null;
      if (plan.action === 'create') {
        const claim = claimCreate({
          stateDir,
          owner: plan.owner,
          repo: plan.repo,
          prNumber: plan.pr,
        });
        if (!claim.claimed) {
          livePlan = { ...plan, action: 'jump', wake_kind: 'jump', session_id: claim.session_id };
        } else {
          createClaimId = claim.state?.create_claim?.claim_id ?? null;
        }
      }
      const params = sessionsDispatchParams(livePlan);
      let result;
      try {
        result = dispatchFn(params) ?? {};
      } catch (err) {
        // The host may already have created a session: retain the durable claim.
        throw err;
      }
      const sessionId = typeof result.target_session_id === 'string' && result.target_session_id.length > 0
        ? result.target_session_id
        : null;
      if (livePlan.action === 'create') {
        if (!sessionId) {
          // An empty receipt is ambiguous, not permission to create again.
          throw new Error(`create ${livePlan.owner}/${livePlan.repo}#${livePlan.pr} 未返回 target_session_id，拒绝空跑`);
        }
        bindSessionId({
          stateDir,
          owner: livePlan.owner,
          repo: livePlan.repo,
          prNumber: livePlan.pr,
          sessionId,
          claimId: createClaimId,
        });
      } else if (livePlan.action === 'jump') {
        const file = join(stateDir, stateFileName(livePlan.owner, livePlan.repo, livePlan.pr));
        const live = readJson(file);
        if (live.session_id && live.session_id !== (sessionId ?? livePlan.session_id)) {
          throw new Error(`jump ${livePlan.owner}/${livePlan.repo}#${livePlan.pr} 名册已绑 ${live.session_id}，拒绝 ${sessionId ?? livePlan.session_id}`);
        }
      }
      if (livePlan.next_cursors) {
        persistCursors({
          stateDir,
          owner: livePlan.owner,
          repo: livePlan.repo,
          prNumber: livePlan.pr,
          cursors: livePlan.next_cursors,
        });
      }
      applied.push({
        ...livePlan,
        session_id: sessionId ?? livePlan.session_id,
      });
    } catch (error) {
      errors.push({ owner:plan.owner, repo:plan.repo, pr:plan.pr, error:error.message });
    }
  }
  const unregistered = [];
  for (const term of scan.terminals) {
    const out = unregisterFn({
      stateDir,
      owner: term.owner,
      repo: term.repo,
      prNumber: term.pr,
      reason: 'terminal',
    });
    unregistered.push({ ...term, removed: out?.removed !== false });
  }
  return {
    scanned: scan.scanned,
    dispatches: applied,
    errors,
    terminals: scan.terminals,
    unregistered,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'bind') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args['session-id']) {
      fail('用法: session-watch.mjs bind --state-dir <dir> --owner <o> --repo <r> --pr <N> --session-id <id>');
    }
    bindSessionId({
      stateDir: args['state-dir'],
      owner: args.owner,
      repo: args.repo,
      prNumber: args.pr,
      sessionId: args['session-id'],
      claimId: args['claim-id'],
    });
    process.stdout.write('BOUND\n');
  } else if (cmd === 'persist-cursors') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr || !args.cursors) {
      fail('用法: session-watch.mjs persist-cursors --state-dir <dir> --owner <o> --repo <r> --pr <N> --cursors <json>');
    }
    persistCursors({
      stateDir: args['state-dir'],
      owner: args.owner,
      repo: args.repo,
      prNumber: args.pr,
      cursors: JSON.parse(args.cursors),
    });
    process.stdout.write('CURSORS\n');
  } else if (cmd === 'unregister') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr) {
      fail('用法: session-watch.mjs unregister --state-dir <dir> --owner <o> --repo <r> --pr <N>');
    }
    const out = unregisterPr({
      stateDir: args['state-dir'],
      owner: args.owner,
      repo: args.repo,
      prNumber: args.pr,
      reason: args.reason ?? 'terminal',
    });
    process.stdout.write(out.removed ? 'UNREGISTERED\n' : 'NOT-FOUND\n');
  } else if (cmd === 'claim-create') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr) {
      fail('用法: session-watch.mjs claim-create --state-dir <dir> --owner <o> --repo <r> --pr <N>');
    }
    const out = claimCreate({
      stateDir: args['state-dir'],
      owner: args.owner,
      repo: args.repo,
      prNumber: args.pr,
      ownerPid: args['owner-pid'] === undefined ? process.pid : Number(args['owner-pid']),
    });
    process.stdout.write(`${JSON.stringify({
      claimed: out.claimed,
      session_id: out.session_id,
      claim_id: out.state?.create_claim?.claim_id ?? null,
    })}\n`);
  } else if (cmd === 'release-create') {
    if (!args['state-dir'] || !args.owner || !args.repo || !args.pr) {
      fail('用法: session-watch.mjs release-create --state-dir <dir> --owner <o> --repo <r> --pr <N>');
    }
    releaseCreateClaim({
      stateDir: args['state-dir'],
      owner: args.owner,
      repo: args.repo,
      prNumber: args.pr,
      claimId: args['claim-id'] ?? null,
    });
    process.stdout.write('RELEASED\n');
  } else {
    if (!args['state-dir'] || !args['snapshot-cmd']) {
      fail('用法: session-watch.mjs --state-dir <dir> --snapshot-cmd "<cmd>"');
    }
    const out = scanWatch({
      stateDir: args['state-dir'],
      snapshotCmd: args['snapshot-cmd'],
      hmacKey: process.env.PR_AUTOPILOT_HMAC_KEY ?? null,
      gatewayAvailable: process.env.AE_WATCH_ALLOW_CREATE === '1' ? true : undefined,
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
}

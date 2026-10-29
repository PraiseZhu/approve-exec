#!/usr/bin/env node
// issue-run.mjs — issue 入口的小台账（issue-run-v1）：每个子 issue 一条，记录派发、owner 收口、lead 验收与收尾。
// lead 自己调 send_to_session / archive_sessions；本脚本只出请求、收回执、改台账，不调用任何宿主工具。
// 跨台账、跨机器的防重靠子 issue 自己评论区里的标记：prepare 发「批准执行认领」，bind 成功发「批准执行登记」，
// release 发「批准执行释放」。只认当前 gh 账号发的标记。同一子 issue 有未释放的认领 / 登记时，
// 任何台账、任何入口（总 issue 或子 issue）的 prepare 都拒绝；两个 lead 同时认领时，评论 id 小的胜出，
// 后到的一方发释放评论让位。
//
// 状态：pending → claimed → dispatched → awaiting_acceptance →（verdict）accepted | revising →
//       ready → cleaned → archived；dispatch_unknown、blocked_user 是停点；closed 是计划时就已关闭。
//
// CLI（全部输出一行 JSON；exit 0 成功 / 2 拒绝）：
//   init       --plan <plan.json> --ledger <ledger.json> [--now ISO]
//   next       --ledger <f> [--gh-fixture <夹具>]                      可派的子 issue 与 run 状态
//   prepare    --ledger <f> --item <ref> --lead-session <id> [--now ISO] [--gh-fixture <夹具>]
//   bind       --ledger <f> --item <ref> --claim <id> --result <send_to_session 回执 JSON 文件> [--now ISO] [--gh-fixture <夹具>]
//   release    --ledger <f> --item <ref> --evidence <已核实没有建出会话的依据> [--now ISO] [--gh-fixture <夹具>]
//   checkpoint --ledger <f> --item <ref> --state awaiting_acceptance|ready|blocked_user
//              [--pr <号>] [--head <40 位 sha>] [--sc <JSON 数组>] [--keel-run <id>] [--lane <车道>] [--reason <文字>] [--now ISO]
//   verdict    --ledger <f> --item <ref> (--pass --check <accept-check 输出 JSON 文件> | --revise <要改的条目>) [--now ISO]
//   unblock    --ledger <f> --item <ref> --note <用户怎么处理的> [--now ISO]
//   cleanup    --ledger <f> --item <ref> [--now ISO] [--gh-fixture <夹具>]
//   archived   --ledger <f> --item <ref> --result <archive_sessions 回执 JSON 文件> [--now ISO]
//   status     --ledger <f>
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashObject, isMain, nowIso, parseArgs, readJson, writeJsonAtomic } from './lib/common.mjs';
import { withLock } from './lib/state-lock.mjs';
import { ghRunner, readIssue, parseIssueRef, PLAN_SCHEMA } from './issue-plan.mjs';
import { renderIssueHandoff } from './render-issue-handoff.mjs';

export const LEDGER_SCHEMA = 'issue-run-v1';
export const ITEM_STATES = Object.freeze([
  'pending', 'claimed', 'dispatched', 'dispatch_unknown',
  'awaiting_acceptance', 'revising', 'accepted', 'ready', 'cleaned', 'archived',
  'blocked_user', 'closed',
]);
export const REQUEST_KEYS = Object.freeze(['title', 'message', 'working_dir', 'use_worktree']);
export const MAX_REVISE_ROUNDS = 2; // 第 3 次判「要改」就停下找用户
export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const SC_STATUSES = ['pass', 'fail', 'not_run', 'manual'];
const SHA_RE = /^[0-9a-f]{40}$/;
const IN_FLIGHT = ['claimed', 'dispatched', 'dispatch_unknown', 'awaiting_acceptance', 'revising', 'accepted', 'ready', 'cleaned'];
const DONE = ['archived', 'closed'];

export class RunError extends Error {
  constructor(message) {
    super(message);
    this.code = 'RUN';
  }
}
const reject = (msg) => { throw new RunError(msg); };

// helpers

const PROJECT_PREFIX = Object.freeze({
  'xindong/mivo-canvas-plugin': 'MivoPlugin',
  'xindong/mivo-canvas': 'MivoCanvas',
  'makecindy/cindy': 'Cindy',
});
const HAN_RE = /\p{Script=Han}/u;

export function projectName(repo) {
  if (PROJECT_PREFIX[repo]) return PROJECT_PREFIX[repo];
  const name = repo.split('/').pop().replace(/^project-/i, '');
  return name.split(/[-_.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

/** 会话标题 {项目名}-{中文任务名}丨 {MMDD}，日期按 Asia/Shanghai。 */
export function sessionTitle(item, now) {
  let task = item.title.replace(/^\[(子\d+\/\d+|总)\]\s*/, '').split(/[：:]/)[0].trim().slice(0, 24);
  if (!HAN_RE.test(task)) task = `任务${item.number}`;
  return `${projectName(item.repo)}-${task}丨 ${mmdd(now)}`;
}

function mmdd(now) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  return `${parts.find((p) => p.type === 'month').value}${parts.find((p) => p.type === 'day').value}`;
}

function load(path) {
  if (!existsSync(path)) reject(`台账不存在: ${path}`);
  const ledger = readJson(path);
  if (ledger.schema !== LEDGER_SCHEMA) reject(`台账 schema 不是 ${LEDGER_SCHEMA}: ${path}`);
  return ledger;
}

function save(path, ledger, now) {
  ledger.version += 1;
  ledger.updated_at = now;
  writeJsonAtomic(path, ledger);
}

function move(item, to, now, detail = {}) {
  item.history.push({ at: now, from: item.state, to, ...detail });
  item.state = to;
  item.last_activity_at = now;
}

function itemOf(ledger, ref) {
  const item = ledger.items[ref];
  if (!item) reject(`台账里没有 ${ref}`);
  return item;
}

function expectState(item, allowed, action) {
  if (!allowed.includes(item.state)) reject(`${item.ref} 当前状态 ${item.state}，${action} 只接受 ${allowed.join(' / ')}`);
}

function planItemOf(plan, ref) {
  const planItem = plan.items.find((i) => i.ref === ref);
  if (!planItem) reject(`计划里没有 ${ref}`);
  return planItem;
}

/** 依赖满足 = GitHub 上该 issue 已关闭且不是「不做」。被关成「不做」的依赖交给用户决定。 */
export function depStatus(gh, ref) {
  const { repo, number } = parseIssueRef(ref);
  const issue = readIssue(gh, repo, number);
  if (issue.state !== 'closed') return { ref, ok: false, reason: 'open' };
  if (issue.state_reason === 'not_planned') return { ref, ok: false, reason: 'not_planned' };
  return { ref, ok: true };
}

function waitingOn(gh, item) {
  return item.hard_deps.map((d) => depStatus(gh, d)).filter((s) => !s.ok);
}

/** run 状态：全部收工 complete；有子 issue 等用户 blocked_user；有在途的 running；只剩等依赖合并的 waiting_merge。 */
export function runStatus(ledger, { dispatchable = [] } = {}) {
  const items = Object.values(ledger.items);
  if (items.every((i) => DONE.includes(i.state))) return 'complete';
  if (items.some((i) => i.state === 'blocked_user')) return 'blocked_user';
  if (items.some((i) => IN_FLIGHT.includes(i.state)) || dispatchable.length) return 'running';
  return 'waiting_merge';
}

// sub-issue comments: cross-ledger claims

const CLAIM_RE = /^批准执行(认领|登记|释放)：\S+ (\S+#\d+)\b[^\n]*?claim ([0-9a-f-]{36})/;
const MAX_COMMENT_PAGES = 50;

function commentsPathFor(ref) {
  const { repo, number } = parseIssueRef(ref);
  return `repos/${repo}/issues/${number}/comments`;
}

/** 分页读完一个 issue 的评论（每页 100 条，最多 50 页，超过就拒绝，不拿半截结果查重）。 */
export function readComments(gh, path) {
  const all = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const batch = gh(['api', `${path}?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) reject(`读评论返回的不是数组: ${path} 第 ${page} 页`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  reject(`${path} 评论超过 ${MAX_COMMENT_PAGES * 100} 条，无法完整查重`);
}

export function ghLogin(gh) {
  const login = gh(['api', 'user'])?.login;
  if (typeof login !== 'string' || !login) reject('读不到当前 gh 账号（gh api user），无法确认认领评论的作者');
  return login;
}

/** 评论 → 该子 issue 未释放的认领 / 登记，按评论 id 从早到晚。只认 login 本人发的评论。 */
export function activeClaims(comments, ref, login) {
  const byClaim = new Map();
  const sorted = (Array.isArray(comments) ? comments : []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const c of sorted) {
    if (c.user?.login !== login) continue;
    const m = CLAIM_RE.exec(String(c.body ?? ''));
    if (!m || m[2] !== ref) continue;
    const [, kind, , claimId] = m;
    if (kind === '释放') byClaim.delete(claimId);
    else if (!byClaim.has(claimId)) byClaim.set(claimId, { claim_id: claimId, kind, comment_id: c.id ?? null, url: c.html_url ?? null });
    else byClaim.get(claimId).kind = kind;
  }
  return [...byClaim.values()];
}

function postComment(gh, path, body) {
  return gh(['api', '-X', 'POST', path, '-f', `body=${body}`]);
}

// commands: dispatch

export function init({ plan, planPath, ledgerPath, now }) {
  if (plan.schema !== PLAN_SCHEMA) reject(`计划 schema 不是 ${PLAN_SCHEMA}`);
  const planSha = hashObject(plan);
  if (existsSync(ledgerPath)) {
    const existing = load(ledgerPath);
    if (existing.plan.sha256 !== planSha) reject(`台账已存在且对应另一份计划: ${ledgerPath}`);
    return { ok: true, created: false, ledger: ledgerPath };
  }
  const items = {};
  for (const i of plan.items) {
    items[i.ref] = {
      ref: i.ref,
      repo: i.repo,
      number: i.number,
      title: i.title,
      wave: i.wave,
      hard_deps: i.hard_deps,
      merge_after: i.merge_after,
      state: i.closed ? 'closed' : 'pending',
      claim_id: null,
      session_id: null,
      session_title: null,
      checkpoint: null,
      checkpoint_seq: 0,
      revise_count: 0,
      verdicts: [],
      blocked: null,
      cleanup: null,
      archive: null,
      last_activity_at: now,
      history: [],
    };
  }
  const ledger = {
    schema: LEDGER_SCHEMA,
    run_id: randomUUID(),
    created_at: now,
    updated_at: now,
    version: 0,
    plan: { path: planPath, sha256: planSha },
    root: plan.root,
    lead_agent: plan.lead_agent,
    lead_session_id: null,
    source: plan.source,
    authorization_source: plan.authorization_source,
    items,
  };
  save(ledgerPath, ledger, now);
  return { ok: true, created: true, ledger: ledgerPath, run_id: ledger.run_id };
}

export function next({ ledger, gh }) {
  const dispatchable = [];
  const waiting = [];
  const inFlight = [];
  const unknown = [];
  for (const item of Object.values(ledger.items)) {
    if (item.state === 'dispatch_unknown') unknown.push(item.ref);
    else if (IN_FLIGHT.includes(item.state)) inFlight.push(item.ref);
    else if (item.state === 'pending') {
      const blockers = waitingOn(gh, item);
      if (blockers.length) waiting.push({ ref: item.ref, waiting_on: blockers });
      else dispatchable.push(item.ref);
    }
  }
  return { ok: true, run_status: runStatus(ledger, { dispatchable }), dispatchable, waiting, in_flight: inFlight, unknown };
}

export function prepare({ ledger, ledgerPath, plan, ref, leadSessionId, gh, now }) {
  if (!leadSessionId) reject('缺 --lead-session <lead 会话 id>');
  if (ledger.lead_agent === 'pi') reject('KEEL 不接受 Pi 当主控：lead 会话必须是 claude-code 或 codex');
  const item = itemOf(ledger, ref);
  if (item.state === 'claimed' || item.state === 'dispatched') {
    return { ok: true, claimed: false, reason: 'already_claimed', state: item.state, session_id: item.session_id };
  }
  if (item.state === 'dispatch_unknown') reject(`${ref} 上次派发结果未知：先核对原回执与会话列表，确认没有建出会话后用 release 放回`);
  if (item.state !== 'pending') reject(`${ref} 当前状态 ${item.state}，不能派发`);
  const blockers = waitingOn(gh, item);
  if (blockers.length) reject(`${ref} 的依赖还没满足：${blockers.map((b) => `${b.ref}(${b.reason})`).join('、')}`);
  const path = commentsPathFor(ref);
  const login = ghLogin(gh);
  const taken = activeClaims(readComments(gh, path), ref, login);
  if (taken.length) {
    const t = taken[0];
    reject(`${ref} 已有未释放的批准执行${t.kind}（claim ${t.claim_id}，${t.url ?? '子 issue 评论'}）：同一子 issue 只能有一个会话。确认那个会话已不在后，先发「批准执行释放」再派`);
  }
  const planItem = planItemOf(plan, ref);
  const title = sessionTitle(planItem, now);
  const request = {
    title,
    message: renderIssueHandoff({ plan, item: planItem, leadSessionId, ...(ledgerPath ? { ledgerPath: resolve(ledgerPath) } : {}), scriptsDir: SCRIPTS_DIR }),
    working_dir: planItem.keel_run.repo_dir,
    use_worktree: false,
  };
  const claimId = randomUUID();
  const date = now.slice(0, 10);
  postComment(gh, path, `批准执行认领：${date} ${ref} claim ${claimId}（台账 ${ledger.run_id}，lead 会话 ${leadSessionId}）`);
  // 先认领后复查：同时认领时评论 id 最小的胜出；自己的认领没读到也按输处理（fail-closed）。
  const after = activeClaims(readComments(gh, path), ref, login);
  if (after[0]?.claim_id !== claimId) {
    const winner = after.find((c) => c.claim_id !== claimId);
    postComment(gh, path, `批准执行释放：${date} ${ref} claim ${claimId}：与 claim ${winner?.claim_id ?? '未知'} 同时认领，按评论先后让位`);
    reject(`${ref} 与另一个 lead 同时认领，按评论先后让给 claim ${winner?.claim_id ?? '未知'}；本台账未派发`);
  }
  ledger.lead_session_id = leadSessionId;
  item.claim_id = claimId;
  item.session_title = title;
  move(item, 'claimed', now, { claim_id: claimId });
  return { ok: true, claimed: true, claim_id: claimId, request };
}

/** send_to_session 回执 → 会话 id；不是明确成功一律返回 null。 */
export function sessionIdFrom(result) {
  if (!result || typeof result !== 'object' || result.ok === false || result.errorCode) return null;
  const id = result.target_session_id ?? result.session_id ?? result.data?.target_session_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function bind({ ledger, ref, claimId, result, gh, now }) {
  const item = itemOf(ledger, ref);
  if (item.state !== 'claimed') reject(`${ref} 当前状态 ${item.state}，只有 claimed 才能 bind`);
  if (item.claim_id !== claimId) reject(`${ref} 的认领号对不上（台账 ${item.claim_id}，传入 ${claimId}）`);
  const sessionId = sessionIdFrom(result);
  if (!sessionId) {
    move(item, 'dispatch_unknown', now, { error: result?.errorCode ?? result?.error ?? 'no_session_id' });
    return { ok: false, state: item.state, ref };
  }
  item.session_id = sessionId;
  move(item, 'dispatched', now, { session_id: sessionId });
  const body = `批准执行登记：${now.slice(0, 10)} ${ref} → 会话 ${sessionId}（${item.session_title}）claim ${claimId}`;
  const out = { ok: true, state: item.state, ref, session_id: sessionId };
  // 子 issue 上的登记是防重依据；总 issue 上再发一份，方便在总 issue 一处看全（open-issue §6）。
  // 认领评论已在子 issue 上，防重不受影响；登记评论没发出去要让 lead 看见并补发。
  const targets = [[commentsPathFor(ref), 'comment']];
  if (ledger.root.ref !== ref) targets.push([commentsPathFor(ledger.root.ref), 'root_comment']);
  for (const [path, key] of targets) {
    try {
      out[`${key}_url`] = postComment(gh, path, body)?.html_url ?? null;
    } catch (err) {
      out[`${key}_error`] = String(err.message ?? err);
      out[`${key}_path`] = path;
      out[key] = body;
    }
  }
  return out;
}

export function release({ ledger, ref, evidence, gh, now }) {
  const item = itemOf(ledger, ref);
  if (item.state !== 'dispatch_unknown') reject(`${ref} 当前状态 ${item.state}，只有 dispatch_unknown 才能 release`);
  if (!evidence || !String(evidence).trim()) reject('release 需要 --evidence：写明怎么核实的没有建出会话');
  const reason = String(evidence).trim();
  postComment(gh, commentsPathFor(ref), `批准执行释放：${now.slice(0, 10)} ${ref} claim ${item.claim_id}：${reason}`);
  item.claim_id = null;
  move(item, 'pending', now, { evidence: reason });
  return { ok: true, state: item.state, ref };
}

// commands: owner closeout and lead acceptance

function allScIds(planItem) {
  return [...planItem.keel_run.sc.map((s) => s.id), ...planItem.manual_scs.map((s) => s.id)];
}

/** owner 交来的 SC 表：每条 SC 恰好一行；KEEL 管的 SC 必须 pass，黑盒项只能 manual / not_run。 */
function checkScTable(sc, planItem, ref) {
  if (!Array.isArray(sc)) reject(`${ref} --sc 必须是 JSON 数组 [{"id":"SC1","status":"pass"}, …]`);
  const want = allScIds(planItem);
  const got = sc.map((s) => s?.id);
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  if (missing.length || extra.length || new Set(got).size !== got.length) {
    reject(`${ref} --sc 与子 issue 的 SC 对不上（缺: ${missing.join(',') || '无'}；多或重复: ${extra.join(',') || (new Set(got).size !== got.length ? '有重复' : '无')}）`);
  }
  const manual = new Set(planItem.manual_scs.map((s) => s.id));
  for (const s of sc) {
    if (!SC_STATUSES.includes(s.status)) reject(`${ref} ${s.id} 的状态只能是 ${SC_STATUSES.join(' / ')}（当前: ${s.status}）`);
    if (!manual.has(s.id) && s.status !== 'pass') reject(`${ref} ${s.id} 还没有通过（${s.status}），没到验收点：继续按 KEEL 推进，做不下去就写 blocked_user`);
    if (manual.has(s.id) && !['manual', 'not_run'].includes(s.status)) reject(`${ref} ${s.id} 是合并前拿不到证据的验收项，只能写 manual / not_run`);
  }
}

function requirePr(pr, head, ref) {
  if (!Number.isSafeInteger(Number(pr)) || Number(pr) <= 0) reject(`${ref} 缺 --pr <PR 号>`);
  if (!SHA_RE.test(String(head ?? ''))) reject(`${ref} --head 必须是 40 位小写十六进制 sha（当前: ${head}）`);
}

export function checkpoint({ ledger, plan, ref, state, pr, head, sc, keelRun, lane, reason, now }) {
  const item = itemOf(ledger, ref);
  const planItem = planItemOf(plan, ref);
  if (state === 'awaiting_acceptance') {
    expectState(item, ['dispatched', 'revising', 'blocked_user'], 'checkpoint awaiting_acceptance');
    requirePr(pr, head, ref);
    checkScTable(sc, planItem, ref);
  } else if (state === 'ready') {
    expectState(item, ['accepted'], 'checkpoint ready');
    requirePr(pr, head, ref);
    if (Number(pr) !== item.checkpoint.pr || head !== item.checkpoint.head) {
      reject(`${ref} 的 PR 或 head 和验收通过时不一致（验收时 #${item.checkpoint.pr} ${item.checkpoint.head}，现在 #${pr} ${head}）：回到验收点重新写 awaiting_acceptance`);
    }
  } else if (state === 'blocked_user') {
    expectState(item, ['dispatched', 'revising', 'awaiting_acceptance', 'accepted'], 'checkpoint blocked_user');
    if (!reason || !String(reason).trim()) reject(`${ref} blocked_user 需要 --reason：写明要用户做什么`);
  } else {
    reject(`--state 只能是 awaiting_acceptance / ready / blocked_user（当前: ${state}）`);
  }
  item.checkpoint_seq += 1;
  const record = {
    seq: item.checkpoint_seq,
    state,
    at: now,
    pr: pr === undefined ? item.checkpoint?.pr ?? null : Number(pr),
    head: head ?? item.checkpoint?.head ?? null,
    ...(sc ? { sc } : {}),
    ...(keelRun ? { keel_run_id: String(keelRun) } : {}),
    ...(lane ? { lane: String(lane) } : {}),
    ...(reason ? { reason: String(reason).trim() } : {}),
  };
  if (state === 'blocked_user') {
    item.blocked = { seq: item.checkpoint_seq, by: 'owner', reason: record.reason, prev_state: item.state, at: now };
  } else {
    item.checkpoint = record;
    item.blocked = null;
  }
  move(item, state, now, { checkpoint_seq: item.checkpoint_seq });
  return { ok: true, state: item.state, ref, checkpoint_seq: item.checkpoint_seq };
}

function laneIsHandoff(lane) {
  return /handoff/.test(String(lane ?? ''));
}

export function verdict({ ledger, ref, pass, revise, check, now }) {
  const item = itemOf(ledger, ref);
  expectState(item, ['awaiting_acceptance'], 'verdict');
  const cp = item.checkpoint;
  const date = now.slice(0, 10);
  if (pass) {
    if (!check || check.ok !== true || check.ref !== ref || check.stage !== 'acceptance' || check.head !== cp.head || check.pr !== cp.pr) {
      reject(`${ref} 判「通过」需要同一 PR、同一 head（#${cp.pr} ${cp.head}）且 ok=true 的 accept-check --stage acceptance 结果`);
    }
    item.verdicts.push({ at: now, verdict: 'pass', head: cp.head, check_at: check.checked_at ?? null });
    move(item, 'accepted', now, { verdict: 'pass' });
    const ready = laneIsHandoff(cp.lane)
      ? `现在调 KEEL 的 pr_ready，authorization_source 填「${ledger.authorization_source}」；成功后写 checkpoint --state ready --pr ${cp.pr} --head ${cp.head}`
      : `PR 已经是 Ready，直接写 checkpoint --state ready --pr ${cp.pr} --head ${cp.head}`;
    return {
      ok: true, state: item.state, ref, target_session_id: item.session_id,
      owner_message: `批准执行验收：${date} ${ref} 通过（head ${cp.head}）。${ready}。写完就结束本轮。`,
    };
  }
  const items = String(revise ?? '').trim();
  if (!items) reject(`${ref} 判「要改」需要 --revise <要改的条目>`);
  item.revise_count += 1;
  item.verdicts.push({ at: now, verdict: 'revise', head: cp.head, items, round: item.revise_count });
  if (item.revise_count > MAX_REVISE_ROUNDS) {
    item.blocked = { seq: item.checkpoint_seq, by: 'lead', reason: `已判「要改」${item.revise_count} 次仍未通过`, prev_state: 'revising', at: now };
    move(item, 'blocked_user', now, { verdict: 'revise', round: item.revise_count });
    const rounds = item.verdicts.filter((v) => v.verdict === 'revise').map((v) => `第 ${v.round} 次：${v.items}`).join('；');
    return {
      ok: true, state: item.state, ref,
      root_comment: `批准执行停下等用户：${date} ${ref}（PR #${cp.pr}）已判「要改」${item.revise_count} 次仍未通过，不再发回会话 ${item.session_id}。${rounds}`,
    };
  }
  move(item, 'revising', now, { verdict: 'revise', round: item.revise_count });
  return {
    ok: true, state: item.state, ref, target_session_id: item.session_id,
    owner_message: `批准执行验收：${date} ${ref} 要改（第 ${item.revise_count} 次，最多 ${MAX_REVISE_ROUNDS} 次）。要改的条目：${items}。改完回到验收点，重新写 checkpoint --state awaiting_acceptance。`,
  };
}

export function unblock({ ledger, ref, note, now }) {
  const item = itemOf(ledger, ref);
  expectState(item, ['blocked_user'], 'unblock');
  if (!note || !String(note).trim()) reject(`${ref} unblock 需要 --note：写明用户怎么处理的`);
  const back = item.blocked?.by === 'lead' ? 'revising' : item.blocked?.prev_state ?? 'dispatched';
  if (item.blocked?.by === 'lead') item.revise_count = 0;
  item.blocked = null;
  move(item, back, now, { note: String(note).trim() });
  return { ok: true, state: item.state, ref, target_session_id: item.session_id };
}

function gitRunner() {
  return (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** `git worktree list --porcelain` → [{worktree, head, branch}]。 */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) { cur = { worktree: line.slice(9), head: null, branch: null }; out.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7);
  }
  return out;
}

/** Ready 后清本地：删 PR 分支的本地 worktree 与本地分支，不删远端。有未提交改动或本地比 PR 新时拒绝。 */
export function cleanup({ ledger, plan, ref, gh, git = gitRunner(), now }) {
  const item = itemOf(ledger, ref);
  expectState(item, ['ready'], 'cleanup');
  const repoDir = planItemOf(plan, ref).keel_run.repo_dir;
  const pr = gh(['api', `repos/${item.repo}/pulls/${item.checkpoint.pr}`]);
  const branch = pr?.head?.ref;
  const prHead = pr?.head?.sha;
  if (!branch || !SHA_RE.test(String(prHead))) reject(`${ref} 读不到 PR #${item.checkpoint.pr} 的分支与 head`);
  const entries = parseWorktrees(git(['-C', repoDir, 'worktree', 'list', '--porcelain']));
  const main = entries[0]?.worktree ?? null;
  const wt = entries.find((e) => e.branch === `refs/heads/${branch}` && e.worktree !== main);
  const record = { branch, pr_head: prHead, worktree: null, branch_deleted: false, at: now };
  if (wt) {
    if (git(['-C', wt.worktree, 'status', '--porcelain'])) reject(`${ref} 的 worktree ${wt.worktree} 有未提交改动，不清理`);
    if (wt.head !== prHead) reject(`${ref} 的 worktree HEAD ${wt.head} 与 PR head ${prHead} 不一致（有没推送的提交？），不清理`);
    git(['-C', repoDir, 'worktree', 'remove', wt.worktree]);
    record.worktree = wt.worktree;
  }
  let local = null;
  try { local = git(['-C', repoDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { local = null; }
  const checkedOutInMain = entries[0]?.branch === `refs/heads/${branch}`;
  if (local && !checkedOutInMain) {
    if (local !== prHead) reject(`${ref} 本地分支 ${branch} 在 ${local}，与 PR head ${prHead} 不一致，不删`);
    git(['-C', repoDir, 'branch', '-D', branch]);
    record.branch_deleted = true;
  }
  item.cleanup = record;
  move(item, 'cleaned', now, { worktree: record.worktree, branch_deleted: record.branch_deleted });
  return { ok: true, state: item.state, ref, ...record, target_session_id: item.session_id };
}

function asRecord(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

/** archive_sessions 工具回执 → 是否归档了这个会话（与 confirm-session-archived.mjs 同口径，含 MCP 外壳）。 */
export function extractArchiveResult(raw, sessionId) {
  const rec = asRecord(raw);
  if (rec.isError === true || rec.ok === false) reject('archive_sessions 工具返回失败，不能用作归档证明');
  if (rec.structuredContent) return extractArchiveResult(rec.structuredContent, sessionId);
  if (Array.isArray(rec.content)) {
    const payloads = rec.content.filter((part) => part.type === 'text').map((part) => asRecord(part.text)).filter((v) => Object.keys(v).length);
    if (payloads.length !== 1) reject('archive_sessions 结果必须能解析为唯一回执');
    return extractArchiveResult(payloads[0], sessionId);
  }
  const payload = rec.result && typeof rec.result === 'object' ? rec.result : rec;
  if (payload.ok !== true) reject(`archive_sessions 回执 ok 必须是 true（当前: ${payload.ok ?? '缺失'}）`);
  if (!Array.isArray(payload.changed) || payload.changed.length === 0) reject('archive_sessions 回执必须含非空 changed[]');
  const hit = payload.changed.find((c) => c && c.session_id === sessionId);
  if (!hit) reject(`archive_sessions.changed 未包含 ${sessionId}`);
  if (hit.status !== 'archived') reject(`archive_sessions.changed[${sessionId}].status 必须是 archived（当前: ${hit.status}）`);
  return { session_id: sessionId, archived: true };
}

export function archived({ ledger, ref, result, now }) {
  const item = itemOf(ledger, ref);
  expectState(item, ['cleaned'], 'archived');
  item.archive = { ...extractArchiveResult(result, item.session_id), at: now };
  move(item, 'archived', now);
  return { ok: true, state: item.state, ref, run_status: runStatus(ledger) };
}

export function status({ ledger }) {
  const items = Object.values(ledger.items).map((i) => ({
    ref: i.ref, wave: i.wave, state: i.state, session_id: i.session_id,
    pr: i.checkpoint?.pr ?? null, revise_count: i.revise_count, blocked: i.blocked?.reason ?? null,
  }));
  return { ok: true, root: ledger.root.ref, run_id: ledger.run_id, run_status: runStatus(ledger), items };
}

// cli

function scArg(raw) {
  if (raw === undefined || raw === true) return undefined;
  try { return JSON.parse(String(raw)); } catch { reject('--sc 不是合法 JSON'); }
}

const str = (v) => (typeof v === 'string' ? v : undefined);

export function main(argv = process.argv.slice(2)) {
  const [cmd] = argv;
  const args = parseArgs(argv.slice(1));
  const now = typeof args.now === 'string' ? args.now : nowIso();
  const gh = () => ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
  const WRITES = ['prepare', 'bind', 'release', 'checkpoint', 'verdict', 'unblock', 'cleanup', 'archived'];
  try {
    if (!args.ledger || args.ledger === true) reject('缺 --ledger <ledger.json>');
    const ledgerPath = String(args.ledger);
    let out;
    if (cmd === 'init') {
      const plan = readJson(String(args.plan));
      out = withLock(`${ledgerPath}.lock`, () => init({ plan, planPath: String(args.plan), ledgerPath, now }));
    } else if (cmd === 'next') {
      out = next({ ledger: load(ledgerPath), gh: gh() });
    } else if (cmd === 'status') {
      out = status({ ledger: load(ledgerPath) });
    } else if (WRITES.includes(cmd)) {
      out = withLock(`${ledgerPath}.lock`, () => {
        const ledger = load(ledgerPath);
        const ref = String(args.item);
        const plan = readJson(ledger.plan.path);
        if (hashObject(plan) !== ledger.plan.sha256) reject('计划文件在 init 之后被改过，重新出计划并新开台账');
        let res;
        if (cmd === 'prepare') {
          res = prepare({ ledger, ledgerPath, plan, ref, leadSessionId: str(args['lead-session']), gh: gh(), now });
        } else if (cmd === 'bind') {
          res = bind({ ledger, ref, claimId: String(args.claim), result: JSON.parse(readFileSync(String(args.result), 'utf8')), gh: gh(), now });
        } else if (cmd === 'release') {
          res = release({ ledger, ref, evidence: str(args.evidence), gh: gh(), now });
        } else if (cmd === 'checkpoint') {
          res = checkpoint({
            ledger, plan, ref, state: str(args.state), pr: str(args.pr), head: str(args.head), sc: scArg(args.sc),
            keelRun: str(args['keel-run']), lane: str(args.lane), reason: str(args.reason), now,
          });
        } else if (cmd === 'verdict') {
          const check = typeof args.check === 'string' ? JSON.parse(readFileSync(args.check, 'utf8')) : null;
          res = verdict({ ledger, ref, pass: args.pass === true, revise: str(args.revise), check, now });
        } else if (cmd === 'unblock') {
          res = unblock({ ledger, ref, note: str(args.note), now });
        } else if (cmd === 'cleanup') {
          res = cleanup({ ledger, plan, ref, gh: gh(), now });
        } else {
          res = archived({ ledger, ref, result: JSON.parse(readFileSync(String(args.result), 'utf8')), now });
        }
        if (!(cmd === 'prepare' && res.claimed === false)) save(ledgerPath, ledger, now);
        return res;
      });
    } else {
      reject(`未知子命令: ${cmd}（init / next / prepare / bind / release / checkpoint / verdict / unblock / cleanup / archived / status）`);
    }
    process.stdout.write(JSON.stringify(out) + '\n');
    return out.ok === false ? 2 : 0;
  } catch (err) {
    if (!(err instanceof RunError) && err?.code !== 'PLAN') throw err;
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());

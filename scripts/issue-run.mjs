#!/usr/bin/env node
// issue-run.mjs — issue 入口的小台账（issue-run-v1）：每个子 issue 一条，记录一次性认领与会话回执。
// lead 自己调 send_to_session；本脚本只出请求、收回执，不调用任何宿主工具。
// 跨台账、跨机器的防重靠总 issue 上的评论：prepare 发「批准执行认领」，bind 成功发「批准执行登记」，
// release 发「批准执行释放」。同一子 issue 有未释放的认领 / 登记时，任何台账的 prepare 都拒绝。
//
// CLI（全部输出一行 JSON；exit 0 成功 / 2 拒绝）：
//   init    --plan <plan.json> --ledger <ledger.json> [--now ISO]
//   next    --ledger <f> [--gh-fixture <夹具>]                      列出依赖已满足、可派的子 issue
//   prepare --ledger <f> --item <ref> --lead-session <id> [--now ISO] [--gh-fixture <夹具>]
//   bind    --ledger <f> --item <ref> --claim <id> --result <send_to_session 回执 JSON 文件> [--now ISO] [--gh-fixture <夹具>]
//   release --ledger <f> --item <ref> --evidence <已核实没有建出会话的依据> [--now ISO] [--gh-fixture <夹具>]
//   status  --ledger <f>
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hashObject, isMain, nowIso, parseArgs, readJson, writeJsonAtomic } from './lib/common.mjs';
import { withLock } from './lib/state-lock.mjs';
import { ghRunner, readIssue, parseIssueRef, PLAN_SCHEMA } from './issue-plan.mjs';
import { renderIssueHandoff } from './render-issue-handoff.mjs';

export const LEDGER_SCHEMA = 'issue-run-v1';
export const ITEM_STATES = Object.freeze(['pending', 'claimed', 'dispatched', 'dispatch_unknown', 'closed']);
export const REQUEST_KEYS = Object.freeze(['title', 'message', 'working_dir', 'use_worktree']);

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
}

function itemOf(ledger, ref) {
  const item = ledger.items[ref];
  if (!item) reject(`台账里没有 ${ref}`);
  return item;
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

// root issue comments: cross-ledger claims

const CLAIM_RE = /^批准执行(认领|登记|释放)：\S+ (\S+#\d+)\b[^\n]*?claim ([0-9a-f-]{36})/;

function commentsPath(ledger) {
  const { repo, number } = parseIssueRef(ledger.root.ref);
  return `repos/${repo}/issues/${number}/comments`;
}

/** 总 issue 评论 → 该子 issue 未释放的认领 / 登记（{claim_id, kind, url}）。 */
export function activeClaims(comments, ref) {
  const byClaim = new Map();
  for (const c of Array.isArray(comments) ? comments : []) {
    const m = CLAIM_RE.exec(String(c.body ?? ''));
    if (!m || m[2] !== ref) continue;
    const [, kind, , claimId] = m;
    if (kind === '释放') byClaim.delete(claimId);
    else byClaim.set(claimId, { claim_id: claimId, kind, url: c.html_url ?? null });
  }
  return [...byClaim.values()];
}

function postComment(gh, ledger, body) {
  return gh(['api', '-X', 'POST', commentsPath(ledger), '-f', `body=${body}`]);
}

// commands

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
    else if (item.state === 'claimed' || item.state === 'dispatched') inFlight.push(item.ref);
    else if (item.state === 'pending') {
      const blockers = waitingOn(gh, item);
      if (blockers.length) waiting.push({ ref: item.ref, waiting_on: blockers });
      else dispatchable.push(item.ref);
    }
  }
  return { ok: true, dispatchable, waiting, in_flight: inFlight, unknown };
}

export function prepare({ ledger, plan, ref, leadSessionId, gh, now }) {
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
  const taken = activeClaims(gh(['api', `${commentsPath(ledger)}?per_page=100`]), ref);
  if (taken.length) {
    const t = taken[0];
    reject(`${ref} 已有未释放的批准执行${t.kind}（claim ${t.claim_id}，${t.url ?? '总 issue 评论'}）：同一子 issue 只能有一个会话。确认那个会话已不在后，先发「批准执行释放」再派`);
  }
  const planItem = plan.items.find((i) => i.ref === ref);
  if (!planItem) reject(`计划里没有 ${ref}`);
  const title = sessionTitle(planItem, now);
  const request = {
    title,
    message: renderIssueHandoff({ plan, item: planItem, leadSessionId }),
    working_dir: planItem.keel_run.repo_dir,
    use_worktree: false,
  };
  const claimId = randomUUID();
  postComment(gh, ledger, `批准执行认领：${now.slice(0, 10)} ${ref} claim ${claimId}（台账 ${ledger.run_id}，lead 会话 ${leadSessionId}）`);
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
  try {
    const posted = postComment(gh, ledger, body);
    return { ok: true, state: item.state, ref, session_id: sessionId, root_comment_url: posted?.html_url ?? null };
  } catch (err) {
    // 认领评论已在总 issue 上，防重不受影响；登记评论没发出去要让 lead 看见并补发。
    return { ok: true, state: item.state, ref, session_id: sessionId, root_comment_error: String(err.message ?? err), root_comment: body };
  }
}

export function release({ ledger, ref, evidence, gh, now }) {
  const item = itemOf(ledger, ref);
  if (item.state !== 'dispatch_unknown') reject(`${ref} 当前状态 ${item.state}，只有 dispatch_unknown 才能 release`);
  if (!evidence || !String(evidence).trim()) reject('release 需要 --evidence：写明怎么核实的没有建出会话');
  const reason = String(evidence).trim();
  postComment(gh, ledger, `批准执行释放：${now.slice(0, 10)} ${ref} claim ${item.claim_id}：${reason}`);
  item.claim_id = null;
  move(item, 'pending', now, { evidence: reason });
  return { ok: true, state: item.state, ref };
}

export function status({ ledger }) {
  const items = Object.values(ledger.items).map((i) => ({ ref: i.ref, wave: i.wave, state: i.state, session_id: i.session_id }));
  return { ok: true, root: ledger.root.ref, run_id: ledger.run_id, items };
}

// cli

export function main(argv = process.argv.slice(2)) {
  const [cmd] = argv;
  const args = parseArgs(argv.slice(1));
  const now = typeof args.now === 'string' ? args.now : nowIso();
  const gh = () => ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
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
    } else if (['prepare', 'bind', 'release'].includes(cmd)) {
      out = withLock(`${ledgerPath}.lock`, () => {
        const ledger = load(ledgerPath);
        const ref = String(args.item);
        let res;
        if (cmd === 'prepare') {
          const plan = readJson(ledger.plan.path);
          if (hashObject(plan) !== ledger.plan.sha256) reject('计划文件在 init 之后被改过，重新出计划并新开台账');
          res = prepare({ ledger, plan, ref, leadSessionId: args['lead-session'] === true ? null : args['lead-session'], gh: gh(), now });
        } else if (cmd === 'bind') {
          const result = JSON.parse(readFileSync(String(args.result), 'utf8'));
          res = bind({ ledger, ref, claimId: String(args.claim), result, gh: gh(), now });
        } else {
          res = release({ ledger, ref, evidence: args.evidence === true ? '' : args.evidence, gh: gh(), now });
        }
        if (!(cmd === 'prepare' && res.claimed === false)) save(ledgerPath, ledger, now);
        return res;
      });
    } else {
      reject(`未知子命令: ${cmd}（init / next / prepare / bind / release / status）`);
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

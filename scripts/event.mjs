#!/usr/bin/env node
// event.mjs — 批准执行 v3 协议事件的唯一写通道（PraiseZhu/approve-exec#104）。
// 每个事件是子 issue 上的一条评论：第一行人话（沿用旧文案，旧解析照常认），后面跟一个机器标记。
// 事件先落在 GitHub，再发消息：消息送丢了事件还在，对账器（reconcile.mjs）只读这些事件。
//
// CLI:
//   node scripts/event.mjs emit --type <类型> --item <子 issue> [--pr <号>] [--head <40 位 sha>]
//                               [--session <会话 id>] [--title <会话标题>] [--note <一段话>]
//   node scripts/event.mjs list --item <子 issue>
//   公共：[--now <ISO>] [--gh-fixture <夹具.json>]
// 输出：stdout 一行 JSON；exit 0 成功 / 2 拒绝（stderr 写原因）。
import { isMain, nowIso, parseArgs, sha256 } from './lib/common.mjs';
import { ghRunner, parseIssueRef } from './issue-plan.mjs';
import { ghLogin, readComments } from './issue-run.mjs';

export class EventError extends Error {}
const reject = (msg) => { throw new EventError(msg); };

export const EVENT_TYPES = ['dispatch', 'ready_for_verdict', 'verdict_pass', 'verdict_revise', 'ready', 'blocked', 'withdraw', 'archived', 'prereview'];
const NEEDS_PR_HEAD = ['ready_for_verdict', 'verdict_pass', 'verdict_revise', 'ready', 'prereview'];
const NEEDS_SESSION = ['dispatch', 'archived'];
const SHA_RE = /^[0-9a-f]{40}$/;
const SESSION_RE = /^[\w-]+$/;
export const EVENT_MARK_RE = /<!-- approve-exec:event v1 (\{.*?\}) -->/s;

const commentsPath = (ref) => { const { repo, number } = parseIssueRef(ref); return `repos/${repo}/issues/${number}/comments`; };
const dateOf = (now) => String(now).slice(0, 10);

// helpers

/** 事件的第一行人话。派发、撤回、归档沿用 batch.mjs 旧正则认的文案，其余五种用执行会话和 lead 一直在用的消息首行。 */
export function toHeadline({ type, ref, pr, head, session, title, note, at }) {
  const day = dateOf(at);
  if (type === 'dispatch') return `批准执行派发：${day} ${ref} → 会话 ${session}（${title ?? '执行会话'}）`;
  if (type === 'withdraw') return `批准执行撤回：${day} ${ref}：${note}`;
  if (type === 'archived') return `批准执行归档：${day} ${ref} 会话 ${session}`;
  if (type === 'ready_for_verdict') return `批准执行待验收 ${ref} PR #${pr} head ${head}`;
  if (type === 'verdict_pass') return `批准执行通过 ${ref} PR #${pr}（head ${head}）`;
  if (type === 'verdict_revise') return `批准执行要改 ${ref} PR #${pr}（head ${head}）`;
  if (type === 'ready') return `批准执行已转正式 ${ref} PR #${pr}（head ${head}）`;
  if (type === 'prereview') return `批准执行预审 ${ref} PR #${pr}（head ${head}）`;
  return `批准执行卡住 ${ref}`;
}

/** 同一事件的去重键：类型、子 issue、代码版本、会话；要改和卡住再带上说明（同一版本可以有不同的要改内容）。 */
export function toEventId({ type, ref, head, session, note }) {
  const extra = ['verdict_revise', 'blocked', 'withdraw'].includes(type) ? String(note ?? '') : '';
  return sha256([type, ref, head ?? '', session ?? '', extra].join('|')).slice(0, 16);
}

/** 评论 → 事件数组（按评论 id 升序）。只认 login 本人发的、带合法标记的评论；标记坏了的计入 skipped。 */
export function parseEvents(comments, login) {
  const events = [];
  let skipped = 0;
  const sorted = (Array.isArray(comments) ? comments : []).slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const c of sorted) {
    const m = EVENT_MARK_RE.exec(String(c.body ?? ''));
    if (!m) continue;
    if (login && c.user?.login !== login) continue;
    let payload;
    try { payload = JSON.parse(m[1]); } catch { skipped += 1; continue; }
    if (!payload || !EVENT_TYPES.includes(payload.type) || typeof payload.ref !== 'string') { skipped += 1; continue; }
    // 必填的代码版本缺了或不是 40 位 sha：按坏标记处理，不采信。
    if (NEEDS_PR_HEAD.includes(payload.type) && !SHA_RE.test(String(payload.head ?? ''))) { skipped += 1; continue; }
    events.push({ ...payload, at: payload.at ?? c.created_at ?? null, comment_id: c.id ?? null, url: c.html_url ?? null });
  }
  return { events, skipped };
}

// emit

export function emit({ gh, type, itemRef, pr = null, head = null, session = null, title = null, note = null, route = null, now = nowIso() }) {
  if (!EVENT_TYPES.includes(type)) reject(`--type 只能是 ${EVENT_TYPES.join(' / ')}（当前：${type ?? '空'}）`);
  const { ref } = parseIssueRef(itemRef);
  if (NEEDS_PR_HEAD.includes(type)) {
    if (!Number.isInteger(pr) || pr < 1) reject(`${type} 事件要带 --pr <PR 号>（当前：${pr}）`);
    if (!SHA_RE.test(String(head ?? ''))) reject(`${type} 事件要带 --head <40 位 sha>（当前：${head}）`);
  }
  if (NEEDS_SESSION.includes(type) && !SESSION_RE.test(String(session ?? ''))) reject(`${type} 事件要带 --session <会话 id>（当前：${session}）`);
  if (type === 'withdraw' && !String(note ?? '').trim()) reject('withdraw 事件要用 --note 写撤回原因');
  const text = note == null ? null : String(note).trim();
  if (text && text.includes('-->')) reject('--note 里不能有「-->」');
  if (route !== null) {
    if (type !== 'dispatch' || !route || typeof route !== 'object' || Array.isArray(route)
      || !['agent', 'model', 'kind'].every((key) => typeof route[key] === 'string' && route[key].trim())
      || !['codex', 'claude-code', 'pi'].includes(route.agent) || !['界面', '逻辑', '混合'].includes(route.kind)
      || !Number.isSafeInteger(route.route_index) || route.route_index < 0
      || Object.keys(route).some((key) => !['agent', 'model', 'kind', 'route_index'].includes(key))) {
      reject('dispatch route 要含 agent、model、kind 和非负整数 route_index');
    }
  }
  const login = ghLogin(gh);
  const id = toEventId({ type, ref, head, session, note: text });
  const { events } = parseEvents(readComments(gh, commentsPath(ref)), login);
  // 派发可以在撤回后对同一会话重发（极少见），其余类型同 id 一律视为重复。
  const dup = events.find((e) => e.id === id);
  if (dup && !(type === 'dispatch' && events.some((e) => e.type === 'withdraw' && (e.comment_id ?? 0) > (dup.comment_id ?? 0)))) {
    return { ok: true, duplicate: true, ref, type, id, comment_url: dup.url ?? null };
  }
  const payload = { type, ref, pr, head, session, at: now, id, ...(text ? { note: text } : {}), ...(route ? { route } : {}) };
  const headline = toHeadline({ type, ref, pr, head, session, title, note: text, at: now });
  const middle = text && !['withdraw'].includes(type) ? `\n\n${text}` : '';
  const body = `${headline}${middle}\n\n<!-- approve-exec:event v1 ${JSON.stringify(payload)} -->`;
  const posted = gh(['api', '-X', 'POST', commentsPath(ref), '-f', `body=${body}`]);
  return { ok: true, duplicate: false, ref, type, id, comment_url: posted?.html_url ?? null };
}

export function list({ gh, itemRef }) {
  const { ref } = parseIssueRef(itemRef);
  const { events, skipped } = parseEvents(readComments(gh, commentsPath(ref)), ghLogin(gh));
  return { ok: true, ref, events, skipped };
}

// cli

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [cmd] = args._;
  const gh = ghRunner(typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null);
  const str = (k) => (typeof args[k] === 'string' ? args[k] : null);
  try {
    let out;
    if (cmd === 'emit') {
      out = emit({ gh, type: str('type'), itemRef: args.item, pr: args.pr === undefined ? null : Number(args.pr), head: str('head'), session: str('session'), title: str('title'), note: str('note'), now: str('now') ?? nowIso() });
    } else if (cmd === 'list') out = list({ gh, itemRef: args.item });
    else reject(`子命令只能是 emit / list（当前：${cmd ?? '空'}）`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`[REJECT] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) process.exit(main());

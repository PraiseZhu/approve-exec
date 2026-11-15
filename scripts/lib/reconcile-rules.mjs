// reconcile-rules.mjs — 对账器的判定规则（PraiseZhu/approve-exec#103）。全是纯函数：事实进，阶段和到期动作出。
// 不读 GitHub、不读时钟、不写任何东西。判停滞只看提交、检查、标签、review 这些 GitHub 上的事实，
// 不看「多久没有评论」（旧续跑脚本按台账写入时间判停滞，误报过 3 次）。
import { EVENT_MARK_RE, parseEvents } from '../event.mjs';
import { baseAllowed, selectCharter } from '../charter.mjs';

// 每个等待阶段的期限（分钟）和负责方。改期限只改这张表。
export const DEADLINES = Object.freeze({
  awaiting_verdict: { minutes: 15, waiting_on: 'lead' },
  accepted_draft: { minutes: 30, waiting_on: 'owner' },
  in_review: { minutes: 120, waiting_on: 'reviewer' },
  merge_ready: { minutes: 10, waiting_on: 'lead' },
  in_dev: { minutes: 360, waiting_on: 'owner' },
  revising: { minutes: 360, waiting_on: 'owner' },
});
export const STAGES = ['not_started', 'in_dev', 'awaiting_verdict', 'revising', 'accepted_draft', 'in_review', 'merge_ready', 'merged', 'closed'];
export const ACTIONS = ['wake_lead', 'wake_owner', 'recheck', 'request_merge'];
export const MERGE_READY_LABEL = 'review:merge-ready';
export const NOTE_MARK_RE = /<!-- approve-exec:note v1 (\{.*?\}) -->/s;
const HOLD_PREFIX = '暂缓转正式：';

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const minutesBetween = (from, to) => Math.floor((ms(to) - ms(from)) / 60000);
const latest = (...isos) => isos.filter(Boolean).sort((a, b) => ms(a) - ms(b)).at(-1) ?? null;

// helpers

/** 改版前手写的评论首行 → 事件（legacy: true）。带 v3 标记的评论不走这里。 */
export function toLegacyEvent(comment, ref) {
  const body = String(comment.body ?? '');
  if (EVENT_MARK_RE.test(body)) return null;
  const first = body.split('\n')[0];
  const head = /head ([0-9a-f]{40})/.exec(first)?.[1] ?? null;
  const pr = Number(/PR #(\d+)/.exec(first)?.[1]) || null;
  const base = { ref, pr, head, at: comment.created_at ?? null, legacy: true, comment_id: comment.id ?? null };
  const d = /^批准执行派发：\S+ (\S+#\d+) → 会话 ([\w-]+)/.exec(first);
  if (d && d[1] === ref) return { ...base, type: 'dispatch', session: d[2] };
  if (/^批准执行撤回：/.test(first)) return { ...base, type: 'withdraw' };
  if (/^批准执行归档：/.test(first)) return { ...base, type: 'archived' };
  if (/^批准执行验收：通过/.test(first) || /^批准执行通过 /.test(first)) return { ...base, type: 'verdict_pass' };
  if (/^批准执行验收：要改/.test(first) || /^批准执行要改 /.test(first)) return { ...base, type: 'verdict_revise' };
  return null;
}

/** 子 issue 的评论 → 按时间排好的事件（v3 标记优先，认不到再认旧手写首行）。只认 login 本人发的。 */
export function selectChildEvents(comments, ref, login) {
  const own = (Array.isArray(comments) ? comments : []).filter((c) => !login || c.user?.login === login);
  const marked = parseEvents(own, login).events.filter((e) => e.ref === ref);
  const legacy = own.map((c) => toLegacyEvent(c, ref)).filter(Boolean);
  return [...marked, ...legacy].sort((a, b) => (ms(a.at) - ms(b.at)) || ((a.comment_id ?? 0) - (b.comment_id ?? 0)));
}

/** 总 issue 的评论 → 运行笔记。 */
export function selectNotes(comments, login) {
  const notes = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (login && c.user?.login !== login) continue;
    const m = NOTE_MARK_RE.exec(String(c.body ?? ''));
    if (!m) continue;
    try {
      const n = JSON.parse(m[1]);
      if (typeof n.from === 'string') notes.push({ from: n.from, kind: n.kind ?? 'pitfall', broadcast: n.broadcast === true, at: n.at ?? c.created_at ?? null, id: c.id ?? null });
    } catch { /* 坏标记不采信 */ }
  }
  return notes;
}

/** 录下来的 PR 在某个时间点的样子。at 之前还没建的 PR 返回 null。 */
export function toPrAt(pr, at) {
  if (!pr || ms(pr.created_at) > ms(at)) return null;
  const before = (list) => (list ?? []).filter((e) => ms(e.at) <= ms(at));
  const events = before(pr.events);
  const commits = before(pr.commits);
  const readyEvents = events.filter((e) => e.event === 'ready_for_review' || e.event === 'convert_to_draft');
  const lastReady = readyEvents.at(-1);
  const everReady = (pr.events ?? []).some((e) => e.event === 'ready_for_review');
  // 时间线里没有任何转正式事件：PR 要么一直是 Draft，要么建出来就是正式的，按当前状态算。
  const draft = lastReady ? lastReady.event === 'convert_to_draft' : (everReady ? true : pr.draft === true);
  const labelEvents = events.filter((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label === MERGE_READY_LABEL);
  const lastLabel = labelEvents.at(-1);
  const merged = Boolean(pr.merged_at) && ms(pr.merged_at) <= ms(at);
  return {
    number: pr.number,
    base: pr.base ?? null,
    draft: merged ? false : draft,
    merged,
    merged_at: merged ? pr.merged_at : null,
    closed_unmerged: !merged && Boolean(pr.closed_at) && ms(pr.closed_at) <= ms(at),
    head: commits.at(-1)?.sha ?? pr.head_sha ?? null,
    ready_at: lastReady?.event === 'ready_for_review' ? lastReady.at : null,
    label_at: lastLabel?.event === 'labeled' ? lastLabel.at : null,
    first_label_at: labelEvents.find((e) => e.event === 'labeled')?.at ?? null,
    commits: commits.map((c) => ({ sha: c.sha, at: c.at })),
    reviews: before(pr.reviews).map((r) => ({ at: r.at, user: r.user ?? null })),
    pending_checks: pr.pending_checks === true,
  };
}

/** 回放数据（replay-capture.mjs 的输出）→ 某个时间点的事实。只用 at 之前的评论、事件、提交。 */
export function toFacts(data, at, { charter } = {}) {
  const login = data.login ?? null;
  // 回放数据里评论的 user 是登录名字符串，这里还原成 GitHub 评论的形状，后面的解析函数两边通用。
  const upTo = (comments) => (comments ?? []).filter((c) => ms(c.created_at) <= ms(at)).map((c) => (typeof c.user === 'string' || c.user === null ? { ...c, user: { login: c.user } } : c));
  const rootComments = upTo(data.root?.comments);
  const children = (data.children ?? []).map((child) => {
    const closed = Boolean(child.closed_at) && ms(child.closed_at) <= ms(at);
    const prs = (data.prs ?? []).filter((p) => p.task_ref === child.ref).map((p) => toPrAt(p, at)).filter(Boolean);
    // 一个子 issue 应该只有一个 PR；多个时取没被关掉的最新一个。
    // 关掉没合的 PR 不算数（标签可能还留着）：只剩这种 PR 时当成没有 PR，阶段由事件决定。
    const pr = prs.filter((p) => !p.closed_unmerged).at(-1) ?? null;
    return { ref: child.ref, closed, closed_at: closed ? child.closed_at : null, events: selectChildEvents(upTo(child.comments), child.ref, login), pr };
  });
  return {
    root: data.root?.ref ?? null,
    at,
    charter: charter === undefined ? selectCharter(rootComments, login) : charter,
    children,
    notes: selectNotes(rootComments, login),
  };
}

// stage

/** 一个子 issue 现在处在哪个阶段、从什么时候开始、在等谁。 */
export function selectStage(child) {
  const { events = [], pr } = child;
  const of = (...types) => events.filter((e) => types.includes(e.type));
  const dispatch = of('dispatch', 'withdraw').at(-1);
  const verdict = of('verdict_pass', 'verdict_revise').at(-1) ?? null;
  const pass = verdict?.type === 'verdict_pass' ? verdict : null;
  const base = { verdict, pass, session: of('dispatch').at(-1)?.session ?? null };
  if (child.closed) return { ...base, stage: 'closed', since: child.closed_at };
  if (pr?.merged) return { ...base, stage: 'merged', since: pr.merged_at };
  if (pr && !pr.draft) {
    if (pr.label_at) return { ...base, stage: 'merge_ready', since: pr.label_at };
    return { ...base, stage: 'in_review', since: latest(pr.ready_at, verdict?.at) ?? pr.commits[0]?.at ?? null };
  }
  if (pass && pr) return { ...base, stage: 'accepted_draft', since: pass.at };
  const asked = of('ready_for_verdict').at(-1);
  if (asked && (!verdict || ms(asked.at) > ms(verdict.at))) return { ...base, stage: 'awaiting_verdict', since: asked.at };
  if (verdict) return { ...base, stage: 'revising', since: verdict.at };
  if (dispatch?.type === 'dispatch' || pr) return { ...base, stage: 'in_dev', since: dispatch?.type === 'dispatch' ? dispatch.at : pr.commits[0]?.at ?? null };
  return { ...base, stage: 'not_started', since: null };
}

// reconcile

/**
 * 事实 → 每个子 issue 的阶段 + 到期动作。同一份事实永远得到同一份输出。
 * 到期动作的 key 由子 issue、动作、进入该阶段的时间拼成：同一段等待只对应一个 key，敲门方按它去重。
 */
export function reconcile(facts) {
  const { at, charter = null } = facts;
  const children = [];
  const due = [];
  const add = (ref, action, target, since, reason) => due.push({ key: `${ref}|${action}|${since ?? ''}`, ref, action, target, reason });

  for (const child of facts.children ?? []) {
    const s = selectStage(child);
    const rule = DEADLINES[s.stage] ?? null;
    const pr = child.pr ?? null;
    const waited = s.since ? minutesBetween(s.since, at) : null;
    children.push({ ref: child.ref, stage: s.stage, waiting_on: rule?.waiting_on ?? null, since: s.since, waited_min: waited, pr: pr?.number ?? null, session: s.session });
    if (!rule || !s.since) continue;

    // 判通过后代码变了：只认 v3 事件里记的版本（旧手写评论不产生复核）。
    const stale = Boolean(s.pass && !s.pass.legacy && s.pass.head && pr && !pr.merged && pr.head && pr.head !== s.pass.head);
    if (stale) add(child.ref, 'recheck', 'lead', s.pass.at, `判通过时的版本是 ${s.pass.head.slice(0, 7)}，PR #${pr.number} 现在是 ${pr.head.slice(0, 7)}：对新增改动跑一次 check-pr.mjs --stage recheck`);

    const lastCommit = pr?.commits.at(-1)?.at ?? null;
    if (s.stage === 'awaiting_verdict' && waited > rule.minutes) {
      add(child.ref, 'wake_lead', 'lead', s.since, `待验收已等 ${waited} 分钟（期限 ${rule.minutes}）`);
    } else if (s.stage === 'accepted_draft' && waited > rule.minutes) {
      const held = charter?.conflict?.same_file !== 'parallel' && String(s.pass?.note ?? '').startsWith(HOLD_PREFIX);
      if (!held) add(child.ref, 'wake_owner', 'owner', s.since, `判通过已 ${waited} 分钟，PR #${pr?.number ?? '?'} 还是 Draft（期限 ${rule.minutes}）`);
    } else if (s.stage === 'in_review') {
      const active = latest(s.since, lastCommit, pr.reviews.at(-1)?.at);
      const idle = minutesBetween(active, at);
      if (idle > rule.minutes && !pr.pending_checks) add(child.ref, 'wake_lead', 'lead', active, `PR #${pr.number} 转正式后 ${idle} 分钟没有新提交也没有新的审查结论（期限 ${rule.minutes}）：查审查和盯梢是否在处理`);
    } else if (s.stage === 'merge_ready' && waited > rule.minutes) {
      const lacks = [];
      if (!charter) lacks.push('没有运行章程');
      else if (!charter.merge.auto_request) lacks.push('章程没有授权自动交合并请求');
      else if (!baseAllowed(charter, pr.base)) lacks.push(`章程的 merge.bases 不含目标分支 ${pr.base}`);
      if (stale) lacks.push('判通过后的改动还没复核');
      if (lacks.length === 0) add(child.ref, 'request_merge', 'lead', s.since, `PR #${pr.number} 审查放行已 ${waited} 分钟，章程已授权：交合并请求`);
      else add(child.ref, 'wake_lead', 'lead', s.since, `PR #${pr.number} 审查放行已 ${waited} 分钟还没进合并队列（${lacks.join('；')}）`);
    } else if (s.stage === 'in_dev' || s.stage === 'revising') {
      const blocked = (child.events ?? []).filter((e) => e.type === 'blocked').at(-1);
      const active = latest(s.since, lastCommit);
      const idle = minutesBetween(active, at);
      // 「卡住」只在它之后没有新提交时算数：恢复提交后再停滞，照常探活。
      const isBlocked = blocked && ms(blocked.at) >= ms(active);
      if (idle > rule.minutes && !pr?.pending_checks && !isBlocked) add(child.ref, 'wake_owner', 'owner', active, `${idle} 分钟没有新提交、没有在跑的检查、也没有「卡住」（期限 ${rule.minutes}）：确认执行会话还在`);
    }
  }

  // 带广播标志的笔记：敲一次还在开发的兄弟会话（PraiseZhu/approve-exec#108）。
  for (const note of facts.notes ?? []) {
    if (!note.broadcast) continue;
    for (const c of children) {
      if (c.ref === note.from || !['in_dev', 'revising'].includes(c.stage)) continue;
      due.push({ key: `${c.ref}|note|${note.id ?? note.at}`, ref: c.ref, action: 'wake_owner', target: 'owner', reason: `${note.from} 记了一条${note.kind === 'decision' ? '决定' : '坑'}，可能和你有关：node scripts/note.mjs list --root ${facts.root}` });
    }
  }
  return { ok: true, root: facts.root, at, children, due };
}

// report

const hours = (from, to) => (from && to && ms(to) >= ms(from) ? Math.round(((ms(to) - ms(from)) / 3600000) * 10) / 10 : null);
const cell = (v, unit = '') => (v === null || v === undefined ? '无记录' : `${v}${unit}`);

/** 一个子 issue 的各段用时与计数（没有数据的格子是 null，不写 0）。 */
export function toReportRow(child) {
  const { events = [], pr } = child;
  const first = (type) => events.find((e) => e.type === type) ?? null;
  const dispatch = first('dispatch');
  const actualRoute = events.filter((e) => e.type === 'dispatch').at(-1)?.route;
  const pass = events.filter((e) => e.type === 'verdict_pass').at(0) ?? null;
  const idx = pass?.head && pr ? pr.commits.findIndex((c) => c.sha === pass.head) : -1;
  const after = !pass || !pr ? null : idx >= 0 ? pr.commits.length - idx - 1 : pr.commits.filter((c) => ms(c.at) > ms(pass.at)).length;
  const pre = events.filter((e) => e.type === 'prereview');
  const preRounds = pre.length ? Number(/(\d+)\s*轮/.exec(pre.at(-1).note ?? '')?.[1] ?? pre.length) : null;
  const scopeNote = /范围外\s*(\d+)/.exec(events.filter((e) => e.type === 'verdict_pass' || e.type === 'verdict_revise').map((e) => e.note ?? '').join(' '))?.[1];
  return {
    ref: child.ref,
    pr: pr?.number ?? null,
    kind: actualRoute?.kind ?? '未记录',
    model: actualRoute?.model ?? '未记录',
    dev_h: hours(dispatch?.at, pass?.at),
    to_ready_h: hours(pass?.at, pr?.ready_at),
    review_h: hours(pr?.ready_at, pr?.first_label_at),
    merge_h: hours(pr?.first_label_at, pr?.merged_at),
    review_rounds: pr?.ready_at ? pr.reviews.filter((r) => ms(r.at) >= ms(pr.ready_at)).length : null,
    commits_after_pass: after,
    out_of_scope: scopeNote === undefined ? null : Number(scopeNote),
    prereview_rounds: preRounds,
    dispatched_at: dispatch?.at ?? null,
    merged_at: pr?.merged_at ?? null,
  };
}

/** 事实 → 运行报告（Markdown）。 */
export function toReport(facts) {
  const rows = (facts.children ?? []).map(toReportRow);
  const start = rows.map((r) => r.dispatched_at).filter(Boolean).sort()[0] ?? null;
  const end = rows.map((r) => r.merged_at).filter(Boolean).sort().at(-1) ?? null;
  const lines = [
    `批准执行运行报告：${facts.root}`,
    '',
    `- 从第一次派发到最后一次合入：${cell(hours(start, end), ' 小时')}`,
    `- 运行笔记：${(facts.notes ?? []).length} 条`,
    '',
    '| 子 issue | PR | 类型 | 模型 | 派发到判通过 | 判通过到转正式 | 转正式到审查放行 | 审查放行到合入 | 审查轮数 | 判通过后新增提交 | 范围外文件 | 预审轮数 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.ref} | ${r.pr ? `#${r.pr}` : '无记录'} | ${r.kind} | ${r.model} | ${cell(r.dev_h, ' 小时')} | ${cell(r.to_ready_h, ' 小时')} | ${cell(r.review_h, ' 小时')} | ${cell(r.merge_h, ' 小时')} | ${cell(r.review_rounds)} | ${cell(r.commits_after_pass)} | ${cell(r.out_of_scope)} | ${cell(r.prereview_rounds)} |`),
  ];
  return { rows, markdown: lines.join('\n') };
}

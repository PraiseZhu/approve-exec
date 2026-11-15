// reconcile-rules.mjs：阶段判定、期限、幂等、章程分路、广播、运行报告（PraiseZhu/approve-exec#103、#105、#108）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, DEADLINES, STAGES, reconcile, selectStage, toFacts, toReport } from '../scripts/lib/reconcile-rules.mjs';
import { toCharter } from '../scripts/charter.mjs';
import { capture } from '../scripts/replay-capture.mjs';
import { readFacts } from '../scripts/reconcile.mjs';

const R = 'acme/app';
const ref = (n) => `${R}#${n}`;
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const T = (hhmm) => `2026-11-14T${hhmm}:00Z`;
const CHARTER = toCharter({
  merge: { auto_request: true, bases: ['main', 'integration/*'] }, conflict: { same_file: 'parallel' }, prereview: 'feature',
  early_start: true, max_parallel: 6, manual_test: 'x', user_words: 'x', lead_session: `${'a'.repeat(64)}::lead-1`,
});

const ev = (type, at, extra = {}) => ({ type, ref: ref(11), at, pr: 5, head: H1, ...extra });
const pr = (over = {}) => ({ number: 5, base: 'main', draft: true, merged: false, merged_at: null, head: H1, ready_at: null, label_at: null, first_label_at: null, commits: [{ sha: H1, at: T('01:00') }], reviews: [], pending_checks: false, ...over });
const child = (over = {}) => ({ ref: ref(11), closed: false, closed_at: null, events: [], pr: null, ...over });
const facts = (children, over = {}) => ({ root: ref(10), at: T('12:00'), charter: null, children, notes: [], ...over });
const stageOf = (c) => selectStage(c).stage;
const dueOf = (f) => reconcile(f).due.map((d) => `${d.action}@${d.ref.split('#')[1]}`);

test('9 种阶段各判一次', () => {
  const dispatch = ev('dispatch', T('00:00'), { session: 's11' });
  const cases = {
    not_started: child(),
    in_dev: child({ events: [dispatch] }),
    awaiting_verdict: child({ events: [dispatch, ev('ready_for_verdict', T('02:00'))], pr: pr() }),
    revising: child({ events: [dispatch, ev('ready_for_verdict', T('02:00')), ev('verdict_revise', T('02:10'))], pr: pr() }),
    accepted_draft: child({ events: [dispatch, ev('verdict_pass', T('02:10'))], pr: pr() }),
    in_review: child({ events: [dispatch, ev('verdict_pass', T('02:10'))], pr: pr({ draft: false, ready_at: T('02:20') }) }),
    merge_ready: child({ events: [dispatch, ev('verdict_pass', T('02:10'))], pr: pr({ draft: false, ready_at: T('02:20'), label_at: T('03:00') }) }),
    merged: child({ events: [dispatch], pr: pr({ draft: false, merged: true, merged_at: T('04:00') }) }),
    closed: child({ closed: true, closed_at: T('04:05'), events: [dispatch] }),
  };
  assert.deepEqual(Object.keys(cases), STAGES);
  for (const [want, c] of Object.entries(cases)) assert.equal(stageOf(c), want, want);
  // 要改之后又发了待验收 → 回到等 lead
  assert.equal(stageOf(child({ events: [dispatch, ev('verdict_revise', T('02:10')), ev('ready_for_verdict', T('03:00'))], pr: pr() })), 'awaiting_verdict');
  // 撤回后没有 PR → 回到没开始
  assert.equal(stageOf(child({ events: [dispatch, ev('withdraw', T('01:00'))] })), 'not_started');
});

test('期限：到期才产生动作，动作只有四种，等谁写得对', () => {
  const dispatch = ev('dispatch', T('00:00'), { session: 's11' });
  const waiting = child({ events: [dispatch, ev('ready_for_verdict', T('11:50'))], pr: pr() });
  assert.deepEqual(dueOf(facts([waiting])), [], '待验收 10 分钟，没到 15 分钟期限');
  assert.deepEqual(dueOf(facts([waiting], { at: T('12:06') })), ['wake_lead@11']);
  const accepted = child({ events: [dispatch, ev('verdict_pass', T('11:00'), { legacy: true })], pr: pr() });
  const out = reconcile(facts([accepted]));
  assert.deepEqual(out.due.map((d) => [d.action, d.target]), [['wake_owner', 'owner']]);
  assert.equal(out.children[0].waiting_on, 'owner');
  assert.equal(out.children[0].waited_min, 60);
  assert.equal(out.children[0].session, 's11');
  for (const d of out.due) assert.ok(ACTIONS.includes(d.action));
  assert.equal(DEADLINES.accepted_draft.minutes, 30);
});

test('开发中：6 小时内有新提交不算停滞；有在跑的检查、或发过「卡住」也不算', () => {
  const dispatch = ev('dispatch', T('00:00'), { session: 's11' });
  const at = T('07:00');
  assert.deepEqual(dueOf(facts([child({ events: [dispatch] })], { at })), ['wake_owner@11'], '7 小时没有任何动静');
  assert.deepEqual(dueOf(facts([child({ events: [dispatch], pr: pr({ commits: [{ sha: H1, at: T('05:00') }] }) })], { at })), []);
  assert.deepEqual(dueOf(facts([child({ events: [dispatch], pr: pr({ pending_checks: true }) })], { at })), []);
  assert.deepEqual(dueOf(facts([child({ events: [dispatch, ev('blocked', T('00:30'))] })], { at })), []);
});

test('审查中：2 小时内有新提交或新审查结论不算停滞', () => {
  const events = [ev('dispatch', T('00:00'), { session: 's11' }), ev('verdict_pass', T('02:10'), { legacy: true })];
  const quiet = child({ events, pr: pr({ draft: false, ready_at: T('02:20') }) });
  assert.deepEqual(dueOf(facts([quiet], { at: T('04:30') })), ['wake_lead@11']);
  const active = child({ events, pr: pr({ draft: false, ready_at: T('02:20'), reviews: [{ at: T('03:30') }] }) });
  assert.deepEqual(dueOf(facts([active], { at: T('04:30') })), []);
});

test('幂等：同一份事实算两遍，输出逐字节相同', () => {
  const f = facts([
    child({ events: [ev('dispatch', T('00:00'), { session: 's11' }), ev('verdict_pass', T('02:00'), { legacy: true })], pr: pr() }),
    child({ ref: ref(12), events: [{ type: 'dispatch', ref: ref(12), at: T('00:00'), session: 's12' }] }),
  ]);
  assert.equal(JSON.stringify(reconcile(f)), JSON.stringify(reconcile(structuredClone(f))));
});

test('复核：只认 v3 事件里记的版本；旧手写裁决不产生复核；重新判通过后消失', () => {
  const dispatch = ev('dispatch', T('00:00'), { session: 's11' });
  const moved = pr({ draft: false, ready_at: T('02:20'), head: H2, commits: [{ sha: H1, at: T('01:00') }, { sha: H2, at: T('11:30') }] });
  assert.deepEqual(dueOf(facts([child({ events: [dispatch, ev('verdict_pass', T('02:10'))], pr: moved })])), ['recheck@11']);
  assert.deepEqual(dueOf(facts([child({ events: [dispatch, ev('verdict_pass', T('02:10'), { legacy: true })], pr: moved })])), []);
  assert.deepEqual(dueOf(facts([child({ events: [dispatch, ev('verdict_pass', T('02:10')), ev('verdict_pass', T('11:40'), { head: H2 })], pr: moved })])), []);
});

test('章程分路：没有章程任何时候都不交合并请求；授权且目标分支在范围内才交；有未复核的改动不交', () => {
  const events = [ev('dispatch', T('00:00'), { session: 's11' }), ev('verdict_pass', T('02:10'))];
  const ready = (over = {}) => child({ events, pr: pr({ draft: false, ready_at: T('02:20'), label_at: T('11:00'), ...over }) });
  assert.deepEqual(dueOf(facts([ready()])), ['wake_lead@11']);
  assert.match(reconcile(facts([ready()])).due[0].reason, /没有运行章程/);
  assert.deepEqual(dueOf(facts([ready()], { charter: CHARTER })), ['request_merge@11']);
  assert.deepEqual(dueOf(facts([ready({ base: 'integration/s1' })], { charter: CHARTER })), ['request_merge@11']);
  const mainOnly = toCharter({ ...CHARTER, merge: { auto_request: true, bases: ['main'] } });
  const out = reconcile(facts([ready({ base: 'integration/s1' })], { charter: mainOnly }));
  assert.deepEqual(out.due.map((d) => d.action), ['wake_lead']);
  assert.match(out.due[0].reason, /integration\/s1/);
  const stale = ready({ head: H2, commits: [{ sha: H1, at: T('01:00') }, { sha: H2, at: T('10:00') }] });
  assert.deepEqual(dueOf(facts([stale], { charter: CHARTER })).sort(), ['recheck@11', 'wake_lead@11']);
});

test('暂缓转正式：章程是串行（或没有章程）时 lead 写了暂缓就不催；章程是并行时照常催', () => {
  const events = [ev('dispatch', T('00:00'), { session: 's11' }), ev('verdict_pass', T('02:10'), { note: '暂缓转正式：等 #12 先合，两个 PR 都改了基线文件' })];
  const held = child({ events, pr: pr() });
  assert.deepEqual(dueOf(facts([held])), []);
  assert.deepEqual(dueOf(facts([held], { charter: toCharter({ ...CHARTER, conflict: { same_file: 'serial' } }) })), []);
  assert.deepEqual(dueOf(facts([held], { charter: CHARTER })), ['wake_owner@11']);
});

test('广播笔记：敲还在开发或返工的兄弟会话各一次，发笔记的自己不敲，已转正式的不敲', () => {
  const d = (n) => ({ type: 'dispatch', ref: ref(n), at: T('11:00'), session: `s${n}` });
  const children = [
    child({ events: [d(11)] }),
    child({ ref: ref(12), events: [d(12)] }),
    child({ ref: ref(13), events: [d(13), { type: 'verdict_pass', ref: ref(13), at: T('11:30'), legacy: true }], pr: pr({ draft: false, ready_at: T('11:40') }) }),
  ];
  const note = { from: ref(11), kind: 'pitfall', broadcast: true, at: T('11:50'), id: 900 };
  const out = reconcile(facts(children, { notes: [note, { ...note, id: 901, broadcast: false }] }));
  assert.deepEqual(out.due.map((x) => [x.ref, x.action]), [[ref(12), 'wake_owner']]);
  assert.match(out.due[0].reason, /note\.mjs list/);
});

test('运行报告：各段用时、审查轮数、判通过后新增提交；没有数据的格子写「无记录」不写 0', () => {
  const c = child({
    events: [ev('dispatch', T('00:00'), { session: 's11' }), ev('verdict_pass', T('01:30')), ev('prereview', T('01:20'), { note: '2 轮，修了 3 条' })],
    pr: pr({ draft: false, merged: true, merged_at: T('09:00'), ready_at: T('02:00'), first_label_at: T('06:00'), reviews: [{ at: T('03:00') }, { at: T('05:00') }], commits: [{ sha: H1, at: T('01:00') }, { sha: H2, at: T('04:00') }] }),
  });
  const { rows, markdown } = toReport(facts([c, child({ ref: ref(12) })]));
  assert.deepEqual({ dev: rows[0].dev_h, ready: rows[0].to_ready_h, review: rows[0].review_h, merge: rows[0].merge_h }, { dev: 1.5, ready: 0.5, review: 4, merge: 3 });
  assert.equal(rows[0].review_rounds, 2);
  assert.equal(rows[0].commits_after_pass, 1);
  assert.equal(rows[0].prereview_rounds, 2);
  const emptyRow = markdown.split('\n').find((l) => l.startsWith(`| ${ref(12)} `));
  assert.equal((emptyRow.match(/无记录/g) ?? []).length, 9);
  assert.match(markdown, /从第一次派发到最后一次合入：9 小时/);
});

// 现读模式：只读 GitHub

function liveFixture() {
  const issue = (n, extra = {}) => ({ number: n, title: `t${n}`, body: 'b', state: 'open', state_reason: null, created_at: T('00:00'), closed_at: null, repository_url: `https://api.github.com/repos/${R}`, ...extra });
  const mark = (payload) => `x\n\n<!-- approve-exec:event v1 ${JSON.stringify(payload)} -->`;
  return {
    [`api repos/${R}/issues/10`]: issue(10, { title: '[总] x' }),
    [`api repos/${R}/issues/10/sub_issues?per_page=100`]: [issue(11)],
    'api user': { login: 'lead-account' },
    [`api repos/${R}/issues/10/comments?per_page=100&page=1`]: [],
    [`api repos/${R}/issues/11/comments?per_page=100&page=1`]: [
      { id: 1, user: { login: 'lead-account' }, created_at: T('00:10'), body: mark({ type: 'dispatch', ref: ref(11), session: 's11', at: T('00:10'), id: 'd' }) },
      { id: 2, user: { login: 'lead-account' }, created_at: T('01:00'), body: mark({ type: 'verdict_pass', ref: ref(11), pr: 5, head: H1, at: T('01:00'), id: 'v' }) },
    ],
    [`api repos/${R}/issues/11/timeline?per_page=100&page=1`]: [{ event: 'cross-referenced', created_at: T('00:20'), source: { issue: { number: 5, pull_request: {}, repository_url: `https://api.github.com/repos/${R}` } } }],
    [`api repos/${R}/pulls/5`]: { number: 5, title: 'pr', state: 'open', draft: true, body: `任务 issue：${ref(11)}`, base: { ref: 'main' }, head: { sha: H1 }, created_at: T('00:20'), closed_at: null, merged_at: null },
    [`api repos/${R}/issues/5/timeline?per_page=100&page=1`]: [],
    [`api repos/${R}/pulls/5/commits?per_page=100&page=1`]: [{ sha: H1, parents: [{}], commit: { committer: { date: T('00:30') }, message: 'feat: x' } }],
    [`api repos/${R}/pulls/5/reviews?per_page=100&page=1`]: [],
    [`api repos/${R}/commits/${H1}/check-runs?per_page=100`]: { check_runs: [{ status: 'completed' }] },
  };
}

test('现读：对账器只发读请求，一次写请求都没有；判出阶段和到期动作', () => {
  const fixture = liveFixture();
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    if (!Object.hasOwn(fixture, key)) throw new Error(`gh 夹具缺少: ${key}`);
    return fixture[key];
  };
  const f = readFacts({ gh, rootRef: ref(10), now: T('02:00') });
  const out = reconcile(f);
  assert.equal(out.children[0].stage, 'accepted_draft');
  assert.deepEqual(out.due.map((d) => d.action), ['wake_owner']);
  assert.ok(calls.length > 5);
  assert.deepEqual(calls.filter((c) => /-X (POST|PATCH|PUT|DELETE)/.test(c)), []);
  // 轻量现读不逐个读提交的改动文件
  assert.equal(calls.some((c) => c === `api repos/${R}/commits/${H1}`), false);
  // 回放路径和现读路径是同一份数据结构
  assert.equal(toFacts(capture({ gh, rootRef: ref(10), light: true, now: T('02:00') }), T('02:00')).children[0].pr.number, 5);
});

test('发过「卡住」之后又有新提交、再停滞：照常探活（单审 P2）', () => {
  const c = child({ events: [ev('dispatch', T('00:00'), { session: 's11' }), ev('blocked', T('01:00'))], pr: pr({ commits: [{ sha: H1, at: T('02:00') }] }) });
  assert.deepEqual(dueOf(facts([c], { at: T('10:00') })), ['wake_owner@11']);
});

test('唯一的 PR 关掉没合、标签还留着：不当成审查放行，不产生合并类动作（单审 P2）', () => {
  const data = {
    login: 'u', root: { ref: ref(10), comments: [] },
    children: [{ ref: ref(11), closed_at: null, comments: [
      { id: 1, user: 'u', created_at: T('00:00'), body: `批准执行派发：2026-11-14 ${ref(11)} → 会话 s11（t）` },
      { id: 2, user: 'u', created_at: T('01:00'), body: `批准执行通过 ${ref(11)} PR #5（head ${H1}）` },
    ] }],
    prs: [{ number: 5, task_ref: ref(11), base: 'main', draft: false, created_at: T('00:10'), closed_at: T('03:00'), merged_at: null,
      events: [{ event: 'ready_for_review', at: T('01:10') }, { event: 'labeled', at: T('02:00'), label: 'review:merge-ready' }], commits: [{ sha: H1, at: T('00:30') }], reviews: [] }],
  };
  const out = reconcile(toFacts(data, T('12:00'), { charter: CHARTER }));
  assert.equal(out.children[0].pr, null);
  assert.notEqual(out.children[0].stage, 'merge_ready');
  assert.equal(out.due.some((d) => d.action === 'request_merge'), false);
});

test('#112 运行报告使用最新一次派发的实际类型模型，旧事件未记录不倒推', () => {
  const events = [ev('dispatch', T('00:00'), { session: 'failed', route: { agent: 'claude-code', kind: '混合', model: 'old-model', route_index: 0 } }), ev('withdraw', T('00:01')), ev('dispatch', T('00:02'), { session: 'fallback', route: { agent: 'codex', kind: '逻辑', model: 'gpt-6.1-sol', route_index: 1 } })];
  const { rows, markdown } = toReport(facts([child({ events }), child({ ref: ref(12), events: [ev('dispatch', T('00:00'))] })]));
  assert.equal(rows[0].kind, '逻辑'); assert.equal(rows[0].model, 'gpt-6.1-sol');
  assert.equal(rows[1].model, '未记录'); assert.equal(rows[1].kind, '未记录');
  assert.match(markdown, /类型 \| 模型/); assert.match(markdown, /逻辑 \| gpt-6.1-sol/);
  const latestOld = toReport(facts([child({ events: [...events, ev('dispatch', T('00:03'))] })]));
  assert.equal(latestOld.rows[0].model, '未记录');
});

// issue-run.mjs：一次性认领、派会话请求、会话回执（PraiseZhu/approve-exec#68 SC5、SC6、SC8）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildPlan, readRoot } from '../scripts/issue-plan.mjs';
import { init, next, prepare, bind, release, checkpoint, verdict, unblock, freeWorktree, soleOpenPr, cleanup, archived, runStatus, status, sessionTitle, projectName, sessionIdFrom, activeClaims, REQUEST_KEYS, RunError } from '../scripts/issue-run.mjs';
import { hashObject } from '../scripts/lib/common.mjs';
import { REPO, LOGIN, commentsKey, openPullsKey, parentFixture, writeFixture, ghFrom } from './fixtures/issues/build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'scripts/issue-run.mjs');
const NOW = '2026-10-29T08:00:00.000Z';
const A = `${REPO}#11`;
const C = `${REPO}#13`;

function setup({ lead = 'claude-code', fixture = parentFixture(), source = 'chat', authorization, entryRef = `${REPO}#10` } = {}) {
  const fx = writeFixture(fixture);
  const gh = ghFrom(fixture);
  const { root: r, children } = readRoot(gh, entryRef);
  const plan = buildPlan({ root: r, children, repoDirs: { [REPO]: fx.repoDir }, lead, entry: '批准执行 acme/app#10', authorization, source, now: NOW });
  const planPath = join(fx.dir, 'plan.json');
  const ledgerPath = join(fx.dir, `ledger-${entryRef.split('#')[1]}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  init({ plan, planPath, ledgerPath, now: NOW });
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  return { ...fx, fixture, gh, plan, planPath, ledgerPath, ledger };
}

// 认领 / 登记 / 释放记在子 issue 自己的评论区；登记另抄一份到总 issue。
const COMMENTS = commentsKey(11);
const ROOT_COMMENTS = commentsKey(10);

test('SC5 派会话请求只有四个键：title / message / working_dir（主目录绝对路径）/ use_worktree=false', () => {
  const { ledger, plan, gh, repoDir } = setup();
  const res = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  assert.equal(res.claimed, true);
  assert.deepEqual(Object.keys(res.request).sort(), [...REQUEST_KEYS].sort());
  assert.equal(res.request.working_dir, repoDir);
  assert.equal(res.request.use_worktree, false);
  for (const k of ['agent_kind', 'model', 'effort', 'provider_id']) assert.equal(Object.hasOwn(res.request, k), false, `请求不得含 ${k}`);
  assert.equal(res.request.title, 'App-同步状态读取丨 1029');
});

test('SC5 lead 是 Pi 时 CLI 退出码 2，写明准确理由（#74）', () => {
  const { ledgerPath, ledger } = setup();
  ledger.lead_agent = 'pi';
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const res = spawnSync(process.execPath, [CLI, 'prepare', '--ledger', ledgerPath, '--item', A, '--lead-session', 'lead-1', '--now', NOW], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /owner 会话沿用 lead 的执行框架/);
  assert.match(res.stderr, /KEEL 只给 claude-code \/ codex 配了默认主控方案/);
  assert.doesNotMatch(res.stderr, /不接受 Pi/);
});

test('SC6 同一子 issue 第二次 prepare 返回已认领，不生成第二个请求', () => {
  const { ledger, plan, gh } = setup();
  const first = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  const second = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'already_claimed');
  assert.equal(Object.hasOwn(second, 'request'), false);
});

test('SC6 bind 收到失败或未知回执 → dispatch_unknown，此后 prepare 拒绝；release 要求依据并发释放评论', () => {
  const { ledger, plan, gh, fixture } = setup();
  const { claim_id } = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  const res = bind({ ledger, ref: A, claimId: claim_id, result: { ok: false, errorCode: 'INVALID_ARGS' }, gh, now: NOW });
  assert.equal(res.ok, false);
  assert.equal(ledger.items[A].state, 'dispatch_unknown');
  assert.throws(() => prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW }), (e) => e instanceof RunError && /结果未知/.test(e.message));
  assert.throws(() => release({ ledger, ref: A, evidence: '', gh, now: NOW }), /需要 --evidence/);
  release({ ledger, ref: A, evidence: 'list_sessions 无同名会话；回执 errorCode=INVALID_ARGS 为派发前拒绝', gh, now: NOW });
  assert.equal(ledger.items[A].state, 'pending');
  assert.match(fixture[COMMENTS].at(-1).body, new RegExp(`^批准执行释放：2026-10-29 acme/app#11 claim ${claim_id}：list_sessions 无同名会话`));
  assert.deepEqual(activeClaims(fixture[COMMENTS], A, LOGIN), [], '释放后不再算占用');
  assert.equal(prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW }).claimed, true, '同一台账释放后可以重新认领');
});

test('SC6 跨台账：另一份台账对同一子 issue prepare 时读到未释放的认领 / 登记评论就拒绝', () => {
  const s = setup();
  const first = prepare({ ledger: s.ledger, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: s.gh, now: NOW });
  assert.equal(first.claimed, true);
  assert.match(s.fixture[COMMENTS][0].body, new RegExp(`^批准执行认领：2026-10-29 acme/app#11 claim ${first.claim_id}`));
  // 同一份计划、另一份台账（换会话、换机器重新「批准执行」）共用同一个总 issue 评论区。
  const otherLedger = join(s.dir, 'ledger-b.json');
  init({ plan: s.plan, planPath: s.planPath, ledgerPath: otherLedger, now: NOW });
  const b = JSON.parse(readFileSync(otherLedger, 'utf8'));
  assert.throws(() => prepare({ ledger: b, plan: s.plan, ref: A, leadSessionId: 'lead-2', gh: s.gh, now: NOW }),
    (e) => e instanceof RunError && e.message.includes(`已有未释放的批准执行认领（claim ${first.claim_id}`));
  bind({ ledger: s.ledger, ref: A, claimId: first.claim_id, result: { target_session_id: 's1' }, gh: s.gh, now: NOW });
  assert.throws(() => prepare({ ledger: b, plan: s.plan, ref: A, leadSessionId: 'lead-2', gh: s.gh, now: NOW }), /已有未释放的批准执行/);
  assert.equal(prepare({ ledger: b, plan: s.plan, ref: `${REPO}#12`, leadSessionId: 'lead-2', gh: s.gh, now: NOW }).claimed, true, '别的子 issue 不受影响');
});

test('activeClaims：只认本账号、本子 issue 的认领 / 登记，按评论 id 排序，释放后清除；#110 不算 #11', () => {
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const id3 = '33333333-3333-4333-8333-333333333333';
  const me = { login: LOGIN };
  const comments = [
    { id: 30, user: me, body: `批准执行认领：2026-10-29 acme/app#11 claim ${id3}（台账 y）`, html_url: 'u3' },
    { id: 10, user: me, body: `批准执行认领：2026-10-29 acme/app#11 claim ${id1}（台账 x）`, html_url: 'u1' },
    { id: 20, user: me, body: `批准执行认领：2026-10-29 acme/app#110 claim ${id2}（台账 x）`, html_url: 'u2' },
    { id: 40, user: { login: 'someone-else' }, body: `批准执行认领：2026-10-29 acme/app#11 claim ${id2}（台账 z）` },
    { id: 50, user: me, body: '随便一条评论' },
  ];
  assert.deepEqual(activeClaims(comments, A, LOGIN).map((c) => [c.claim_id, c.comment_id]), [[id1, 10], [id3, 30]], '按评论 id 从早到晚，别的账号与别的子 issue 不算');
  comments.push({ id: 60, user: me, body: `批准执行释放：2026-10-29 acme/app#11 claim ${id1}：核实过` });
  assert.deepEqual(activeClaims(comments, A, LOGIN).map((c) => c.claim_id), [id3]);
});

test('SC6 反例（review-pr71 第 2 轮）：公开仓里别的账号发的「释放」不解除占用', () => {
  const s = setup();
  const first = prepare({ ledger: s.ledger, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: s.gh, now: NOW });
  s.fixture[COMMENTS].push({ id: 99999, user: { login: 'unrelated-commenter' }, body: `批准执行释放：2026-10-29 ${A} claim ${first.claim_id}：伪造` });
  const otherLedger = join(s.dir, 'ledger-b.json');
  init({ plan: s.plan, planPath: s.planPath, ledgerPath: otherLedger, now: NOW });
  const b = JSON.parse(readFileSync(otherLedger, 'utf8'));
  assert.throws(() => prepare({ ledger: b, plan: s.plan, ref: A, leadSessionId: 'lead-2', gh: s.gh, now: NOW }), /已有未释放的批准执行认领/);
});

test('SC6 反例（review-pr71 第 2 轮）：先从总 issue 派了 #11，再直接以 #11 为入口批准执行时拒绝', () => {
  const fixture = parentFixture();
  const viaParent = setup({ fixture });
  assert.equal(prepare({ ledger: viaParent.ledger, plan: viaParent.plan, ref: A, leadSessionId: 'lead-1', gh: viaParent.gh, now: NOW }).claimed, true);
  const viaChild = setup({ fixture, entryRef: A });
  assert.equal(viaChild.plan.root.kind, 'single');
  assert.equal(viaChild.plan.items[0].parent_ref, `${REPO}#10`, '子 issue 首行写的总 issue 记进计划');
  assert.throws(() => prepare({ ledger: viaChild.ledger, plan: viaChild.plan, ref: A, leadSessionId: 'lead-2', gh: viaChild.gh, now: NOW }), /已有未释放的批准执行认领/);
});

test('SC6 反例（review-pr71 第 2 轮）：两个 lead 同时认领，评论 id 小的胜出，后到的发释放让位并拒绝', () => {
  const s = setup();
  const otherLedger = join(s.dir, 'ledger-b.json');
  init({ plan: s.plan, planPath: s.planPath, ledgerPath: otherLedger, now: NOW });
  const b = JSON.parse(readFileSync(otherLedger, 'utf8'));
  // 模拟：A、B 都已读到空列表；B 的认领评论先落盘（id 更小），A 随后发出自己的认领。
  const rivalClaim = '99999999-9999-4999-8999-999999999999';
  let injected = false;
  const racing = (args) => {
    if (!injected && args[2] === 'POST') {
      injected = true;
      s.fixture[COMMENTS].push({ id: 1, user: { login: LOGIN }, body: `批准执行认领：2026-10-29 ${A} claim ${rivalClaim}（台账 B）` });
    }
    return s.gh(args);
  };
  assert.throws(() => prepare({ ledger: s.ledger, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: racing, now: NOW }),
    (e) => e instanceof RunError && e.message.includes(`让给 claim ${rivalClaim}`));
  assert.equal(s.ledger.items[A].state, 'pending', '让位的一方不进 claimed');
  assert.match(s.fixture[COMMENTS].at(-1).body, new RegExp(`^批准执行释放：.*与 claim ${rivalClaim} 同时认领`));
  assert.deepEqual(activeClaims(s.fixture[COMMENTS], A, LOGIN).map((c) => c.claim_id), [rivalClaim], '只剩胜出方的认领');
  assert.throws(() => prepare({ ledger: b, plan: s.plan, ref: A, leadSessionId: 'lead-2', gh: s.gh, now: NOW }), /已有未释放/);
});

test('SC6 反例（review-pr71 第 2 轮）：评论超过 100 条时分页读完，第 101 条的认领也能查到', () => {
  const fixture = parentFixture();
  fixture[commentsKey(11, 1)] = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, user: { login: LOGIN }, body: `普通评论 ${i}` }));
  fixture[commentsKey(11, 2)] = [{ id: 101, user: { login: LOGIN }, body: `批准执行认领：2026-10-29 ${A} claim 44444444-4444-4444-8444-444444444444（台账 old）`, html_url: 'u101' }];
  const s = setup({ fixture });
  assert.throws(() => prepare({ ledger: s.ledger, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: s.gh, now: NOW }), /claim 44444444-4444-4444-8444-444444444444/);
});

test('bind 成功：记会话 id，在总 issue 发登记评论；认领号不对时拒绝', () => {
  const { ledger, plan, gh, fixture } = setup();
  const { claim_id } = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  assert.throws(() => bind({ ledger, ref: A, claimId: 'wrong', result: { target_session_id: 's1' }, gh, now: NOW }), /认领号对不上/);
  const res = bind({ ledger, ref: A, claimId: claim_id, result: { target_session_id: 's1', wake_kind: 'created' }, gh, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(ledger.items[A].state, 'dispatched');
  const reg = `批准执行登记：2026-10-29 acme/app#11 → 会话 s1（App-同步状态读取丨 1029）claim ${claim_id}`;
  assert.equal(fixture[COMMENTS].at(-1).body, reg, '子 issue 上的登记是防重依据');
  assert.equal(fixture[ROOT_COMMENTS].at(-1).body, reg, '总 issue 上抄一份方便看全');
  assert.ok(res.comment_url && res.root_comment_url);
  assert.equal(sessionIdFrom({ ok: true, data: { target_session_id: 's2' } }), 's2');
  assert.equal(sessionIdFrom({ ok: true }), null);
});

test('bind 成功但登记评论发不出去：仍记 dispatched，返回错误与待补发正文', () => {
  const { ledger, plan, gh } = setup();
  const { claim_id } = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  const failing = (args) => { if (args[2] === 'POST') throw new Error('HTTP 502'); return gh(args); };
  const res = bind({ ledger, ref: A, claimId: claim_id, result: { target_session_id: 's1' }, gh: failing, now: NOW });
  assert.equal(ledger.items[A].state, 'dispatched');
  assert.equal(res.comment_error, 'HTTP 502');
  assert.equal(res.root_comment_error, 'HTTP 502');
  assert.match(res.comment, /^批准执行登记：/);
});

test('next：依赖未关闭的排在 waiting，依赖关闭后才可派；依赖被关成「不做」也不放行', () => {
  let s = setup();
  let out = next({ ledger: s.ledger, gh: s.gh });
  assert.ok(out.dispatchable.includes(A));
  assert.ok(!out.dispatchable.includes(C));
  assert.deepEqual(out.waiting.find((w) => w.ref === C).waiting_on, [{ ref: A, ok: false, reason: 'open' }]);
  assert.throws(() => prepare({ ledger: s.ledger, plan: s.plan, ref: C, leadSessionId: 'l', gh: s.gh, now: NOW }), /依赖还没满足/);

  s = setup({ fixture: parentFixture({ aState: 'closed', aReason: 'completed' }) });
  out = next({ ledger: s.ledger, gh: s.gh });
  assert.ok(out.dispatchable.includes(C));

  s = setup({ fixture: parentFixture({ aState: 'closed', aReason: 'not_planned' }) });
  out = next({ ledger: s.ledger, gh: s.gh });
  assert.equal(out.waiting.find((w) => w.ref === C).waiting_on[0].reason, 'not_planned');
});

test('SC8 台账带 source 与 authorization_source', () => {
  const s = setup({ source: 'script', authorization: '看板推进器：用户 2026-10-29 常设授权' });
  assert.equal(s.ledger.source, 'script');
  assert.equal(s.ledger.authorization_source, '看板推进器：用户 2026-10-29 常设授权');
  assert.equal(setup().ledger.authorization_source, '批准执行 acme/app#10');
});

test('init 幂等：同一份计划再 init 不新建；换计划拒绝', () => {
  const s = setup();
  assert.equal(init({ plan: s.plan, planPath: s.planPath, ledgerPath: s.ledgerPath, now: NOW }).created, false);
  assert.throws(() => init({ plan: { ...s.plan, entry: 'x' }, planPath: s.planPath, ledgerPath: s.ledgerPath, now: NOW }), /对应另一份计划/);
});

test('CLI 全流程：init → next → prepare → bind，台账落盘', () => {
  const fixture = parentFixture();
  const fx = writeFixture(fixture);
  const plan = JSON.parse(spawnSync(process.execPath, [join(root, 'scripts/issue-plan.mjs'), '--issue', `${REPO}#10`, '--lead-agent', 'codex',
    '--repo-dir', `${REPO}=${fx.repoDir}`, '--entry', '批准执行', '--out', join(fx.dir, 'plan.json'), '--gh-fixture', fx.ghPath, '--now', NOW],
  { encoding: 'utf8' }).stdout).plan;
  const ledger = join(fx.dir, 'ledger.json');
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--ledger', ledger, '--now', NOW, '--gh-fixture', fx.ghPath], { encoding: 'utf8' });
  assert.equal(run('init', '--plan', plan).status, 0);
  assert.ok(JSON.parse(run('next').stdout).dispatchable.includes(A));
  const prep = JSON.parse(run('prepare', '--item', A, '--lead-session', 'lead-9').stdout);
  const resultPath = join(fx.dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify({ target_session_id: 'sess-9' }));
  const b = run('bind', '--item', A, '--claim', prep.claim_id, '--result', resultPath);
  assert.equal(b.status, 0, b.stderr);
  const saved = JSON.parse(readFileSync(ledger, 'utf8'));
  assert.equal(saved.items[A].session_id, 'sess-9');
  assert.equal(saved.lead_session_id, 'lead-9');
  assert.ok(saved.version >= 3);
});

test('会话标题：已知仓用固定前缀，其余仓名去掉 project- 后转 PascalCase；无汉字时用「任务<号>」', () => {
  assert.equal(projectName('xindong/mivo-canvas-plugin'), 'MivoPlugin');
  assert.equal(projectName('PraiseZhu/project-keel'), 'Keel');
  assert.equal(projectName('PraiseZhu/approve-exec'), 'ApproveExec');
  assert.equal(sessionTitle({ title: 'Fix sync', number: 7, repo: 'a/b' }, NOW), 'B-任务7丨 1029');
  assert.equal(sessionTitle({ title: '[子2/4] 批准执行收口：owner 停在验收点', number: 69, repo: 'PraiseZhu/approve-exec' }, '2026-10-29T17:00:00.000Z'), 'ApproveExec-批准执行收口丨 1030');
});

// owner 收口、lead 验收与收尾（PraiseZhu/approve-exec#69 SC5、SC7、SC8）

const HEAD = 'a'.repeat(40);
const SC_OK = [{ id: 'SC1', status: 'pass' }, { id: 'SC2', status: 'pass' }, { id: 'SC3', status: 'manual' }, { id: 'SC4', status: 'pass' }];

function dispatched(opts) {
  const s = setup(opts);
  const { claim_id } = prepare({ ledger: s.ledger, ledgerPath: s.ledgerPath, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: s.gh, now: NOW });
  bind({ ledger: s.ledger, ref: A, claimId: claim_id, result: { target_session_id: 'owner-1' }, gh: s.gh, now: NOW });
  return s;
}

function awaiting(s, { lane = 'draft-gated-handoff', head = HEAD } = {}) {
  return checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head, sc: SC_OK, keelRun: 'keel-1', lane, now: NOW });
}

const RUN_META = { keelRun: 'keel-1', lane: 'draft-gated-handoff' };
const okCheck = (over = {}) => ({ ok: true, stage: 'acceptance', ref: A, pr: 5, head: HEAD, checked_at: NOW, ...over });

test('checkpoint awaiting_acceptance：SC 表要覆盖子 issue 全部 SC，KEEL 管的必须 pass，黑盒项只能 manual / not_run', () => {
  const s = dispatched();
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: SC_OK.slice(1), ...RUN_META, now: NOW }), /缺: SC1/);
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: [{ id: 'SC1', status: 'fail' }, ...SC_OK.slice(1)], ...RUN_META, now: NOW }), /SC1 还没有通过/);
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: SC_OK.map((x) => (x.id === 'SC3' ? { ...x, status: 'pass' } : x)), ...RUN_META, now: NOW }), /SC3 是合并前拿不到证据/);
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: 'abc', sc: SC_OK, now: NOW }), /--head 必须是 40 位/);
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: SC_OK, lane: 'personal', now: NOW }), /缺 --keel-run/, 'SC1 要求 checkpoint 带 KEEL run_id');
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: SC_OK, keelRun: 'keel-1', now: NOW }), /--lane 只能是/);
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: SC_OK, keelRun: 'keel-1', lane: 'handoff', now: NOW }), /--lane 只能是/);
  const res = awaiting(s);
  assert.equal(res.state, 'awaiting_acceptance');
  assert.equal(s.ledger.items[A].checkpoint.pr, 5);
  assert.equal(s.ledger.items[A].checkpoint_seq, 1);
});

test('verdict --pass：要同一 PR、同一 head、ok 的 accept-check；交接车道让 owner 调 pr_ready 并用台账里的授权原话', () => {
  const s = dispatched();
  awaiting(s);
  assert.throws(() => verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck({ head: 'b'.repeat(40) }), now: NOW }), /同一 PR、同一 head/);
  assert.throws(() => verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck({ ok: false }), now: NOW }), /ok=true/);
  const res = verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck(), now: NOW });
  assert.equal(res.state, 'accepted');
  assert.equal(res.target_session_id, 'owner-1');
  assert.match(res.owner_message, /pr_ready，authorization_source 填「批准执行 acme\/app#10」/);
});

test('#77 SC5 verdict --pass：三种车道都让 owner 调 pr_ready 再写 ready，不再说「PR 已经是 Ready」', () => {
  for (const lane of ['personal', 'gated-handoff', 'draft-gated-handoff']) {
    const s = dispatched();
    awaiting(s, { lane });
    const res = verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck(), now: NOW });
    assert.match(res.owner_message, /现在调 KEEL 的 pr_ready，authorization_source 填「批准执行 acme\/app#10」；成功后写 checkpoint --state ready --pr 5 --head a{40}，再把 done 门答 wait/, lane);
    assert.doesNotMatch(res.owner_message, /已经是 Ready/, lane);
  }
});

test('#77 SC4 needs_lead：要 --reason；记下原状态；unblock 放回；只能从 dispatched / revising 写', () => {
  const s = dispatched();
  writeFileSync(s.ledgerPath, JSON.stringify(s.ledger));
  const cli = spawnSync(process.execPath, [CLI, 'checkpoint', '--ledger', s.ledgerPath, '--item', A, '--state', 'needs_lead', '--now', NOW], { encoding: 'utf8' });
  assert.equal(cli.status, 2, '不带 --reason 时 CLI 退出码 2');
  assert.match(cli.stderr, /needs_lead 需要 --reason/);
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'needs_lead', reason: ' ', now: NOW }), /needs_lead 需要 --reason/);
  checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'needs_lead', reason: '要改 docs/sync.md 才能补 SC2 的说明', now: NOW });
  const it = s.ledger.items[A];
  assert.equal(it.state, 'needs_lead');
  assert.equal(it.blocked.reason, '要改 docs/sync.md 才能补 SC2 的说明');
  assert.equal(it.blocked.prev_state, 'dispatched');
  assert.equal(runStatus(s.ledger), 'running', 'needs_lead 算在途，不算等用户');
  assert.throws(() => awaiting(s), /checkpoint awaiting_acceptance 只接受/, '等 lead 定之前 owner 不能自己回到验收点');
  assert.throws(() => unblock({ ledger: s.ledger, ref: A, note: '', now: NOW }), /写明 lead 怎么定的/);
  const back = unblock({ ledger: s.ledger, ref: A, note: 'lead 2026-10-30：不改范围，换成在 src/sync 里写注释', now: NOW });
  assert.equal(back.state, 'dispatched');
  assert.equal(back.target_session_id, 'owner-1');
  awaiting(s);
  verdict({ ledger: s.ledger, ref: A, revise: '补证据', now: NOW });
  checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'needs_lead', reason: '要改 SC2', now: NOW });
  assert.equal(s.ledger.items[A].blocked.prev_state, 'revising');
  assert.equal(unblock({ ledger: s.ledger, ref: A, note: '定了', now: NOW }).state, 'revising');
});

const H = (c) => c.repeat(40);

test('#78 SC3 判「要改」不设轮数上限：条目和 head 每次都变，第 3、4 次仍发回 owner', () => {
  const s = dispatched();
  const rounds = [['a', '补 SC2 的验收对照'], ['b', '范围外改了 README'], ['c', '还缺 SC4 证据'], ['d', '测试名写错']];
  for (const [i, [c, items]] of rounds.entries()) {
    awaiting(s, { head: H(c) });
    const res = verdict({ ledger: s.ledger, ref: A, revise: items, now: NOW });
    assert.equal(res.state, 'revising', `第 ${i + 1} 次`);
    assert.match(res.owner_message, new RegExp(`要改（第 ${i + 1} 次）。要改的条目：${items}`));
    assert.doesNotMatch(res.owner_message, /最多/);
  }
});

test('#78 SC3 没有进展才停下找用户：条目原文和上一次相同 → blocked_user，root_comment 写明没有进展和两次条目', () => {
  const s = dispatched();
  awaiting(s, { head: H('a') });
  verdict({ ledger: s.ledger, ref: A, revise: '补 SC2 的验收对照', now: NOW });
  awaiting(s, { head: H('b') });
  const res = verdict({ ledger: s.ledger, ref: A, revise: '  补 SC2 的验收对照 ', now: NOW });
  assert.equal(res.state, 'blocked_user');
  assert.equal(Object.hasOwn(res, 'owner_message'), false, '没有进展时不再发回 owner');
  assert.match(res.root_comment, /^批准执行停下等用户：2026-10-29 acme\/app#11（PR #5）第 2 次判「要改」没有进展（要改的条目和上一次相同），不再发回会话 owner-1。第 1 次：补 SC2 的验收对照；第 2 次：补 SC2 的验收对照$/);
  assert.equal(s.ledger.items[A].blocked.by, 'lead');
  assert.throws(() => awaiting(s), /owner 不能直接回到验收点/, '反例（review-pr72）：lead 叫停后 owner 不能自己写回待验收');
  const back = unblock({ ledger: s.ledger, ref: A, note: '用户 2026-10-30：同意再改一轮', now: NOW });
  assert.equal(back.state, 'revising');
});

test('#78 SC3 没有进展才停下找用户：head 和上一次判要改时一样（没有新提交）→ blocked_user', () => {
  const s = dispatched();
  awaiting(s, { head: H('a') });
  verdict({ ledger: s.ledger, ref: A, revise: '补证据', now: NOW });
  awaiting(s, { head: H('a') });
  const res = verdict({ ledger: s.ledger, ref: A, revise: '换个说法：补 SC2 证据', now: NOW });
  assert.equal(res.state, 'blocked_user');
  assert.match(res.root_comment, new RegExp(`没有进展（head 还是上一次判要改时的 ${H('a')}，没有新提交）`));
});

test('SC8 owner 写 blocked_user：台账记原因；unblock 回到原状态；没有原因就拒绝', () => {
  const s = dispatched();
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'blocked_user', now: NOW }), /需要 --reason/);
  checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'blocked_user', reason: '需要管理员在仓库设置里建 integration/* 规则集', now: NOW });
  const it = s.ledger.items[A];
  assert.equal(it.state, 'blocked_user');
  assert.equal(it.blocked.reason, '需要管理员在仓库设置里建 integration/* 规则集');
  assert.equal(it.blocked.prev_state, 'dispatched');
  assert.equal(unblock({ ledger: s.ledger, ref: A, note: '已建', now: NOW }).state, 'dispatched');
});

test('checkpoint ready：PR 与 head 必须和验收通过时一致', () => {
  const s = dispatched();
  awaiting(s);
  verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck(), now: NOW });
  assert.throws(() => checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'ready', pr: '5', head: 'b'.repeat(40), now: NOW }), /和验收通过时不一致/);
  assert.equal(checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'ready', pr: '5', head: HEAD, now: NOW }).state, 'ready');
});

function gitRepoWithWorktree() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-cleanup-'));
  const repo = join(dir, 'repo');
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  mkdirSync(repo);
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('worktree', 'add', '-q', '-b', 'feat/x', join(repo, '.worktrees', 'keel-1'));
  const head = g('rev-parse', 'feat/x');
  return { repo, wt: join(repo, '.worktrees', 'keel-1'), head, g };
}

function readyWith(head, repoDir) {
  const fixture = parentFixture();
  fixture[`api repos/${REPO}/pulls/5`] = { head: { ref: 'feat/x', sha: head }, state: 'open', draft: false };
  fixture[`pr checks 5 --repo ${REPO} --required --json name,bucket`] = [{ name: 'test', bucket: 'pass' }];
  const s = dispatched({ fixture });
  s.plan.items.find((i) => i.ref === A).keel_run.repo_dir = repoDir;
  awaiting(s, { head });
  verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck({ head }), now: NOW });
  checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'ready', pr: '5', head, now: NOW });
  return s;
}

test('SC7 cleanup：删本地 KEEL worktree 与本地分支，不碰远端；有未提交改动或本地比 PR 新时拒绝', () => {
  let r = gitRepoWithWorktree();
  let s = readyWith(r.head, r.repo);
  writeFileSync(join(r.wt, 'dirty.txt'), 'x');
  assert.throws(() => cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW }), /有未提交改动，不清理/);

  r = gitRepoWithWorktree();
  s = readyWith('c'.repeat(40), r.repo);
  assert.throws(() => cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW }), /与 PR head .* 不一致/);

  // 反例（review-pr72）：Ready 之后又变了的 PR 不清理。
  r = gitRepoWithWorktree();
  s = readyWith(r.head, r.repo);
  s.fixture[`api repos/${REPO}/pulls/5`].draft = true;
  assert.throws(() => cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW }), /还不是正式 Ready/);
  s.fixture[`api repos/${REPO}/pulls/5`] = { head: { ref: 'feat/x', sha: 'd'.repeat(40) }, state: 'open', draft: false };
  assert.throws(() => cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW }), /新提交没验收过/);
  assert.equal(existsSync(r.wt), true);

  // 反例（review-pr72 第 2 轮）：同一 head 的 CI 后来变成 pending / 失败时不清理（SC7：当前 head 必需 CI 全绿）。
  r = gitRepoWithWorktree();
  s = readyWith(r.head, r.repo);
  s.fixture[`pr checks 5 --repo ${REPO} --required --json name,bucket`] = [{ name: 'test', bucket: 'pending' }];
  assert.throws(() => cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW }), /当前 CI 不是全绿.*test=pending/);
  assert.equal(existsSync(r.wt), true);
  assert.equal(s.ledger.items[A].state, 'ready');

  // 反例（review-pr72）：分支在主目录检出时拒绝，不假装清理过。
  r = gitRepoWithWorktree();
  r.g('worktree', 'remove', r.wt);
  r.g('checkout', '-q', 'feat/x');
  s = readyWith(r.head, r.repo);
  assert.throws(() => cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW }), /在主目录 .* 检出，不清理/);
  assert.equal(s.ledger.items[A].state, 'ready');

  r = gitRepoWithWorktree();
  s = readyWith(r.head, r.repo);
  const res = cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW });
  assert.equal(res.state, 'cleaned');
  assert.equal(res.worktree, join(realpathSync(r.repo), '.worktrees', 'keel-1'), 'git 报真实路径（macOS 的 /var 是 /private/var）');
  assert.equal(res.branch_deleted, true);
  assert.equal(existsSync(r.wt), false);
  assert.equal(r.g('branch', '--list', 'feat/x'), '');
});

test('SC7 archived 只认 archive_sessions 回执；全部收工 run 才 complete，等依赖时是 waiting_merge', () => {
  const r = gitRepoWithWorktree();
  const s = readyWith(r.head, r.repo);
  cleanup({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, checks: s.gh, now: NOW });
  assert.throws(() => archived({ ledger: s.ledger, ref: A, result: { ok: true, changed: [{ session_id: 'other', status: 'archived' }] }, now: NOW }), /未包含 owner-1/);
  assert.throws(() => archived({ ledger: s.ledger, ref: A, result: { archived: true }, now: NOW }), /ok 必须是 true/);
  const wrapped = { content: [{ type: 'text', text: JSON.stringify({ ok: true, changed: [{ session_id: 'owner-1', status: 'archived' }] }) }] };
  const res = archived({ ledger: s.ledger, ref: A, result: wrapped, now: NOW });
  assert.equal(res.state, 'archived');
  assert.equal(Object.hasOwn(res, 'run_status'), false, '反例（review-pr72 第 2 轮）：run 状态只由 status / next 给，archived 不另算一套');
  // #12、#14 还没派、#13 等 #11：还没完。
  assert.notEqual(runStatus(s.ledger), 'complete');
  for (const ref of [`${REPO}#12`, `${REPO}#14`]) s.ledger.items[ref].state = 'archived';
  assert.equal(runStatus(s.ledger), 'waiting_merge', '只剩等依赖合并的 #13');
  assert.equal(next({ ledger: s.ledger, gh: s.gh }).run_status, 'waiting_merge');
  assert.equal(status({ ledger: s.ledger, gh: s.gh }).run_status, 'waiting_merge');
  s.ledger.items[C].state = 'closed';
  assert.equal(runStatus(s.ledger), 'complete');
});

test('反例（review-pr72）：status 和 next 对同一台账给出同一个 run_status（有可派的子 issue 时是 running）', () => {
  const s = dispatched();
  assert.equal(next({ ledger: s.ledger, gh: s.gh }).run_status, 'running');
  for (const ref of Object.keys(s.ledger.items)) s.ledger.items[ref].state = ref === `${REPO}#12` ? 'pending' : 'archived';
  const n = next({ ledger: s.ledger, gh: s.gh });
  assert.deepEqual(n.dispatchable, [`${REPO}#12`]);
  assert.equal(n.run_status, 'running');
  assert.equal(status({ ledger: s.ledger, gh: s.gh }).run_status, 'running');
});

test('「要改」回复写明先跑 free-worktree，再用 keel_run 传 pr=<号> 在同一 PR 上继续（#69 待定问题结论、#77 SC6）', () => {
  const s = dispatched();
  awaiting(s, { lane: 'personal' });
  const res = verdict({ ledger: s.ledger, ref: A, revise: '补证据', now: NOW });
  assert.match(res.owner_message, /先跑开工包第 3 节的 free-worktree，释放上一个 KEEL run 占着分支的 worktree，再用 keel_run 传 pr=5 在同一 PR 上接着做/);
});

/** 判了一次「要改」、PR #5 分支 feat/x 的 head 是 head 的台账，计划里的主目录指向 repoDir。 */
function revisingWith(head, repoDir) {
  const fixture = parentFixture();
  fixture[`api repos/${REPO}/pulls/5`] = { head: { ref: 'feat/x', sha: head }, state: 'open', draft: true };
  const s = dispatched({ fixture });
  s.plan.items.find((i) => i.ref === A).keel_run.repo_dir = repoDir;
  awaiting(s, { head });
  verdict({ ledger: s.ledger, ref: A, revise: '补证据', now: NOW });
  return s;
}

test('#77 SC6 free-worktree：干净且 HEAD 等于 PR head 时删掉旧 KEEL worktree、保留本地分支；脏或不一致时拒绝、什么都不删', () => {
  let r = gitRepoWithWorktree();
  let s = revisingWith(r.head, r.repo);
  writeFileSync(join(r.wt, 'dirty.txt'), 'x');
  assert.throws(() => freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW }), /有未提交改动，不释放/);
  assert.equal(existsSync(r.wt), true);

  r = gitRepoWithWorktree();
  s = revisingWith('c'.repeat(40), r.repo);
  assert.throws(() => freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW }), /与 PR head .* 不一致.*不释放/);
  assert.equal(existsSync(r.wt), true);

  r = gitRepoWithWorktree();
  r.g('worktree', 'remove', r.wt);
  r.g('checkout', '-q', 'feat/x');
  s = revisingWith(r.head, r.repo);
  assert.throws(() => freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW }), /在主目录 .* 检出，不释放/);

  r = gitRepoWithWorktree();
  s = revisingWith(r.head, r.repo);
  const res = freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW });
  assert.equal(res.freed, true);
  assert.equal(res.worktree, join(realpathSync(r.repo), '.worktrees', 'keel-1'));
  assert.equal(existsSync(r.wt), false);
  assert.equal(r.g('rev-parse', 'feat/x'), r.head, '本地分支保留，keel_run 传 pr 时检出它');
  assert.equal(s.ledger.items[A].state, 'revising', '台账状态不变');
  assert.deepEqual(freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW }), { ok: true, freed: false, ref: A, branch: 'feat/x' }, '没有占用时什么都不做');

  const fresh = dispatched();
  assert.throws(() => freeWorktree({ ledger: fresh.ledger, plan: fresh.plan, ref: A, gh: fresh.gh, now: NOW }), /台账里没有 PR 号/);
});

test('#77 SC6 反例（review-pr80 P2）：不是 KEEL 建的 worktree（不在 <主目录>/.worktrees/keel-* 下）不删，里面被 gitignore 的文件也还在', () => {
  const r = gitRepoWithWorktree();
  r.g('worktree', 'remove', r.wt);
  const manual = join(r.repo, 'manual-wt');
  r.g('worktree', 'add', '-q', manual, 'feat/x');
  writeFileSync(join(r.repo, '.gitignore'), 'local.env\n');
  writeFileSync(join(manual, '.gitignore'), 'local.env\n');
  r.g('-C', manual, 'add', '.gitignore');
  r.g('-C', manual, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'ignore');
  writeFileSync(join(manual, 'local.env'), 'x');
  const head = r.g('rev-parse', 'feat/x');
  const s = revisingWith(head, r.repo);
  assert.throws(() => freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW }), /不是 KEEL 建的.*不释放/);
  assert.equal(existsSync(join(manual, 'local.env')), true, '手工 worktree 和里面的本地文件都还在');
});

test('#77 SC6 free-worktree CLI：删掉占用后台账落盘、退出码 0', () => {
  const r = gitRepoWithWorktree();
  const s = revisingWith(r.head, r.repo);
  writeFileSync(s.planPath, JSON.stringify(s.plan));
  s.ledger.plan.sha256 = hashObject(s.plan);
  writeFileSync(s.ledgerPath, JSON.stringify(s.ledger));
  writeFileSync(s.ghPath, JSON.stringify(s.fixture));
  const res = spawnSync(process.execPath, [CLI, 'free-worktree', '--ledger', s.ledgerPath, '--item', A, '--now', NOW, '--gh-fixture', s.ghPath], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).freed, true);
  assert.equal(existsSync(r.wt), false);
});

test('#78 SC4 release 接受 claimed / dispatched / revising / needs_lead：发释放评论、清会话绑定、回 pending，之后能重派', () => {
  for (const to of ['claimed', 'dispatched', 'revising', 'needs_lead']) {
    const s = dispatched();
    if (to === 'claimed') {
      s.ledger.items[A].state = 'claimed';
      s.ledger.items[A].session_id = null;
    } else if (to === 'revising') {
      awaiting(s);
      verdict({ ledger: s.ledger, ref: A, revise: '补证据', now: NOW });
    } else if (to === 'needs_lead') {
      checkpoint({ ledger: s.ledger, plan: s.plan, ref: A, state: 'needs_lead', reason: '要改范围', now: NOW });
    }
    assert.equal(s.ledger.items[A].state, to);
    const claim = s.ledger.items[A].claim_id;
    assert.throws(() => release({ ledger: s.ledger, ref: A, evidence: ' ', gh: s.gh, now: NOW }), /需要 --evidence/, to);
    const res = release({ ledger: s.ledger, ref: A, evidence: 'list_sessions 里没有这个会话（已被删）', gh: s.gh, now: NOW });
    assert.equal(res.state, 'pending', to);
    assert.equal(s.ledger.items[A].session_id, null, `${to}：会话绑定清掉`);
    assert.match(s.fixture[COMMENTS].at(-1).body, new RegExp(`^批准执行释放：2026-10-29 acme/app#11 claim ${claim}：list_sessions 里没有这个会话`), to);
    assert.deepEqual(activeClaims(s.fixture[COMMENTS], A, LOGIN), [], `${to}：释放后不再占用`);
    const again = prepare({ ledger: s.ledger, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: s.gh, now: NOW });
    assert.equal(again.claimed, true, `${to}：能重派`);
    if (to === 'revising') {
      assert.match(again.request.message, /^> 接手：上一个 owner 会话失联，PR #5 已经开着。不要开新 PR/, '已有 PR 的重派接着那个 PR 做');
      assert.match(again.request.message, /keel_run` 传 `pr=5`/);
    } else {
      assert.doesNotMatch(again.request.message, /^> 接手/, `${to}：还没开 PR 的照常开工`);
    }
  }
});

test('#78 SC4 release 拒绝已到验收点及之后的状态；CLI 不带 --evidence 退出码 2', () => {
  const s = dispatched();
  awaiting(s);
  assert.throws(() => release({ ledger: s.ledger, ref: A, evidence: '会话不在', gh: s.gh, now: NOW }), /当前状态 awaiting_acceptance，release 只接受 dispatch_unknown \/ claimed \/ dispatched \/ revising \/ needs_lead/);
  verdict({ ledger: s.ledger, ref: A, pass: true, check: okCheck(), now: NOW });
  assert.throws(() => release({ ledger: s.ledger, ref: A, evidence: '会话不在', gh: s.gh, now: NOW }), /当前状态 accepted/);
  for (const state of ['ready', 'cleaned']) {
    s.ledger.items[A].state = state;
    assert.throws(() => release({ ledger: s.ledger, ref: A, evidence: '会话不在', gh: s.gh, now: NOW }), new RegExp(`当前状态 ${state}`));
  }
  const d = dispatched();
  writeFileSync(d.ledgerPath, JSON.stringify(d.ledger));
  writeFileSync(d.ghPath, JSON.stringify(d.fixture));
  const cli = spawnSync(process.execPath, [CLI, 'release', '--ledger', d.ledgerPath, '--item', A, '--now', NOW, '--gh-fixture', d.ghPath], { encoding: 'utf8' });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /需要 --evidence/);
});

test('#78 SC4 反例（review-pr81）：开了 PR、还没写验收点就失联 → 重派按 GitHub 上「任务 issue：」找到的唯一 PR 接手，free-worktree 也认它；多个时拒绝', () => {
  const s = dispatched();
  s.fixture[openPullsKey()] = [
    { number: 7, body: `任务 issue：${A}\nCloses ${A}` },
    { number: 8, body: `任务 issue：${REPO}#110` },
    { number: 9, body: '没有任务行' },
  ];
  release({ ledger: s.ledger, ref: A, evidence: '会话已被删', gh: s.gh, now: NOW });
  assert.equal(s.ledger.items[A].checkpoint, null, '失联前没写过验收点');
  const again = prepare({ ledger: s.ledger, plan: s.plan, ref: A, leadSessionId: 'lead-1', gh: s.gh, now: NOW });
  assert.match(again.request.message, /^> 接手：上一个 owner 会话失联，PR #7 已经开着。不要开新 PR/);
  assert.equal(s.ledger.items[A].takeover_pr, 7);

  const r = gitRepoWithWorktree();
  s.fixture[`api repos/${REPO}/pulls/7`] = { head: { ref: 'feat/x', sha: r.head }, state: 'open', draft: true };
  s.plan.items.find((i) => i.ref === A).keel_run.repo_dir = r.repo;
  bind({ ledger: s.ledger, ref: A, claimId: again.claim_id, result: { target_session_id: 'owner-2' }, gh: s.gh, now: NOW });
  assert.equal(freeWorktree({ ledger: s.ledger, plan: s.plan, ref: A, gh: s.gh, now: NOW }).freed, true, '没有验收点时用接手的 PR 号释放旧 worktree');

  s.fixture[openPullsKey()].push({ number: 12, body: `任务 issue：${A}` });
  assert.throws(() => soleOpenPr(s.gh, REPO, A), /有 2 个开着的 PR 写着「任务 issue：acme\/app#11」（#7、#12）/);
  const first = dispatched();
  assert.doesNotMatch(prepare({ ledger: first.ledger, plan: first.plan, ref: `${REPO}#12`, leadSessionId: 'lead-1', gh: first.gh, now: NOW }).request.message, /^> 接手/, '第一次派发不查也不加接手说明');
});

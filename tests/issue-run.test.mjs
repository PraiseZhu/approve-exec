// issue-run.mjs：一次性认领、派会话请求、会话回执（PraiseZhu/approve-exec#68 SC5、SC6、SC8）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPlan, readRoot } from '../scripts/issue-plan.mjs';
import { init, next, prepare, bind, release, sessionTitle, projectName, sessionIdFrom, activeClaims, REQUEST_KEYS, RunError } from '../scripts/issue-run.mjs';
import { REPO, parentFixture, writeFixture, ghFrom } from './fixtures/issues/build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'scripts/issue-run.mjs');
const NOW = '2026-10-29T08:00:00.000Z';
const A = `${REPO}#11`;
const C = `${REPO}#13`;

function setup({ lead = 'claude-code', fixture = parentFixture(), source = 'chat', authorization } = {}) {
  const fx = writeFixture(fixture);
  const gh = ghFrom(fixture);
  const { root: r, children } = readRoot(gh, `${REPO}#10`);
  const plan = buildPlan({ root: r, children, repoDirs: { [REPO]: fx.repoDir }, lead, entry: '批准执行 acme/app#10', authorization, source, now: NOW });
  const planPath = join(fx.dir, 'plan.json');
  const ledgerPath = join(fx.dir, 'ledger.json');
  writeFileSync(planPath, JSON.stringify(plan));
  init({ plan, planPath, ledgerPath, now: NOW });
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  return { ...fx, fixture, gh, plan, planPath, ledgerPath, ledger };
}

const COMMENTS = `api repos/${REPO}/issues/10/comments?per_page=100`;

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

test('SC5 lead 是 Pi 时 CLI 退出码 2，写明 KEEL 不接受 Pi', () => {
  const { ledgerPath, ledger } = setup();
  ledger.lead_agent = 'pi';
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const res = spawnSync(process.execPath, [CLI, 'prepare', '--ledger', ledgerPath, '--item', A, '--lead-session', 'lead-1', '--now', NOW], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /KEEL 不接受 Pi/);
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
  assert.deepEqual(activeClaims(fixture[COMMENTS], A), [], '释放后不再算占用');
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

test('activeClaims：只认本子 issue 的认领 / 登记，释放后清除；#110 不算 #11', () => {
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  const comments = [
    { body: `批准执行认领：2026-10-29 acme/app#11 claim ${id1}（台账 x）`, html_url: 'u1' },
    { body: `批准执行认领：2026-10-29 acme/app#110 claim ${id2}（台账 x）`, html_url: 'u2' },
    { body: '随便一条评论' },
  ];
  assert.deepEqual(activeClaims(comments, A), [{ claim_id: id1, kind: '认领', url: 'u1' }]);
  comments.push({ body: `批准执行释放：2026-10-29 acme/app#11 claim ${id1}：核实过`, html_url: 'u3' });
  assert.deepEqual(activeClaims(comments, A), []);
});

test('bind 成功：记会话 id，在总 issue 发登记评论；认领号不对时拒绝', () => {
  const { ledger, plan, gh, fixture } = setup();
  const { claim_id } = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  assert.throws(() => bind({ ledger, ref: A, claimId: 'wrong', result: { target_session_id: 's1' }, gh, now: NOW }), /认领号对不上/);
  const res = bind({ ledger, ref: A, claimId: claim_id, result: { target_session_id: 's1', wake_kind: 'created' }, gh, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(ledger.items[A].state, 'dispatched');
  assert.equal(fixture[COMMENTS].at(-1).body, `批准执行登记：2026-10-29 acme/app#11 → 会话 s1（App-同步状态读取丨 1029）claim ${claim_id}`);
  assert.ok(res.root_comment_url);
  assert.equal(sessionIdFrom({ ok: true, data: { target_session_id: 's2' } }), 's2');
  assert.equal(sessionIdFrom({ ok: true }), null);
});

test('bind 成功但登记评论发不出去：仍记 dispatched，返回错误与待补发正文', () => {
  const { ledger, plan, gh } = setup();
  const { claim_id } = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  const failing = (args) => { if (args[2] === 'POST') throw new Error('HTTP 502'); return gh(args); };
  const res = bind({ ledger, ref: A, claimId: claim_id, result: { target_session_id: 's1' }, gh: failing, now: NOW });
  assert.equal(ledger.items[A].state, 'dispatched');
  assert.equal(res.root_comment_error, 'HTTP 502');
  assert.match(res.root_comment, /^批准执行登记：/);
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

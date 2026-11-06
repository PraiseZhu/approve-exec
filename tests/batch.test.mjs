// batch.mjs：批准执行 2026-11-07 改版——按依赖一次列出能并行开工的子 issue、派发防重、开工消息。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activeDispatch, batchStatus, brief, claim, release, toOwnerMessage } from '../scripts/batch.mjs';
import { REPO, LOGIN, childBody, commentsKey, ghFrom, openPullsKey, parentFixture, standaloneFixture, writeFixture } from './fixtures/issues/build.mjs';

const CLI = fileURLToPath(new URL('../scripts/batch.mjs', import.meta.url));
const NOW = '2026-11-07T02:00:00.000Z';
const ref = (n) => `${REPO}#${n}`;
const stateOf = (res, n) => res.items.find((i) => i.ref === ref(n));

test('并行：依赖已满足的子 issue 一次全列出；「等 #11 合进 main」的 #13 等着，「#11 先合」的 #14 不挡开工', () => {
  const res = batchStatus({ gh: ghFrom(parentFixture()), issueRef: ref(10) });
  assert.equal(res.kind, 'parent');
  assert.deepEqual(res.dispatchable, [ref(11), ref(12), ref(14)]);
  assert.equal(stateOf(res, 13).state, 'waiting');
  assert.deepEqual(stateOf(res, 13).waiting_on, [ref(11)]);
  assert.equal(res.all_done, false);
});

/** #11 关闭：sub_issues 列表和单读 issue 两处都改（readRoot 用列表里的正文和状态，依赖查单读）。 */
function closedA(reason) {
  const f = parentFixture({ aState: 'closed', aReason: reason });
  const key = `api repos/${REPO}/issues/10/sub_issues?per_page=100`;
  f[key] = f[key].map((i) => (i.number === 11 ? { ...i, state: 'closed', state_reason: reason } : i));
  return f;
}

test('依赖合入后（#11 关闭）下一批放开；被关成「不做」的依赖要用户决定', () => {
  const merged = batchStatus({ gh: ghFrom(closedA('completed')), issueRef: ref(10) });
  assert.equal(stateOf(merged, 11).state, 'done');
  assert.ok(merged.dispatchable.includes(ref(13)));
  const dropped = batchStatus({ gh: ghFrom(closedA('not_planned')), issueRef: ref(10) });
  assert.equal(stateOf(dropped, 13).state, 'waiting');
  assert.match(stateOf(dropped, 13).reason, /不做，要用户决定/);
});

test('已有写着「任务 issue」的开着的 PR：算在做，不再派', () => {
  const fixture = parentFixture({ extra: { [openPullsKey()]: [{ number: 7, draft: true, body: `任务 issue：${ref(12)}\nCloses ${ref(12)}` }] } });
  const res = batchStatus({ gh: ghFrom(fixture), issueRef: ref(10) });
  assert.equal(stateOf(res, 12).state, 'in_progress');
  assert.deepEqual(stateOf(res, 12).prs, [{ number: 7, draft: true }]);
  assert.equal(res.dispatchable.includes(ref(12)), false);
});

test('派发防重：claim 后算在做、再 claim 拒绝；release 后可重派；没有派发记录时 release 拒绝', () => {
  const fixture = parentFixture();
  const gh = ghFrom(fixture);
  const c = claim({ gh, itemRef: ref(11), session: 'sess-a', title: '同步状态读取丨1107', now: NOW });
  assert.equal(c.ok, true);
  assert.match(fixture[commentsKey(11)][0].body, /^批准执行派发：2026-11-07 acme\/app#11 → 会话 sess-a（同步状态读取丨1107）/);
  assert.equal(fixture[commentsKey(11)][0].body.startsWith('批准执行登记：'), false, '不能用登记开头，否则验收机会等 lead 交接');
  assert.equal(stateOf(batchStatus({ gh, issueRef: ref(10) }), 11).session, 'sess-a');
  assert.throws(() => claim({ gh, itemRef: ref(11), session: 'sess-b', title: 'x丨1107', now: NOW }), /已派给会话 sess-a/);
  release({ gh, itemRef: ref(11), reason: '会话已删除', now: NOW });
  assert.equal(stateOf(batchStatus({ gh, issueRef: ref(10) }), 11).state, 'dispatchable');
  assert.throws(() => release({ gh, itemRef: ref(11), reason: '再撤一次', now: NOW }), /没有有效的派发记录/);
});

test('只认当前 gh 账号发的派发评论', () => {
  const comments = [{ id: 1, user: { login: 'someone-else' }, body: `批准执行派发：2026-11-07 ${ref(11)} → 会话 x（t丨1107）` }];
  assert.equal(activeDispatch(comments, ref(11), LOGIN), null);
});

test('旧台账 run 的认领 / 登记照样算在做，新流程不重复派', () => {
  const legacy = { id: 5, user: { login: LOGIN }, body: `批准执行认领：2026-11-01 ${ref(11)} claim 0f0e0d0c-0b0a-4099-8877-665544332211（台账 r1，lead 会话 L）` };
  const fixture = parentFixture({ extra: { [commentsKey(11)]: [legacy] } });
  const gh = ghFrom(fixture);
  const item = stateOf(batchStatus({ gh, issueRef: ref(10) }), 11);
  assert.equal(item.state, 'in_progress');
  assert.match(item.reason, /旧台账/);
  assert.throws(() => claim({ gh, itemRef: ref(11), session: 's', title: 't丨1107', now: NOW }), /旧台账/);
});

test('待定问题没写「已定」：needs_decision，不派；写了「已定」就放行', () => {
  const pending = childBody({ pending: '- 图标用哪套？' });
  const decided = childBody({ pending: '- 图标用哪套？已定：用现有一套（Jev 0.8）' });
  const base = parentFixture();
  const withPending = { ...base, [`api repos/${REPO}/issues/10/sub_issues?per_page=100`]: base[`api repos/${REPO}/issues/10/sub_issues?per_page=100`].map((i) => (i.number === 12 ? { ...i, body: pending } : i)) };
  assert.equal(stateOf(batchStatus({ gh: ghFrom(withPending), issueRef: ref(10) }), 12).state, 'needs_decision');
  const withDecided = { ...base, [`api repos/${REPO}/issues/10/sub_issues?per_page=100`]: base[`api repos/${REPO}/issues/10/sub_issues?per_page=100`].map((i) => (i.number === 12 ? { ...i, body: decided } : i)) };
  assert.equal(stateOf(batchStatus({ gh: ghFrom(withDecided), issueRef: ref(10) }), 12).state, 'dispatchable');
});

test('没按模板写的子 issue 标 invalid，不挡其他子 issue', () => {
  const base = parentFixture();
  const key = `api repos/${REPO}/issues/10/sub_issues?per_page=100`;
  const fixture = { ...base, [key]: base[key].map((i) => (i.number === 12 ? { ...i, body: '随便写的' } : i)) };
  const res = batchStatus({ gh: ghFrom(fixture), issueRef: ref(10) });
  assert.equal(stateOf(res, 12).state, 'invalid');
  assert.match(stateOf(res, 12).reason, /task-issue-child/);
  assert.deepEqual(res.dispatchable, [ref(11), ref(14)]);
});

test('「范围」没用反引号写路径、SC 缺验证层：派发前就标 invalid，不等验收时才发现', () => {
  const base = parentFixture();
  const key = `api repos/${REPO}/issues/10/sub_issues?per_page=100`;
  const badScope = childBody({ scope: ['- 相关测试'] });
  const badSc = childBody({ scs: ['- [ ] SC1 状态显示正确'] });
  const fixture = { ...base, [key]: base[key].map((i) => (i.number === 12 ? { ...i, body: badScope } : i.number === 14 ? { ...i, body: badSc } : i)) };
  const res = batchStatus({ gh: ghFrom(fixture), issueRef: ref(10) });
  assert.equal(stateOf(res, 12).state, 'invalid');
  assert.match(stateOf(res, 12).reason, /范围/);
  assert.equal(stateOf(res, 14).state, 'invalid');
  assert.match(stateOf(res, 14).reason, /验证/);
  assert.deepEqual(res.dispatchable, [ref(11)]);
});

test('独立 issue 入口：只有它自己一项', () => {
  const fixture = { ...standaloneFixture(), [openPullsKey()]: [] };
  const res = batchStatus({ gh: ghFrom(fixture), issueRef: ref(20) });
  assert.equal(res.kind, 'single');
  assert.deepEqual(res.dispatchable, [ref(20)]);
});

test('brief：标题是人话任务名丨日期，开工消息写明红线、lead 会话和三种消息格式，只传五个键', () => {
  const out = brief({ gh: ghFrom(parentFixture()), itemRef: ref(11), lead: 'lead-sess-1', repoDir: '/repos/app', project: '/repos/app', now: NOW });
  assert.deepEqual(Object.keys(out.request).sort(), ['message', 'project_path', 'title', 'use_worktree', 'working_dir']);
  assert.equal(out.request.title, '同步状态读取丨1107');
  assert.equal(out.request.use_worktree, true);
  const m = out.request.message;
  for (const must of ['推到正式 PR', '不走 KEEL', 'lead-sess-1', `批准执行待验收 ${ref(11)} PR #<号> head`, `批准执行已转正式 ${ref(11)} PR #<号>`, `批准执行卡住 ${ref(11)}`,
    'timeout 540 gh pr checks', '不问用户', 'references/owner-protocol.md', `任务 issue：${ref(11)}`]) {
    assert.ok(m.includes(must), `开工消息应写「${must}」`);
  }
  assert.equal(m.includes('加急'), false);
});

test('brief：已有开着的 PR 时标题带 #PR号，消息写明接着那个 PR 做；加急写明转正式后由 lead 合并', () => {
  const fixture = parentFixture({ extra: { [openPullsKey()]: [{ number: 5, draft: true, body: `任务 issue：${ref(11)}` }] } });
  const out = brief({ gh: ghFrom(fixture), itemRef: ref(11), lead: 'L1', repoDir: '/repos/app', project: '/repos/app', urgent: true, now: NOW });
  assert.equal(out.request.title, '#5-同步状态读取丨1107');
  assert.match(out.request.message, /已经有开着的 PR #5.*不开新 PR/s);
  assert.match(out.request.message, /加急任务/);
});

test('brief 拒绝：lead 不是会话 id、主目录不是绝对路径、没给项目', () => {
  const gh = ghFrom(parentFixture());
  assert.throws(() => brief({ gh, itemRef: ref(11), lead: 'a b', repoDir: '/r', project: '/r', now: NOW }), /--lead/);
  assert.throws(() => brief({ gh, itemRef: ref(11), lead: 'L', repoDir: 'r', project: '/r', now: NOW }), /--repo-dir/);
  assert.throws(() => brief({ gh, itemRef: ref(11), lead: 'L', repoDir: '/r', project: '', now: NOW }), /--project/);
});

test('toOwnerMessage 不带 url 也能生成', () => {
  assert.match(toOwnerMessage({ ref: ref(11), title: 't', url: null, lead: 'L' }), /^批准执行开工：acme\/app#11「t」\n\n/);
});

test('CLI：status 走夹具 exit 0，未知子命令 exit 2', () => {
  const { ghPath } = writeFixture(parentFixture());
  const ok = spawnSync(process.execPath, [CLI, 'status', '--issue', ref(10), '--gh-fixture', ghPath], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).dispatchable, [ref(11), ref(12), ref(14)]);
  const bad = spawnSync(process.execPath, [CLI, 'nope', '--gh-fixture', ghPath], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /子命令只能是/);
});

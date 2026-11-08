// batch.mjs：批准执行 2026-11-07 改版——按依赖一次列出能并行开工的子 issue、派发防重、开工消息。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeDispatch, archived, batchStatus, brief, claim, notify, release, selectDispatchRoute, toOwnerMessage, unarchivedSessions } from '../scripts/batch.mjs';
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

test('只剩开着的 PR、没有派发记录：needs_owner（待接手），不当成有人在做；有派发记录才是 in_progress（astra 审查 #1）', () => {
  const pr = { number: 7, draft: true, body: `任务 issue：${ref(12)}\nCloses ${ref(12)}` };
  const orphan = batchStatus({ gh: ghFrom(parentFixture({ extra: { [openPullsKey()]: [pr] } })), issueRef: ref(10) });
  assert.equal(stateOf(orphan, 12).state, 'needs_owner');
  assert.deepEqual(orphan.needs_owner, [ref(12)]);
  assert.match(stateOf(orphan, 12).reason, /PR #7 开着，但没有在做的执行会话/);
  assert.equal(orphan.dispatchable.includes(ref(12)), false);
  assert.deepEqual(orphan.to_attach, [{ repo: REPO, number: 7 }], 'lead 要把在做的 PR 挂到自己会话顶上');
  const owned = parentFixture({ extra: { [openPullsKey()]: [pr], [commentsKey(12)]: [{ id: 1, user: { login: LOGIN }, body: `批准执行派发：2026-11-07 ${ref(12)} → 会话 s12（t丨1107）` }] } });
  const res = batchStatus({ gh: ghFrom(owned), issueRef: ref(10) });
  assert.equal(stateOf(res, 12).state, 'in_progress');
  assert.deepEqual(stateOf(res, 12).prs, [{ number: 7, draft: true }]);
  assert.equal(stateOf(res, 12).session, 's12');
});

test('issue 关了但 PR 还开着：不算完成、不归档、不放行依赖（astra 审查 #2）', () => {
  const fixture = closedA('completed');
  fixture[openPullsKey()] = [{ number: 5, draft: true, body: `任务 issue：${ref(11)}` }];
  fixture[commentsKey(11)] = [{ id: 1, user: { login: LOGIN }, body: `批准执行派发：2026-11-07 ${ref(11)} → 会话 s11（t丨1107）` }];
  const res = batchStatus({ gh: ghFrom(fixture), issueRef: ref(10) });
  assert.equal(stateOf(res, 11).state, 'needs_decision');
  assert.match(stateOf(res, 11).reason, /PR #5 还开着/);
  assert.deepEqual(res.to_archive, []);
  assert.equal(stateOf(res, 13).state, 'waiting', '#13 等 #11：#11 的 PR 还开着就不放行');
  assert.equal(res.all_done, false);
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

test('brief：标题是人话任务名丨日期，开工消息写明红线、lead 会话和三种消息格式；请求带默认路线 Opus 5.5 high，不带网关时靠继承', () => {
  const out = brief({ gh: ghFrom(parentFixture()), itemRef: ref(11), root: ref(10), lead: 'lead-sess-1', repoDir: '/repos/app', project: '/repos/app', now: NOW });
  assert.deepEqual(Object.keys(out.request).sort(), ['agent_kind', 'effort', 'message', 'model', 'project_path', 'title', 'use_worktree', 'working_dir']);
  assert.deepEqual([out.request.agent_kind, out.request.model, out.request.effort], ['claude-code', 'claude-opus-5-5', 'high']);
  assert.deepEqual(out.gateways, ['Claude', 'Personal', 'Personal 2']);
  assert.match(out.request.message, /一个子 issue 只对应这一个 PR、这一个会话/);
  assert.equal(out.request.title, '同步状态读取丨1107');
  assert.equal(out.request.use_worktree, true);
  const m = out.request.message;
  for (const must of ['推到正式 PR', '不走 KEEL', 'lead-sess-1', `批准执行待验收 ${ref(11)} PR #<号> head`, `批准执行已转正式 ${ref(11)} PR #<号>`, `批准执行卡住 ${ref(11)}`,
    'timeout 540 gh pr checks', '不问用户', 'references/owner-protocol.md', `任务 issue：${ref(11)}`, '`manage_session_prs`（action=attach', '其余命名不变',
    '总 issue：acme/app#10', '不要 git checkout -b 另开分支', 'git push origin HEAD:<PR 分支名>', '不算越界', '全部检查都跑完且通过', `check-pr-body.sh --stage ready <owner/repo#PR号> ${ref(11)}`,
    '不要再发「待验收」', '批准执行未送达', 'DELIVERY_UNKNOWN', '指向的 PR 门禁规则（如 docs/dev-rules/ 下的文件）', '都写实际跑的命令和退出码', '只写「通过」不算']) {
    assert.ok(m.includes(must), `开工消息应写「${must}」`);
  }
  assert.equal(m.includes('加急'), false);
});

test('brief：已有开着的 PR 时标题带 #PR号，消息写明接着那个 PR 做；加急写明转正式后由 lead 合并', () => {
  const fixture = parentFixture({ extra: { [openPullsKey()]: [{ number: 5, draft: true, body: `任务 issue：${ref(11)}` }] } });
  const out = brief({ gh: ghFrom(fixture), itemRef: ref(11), root: ref(10), lead: 'L1', repoDir: '/repos/app', project: '/repos/app', urgent: true, now: NOW });
  assert.equal(out.request.title, '#5-同步状态读取丨1107');
  assert.match(out.request.message, /已经有开着的 PR #5.*不开新 PR/s);
  assert.match(out.request.message, /git reset --hard origin\/<PR #5 的分支>/);
  assert.match(out.request.message, /加急任务/);
});

test('brief --gateway：按配置顺序取网关的 agent_device_id；不认识的网关名拒绝', () => {
  const gh = ghFrom(parentFixture());
  const out = brief({ gh, itemRef: ref(11), root: ref(10), lead: 'L', repoDir: '/r', project: '/r', gateway: 'Personal', now: NOW });
  assert.equal(out.request.agent_device_id, '8620a24bb37ab0fff5f06fe54601a7747583995243a3086ccc1b769facd8fcec');
  assert.throws(() => brief({ gh, itemRef: ref(11), root: ref(10), lead: 'L', repoDir: '/r', project: '/r', gateway: 'Nope', now: NOW }), /--gateway 只能是 Claude \/ Personal \/ Personal 2/);
});

test('dispatchRoute 缺项时 fail-closed，不悄悄换模型', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  const bad = join(dir, 'defaults.json');
  writeFileSync(bad, JSON.stringify({ dispatchRoute: { agent_kind: 'claude-code', model: 'claude-opus-5-5', gateways: [] } }));
  assert.throws(() => selectDispatchRoute(bad), /dispatchRoute 不完整/);
});

test('PR 合入、子 issue 关闭后：status 列出该归档的执行会话（含撤回过的）；记过「批准执行归档」就不再列', () => {
  const fixture = closedA('completed');
  fixture[commentsKey(11)] = [
    { id: 1, user: { login: LOGIN }, body: `批准执行派发：2026-11-07 ${ref(11)} → 会话 sess-old（t丨1107）` },
    { id: 2, user: { login: LOGIN }, body: `批准执行撤回：2026-11-07 ${ref(11)}：会话崩了` },
    { id: 3, user: { login: LOGIN }, body: `批准执行派发：2026-11-07 ${ref(11)} → 会话 sess-new（t丨1107）` },
  ];
  const gh = ghFrom(fixture);
  const res = batchStatus({ gh, issueRef: ref(10) });
  assert.deepEqual(stateOf(res, 11).sessions_to_archive, ['sess-old', 'sess-new']);
  assert.deepEqual(res.to_archive, [{ ref: ref(11), session: 'sess-old' }, { ref: ref(11), session: 'sess-new' }]);
  archived({ gh, itemRef: ref(11), session: 'sess-old', now: NOW });
  assert.match(fixture[commentsKey(11)].at(-1).body, /^批准执行归档：2026-11-07 acme\/app#11 会话 sess-old/);
  assert.deepEqual(batchStatus({ gh, issueRef: ref(10) }).to_archive, [{ ref: ref(11), session: 'sess-new' }]);
  assert.throws(() => archived({ gh, itemRef: ref(11), session: 'sess-old', now: NOW }), /没有待归档的会话 sess-old/);
  assert.deepEqual(unarchivedSessions(fixture[commentsKey(11)], ref(11), 'someone-else'), []);
});

test('brief 拒绝：lead 不是会话 id、主目录不是绝对路径、没给项目', () => {
  const gh = ghFrom(parentFixture());
  assert.throws(() => brief({ gh, itemRef: ref(11), root: ref(10), lead: 'a b', repoDir: '/r', project: '/r', now: NOW }), /--lead/);
  assert.throws(() => brief({ gh, itemRef: ref(11), root: ref(10), lead: 'L', repoDir: 'r', project: '/r', now: NOW }), /--repo-dir/);
  assert.throws(() => brief({ gh, itemRef: ref(11), root: ref(10), lead: 'L', repoDir: '/r', project: '', now: NOW }), /--project/);
});

test('brief --root：只派入口 issue 范围内的子 issue；别的 issue、缺 --root 都拒绝（2026-11-07 复盘：#1839 越界派发）', () => {
  const fixture = { ...parentFixture(), ...standaloneFixture() };
  const gh = ghFrom(fixture);
  assert.throws(() => brief({ gh, itemRef: ref(20), root: ref(10), lead: 'L', repoDir: '/r', project: '/r', now: NOW }), /acme\/app#20 不是 acme\/app#10 的子 issue/);
  assert.throws(() => brief({ gh, itemRef: ref(11), lead: 'L', repoDir: '/r', project: '/r', now: NOW }), /--root/);
  assert.equal(brief({ gh, itemRef: ref(20), root: ref(20), lead: 'L', repoDir: '/r', project: '/r', now: NOW }).ref, ref(20), '入口就是这个独立 issue 时照常派');
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

// notify：Mivo PR 转正式后 lead 把地址登记给合并伙伴（#97）

const MIVO = 'xindong/mivo-canvas-plugin';
const DEV = 'a'.repeat(64);
const LEAD = `${DEV}::lead-1`;
const PARTNER = `${'b'.repeat(64)}::partner-1`;
const pullKey = (n) => `api repos/${MIVO}/pulls/${n}`;
function partnerFile(content = { session: PARTNER }) {
  const path = join(mkdtempSync(join(tmpdir(), 'partner-')), 'partner.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('#97 SC1 notify：开着的 Mivo PR → 发给伙伴的登记消息，首行固定、JSON 带 lead 地址和这个 PR', () => {
  const gh = ghFrom({ [pullKey(2017)]: { state: 'open', merged_at: null } });
  const out = notify({ gh, prRef: `${MIVO}#2017`, leadAddress: LEAD, partnerPath: partnerFile(), now: NOW });
  assert.equal(out.already_merged, false);
  assert.equal(out.target_session_id, PARTNER);
  const [first, ...rest] = out.message.split('\n');
  assert.equal(first, 'praise-merge 通知登记');
  const json = JSON.parse(rest.join('\n').replace(/^```json\n/, '').replace(/\n```$/, ''));
  assert.deepEqual(json, { schema: 'praise-merge/notify@1', notify_session: LEAD, prs: [{ repo: MIVO, number: 2017 }], registered_at: NOW });
});

test('#97 SC2 notify：PR 已合入 → already_merged，不生成消息；其余情况都拒绝并说明原因', () => {
  const gh = ghFrom({ [pullKey(1)]: { state: 'closed', merged_at: '2026-11-08T00:00:00Z' }, [pullKey(2)]: { state: 'closed', merged_at: null }, [pullKey(3)]: { state: 'open', merged_at: null } });
  const merged = notify({ gh, prRef: `${MIVO}#1`, leadAddress: LEAD, partnerPath: partnerFile(), now: NOW });
  assert.deepEqual(merged, { ok: true, ref: `${MIVO}#1`, already_merged: true });
  assert.throws(() => notify({ gh, prRef: `${MIVO}#2`, leadAddress: LEAD, partnerPath: partnerFile(), now: NOW }), /已关闭且没合入（state=closed）/);
  assert.throws(() => notify({ gh, prRef: 'PraiseZhu/approve-exec#3', leadAddress: LEAD, partnerPath: partnerFile(), now: NOW }), /只有 Mivo（xindong\/mivo-canvas-plugin）的 PR 要登记合入通知，当前：PraiseZhu\/approve-exec#3/);
  assert.throws(() => notify({ gh, prRef: `${MIVO}#3`, leadAddress: 'lead-1', partnerPath: partnerFile(), now: NOW }), /--lead-address 要填 <deviceId>::<lead 会话 id>.*当前：lead-1/);
  assert.throws(() => notify({ gh, prRef: `${MIVO}#3`, leadAddress: LEAD, partnerPath: join(tmpdir(), 'no-such-dir-97', 'partner.json'), now: NOW }), /读不到合并伙伴地址 .*（ENOENT）：伙伴没部署，不登记/);
  assert.throws(() => notify({ gh, prRef: `${MIVO}#3`, leadAddress: LEAD, partnerPath: partnerFile({ session: 'partner-1' }), now: NOW }), /里的 session 应是 <deviceId>::<会话 id>，当前：partner-1/);
});

test('#97 notify CLI：走夹具 exit 0 输出一行 JSON；缺 --lead-address exit 2', () => {
  const { ghPath } = writeFixture({ [pullKey(2017)]: { state: 'open', merged_at: null } });
  const partner = partnerFile();
  const ok = spawnSync(process.execPath, [CLI, 'notify', '--pr', `${MIVO}#2017`, '--lead-address', LEAD, '--partner', partner, '--gh-fixture', ghPath, '--now', NOW], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).target_session_id, PARTNER);
  const bad = spawnSync(process.execPath, [CLI, 'notify', '--pr', `${MIVO}#2017`, '--partner', partner, '--gh-fixture', ghPath], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--lead-address/);
});

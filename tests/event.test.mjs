// event.mjs：v3 协议事件的唯一写通道（PraiseZhu/approve-exec#104 SC1–SC4，#107 的 prereview 类型）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, emit, list, parseEvents } from '../scripts/event.mjs';
import { activeDispatch, batchStatus, claim, release, unarchivedSessions } from '../scripts/batch.mjs';
import { REPO, LOGIN, commentsKey, ghFrom, parentFixture } from './fixtures/issues/build.mjs';

const A = `${REPO}#11`;
const HEAD = 'a'.repeat(40);
const NOW = '2026-11-14T02:00:00.000Z';
const ARGS = {
  dispatch: { session: 's11', title: '同步状态丨1114' },
  ready_for_verdict: { pr: 5, head: HEAD },
  verdict_pass: { pr: 5, head: HEAD, note: '全部通过' },
  verdict_revise: { pr: 5, head: HEAD, note: 'SC2 没达成' },
  ready: { pr: 5, head: HEAD },
  blocked: { note: '缺权限' },
  withdraw: { session: 's11', note: '会话已删除' },
  archived: { session: 's11' },
  prereview: { pr: 5, head: HEAD, note: '2 轮，修了 3 条' },
};

test('9 种类型各发一次，parse 全部读回，字段与写入一致', () => {
  const fixture = parentFixture();
  const gh = ghFrom(fixture);
  assert.deepEqual(Object.keys(ARGS).sort(), [...EVENT_TYPES].sort());
  for (const type of EVENT_TYPES) {
    const res = emit({ gh, type, itemRef: A, now: NOW, ...ARGS[type] });
    assert.equal(res.duplicate, false, type);
  }
  const { events, skipped } = list({ gh, itemRef: A });
  assert.equal(skipped, 0);
  assert.deepEqual(events.map((e) => e.type), EVENT_TYPES);
  const pass = events.find((e) => e.type === 'verdict_pass');
  assert.equal(pass.pr, 5);
  assert.equal(pass.head, HEAD);
  assert.equal(pass.note, '全部通过');
  assert.equal(pass.at, NOW);
  assert.equal(events.find((e) => e.type === 'dispatch').session, 's11');
});

test('同一事件发两次：第二次不产生新评论，duplicate 为真；同一版本不同内容的要改算两条', () => {
  const fixture = parentFixture();
  const gh = ghFrom(fixture);
  emit({ gh, type: 'verdict_pass', itemRef: A, pr: 5, head: HEAD, now: NOW });
  const again = emit({ gh, type: 'verdict_pass', itemRef: A, pr: 5, head: HEAD, now: NOW });
  assert.equal(again.duplicate, true);
  assert.equal(fixture[commentsKey(11)].length, 1);
  emit({ gh, type: 'verdict_revise', itemRef: A, pr: 5, head: HEAD, note: '第一条', now: NOW });
  emit({ gh, type: 'verdict_revise', itemRef: A, pr: 5, head: HEAD, note: '第二条', now: NOW });
  assert.equal(fixture[commentsKey(11)].length, 3);
});

test('要带 PR 和版本的类型缺了就拒绝；类型不认识也拒绝', () => {
  const gh = ghFrom(parentFixture());
  for (const type of ['ready_for_verdict', 'verdict_pass', 'verdict_revise', 'ready', 'prereview']) {
    assert.throws(() => emit({ gh, type, itemRef: A, pr: 5 }), /--head/, type);
    assert.throws(() => emit({ gh, type, itemRef: A, head: HEAD }), /--pr/, type);
  }
  assert.throws(() => emit({ gh, type: 'done', itemRef: A }), /--type 只能是/);
  assert.throws(() => emit({ gh, type: 'withdraw', itemRef: A, session: 's' }), /撤回原因/);
});

test('改版前两种手写验收评论不算 v3 事件；别人账号发的带标记评论不采信；坏标记计入 skipped', () => {
  const mark = (payload) => `x\n\n<!-- approve-exec:event v1 ${JSON.stringify(payload)} -->`;
  const comments = [
    { id: 1, user: { login: LOGIN }, body: `批准执行验收：通过（PR #2141，head ${HEAD}，2026-11-11 lead）。` },
    { id: 2, user: { login: LOGIN }, body: `批准执行通过 xindong/mivo-canvas-plugin#2215 PR #2224（head ${HEAD}）` },
    { id: 3, user: { login: 'someone-else' }, body: mark({ type: 'verdict_pass', ref: A, pr: 5, head: HEAD, id: 'x' }) },
    { id: 4, user: { login: LOGIN }, body: 'x\n\n<!-- approve-exec:event v1 {"type": -->' },
    { id: 5, user: { login: LOGIN }, body: mark({ type: 'nope', ref: A }) },
  ];
  const { events, skipped } = parseEvents(comments, LOGIN);
  assert.equal(events.length, 0);
  assert.equal(skipped, 1, '类型不认识的标记计入 skipped（JSON 截断的那条正则就匹配不上）');
});

test('派发、撤回、归档经事件通道写出后，旧解析照常认：status 判 in_progress、撤回后可重派、待归档能数出来', () => {
  const fixture = parentFixture();
  const gh = ghFrom(fixture);
  claim({ gh, itemRef: A, session: 's11', title: '同步状态丨1114', now: NOW });
  const body = fixture[commentsKey(11)][0].body;
  assert.match(body, /^批准执行派发：2026-11-14 acme\/app#11 → 会话 s11（同步状态丨1114）/);
  assert.match(body, /approve-exec:event v1/);
  assert.equal(activeDispatch(fixture[commentsKey(11)], A, LOGIN).session, 's11');
  assert.equal(batchStatus({ gh, issueRef: `${REPO}#10` }).items.find((i) => i.ref === A).state, 'in_progress');
  release({ gh, itemRef: A, reason: '会话已删除', now: NOW });
  assert.equal(activeDispatch(fixture[commentsKey(11)], A, LOGIN), null);
  assert.deepEqual(unarchivedSessions(fixture[commentsKey(11)], A, LOGIN), ['s11']);
  // 旧的手写派发评论（没有标记）仍被认出
  const old = parentFixture({ extra: { [commentsKey(11)]: [{ id: 1, user: { login: LOGIN }, body: `批准执行派发：2026-11-07 ${A} → 会话 old1（t丨1107）` }] } });
  assert.equal(batchStatus({ gh: ghFrom(old), issueRef: `${REPO}#10` }).items.find((i) => i.ref === A).state, 'in_progress');
});

test('#112 dispatch 可选 route 原样往返；拒绝坏字段且兼容无 route 的旧事件', () => {
  const route = { agent: 'codex', model: 'gpt-6.1-sol', kind: '逻辑', route_index: 1 };
  const fixture = parentFixture(); const gh = ghFrom(fixture);
  emit({ gh, type: 'dispatch', itemRef: A, session: 's-route', route, now: NOW });
  assert.deepEqual(list({ gh, itemRef: A }).events.at(-1).route, route);
  for (const broken of [{ ...route, route_index: -1 }, { ...route, route_index: 0.5 }, { ...route, model: '' }, { ...route, kind: '后端' }, { ...route, provider_id: 'secret' }]) {
    assert.throws(() => emit({ gh, type: 'dispatch', itemRef: A, session: 'bad', route: broken, now: NOW }), /dispatch route/);
  }
  emit({ gh, type: 'dispatch', itemRef: A, session: 'old-route', now: NOW });
  assert.equal(list({ gh, itemRef: A }).events.at(-1).route, undefined);
});

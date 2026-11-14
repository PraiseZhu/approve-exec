// charter.mjs：运行章程的校验、写入、读取，以及按章程交合并请求（PraiseZhu/approve-exec#105）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseAllowed, read, selectCharter, toCharter, write } from '../scripts/charter.mjs';
import { mergeRequest } from '../scripts/batch.mjs';
import { REPO, LOGIN, commentsKey, ghFrom, parentFixture } from './fixtures/issues/build.mjs';

const ROOT = `${REPO}#10`;
const LEAD = `${'a'.repeat(64)}::lead-1`;
export const CHARTER = {
  merge: { auto_request: true, bases: ['main', 'integration/*'] },
  conflict: { same_file: 'parallel' },
  prereview: 'feature',
  early_start: true,
  max_parallel: 6,
  manual_test: 'Orca Worker 在 Pro 上做 Mac 手测',
  user_words: '批准执行 acme/app#10，审查放行后自动合',
  lead_session: LEAD,
};

test('合法章程写入后读回，9 个字段逐一相等', () => {
  const fixture = parentFixture();
  const gh = ghFrom(fixture);
  write({ gh, rootRef: ROOT, raw: CHARTER, now: '2026-11-14T02:00:00.000Z' });
  assert.match(fixture[commentsKey(10)][0].body, /^批准执行章程：2026-11-14/);
  const { charter } = read({ gh, rootRef: ROOT });
  for (const k of Object.keys(CHARTER)) assert.deepEqual(charter[k], CHARTER[k], k);
  assert.equal(Object.keys(charter).length, 9, 'schema + 8 个业务字段');
});

test('多一个未知字段、max_parallel 写 0、bases 含 release/x、地址格式不对都拒绝，消息里有字段名', () => {
  assert.throws(() => toCharter({ ...CHARTER, extra: 1 }), /清单外的字段：extra/);
  assert.throws(() => toCharter({ ...CHARTER, max_parallel: 0 }), /max_parallel/);
  assert.throws(() => toCharter({ ...CHARTER, merge: { auto_request: true, bases: ['release/x'] } }), /merge\.bases/);
  assert.throws(() => toCharter({ ...CHARTER, lead_session: 'lead-1' }), /lead_session/);
  assert.throws(() => toCharter({ ...CHARTER, prereview: 'sometimes' }), /prereview/);
  assert.throws(() => toCharter({ ...CHARTER, conflict: { same_file: 'maybe' } }), /conflict\.same_file/);
});

test('别人账号发的章程不采信；同一账号发两条取后一条；没有章程读回 null', () => {
  const gh = ghFrom(parentFixture());
  assert.equal(read({ gh, rootRef: ROOT }).charter, null);
  const mark = (c) => `批准执行章程：x\n\n<!-- approve-exec:charter v1 ${JSON.stringify(c)} -->`;
  const comments = [
    { id: 1, user: { login: LOGIN }, body: mark({ ...CHARTER, max_parallel: 2 }) },
    { id: 2, user: { login: LOGIN }, body: mark({ ...CHARTER, max_parallel: 4 }) },
    { id: 3, user: { login: 'someone-else' }, body: mark({ ...CHARTER, max_parallel: 9 }) },
  ];
  assert.equal(selectCharter(comments, LOGIN).max_parallel, 4);
});

test('baseAllowed：integration/* 只认一层；没授权时一律不允许', () => {
  const c = toCharter(CHARTER);
  assert.equal(baseAllowed(c, 'main'), true);
  assert.equal(baseAllowed(c, 'integration/canvas-bounds-s1'), true);
  assert.equal(baseAllowed(c, 'integration/a/b'), false);
  assert.equal(baseAllowed(c, 'release/1.0'), false);
  assert.equal(baseAllowed(toCharter({ ...CHARTER, merge: { auto_request: false, bases: ['main'] } }), 'main'), false);
  assert.equal(baseAllowed(null, 'main'), false);
});

const HEAD = 'a'.repeat(40);
const PASS = { type: 'verdict_pass', ref: `${REPO}#11`, pr: 7, head: HEAD, at: '2026-11-14T01:00:00Z', id: 'p' };
function prFixture({ charter, pr = {}, events = [PASS] } = {}) {
  const fixture = parentFixture();
  if (charter) write({ gh: ghFrom(fixture), rootRef: ROOT, raw: charter });
  fixture[`api repos/${REPO}/pulls/7`] = { state: 'open', draft: false, merged_at: null, base: { ref: 'main' }, head: { sha: HEAD }, body: `任务 issue：${REPO}#11`, labels: [{ name: 'review:merge-ready' }], ...pr };
  fixture[commentsKey(11)] = events.map((e, i) => ({ id: 50 + i, user: { login: LOGIN }, created_at: e.at, body: `x\n\n<!-- approve-exec:event v1 ${JSON.stringify(e)} -->` }));
  return ghFrom(fixture);
}

test('merge-request：章程授权且目标分支在范围内才生成 pr-merge 的输入，带通知地址和用户原话', () => {
  const out = mergeRequest({ gh: prFixture({ charter: CHARTER }), prRef: `${REPO}#7`, rootRef: ROOT, lead: 'lead-1' });
  assert.equal(out.route, 'self', '非 Mivo 仓由 lead 按 pr-merge 自己合');
  assert.deepEqual(out.pr_merge_input.prs, [{ repo: REPO, number: 7 }]);
  assert.equal(out.pr_merge_input.notify_session, LEAD);
  assert.equal(out.pr_merge_input.authorization_text, CHARTER.user_words);
  assert.equal(mergeRequest({ gh: prFixture({ charter: CHARTER, pr: { merged_at: '2026-11-14T03:00:00Z' } }), prRef: `${REPO}#7`, rootRef: ROOT, lead: 'lead-1' }).already_merged, true);
});

test('merge-request：没有章程、章程没授权、目标分支不在范围、PR 还是 Draft 都拒绝', () => {
  const call = (gh) => () => mergeRequest({ gh, prRef: `${REPO}#7`, rootRef: ROOT, lead: 'lead-1' });
  assert.throws(call(prFixture()), /没有运行章程/);
  assert.throws(call(prFixture({ charter: { ...CHARTER, merge: { auto_request: false, bases: ['main'] } } })), /没有授权自动交合并请求/);
  assert.throws(call(prFixture({ charter: { ...CHARTER, merge: { auto_request: true, bases: ['main'] } }, pr: { base: { ref: 'integration/s1' } } })), /不含 .* 的目标分支 integration\/s1/);
  assert.throws(call(prFixture({ charter: CHARTER, pr: { draft: true } })), /不是开着的正式 PR/);
});

test('merge-request 只对本次 run 里审查放行、且判通过后没变过的 PR 生成输入（单审 P1）', () => {
  const call = (opts) => () => mergeRequest({ gh: prFixture({ charter: CHARTER, ...opts }), prRef: `${REPO}#7`, rootRef: ROOT, lead: 'lead-1' });
  assert.throws(call({ pr: { body: '任务 issue：acme/app#99' } }), /不是 acme\/app#10 的子 issue/);
  assert.throws(call({ pr: { body: '没有任务 issue 行' } }), /不是 acme\/app#10 的子 issue/);
  assert.throws(call({ pr: { labels: [] } }), /没有审查放行标签/);
  assert.throws(call({ events: [] }), /最新的裁决不是通过/);
  assert.throws(call({ events: [PASS, { ...PASS, type: 'verdict_revise', at: '2026-11-14T02:00:00Z', id: 'r' }] }), /最新的裁决不是通过/);
  assert.throws(call({ pr: { head: { sha: 'b'.repeat(40) } } }), /判通过后代码变了/);
});

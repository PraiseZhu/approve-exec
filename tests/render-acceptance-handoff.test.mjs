// render-acceptance-handoff.mjs：总 issue 交接评论（PraiseZhu/approve-exec#79 SC4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_SECTIONS, LOCAL_PATH_RE, handoffFirstLine, renderAcceptanceHandoff, rootScs, validateResult } from '../scripts/render-acceptance-handoff.mjs';

const ROOT_BODY = [
  '## 整体验收',
  '',
  '<!-- 整体验收也用 SC<n> 编号 -->',
  '- [ ] SC1 真实运行里 owner 不找 lead。验证：github-live',
  '- [x] **SC2** 交接后验收机才开轮。验证：github-live',
  '- [ ] SC3 两仓测试全绿。验证：static',
].join('\n');
const SCS = rootScs(ROOT_BODY);
const LEDGER = { root: { ref: 'acme/app#10' }, run_id: '12345678-aaaa-4bbb-8ccc-1234567890ab' };
const CHECK = {
  rows: [
    { ref: 'acme/app#11', state: 'archived', pr: 5, lane: 'personal', accepted_head: 'a'.repeat(40), current_head: 'a'.repeat(40), merged: true, head_moved: false, pushed_after_ready: false },
    { ref: 'acme/app#12', state: 'archived', pr: 6, lane: 'gated-handoff', accepted_head: 'b'.repeat(40), current_head: 'd'.repeat(40), merged: false, head_moved: true, pushed_after_ready: true },
    { ref: 'acme/app#13', state: 'closed', pr: null },
  ],
};
const RESULT = {
  conclusion: 'lead 判总 issue 通过：2 个子 PR 都已 Ready、CI 全绿。',
  sc: [
    { id: 'SC1', result: '人工手测', evidence: '亲见 2 个 owner 会话没给 lead 发消息', hint: '仍标人工手测' },
    { id: 'SC2', result: '人工手测', evidence: '交接评论先于验收机第 1 轮' },
    { id: 'SC3', result: '通过', evidence: '集成预览里 node scripts/run-tests.mjs → all pass', hint: '合并后在 main 上重跑' },
  ],
  focus: ['#12 合并前盯梢又推了提交', 'cleanup 附近两个 PR 都动过'],
  not_verified: ['SC1 的跨机运行'],
  post_launch: ['三台 git pull 后 selfcheck --live'],
  scope: ['所有 PR 只碰 scripts/ 与 tests/：是'],
};

test('#79 SC4 rootScs 读总 issue 的 SC 行（含已勾、加粗），HTML 注释里的不算', () => {
  assert.deepEqual(SCS.map((s) => s.id), ['SC1', 'SC2', 'SC3']);
});

test('#79 SC4 交接正文首行固定、七节齐全且顺序固定；子 PR 表有 lead 通过时的 head、当前 head、车道、Ready 后是否还有人推送', () => {
  const body = renderAcceptanceHandoff({ ledger: LEDGER, check: CHECK, result: RESULT, scs: SCS, n: 2, now: '2026-10-30T08:00:00.000Z' });
  const lines = body.split('\n');
  assert.equal(lines[0], '[批准执行] 交接验收 · 第 2 次');
  assert.equal(handoffFirstLine(1), '[批准执行] 交接验收 · 第 1 次');
  assert.equal(lines[1], '总 issue：acme/app#10 · lead 验收：2026-10-30T16:00:00+08:00 · 台账 12345678-aaaa-4bbb-8ccc-1234567890ab');
  const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  assert.deepEqual(headings, [...HANDOFF_SECTIONS]);
  assert.ok(lines.includes('| 子 issue | PR | lead 通过时的 head | 当前 head | 车道 | Ready 后还会有人推送吗 |'));
  assert.ok(lines.includes(`| acme/app#11 | #5（已合并） | ${'a'.repeat(40)} | ${'a'.repeat(40)} | personal | 否 |`));
  assert.ok(lines.includes(`| acme/app#12 | #6 | ${'b'.repeat(40)} | ${'d'.repeat(40)}（之后有新提交） | gated-handoff | 会（盯梢按审查意见推） |`));
  assert.ok(lines.includes('| acme/app#13 | — | — | — | — | 计划时已关闭 |'));
  assert.ok(body.includes('#6 在 lead 通过之后又有提交'));
  assert.ok(lines.includes('| SC3 | 通过 | 集成预览里 node scripts/run-tests.mjs → all pass | 合并后在 main 上重跑 |'));
  assert.ok(lines.includes('| SC2 | 人工手测 | 交接评论先于验收机第 1 轮 | — |'));
  // 验收机（vigil#140）按「## 请重点查」下的编号列表取重点项。
  const focus = body.split('## 请重点查')[1].split('\n## ')[0];
  assert.deepEqual(focus.split('\n').filter((l) => /^\d+\. /.test(l)), ['1. #12 合并前盯梢又推了提交', '2. cleanup 附近两个 PR 都动过']);
  assert.doesNotMatch(body, LOCAL_PATH_RE);
});

test('#79 SC4 validateResult：缺 SC、多 SC、有「未通过」、缺证据、结论为空都报出来；合格时为空', () => {
  assert.deepEqual(validateResult({ result: RESULT, scs: SCS }), []);
  const p = (over) => validateResult({ result: { ...RESULT, ...over }, scs: SCS }).join('；');
  assert.match(p({ sc: RESULT.sc.slice(1) }), /缺总 issue 的 SC1/);
  assert.match(p({ sc: [...RESULT.sc, { id: 'SC9', result: '通过', evidence: 'x' }] }), /总 issue 没有 SC9/);
  assert.match(p({ sc: RESULT.sc.map((r) => (r.id === 'SC3' ? { ...r, result: '未通过' } : r)) }), /SC3 未通过：总 issue 没验过就补子 issue，不交接/);
  assert.match(p({ sc: RESULT.sc.map((r) => (r.id === 'SC3' ? { ...r, evidence: ' ' } : r)) }), /SC3 缺 evidence/);
  assert.match(p({ conclusion: '' }), /缺 conclusion/);
  assert.match(p({ focus: 'x' }), /focus 必须是字符串数组/);
});

test('#79 SC4 本机绝对路径识别：/Users/、/home/、/tmp/、/private/、盘符；仓内相对路径不算', () => {
  for (const s of ['/Users/x/a', '在 /home/u/b 里', '/tmp/x', '/private/var/y', 'C:\\work']) assert.match(s, LOCAL_PATH_RE, s);
  for (const s of ['scripts/root-check.mjs', 'https://github.com/acme/app/pull/5', '.worktrees/approve-exec-preview-1']) assert.doesNotMatch(s, LOCAL_PATH_RE, s);
});

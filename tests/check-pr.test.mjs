// check-pr.mjs：批准执行 2026-11-07 改版 lead 的验收 / 收工检查，不读台账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPr, ciAllVerdict } from '../scripts/check-pr.mjs';
import { REPO, ghFrom, parentFixture } from './fixtures/issues/build.mjs';

const A = `${REPO}#11`;
const HEAD = 'a'.repeat(40);
const GOOD_BODY = [
  `任务 issue：${A}`, `Closes ${A}`, '', '## 验收对照', '', '| 验收项 | 状态 | 证据 |', '|---|---|---|',
  '| SC1 已同步 | 通过 | node --test |', '| SC2 离线 | 通过 | playwright |', '| SC3 上线后无报错 | 人工手测 | 上线后验证 |', '| SC4 CI 全绿 | 通过 | CI |',
].join('\n');

function setup({ pr = {}, files = ['src/sync/status.ts', 'tests/sync/status.test.ts'], ci = [{ name: 'test', bucket: 'pass' }], body = { ok: true, detail: 'ok' } } = {}) {
  const fixture = parentFixture();
  fixture[`api repos/${REPO}/pulls/5`] = { head: { sha: HEAD }, state: 'open', draft: true, merged: false, body: GOOD_BODY, ...pr };
  fixture[`api repos/${REPO}/pulls/5/files?per_page=100&page=1`] = files.map((filename) => ({ filename }));
  const checks = (args) => (args.includes('--required') ? { status: 0, stdout: JSON.stringify(ci) } : { status: 0, stdout: JSON.stringify(ci) });
  return { gh: ghFrom(fixture), checks, bodyCheck: () => body };
}
const failed = (res) => res.checks.filter((c) => !c.ok).map((c) => c.name);

test('验收档全部通过：Draft、CI 全绿、改动在范围内、正文齐、待定问题已定', () => {
  const res = checkPr({ ...setup(), ref: A, pr: 5, head: HEAD });
  assert.equal(res.ok, true, JSON.stringify(res.checks));
});

test('验收档：已转正式、head 对不上、CI 没绿都判不过', () => {
  assert.deepEqual(failed(checkPr({ ...setup({ pr: { draft: false } }), ref: A, pr: 5 })), ['pr_draft']);
  assert.deepEqual(failed(checkPr({ ...setup(), ref: A, pr: 5, head: 'b'.repeat(40) })), ['pr_head']);
  assert.deepEqual(failed(checkPr({ ...setup({ ci: [{ name: 'test', bucket: 'fail' }] }), ref: A, pr: 5 })), ['ci']);
});

test('验收档：超出「范围」的文件判不过；docs/pr/<PR号>/ 交接目录固定放行', () => {
  assert.deepEqual(failed(checkPr({ ...setup({ files: ['src/sync/status.ts', 'src/other.ts'] }), ref: A, pr: 5 })), ['scope']);
  assert.equal(checkPr({ ...setup({ files: ['src/sync/status.ts', 'docs/pr/5/review.md'] }), ref: A, pr: 5 }).ok, true);
});

test('验收档：正文缺「任务 issue」一行或缺 SC 行判不过', () => {
  const body = GOOD_BODY.replace(`任务 issue：${A}\n`, '').replace('| SC2 离线 | 通过 | playwright |\n', '');
  assert.deepEqual(failed(checkPr({ ...setup({ pr: { body } }), ref: A, pr: 5 })).sort(), ['body_issue_line', 'body_sc_rows']);
});

test('CI 口径与执行会话一致：全部检查跑完且通过才算绿，skipping 算通过；还在跑或非必需检查失败都不过（astra 审查 #7）', () => {
  const run = (ci) => ciAllVerdict(() => ({ status: 0, stdout: JSON.stringify(ci) }), REPO, 5);
  assert.equal(run([{ name: 'verify', bucket: 'pass' }, { name: 'design', bucket: 'skipping' }]).ok, true);
  assert.match(run([{ name: 'verify', bucket: 'pass' }, { name: 'win 2/4', bucket: 'pending' }]).detail, /还有 1 项检查在跑：win 2\/4/);
  assert.match(run([{ name: 'verify', bucket: 'pass' }, { name: 'unit', bucket: 'fail' }]).detail, /有检查没过：unit=fail/);
  assert.equal(run([]).ok, false);
});

test('验收档复核 ready 档 PR 正文：SC 还是「待验证」或缺证据就判不过（astra 审查 #8）', () => {
  const res = checkPr({ ...setup({ body: { ok: false, detail: 'SC2 还是「待验证」，不能转 Ready' } }), ref: A, pr: 5 });
  assert.deepEqual(failed(res), ['body_ready']);
  assert.match(res.checks.find((c) => c.name === 'body_ready').detail, /SC2 还是「待验证」/);
});

test('收工档：已转正式且 CI 全绿才过；还是 Draft 不过；已合并也算过', () => {
  assert.equal(checkPr({ ...setup({ pr: { draft: false } }), ref: A, pr: 5, stage: 'ready' }).ok, true);
  assert.deepEqual(failed(checkPr({ ...setup(), ref: A, pr: 5, stage: 'ready' })), ['pr_not_draft']);
  const merged = checkPr({ ...setup({ pr: { draft: false, state: 'closed', merged: true }, ci: [] }), ref: A, pr: 5, stage: 'ready' });
  assert.equal(merged.ok, true, JSON.stringify(merged.checks));
});

test('参数错：stage 不认识、PR 号不是整数都直接报错', () => {
  assert.throws(() => checkPr({ ...setup(), ref: A, pr: 5, stage: 'x' }), /--stage/);
  assert.throws(() => checkPr({ ...setup(), ref: A, pr: Number('abc') }), /--pr/);
});

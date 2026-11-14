// check-pr.mjs --stage recheck：判通过后代码变了，只查新增改动（PraiseZhu/approve-exec#104 SC5、SC6）。
// 场景取自 xindong/mivo-canvas-plugin PR 2204：判通过的版本是 7b43650…，之后盯梢的提交 8dc2b80 改了一行存量测试，
// 违反子 issue「存量测试只增不改」，当时没人复核（evolution/ledger.json 的 post-ready-fix-breaks-child-sc）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPr } from '../scripts/check-pr.mjs';
import { readFileSync } from 'node:fs';
import { REPO, childBody, ghFrom, issue, parentFixture } from './fixtures/issues/build.mjs';

const A = `${REPO}#11`;
const ACCEPTED = '7b43650a69e2e6aabcfb01efe279f7b28d04b1f1';
// PR 2204 里盯梢改存量测试的那个真实提交（回放数据里有它，排在判通过的版本之后）。回放数据是瘦身版、不带文件名，
// 所以改动文件清单是手写的，文件名用合成的（本仓公开，不带出来源仓的真实路径），保留「存量测试被删 1 行」这个情形。
const NOW_HEAD = '8dc2b808932e00530f75001acd8f3907bf7e7ed9';
const SCOPE = ['- `src/canvas/**`：边界逻辑', '- `src/canvas/**/*.test.ts`：相关测试'];

function setup({ head = NOW_HEAD, compare, ci = [{ name: 'test', bucket: 'pass' }] } = {}) {
  const a = issue(11, '[子1/4] 指定位置新建不出范围', childBody({ scope: SCOPE }));
  const fixture = parentFixture();
  fixture[`api repos/${REPO}/issues/11`] = a;
  fixture[`api repos/${REPO}/pulls/5`] = { head: { sha: head }, state: 'open', draft: false, body: `任务 issue：${A}` };
  if (compare !== undefined) fixture[`api repos/${REPO}/compare/${ACCEPTED}...${head}`] = compare;
  return { gh: ghFrom(fixture), checks: () => ({ status: 0, stdout: JSON.stringify(ci) }) };
}
const failed = (res) => res.checks.filter((c) => !c.ok).map((c) => c.name);
const run = (opts) => checkPr({ ...setup(opts), ref: A, pr: 5, stage: 'recheck', acceptedHead: ACCEPTED });

test('判通过后存量测试被删了行：不过，原因写出文件名和删除行数', () => {
  const res = run({ compare: { status: 'ahead', files: [
    { filename: 'src/canvas/existing.contract.test.ts', status: 'modified', additions: 1, deletions: 1 },
    { filename: 'src/canvas/feature.ts', status: 'modified', additions: 8, deletions: 2 },
  ] } });
  assert.deepEqual(failed(res), ['existing_tests']);
  const detail = res.checks.find((c) => c.name === 'existing_tests').detail;
  assert.match(detail, /src\/canvas\/existing\.contract\.test\.ts（删 1 行）/);
  assert.equal(res.accepted_head, ACCEPTED);
});

test('只加新测试、改源码：通过；新加的测试文件删行不算存量', () => {
  const res = run({ compare: { status: 'ahead', files: [
    { filename: 'src/canvas/feature.test.ts', status: 'added', additions: 40, deletions: 0 },
    { filename: 'src/canvas/existing.contract.test.ts', status: 'modified', additions: 5, deletions: 0 },
    { filename: 'src/canvas/feature.ts', status: 'modified', additions: 8, deletions: 2 },
  ] } });
  assert.equal(res.ok, true, JSON.stringify(res.checks));
});

test('当前版本就是判通过的版本：直接通过，不读差异', () => {
  const res = run({ head: ACCEPTED });
  assert.equal(res.ok, true);
  assert.deepEqual(res.checks.map((c) => c.name), ['pr_open', 'unchanged']);
});

test('差异读不到（旧版本被强推掉）：不过，要整体重新验收', () => {
  const res = run({});
  assert.deepEqual(failed(res), ['compare']);
  assert.match(res.checks.find((c) => c.name === 'compare').detail, /整体重新验收/);
});

test('判通过后的新增改动超出范围、或 CI 没绿：不过', () => {
  assert.deepEqual(failed(run({ compare: { status: 'ahead', files: [{ filename: 'server/app.ts', status: 'modified', additions: 1, deletions: 0 }] } })), ['scope']);
  assert.deepEqual(failed(run({ compare: { status: 'ahead', files: [] }, ci: [{ name: 'test', bucket: 'fail' }] })), ['ci']);
});

test('recheck 不带 --accepted-head 直接报错', () => {
  assert.throws(() => checkPr({ ...setup({ compare: { status: 'ahead', files: [] } }), ref: A, pr: 5, stage: 'recheck' }), /--accepted-head/);
});

test('场景里的两个版本来自真实回放：PR 2204 的提交列表里 8dc2b80 排在判通过的 7b43650 之后', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/replay/xindong__mivo-canvas-plugin__2089.json', import.meta.url), 'utf8'));
  const shas = data.prs.find((p) => p.number === 2204).commits.map((c) => c.sha);
  assert.ok(shas.indexOf(ACCEPTED) >= 0 && shas.indexOf(NOW_HEAD) > shas.indexOf(ACCEPTED));
});

test('PR 被回退到判通过版本之前（compare 是 behind）或分叉：不过，要整体重新验收（单审 P1）', () => {
  for (const status of ['behind', 'diverged']) {
    const res = run({ compare: { status, ahead_by: 0, files: [] } });
    assert.deepEqual(failed(res), ['compare'], status);
    assert.match(res.checks.find((c) => c.name === 'compare').detail, new RegExp(`${status}.*整体重新验收`));
  }
  assert.deepEqual(failed(run({ compare: { status: 'ahead' } })), ['compare'], 'files 不是数组也不过');
});

test('存量测试被改名成非测试文件、或改名的同时删了行：不过（单审 P2）', () => {
  const renamed = run({ compare: { status: 'ahead', files: [{ filename: 'src/canvas/status-renamed.ts', previous_filename: 'src/canvas/status.test.ts', status: 'renamed', additions: 0, deletions: 9 }] } });
  assert.deepEqual(failed(renamed), ['existing_tests']);
  assert.match(renamed.checks.find((c) => c.name === 'existing_tests').detail, /src\/canvas\/status\.test\.ts → src\/canvas\/status-renamed\.ts/);
  const pure = run({ compare: { status: 'ahead', files: [{ filename: 'src/canvas/b.test.ts', previous_filename: 'src/canvas/a.test.ts', status: 'renamed', additions: 0, deletions: 0 }] } });
  assert.equal(pure.ok, true, '测试文件之间纯改名、没删行，不算');
});

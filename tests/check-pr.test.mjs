// check-pr.mjs：批准执行 2026-11-07 改版 lead 的验收 / 收工检查，不读台账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPr, ciAllVerdict } from '../scripts/check-pr.mjs';
import { REPO, LOGIN, childBody, commentsKey, ghFrom, issue, parentFixture } from './fixtures/issues/build.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { CARDS_DIR } from '../scripts/lib/repo-card.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// v3：范围三档（#106）、预审与上游检查（#107）

const scopeNote = (file, why) => `${GOOD_BODY}\n\n## 范围对照\n\n- \`${file}\`：${why}\n\n## 风险与回滚\n\n无`;

function cardsDirWith(card) {
  const dir = mkdtempSync(join(tmpdir(), 'cards-'));
  writeFileSync(join(dir, 'acme__app.json'), JSON.stringify(card));
  return dir;
}
const CARD = { schema: 'approve-exec/repo-card@1', repo: REPO, always_allowed: ['docs/pr/{pr}/**', 'scripts/ci/size.baseline.json'], hot_files: [], guards: [], verify: [], review_rules: [], pitfalls: [] };

test('范围三档：范围外文件在「范围对照」写了说明记 needs_judgement（总结果仍过），没写说明不过', () => {
  const files = ['src/sync/status.ts', 'scripts/ci/first-screen-size.baseline.json'];
  const explained = checkPr({ ...setup({ files, pr: { body: scopeNote('scripts/ci/first-screen-size.baseline.json', '首屏 JS 增加 4675 字节，按仓库规则上调基线') } }), ref: A, pr: 5 });
  assert.equal(explained.ok, true, JSON.stringify(explained.checks));
  assert.deepEqual(explained.judgement.map((j) => j.file), ['scripts/ci/first-screen-size.baseline.json']);
  assert.match(explained.checks.find((c) => c.name === 'scope').detail, /needs_judgement/);
  const silent = checkPr({ ...setup({ files }), ref: A, pr: 5 });
  assert.deepEqual(failed(silent), ['scope']);
  assert.equal(silent.judgement, undefined);
  // 只列路径、没有说明的不算
  const bare = checkPr({ ...setup({ files, pr: { body: `${GOOD_BODY}\n\n## 范围对照\n\n- \`scripts/ci/first-screen-size.baseline.json\`` } }), ref: A, pr: 5 });
  assert.deepEqual(failed(bare), ['scope']);
});

test('范围三档：仓库卡 always_allowed 放行（{pr} 换成 PR 号）；没有仓库卡的仓仍放行 docs/pr/<PR号>/', () => {
  const files = ['src/sync/status.ts', 'docs/pr/5/review.md', 'scripts/ci/size.baseline.json'];
  assert.equal(checkPr({ ...setup({ files }), ref: A, pr: 5, cardsDir: cardsDirWith(CARD) }).ok, true);
  assert.deepEqual(failed(checkPr({ ...setup({ files }), ref: A, pr: 5 })), ['scope'], '没有卡时基线文件不放行');
  assert.equal(checkPr({ ...setup({ files: ['src/sync/status.ts', 'docs/pr/5/review.md'] }), ref: A, pr: 5 }).ok, true);
});

const CHARTER_MARK = (prereview) => `批准执行章程：2026-11-14\n\n<!-- approve-exec:charter v1 ${JSON.stringify({
  schema: 'approve-exec/charter@1', merge: { auto_request: false, bases: ['main'] }, conflict: { same_file: 'serial' }, prereview, early_start: false,
  max_parallel: 4, manual_test: 'x', user_words: 'x', lead_session: `${'a'.repeat(64)}::lead-1`,
})} -->`;

function withCharter(prereview, { files, events = [] }) {
  const s = setup({ files });
  const fixture = parentFixture();
  fixture[`api repos/${REPO}/pulls/5`] = { head: { sha: HEAD }, state: 'open', draft: true, merged: false, body: GOOD_BODY };
  fixture[`api repos/${REPO}/pulls/5/files?per_page=100&page=1`] = files.map((filename) => ({ filename }));
  fixture[commentsKey(10)] = [{ id: 1, user: { login: LOGIN }, body: CHARTER_MARK(prereview) }];
  fixture[commentsKey(11)] = events.map((e, i) => ({ id: 10 + i, user: { login: LOGIN }, body: `批准执行预审 x\n\n<!-- approve-exec:event v1 ${JSON.stringify(e)} -->` }));
  return { ...s, gh: ghFrom(fixture) };
}
const pre = (head) => ({ type: 'prereview', ref: A, pr: 5, head, at: '2026-11-14T01:00:00Z', id: head.slice(0, 6) });

test('预审：章程是 feature 且改了源码时，要有当前版本的预审记录；旧版本的记录不算', () => {
  const files = ['src/sync/status.ts', 'tests/sync/status.test.ts'];
  const none = checkPr({ ...withCharter('feature', { files }), ref: A, pr: 5 });
  assert.deepEqual(failed(none), ['prereview']);
  assert.match(none.checks.find((c) => c.name === 'prereview').detail, /当前版本没有预审记录/);
  assert.deepEqual(failed(checkPr({ ...withCharter('feature', { files, events: [pre('b'.repeat(40))] }), ref: A, pr: 5 })), ['prereview']);
  assert.equal(checkPr({ ...withCharter('feature', { files, events: [pre(HEAD)] }), ref: A, pr: 5 }).ok, true);
});

test('预审：只改测试和文档、章程是 off、或没有章程时不要求', () => {
  const docsOnly = checkPr({ ...withCharter('feature', { files: ['tests/sync/status.test.ts'] }), ref: A, pr: 5 });
  assert.equal(docsOnly.ok, true, JSON.stringify(docsOnly.checks));
  assert.match(docsOnly.checks.find((c) => c.name === 'prereview').detail, /章程未要求/);
  assert.equal(checkPr({ ...withCharter('off', { files: ['src/sync/status.ts'] }), ref: A, pr: 5 }).ok, true);
  assert.match(checkPr({ ...setup(), ref: A, pr: 5 }).checks.find((c) => c.name === 'prereview').detail, /章程未要求/);
  assert.deepEqual(failed(checkPr({ ...withCharter('all', { files: ['tests/sync/status.test.ts'] }), ref: A, pr: 5 })), ['prereview'], 'all 时只改测试也要预审');
});

test('预开工：上游子 issue 还开着时不验收，列出上游；上游关闭后通过', () => {
  const C = `${REPO}#13`;
  const make = (aState) => {
    const fixture = parentFixture({ aState, aReason: aState === 'closed' ? 'completed' : null });
    const body = GOOD_BODY.replaceAll(A, C).replace('| SC4 CI 全绿 | 通过 | CI |', '| SC4 CI 全绿 | 通过 | CI |');
    fixture[`api repos/${REPO}/pulls/5`] = { head: { sha: HEAD }, state: 'open', draft: true, merged: false, body };
    fixture[`api repos/${REPO}/pulls/5/files?per_page=100&page=1`] = [{ filename: 'src/sync/offline.ts' }];
    return { gh: ghFrom(fixture), checks: () => ({ status: 0, stdout: JSON.stringify([{ name: 'test', bucket: 'pass' }]) }), bodyCheck: () => ({ ok: true, detail: 'ok' }) };
  };
  const waiting = checkPr({ ...make('open'), ref: C, pr: 5 });
  assert.deepEqual(failed(waiting), ['upstream_merged']);
  assert.match(waiting.checks.find((c) => c.name === 'upstream_merged').detail, /acme\/app#11/);
  assert.equal(checkPr({ ...make('closed'), ref: C, pr: 5 }).ok, true);
  // 上游被关成「不做」不算合入（和 batch.mjs 的依赖判定同口径，单审 P2）
  const dropped = make('closed');
  const inner = dropped.gh;
  dropped.gh = (args) => { const out = inner(args); return args.join(' ') === `api repos/${REPO}/issues/11` ? { ...out, state_reason: 'not_planned' } : out; };
  assert.deepEqual(failed(checkPr({ ...dropped, ref: C, pr: 5 })), ['upstream_merged']);
});

test('预开工：上游 issue 关了但它的任务 PR 还开着，不算合入（单审第 2 轮 P2）', () => {
  const C = `${REPO}#13`;
  const fixture = parentFixture({ aState: 'closed', aReason: 'completed' });
  fixture[`api repos/${REPO}/pulls/5`] = { head: { sha: HEAD }, state: 'open', draft: true, merged: false, body: GOOD_BODY.replaceAll(A, C) };
  fixture[`api repos/${REPO}/pulls/5/files?per_page=100&page=1`] = [{ filename: 'src/sync/offline.ts' }];
  fixture[`api repos/${REPO}/pulls?state=open&per_page=100&page=1`] = [{ number: 4, draft: false, body: `任务 issue：${A}` }];
  const res = checkPr({ gh: ghFrom(fixture), checks: () => ({ status: 0, stdout: JSON.stringify([{ name: 'test', bucket: 'pass' }]) }), bodyCheck: () => ({ ok: true, detail: 'ok' }), ref: C, pr: 5 });
  assert.deepEqual(failed(res), ['upstream_merged']);
});

// #121：正式档放行仓库卡列出的「转正式后才开始」的审查；Mivo 卡默认放行规则强制同步的文件

test('#121 正式档：ready_pending_allowed 里的检查还在跑不拦并写明归盯梢；其他检查在跑、名单里的检查失败、验收档都照样不过', () => {
  const dir = cardsDirWith({ ...CARD, ready_pending_allowed: ['review-pr'] });
  const ci = [{ name: 'verify', bucket: 'pass' }, { name: 'review-pr', bucket: 'pending' }];
  const ready = checkPr({ ...setup({ pr: { draft: false }, ci }), ref: A, pr: 5, stage: 'ready', cardsDir: dir });
  assert.equal(ready.ok, true, JSON.stringify(ready.checks));
  assert.match(ready.checks.find((c) => c.name === 'ci').detail, /review-pr 还在跑.*归盯梢/);
  const other = checkPr({ ...setup({ pr: { draft: false }, ci: [...ci, { name: 'unit', bucket: 'pending' }] }), ref: A, pr: 5, stage: 'ready', cardsDir: dir });
  assert.deepEqual(failed(other), ['ci']);
  const failedReview = checkPr({ ...setup({ pr: { draft: false }, ci: [{ name: 'verify', bucket: 'pass' }, { name: 'review-pr', bucket: 'fail' }] }), ref: A, pr: 5, stage: 'ready', cardsDir: dir });
  assert.deepEqual(failed(failedReview), ['ci']);
  const noCard = checkPr({ ...setup({ pr: { draft: false }, ci }), ref: A, pr: 5, stage: 'ready' });
  assert.deepEqual(failed(noCard), ['ci'], '没有仓库卡时不放行');
  const onlyAllowed = checkPr({ ...setup({ pr: { draft: false }, ci: [{ name: 'review-pr', bucket: 'pending' }] }), ref: A, pr: 5, stage: 'ready', cardsDir: dir });
  assert.deepEqual(failed(onlyAllowed), ['ci'], '只有名单里的检查在跑、其他检查一项都没跑完时不放行');
  assert.match(onlyAllowed.checks.find((c) => c.name === 'ci').detail, /除了 review-pr 之外还没有任何检查跑完/);
  const acceptance = checkPr({ ...setup({ ci }), ref: A, pr: 5, cardsDir: dir });
  assert.deepEqual(failed(acceptance), ['ci'], '验收档不放行');
});

test('#121 Mivo 卡的 always_allowed 放行产品规则、设计台账、真浏览器用例', () => {
  const mivo = JSON.parse(readFileSync(join(CARDS_DIR, 'xindong__mivo-canvas-plugin.json'), 'utf8'));
  const dir = cardsDirWith({ ...mivo, repo: REPO });
  const files = ['src/sync/status.ts', 'docs/product-rules/canvas-bounds.md', 'cindyplugin/design-inventory.md', 'scripts/fixtures/canvas-browser/cases/canvas-world-bounds.case.mjs'];
  const res = checkPr({ ...setup({ files }), ref: A, pr: 5, cardsDir: dir });
  assert.equal(res.ok, true, JSON.stringify(res.checks));
});

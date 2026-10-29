// accept-check.mjs：lead 验收前的确定性检查（PraiseZhu/approve-exec#69 SC4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, readRoot } from '../scripts/issue-plan.mjs';
import { init, prepare, bind, checkpoint } from '../scripts/issue-run.mjs';
import { acceptCheck, ciVerdict, matchScopeGlob, outOfScope, scRowsInBody } from '../scripts/accept-check.mjs';
import { REPO, childBody, parentFixture, writeFixture, ghFrom } from './fixtures/issues/build.mjs';

const CLI = fileURLToPath(new URL('../scripts/accept-check.mjs', import.meta.url));
const RUN_CLI = fileURLToPath(new URL('../scripts/issue-run.mjs', import.meta.url));
const NOW = '2026-10-29T08:00:00.000Z';
const A = `${REPO}#11`;
const HEAD = 'a'.repeat(40);
const SC_OK = [{ id: 'SC1', status: 'pass' }, { id: 'SC2', status: 'pass' }, { id: 'SC3', status: 'manual' }, { id: 'SC4', status: 'pass' }];
const GOOD_BODY = [
  `任务 issue：${A}`,
  `Closes ${A}`,
  '',
  '## 验收对照',
  '',
  '| 验收项 | 状态 | 证据 |',
  '|---|---|---|',
  '| SC1 状态为 ok 时显示「已同步」 | 通过 | node --test |',
  '| SC2 断网 30 秒后显示「离线」 | 通过 | playwright |',
  '| SC3 上线后 24 小时内无同步报错 | 人工手测 | 上线后验证 |',
  '| SC4 目标仓测试与 CI 全绿 | 通过 | CI |',
].join('\n');

/** 夹具：#11 已派、owner 在 PR #5 head=HEAD 写了 awaiting_acceptance。 */
function scenario({ pr = {}, files = ['src/sync/status.ts', 'tests/sync/status.test.ts'], required, all = [{ name: 'test', bucket: 'pass' }], issueBody } = {}) {
  const fixture = parentFixture();
  if (issueBody) {
    fixture[`api repos/${REPO}/issues/11`] = { ...fixture[`api repos/${REPO}/issues/11`], body: issueBody };
  }
  fixture[`api repos/${REPO}/pulls/5`] = { head: { sha: HEAD, ref: 'feat/x' }, state: 'open', draft: true, body: GOOD_BODY, ...pr };
  fixture[`api repos/${REPO}/pulls/5/files?per_page=100&page=1`] = files.map((filename) => ({ filename }));
  fixture[`pr checks 5 --repo ${REPO} --required --json name,bucket`] = required ?? { status: 1, stdout: '', stderr: "no required checks reported on the 'feat/x' branch" };
  fixture[`pr checks 5 --repo ${REPO} --json name,bucket`] = all;
  const fx = writeFixture(fixture);
  const gh = ghFrom(fixture);
  const { root, children } = readRoot(gh, `${REPO}#10`);
  const plan = buildPlan({ root, children, repoDirs: { [REPO]: fx.repoDir }, lead: 'codex', entry: '批准执行', now: NOW });
  const planPath = join(fx.dir, 'plan.json');
  const ledgerPath = join(fx.dir, 'ledger.json');
  writeFileSync(planPath, JSON.stringify(plan));
  init({ plan, planPath, ledgerPath, now: NOW });
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const { claim_id } = prepare({ ledger, plan, ref: A, leadSessionId: 'lead-1', gh, now: NOW });
  bind({ ledger, ref: A, claimId: claim_id, result: { target_session_id: 'owner-1' }, gh, now: NOW });
  checkpoint({ ledger, plan, ref: A, state: 'awaiting_acceptance', pr: '5', head: HEAD, sc: SC_OK, keelRun: 'keel-1', lane: 'draft-gated-handoff', now: NOW });
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  writeFileSync(fx.ghPath, JSON.stringify(fixture));
  const checks = (args) => {
    const key = args.join(' ');
    if (!Object.hasOwn(fixture, key)) throw new Error(`gh 夹具缺少: ${key}`);
    return fixture[key];
  };
  return { ...fx, fixture, gh, checks, plan, ledger, ledgerPath };
}

const run = (s, stage = 'acceptance') => acceptCheck({ ledger: s.ledger, plan: s.plan, ref: A, stage, gh: s.gh, checks: s.checks, now: NOW });
const failed = (res) => res.checks.filter((c) => !c.ok).map((c) => c.name);

test('SC4 全部满足时 ok=true，结果带 PR、head 与阶段', () => {
  const res = run(scenario());
  assert.equal(res.ok, true, JSON.stringify(res.checks));
  assert.deepEqual([res.stage, res.pr, res.head], ['acceptance', 5, HEAD]);
});

test('SC4 PR head 与 checkpoint 不一致 → pr_head 不过', () => {
  const res = run(scenario({ pr: { head: { sha: 'b'.repeat(40), ref: 'feat/x' } } }));
  assert.equal(res.ok, false);
  assert.deepEqual(failed(res), ['pr_head']);
});

test('SC4 必需检查不是全绿 → ci 不过；没设必需检查时看全部；一项检查都没有也不过', () => {
  let res = run(scenario({ required: [{ name: 'verify', bucket: 'pass' }, { name: 'e2e', bucket: 'pending' }] }));
  assert.deepEqual(failed(res), ['ci']);
  assert.match(res.checks.find((c) => c.name === 'ci').detail, /必需检查未全绿：e2e=pending/);
  res = run(scenario({ all: [{ name: 'test', bucket: 'fail' }] }));
  assert.match(res.checks.find((c) => c.name === 'ci').detail, /全部检查未全绿：test=fail/);
  res = run(scenario({ all: [] }));
  assert.match(res.checks.find((c) => c.name === 'ci').detail, /没有任何检查/);
  res = run(scenario({ required: [{ name: 'verify', bucket: 'pass' }], all: [{ name: 'flaky', bucket: 'fail' }] }));
  assert.equal(res.ok, true, '有必需检查时只看必需检查');
});

test('反例（review-pr72）：必需检查查询出错时 ci 不过，不退回去看全部检查', () => {
  const res = run(scenario({ required: { status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' } }));
  assert.deepEqual(failed(res), ['ci']);
  assert.match(res.checks.find((c) => c.name === 'ci').detail, /读不到必需检查（HTTP 500/);
  const none = run(scenario({ required: { status: 1, stdout: '', stderr: "no checks reported on the 'feat/x' branch" } }));
  assert.deepEqual(failed(none), ['ci'], '反例（review-pr72 第 2 轮）：「no checks reported」不等于仓库没设必需检查');
});

test('反例（review-pr72）：「验收对照」一节以外的 SC 表格行不算数', () => {
  const body = GOOD_BODY.replace(/^\| SC3 .*$/m, '') + '\n\n## 随手记录\n\n| SC3 提了一句 | 文本 |';
  const res = run(scenario({ pr: { body } }));
  assert.deepEqual(failed(res), ['body_sc_rows']);
});

test('反例（review-pr72）：verdict --pass 自己跑 accept-check，不收 --check；检查不过就拒绝并点名', () => {
  const verdictCli = (s, ...a) => spawnSync(process.execPath, [RUN_CLI, 'verdict', '--ledger', s.ledgerPath, '--item', A, ...a, '--gh-fixture', s.ghPath, '--now', NOW], { encoding: 'utf8' });
  let s = scenario({ files: ['src/sync/status.ts', 'README.md'] });
  const forged = join(s.dir, 'forged.json');
  writeFileSync(forged, JSON.stringify({ ok: true, stage: 'acceptance', ref: A, pr: 5, head: HEAD }));
  let res = verdictCli(s, '--pass', '--check', forged);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /不收 --check/);
  res = verdictCli(s, '--pass');
  assert.equal(res.status, 2);
  assert.match(res.stderr, /不过的项：scope/);
  assert.equal(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).items[A].state, 'awaiting_acceptance');
  s = scenario();
  res = verdictCli(s, '--pass');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).state, 'accepted');
});

test('SC4 改动文件超出子 issue 范围 → scope 不过，并点名文件', () => {
  const res = run(scenario({ files: ['src/sync/status.ts', 'README.md'] }));
  assert.deepEqual(failed(res), ['scope']);
  assert.match(res.checks.find((c) => c.name === 'scope').detail, /README\.md/);
});

test('SC4 PR 正文缺「任务 issue：」行或缺某条 SC 的验收对照行 → body 检查不过', () => {
  let res = run(scenario({ pr: { body: GOOD_BODY.replace(`任务 issue：${A}`, '任务：随便') } }));
  assert.deepEqual(failed(res), ['body_issue_line']);
  res = run(scenario({ pr: { body: GOOD_BODY.replace(/^\| SC3 .*$/m, '') } }));
  assert.deepEqual(failed(res), ['body_sc_rows']);
  assert.match(res.checks.find((c) => c.name === 'body_sc_rows').detail, /缺 SC3/);
});

test('SC4 子 issue「待定问题」里有没写「已定」的条目 → pending_questions 不过', () => {
  const res = run(scenario({ issueBody: childBody({ pending: '- 用哪个缓存库\n- 已定 2026-10-29：图标用 svg' }) }));
  assert.deepEqual(failed(res), ['pending_questions']);
  assert.match(res.checks.find((c) => c.name === 'pending_questions').detail, /用哪个缓存库/);
});

test('--stage ready：PR 还是 Draft 时不过', () => {
  assert.deepEqual(failed(run(scenario(), 'ready')), ['pr_not_draft']);
  assert.equal(run(scenario({ pr: { draft: false } }), 'ready').ok, true);
});

test('CLI：全部通过 exit 0 并写出结果文件；有不过 exit 2', () => {
  const s = scenario();
  const out = join(s.dir, 'check.json');
  let res = spawnSync(process.execPath, [CLI, '--ledger', s.ledgerPath, '--item', A, '--out', out, '--gh-fixture', s.ghPath, '--now', NOW], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).ok, true);
  res = spawnSync(process.execPath, [CLI, '--ledger', s.ledgerPath, '--item', A, '--stage', 'ready', '--gh-fixture', s.ghPath], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).ok, false);
});

test('范围匹配与 KEEL scope.ts 同口径：** / * / 尾斜杠 / node_modules', () => {
  assert.equal(matchScopeGlob('tests/sync/a.test.ts', 'tests/**/*.test.ts'), true);
  assert.equal(matchScopeGlob('tests/a.test.ts', 'tests/**/*.test.ts'), true);
  assert.equal(matchScopeGlob('src/a/b.ts', 'src/*.ts'), false);
  assert.equal(matchScopeGlob('docs/x/y.md', 'docs/'), true);
  assert.equal(matchScopeGlob('docs', 'docs/**'), true);
  assert.deepEqual(outOfScope(['node_modules/x.js', 'a.md'], ['b.md']), ['a.md']);
  assert.deepEqual([...scRowsInBody('## 验收对照\n| **SC2** x |\n| SC10 y |\n- SC3 不是表格行')], ['SC2', 'SC10']);
  assert.deepEqual([...scRowsInBody('### 验收对照\n| SC1 x |\n## 风险\n| SC2 y |')], ['SC1'], 'Mivo 模板的三级标题也认，下一个标题之后不算');
  assert.equal(ciVerdict(() => [{ name: 'a', bucket: 'skipping' }], 'o/r', 1).ok, true, 'skipping 算通过');
});

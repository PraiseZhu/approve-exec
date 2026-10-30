// root-check.mjs：总 issue 验收前的检查与集成预览（PraiseZhu/approve-exec#79 SC2、SC3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, readRoot } from '../scripts/issue-plan.mjs';
import { init } from '../scripts/issue-run.mjs';
import { rootCheck, preview, cleanupPreview, previewName } from '../scripts/root-check.mjs';
import { REPO, parentFixture, writeFixture, ghFrom } from './fixtures/issues/build.mjs';

const CLI = fileURLToPath(new URL('../scripts/root-check.mjs', import.meta.url));
const NOW = '2026-10-30T08:00:00.000Z';
const A = `${REPO}#11`;
const B = `${REPO}#12`;
const H = (c) => c.repeat(40);

/** 台账：#11（PR 5）、#12（PR 6）已归档，#13、#14 计划时已关闭。prs 覆盖 GitHub 上 PR 的样子。 */
function archivedRun({ prs = {}, lanes = {}, ci = 'pass' } = {}) {
  const fixture = parentFixture();
  const fx = writeFixture(fixture);
  const gh = ghFrom(fixture);
  const { root, children } = readRoot(gh, `${REPO}#10`);
  const plan = buildPlan({ root, children, repoDirs: { [REPO]: fx.repoDir }, lead: 'claude-code', entry: '批准执行', now: NOW });
  const planPath = join(fx.dir, 'plan.json');
  const ledgerPath = join(fx.dir, 'ledger.json');
  writeFileSync(planPath, JSON.stringify(plan));
  init({ plan, planPath, ledgerPath, now: NOW });
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const set = (ref, pr, head, lane) => {
    Object.assign(ledger.items[ref], { state: 'archived', checkpoint: { seq: 2, state: 'ready', pr, head, lane } });
    fixture[`api repos/${REPO}/pulls/${pr}`] = { head: { ref: `feat/${pr}`, sha: head }, state: 'open', draft: false, merged: false, ...prs[pr] };
    fixture[`pr checks ${pr} --repo ${REPO} --required --json name,bucket`] = [{ name: 'test', bucket: ci }];
  };
  set(A, 5, H('a'), lanes[5] ?? 'personal');
  set(B, 6, H('b'), lanes[6] ?? 'gated-handoff');
  for (const ref of [`${REPO}#13`, `${REPO}#14`]) ledger.items[ref].state = 'closed';
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  writeFileSync(fx.ghPath, JSON.stringify(fixture));
  return { ...fx, fixture, gh, plan, planPath, ledger, ledgerPath };
}

const check = (s) => rootCheck({ ledger: s.ledger, gh: s.gh, checks: s.gh, now: NOW });
const bad = (res) => res.rows.filter((r) => !r.ok).map((r) => r.ref);

test('#79 SC2 全部子 PR 非 Draft、CI 绿、开着或已合并、personal 车道 head 没变 → ok；计划时已关闭的直接算过', () => {
  let res = check(archivedRun());
  assert.equal(res.ok, true, JSON.stringify(res.rows));
  assert.deepEqual(res.rows.filter((r) => r.state === 'closed').map((r) => r.note), ['计划时已关闭', '计划时已关闭']);
  res = check(archivedRun({ prs: { 5: { state: 'closed', merged: true } } }));
  assert.equal(res.ok, true, '已合并算过（和 #78 cleanup 一致）');
  assert.equal(res.rows.find((r) => r.ref === A).merged, true);
});

test('#79 SC2 任一项不过整体 ok=false 并列出：Draft、CI 不绿、关了没合、personal 车道 head 变了、还没收工', () => {
  const cases = [
    [{ prs: { 5: { draft: true } } }, /PR #5 还是 Draft/],
    [{ ci: 'fail' }, /PR #5 必需检查未全绿：test=fail/],
    [{ prs: { 5: { state: 'closed', merged: false } } }, /PR #5 关了没合（状态 closed）/],
    [{ prs: { 5: { head: { ref: 'feat/5', sha: H('c') } } } }, new RegExp(`PR #5 的 head 从 lead 判通过时的 ${H('a')} 变成了 ${H('c')}：新提交没验收过`)],
  ];
  for (const [opts, re] of cases) {
    const res = check(archivedRun(opts));
    assert.equal(res.ok, false, String(re));
    assert.ok(bad(res).includes(A));
    assert.match(res.rows.find((r) => r.ref === A).problems.join('；'), re);
  }
  const s = archivedRun();
  s.ledger.items[A].state = 'ready';
  assert.match(check(s).rows.find((r) => r.ref === A).problems.join('；'), /子 issue 还没收工（ready）/);
});

test('#79 SC2 交接车道 head 变了只记 head_moved（Ready 后归盯梢推），不判不过', () => {
  const res = check(archivedRun({ prs: { 6: { head: { ref: 'feat/6', sha: H('d') } } } }));
  assert.equal(res.ok, true);
  const row = res.rows.find((r) => r.ref === B);
  assert.equal(row.head_moved, true);
  assert.equal(row.pushed_after_ready, true);
  assert.deepEqual([row.accepted_head, row.current_head], [H('b'), H('d')]);
});

// preview：临时 bare origin + 主目录克隆，PR head 放在 refs/pull/<n>/head（和 GitHub 一样）。

function gitWorld({ conflict = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'root-preview-'));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  const origin = join(dir, 'origin.git');
  g(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const repo = join(dir, 'repo');
  g(dir, 'clone', '-q', origin, repo);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  g(repo, 'add', '.');
  g(repo, ...id, 'commit', '-q', '-m', 'base');
  g(repo, 'push', '-q', 'origin', 'HEAD:main');
  const branch = (name, file, text) => {
    g(repo, 'checkout', '-q', '-b', name, 'origin/main');
    writeFileSync(join(repo, file), text);
    g(repo, 'add', '.');
    g(repo, ...id, 'commit', '-q', '-m', name);
    return g(repo, 'rev-parse', 'HEAD');
  };
  const h5 = branch('feat/5', 'a.txt', 'from #11\n');
  const h6 = branch('feat/6', conflict ? 'a.txt' : 'b.txt', 'from #12\n');
  g(repo, 'checkout', '-q', 'main');
  g(repo, 'push', '-q', 'origin', `${h5}:refs/pull/5/head`, `${h6}:refs/pull/6/head`);
  return { repo, origin, h5, h6, g, id };
}

function previewRun(world) {
  const s = archivedRun({ prs: { 5: { head: { ref: 'feat/5', sha: world.h5 } }, 6: { head: { ref: 'feat/6', sha: world.h6 } } } });
  s.ledger.items[A].checkpoint.head = world.h5;
  s.ledger.items[B].checkpoint.head = world.h6;
  for (const i of s.plan.items) i.keel_run.repo_dir = world.repo;
  return s;
}

test('#79 SC3 --preview 从 origin/main 开 .worktrees/approve-exec-preview-<run>，按批次依次合入各子 PR 的 head；--cleanup 删掉', () => {
  const w = gitWorld();
  const s = previewRun(w);
  const res = preview({ ledger: s.ledger, plan: s.plan, check: check(s) });
  assert.equal(res.ok, true, JSON.stringify(res));
  const [repo] = res.repos;
  const wt = join(w.repo, '.worktrees', previewName(s.ledger));
  assert.equal(realpathSync(repo.dir), realpathSync(wt));
  assert.match(previewName(s.ledger), /^approve-exec-preview-[0-9a-f-]{8}$/);
  assert.deepEqual(repo.merged, [5, 6]);
  assert.equal(readFileSync(join(wt, 'a.txt'), 'utf8'), 'from #11\n');
  assert.equal(readFileSync(join(wt, 'b.txt'), 'utf8'), 'from #12\n');
  assert.equal(w.g(wt, 'status', '--porcelain'), '');
  assert.equal(w.g(w.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '主目录不动');
  const again = preview({ ledger: s.ledger, plan: s.plan, check: check(s) });
  assert.equal(again.ok, true, '再跑一次会先删旧的预览目录');
  const clean = cleanupPreview({ ledger: s.ledger, plan: s.plan });
  assert.equal(clean.removed.length, 1);
  assert.equal(existsSync(wt), false);
});

test('#79 SC3 --preview 有冲突：报出 PR 号和冲突文件、ok=false，预览目录恢复到干净状态', () => {
  const w = gitWorld({ conflict: true });
  const s = previewRun(w);
  const res = preview({ ledger: s.ledger, plan: s.plan, check: check(s) });
  assert.equal(res.ok, false);
  assert.deepEqual(res.repos[0].merged, [5]);
  assert.deepEqual(res.repos[0].conflict, { pr: 6, ref: B, files: ['a.txt'] });
  const wt = join(w.repo, '.worktrees', previewName(s.ledger));
  assert.equal(w.g(wt, 'status', '--porcelain'), '', 'merge --abort 之后是干净的');
  cleanupPreview({ ledger: s.ledger, plan: s.plan });
});

test('#79 SC2/SC3 CLI：检查不过 exit 2；--preview 结果写进 --out；--cleanup exit 0', () => {
  const w = gitWorld();
  const s = previewRun(w);
  writeFileSync(s.planPath, JSON.stringify(s.plan));
  writeFileSync(s.ledgerPath, JSON.stringify(s.ledger));
  const run = (...a) => spawnSync(process.execPath, [CLI, '--ledger', s.ledgerPath, '--gh-fixture', s.ghPath, '--now', NOW, ...a], { encoding: 'utf8' });
  const out = join(s.dir, 'root-check.json');
  let res = run('--preview', '--out', out);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).preview.repos[0].merged.length, 2);
  assert.equal(run('--cleanup').status, 0);
  s.fixture[`api repos/${REPO}/pulls/5`].draft = true;
  writeFileSync(s.ghPath, JSON.stringify(s.fixture));
  res = run();
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).ok, false);
});

test('#79 SC3 反例（review-pr82）：同一个仓有不同目标分支时各开一个预览目录，互不覆盖；--cleanup 都删掉', () => {
  const w = gitWorld();
  w.g(w.repo, 'push', '-q', 'origin', 'origin/main:refs/heads/release');
  const s = previewRun(w);
  s.plan.items.find((i) => i.ref === B).keel_run.base_ref = 'release';
  const res = preview({ ledger: s.ledger, plan: s.plan, check: check(s) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.repos.length, 2);
  const dirs = res.repos.map((r) => r.dir);
  assert.notEqual(dirs[0], dirs[1]);
  assert.ok(dirs.every((d) => existsSync(d)), '两个预览目录都在');
  assert.match(res.repos.find((r) => r.base === 'release').dir, new RegExp(`${previewName(s.ledger)}-release$`));
  assert.equal(cleanupPreview({ ledger: s.ledger, plan: s.plan }).removed.length, 2);
  assert.ok(dirs.every((d) => !existsSync(d)));
});

test('#79 SC3 反例（review-pr82）：检查之后 PR 又推了提交 → 预览不合旧提交，报 head_moved、ok=false', () => {
  const w = gitWorld();
  const s = previewRun(w);
  const checked = check(s);
  w.g(w.repo, 'checkout', '-q', 'feat/6');
  writeFileSync(join(w.repo, 'c.txt'), 'later\n');
  w.g(w.repo, 'add', '.');
  w.g(w.repo, ...w.id, 'commit', '-q', '-m', 'later');
  const later = w.g(w.repo, 'rev-parse', 'HEAD');
  w.g(w.repo, 'checkout', '-q', 'main');
  w.g(w.repo, 'push', '-q', '-f', 'origin', `${later}:refs/pull/6/head`);
  const res = preview({ ledger: s.ledger, plan: s.plan, check: checked });
  assert.equal(res.ok, false);
  assert.deepEqual(res.repos[0].merged, [5]);
  assert.deepEqual(res.repos[0].head_moved, { pr: 6, ref: B, checked: w.h6, now: later });
  cleanupPreview({ ledger: s.ledger, plan: s.plan });
});

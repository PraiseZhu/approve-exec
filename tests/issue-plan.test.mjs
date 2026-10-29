// issue-plan.mjs：读总 issue → 校验模板 → 分批 → keel_run 参数（PraiseZhu/approve-exec#68 SC1–SC4、SC8）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildPlan, readRoot, toKeelSc, toScope, parseDeps, expandBraces, parseHeader, splitSections, PlanError,
} from '../scripts/issue-plan.mjs';
import { REPO, childBody, issue, parentFixture, standaloneFixture, writeFixture, ghFrom } from './fixtures/issues/build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'scripts/issue-plan.mjs');

function plan(fixture, ref = `${REPO}#10`, extra = {}) {
  const { repoDir } = writeFixture({});
  const { root: r, children } = readRoot(ghFrom(fixture), ref);
  return buildPlan({ root: r, children, repoDirs: { [REPO]: repoDir }, lead: 'claude-code', entry: '批准执行 acme/app#10', now: '2026-10-29T08:00:00.000Z', ...extra });
}

function runCli(fixture, args = []) {
  const { dir, repoDir, ghPath } = writeFixture(fixture);
  const out = join(dir, 'plan.json');
  const res = spawnSync(process.execPath, [CLI, '--issue', `${REPO}#${args.includes('--standalone') ? 20 : 10}`,
    '--lead-agent', 'codex', '--repo-dir', `${REPO}=${repoDir}`, '--entry', '批准执行', '--out', out, '--gh-fixture', ghPath,
    ...args.filter((a) => a !== '--standalone')], { encoding: 'utf8' });
  return { ...res, out };
}

test('SC1 总 issue 分批：A、B、D 第 1 批，C 等 A 合入排第 2 批；「先合」只记合并顺序', () => {
  const p = plan(parentFixture());
  assert.deepEqual(p.waves, [[`${REPO}#11`, `${REPO}#12`, `${REPO}#14`], [`${REPO}#13`]]);
  const byRef = Object.fromEntries(p.items.map((i) => [i.ref, i]));
  assert.deepEqual(byRef[`${REPO}#13`].hard_deps, [`${REPO}#11`]);
  assert.equal(byRef[`${REPO}#13`].wave, 2);
  assert.deepEqual(byRef[`${REPO}#14`].hard_deps, []);
  assert.deepEqual(byRef[`${REPO}#14`].merge_after, [`${REPO}#11`]);
  assert.equal(p.root.kind, 'parent');
});

test('SC1 独立 issue：1 批 1 个', () => {
  const p = plan(standaloneFixture(), `${REPO}#20`);
  assert.equal(p.root.kind, 'single');
  assert.deepEqual(p.waves, [[`${REPO}#20`]]);
});

test('SC1 依赖成环拒绝', () => {
  const fx = parentFixture({ cBody: childBody({ deps: '等 #13 合进 main 再开工' }) });
  fx[`api repos/${REPO}/issues/10/sub_issues?per_page=100`][0].body = childBody({ deps: '等 #13 合进 main 再开工' });
  fx[`api repos/${REPO}/issues/10/sub_issues?per_page=100`][2].body = childBody({ deps: '等 #11 合进 main 再开工' });
  assert.throws(() => plan(fx), (e) => e instanceof PlanError && /依赖成环/.test(e.message));
});

test('SC1 依赖句判断不了时拒绝并给出原句', () => {
  assert.throws(() => parseDeps('参考 #11 的写法', REPO, `${REPO}#12`), /判断不了.*参考 #11 的写法/);
  assert.deepEqual(parseDeps('无，随时可开工', REPO, `${REPO}#12`), { hard: [], after: [] });
  assert.deepEqual(
    parseDeps('与 other/repo#5 并行开发（另一个仓）；other/repo#6 先进 main，本 issue 再合', REPO, `${REPO}#12`),
    { hard: [], after: ['other/repo#6'] },
  );
});

test('SC2 验证层映射：static/unit/contract/browser-fixture 进 sc，黑盒层单列 manual_scs', () => {
  const text = [
    '- [ ] SC1 a。验证：static',
    '- [ ] SC2 b。验证：unit（测试点：x）',
    '- [ ] SC3 c。验证：contract',
    '- [ ] SC4 d。验证：browser-fixture',
    '- [ ] SC5 e。验证：github-live',
    '- [ ] SC6 f。验证：cindy-mac',
    '- [ ] SC7 g。验证：cindy-windows',
    '- [ ] SC8 h。验证：paid',
  ].join('\n');
  const { sc, manual } = toKeelSc(text, 'x#1');
  assert.deepEqual(sc.map((s) => [s.id, s.min_level]), [
    ['SC1', 'type-check-only'], ['SC2', 'unit-test-verified'], ['SC3', 'unit-test-verified'], ['SC4', 'live-ui-verified'],
  ]);
  assert.deepEqual(manual.map((s) => [s.id, s.layer]), [['SC5', 'github-live'], ['SC6', 'cindy-mac'], ['SC7', 'cindy-windows'], ['SC8', 'paid']]);
  assert.ok(sc[1].text.startsWith('SC2 b。验证：unit'));
});

test('SC2 缺验证层或层名不认识时拒绝', () => {
  assert.throws(() => toKeelSc('- [ ] SC1 没写层', 'x#1'), /x#1 SC1 缺「验证：<层>」/);
  assert.throws(() => toKeelSc('- [ ] SC1 a。验证：e2e', 'x#1'), /验证层「e2e」不认识/);
});

test('SC3 范围：反引号路径原样成为 scope，花括号展开，非路径词忽略', () => {
  const scope = toScope([
    '- `scripts/issue-run.mjs`：新增 `checkpoint` 子命令',
    '- `scripts/lib/{a,b}.mjs`（新）',
    '- `tests/**/*.test.mjs`：相关测试',
  ].join('\n'), 'x#1');
  assert.deepEqual(scope, ['scripts/issue-run.mjs', 'scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'tests/**/*.test.mjs']);
  assert.deepEqual(expandBraces('a/{x,y}/{1,2}.md'), ['a/x/1.md', 'a/x/2.md', 'a/y/1.md', 'a/y/2.md']);
});

test('SC3 CLI：范围里有一行只写「相关测试」时退出码 2，stderr 写出 issue 号和原行', () => {
  const body = childBody({ scope: ['- `src/sync/status.ts`：读状态', '- 相关测试'] });
  const res = runCli(standaloneFixture(body), ['--standalone']);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /acme\/app#20 「范围」这一行没有反引号包住的文件路径或 glob.*- 相关测试/);
  assert.equal(existsSync(res.out), false, '拒绝时不得产出计划文件');
});

test('SC3 CLI：范围段没有任何列表项时退出码 2', () => {
  const res = runCli(standaloneFixture(childBody({ scope: ['看代码再定'] })), ['--standalone']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /「范围」段没有任何文件路径列表项/);
});

test('SC4 CLI：缺五个二级标题之一或没有 SC 行时退出码 2，不产出计划', () => {
  const noScope = childBody().replace('## 范围（可改）', '## 改哪里');
  let res = runCli(standaloneFixture(noScope), ['--standalone']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /缺「## 范围」段/);
  assert.equal(existsSync(res.out), false);
  const noSc = childBody({ scs: ['- [ ] 能用。验证：unit'] });
  res = runCli(standaloneFixture(noSc), ['--standalone']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /没有 SC<n> 编号项/);
});

test('SC4 CLI 成功：写出计划文件，stdout 摘要含批次', () => {
  const res = runCli(parentFixture());
  assert.equal(res.status, 0, res.stderr);
  const summary = JSON.parse(res.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.waves.length, 2);
  const p = JSON.parse(readFileSync(res.out, 'utf8'));
  assert.equal(p.schema, 'issue-plan-v1');
  assert.equal(p.lead_agent, 'codex');
});

test('keel_run 参数：goal / sc / scope / repo_dir / lead；目标分支不是 main 时带 base_ref', () => {
  const p = plan(parentFixture());
  const a = p.items.find((i) => i.ref === `${REPO}#11`);
  assert.deepEqual(Object.keys(a.keel_run), ['goal', 'sc', 'scope', 'repo_dir', 'lead']);
  assert.match(a.keel_run.goal, /^按 acme\/app#11「\[子1\/4\] 同步状态读取：从本地缓存读」完成：用户能在设置页看到同步状态。$/);
  assert.equal(a.keel_run.lead, 'claude-code');
  assert.deepEqual(a.keel_run.sc.map((s) => s.id), ['SC1', 'SC2', 'SC4']);
  assert.deepEqual(a.manual_scs.map((s) => s.id), ['SC3']);
  assert.equal(parseHeader(splitSections(childBody({ target: 'integration/canvas-s1' }))).base_ref, 'integration/canvas-s1');
  assert.equal(parseHeader(splitSections(childBody())).base_ref, null);
});

test('lead 只能是 claude-code / codex：Pi 拒绝并写明原因', () => {
  assert.throws(() => plan(parentFixture(), `${REPO}#10`, { lead: 'pi' }), /KEEL 不接受 Pi/);
});

test('SC8 授权原话：--authorization 优先，否则取入口消息原文；都没有就拒绝；source 记录来源', () => {
  assert.equal(plan(parentFixture(), `${REPO}#10`, { authorization: '用户 2026-10-29：批准执行 #10' }).authorization_source, '用户 2026-10-29：批准执行 #10');
  const p = plan(parentFixture());
  assert.equal(p.authorization_source, '批准执行 acme/app#10');
  assert.equal(p.source, 'chat');
  assert.equal(plan(parentFixture(), `${REPO}#10`, { source: 'script' }).source, 'script');
  assert.throws(() => plan(parentFixture(), `${REPO}#10`, { entry: undefined }), /缺授权原话/);
});

test('总 issue 没挂子 issue 时拒绝；已关闭的子 issue 标 closed', () => {
  const lonely = { [`api repos/${REPO}/issues/30`]: issue(30, '[总] 空', ''), [`api repos/${REPO}/issues/30/sub_issues?per_page=100`]: [] };
  assert.throws(() => plan(lonely, `${REPO}#30`), /是总 issue 却没有挂子 issue/);
  const fx = parentFixture();
  fx[`api repos/${REPO}/issues/10/sub_issues?per_page=100`][1].state = 'closed';
  assert.equal(plan(fx).items.find((i) => i.ref === `${REPO}#12`).closed, true);
});

test('SC3 反例（review-pr71）：冒号前那一格的无扩展名文件也收进 scope', () => {
  assert.deepEqual(toScope('- `Makefile`: build target', 'acme/app#20'), ['Makefile']);
  assert.deepEqual(toScope('- `Dockerfile`、`LICENSE`：镜像与许可证', 'acme/app#20'), ['Dockerfile', 'LICENSE']);
  assert.deepEqual(toScope('- `scripts/run-tests.mjs`：`TEST_FILES` 登记新测试', 'acme/app#20'), ['scripts/run-tests.mjs'], '冒号前已是文件格时，冒号后的标识符不当路径');
});

test('SC1 反例（review-pr71）：「与 #11 并行开发，等 #12 合进 main 后开工」只把 #12 算开工依赖', () => {
  assert.deepEqual(parseDeps('与 #11 并行开发，等 #12 合进 main 后开工', REPO, `${REPO}#13`), { hard: [`${REPO}#12`], after: [] });
  assert.deepEqual(parseDeps('等 #11 合进 main，再开工', REPO, `${REPO}#13`), { hard: [`${REPO}#11`], after: [] });
});

test('SC3 反例（review-pr71 第 2 轮）：没有冒号的说明行不把标识符当路径；整行只列文件时全收', () => {
  assert.throws(() => toScope('- adjust `checkpoint` before tests', 'acme/app#20'), /这一行没有反引号包住的文件路径/);
  assert.deepEqual(toScope('- `Makefile`', 'acme/app#20'), ['Makefile']);
  assert.deepEqual(toScope('- `scripts/a.mjs`（新）、`LICENSE`', 'acme/app#20'), ['scripts/a.mjs', 'LICENSE']);
  assert.deepEqual(toScope('- 顺手更新 `docs/x.md` 里的 `TEST_FILES` 说明', 'acme/app#20'), ['docs/x.md']);
});

test('SC1 反例（review-pr71 第 2 轮）：「不需要等 #11 合进 main，直接开工」不算依赖', () => {
  assert.deepEqual(parseDeps('不需要等 #11 合进 main，直接开工', REPO, `${REPO}#13`), { hard: [], after: [] });
  assert.deepEqual(parseDeps('无需等 #11 合入', REPO, `${REPO}#13`), { hard: [], after: [] });
});

test('SC3 反例（review-pr71 第 3 轮）：版本号不当路径', () => {
  assert.throws(() => toScope('- Compare `v1.0` with the deployed response', 'acme/app#20'), /这一行没有反引号包住的文件路径/);
  assert.deepEqual(toScope('- `src/a.ts`：升到 `v1.2.3`，类型见 `types/x.d.ts`', 'acme/app#20'), ['src/a.ts', 'types/x.d.ts']);
});

test('SC1 反例（review-pr71 第 3 轮）：括号里的否定只管括号里那一句', () => {
  assert.deepEqual(parseDeps('等 #11 合进 main 后开工（不需要等 #12 合入）', REPO, `${REPO}#13`), { hard: [`${REPO}#11`], after: [] });
});

test('SC1 回归（真实 #70 依赖原文）：括号里只是解释、提到同一 issue 也不拒绝', () => {
  assert.deepEqual(
    parseDeps('等 #69 合进 main 再开工（删的是 #69 之后才不再使用的东西；改同一批文件）', 'PraiseZhu/approve-exec', 'PraiseZhu/approve-exec#70'),
    { hard: ['PraiseZhu/approve-exec#69'], after: [] },
  );
  assert.throws(() => parseDeps('参考 #11 的写法（见 docs）', REPO, `${REPO}#13`), /判断不了.*参考 #11 的写法/, '括号外判断不了仍拒绝');
});

test('SC3 反例（review-pr71 第 4、5 轮）：说明句里只认带 / 或 * 的词；根目录文件写在冒号前那一格', () => {
  assert.deepEqual(toScope('- `archive.7z`：生成后更新', 'acme/app#20'), ['archive.7z'], '模板写法收根目录文件');
  assert.deepEqual(toScope('- `archive.7z`', 'acme/app#20'), ['archive.7z'], '整行只列文件也收');
  for (const prose of ['- Update `archive.7z` after generation', '- Compare `v1.0rc1` with deployed output', '- Bump to `1.2.3`']) {
    assert.throws(() => toScope(prose, 'acme/app#20'), /按模板写成/, `说明句不猜路径：${prose}`);
  }
  assert.deepEqual(toScope('- `src/a.ts`：升到 `v1.0rc1`，见 `docs/release.md`', 'acme/app#20'), ['src/a.ts', 'docs/release.md']);
});

test('SC1 反例（review-pr71 第 4 轮）：嵌套括号逐层拆，括号外的硬依赖不丢', () => {
  assert.deepEqual(parseDeps('等 #11 合进 main 后开工（不需要等 #12 合入（仅供参考））', REPO, `${REPO}#13`), { hard: [`${REPO}#11`], after: [] });
});

test('SC3 文件格：冒号前没有反引号时，冒号后的反引号内容是文件格（真实 #70 的「修改：`SKILL.md`、`README.md`」）', () => {
  assert.deepEqual(toScope('- 修改：`SKILL.md`（只留 issue 入口）、`README.md`、`config/defaults.json`', 'x#70'), ['SKILL.md', 'README.md', 'config/defaults.json']);
  assert.deepEqual(toScope('- `scripts/issue-watch.py`（新）：续跑脚本（`sessions.dispatch` 唤醒 lead）', 'x#69'), ['scripts/issue-watch.py'], '能力名不进 scope');
});

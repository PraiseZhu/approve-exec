// ready-check.mjs 出口门测试（sc-p1f / sc-p1g）：
//  - full 夹具（ready-full 复制 + __HEAD_SHA__ 占位替换）→ READY_FOR_SUBMIT_PR 含分支与 SHA，台账 phase→ready
//  - 七项各缺其一 → exit 2 且 GAP 列表恰含对应 gate（不短路，逐项独立）
//  - SHA 过期夹具分别构造在②③④⑤ → 各自点名
//  - detached HEAD / main 分支 → 点名 feature-branch
//  - 组合缺口 → 两项都点名（验证逐项独立不短路）
// 临时 git 仓库与夹具环境都建在 os.tmpdir()（mkdtemp），t.after 清理，不污染仓内工作树。
// 变异反证（sc-p1g）由文件末尾的 mutation-kill 测试编码完成：把 scripts/tests/config 复制到临时目录，
// 对副本应用变异（字符串替换，锚点唯一）→ 跑「跳过变异测试自身」的完整套件 → 断言失败集恰为预测集
// （挖红 + 隔离证明）。真实脚本永不被触碰，无需恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
// manifestCoreHash 直接 import（与 run-ledger 同一实现，manifest 篡改对照测试的 hash 基准）
import { manifestCoreHash } from '../scripts/run-ledger.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_CHECK = join(root, 'scripts/ready-check.mjs');
const RUN_LEDGER = join(root, 'scripts/run-ledger.mjs');
const FULL_FIXTURE = join(root, 'tests/fixtures/ready-full');
const FIXED_NOW = '2026-08-09T04:00:00.000Z';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// 建临时 git 候选仓：unborn HEAD 直接 symbolic-ref 到目标分支，避免依赖 init.defaultBranch
// symlinkAnchorOut: 把 evidence/anchors/a.txt 提交为指向仓外文件的 symlink（F-L 逃逸夹具）
function makeRepo(t, { branch = 'feat/fixture-branch', detached = false, dirty = false, symlinkAnchorOut = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-repo-'));
  run('git', ['init', '-q', dir]);
  run('git', ['config', 'user.email', 'fixture@test.local'], { cwd: dir });
  run('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
  run('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir });
  mkdirSync(join(dir, 'evidence/anchors'), { recursive: true });
  if (symlinkAnchorOut) {
    // 仓外文件放在临时根（repo 目录之外），symlink 目标用绝对路径，git 按 120000 模式入库
    const outside = join(dirname(dir), 'outside-anchor.txt');
    writeFileSync(outside, 'outside anchor\n');
    symlinkSync(outside, join(dir, 'evidence/anchors/a.txt'));
    t.after(() => rmSync(outside, { force: true }));
  } else {
    writeFileSync(join(dir, 'evidence/anchors/a.txt'), 'anchor a\n');
  }
  writeFileSync(join(dir, 'evidence/anchors/b.txt'), 'anchor b\n');
  writeFileSync(join(dir, 'evidence/anchors/c.txt'), 'anchor c\n');
  writeFileSync(join(dir, 'src.ts'), 'export const fixture = 1;\n');
  run('git', ['add', '-A'], { cwd: dir });
  const commit = run('git', ['commit', '-q', '-m', 'fixture initial commit'], { cwd: dir });
  assert.equal(commit.status, 0, `fixture repo 首提交失败: ${commit.stderr}`);
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout;
  assert.match(sha, /^[0-9a-f]{40}$/, 'fixture repo HEAD 应为 40 位十六进制');
  if (detached) {
    const detach = run('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: dir });
    assert.equal(detach.status, 0, `detach 失败: ${detach.stderr}`);
  }
  if (dirty) writeFileSync(join(dir, 'dirty.txt'), 'untracked\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sha };
}

// 复制 ready-full 夹具到临时环境，替换 __HEAD_SHA__ 占位，应用 mutate 后写回
function buildEnv(t, repo, mutate) {
  const envDir = mkdtempSync(join(tmpdir(), 'ready-env-'));
  cpSync(FULL_FIXTURE, envDir, { recursive: true });
  const files = {
    ledger: 'ledger.json',
    manifest: 'manifest.json',
    verdict: 'verdict.json',
    e2e: 'e2e-report.json',
    size: 'presubmit/size.json',
    format: 'presubmit/format.json',
    intent: 'presubmit/intent.json',
  };
  const parsed = {};
  for (const [key, rel] of Object.entries(files)) {
    const p = join(envDir, rel);
    const text = readFileSync(p, 'utf8').replaceAll('__HEAD_SHA__', repo.sha);
    parsed[key] = JSON.parse(text);
    writeFileSync(p, text);
  }
  if (mutate) mutate(parsed); // 就地修改（引用共享），随后全部写回
  for (const [key, rel] of Object.entries(files)) {
    const p = join(envDir, rel);
    writeFileSync(p, `${JSON.stringify(parsed[key], null, 2)}\n`);
  }
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  return {
    dir: envDir,
    ledgerPath: join(envDir, files.ledger),
    manifestPath: join(envDir, files.manifest),
    verdictPath: join(envDir, files.verdict),
    e2ePath: join(envDir, files.e2e),
    presubmitDir: join(envDir, 'presubmit'),
    parsed,
  };
}

function runReady(repo, env, { withNow = true, now = FIXED_NOW, withReceipt = true, receiptPath } = {}) {
  const args = [READY_CHECK, '--repo', repo.dir, '--ledger', env.ledgerPath, '--manifest', env.manifestPath,
    '--verdict', env.verdictPath, '--e2e-report', env.e2ePath, '--presubmit-dir', env.presubmitDir];
  if (withNow) args.push('--now', now);
  if (withReceipt) args.push('--receipt', receiptPath || join(env.dir, 'ready-receipt.json'));
  return run(process.execPath, args);
}

// 并发场景辅助：同时 spawn 多份 ready-check（spawnSync 是串行的，跑不出竞态）
function runReadyConcurrent(repo, env, count = 2) {
  const receiptPath = join(env.dir, 'ready-receipt.json');
  const args = [READY_CHECK, '--repo', repo.dir, '--ledger', env.ledgerPath, '--manifest', env.manifestPath,
    '--verdict', env.verdictPath, '--e2e-report', env.e2ePath, '--presubmit-dir', env.presubmitDir,
    '--now', FIXED_NOW, '--receipt', receiptPath];
  return Promise.all(Array.from({ length: count }, () => new Promise((resolvePromise) => {
    const p = spawn(process.execPath, [...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolvePromise({ status: code, stdout: stdout.trim(), stderr: stderr.trim() }));
  })));
}

function gapGates(stderr) {
  return stderr.split('\n').filter((l) => l.startsWith('GAP: ')).map((l) => l.replace(/^GAP: /, '').split(':')[0]);
}

// 断言 exit 2 且 GAP gate 集合恰等于 expected（无多余无遗漏）
function expectGaps(res, expected, msg = '') {
  assert.equal(res.status, 2, `期望 exit 2（${msg}），实际 ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const actual = gapGates(res.stderr).sort();
  const want = [...expected].sort();
  assert.deepEqual(actual, want, `gap 集合不匹配（${msg}）: got ${actual.join(',')} want ${want.join(',')}\nstderr:\n${res.stderr}`);
  assert.equal(res.stdout, '', `gap 态不应输出 READY 行（${msg}）: ${res.stdout}`);
}


test('gap1: 台账缺组（组数 < manifest packets）→ exit 2 gap ledger-partition', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves = p.ledger.waves.filter((w) => w.wave !== 2); // 删掉 g2 所在波
    p.ledger.events = p.ledger.events.filter((e) => e.detail?.group_id !== 'g2');
    return p;
  });
  // ① 组数对账点名 ledger-partition；F-M 台账侧对账（组 sc_ids 不再覆盖全部 SC）追加 verdict-anchors——
  // 同一破损状态的两个真实缺口，都点名
  expectGaps(runReady(repo, env), ['ledger-partition', 'verdict-anchors'], '台账缺组');
});

test('gap1: 组非 verified → exit 2 gap ledger-partition', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves[1].groups[0].state = 'delivered';
    return p;
  });
  expectGaps(runReady(repo, env), ['ledger-partition'], '组 state=delivered');
});

test('gap1: 组 tip_sha 与 delivery 事件对账失败 → exit 2 gap ledger-partition', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    const ev = p.ledger.events.find((e) => e.type === 'delivery' && e.detail?.group_id === 'g1');
    ev.detail.tip_sha = 'a'.repeat(40);
    return p;
  });
  expectGaps(runReady(repo, env), ['ledger-partition'], 'delivery tip_sha 对账失败');
});

test('gap1: 零工作运行（台账/manifest 全空）→ exit 2 gap ledger-partition（拒绝空洞 READY）', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves = [];
    p.ledger.events = [];
    p.manifest.scs = [];
    p.manifest.waves = [];
    p.manifest.dispatch.packets = [];
    return p;
  });
  // F-M 后 manifest.scs=[] 也会被 ② 的 fail-closed 校验点名（与 ① 零组守卫同一类的第二条防线）
  expectGaps(runReady(repo, env), ['ledger-partition', 'verdict-anchors'], '零工作运行，三条对账空洞通过，必须被零组守卫 + scs 空集校验拦下');
});

test('F-N: dispatch 事件 group_id 换成未知 gX（数量仍为 2）→ exit 2 gap ledger-partition', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    // gpt 审查席实测：只改 dispatch 事件组名，两侧去重数量不变——旧实现只看数量会放行「g2 从未被派出」
    const ev = p.ledger.events.find((e) => e.type === 'dispatch' && e.detail?.group_id === 'g2');
    ev.detail.group_id = 'gX';
    return p;
  });
  expectGaps(runReady(repo, env), ['ledger-partition'], 'dispatch 组名与台账不符必须点名');
});

test('F-N: manifest packet group_id 换成未知 gX → exit 2 gap ledger-partition', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.manifest.dispatch.packets[1].group_id = 'gX';
    return p;
  });
  expectGaps(runReady(repo, env), ['ledger-partition'], 'packet 组名与台账不符必须点名');
});

test('gap2: verdict candidate_sha 过期 → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.verdict.candidate_sha = 'a'.repeat(40); // SHA 过期夹具（②）
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], 'verdict SHA 过期');
});

test('gap2: verdict 缺 SC → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.verdict.scs = p.verdict.scs.filter((s) => s.sc_id !== 'sc-p1f');
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], 'verdict 缺 sc-p1f');
});

test('gap2: 证据锚点指向不存在文件 → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    // 假锚点：verdict 声称该文件存在输出记录（output_records 有 key），但文件真实不存在。
    // 变异③（锚点内容校验回退为字符串非空）会让本用例误 READY——这是它要防的假锚点形态。
    p.verdict.scs[1].evidence[0].file = 'evidence/anchors/missing.txt';
    p.verdict.output_records['evidence/anchors/missing.txt'] = 'ready-check.test.mjs all pass';
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], '锚点文件不存在');
});

test('gap2: evidence 输出摘要与 verdict 内嵌 output_records 不一致 → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.verdict.scs[0].evidence[0].summary = 'bogus summary'; // 非空但内容不一致
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], 'summary 与内嵌记录不一致');
});

test('F-L: 证据锚点以 symlink 指向仓外 → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t, { symlinkAnchorOut: true });
  const env = buildEnv(t, repo, null);
  // 词法 resolve 只看路径字符串会放行（existsSync 跟随链接返回 true），realpath 后才能发现真实文件在仓外
  expectGaps(runReady(repo, env), ['verdict-anchors'], '锚点 symlink 越出候选仓必须点名');
});

test('F-M: manifest.scs 为空数组（其余凭据全有效）→ exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.manifest.scs = [];
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], 'scs 空全集会让 ② 遍历零次、空洞放行');
});

test('F-M: manifest.scs 含重复 id → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    // sc-p0a 重复出现一次，但集合覆盖全部三个原 id——重复校验必须独立拦下（对账看不出来）
    p.manifest.scs = [
      { id: 'sc-p0a', kind: 'fix', priority_id: 'p0' },
      { id: 'sc-p0a', kind: 'fix', priority_id: 'p0' },
      { id: 'sc-p1f', kind: 'fix', priority_id: 'p1' },
      { id: 'sc-p1g', kind: 'fix', priority_id: 'p1' },
    ];
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], 'scs 重复 id 必须点名');
});

test('F-M: dispatch packets scs_inline 与 manifest.scs 不一致 → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.manifest.dispatch.packets[1].scs_inline = [{ id: 'sc-p1f' }, { id: 'sc-ghost' }];
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], 'packet scs 集合与 manifest.scs 不一致必须点名');
});

test('F-M: 台账组 sc_ids 与 manifest.scs 不一致 → exit 2 gap verdict-anchors', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves[1].groups[0].sc_ids = ['sc-p1f', 'sc-ghost'];
    return p;
  });
  expectGaps(runReady(repo, env), ['verdict-anchors'], '台账组 sc_ids 与 manifest.scs 不一致必须点名');
});

test('gap3: review.rounds 超上限（4 > reviewMaxRounds）→ exit 2 gap review-clean', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves[1].groups[0].review.rounds = 4;
    return p;
  });
  expectGaps(runReady(repo, env), ['review-clean'], 'rounds 超限');
});

test('gap3: review.unresolved>0 → exit 2 gap review-clean', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves[0].groups[0].review.unresolved = 1;
    return p;
  });
  expectGaps(runReady(repo, env), ['review-clean'], 'unresolved=1');
});

test('gap3: 审查交卷（delivery 入账）candidate_sha 过期 → exit 2 gap review-clean', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    const ev = p.ledger.events.find((e) => e.type === 'delivery' && e.detail?.group_id === 'g1');
    ev.detail.candidate_sha = 'a'.repeat(40); // SHA 过期夹具（③）
    return p;
  });
  expectGaps(runReady(repo, env), ['review-clean'], '审查交卷绑定 SHA 过期');
});

test('gap4: e2e 报告缺失 → exit 2 gap e2e-report', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  rmSync(env.e2ePath, { force: true });
  expectGaps(runReady(repo, env), ['e2e-report'], 'e2e 报告缺失');
});

test('F-O: ledger+e2e 都删 → 三项 gap 同时点名（不跳过后项）', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  rmSync(env.ledgerPath, { force: true });
  rmSync(env.e2ePath, { force: true });
  // gpt 审查席实测：旧实现 ledger 不可解析提前 exit，e2e-report/presubmit/git/branch 全没检查
  expectGaps(runReady(repo, env), ['ledger-partition', 'review-clean', 'e2e-report'], 'ledger 缺失不得短路后项');
});

test('F-O: manifest+verdict 都删 → ledger-partition + verdict-anchors 双 gate 点名', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  rmSync(env.manifestPath, { force: true });
  rmSync(env.verdictPath, { force: true });
  // ① 依赖 manifest 点名 ledger-partition；② 依赖 manifest+verdict 各点名一次 verdict-anchors
  expectGaps(runReady(repo, env), ['ledger-partition', 'verdict-anchors', 'verdict-anchors'], 'manifest 缺失不得短路后项');
});

test('gap4: e2e 报告 status=fail → exit 2 gap e2e-report', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.e2e.status = 'fail';
    return p;
  });
  expectGaps(runReady(repo, env), ['e2e-report'], 'e2e status=fail');
});

test('gap4: e2e 报告 candidate_sha 过期 → exit 2 gap e2e-report', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.e2e.candidate_sha = 'a'.repeat(40); // SHA 过期夹具（④）
    return p;
  });
  expectGaps(runReady(repo, env), ['e2e-report'], 'e2e SHA 过期');
});

test('gap5: presubmit 三闸结果缺失（intent.json）→ exit 2 gap presubmit-gates', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  rmSync(join(env.presubmitDir, 'intent.json'), { force: true });
  expectGaps(runReady(repo, env), ['presubmit-gates'], 'intent.json 缺失');
});

test('gap5: size 闸 result=STOP → exit 2 gap presubmit-gates', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.size.result = 'STOP';
    return p;
  });
  expectGaps(runReady(repo, env), ['presubmit-gates'], 'size STOP');
});

test('gap5: presubmit 三闸各自绑定 SHA 过期 → exit 2 gap presubmit-gates', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.size.candidate_sha = 'a'.repeat(40); // SHA 过期夹具（⑤，变异①预测红集）
    return p;
  });
  expectGaps(runReady(repo, env), ['presubmit-gates'], 'presubmit SHA 过期');
});

test('gap6: 候选仓 git status 不干净 → exit 2 gap git-clean', (t) => {
  const repo = makeRepo(t, { dirty: true });
  const env = buildEnv(t, repo, null);
  expectGaps(runReady(repo, env), ['git-clean'], '工作树脏');
});

test('gap7: detached HEAD → exit 2 gap feature-branch', (t) => {
  const repo = makeRepo(t, { detached: true });
  const env = buildEnv(t, repo, null);
  expectGaps(runReady(repo, env), ['feature-branch'], 'detached HEAD');
});

test('gap7: HEAD 在 main 分支 → exit 2 gap feature-branch', (t) => {
  const repo = makeRepo(t, { branch: 'main' });
  const env = buildEnv(t, repo, null);
  expectGaps(runReady(repo, env), ['feature-branch'], 'main 分支');
});

test('组合缺口: e2e 缺失 + main 分支 → exit 2 且两项都点名（不短路）', (t) => {
  const repo = makeRepo(t, { branch: 'main' });
  const env = buildEnv(t, repo, null);
  rmSync(env.e2ePath, { force: true });
  expectGaps(runReady(repo, env), ['e2e-report', 'feature-branch'], '组合缺口逐项独立');
});

test('full 但未传 --now: 门全过但拒绝写 receipt → exit 2 gap ready-receipt，台账不被驱动', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env, { withNow: false });
  expectGaps(res, ['ready-receipt'], '无 --now 拒绝写 receipt（checked_at 需注入）');
  const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(written.phase, 'validating', '台账 phase 必须保持原状');
  assert.equal(written.version, 3, '台账 version 必须保持原状');
});

test('bad-now: --now 非 ISO 时间戳 → exit 2，台账不被驱动（fail-closed 不写坏账）', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env, { now: 'not-an-iso' });
  assert.equal(res.status, 2, `期望 exit 2\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /--now 必须是 ISO 时间戳/, '错误信息应点名非法 --now');
  assert.equal(res.stdout, '', '非法 --now 不应输出 READY 行');
  const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(written.phase, 'validating', '非法 --now 不得驱动台账 phase');
  assert.equal(written.version, 3, '非法 --now 不得递增台账 version');
});

test('full 但未传 --receipt: 门全过但拒绝输出 READY → exit 2 gap ready-receipt，台账不被驱动', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env, { withReceipt: false });
  expectGaps(res, ['ready-receipt'], '无 --receipt 拒绝输出 READY（→ready 凭据需 ready-check 写入 receipt）');
  const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(written.phase, 'validating', '无 --receipt 时台账 phase 必须保持原状（不驱动）');
  assert.equal(written.version, 3, '无 --receipt 时台账 version 必须保持原状');
});

test('receipt 写盘失败: --receipt 指向不存在目录 → exit 2 gap ready-receipt，不输出 READY 行', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env, { receiptPath: join(env.dir, 'no-such-dir', 'ready-receipt.json') });
  assert.equal(res.status, 2, `receipt 写失败必须 exit 2\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /GAP: ready-receipt/, '写失败必须点名 ready-receipt');
  assert.match(res.stderr, /receipt 写入失败/, '写失败必须点名具体原因');
  assert.equal(res.stdout, '', 'receipt 未落盘时不得输出 READY 行');
});

// ---------- receipt 闭环（F-F 对端）：ready-check 铸 receipt → run-ledger set-state 消费 → ready ----------
// 消费侧契约（run-ledger READY_RECEIPT_KEYS）：ledger_version 必须 == 消费时台账 version（检查后
// 任何写操作使 receipt 失效，防重放）+ candidate_sha == 台账当前最新集成 tip。
// ready-check 的 ready-full 夹具 phase=validating、无 integrated_tip，直接给它消费会撞
// phaseTransitionAllowed（validating→ready 非法跳步）与「集成树=null」——闭环用「同款台账推进到
// packaging 且全波集成」的副本消费：receipt.ledger_version=3（检查时读到的 version，非 +1）
// 与副本 version=3 绑定，语义一致。phase_at 被显式剥掉：副本从未发生过 ready 转换，
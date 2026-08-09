// ready-check.mjs 出口门测试（sc-p1f / sc-p1g）：
//  - full 夹具（ready-full 复制 + __HEAD_SHA__ 占位替换）→ READY_FOR_SUBMIT_PR 含分支与 SHA，台账 phase→ready
//  - 七项各缺其一 → exit 2 且 GAP 列表恰含对应 gate（不短路，逐项独立）
//  - SHA 过期夹具分别构造在②③④⑤ → 各自点名
//  - detached HEAD / main 分支 → 点名 feature-branch
//  - 组合缺口 → 两项都点名（验证逐项独立不短路）
// 临时 git 仓库与夹具环境都建在 os.tmpdir()（mkdtemp），t.after 清理，不污染仓内工作树。
// 变异反证（sc-p1g）由脚本级操作完成：cp 备份 → sed 挖变异点 → 跑全量 → 收集失败标题 → 恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_CHECK = join(root, 'scripts/ready-check.mjs');
const FULL_FIXTURE = join(root, 'tests/fixtures/ready-full');
const FIXED_NOW = '2026-08-09T04:00:00.000Z';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// 建临时 git 候选仓：unborn HEAD 直接 symbolic-ref 到目标分支，避免依赖 init.defaultBranch
function makeRepo(t, { branch = 'feat/fixture-branch', detached = false, dirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-repo-'));
  run('git', ['init', '-q', dir]);
  run('git', ['config', 'user.email', 'fixture@test.local'], { cwd: dir });
  run('git', ['config', 'user.name', 'Fixture'], { cwd: dir });
  run('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir });
  mkdirSync(join(dir, 'evidence/anchors'), { recursive: true });
  writeFileSync(join(dir, 'evidence/anchors/a.txt'), 'anchor a\n');
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

function runReady(repo, env, { withNow = true } = {}) {
  const args = [READY_CHECK, '--repo', repo.dir, '--ledger', env.ledgerPath, '--manifest', env.manifestPath,
    '--verdict', env.verdictPath, '--e2e-report', env.e2ePath, '--presubmit-dir', env.presubmitDir];
  if (withNow) args.push('--now', FIXED_NOW);
  return run(process.execPath, args);
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

test('full: 七项全齐 → READY_FOR_SUBMIT_PR 含分支与 SHA，台账 phase→ready 且 version+1', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env);
  assert.equal(res.status, 0, `期望 exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.equal(res.stdout, `READY_FOR_SUBMIT_PR feat/fixture-branch ${repo.sha}`, 'READY 行必须单行含分支与 HEAD SHA');
  const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(written.phase, 'ready', '台账 phase 应被驱动为 ready');
  assert.equal(written.version, 4, '台账 version 应 +1（3→4，CAS 乐观锁）');
  assert.equal(written.phase_at, FIXED_NOW, 'phase_at 应使用 --now 注入的时间戳');
});

test('gap1: 台账缺组（组数 < manifest packets）→ exit 2 gap ledger-partition', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    p.ledger.waves = p.ledger.waves.filter((w) => w.wave !== 2); // 删掉 g2 所在波
    p.ledger.events = p.ledger.events.filter((e) => e.detail?.group_id !== 'g2');
    return p;
  });
  expectGaps(runReady(repo, env), ['ledger-partition'], '台账缺组');
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

test('full 但未传 --now: 门全过但拒绝驱动台账 → exit 2 gap ledger-write-conflict', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env, { withNow: false });
  expectGaps(res, ['ledger-write-conflict'], '无 --now 拒绝写台账');
  const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(written.phase, 'validating', '未驱动时台账 phase 必须保持原状');
  assert.equal(written.version, 3, '未驱动时台账 version 必须保持原状');
});

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
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
// manifestCoreHash 直接 import（与 run-ledger 同一实现，manifest 篡改对照测试的 hash 基准）
import { manifestCoreHash } from '../scripts/run-ledger.mjs';
// buildChildEnv：变异子套件自起子进程，git 隔离必须同一份实现（run-tests.mjs 是唯一权威）。
// 子套件在复制树里跑（makeRepo 的 git commit），缺隔离会继承机器全局 commit.gpgsign=true，
// 负载下 gpg 失败让夹具 commit 红——失败集比对随之漂移。
import { buildChildEnv } from '../scripts/run-tests.mjs';

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
// 每个 git 调用都断言 status===0（fail-fast）：fixture 构造失败必须显式红并点名失败步骤，
// 绝不允许「构造失败但测试继续跑并通过」的静默降级——git add 静默失败曾让 symlink 未入库，
// F-L 测试读到「无锚点」走另一条路径仍通过，导致变异④假绿（守卫看起来有效实则失效）。
function makeRepo(t, { branch = 'feat/fixture-branch', detached = false, dirty = false, symlinkAnchorOut = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-repo-'));
  const gitRun = (args, label) => {
    // buildChildEnv：裸跑（非权威入口）时 makeRepo 的 git commit 同样必须隔离——缺它会继承
    // 机器全局 commit.gpgsign=true，负载下 gpg 失败让夹具 commit 红。同一份实现，不拷。
    const r = run('git', args, { cwd: dir, env: buildChildEnv(process.env) });
    assert.equal(r.status, 0, `fixture ${label} 失败: ${r.stderr}`);
    return r;
  };
  gitRun(['init', '-q', dir], 'git init');
  gitRun(['config', 'user.email', 'fixture@test.local'], 'git config user.email');
  gitRun(['config', 'user.name', 'Fixture'], 'git config user.name');
  gitRun(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], 'git symbolic-ref');
  mkdirSync(join(dir, 'evidence/anchors'), { recursive: true });
  if (symlinkAnchorOut) {
    // 仓外文件放在临时根（repo 目录之外），symlink 目标用绝对路径，git 按 120000 模式入库。
    // 文件名派生自 mkdtemp 唯一 basename：并发 fixture 各持独立文件，t.after 只删自己的，
    // 结构性排除共享固定路径竞态（旧版恒为 <tmp>/outside-anchor.txt，并发进程互删）。
    const outside = join(dirname(dir), `outside-anchor-${basename(dir)}.txt`);
    writeFileSync(outside, 'outside anchor\n');
    symlinkSync(outside, join(dir, 'evidence/anchors/a.txt'));
    t.after(() => rmSync(outside, { force: true }));
  } else {
    writeFileSync(join(dir, 'evidence/anchors/a.txt'), 'anchor a\n');
  }
  writeFileSync(join(dir, 'evidence/anchors/b.txt'), 'anchor b\n');
  writeFileSync(join(dir, 'evidence/anchors/c.txt'), 'anchor c\n');
  writeFileSync(join(dir, 'src.ts'), 'export const fixture = 1;\n');
  gitRun(['add', '-A'], 'git add -A');
  gitRun(['commit', '-q', '-m', 'fixture initial commit'], 'git commit');
  const sha = gitRun(['rev-parse', 'HEAD'], 'git rev-parse HEAD').stdout;
  assert.match(sha, /^[0-9a-f]{40}$/, 'fixture repo HEAD 应为 40 位十六进制');
  if (detached) gitRun(['checkout', '-q', '--detach', 'HEAD'], 'detach');
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
  // 与 cwd 解耦：夹具 ledger.json 的 manifest_path / verify.evidence_ref 是相对 cwd 的
  // （"tests/fixtures/ready-full/…"，从仓根跑才成立；cwd 一漂即 ENOENT 假红，已两轮
  // 实测付费）。复制后重写为 envDir 内绝对路径——链尾 run-ledger validate 按台账
  // manifest_path 解析，从此不再依赖调用方 cwd。断言不读这两字段的相对值（manifest
  // 篡改基线的 manifest_path 本就是绝对写法），重写不影响任何断言语义。
  parsed.ledger.manifest_path = join(envDir, files.manifest);
  for (const w of parsed.ledger.waves ?? []) {
    for (const g of w.groups ?? []) {
      if (g.verify && typeof g.verify.evidence_ref === 'string') {
        g.verify.evidence_ref = join(envDir, files.verdict);
      }
    }
  }
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

test('full: 七项全齐 → READY_FOR_SUBMIT_PR 含分支与 SHA，receipt 原子落盘（ledger_version=检查时 version），台账不被驱动', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const res = runReady(repo, env);
  assert.equal(res.status, 0, `期望 exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.equal(res.stdout, `READY_FOR_SUBMIT_PR feat/fixture-branch ${repo.sha}`, 'READY 行必须单行含分支与 HEAD SHA');
  // ready-check 只检查不写台账：台账必须原样（phase=validating、version=3、无 phase_at）
  const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  assert.equal(written.phase, 'validating', 'ready-check 不得驱动台账 phase（写入权在 run-ledger set-state）');
  assert.equal(written.version, 3, 'ready-check 不得递增台账 version');
  assert.equal(written.phase_at, undefined, 'ready-check 不得写 phase_at（phase→ready 由 run-ledger 驱动时写入）');
  // 台账仍是 run-ledger exact schema 合法形状
  const v = run(process.execPath, [RUN_LEDGER, 'validate', env.ledgerPath]);
  assert.equal(v.status, 0, `台账必须过 run-ledger validate: ${v.stderr}`);
  // →ready receipt（READY_RECEIPT_KEYS 消费契约）：exact 三键、candidate_sha=HEAD、
  // ledger_version=检查时读到的 version（非 +1）、checked_at=注入时间戳
  const receipt = JSON.parse(readFileSync(join(env.dir, 'ready-receipt.json'), 'utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['candidate_sha', 'checked_at', 'ledger_version'], 'receipt 必须 exact 三键（未知键拒）');
  assert.equal(receipt.candidate_sha, repo.sha, 'receipt.candidate_sha 必须 = 候选仓 HEAD');
  assert.equal(receipt.ledger_version, 3, 'receipt.ledger_version 必须 = 检查时读到的台账 version（非 +1）');
  assert.equal(receipt.checked_at, FIXED_NOW, 'receipt.checked_at 必须 = --now 注入的时间戳');
});

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
    // g1 有 exec/review/verify 多条 delivery（夹具已按真实落盘形状对齐）：任一条 tip_sha
    // 与台账 tip_sha 相符都会让 ① 对账通过，故必须把 g1 全部 delivery 的 tip_sha 一起变异
    for (const e of p.ledger.events) {
      if (e.type === 'delivery' && e.detail?.group_id === 'g1') e.detail.tip_sha = 'a'.repeat(40);
    }
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

test('gap3: 审查交卷（review 类 delivery）candidate_sha 过期（verify 绑当前 SHA 不顶替）→ exit 2 gap review-clean', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    // 缺陷组合：review 交卷（delivered 时入账）绑过期 SHA；verify 交卷（review_pass 时入账、
    // 排在最后一条）绑当前 HEAD。旧实现取「最后一条交卷」= verify → 放行；修复后必须按
    // review 类交卷取，点名 review 实际绑定的旧 SHA。夹具 g1 已含 verify 交卷（绑当前 HEAD）。
    const ev = p.ledger.events.find((e) => e.type === 'delivery' && e.detail?.group_id === 'g1'
      && typeof e.detail?.rounds === 'number');
    assert.ok(ev, '夹具 g1 必须存在 review 类 delivery 事件');
    ev.detail.candidate_sha = 'a'.repeat(40); // SHA 过期夹具（③）
    return p;
  });
  expectGaps(runReady(repo, env), ['review-clean'], '审查交卷绑定 SHA 过期');
});

test('gap3: 组无 review 类交卷（仅 exec+verify delivery）→ exit 2 gap review-clean 且点名类别序列', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => {
    // D2 fail-closed：组没有 review 类交卷时不得回落到「最后一条」或「视为通过」——
    // 否则 exec/verify 交卷会冒充审查绑定。消息必须带组名与实际类别序列。
    p.ledger.events = p.ledger.events.filter((e) => !(e.type === 'delivery' && e.detail?.group_id === 'g1'
      && typeof e.detail?.rounds === 'number'));
    return p;
  });
  const res = runReady(repo, env);
  expectGaps(res, ['review-clean'], '无 review 类交卷必须 fail-closed');
  assert.match(res.stderr, /g1 无 review 类交卷/, '必须点名组名');
  assert.match(res.stderr, /exec, verify/, '必须点名实际 delivery 类别序列');
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

// receipts 在场契约（缺陷 #2 出口门侧回归守卫）：receipts 被 core hash 黑名单剔除，删它 hash 不变——
// 出口门不能只靠 hash 兜底。ready-check 消费 manifest 必须走与 run-ledger 同一份判据（readManifest），
// 不合约的 manifest（含删 receipts）转 gap 点名，不得输出 READY。
test('receipts 在场契约: 全量凭据下删 manifest.receipts 键 → exit 2 gap ledger-partition+verdict-anchors，gap 点名 receipts（出口门同判据）', (t) => {
  if (process.env.RC_MUTATION_CHILD === '1') { t.skip('变异子套件运行跳过本用例（与 ready-check 既有变异无关，防污染其失败集契约）'); return; }
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, (p) => { delete p.manifest.receipts; });
  const res = runReady(repo, env);
  expectGaps(res, ['ledger-partition', 'verdict-anchors'], '删 receipts 键必须被拒（receipts 在场契约收口于 readManifest，ready-check 同判据）');
  assert.match(res.stderr, /receipts/, 'gap 必须点名 receipts（可解析但不合约，不得笼统说「不可解析」）');
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
// 不应携带 ready 时点（消费成功时 run-ledger 会新写）。
function buildConsumableLedger(env, repo) {
  const base = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  const { phase_at: _drop, ...clean } = base;
  return {
    ...clean,
    version: 3,
    phase: 'packaging',
    waves: base.waves.map((w) => ({ ...w, integrated_tip: repo.sha })),
  };
}

test('闭环: ready-check 写出 receipt → run-ledger set-state --ready-receipt 消费 → exit 0 成功到 ready', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const receiptPath = join(env.dir, 'ready-receipt.json');
  const res = runReady(repo, env, { receiptPath });
  assert.equal(res.status, 0, `ready-check 必须 exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.deepEqual(Object.keys(receipt).sort(), ['candidate_sha', 'checked_at', 'ledger_version'], 'receipt 必须 exact 三键');

  // 消费：packaging 副本 + 同 version → 合法 receipt 驱动到 ready
  const ledgerB = join(env.dir, 'ledger-consumable.json');
  writeFileSync(ledgerB, `${JSON.stringify(buildConsumableLedger(env, repo), null, 2)}\n`);
  const r = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--phase', 'ready',
    '--ready-receipt', receiptPath, '--now', FIXED_NOW]);
  assert.equal(r.status, 0, `合法 receipt 消费必须 exit 0: ${r.stderr}`);
  const consumed = JSON.parse(readFileSync(ledgerB, 'utf8'));
  assert.equal(consumed.phase, 'ready', '消费成功后台账 phase 必须 = ready');
  assert.equal(consumed.phase_at, FIXED_NOW, '消费成功必须写 phase_at（F2 契约）');
});

test('闭环反例 A: 铸 receipt 后对台账做一次写操作（version+1）→ run-ledger 拒并点名版本不匹配（防重放）', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const receiptPath = join(env.dir, 'ready-receipt.json');
  const res = runReady(repo, env, { receiptPath });
  assert.equal(res.status, 0, `ready-check 必须 exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const ledgerB = join(env.dir, 'ledger-consumable.json');
  // 反例 A 专用副本：packaging + version=3（与 receipt 绑定），waves 保持未集成——
  // 新 main 生命周期门下 verified 组身份写/record-delivery 全拒，wave 集成是该形状
  // 唯一仍可执行的 version+1 合法写（全组 verified 前置满足）。版本检查先于候选树
  // 检查触发，拒绝理由仍是版本不匹配（与闭环正例的集成树语义互不影响）。
  const base = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  const { phase_at: _drop, ...clean } = base;
  writeFileSync(ledgerB, `${JSON.stringify({ ...clean, version: 3, phase: 'packaging' }, null, 2)}\n`);
  // 写 receipt 后对台账做一次写操作：wave 1 集成（receipt.ledger_version(3) ≠ 消费时 version(4) → 拒）
  const bump = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--wave', '1',
    '--integrate', repo.sha, '--now', FIXED_NOW]);
  assert.equal(bump.status, 0, `预置写操作必须成功: ${bump.stderr}`);
  const r = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--phase', 'ready',
    '--ready-receipt', receiptPath, '--now', FIXED_NOW]);
  assert.equal(r.status, 2, '过期 receipt（检查后发生过写操作）必须 exit 2');
  assert.match(r.stderr, /版本不匹配|ledger_version/, '必须点名版本不匹配（防重放）');
  const ledger = JSON.parse(readFileSync(ledgerB, 'utf8'));
  assert.equal(ledger.phase, 'packaging', '被拒后 phase 必须保持原状');
  assert.ok(ledger.events.some((e) => e.type === 'illegal_transition'), '非法尝试必须落 illegal_transition 事件');
});

test('闭环反例 B: receipt.candidate_sha 与台账集成树不符 → run-ledger 拒并点名（伪造拒）', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const receiptPath = join(env.dir, 'ready-receipt.json');
  const res = runReady(repo, env, { receiptPath });
  assert.equal(res.status, 0, `ready-check 必须 exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const ledgerB = join(env.dir, 'ledger-consumable.json');
  writeFileSync(ledgerB, `${JSON.stringify(buildConsumableLedger(env, repo), null, 2)}\n`);
  // 改 receipt 的 candidate_sha（形状仍合法 40hex）→ 与台账当前集成树不符 → 拒
  const forged = join(env.dir, 'ready-receipt-forged.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(forged, `${JSON.stringify({ ...receipt, candidate_sha: 'b'.repeat(40) }, null, 2)}\n`);
  const r = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--phase', 'ready',
    '--ready-receipt', forged, '--now', FIXED_NOW]);
  assert.equal(r.status, 2, 'candidate_sha 与集成树不符必须 exit 2（伪造拒）');
  assert.match(r.stderr, /candidate_sha|集成树/, '必须点名 candidate_sha 与集成树不一致');
});

// ---------- 并发实证（缺陷①回归守卫）：ready-check 不写台账，并发双跑无写竞争 ----------
// 每轮用全新夹具副本（version=3 起点），双进程经 spawn 并发启动（spawnSync 串行跑不出竞态）。
// ready-check 只写 receipt（唯一 tmp + rename 原子，内容同源同值，无半写）不改台账——
// 双进程都 exit 0 都输出 READY，台账 version 全程不变。phase→ready 的唯一写入者
// run-ledger set-state 对 receipt 消费：同一 receipt 驱动恰 1 次成功（第二次必拒）。
// 轮数：正常跑 30 轮（≥ 验收口径）；变异子套件（RC_MUTATION_CHILD=1）降至 8 轮——
// 套件并发风暴下 30 轮 × 9 变异副本会让子套件重载失稳（实测全量并行跑时变异子套件输出被截断）。
test('并发: 同台账双进程同时跑 ready-check → 双 READY、台账 version 全程不变，receipt 驱动恰 1 成功（30 轮）', async (t) => {
  const repo = makeRepo(t);
  const ROUNDS = process.env.RC_MUTATION_CHILD === '1' ? 8 : 30;
  for (let i = 0; i < ROUNDS; i += 1) {
    const env = buildEnv(t, repo, null); // 每轮独立夹具副本（version=3 起点）
    const [a, b] = await runReadyConcurrent(repo, env);
    for (const r of [a, b]) {
      assert.equal(r.status, 0, `轮 ${i + 1}: ready-check 必须 exit 0（无写竞争）\n${r.stderr}`);
      assert.match(r.stdout, new RegExp(`^READY_FOR_SUBMIT_PR feat/fixture-branch ${repo.sha}$`), 'READY 行必须含分支与 HEAD SHA');
    }
    const written = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
    assert.equal(written.version, 3, `轮 ${i + 1}: 台账 version 必须全程不变（ready-check 不写台账）`);
    assert.equal(written.phase, 'validating', `轮 ${i + 1}: 台账 phase 必须不被驱动`);
    // 并发写同一 receipt 路径：唯一 tmp + rename 原子 → 落盘必为完整合法 JSON（无半写）
    const receipt = JSON.parse(readFileSync(join(env.dir, 'ready-receipt.json'), 'utf8'));
    assert.deepEqual(Object.keys(receipt).sort(), ['candidate_sha', 'checked_at', 'ledger_version'], 'receipt 必须 exact 三键');
    assert.equal(receipt.ledger_version, 3, 'receipt.ledger_version 必须 = 检查时 version');
    if (i === ROUNDS - 1) {
      // 用最后一张 receipt 驱动 run-ledger：恰 1 成功（驱动后台账 ready，第二次驱动必拒）
      const ledgerB = join(env.dir, 'ledger-consumable.json');
      writeFileSync(ledgerB, `${JSON.stringify(buildConsumableLedger(env, repo), null, 2)}\n`);
      const r1 = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--phase', 'ready',
        '--ready-receipt', join(env.dir, 'ready-receipt.json'), '--now', FIXED_NOW]);
      assert.equal(r1.status, 0, `receipt 驱动必须恰 1 成功: ${r1.stderr}`);
      const r2 = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--phase', 'ready',
        '--ready-receipt', join(env.dir, 'ready-receipt.json'), '--now', FIXED_NOW]);
      assert.equal(r2.status, 2, '同一 receipt 第二次驱动必须 exit 2（恰 1 成功）');
    }
  }
  t.diagnostic(`并发 ${ROUNDS} 轮全过：每轮双 READY + 台账 version 3 不变，receipt 驱动恰 1 成功`);
});

// ---------- 状态机绕过（缺陷③回归守卫）：ready-check 只检查，run-ledger 驱动时执行状态机 ----------
// 旧实现 drivePhaseReady 直接 {...current, phase:'ready'}，不查当前 phase、不要求全波集成——
// phase=validating、integrated_tip=null 也被放行。新架构下 ready-check 对此无感（职责分工），
// 但 run-ledger set-state --phase ready 必须拒：集成树为空（candidate_sha 无绑定对象）或
// phase 跳步（validating→ready 须依次经过 e2e → packaging）各拒并点名。
test('状态机绕过: 台账 phase=validating 且 integrated_tip=null → ready-check 放行（只检查），run-ledger 驱动必拒并点名', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  const receiptPath = join(env.dir, 'ready-receipt.json');
  // ready-check 对 phase/集成状态不做状态机前置（那不是它的职责）——仍 exit 0 + 写 receipt
  const res = runReady(repo, env, { receiptPath });
  assert.equal(res.status, 0, `ready-check 应 exit 0（只检查）: ${res.stderr}`);
  assert.match(res.stdout, new RegExp(`^READY_FOR_SUBMIT_PR feat/fixture-branch ${repo.sha}$`));
  // (a) 集成树为空：receipt.candidate_sha != latestIntegratedTip(null) → 拒并点名
  const rA = run(process.execPath, [RUN_LEDGER, 'set-state', env.ledgerPath, '--phase', 'ready',
    '--ready-receipt', receiptPath, '--now', FIXED_NOW]);
  assert.equal(rA.status, 2, '集成树为空时驱动必须 exit 2');
  assert.match(rA.stderr, /candidate_sha|集成树/, '必须点名 candidate_sha 与集成树不一致');
  // (b) phase 跳步：phase=validating 但全波已集成（version 与 receipt 匹配）→ 状态机拒并点名
  const ledgerB = join(env.dir, 'ledger-jump.json');
  const base = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  writeFileSync(ledgerB, `${JSON.stringify({ ...base, version: 3, phase: 'validating',
    waves: base.waves.map((w) => ({ ...w, integrated_tip: repo.sha })) }, null, 2)}\n`);
  const rB = run(process.execPath, [RUN_LEDGER, 'set-state', ledgerB, '--phase', 'ready',
    '--ready-receipt', receiptPath, '--now', FIXED_NOW]);
  assert.equal(rB.status, 2, 'phase 跳步必须 exit 2');
  assert.match(rB.stderr, /非法跳转|须依次经过/, '必须点名 phase 单步前置（validating → ready 须经过 e2e → packaging）');
});

// ---------- manifest 篡改（缺陷②回归守卫）：hash 绑定在 run-ledger 侧 ----------
// 旧实现 ready-check 直接消费 --manifest，只对 group/sc 集合，不校 core hash——
// 改 manifest.goal（保留 scs/packets）仍被放行。新架构下 ready-check 不校 hash
// （它的职责是候选树 + 台账状态 + 三闸检查，不是内容绑定）；manifest 内容绑定由
// run-ledger 的 assertManifestBound 在所有消费 manifest 的命令入口执行（validate/
// render-packet/record-delivery）——篡改 manifest 后 validate 实读实算 → HASH_MISMATCH 拒。
// 对照设计：先证明「未篡改 env manifest 绑定自身 hash → validate 过」（隔离基线），
// 再仅改 goal 一字段 → 同 hash 台账 validate 拒。差异唯一 = goal 篡改。
test('manifest 篡改: 改 manifest.goal（scs/packets 原样）→ ready-check 放行（不校 hash 是分工），run-ledger validate 拒 HASH_MISMATCH', (t) => {
  const repo = makeRepo(t);
  const env = buildEnv(t, repo, null);
  // ready-check：仅 goal 变化的 manifest 仍过七门（hash 不属其职责）→ exit 0 + READY + receipt
  const res = runReady(repo, env);
  assert.equal(res.status, 0, `ready-check 应 exit 0（hash 绑定不在它这边）: ${res.stderr}`);
  assert.match(res.stdout, new RegExp(`^READY_FOR_SUBMIT_PR feat/fixture-branch ${repo.sha}$`));
  assert.equal(JSON.parse(readFileSync(join(env.dir, 'ready-receipt.json'), 'utf8')).candidate_sha, repo.sha, 'receipt 已落盘');
  // 基线：env manifest（未篡改）绑定自身 hash → validate 必须过（隔离对照，证明差异唯一 = goal）
  const boundHash = manifestCoreHash(JSON.parse(readFileSync(env.manifestPath, 'utf8')));
  const ledgerBase = JSON.parse(readFileSync(env.ledgerPath, 'utf8'));
  const baselinePath = join(env.dir, 'ledger-baseline.json');
  writeFileSync(baselinePath, `${JSON.stringify({ ...ledgerBase, manifest_path: env.manifestPath, manifest_core_hash: boundHash }, null, 2)}\n`);
  const baseline = run(process.execPath, [RUN_LEDGER, 'validate', baselinePath]);
  assert.equal(baseline.status, 0, `未篡改 manifest 必须过 validate（隔离对照）: ${baseline.stderr}`);
  // 篡改：goal 一字段（scs/packets 与基线逐字相同）→ 同 hash 台账 validate 拒
  const tampered = JSON.parse(readFileSync(env.manifestPath, 'utf8'));
  tampered.goal = '被篡改的 goal（scs/packets 原样）';
  const tamperedPath = join(env.dir, 'manifest-tampered.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedLedgerPath = join(env.dir, 'ledger-tampered.json');
  writeFileSync(tamperedLedgerPath, `${JSON.stringify({ ...ledgerBase, manifest_path: tamperedPath, manifest_core_hash: boundHash }, null, 2)}\n`);
  const v = run(process.execPath, [RUN_LEDGER, 'validate', tamperedLedgerPath]);
  assert.equal(v.status, 2, '篡改 manifest 后 validate 必须 exit 2');
  assert.match(v.stderr, /HASH_MISMATCH/, '必须点名 manifest core hash 不匹配');
});

// ---------- 变异反证（sc-p1g）：三组反向变异各自挖红且失败模式互相隔离 ----------
// 与 ready-check.mjs 内变异点注释一一对应：变异① = ⑤ presubmit SHA 绑定、
// 变异② = ① 组数对账、变异③ = ② 锚点内容校验（文件存在性）。
// 机制：把 scripts/tests/config 复制到临时目录，对副本应用变异（字符串替换，锚点唯一），
// 再跑「跳过变异测试自身」（RC_MUTATION_CHILD=1）的完整套件，断言失败集恰为预测集——
// 挖红（失败集非空）+ 隔离（恰等于预测集，无多余无遗漏）。真实脚本永不被触碰，无需恢复。
// 若 gap 测试改名，预测集字符串会随之失配并响亮失败——这是刻意的耦合，防止变异测试静默空转。
const MUTATION_PREDICTIONS = [
  { id: '变异①', label: '⑤ presubmit SHA 绑定', from: 'result.candidate_sha !== headSha', to: 'false',
    red: ['gap5: presubmit 三闸各自绑定 SHA 过期 → exit 2 gap presubmit-gates'] },
  { id: '变异②', label: '① 组数对账', from: 'groups.length !== packets.length', to: 'false',
    red: ['gap1: 台账缺组（组数 < manifest packets）→ exit 2 gap ledger-partition'] },
  { id: '变异③', label: '② 锚点内容校验（文件存在性）', from: '!anchorFileExists', to: 'false',
    red: ['gap2: 证据锚点指向不存在文件 → exit 2 gap verdict-anchors',
          'F-L: 证据锚点以 symlink 指向仓外 → exit 2 gap verdict-anchors'] },
  { id: '变异④', label: 'F-L 锚点 realpath 仓内校验', from: 'return anchorReal === repoReal || anchorReal.startsWith(repoReal + sep);',
    to: 'return resolved.startsWith(repoRoot + sep) || resolved === repoRoot;',
    red: ['F-L: 证据锚点以 symlink 指向仓外 → exit 2 gap verdict-anchors'] },
  { id: '变异⑤', label: 'F-M manifest.scs fail-closed（空/重复/对账）', from: 'if (!scv.ok) {',
    to: 'if (false) {',
    red: ['F-M: manifest.scs 为空数组（其余凭据全有效）→ exit 2 gap verdict-anchors',
          'F-M: manifest.scs 含重复 id → exit 2 gap verdict-anchors',
          'F-M: dispatch packets scs_inline 与 manifest.scs 不一致 → exit 2 gap verdict-anchors',
          'F-M: 台账组 sc_ids 与 manifest.scs 不一致 → exit 2 gap verdict-anchors',
          'gap1: 零工作运行（台账/manifest 全空）→ exit 2 gap ledger-partition（拒绝空洞 READY）',
          'gap1: 台账缺组（组数 < manifest packets）→ exit 2 gap ledger-partition'] },
  { id: '变异⑥', label: 'F-N 三方 group_id 集合严格相等', from: '&& (!setsEqual(ledgerGroupIds, packetGroupIds) || !setsEqual(ledgerGroupIds, dispatchGroupIds))) {',
    to: '&& false) {',
    red: ['F-N: dispatch 事件 group_id 换成未知 gX（数量仍为 2）→ exit 2 gap ledger-partition',
          'F-N: manifest packet group_id 换成未知 gX → exit 2 gap ledger-partition'] },
  { id: '变异⑦', label: 'F-O 不可解析输入不提前 exit', from: 'const ledger = readJsonOrNull(args.ledger);\n  // manifest 经 readManifest 统一收口（receipts 在场/形状契约与 run-ledger 全部消费入口同判据）：\n  // 不合约/不可解析 → 转 gap 占位（F-O：不提前 exit，后项照常运行），错误原文随 manifestError\n  // 进 gap detail——「可解析但不合约」不得被笼统说成「不可解析」。\n  let manifest = null;\n  let manifestError = null;\n  try { manifest = readManifest(args.manifest); } catch (err) { manifestError = err.message; }',
    to: 'const ledger = readJsonOrNull(args.ledger);\n  const manifest = readJsonOrNull(args.manifest);\n  let manifestError = null;\n  if (!ledger || !manifest) { console.error(\'GAP: ledger-partition: 前置输入不可解析（旧版提前 exit 行为）\'); process.exit(2); }',
    red: ['F-O: ledger+e2e 都删 → 三项 gap 同时点名（不跳过后项）',
          'F-O: manifest+verdict 都删 → ledger-partition + verdict-anchors 双 gate 点名'] },
  { id: '变异⑨', label: '→ready receipt 写入（成功路径铸凭据）', from: 'const receiptError = writeReadyReceipt(args.receipt, { candidateSha: headSha, ledgerVersion: ledger.version, checkedAt: args.now });',
    to: 'const receiptError = null; // 变异⑨：receipt 写盘被挖掉',
    red: ['full: 七项全齐 → READY_FOR_SUBMIT_PR 含分支与 SHA，receipt 原子落盘（ledger_version=检查时 version），台账不被驱动',
          'receipt 写盘失败: --receipt 指向不存在目录 → exit 2 gap ready-receipt，不输出 READY 行',
          '闭环: ready-check 写出 receipt → run-ledger set-state --ready-receipt 消费 → exit 0 成功到 ready',
          '闭环反例 A: 铸 receipt 后对台账做一次写操作（version+1）→ run-ledger 拒并点名版本不匹配（防重放）',
          '闭环反例 B: receipt.candidate_sha 与台账集成树不符 → run-ledger 拒并点名（伪造拒）',
          'manifest 篡改: 改 manifest.goal（scs/packets 原样）→ ready-check 放行（不校 hash 是分工），run-ledger validate 拒 HASH_MISMATCH',
          '状态机绕过: 台账 phase=validating 且 integrated_tip=null → ready-check 放行（只检查），run-ledger 驱动必拒并点名',
          '并发: 同台账双进程同时跑 ready-check → 双 READY、台账 version 全程不变，receipt 驱动恰 1 成功（30 轮）'] },
  { id: '变异⑩', label: 'receipt 未落盘不得输出 READY 的守卫（写失败 exit 2）', from: 'if (receiptError !== null) {',
    to: 'if (false) {',
    red: ['receipt 写盘失败: --receipt 指向不存在目录 → exit 2 gap ready-receipt，不输出 READY 行'] },
  // 变异⑪（D1）：③ 的绑定对象是「该类组的结论交卷」（执行组=review / 验收组=verify）。
  // 挖回「最后一条交卷」= verify（绑当前 HEAD）→ 两条新用例（review 旧 SHA 被顶替 /
  // 无 review 类交卷）都变绿假通过而红
  { id: '变异⑪', label: '③ 审查交卷绑定按该类组结论交卷（review 旧 SHA 不被 verify 顶替）', from: 'const lastBinding = binding[binding.length - 1];',
    to: 'const lastBinding = deliveries[deliveries.length - 1];',
    red: ['gap3: 审查交卷（review 类 delivery）candidate_sha 过期（verify 绑当前 SHA 不顶替）→ exit 2 gap review-clean',
          'gap3: 组无 review 类交卷（仅 exec+verify delivery）→ exit 2 gap review-clean 且点名类别序列'] },
];

// 复制 scripts/tests/config 到临时目录并对脚本副本应用变异；返回 { file, dir }——
// dir 是复制树根（子套件进程的 cwd 必须是根：full 测试的链尾 run-ledger validate 会按
// cwd 解析夹具 ledger 里的相对 manifest_path；此前 cwd 误传 dirname(testFile)=根/tests，
// 相对路径全解析错位，直到 F2 回归锚点首次暴露）。
function copyTreeForMutation(t, mutateScript) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-mut-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  const scriptSrc = readFileSync(join(root, 'scripts/ready-check.mjs'), 'utf8');
  const scriptMutated = mutateScript(scriptSrc);
  assert.notEqual(scriptMutated, scriptSrc, '变异必须实际改变脚本内容（防替换静默空转）');
  writeFileSync(join(dir, 'scripts/ready-check.mjs'), scriptMutated);
  // full 测试的链尾 run-ledger validate（F2 回归锚点）需要真实 run-ledger.mjs 副本
  writeFileSync(join(dir, 'scripts/run-ledger.mjs'), readFileSync(join(root, 'scripts/run-ledger.mjs'), 'utf8'));
  // ready-check.test.mjs import 了 run-tests.mjs 的 buildChildEnv（变异子套件 git 隔离唯一实现）：
  // 复制树必须带上该文件，否则子套件加载失败（失败集解析成文件路径，恰红契约被破坏）
  writeFileSync(join(dir, 'scripts/run-tests.mjs'), readFileSync(join(root, 'scripts/run-tests.mjs'), 'utf8'));
  writeFileSync(join(dir, 'tests/ready-check.test.mjs'), readFileSync(join(root, 'tests/ready-check.test.mjs'), 'utf8'));
  cpSync(join(root, 'tests/fixtures'), join(dir, 'tests/fixtures'), { recursive: true });
  writeFileSync(join(dir, 'config/defaults.json'), readFileSync(join(root, 'config/defaults.json'), 'utf8'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file: join(dir, 'tests/ready-check.test.mjs'), dir };
}

// 跑子套件（变异副本上），返回 exit code 与失败测试名集合；同时解析 spec('✖ name (ms)') 与 TAP('not ok N - name') 报告器
function runMutatedSuite(testFile, dir) {
  // 剥掉 NODE_TEST_CONTEXT：本进程由 node --test 拉起时该标记会被子进程继承，
  // node 检测到「test run 递归」会静默跳过全部测试并 exit 0（实际空跑），必须剥离才能让子套件真正执行
  const { NODE_TEST_CONTEXT: _drop, ...childEnv } = process.env;
  const r = spawnSync(process.execPath, ['--test', testFile],
    { cwd: dir, encoding: 'utf8', env: { ...buildChildEnv(childEnv), RC_MUTATION_CHILD: '1' } });
  const failedNames = new Set();
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) {
    if (line.startsWith('not ok ')) {
      const m = line.match(/^not ok \d+ - (.+)$/);
      if (m) failedNames.add(m[1].trim());
    } else if (line.startsWith('✖ ') && !line.startsWith('✖ failing tests:')) {
      failedNames.add(line.replace(/^✖ /, '').replace(/\s*\(\d+(?:\.\d+)?ms\)\s*$/, '').trim());
    }
  }
  return { status: r.status, failedNames: [...failedNames] };
}

for (const m of MUTATION_PREDICTIONS) {
  test(`mutation-kill: ${m.id} ${m.label} 被挖 → 恰红预测用例，失败模式隔离`, (t) => {
    if (process.env.RC_MUTATION_CHILD === '1') { t.skip('子套件运行跳过变异测试（防递归）'); return; }
    const { file: testFile, dir } = copyTreeForMutation(t, (src) => src.replace(m.from, m.to));
    const { status, failedNames } = runMutatedSuite(testFile, dir);
    assert.equal(status, 1, `变异 ${m.id} 后套件必须红（exit 1），实际 ${status}`);
    assert.deepEqual([...failedNames].sort(), [...m.red].sort(),
      `变异 ${m.id} 的失败集必须恰为预测集（${m.red.length} 条，无多余无遗漏）`);
  });
}

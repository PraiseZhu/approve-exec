// selfcheck 测试：派会话前环境自检（goal skill + fail-closed 反向变异）+ sc-p2c（--live 接线机器可检）。
// 组结构（变异红集预测依据）：
//   组 A「goal skill」——缺省运行 exit 0、只做 goal-skill-md 检查；已删除的 routing / orca-fanout /
//                       run-ledger-dir 检查不再出现；--routing-file 按未知参数 exit 2（PraiseZhu/approve-exec#70）
//   组 B「live 域」——--live 两处接线（symlink 指向 approve-exec 仓根 + 触发行）输出 PASS；
//                       回归锚点：LIVE_LINK 推导与仓库嵌套深度无关（注入浅/深 root 恒同值）+ 与 cwd 无关（异 cwd 黑盒跑）；
//                       F-B 锚点：target 必须是仓根本身（嵌套子目录冒充 → FAIL 点名）
//   组 C「CLI 拒绝」——未知参数 exit 2
// 预测红集：挖掉 live-symlink / live-trigger-line 检查 → 组 B 对应断言红；
//           LIVE_LINK 改回 '../..' 猜层级 → 组B-1（主 checkout 上拼错路径）+ 组B-2（浅深 root 结果分叉）+ 组B-3（异 cwd 下仍按 repo 深度猜）红。组 C 恒绿。
//           F-B 变异（挖掉 show-toplevel 仓根校验）→ 恰好组B-4 负向用例红（冒充误 PASS）；组B-1/3（真实仓根）/组B-5（正向夹具）恒绿。
//           F-K 变异（guard 未归一）→ 恰好组F-1 红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveLiveLink, checkLiveSymlink, checkTriggerLine, TRIGGER_LINE, normalizeGitHubOrigin } from '../scripts/selfcheck.mjs';
// buildChildEnv：变异子套件自起子进程，git 隔离必须同一份实现（run-tests.mjs 是唯一权威）。
// 子套件在复制树里跑，缺隔离会继承机器全局 commit.gpgsign=true，负载下 gpg 失败让夹具
// git commit 红——失败集比对随之漂移。
import { buildChildEnv } from '../scripts/run-tests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'scripts/selfcheck.mjs');

test('#69 SC9 批准执行触发行：issue 入口、owner 用 KEEL、lead 最终验收、不合并；不再提 manifest', () => {
  assert.match(TRIGGER_LINE, /吃总 issue（或独立 issue \/ 单个子 issue）/);
  assert.match(TRIGGER_LINE, /owner 用 KEEL 的 keel_run/);
  assert.match(TRIGGER_LINE, /lead 跑 accept-check 后判通过或要改/);
  assert.match(TRIGGER_LINE, /本 skill 不合入 \|$/);
  for (const old of ['task-priority', 'manifest', 'context-intake', 'grok', 'routing.json']) {
    assert.equal(TRIGGER_LINE.includes(old), false, `触发行不得再出现 ${old}`);
  }
});

function runSelfcheck(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: 'utf8' });
}
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// F-B 临时 git 仓夹具（嵌套子目录冒充 / 仓根正向对照）——全部构造在 tmpdir，不碰真实接线位点
function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-live-'));
  try {
    // buildChildEnv：裸跑（非权威入口）时 F-B 夹具 git 同样必须隔离——缺它会继承机器全局
    // commit.gpgsign=true，负载下 gpg 失败让夹具 commit 红。同一份实现，不拷。
    const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8', env: buildChildEnv(process.env) });
    if (init.status !== 0) throw new Error(`git init 失败: ${init.stderr}`);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('组A-1: 缺省运行 → exit 0，只做 goal-skill-md 检查；routing / orca-fanout / run-ledger-dir 已删除', (t) => {
  if (process.env.SC_MUTATION_CHILD === '1') { t.skip('子套件运行跳过真实环境测试（与 F-K 变异无关，防污染其失败集契约）'); return; }
  const r = runSelfcheck([]);
  const text = out(r);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${text}`);
  assert.ok(text.includes('PASS: goal-skill-md'), `① goal SKILL.md 应 PASS，实际:\n${text}`);
  for (const gone of ['routing-', 'orca-fanout-', 'run-ledger-dir']) {
    assert.equal(text.includes(gone), false, `已删除的检查 ${gone} 不应再出现，实际:\n${text}`);
  }
});

test('组A-2: --routing-file 已删除 → 按未知参数 exit 2', () => {
  const r = runSelfcheck(['--routing-file', 'routing.json']);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes('未知参数 --routing-file'), `输出应点名未知参数，实际:\n${out(r)}`);
});

test('组B-1: --live 接线两处（symlink 指向 approve-exec 仓根 + 触发行）→ exit 0 且两项 PASS', (t) => {
  if (process.env.SC_MUTATION_CHILD === '1') { t.skip('子套件运行跳过 live 环境测试（副本根非 git checkout，接线无法验证）'); return; }
  const r = runSelfcheck(['--live']);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
  const text = out(r);
  assert.ok(text.includes('PASS: live-symlink'), `live-symlink 应 PASS，实际:\n${text}`);
  assert.ok(text.includes('PASS: live-trigger-line'), `live-trigger-line 应 PASS，实际:\n${text}`);
});

// 回归锚点：live-trigger-line 读取的路径来自 config.skillTriggerScanPath（配置键化，非硬编码）。
// 正向：注入指向含触发行临时文件的 config → PASS；负向：注入不存在路径 → FAIL 且点名该路径。
// 变异反证：checkTriggerLine 改回硬编码 ~/.claude/rules/skill-trigger-scan.md（忽略 config）→
// 负向用例读取真实文件（存在且含触发行）恒 PASS，`!it1.ok` 断言红——本用例恰红 1 条。
// 子套件跳过（同组B-1/组B-3 模式）：F-K 变异子套件的失败集契约只针对 main guard，本用例与 F-K
// 无关；不跳过会让「父树在途的其他变异（如 checkTriggerLine 硬编码）」被拷贝进子套件 → 污染预测红集。
test('组B-6: checkTriggerLine 从 config.skillTriggerScanPath 读路径（非硬编码）', (t) => {
  if (process.env.SC_MUTATION_CHILD === '1') { t.skip('子套件运行跳过本用例（与 F-K 变异无关，防污染其失败集契约）'); return; }
  const missing = '/nonexistent/skill-trigger-scan.md';
  const items1 = [];
  checkTriggerLine({ skillTriggerScanPath: missing }, items1);
  const it1 = items1.find((i) => i.id === 'live-trigger-line');
  assert.ok(it1 && !it1.ok, '注入不存在路径必须 FAIL');
  assert.ok(it1.detail.includes(missing), `必须点名注入的路径（证明从 config 读），实际: ${it1.detail}`);

  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-trigger-'));
  try {
    const good = join(dir, 'skill-trigger-scan.md');
    writeFileSync(good, `${TRIGGER_LINE}\n`, 'utf8');
    const items2 = [];
    checkTriggerLine({ skillTriggerScanPath: good }, items2);
    const it2 = items2.find((i) => i.id === 'live-trigger-line');
    assert.ok(it2 && it2.ok, '注入含触发行文件必须 PASS');
    assert.ok(it2.detail.includes(good), `PASS 详情应点名注入路径，实际: ${it2.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 回归锚点：LIVE_LINK 推导不依赖仓库在磁盘上的嵌套深度。
// 主 checkout（approve-exec-src）与 worktree（approve-exec-worktrees/g2）深度不同，
// 按 '../..' 相对 root 猜层级必然在其中一个上拼错路径（V 阶段集成暴露）。
// 两个 root 注入不同嵌套深度（浅 3 层 / 深 5 层，镜像真实主 checkout vs worktree），
// 断言推导结果恒同值且恒等于 dirname(goalSkillRoot)/approve-exec。
// 变异反证：deriveLiveLink 改回 resolve(root, '../../skills/claude-active/approve-exec')
// → 本用例浅深 root 结果分叉，断言红。
test('组B-2: LIVE_LINK 推导与仓库嵌套深度无关（注入浅/深 root 恒同值且等于 config 派生）', () => {
  const config = {
    goalSkillRoot: '/capabilities/source/skills/claude-active/goal',
  };
  const expected = join(dirname(config.goalSkillRoot), 'approve-exec');
  const shallowRoot = '/capabilities/source/approve-exec-src'; // 3 层，镜像主 checkout
  const deepRoot = '/capabilities/source/approve-exec-worktrees/g2'; // 5 层，镜像 worktree
  const fromShallow = deriveLiveLink(config, shallowRoot);
  const fromDeep = deriveLiveLink(config, deepRoot);
  assert.equal(fromShallow, expected, `浅 root 推导应等于 config 派生路径，实际 ${fromShallow}`);
  assert.equal(fromDeep, expected, `深 root 推导应等于 config 派生路径，实际 ${fromDeep}`);
  assert.equal(fromShallow, fromDeep, '推导不得随仓库嵌套深度变化（禁止按 ../.. 猜层级）');
});

// 回归锚点：LIVE_LINK 推导不依赖 process.cwd()。
// 黑盒端到端：在无关 cwd（tmpdir）下跑 --live，config 读取与 LIVE_LINK 均按 import.meta.url 的 root
// 与 config 派生，不读 process.cwd()——异 cwd 下 live-symlink 仍必须 PASS。
// 变异反证：改回 '../..' 猜层级 → 本用例在真实主 checkout 上拼错路径，live-symlink FAIL，断言红。
test('组B-3: --live 在无关 cwd（tmpdir）下跑 → exit 0 且 live-symlink PASS（不依赖 process.cwd()）', (t) => {
  if (process.env.SC_MUTATION_CHILD === '1') { t.skip('子套件运行跳过 live 环境测试（副本根非 git checkout，接线无法验证）'); return; }
  const r = spawnSync(process.execPath, [scriptPath, '--live'], { cwd: tmpdir(), encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${text}`);
  assert.ok(text.includes('PASS: live-symlink'), `异 cwd 下 live-symlink 应 PASS，实际:\n${text}`);
});

// F-B 回归锚点（gpt 审查席 F-B：--live symlink 校验可被嵌套子目录冒充——旧逻辑只查
// ①SKILL.md ②git common dir 同源，仓内任意带 SKILL.md 的子目录都能与 root 共享 common dir）。
// 反证：临时 git 仓里把 live link 指向 src/wrong-nested（子目录只复制 SKILL.md，show-toplevel 实为仓根 ≠ target）。
// 预测红集：挖掉 show-toplevel 仓根校验 → 本用例红（live-symlink 误 PASS）；其余用例恒绿。
test('组B-4(F-B): live link 指向仓内嵌套子目录（仅含 SKILL.md）→ FAIL 点名非仓根', () => {
  withTempRepo((repo) => {
    const nested = join(repo, 'src', 'wrong-nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'SKILL.md'), '# wrong-nested 假 SKILL.md\n');
    const liveLink = join(repo, 'live-approve-exec');
    symlinkSync(nested, liveLink);
    const items = [];
    checkLiveSymlink(liveLink, repo, items);
    const it = items.find((i) => i.id === 'live-symlink');
    assert.ok(it, '必须产出 live-symlink 判定');
    assert.equal(it.ok, false, `嵌套子目录冒充必须 FAIL，实际 detail: ${it.detail}`);
    assert.match(it.detail, /根目录/, `必须点名「不是…根目录」，实际: ${it.detail}`);
  });
});

test('组B-5(F-B): live link 指向仓根（含 SKILL.md）→ PASS（正向对照）', () => {
  withTempRepo((repo) => {
    writeFileSync(join(repo, 'SKILL.md'), '# 真 SKILL.md\n');
    const liveLink = join(repo, 'live-approve-exec');
    symlinkSync(repo, liveLink);
    const items = [];
    checkLiveSymlink(liveLink, repo, items);
    const it = items.find((i) => i.id === 'live-symlink');
    assert.ok(it, '必须产出 live-symlink 判定');
    assert.equal(it.ok, true, `仓根本身必须 PASS，实际 detail: ${it?.detail}`);
  });
});

test('组B-7: git@ 与 https origin 归一成同一仓身份', () => {
  const a = normalizeGitHubOrigin('git@github.com:PraiseZhu/approve-exec.git');
  const b = normalizeGitHubOrigin('https://github.com/PraiseZhu/approve-exec.git');
  const c = normalizeGitHubOrigin('ssh://git@github.com/PraiseZhu/approve-exec.git');
  assert.equal(a, 'github.com/praisezhu/approve-exec');
  assert.equal(a, b);
  assert.equal(a, c);
});

test('组B-8: 两份独立 clone 同一 origin → live-symlink PASS（工程仓/live 双份）', () => {
  withTempRepo((eng) => {
    withTempRepo((live) => {
      const env = buildChildEnv(process.env);
      const origin = 'https://github.com/PraiseZhu/approve-exec.git';
      for (const dir of [eng, live]) {
        writeFileSync(join(dir, 'SKILL.md'), '# approve-exec\n');
        const add = spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, encoding: 'utf8', env });
        assert.equal(add.status, 0, `git remote add 失败: ${add.stderr}`);
      }
      const liveLink = join(eng, 'live-approve-exec');
      symlinkSync(live, liveLink);
      const items = [];
      checkLiveSymlink(liveLink, eng, items);
      const it = items.find((i) => i.id === 'live-symlink');
      assert.ok(it, '必须产出 live-symlink 判定');
      assert.equal(it.ok, true, `双份 clone 同源 origin 必须 PASS，实际: ${it.detail}`);
      assert.match(it.detail, /origin/, `详情应点名 origin 路径，实际: ${it.detail}`);
    });
  });
});

test('组B-9: 两份独立 clone origin 不同 → live-symlink FAIL', () => {
  withTempRepo((eng) => {
    withTempRepo((live) => {
      const env = buildChildEnv(process.env);
      writeFileSync(join(eng, 'SKILL.md'), '# eng\n');
      writeFileSync(join(live, 'SKILL.md'), '# live\n');
      const a = spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/PraiseZhu/approve-exec.git'], { cwd: eng, encoding: 'utf8', env });
      const b = spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/PraiseZhu/other-repo.git'], { cwd: live, encoding: 'utf8', env });
      assert.equal(a.status, 0, `eng remote add 失败: ${a.stderr}`);
      assert.equal(b.status, 0, `live remote add 失败: ${b.stderr}`);
      const liveLink = join(eng, 'live-approve-exec');
      symlinkSync(live, liveLink);
      const items = [];
      checkLiveSymlink(liveLink, eng, items);
      const it = items.find((i) => i.id === 'live-symlink');
      assert.ok(it, '必须产出 live-symlink 判定');
      assert.equal(it.ok, false, `不同 origin 必须 FAIL，实际: ${it.detail}`);
      assert.match(it.detail, /origin/, `必须点名 origin 不一致，实际: ${it.detail}`);
    });
  });
});

test('组C-1: 未知参数 → exit 2', () => {
  const r = runSelfcheck(['--bogus']);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes('未知参数'), `输出应点名未知参数，实际:\n${out(r)}`);
});

// ---------- 组 F（F-K 回归）：main-module guard 的 realpath 归一 ----------
// 前提：import.meta.url 已被 ESM loader 规范化（realpath 后的真实路径），而 process.argv[1] 是调用方
// 原样路径。macOS 上 os.tmpdir() 落在 /var/folders/...（/var → /private/var symlink），以逻辑 /var 路径
// 调用时两者恒不相等——旧 guard 会让 main 静默不执行（exit 0 + 零输出，与全 PASS 同形）。
// 本用例断言：非规范化路径调用必须真的输出检查项（PASS/FAIL 行），只断言 exit code 会被「零输出」骗过。
// 若运行平台 tmpdir 恰好已规范化（realpath == 原路径），用 symlink 强制制造非规范化入口，防止用例空转。
test('组F-1: 非规范化路径调用必须实际执行检查并输出 PASS 行（main guard realpath 归一）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-norm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 保持 <root>/scripts/selfcheck.mjs 布局：脚本 root = dirname(import.meta.url) + '..'，
  // 平铺放置会让 root 解析到临时根层（config 读错位，与 guard 无关地失败）
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  cpSync(join(root, 'scripts/selfcheck.mjs'), join(dir, 'scripts/selfcheck.mjs'));
  writeFileSync(join(dir, 'config/defaults.json'), readFileSync(join(root, 'config/defaults.json'), 'utf8'));
  let logical = dir;
  if (realpathSync(dir) === dir) {
    // link 名必须唯一：历史用 process.pid，进程被杀时 t.after 未注册 → link-<PID> 残留；
    // 宿主并发下 PID 复用即撞名 EEXIST（tmpdir 曾积上千残留）。
    // dir 名来自 mkdtemp 唯一，用它派生 link 名——残留永不撞名，非规范化语义不变。
    const link = join(tmpdir(), `selfcheck-norm-link-${basename(dir)}`);
    symlinkSync(dir, link);
    t.after(() => rmSync(link, { force: true }));
    logical = link;
  }
  assert.notEqual(realpathSync(logical), logical, '前置条件: 调用路径必须非规范化（否则本用例空转）');
  const r = spawnSync(process.execPath,
    [join(logical, 'scripts/selfcheck.mjs')],
    { encoding: 'utf8' });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(text.length > 0, '非规范化路径调用不得静默零输出（guard 被 bypass 的形态就是 exit 0 + 全空）');
  assert.match(text, /^(PASS|FAIL): goal-skill-md: /m, `非规范化路径调用必须实际执行检查并输出检查项行，实际:\n${text}`);
});

// ---------- 变异反证（F-K）：main guard realpath 归一被挖 → 恰红预测用例，失败模式隔离 ----------
// 机制：把 scripts/config/tests 复制到临时目录（复制到 realpath(tmpdir) 下，
// 保证子套件对脚本副本的调用路径已规范化，guard 不误伤其他用例——tmpdir() 的 /var 逻辑路径本身会触发
// 被挖掉的 guard），对副本应用变异，跑「跳过变异测试自身」的完整套件，断言失败集恰为预测集。
const SELFCHECK_MUTATIONS = [
  // F-B 变异：挖掉 show-toplevel 仓根校验（checkLiveSymlink 第三段），
  // 只留 ①SKILL.md ②common dir 同源 → 仓内嵌套子目录冒充被误放行（组B-4 红）。
  // 预测红集：恰组B-4 一条；组B-1/3（真实仓根）与组B-5（正向夹具）在 common dir 同源 + SKILL.md
  // 两段下依旧 PASS，恒绿。
  { id: '变异F-B', label: 'live-symlink show-toplevel 仓根校验', from: 'if (!top || top !== target) {',
    to: 'if (false) {',
    red: ['组B-4(F-B): live link 指向仓内嵌套子目录（仅含 SKILL.md）→ FAIL 点名非仓根'] },
  { id: '变异F-K', label: 'main guard realpath 归一', from: 'if (import.meta.url === pathToFileURL(entryReal).href) {',
    to: 'if (import.meta.url === pathToFileURL(process.argv[1]).href) {',
    red: ['组F-1: 非规范化路径调用必须实际执行检查并输出 PASS 行（main guard realpath 归一）'] },
];

function copyTreeForMutation(t, mutateScript) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'selfcheck-mut-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'tests'));
  mkdirSync(join(dir, 'config'));
  const src = readFileSync(join(root, 'scripts/selfcheck.mjs'), 'utf8');
  const mutated = mutateScript(src);
  assert.notEqual(mutated, src, '变异必须实际改变脚本内容（防替换静默空转）');
  writeFileSync(join(dir, 'scripts/selfcheck.mjs'), mutated);
  // selfcheck.test.mjs import 了 run-tests.mjs 的 buildChildEnv（变异子套件 git 隔离唯一实现）：
  // 复制树必须带上该文件，否则子套件加载失败（失败集解析成文件路径，恰红契约被破坏）
  writeFileSync(join(dir, 'scripts/run-tests.mjs'), readFileSync(join(root, 'scripts/run-tests.mjs'), 'utf8'));
  writeFileSync(join(dir, 'tests/selfcheck.test.mjs'), readFileSync(join(root, 'tests/selfcheck.test.mjs'), 'utf8'));
  writeFileSync(join(dir, 'config/defaults.json'), readFileSync(join(root, 'config/defaults.json'), 'utf8'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'tests/selfcheck.test.mjs');
}

function runMutatedSuite(testFile, dir) {
  const { NODE_TEST_CONTEXT: _drop, ...childEnv } = process.env;
  const r = spawnSync(process.execPath, ['--test', testFile],
    { cwd: dir, encoding: 'utf8', env: { ...buildChildEnv(childEnv), SC_MUTATION_CHILD: '1' } });
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

for (const m of SELFCHECK_MUTATIONS) {
  test(`mutation-kill: ${m.id} ${m.label} 被挖 → 恰红预测用例，失败模式隔离`, (t) => {
    if (process.env.SC_MUTATION_CHILD === '1') { t.skip('子套件运行跳过变异测试（防递归）'); return; }
    const testFile = copyTreeForMutation(t, (src) => src.replace(m.from, m.to));
    const { status, failedNames } = runMutatedSuite(testFile, dirname(testFile));
    assert.equal(status, 1, `变异 ${m.id} 后套件必须红（exit 1），实际 ${status}`);
    assert.deepEqual([...failedNames].sort(), [...m.red].sort(),
      `变异 ${m.id} 的失败集必须恰为预测集（${m.red.length} 条，无多余无遗漏）`);
  });
}

// selfcheck 测试：sc-p0b（五类环境自检 + fail-closed 反向变异）+ sc-p2c（--live 接线机器可检）。
// 组结构（变异红集预测依据）：
//   组 A「routing 域」——缺档夹具 exit 2 点名 e2e 且其余三档 PASS（枚举精确性）、
//                       合法夹具 exit 0、无 --routing-file 读 config routingPath、
//                       文件缺失 exit 2 点名路径、JSON 不可解析 exit 2 点名、
//                       agent/effort 越枚举 exit 2 点名、合法 JSON null（非对象）exit 2 点名而非 TypeError 崩溃
//   组 B「live 域」——--live 两处接线（symlink 指向本仓 + 触发行）输出 PASS；
//                       回归锚点：LIVE_LINK 推导与仓库嵌套深度无关（注入浅/深 root 恒同值）+ 与 cwd 无关（异 cwd 黑盒跑）；
//                       F-B 锚点：target 必须是仓根本身（嵌套子目录冒充 → FAIL 点名）
//   组 C「CLI 拒绝」——未知参数 exit 2
// 预测红集：挖掉「档缺失」分支 → 组 A 缺档用例红；挖掉 agent/effort 枚举校验 → 组 A 越枚举两用例红；
//           挖掉解析 try/catch 或文件读取 try/catch → 对应组 A 用例红（崩溃 exit≠2）；
//           挖掉 live-symlink / live-trigger-line 检查 → 组 B 对应断言红；
//           LIVE_LINK 改回 '../..' 猜层级 → 组B-1（主 checkout 上拼错路径）+ 组B-2（浅深 root 结果分叉）+ 组B-3（异 cwd 下仍按 repo 深度猜）红。组 C 恒绿。
//           F-B 变异（挖掉 show-toplevel 仓根校验）→ 恰好组B-4 负向用例红（冒充误 PASS）；组B-1/3（真实仓根）/组B-5（正向夹具）恒绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveLiveLink, checkLiveSymlink, checkTriggerLine, TRIGGER_LINE } from '../scripts/selfcheck.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'scripts/selfcheck.mjs');
const FIX = {
  missingE2e: join(root, 'tests/fixtures/routing-missing-e2e.json'),
  valid: join(root, 'tests/fixtures/routing-valid.json'),
};

function runSelfcheck(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: 'utf8' });
}
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// 临时注入夹具（JSON 形状合法/非法路由）——仅测试用，用完即清
function withTempRouting(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-routing-'));
  const file = join(dir, 'routing.json');
  try {
    writeFileSync(file, content, 'utf8');
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// F-B 临时 git 仓夹具（嵌套子目录冒充 / 仓根正向对照）——全部构造在 tmpdir，不碰真实接线位点
function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'selfcheck-live-'));
  try {
    const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`git init 失败: ${init.stderr}`);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('组A-1: 缺 e2e 档夹具 → exit 2 且点名 e2e 档缺失、其余三档仍 PASS', () => {
  const r = runSelfcheck(['--routing-file', FIX.missingE2e]);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  const text = out(r);
  assert.ok(text.includes('FAIL: routing-e2e'), `输出应点名 e2e 档，实际:\n${text}`);
  assert.ok(text.includes('档缺失'), `输出应含「档缺失」点名字样，实际:\n${text}`);
  for (const route of ['routing-execute', 'routing-review', 'routing-pr_merge']) {
    assert.ok(text.includes(`PASS: ${route}`), `其余档 ${route} 应保持 PASS，实际:\n${text}`);
  }
});

test('组A-2: 合法夹具 → exit 0', () => {
  const r = runSelfcheck(['--routing-file', FIX.valid]);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes('PASS: routing-e2e'), '合法夹具 e2e 档应 PASS');
});

test('组A-3: 无 --routing-file 时读 config 的 routingPath（真实环境全绿）→ exit 0', () => {
  const r = runSelfcheck([]);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
  const text = out(r);
  assert.ok(text.includes('PASS: routing-execute'), '应消费 config.routingPath 的真实 routing.json');
  assert.ok(text.includes('PASS: orca-fanout-worktree-ledger'), '② orca-fanout worktree-ledger 应 PASS');
  assert.ok(text.includes('PASS: orca-fanout-worktree-reclaim'), '② orca-fanout worktree-reclaim 应 PASS');
  assert.ok(text.includes('PASS: goal-skill-md'), '③ goal SKILL.md 应 PASS');
  assert.ok(text.includes('PASS: run-ledger-dir'), '④ runLedgerDir 应 PASS');
});

test('组A-4: --routing-file 指向不存在文件 → exit 2 且点名路径', () => {
  const missing = '/nonexistent/selfcheck-routing.json';
  const r = runSelfcheck(['--routing-file', missing]);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes(missing), `输出应点名缺失路径，实际:\n${out(r)}`);
});

test('组A-5: routing JSON 不可解析 → exit 2 且点名解析失败', () => {
  withTempRouting('{ "execute": {', (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('解析失败'), `输出应点名解析失败，实际:\n${out(r)}`);
  });
});

test('组A-6: agent 越枚举（不在 {codex, claude-code}）→ exit 2 且点名', () => {
  const body = JSON.stringify({
    execute: { agent: 'cobol', model: 'm', effort: 'max' },
    review: { agent: 'codex', model: 'm', effort: 'xhigh' },
    e2e: { agent: 'codex', model: 'm', effort: 'high' },
    pr_merge: { agent: 'claude-code', model: 'm', effort: 'medium' },
  });
  withTempRouting(body, (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('agent=cobol'), `输出应点名非法 agent 值，实际:\n${out(r)}`);
  });
});

test('组A-8: routing JSON 为合法 null（顶层非对象）→ exit 2 点名结构非法，不崩溃成 TypeError', () => {
  withTempRouting('null', (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('结构非法'), `输出应点名结构非法，实际:\n${out(r)}`);
    assert.ok(!out(r).includes('TypeError'), `不应以 TypeError 崩溃，实际:\n${out(r)}`);
  });
});

test('组A-7: effort 越六枚举 → exit 2 且点名', () => {
  const body = JSON.stringify({
    execute: { agent: 'claude-code', model: 'm', effort: 'turbo' },
    review: { agent: 'codex', model: 'm', effort: 'xhigh' },
    e2e: { agent: 'codex', model: 'm', effort: 'high' },
    pr_merge: { agent: 'claude-code', model: 'm', effort: 'medium' },
  });
  withTempRouting(body, (file) => {
    const r = runSelfcheck(['--routing-file', file]);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    assert.ok(out(r).includes('effort=turbo'), `输出应点名非法 effort 值，实际:\n${out(r)}`);
  });
});

test('组B-1: --live 接线两处（symlink 指向本仓 + 触发行）→ exit 0 且两项 PASS', () => {
  const r = runSelfcheck(['--live', '--routing-file', FIX.valid]);
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
    routingPath: 'routing.json',
    orcaFanoutScriptsRoot: '/capabilities/source/skills/claude-active/orca-fanout/scripts',
    runLedgerDir: '~/.claude/.orca/approve-exec',
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
test('组B-3: --live 在无关 cwd（tmpdir）下跑 → exit 0 且 live-symlink PASS（不依赖 process.cwd()）', () => {
  const r = spawnSync(process.execPath, [scriptPath, '--live', '--routing-file', FIX.valid], { cwd: tmpdir(), encoding: 'utf8' });
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

test('组C-1: 未知参数 → exit 2', () => {
  const r = runSelfcheck(['--bogus']);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
  assert.ok(out(r).includes('未知参数'), `输出应点名未知参数，实际:\n${out(r)}`);
});

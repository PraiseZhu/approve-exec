// run-tests.mjs 自身测试：sc-p0a「显式枚举」契约的机器检验。
// 断言对象：TEST_FILES 冻结数组 + checkEnumeration 双向校验 + 入口 exit code（黑盒 spawn，RUN_TESTS_DIR 注入夹具）。
// 组结构（变异红集预测依据）：
//   组 A「方向 A：枚举缺失」——夹具缺 1 个枚举文件 → exit 2 点名该文件，且不误报方向 B；
//   组 B「方向 B：顶层未枚举」——夹具多 1 个未枚举 *.test.mjs → exit 2 点名该文件，且不误报方向 A；
//   组 C「绿态」——夹具与枚举完全一致 → exit 0 且汇总行全绿。
// 预测红集：挖掉 checkEnumeration 的 missing 过滤 → 仅组A-1 红（方向 B 与绿态恒绿，隔离）；
//           挖掉 unenumerated 过滤 → 仅组B-1 红（方向 A 与绿态恒绿，隔离）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, symlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_FILES } from '../scripts/run-tests.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(root, 'scripts/run-tests.mjs');

// 黑盒：在夹具目录上跑入口（RUN_TESTS_DIR 覆盖 tests/ 路径），断言 exit code 与点名输出
function runOnFixture(dir) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RUN_TESTS_DIR: dir },
  });
}
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// 夹具：mkdtemp 下建 N 个占位 *.test.mjs（注释文件即可，校验在 spawn 之前拦截/放行），t 内用完即清
function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-fixture-'));
  try {
    for (const f of files) writeFileSync(join(dir, f), '// placeholder\n', 'utf8');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('组A-1: 枚举中有文件缺失 → exit 2 且点名该文件', () => {
  const missing = TEST_FILES[0];
  const rest = TEST_FILES.slice(1);
  withFixture(rest, (dir) => {
    const r = runOnFixture(dir);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    const text = out(r);
    assert.ok(text.includes(missing), `应点名缺失文件 ${missing}，实际:\n${text}`);
    assert.ok(text.includes('枚举的测试文件缺失'), `应含「缺失」点名字样，实际:\n${text}`);
  });
});

test('组A-2: 方向 A 触发时不误报方向 B（隔离）', () => {
  withFixture(TEST_FILES.slice(1), (dir) => {
    const r = runOnFixture(dir);
    assert.ok(!out(r).includes('未枚举'), `方向 A 场景不应出现方向 B 点名，实际:\n${out(r)}`);
  });
});

test('组B-1: tests/ 顶层存在未枚举的 *.test.mjs → exit 2 且点名该文件', () => {
  const extra = 'zzz-unenumerated.test.mjs';
  withFixture([...TEST_FILES, extra], (dir) => {
    const r = runOnFixture(dir);
    assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\n${out(r)}`);
    const text = out(r);
    assert.ok(text.includes(extra), `应点名未枚举文件 ${extra}，实际:\n${text}`);
    assert.ok(text.includes('未枚举'), `应含「未枚举」点名字样，实际:\n${text}`);
  });
});

test('组B-2: 方向 B 触发时不误报方向 A（隔离）', () => {
  const extra = 'zzz-unenumerated.test.mjs';
  withFixture([...TEST_FILES, extra], (dir) => {
    const r = runOnFixture(dir);
    assert.ok(!out(r).includes('缺失'), `方向 B 场景不应出现方向 A 点名，实际:\n${out(r)}`);
  });
});

test('组C-1: 夹具与枚举完全一致 → exit 0 且汇总行全绿', () => {
  withFixture(TEST_FILES, (dir) => {
    const r = runOnFixture(dir);
    assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${out(r)}`);
    assert.ok(
      out(r).includes(`${TEST_FILES.length} file(s) run, all pass (exit 0)`),
      `应含全绿汇总行，实际:\n${out(r)}`
    );
  });
});

// ============ 组 F：main guard realpath 归一（与 selfcheck 组F-1 / mem-probe 组F-1 同型） ============
// 前提：import.meta.url 已被 ESM loader 规范化（realpath 后的真实路径），而 process.argv[1] 是调用方
// 原样路径。macOS 上 os.tmpdir() 落在 /var/folders/...（/var → /private/var symlink），以逻辑 /var 路径
// 调用时两者恒不相等——旧 guard 会让 main 静默不执行（exit 0 + 零输出，与「全绿汇总行」同形）。
// 本用例断言：非规范化路径调用必须真的跑完并输出汇总行；只断言 exit code 会被「零输出」骗过。
test('组F-1: 非规范化路径调用必须实际执行并输出汇总行（main guard realpath 归一）', (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'run-tests-norm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 保持 <root>/scripts/run-tests.mjs 布局：脚本 root = dirname(import.meta.url) + '..'，
  // 平铺放置会让 root 解析到临时根层（与 guard 无关地行为走样）
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(root, 'scripts/run-tests.mjs'), join(dir, 'scripts/run-tests.mjs'));
  // link 名必须唯一：历史用 process.pid，进程被杀时 t.after 未注册 → link-<PID> 残留；
  // 宿主并发下 PID 复用即撞名 EEXIST（实测 tmpdir 积上千残留，多次假红根因）。
  // dir 名来自 mkdtemp 唯一，用它派生 link 名——残留永不撞名，非规范化语义不变。
  const link = join(realpathSync(tmpdir()), `run-tests-norm-link-${basename(dir)}`);
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  assert.notEqual(realpathSync(link), link, '前置条件: 调用路径必须非规范化（否则本用例空转）');
  // RUN_TESTS_DIR 注入占位夹具（组A/B/C 同款）：枚举一致性通过 → main 真正执行 → 输出全绿汇总行
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'run-tests-norm-fixture-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const f of TEST_FILES) writeFileSync(join(fixture, f), '// placeholder\n', 'utf8');
  const r = spawnSync(process.execPath, [join(link, 'scripts/run-tests.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RUN_TESTS_DIR: fixture },
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  assert.ok(text.length > 0, '非规范化路径调用不得静默零输出（guard 被 bypass 的形态就是 exit 0 + 全空）');
  assert.ok(text.includes(`${TEST_FILES.length} file(s) run, all pass (exit 0)`),
    `非规范化路径调用必须真正执行并输出全绿汇总行，实际:\n${text}`);
  assert.equal(r.status, 0, `期望 exit 0，实际 ${r.status}\n${text}`);
});

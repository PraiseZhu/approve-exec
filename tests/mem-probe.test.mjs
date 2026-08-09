// mem-probe 测试：sc-p1a（换算/分支/入参校验）+ sc-p1b（fail-closed 反向变异）+ 组F（main guard realpath 归一）。
// 组结构（sc-p1b 变异红集预测依据）：
//   组 A「换算/函数域」——有效夹具换算、三个 min 分支约束主体、floor 语义、无负数、内存真不足 concurrency=0 合法、
//                       computeConcurrency 入参拒绝（含 platformCap 正整数）、parseVmStat 输入类型守卫、CLI 端到端、
//                       同夹具两次输出逐字相同、非 JSON 摘要输出、CLI 帮助出口（--help/-h exit 0）
//   组 B「CLI 参数拒绝」——CLI 侧 --used-slots/--pending/未知参数/缺失参数/文件缺失
//   组 C「fail-closed 解析拒绝」——乱码/缺 Pages free/inactive/speculative/首行无 page size/
//                       page size 非法(0)/数字字段尾界畸形（千分位、单位后缀、数字中间字母、负数、行尾垃圾、
//                       page size 小数）：
//                       parseVmStat 点名 throw；CLI exit 2 并点名缺失字段，绝不回退默认换算
//   组 F「main guard realpath」——非规范化路径调用必须真的执行并打印 JSON（防 exit 0 + 零输出假绿）
// 预测红集（变异1 挖掉 parseVmStat 内容字段校验分支后）= 恰好组 C 全部测试（原 11 条 + 尾界畸形 6 条）；
//   变异2 挖掉两处 Number.isSafeInteger 后 = 恰好 2 条 F-A 标题。组 A/B/F 必须仍绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVmStat, computeConcurrency } from '../scripts/mem-probe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaults = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));
const { orcaPlatformCap, memReserveRatio, perWorkerBytes } = defaults;
const scriptPath = join(root, 'scripts/mem-probe.mjs');
const FIX = {
  '64g': join(root, 'tests/fixtures/vm-stat-64g.txt'),
  '4k': join(root, 'tests/fixtures/vm-stat-4k-page.txt'),
  corrupt: join(root, 'tests/fixtures/vm-stat-corrupt.txt'),
};
const FIX64_TEXT = readFileSync(FIX['64g'], 'utf8');
const FIX4K_TEXT = readFileSync(FIX['4k'], 'utf8');
const FIX_CORRUPT_TEXT = readFileSync(FIX.corrupt, 'utf8');

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

function withTempVmStat(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mem-probe-test-'));
  const p = join(dir, 'vm-stat.txt');
  writeFileSync(p, content);
  try {
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============ 组 A：换算 / 函数域（预测：变异下仍绿） ============

test('换算: 64GB 夹具 parseVmStat——page_size 16384、三行页面数正确、available≈35.5GB', () => {
  const n = parseVmStat(FIX64_TEXT);
  assert.equal(n.pageSize, 16384);
  assert.equal(n.freePages, 700000);
  assert.equal(n.inactivePages, 1300000);
  assert.equal(n.speculativePages, 168000);
  const available = (n.freePages + n.inactivePages + n.speculativePages) * n.pageSize;
  assert.equal(available, 35520512000, 'available_bytes 必须逐字等于 (700000+1300000+168000)×16384');
  assert.ok(Math.abs(available / 1e9 - 35.5) < 0.1, '64GB 样例 available≈35.5GB（十进制 GB）');
});

test('换算: page_size 4096 夹具换算正确', () => {
  const n = parseVmStat(FIX4K_TEXT);
  assert.equal(n.pageSize, 4096);
  const available = (n.freePages + n.inactivePages + n.speculativePages) * n.pageSize;
  assert.equal(available, 7168000000, '(1000000+500000+250000)×4096');
});

test('换算: 内存紧——内存预算分支为约束主体', () => {
  // mem = floor(1e9×0.8/524288000) = floor(1.5258…) = 1；slots = 8−0 = 8；pending = 10
  const r = computeConcurrency({
    availableBytes: 1_000_000_000,
    usedSlots: 0,
    pendingGroups: 10,
    platformCap: orcaPlatformCap,
    perWorkerBytes,
    reserveRatio: memReserveRatio,
  });
  assert.equal(r, 1, '内存分支 ⌊1e9×0.8/perWorkerBytes⌋=1 必须成为约束主体');
  assert.ok(1 < orcaPlatformCap && 1 < 10, '内存分支严格小于另外两分支，min 无歧义');
});

test('换算: 槽位紧——platform_cap−used_slots 分支为约束主体', () => {
  // mem = floor(3e10×0.8/524288000) = floor(45.77…) = 45；slots = 8−5 = 3；pending = 100
  const r = computeConcurrency({
    availableBytes: 30_000_000_000,
    usedSlots: 5,
    pendingGroups: 100,
    platformCap: orcaPlatformCap,
    perWorkerBytes,
    reserveRatio: memReserveRatio,
  });
  assert.equal(r, 3, '槽位分支 platform_cap−used_slots=3 必须成为约束主体');
  assert.ok(3 < 45 && 3 < 100, '槽位分支严格小于另外两分支，min 无歧义');
});

test('换算: 待派少——pending_groups 分支为约束主体', () => {
  // 64GB 夹具派生 mem = floor(35520512000×0.8/524288000) = 54；slots = 8−0 = 8；pending = 2
  const r = computeConcurrency({
    availableBytes: 35_520_512_000,
    usedSlots: 0,
    pendingGroups: 2,
    platformCap: orcaPlatformCap,
    perWorkerBytes,
    reserveRatio: memReserveRatio,
  });
  assert.equal(r, 2, '待派分支 pending_groups=2 必须成为约束主体');
  assert.ok(2 < 54 && 2 < orcaPlatformCap, '待派分支严格小于另外两分支，min 无歧义');
});

test('换算: ⌊⌋ 向下取整语义被钉死（1.5258… → 1，不四舍五入、不取整成 2）', () => {
  const r = computeConcurrency({
    availableBytes: 1_000_000_000,
    usedSlots: 0,
    pendingGroups: 100,
    platformCap: 100,
    perWorkerBytes,
    reserveRatio: memReserveRatio,
  });
  assert.equal(r, 1);
});

test('换算: concurrency 不出现负数——used_slots 超 cap / 内存 0 / 待派 0 三种降为 0', () => {
  const base = { platformCap: orcaPlatformCap, perWorkerBytes, reserveRatio: memReserveRatio };
  // 槽位分支为负：slots = 8−10 = −2 → min 取负 → max(0,·) = 0
  assert.equal(computeConcurrency({ ...base, availableBytes: 35_520_512_000, usedSlots: 10, pendingGroups: 100 }), 0);
  // 内存分支为 0：available=0 → mem=0
  assert.equal(computeConcurrency({ ...base, availableBytes: 0, usedSlots: 0, pendingGroups: 5 }), 0);
  // 待派分支为 0
  assert.equal(computeConcurrency({ ...base, availableBytes: 35_520_512_000, usedSlots: 0, pendingGroups: 0 }), 0);
});

test('函数域: computeConcurrency 拒绝非法入参（与 CLI 同等拒绝，不存在 in-process 绕过）', () => {
  const valid = {
    availableBytes: 35_520_512_000,
    usedSlots: 0,
    pendingGroups: 5,
    platformCap: orcaPlatformCap,
    perWorkerBytes,
    reserveRatio: memReserveRatio,
  };
  const bad = [
    { ...valid, usedSlots: -1 },
    { ...valid, usedSlots: 1.5 },
    { ...valid, usedSlots: '3' },
    { ...valid, usedSlots: NaN },
    { ...valid, usedSlots: Infinity },
    { ...valid, pendingGroups: -1 },
    { ...valid, pendingGroups: 2.5 },
    { ...valid, pendingGroups: Infinity },
    { ...valid, platformCap: -1 },
    { ...valid, platformCap: 0 },
    { ...valid, perWorkerBytes: 0 },
    { ...valid, perWorkerBytes: -100 },
    { ...valid, reserveRatio: 0 },
    { ...valid, reserveRatio: 1 },
    { ...valid, reserveRatio: 1.5 },
    { ...valid, availableBytes: -1 },
    { ...valid, availableBytes: NaN },
  ];
  for (const p of bad) {
    assert.throws(() => computeConcurrency(p), TypeError, `非法入参必须被拒绝: ${JSON.stringify(p)}`);
  }
});

test('函数域: parseVmStat 拒绝非字符串输入', () => {
  assert.throws(() => parseVmStat(123), TypeError);
  assert.throws(() => parseVmStat(undefined), TypeError);
});

// ② 回归锚点：concurrency=0 在内存真不足时是合法输出（审查席实测 available=16384 时 concurrency=0）。
// 要拒的是「配置非法」（platformCap 非正整数，见组A bad 数组），不是拒绝 0 这个值。
// available=16384 → mem 分支 floor(16384×0.8/perWorkerBytes)=0 → min(0, 8, 5)=0 → concurrency=0 且 exit 0。
test('换算: 内存真不足（available=16384B）→ concurrency=0 且 CLI exit 0（合法 0，非配置错误）', () => {
  const r = computeConcurrency({
    availableBytes: 16384,
    usedSlots: 0,
    pendingGroups: 5,
    platformCap: orcaPlatformCap,
    perWorkerBytes,
    reserveRatio: memReserveRatio,
  });
  assert.equal(r, 0, '内存真不足时 concurrency=0 必须合法返回');
  const tiny = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\nPages inactive: 0.\nPages speculative: 0.\n';
  withTempVmStat(tiny, (p) => {
    const cli = runCli(['--json', '--used-slots', '0', '--pending', '5', '--vm-stat-file', p]);
    assert.equal(cli.status, 0, `内存真不足必须 exit 0（合法 concurrency=0），stderr: ${cli.stderr}`);
    const out = JSON.parse(cli.stdout);
    assert.equal(out.available_bytes, 16384);
    assert.equal(out.concurrency, 0);
  });
});

test('CLI 端到端: 64GB 夹具 --json 输出九键齐备、数值来自 config 与夹具', () => {
  const r = runCli(['--json', '--used-slots', '0', '--pending', '5', '--vm-stat-file', FIX['64g']]);
  assert.equal(r.status, 0, `CLI 必须 exit 0，stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), [
    'page_size',
    'total_bytes',
    'available_bytes',
    'used_slots',
    'platform_cap',
    'per_worker_bytes',
    'reserve_ratio',
    'pending_groups',
    'concurrency',
  ]);
  assert.equal(out.page_size, 16384);
  assert.equal(out.available_bytes, 35520512000);
  assert.equal(out.used_slots, 0);
  assert.equal(out.platform_cap, orcaPlatformCap, 'platform_cap 必须来自 config/defaults.json');
  assert.equal(out.per_worker_bytes, perWorkerBytes, 'per_worker_bytes 必须来自 config/defaults.json');
  assert.equal(out.reserve_ratio, memReserveRatio, 'reserve_ratio 必须来自 config/defaults.json');
  assert.equal(out.pending_groups, 5);
  assert.equal(out.concurrency, 5, 'min(⌊35520512000×0.8/perWorker⌋=54, 8−0, 5) = 5');
  // total_bytes 由 live sysctl 提供（同一来源比较，验证接线而非硬编码）
  const live = Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim());
  assert.equal(out.total_bytes, live);
  assert.ok(Number.isSafeInteger(out.total_bytes) && out.total_bytes > 0);
});

test('CLI 确定性: 同一夹具输入两次输出逐字相同', () => {
  const args = ['--json', '--used-slots', '0', '--pending', '5', '--vm-stat-file', FIX['64g']];
  const a = runCli(args);
  const b = runCli(args);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(a.stdout, b.stdout, '两次运行输出必须逐字相同');
});

test('CLI 摘要: 不带 --json 输出单行摘要并 exit 0', () => {
  const r = runCli(['--used-slots', '0', '--pending', '5', '--vm-stat-file', FIX['64g']]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /concurrency=5/);
});

test('CLI 帮助: --help / -h 单独调用 exit 0 并打印用法（不被必填参数校验拦截）', () => {
  for (const flag of ['--help', '-h']) {
    const r = runCli([flag]);
    assert.equal(r.status, 0, `${flag} 必须 exit 0，stderr: ${r.stderr}`);
    assert.match(r.stderr, /用法:/, `${flag} 必须打印用法`);
  }
});

// ============ 组 B：CLI 参数拒绝（预测：变异下仍绿） ============

// F-A 回归锚点（gpt 审查席 F-A：CLI 与导出函数拒绝契约不等价——400 位数字串 Number() 得 Infinity，
// 旧实现未捕获 TypeError、exit 1 裸栈崩溃，且 JSON.stringify(Infinity) 把消息显示成 null）。
// 预测红集：挖掉 parseArgs 的 Number.isSafeInteger 校验 → 本用例 /安全整数/ 断言红；
//           再挖掉 main 的 computeConcurrency try/catch → status 断言红（exit 1 崩溃）。
test('CLI 参数拒绝(F-A): --used-slots 400 位数字 → exit 2 点名安全整数范围，不落 exit 1 裸栈', () => {
  const huge = '9'.repeat(400);
  const r = runCli(['--json', '--used-slots', huge, '--pending', '1', '--vm-stat-file', FIX['64g']]);
  assert.equal(r.status, 2, `400 位数字必须受控 exit 2（而非 exit 1 崩溃），stderr: ${r.stderr}`);
  assert.match(r.stderr, /安全整数/, `stderr 必须点名安全整数范围，实际: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /TypeError/, `不得以 TypeError 裸栈崩溃，实际: ${r.stderr}`);
});

test('CLI 参数拒绝(F-A): --pending 400 位数字 → exit 2 点名安全整数范围', () => {
  const huge = '9'.repeat(400);
  const r = runCli(['--json', '--used-slots', '0', '--pending', huge, '--vm-stat-file', FIX['64g']]);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /安全整数/, `stderr 必须点名安全整数范围，实际: ${r.stderr}`);
});

test('CLI 参数拒绝: --used-slots 负数 / 非数字 / 小数 → exit 2', () => {
  for (const bad of ['-1', 'abc', '1.5']) {
    const r = runCli(['--json', '--used-slots', bad, '--pending', '1', '--vm-stat-file', FIX['64g']]);
    assert.equal(r.status, 2, `--used-slots ${bad} 必须 exit 2`);
    assert.match(r.stderr, /非负整数/);
  }
});

test('CLI 参数拒绝: --pending 负数 / 非数字 / 小数 → exit 2', () => {
  for (const bad of ['-1', 'xyz', '1.5']) {
    const r = runCli(['--json', '--used-slots', '0', '--pending', bad, '--vm-stat-file', FIX['64g']]);
    assert.equal(r.status, 2, `--pending ${bad} 必须 exit 2`);
    assert.match(r.stderr, /非负整数/);
  }
});

test('CLI 参数拒绝: 未知参数 / 缺少 --used-slots / --vm-stat-file 不存在 → exit 2', () => {
  const unknown = runCli(['--json', '--used-slots', '0', '--pending', '1', '--bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知参数/);

  const missing = runCli(['--json', '--pending', '1']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /缺少 --used-slots/);

  const noFile = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', '/nonexistent/mem-probe-vm-stat.txt']);
  assert.equal(noFile.status, 2);
  assert.match(noFile.stderr, /不存在/);
});

// ============ 组 C：fail-closed 解析拒绝（预测：变异下恰好全红） ============

test('fail-closed: parseVmStat 乱码输入 → throw 并点名 page size', () => {
  assert.throws(() => parseVmStat('garbage output\nno pages here at all\n'), /page size/);
});

test('fail-closed: parseVmStat 首行无 page size → throw 并点名 page size', () => {
  assert.throws(() => parseVmStat('Mach Virtual Memory Statistics: (page size of )\nPages free: 100.\n'), /page size/);
});

test('fail-closed: parseVmStat page size 为 0（正则命中但非法）→ throw 并点名 page size', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 0 bytes)\nPages free: 100.\nPages inactive: 50.\nPages speculative: 10.\n';
  assert.throws(() => parseVmStat(text), /page size/);
});

test('fail-closed: parseVmStat 缺 Pages free 行 → throw 并点名 Pages free', () => {
  assert.throws(() => parseVmStat(FIX_CORRUPT_TEXT), /Pages free/);
});

test('fail-closed: parseVmStat 缺 Pages inactive 行 → throw 并点名 Pages inactive', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages speculative: 50.\n';
  assert.throws(() => parseVmStat(text), /Pages inactive/);
});

test('fail-closed: parseVmStat 缺 Pages speculative 行 → throw 并点名 Pages speculative', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 50.\n';
  assert.throws(() => parseVmStat(text), /Pages speculative/);
});

test('fail-closed: CLI 对缺 Pages free 行夹具 exit 2 并点名缺失字段（绝不回退默认换算）', () => {
  const r = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', FIX.corrupt]);
  assert.equal(r.status, 2, '解析失败必须 exit 2');
  assert.match(r.stderr, /Pages free/, 'stderr 必须点名缺失字段');
  assert.doesNotMatch(r.stderr, /concurrency/);
});

test('fail-closed: CLI 对乱码 vm_stat exit 2 并点名 page size', () => {
  withTempVmStat('garbage output\nno pages here\n', (p) => {
    const r = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /page size/);
  });
});

test('fail-closed: CLI 对缺 Pages free 行文本 exit 2 并点名 Pages free', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages inactive: 50.\n';
  withTempVmStat(text, (p) => {
    const r = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Pages free/);
  });
});

test('fail-closed: CLI 对 page size 为 0 的文本 exit 2 并点名 page size', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 0 bytes)\nPages free: 100.\nPages inactive: 50.\nPages speculative: 10.\n';
  withTempVmStat(text, (p) => {
    const r = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /page size/);
  });
});

test('fail-closed: CLI 对缺 Pages inactive 行文本 exit 2 并点名 Pages inactive', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages speculative: 50.\n';
  withTempVmStat(text, (p) => {
    const r = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', p]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Pages inactive/);
  });
});

// ============ 组 C 扩展：① 数字字段尾界畸形（审查席实证：旧正则无尾界，千分位/单位后缀被静默截断当正常数据用） ============
// 旧实现 `^Pages label:\s+(\d+)` 无尾界：`1,000.` 截成 1、`100 pages.` 截成 100——下游拿到错了三个数量级的
// 内存值且毫无信号。修复后整行锚定 `^Pages label:\s+(\d+)\.\s*$`，以下六种畸形（含 page size）必须全部拒绝。
// 均为组 C 成员：变异1（挖 parseVmStat 内容校验）后恰好全红。

function assertMalformedRejected(text, namePattern) {
  assert.throws(() => parseVmStat(text), namePattern, `parseVmStat 必须 throw 并点名，输入: ${JSON.stringify(text.split('\n')[1] ?? text)}`);
  withTempVmStat(text, (p) => {
    const r = runCli(['--json', '--used-slots', '0', '--pending', '1', '--vm-stat-file', p]);
    assert.equal(r.status, 2, `CLI 必须 exit 2（不得静默截断后当正常数据用），stderr: ${r.stderr}`);
    assert.match(r.stderr, namePattern);
  });
}

test('fail-closed: Pages 数字千分位 1,000. → throw 并点名 Pages free（旧实现静默截成 1）', () => {
  assertMalformedRejected(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1,000.\nPages inactive: 500.\nPages speculative: 100.\n',
    /Pages free/,
  );
});

test('fail-closed: Pages 数字单位后缀 100 pages. → throw 并点名 Pages free（旧实现静默截成 100）', () => {
  assertMalformedRejected(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100 pages.\nPages inactive: 500.\nPages speculative: 100.\n',
    /Pages free/,
  );
});

test('fail-closed: Pages 数字中间字母 10a0. → throw 并点名 Pages free', () => {
  assertMalformedRejected(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10a0.\nPages inactive: 500.\nPages speculative: 100.\n',
    /Pages free/,
  );
});

test('fail-closed: Pages 数字负数 -100. → throw 并点名 Pages free', () => {
  assertMalformedRejected(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: -100.\nPages inactive: 500.\nPages speculative: 100.\n',
    /Pages free/,
  );
});

test('fail-closed: Pages 行尾多余内容 100. trailing → throw 并点名 Pages free', () => {
  assertMalformedRejected(
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100. trailing\nPages inactive: 500.\nPages speculative: 100.\n',
    /Pages free/,
  );
});

test('fail-closed: page size 数字带小数 16384.0 → throw 并点名 page size', () => {
  assertMalformedRejected(
    'Mach Virtual Memory Statistics: (page size of 16384.0 bytes)\nPages free: 100.\nPages inactive: 500.\nPages speculative: 100.\n',
    /page size/,
  );
});

// ============ 组 F：main guard realpath 归一（③，与 selfcheck 组F-1 同型） ============
// 前提：import.meta.url 已被 ESM loader 规范化，而 process.argv[1] 是调用方原样路径——macOS 上
// /var → /private/var 这类 symlink 会让两者恒不相等，旧 guard 让 main 静默不执行（exit 0 + 零输出）。
// 本用例断言：非规范化路径调用必须真的打印 JSON。只断言 exit code 会被「零输出」骗过。
test('组F-1: 非规范化路径调用必须实际执行并打印 JSON（main guard realpath 归一）', (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'mem-probe-norm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 保持 <root>/scripts/mem-probe.mjs 布局：脚本 root = dirname(import.meta.url) + '..'
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  cpSync(join(root, 'scripts/mem-probe.mjs'), join(dir, 'scripts/mem-probe.mjs'));
  writeFileSync(join(dir, 'config/defaults.json'), readFileSync(join(root, 'config/defaults.json'), 'utf8'));
  const link = join(realpathSync(tmpdir()), `mem-probe-norm-link-${process.pid}`);
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  assert.notEqual(realpathSync(link), link, '前置条件: 调用路径必须非规范化（否则本用例空转）');
  const r = spawnSync(process.execPath,
    [join(link, 'scripts/mem-probe.mjs'), '--json', '--used-slots', '0', '--pending', '5', '--vm-stat-file', FIX['64g']],
    { encoding: 'utf8' });
  assert.ok(r.stdout.length > 0, '非规范化路径调用不得静默零输出（guard 被 bypass 的形态就是 exit 0 + 全空）');
  assert.ok(r.stdout.includes('"page_size"'), `非规范化路径调用必须真的打印 JSON，实际 stdout:\n${r.stdout}`);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});

// ---------- 变异反证（sc-p1b）：把「只写在注释里的变异反证」变成可执行 harness ----------
// 机制与 selfcheck 同款：把 scripts/config/tests/fixtures 复制到 realpath(tmpdir) 下（保证子套件对脚本副本的
// 调用路径已规范化，修复后的 main guard 不误伤——tmpdir() 的 /var 逻辑路径本身会触发被挖掉的旧 guard），
// 对副本应用变异，跑「跳过变异测试自身」的完整套件，断言失败集恰为预测集。
// 防递归：子套件经 MP_MUTATION_CHILD 环境变量标记（ready-check 用 RC_MUTATION_CHILD，selfcheck 用 SC_MUTATION_CHILD）。
// 变异1 预测红集 = 组 C 全部（原 11 条 + 尾界畸形 6 条，审查席手工验证原 11 条预测正确）；
// 变异2 预测红集 = 2 条 F-A 标题（审查席手工验证挖两处 Number.isSafeInteger → 恰红 2 条）。
const MEM_PROBE_MUTATIONS = [
  {
    id: '变异1',
    label: 'parseVmStat 内容字段校验被挖',
    from: `  const n = extractVmStatNumbers(text);
  const firstLine = String(text).split('\\n')[0] ?? '';
  const pageSizeMatch = firstLine.match(PAGE_SIZE_RE);
  if (!pageSizeMatch) {
    throw new Error(
      \`vm_stat 首行缺少 page size（形如 "Mach Virtual Memory Statistics: (page size of 16384 bytes)"），收到: \${JSON.stringify(firstLine)}\`,
    );
  }
  if (!Number.isInteger(n.pageSize) || n.pageSize <= 0) {
    throw new Error(\`vm_stat 首行 page size 非法: \${JSON.stringify(firstLine)}\`);
  }
  const fields = [
    ['freePages', 'Pages free'],
    ['inactivePages', 'Pages inactive'],
    ['speculativePages', 'Pages speculative'],
  ];
  for (const [key, label] of fields) {
    if (!Number.isInteger(n[key]) || n[key] < 0) {
      throw new Error(\`vm_stat 缺少或非法 \${label} 行\`);
    }
  }
  return n;
}`,
    to: `  const n = extractVmStatNumbers(text);
  return n;
}`,
    red: [
      'fail-closed: parseVmStat 乱码输入 → throw 并点名 page size',
      'fail-closed: parseVmStat 首行无 page size → throw 并点名 page size',
      'fail-closed: parseVmStat page size 为 0（正则命中但非法）→ throw 并点名 page size',
      'fail-closed: parseVmStat 缺 Pages free 行 → throw 并点名 Pages free',
      'fail-closed: parseVmStat 缺 Pages inactive 行 → throw 并点名 Pages inactive',
      'fail-closed: parseVmStat 缺 Pages speculative 行 → throw 并点名 Pages speculative',
      'fail-closed: CLI 对缺 Pages free 行夹具 exit 2 并点名缺失字段（绝不回退默认换算）',
      'fail-closed: CLI 对乱码 vm_stat exit 2 并点名 page size',
      'fail-closed: CLI 对缺 Pages free 行文本 exit 2 并点名 Pages free',
      'fail-closed: CLI 对 page size 为 0 的文本 exit 2 并点名 page size',
      'fail-closed: CLI 对缺 Pages inactive 行文本 exit 2 并点名 Pages inactive',
      'fail-closed: Pages 数字千分位 1,000. → throw 并点名 Pages free（旧实现静默截成 1）',
      'fail-closed: Pages 数字单位后缀 100 pages. → throw 并点名 Pages free（旧实现静默截成 100）',
      'fail-closed: Pages 数字中间字母 10a0. → throw 并点名 Pages free',
      'fail-closed: Pages 数字负数 -100. → throw 并点名 Pages free',
      'fail-closed: Pages 行尾多余内容 100. trailing → throw 并点名 Pages free',
      'fail-closed: page size 数字带小数 16384.0 → throw 并点名 page size',
    ],
  },
  {
    id: '变异2',
    label: '两处 Number.isSafeInteger 校验被挖（F-A 回归锚点）',
    from: 'if (!Number.isSafeInteger(n)) {',
    to: 'if (false && !Number.isSafeInteger(n)) {',
    red: [
      'CLI 参数拒绝(F-A): --used-slots 400 位数字 → exit 2 点名安全整数范围，不落 exit 1 裸栈',
      'CLI 参数拒绝(F-A): --pending 400 位数字 → exit 2 点名安全整数范围',
    ],
  },
];

function copyTreeForMutation(t, mutateScript) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'mem-probe-mut-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'tests'));
  mkdirSync(join(dir, 'config'));
  mkdirSync(join(dir, 'tests/fixtures'));
  const src = readFileSync(join(root, 'scripts/mem-probe.mjs'), 'utf8');
  const mutated = mutateScript(src);
  assert.notEqual(mutated, src, '变异必须实际改变脚本内容（防替换静默空转）');
  writeFileSync(join(dir, 'scripts/mem-probe.mjs'), mutated);
  writeFileSync(join(dir, 'tests/mem-probe.test.mjs'), readFileSync(join(root, 'tests/mem-probe.test.mjs'), 'utf8'));
  writeFileSync(join(dir, 'tests/fixtures/vm-stat-64g.txt'), readFileSync(FIX['64g'], 'utf8'));
  writeFileSync(join(dir, 'tests/fixtures/vm-stat-4k-page.txt'), readFileSync(FIX['4k'], 'utf8'));
  writeFileSync(join(dir, 'tests/fixtures/vm-stat-corrupt.txt'), readFileSync(FIX.corrupt, 'utf8'));
  writeFileSync(join(dir, 'config/defaults.json'), readFileSync(join(root, 'config/defaults.json'), 'utf8'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'tests/mem-probe.test.mjs');
}

function runMutatedSuite(testFile, dir) {
  const { NODE_TEST_CONTEXT: _drop, ...childEnv } = process.env;
  const r = spawnSync(process.execPath, ['--test', testFile],
    { cwd: dir, encoding: 'utf8', env: { ...childEnv, MP_MUTATION_CHILD: '1' } });
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

for (const m of MEM_PROBE_MUTATIONS) {
  test(`mutation-kill: ${m.id} ${m.label} 被挖 → 恰红预测用例，失败模式隔离`, (t) => {
    if (process.env.MP_MUTATION_CHILD === '1') { t.skip('子套件运行跳过变异测试（防递归）'); return; }
    const testFile = copyTreeForMutation(t, (src) => src.split(m.from).join(m.to));
    const { status, failedNames } = runMutatedSuite(testFile, dirname(testFile));
    assert.equal(status, 1, `变异 ${m.id} 后套件必须红（exit 1），实际 ${status}`);
    assert.deepEqual([...failedNames].sort(), [...m.red].sort(),
      `变异 ${m.id} 的失败集必须恰为预测集（${m.red.length} 条，无多余无遗漏）`);
  });
}

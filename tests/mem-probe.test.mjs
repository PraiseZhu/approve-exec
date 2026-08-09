// mem-probe 测试：sc-p1a（换算/分支/入参校验）+ sc-p1b（fail-closed 反向变异）。
// 组结构（sc-p1b 变异红集预测依据）：
//   组 A「换算/函数域」——有效夹具换算、三个 min 分支约束主体、floor 语义、无负数、
//                       computeConcurrency 入参拒绝、parseVmStat 输入类型守卫、CLI 端到端、
//                       同夹具两次输出逐字相同、非 JSON 摘要输出、CLI 帮助出口（--help/-h exit 0）
//   组 B「CLI 参数拒绝」——CLI 侧 --used-slots/--pending/未知参数/缺失参数/文件缺失
//   组 C「fail-closed 解析拒绝」——乱码/缺 Pages free/inactive/speculative/首行无 page size/
//                       page size 非法(0)：
//                       parseVmStat 点名 throw；CLI exit 2 并点名缺失字段，绝不回退默认换算
// 预测红集（挖掉 parseVmStat 内容字段校验分支后）= 恰好组 C 全部测试；组 A/B 必须仍绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
    { ...valid, pendingGroups: -1 },
    { ...valid, pendingGroups: 2.5 },
    { ...valid, platformCap: -1 },
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

#!/usr/bin/env node
// mem-probe —— 内存探针：并发决策只由「实测内存 + config 配置 + 调用方声明的槽位状态」派生。
// 并发公式（sc-p1a）：
//   available_bytes = (Pages free + inactive + speculative) × page_size        （vm_stat 实测）
//   concurrency     = max(0, min(⌊available×(1−reserve_ratio)/per_worker_bytes⌋,
//                                platform_cap − used_slots,
//                                pending_groups))
// 三个 min 分支依次为：内存预算约束 / Orca 平台槽位约束 / 待派组数约束。
// 数值一律从 config/defaults.json 读（本文件内禁止再写字面量）；
// page_size 从 vm_stat 首行解析（不硬编码 16384）。
// --used-slots 语义：全部活跃 worker 数——执行/审查/验收席共享同一 Orca 槽位池，
// 不分阶段分池；跨阶段并行时按同池计数，防超发。
//
// fail-closed（sc-p1b）：vm_stat 输出乱码 / 缺 Pages 行 / 首行无 page size → 点名缺失字段并
// exit 2，绝不回退到任何默认换算。「解析失败不编数」由反向变异测试反证保障。
//
// 用法：
//   node scripts/mem-probe.mjs --json --used-slots <N> --pending <N> [--vm-stat-file <path>]
//   --vm-stat-file 注入夹具文本供确定性测试；缺省时现场执行 `vm_stat`。
//   total_bytes 现场读取 `sysctl -n hw.memsize`（本机 68719476736）。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));

// —— 纯提取：不校验，任何输入都返回数值（缺失字段为 NaN）。校验在 parseVmStat 分支内。 ——
function extractVmStatNumbers(text) {
  const lines = String(text).split('\n');
  const firstLine = lines[0] ?? '';
  const pageSizeMatch = firstLine.match(/page size of (\d+) bytes/);
  const pageSize = Number(pageSizeMatch?.[1]);
  const grab = (label) => {
    const m = text.match(new RegExp(`^Pages ${label}:\\s+(\\d+)`, 'm'));
    return Number(m?.[1]);
  };
  return {
    pageSize,
    freePages: grab('free'),
    inactivePages: grab('inactive'),
    speculativePages: grab('speculative'),
  };
}

// —— 解析校验分支（fail-closed，反向变异测试的挖除目标）： ——
// 任一关键字段缺失/非法 → 点名 throw；绝不回退默认换算。挖掉本分支 = 解析失败不编数失去保障。
export function parseVmStat(text) {
  if (typeof text !== 'string') {
    throw new TypeError('vm_stat 输入必须是字符串');
  }
  const n = extractVmStatNumbers(text);
  const firstLine = String(text).split('\n')[0] ?? '';
  const pageSizeMatch = firstLine.match(/page size of (\d+) bytes/);
  if (!pageSizeMatch) {
    throw new Error(
      `vm_stat 首行缺少 page size（形如 "Mach Virtual Memory Statistics: (page size of 16384 bytes)"），收到: ${JSON.stringify(firstLine)}`,
    );
  }
  if (!Number.isInteger(n.pageSize) || n.pageSize <= 0) {
    throw new Error(`vm_stat 首行 page size 非法: ${JSON.stringify(firstLine)}`);
  }
  const fields = [
    ['freePages', 'Pages free'],
    ['inactivePages', 'Pages inactive'],
    ['speculativePages', 'Pages speculative'],
  ];
  for (const [key, label] of fields) {
    if (!Number.isInteger(n[key]) || n[key] < 0) {
      throw new Error(`vm_stat 缺少或非法 ${label} 行`);
    }
  }
  return n;
}

function assertNonNegInt(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new TypeError(`${name} 必须为非负整数，收到 ${JSON.stringify(v)}`);
  }
}

// computeConcurrency() 纯函数：CLI 与函数入口同等校验入参（不存在 in-process 绕过）。
export function computeConcurrency({
  availableBytes,
  usedSlots,
  pendingGroups,
  platformCap,
  perWorkerBytes,
  reserveRatio,
}) {
  assertNonNegInt(usedSlots, 'usedSlots');
  assertNonNegInt(pendingGroups, 'pendingGroups');
  assertNonNegInt(platformCap, 'platformCap');
  if (typeof availableBytes !== 'number' || !Number.isFinite(availableBytes) || availableBytes < 0) {
    throw new TypeError(`availableBytes 必须为非负有限数，收到 ${JSON.stringify(availableBytes)}`);
  }
  if (typeof perWorkerBytes !== 'number' || !Number.isFinite(perWorkerBytes) || perWorkerBytes <= 0) {
    throw new TypeError(`perWorkerBytes 必须为正数，收到 ${JSON.stringify(perWorkerBytes)}`);
  }
  if (typeof reserveRatio !== 'number' || !Number.isFinite(reserveRatio) || reserveRatio <= 0 || reserveRatio >= 1) {
    throw new TypeError(`reserveRatio 必须在 (0,1) 开区间，收到 ${JSON.stringify(reserveRatio)}`);
  }
  const memBranch = Math.floor((availableBytes * (1 - reserveRatio)) / perWorkerBytes);
  const slotsBranch = platformCap - usedSlots;
  const pendingBranch = pendingGroups;
  return Math.max(0, Math.min(memBranch, slotsBranch, pendingBranch));
}

function usageError(message) {
  console.error(`mem-probe: ${message}`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  console.error(
    [
      '用法: node scripts/mem-probe.mjs --json --used-slots <N> --pending <N> [--vm-stat-file <path>]',
      '  --json            输出 JSON：{page_size,total_bytes,available_bytes,used_slots,platform_cap,per_worker_bytes,reserve_ratio,pending_groups,concurrency}',
      '  --used-slots <N>   全部活跃 worker 数（执行/审查/验收席共享同一 Orca 槽位池，同池计数防超发）',
      '  --pending <N>      待派组数',
      '  --vm-stat-file     注入 vm_stat 夹具文本（确定性测试）；缺省时现场执行 `vm_stat`',
      '  --help            打印本帮助',
    ].join('\n'),
  );
}

// —— CLI 参数校验（与 computeConcurrency 同等拒绝非法入参） ——
function parseArgs(argv) {
  const args = { json: false, help: false, vmStatFile: null, usedSlots: null, pending: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--vm-stat-file') {
      if (i + 1 >= argv.length) usageError('--vm-stat-file 缺少路径参数');
      args.vmStatFile = argv[++i];
    } else if (a === '--used-slots') {
      if (i + 1 >= argv.length) usageError('--used-slots 缺少数值参数');
      const v = argv[++i];
      if (!/^\d+$/.test(v)) usageError(`--used-slots 必须为非负整数，收到 ${JSON.stringify(v)}`);
      args.usedSlots = Number(v);
    } else if (a === '--pending') {
      if (i + 1 >= argv.length) usageError('--pending 缺少数值参数');
      const v = argv[++i];
      if (!/^\d+$/.test(v)) usageError(`--pending 必须为非负整数，收到 ${JSON.stringify(v)}`);
      args.pending = Number(v);
    } else {
      usageError(`未知参数: ${a}`);
    }
  }
  if (args.usedSlots === null) usageError('缺少 --used-slots <N>（调用方声明全部活跃 worker 数）');
  if (args.pending === null) usageError('缺少 --pending <N>（调用方声明待派组数）');
  return args;
}

function readTotalBytes() {
  try {
    return Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim());
  } catch (err) {
    console.error(`mem-probe: 无法读取 sysctl -n hw.memsize: ${err.message}`);
    process.exit(2);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let text;
  if (args.vmStatFile !== null) {
    if (!existsSync(args.vmStatFile)) {
      console.error(`mem-probe: --vm-stat-file 不存在: ${args.vmStatFile}`);
      process.exit(2);
    }
    text = readFileSync(args.vmStatFile, 'utf8');
  } else {
    try {
      text = execFileSync('vm_stat', { encoding: 'utf8', maxBuffer: 1 << 20 });
    } catch (err) {
      console.error(`mem-probe: 无法执行 vm_stat: ${err.message}`);
      process.exit(2);
    }
  }

  // 解析校验分支：唯一 fail-closed 点。解析失败 → 点名缺失字段并 exit 2，绝不回退默认换算。
  let parsed;
  try {
    parsed = parseVmStat(text);
  } catch (err) {
    console.error(`mem-probe: ${err.message}`);
    process.exit(2);
  }

  const availableBytes =
    (parsed.freePages + parsed.inactivePages + parsed.speculativePages) * parsed.pageSize;
  const concurrency = computeConcurrency({
    availableBytes,
    usedSlots: args.usedSlots,
    pendingGroups: args.pending,
    platformCap: config.orcaPlatformCap,
    perWorkerBytes: config.perWorkerBytes,
    reserveRatio: config.memReserveRatio,
  });

  const result = {
    page_size: parsed.pageSize,
    total_bytes: readTotalBytes(),
    available_bytes: availableBytes,
    used_slots: args.usedSlots,
    platform_cap: config.orcaPlatformCap,
    per_worker_bytes: config.perWorkerBytes,
    reserve_ratio: config.memReserveRatio,
    pending_groups: args.pending,
    concurrency,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const gb = availableBytes / 1e9;
    process.stdout.write(
      `mem-probe: page_size=${result.page_size} available=${gb.toFixed(2)}GB ` +
        `slots=${result.used_slots}/${result.platform_cap} pending=${result.pending_groups} concurrency=${result.concurrency}\n`,
    );
  }
  process.exit(0);
}

// main-guard：被 import（测试）时不执行 CLI 入口
const isMain = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isMain) {
  main(process.argv.slice(2));
}

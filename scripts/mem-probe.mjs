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
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'config/defaults.json'), 'utf8'));

// —— 纯提取：不校验，任何输入都返回数值（缺失字段为 NaN）。校验在 parseVmStat 分支内。 ——
// 数字字段正则必须整行锚定（真实 vm_stat 输出：`Pages free:   <数字>.`，数字后带句点，行尾无多余内容）：
//   ^ 行首 + label + : + 空白 + (\d+) + 句点 + 行尾。
// 尾界由「句点 + 行尾」双重承担——千分位 `1,000.`（数字中间 `,` 截断点后不是句点）、
// 单位后缀 `100 pages.`（截断点后是空格）、数字中间字母 `10a0.`、负数 `-100.`、行尾垃圾
// `100. trailing` 都会使整行匹配失败 → NaN → parseVmStat 校验分支点名 throw，绝不把截断值当正常数据。
// page size 同样整行锚定：`Mach Virtual Memory Statistics: (page size of <数字> bytes)`。
const PAGE_SIZE_RE = /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)\s*$/;
function extractVmStatNumbers(text) {
  const lines = String(text).split('\n');
  const firstLine = lines[0] ?? '';
  const pageSizeMatch = firstLine.match(PAGE_SIZE_RE);
  const pageSize = Number(pageSizeMatch?.[1]);
  const grab = (label) => {
    const m = text.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.\\s*$`, 'm'));
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
  const pageSizeMatch = firstLine.match(PAGE_SIZE_RE);
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

// platformCap 必须为正整数：0 是「配置损坏」不是「合法空槽位」。若放行，坏配置会让派工永久无槽位
// （concurrency 恒 0）却没有 fail-closed 信号——lead 会以为「内存不够等一会」，实际等多久都不会好。
function assertPositiveInt(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new TypeError(`${name} 必须为正整数，收到 ${JSON.stringify(v)}`);
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
  assertPositiveInt(platformCap, 'platformCap');
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
      const n = Number(v);
      // 超出安全整数范围（超长数字串 → Number() 得 Infinity）必须以受控 exit 2 点名拒绝，
      // 与导出函数 computeConcurrency 的非法入参拒绝契约等价——不落成 exit 1 裸栈崩溃。
      if (!Number.isSafeInteger(n)) {
        usageError(`--used-slots 必须为非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}），收到 ${v.length} 位数字 ${v.slice(0, 12)}…`);
      }
      args.usedSlots = n;
    } else if (a === '--pending') {
      if (i + 1 >= argv.length) usageError('--pending 缺少数值参数');
      const v = argv[++i];
      if (!/^\d+$/.test(v)) usageError(`--pending 必须为非负整数，收到 ${JSON.stringify(v)}`);
      const n = Number(v);
      if (!Number.isSafeInteger(n)) {
        usageError(`--pending 必须为非负安全整数（≤ ${Number.MAX_SAFE_INTEGER}），收到 ${v.length} 位数字 ${v.slice(0, 12)}…`);
      }
      args.pending = n;
    } else {
      usageError(`未知参数: ${a}`);
    }
  }
  // 帮助出口优先：--help/-h 单独调用必须能打印帮助并 exit 0，不被必填参数校验拦截。
  if (!args.help) {
    if (args.usedSlots === null) usageError('缺少 --used-slots <N>（调用方声明全部活跃 worker 数）');
    if (args.pending === null) usageError('缺少 --pending <N>（调用方声明待派组数）');
  }
  return args;
}

function readTotalBytes() {
  try {
    const v = Number(execFileSync('sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim());
    // fail-closed：sysctl 输出异常时不得把 NaN 静默写进 JSON（JSON.stringify(NaN) = null），点名后 exit 2。
    if (!Number.isSafeInteger(v) || v <= 0) {
      console.error(`mem-probe: sysctl -n hw.memsize 输出非法: ${JSON.stringify(v)}`);
      process.exit(2);
    }
    return v;
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
  // computeConcurrency 校验异常（如 config 侧配置被破坏导致 platformCap/perWorkerBytes/reserveRatio 非法）
  // 一律转受控 exit 2 点名，不落成 exit 1 裸栈崩溃——与 parseArgs 的 CLI 拒绝契约同一语义。
  let concurrency;
  try {
    concurrency = computeConcurrency({
      availableBytes,
      usedSlots: args.usedSlots,
      pendingGroups: args.pending,
      platformCap: config.orcaPlatformCap,
      perWorkerBytes: config.perWorkerBytes,
      reserveRatio: config.memReserveRatio,
    });
  } catch (err) {
    console.error(`mem-probe: ${err.message}`);
    process.exit(2);
  }

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

// main-module guard：作为 CLI 入口才执行主流程；被 import（测试）时静默返回。
// import.meta.url 已被 ESM loader 规范化（symlink/逻辑路径解析后的真实路径），而 process.argv[1]
// 是调用方原样路径——macOS 上 /var → /private/var 这类 symlink 会让两者恒不相等，guard 静默不执行
// （exit 0 + 零输出，与正常完成长得一模一样，探针直接变假）。必须先 realpathSync 归一 argv[1] 再比较。
// 分叉语义：argv[1] 缺失（node --input-type=module --eval 'import ...' 纯 import，无入口文件）→ 不可能是
// CLI 调用，静默返回——mem-probe 必须支持被 import（测试文件即如此），库被加载不得杀死宿主进程；
// argv[1] 存在但 realpath 失败 → fail-closed exit 2 点名（本该是 CLI 却无法验证，不静默假绿）。
if (process.argv[1] !== undefined) {
  let entryReal;
  try {
    entryReal = realpathSync(process.argv[1]);
  } catch (e) {
    console.error(`mem-probe: 无法解析脚本真实路径 ${process.argv[1]}（${e.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    main(process.argv.slice(2));
  }
}

#!/usr/bin/env node
// approve-exec 权威测试入口。
// 显式枚举：固定数组 TEST_FILES 冻结测试集（不 readdir 自动发现、不递归、不用 glob）——
// 新增/删除测试文件必须同步改本数组，否则双向校验强制一致性。
// 双向校验（fail-closed，任一方向 exit 2 点名）：
//   A) 枚举中的文件在磁盘上缺失 → exit 2（防「测试文件被删后静默少跑」）
//   B) tests/ 顶层出现未枚举的 *.test.mjs → exit 2（防「新增测试静默不跑」）
// 校验通过后逐个 spawn `node --test <file>`，node test runner 原始汇总（spec 报告器）经 stdio 原样透传；
// 判据 = fail 0：全绿 → exit 0；有红 → exit 1；枚举为空 → exit 2（fail-closed，视为配置错误）。
// RUN_TESTS_DIR（仅测试注入用）：覆盖 tests/ 目录路径，黑盒用例据此构造夹具目录。
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 显式枚举：冻结测试集（字母序）。sc-p0a 契约——只读顶层、不递归、不自动发现。
export const TEST_FILES = [
  'config.test.mjs',
  'graph.test.mjs',
  'mem-probe.test.mjs',
  'ready-check.test.mjs',
  'run-ledger.test.mjs',
  'run-tests.test.mjs',
  'selfcheck.test.mjs',
  'skill-doc.test.mjs',
];

// 双向校验（纯函数，可单测）：
//   missing —— 枚举中存在、磁盘上缺失的文件（方向 A：测试被删 → 变硬错）
//   unenumerated —— tests/ 顶层存在、未进枚举的 *.test.mjs（方向 B：新增测试 → 变硬错）
export function checkEnumeration(testsDir, testFiles) {
  const missing = testFiles.filter((f) => !existsSync(join(testsDir, f)));
  let present = [];
  try {
    present = readdirSync(testsDir);
  } catch {
    present = []; // tests/ 不存在/不可读：方向 A 会全量点名枚举文件，仍 fail-closed
  }
  const unenumerated = present
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => !testFiles.includes(f))
    .sort();
  return { missing, unenumerated };
}

// 测试隔离：子进程树内禁止 git 签名（fixture 仓首提交）。
// 本机全局 commit.gpgsign=true，多个 fixture git 仓同时 commit 时继承签名，高负载下
// gpg-agent 瞬时内存分配失败（"gpg failed to sign the data ... Cannot allocate memory"）
// → fixture 首提交失败 → 测试假红，且失败集在多轮间漂移（不同 gap 变体轮流红），
// 曾把 flake 误判成真实缺陷。经 GIT_CONFIG_* 环境变量（git 官方进程级配置注入）仅关闭
// 测试子进程树内的签名：不改任何 git 配置文件、不影响真实仓库的签名策略。
// 调用方若已注入 GIT_CONFIG_*（含 COUNT），原样保留、我们的条目追加在既有索引之后
// （git 按序应用，靠后者覆盖前者，保证签名必然关闭）。
export function buildChildEnv(env) {
  const childEnv = { ...env };
  // 已有 COUNT 时必须追加而非覆盖，否则调用方的 git 配置注入会丢；
  // 非数字 COUNT 在 git 侧本就是硬错误（invalid count），归 0 只保证我们的注入仍可用
  const existing = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? '') ? Number(env.GIT_CONFIG_COUNT) : 0;
  childEnv.GIT_CONFIG_COUNT = String(existing + 1);
  childEnv[`GIT_CONFIG_KEY_${existing}`] = 'commit.gpgsign';
  childEnv[`GIT_CONFIG_VALUE_${existing}`] = 'false';
  return childEnv;
}

function main() {
  const testsDir = process.env.RUN_TESTS_DIR ? resolve(process.env.RUN_TESTS_DIR) : join(root, 'tests');

  // 双向校验：A 先于 B（先报「该跑的没跑」，再报「不该多的多了」）
  const { missing, unenumerated } = checkEnumeration(testsDir, TEST_FILES);
  if (missing.length > 0) {
    console.error(`run-tests: 枚举的测试文件缺失: ${missing.join(', ')}`);
    process.exit(2);
  }
  if (unenumerated.length > 0) {
    console.error(`run-tests: tests/ 顶层存在未枚举的测试文件: ${unenumerated.join(', ')}`);
    process.exit(2);
  }
  if (TEST_FILES.length === 0) {
    console.error('run-tests: 枚举为空，无法执行任何测试');
    process.exit(2);
  }

  const testFiles = TEST_FILES.map((f) => join(testsDir, f));
  console.log(`run-tests: 显式枚举 ${testFiles.length} 个测试文件\n`);
  for (const file of testFiles) {
    const result = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit', env: buildChildEnv(process.env) });
    if (result.status === null) {
      // 子进程被信号杀死（异常），与"测试失败"区分：非 0 收束，不静默
      process.exitCode = 1;
      console.error(`\nrun-tests: ${file} 被信号终止 (${result.signal})`);
    } else if (result.status !== 0) {
      process.exitCode = 1;
    }
    console.log('');
  }

  const failed = process.exitCode === 1;
  console.log(`run-tests: ${testFiles.length} file(s) run, ${failed ? 'FAIL (exit 1)' : 'all pass (exit 0)'}`);
}

// main-module guard：作为 CLI 入口才执行主流程；被测试 import（TEST_FILES/checkEnumeration）时静默返回
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

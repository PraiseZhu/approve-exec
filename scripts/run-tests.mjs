#!/usr/bin/env node
// approve-exec 权威测试入口。
// 显式枚举 tests/ 顶层 *.test.mjs（readdirSync 只读顶层 + 后缀过滤，不递归、不用 glob、不自动发现），
// 逐个 spawn `node --test <file>`，node test runner 原始汇总（spec 报告器）经 stdio 原样透传；
// 判据 = fail 0：全绿 → exit 0；有红 → exit 1；tests/ 下没有测试文件 → exit 2（fail-closed，视为配置错误）。
import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'tests');

// 显式枚举：只读 tests/ 顶层，*.test.mjs 后缀过滤（不递归、不自动发现）
const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(testsDir, f));

if (testFiles.length === 0) {
  console.error('run-tests: tests/ 下没有 *.test.mjs 文件，无法执行任何测试');
  process.exit(2);
}

console.log(`run-tests: 显式枚举 ${testFiles.length} 个测试文件\n`);
for (const file of testFiles) {
  const result = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit' });
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

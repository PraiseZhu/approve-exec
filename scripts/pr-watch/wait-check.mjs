#!/usr/bin/env node
// wait-check — 等一个 PR 当前 head 上某项检查（如 review-pr）出结论，代替手写 gh 轮询循环。
// CLI: node scripts/pr-watch/wait-check.mjs --repo <owner/name> --pr <号> --check <检查名>
//        [--after <ISO>] [--interval-sec 120] [--timeout-min 90] [--gh-fixture <夹具.json>]
// --after：只认晚于这个时间开始的那次检查（重审时传上一轮的 started_at，避免读到旧结论）；
//   按时间值比较，带时区偏移也行；还没开始（started_at 为空）的排队检查一律算新的。
// PR head 在等待中变了就跟着新 head 查，结果里写实际 head。
// 每轮进度写 stderr；结束时 stdout 一行 JSON。
// 退出码：0 检查 success；1 检查完成但不是 success；3 超时仍没结论；2 用法或 gh 错误。
// --gh-fixture（测试用）：{"polls":[{"head":"<sha>","runs":[{name,status,conclusion,started_at,...}]}, ...]}，
//   按轮次取，用完后一直停在最后一轮；夹具模式不 sleep。
import { execFileSync } from 'node:child_process';
import { isMain, parseArgs, readJson } from '../lib/common.mjs';

// 纯函数：从一组 check run 里挑出该检查的最新一次，并判断是否已出结论
// 还没开始的（非 completed 且无 started_at）排在最后、算新的；completed 却没有开始时间的算最旧
const startMs = (r) => (r.started_at ? Date.parse(r.started_at) : r.status === 'completed' ? -Infinity : Infinity);

export function selectVerdict(runs, { name, after = null }) {
  const afterMs = after ? Date.parse(after) : -Infinity;
  const mine = runs
    .filter((r) => r.name === name)
    .filter((r) => startMs(r) > afterMs)
    .sort((a, b) => startMs(a) - startMs(b));
  const last = mine.at(-1);
  if (!last) return { done: false, state: 'missing' };
  if (last.status !== 'completed') return { done: false, state: last.status, run: last };
  return { done: true, state: 'completed', conclusion: last.conclusion, run: last };
}

function realGh() {
  return {
    head: (repo, pr) => execFileSync('gh', ['api', `repos/${repo}/pulls/${pr}`, '-q', '.head.sha'], { encoding: 'utf8' }).trim(),
    runs: (repo, sha) => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`], { encoding: 'utf8' })).check_runs,
  };
}

function fixtureGh(path) {
  const { polls } = readJson(path);
  let i = 0;
  const current = () => polls[Math.min(i, polls.length - 1)];
  return {
    head: () => current().head,
    runs: () => { const r = current().runs; i++; return r; },
  };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export async function waitCheck({ repo, pr, name, after, intervalMs, timeoutMs, gh, now = () => Date.now(), pause = sleep }) {
  const deadline = now() + timeoutMs;
  let polls = 0;
  for (;;) {
    const head = gh.head(repo, pr);
    const v = selectVerdict(gh.runs(repo, head), { name, after });
    polls++;
    process.stderr.write(`${new Date(now()).toISOString()} #${pr} ${name} head=${head.slice(0, 9)} ${v.done ? v.conclusion : v.state}\n`);
    if (v.done) {
      return { ok: v.conclusion === 'success', conclusion: v.conclusion, head, polls,
        started_at: v.run.started_at, title: v.run.output?.title ?? null, details_url: v.run.details_url ?? null };
    }
    if (now() >= deadline) return { ok: false, conclusion: null, timeout: true, head, polls, state: v.state, started_at: v.run?.started_at ?? null };
    await pause(intervalMs);
  }
}

// cli

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repo = args.repo, pr = args.pr, name = args.check;
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { process.stderr.write(`[USAGE] --repo 要 owner/name，实际 ${repo}\n`); return 2; }
  if (!/^\d+$/.test(String(pr))) { process.stderr.write(`[USAGE] --pr 要数字，实际 ${pr}\n`); return 2; }
  if (typeof name !== 'string' || name.trim() === '') { process.stderr.write(`[USAGE] --check 要非空的检查名，实际 ${name}\n`); return 2; }
  if ('after' in args && (typeof args.after !== 'string' || Number.isNaN(Date.parse(args.after)))) {
    process.stderr.write(`[USAGE] --after 要 ISO 时间（如 2026-11-02T10:55:40Z），实际 ${args.after}\n`); return 2;
  }
  // 给了参数就必须带非空值：无值时 parseArgs 给 true，Number(true)=1、Number('')=0 都会被误收
  const numArg = (key, fallback) => (key in args ? (typeof args[key] === 'string' && args[key].trim() !== '' ? Number(args[key]) : NaN) : fallback);
  const intervalSec = numArg('interval-sec', 120);
  const timeoutMin = numArg('timeout-min', 90);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) { process.stderr.write(`[USAGE] --interval-sec 要正数秒，实际 ${args['interval-sec']}\n`); return 2; }
  if (!Number.isFinite(timeoutMin) || timeoutMin < 0) { process.stderr.write(`[USAGE] --timeout-min 要非负分钟数，实际 ${args['timeout-min']}\n`); return 2; }
  const fixture = typeof args['gh-fixture'] === 'string' ? args['gh-fixture'] : null;
  try {
    const res = await waitCheck({
      repo, pr: String(pr), name,
      after: 'after' in args ? args.after : null,
      intervalMs: fixture ? 0 : intervalSec * 1000,
      timeoutMs: timeoutMin * 60_000,
      gh: fixture ? fixtureGh(fixture) : realGh(),
      pause: fixture ? async () => {} : sleep,
    });
    process.stdout.write(JSON.stringify(res) + '\n');
    if (res.timeout) return 3;
    return res.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`[GH] ${err.message}\n`);
    return 2;
  }
}

if (isMain(import.meta.url)) main().then((code) => process.exit(code));

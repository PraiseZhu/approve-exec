// pr-watch/wait-check.mjs：等 PR 当前 head 上某项检查出结论（复盘 2026-11-02 第 9 条：手写轮询退出条件写错重跑两次）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectVerdict } from '../scripts/pr-watch/wait-check.mjs';

const CLI = fileURLToPath(new URL('../scripts/pr-watch/wait-check.mjs', import.meta.url));
const run = (name, status, conclusion, started_at) => ({ name, status, conclusion, started_at, output: { title: `${name} ${conclusion}` } });

function cli(polls, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'wait-check-'));
  const fx = join(dir, 'fx.json');
  writeFileSync(fx, JSON.stringify({ polls }));
  const r = spawnSync(process.execPath, [CLI, '--repo', 'o/r', '--pr', '7', '--check', 'review-pr', '--gh-fixture', fx, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test('selectVerdict 只看同名检查里最新的一次', () => {
  const v = selectVerdict([
    run('review-pr', 'completed', 'failure', '2026-11-02T07:10:00Z'),
    run('ci', 'completed', 'success', '2026-11-02T09:00:00Z'),
    run('review-pr', 'completed', 'success', '2026-11-02T08:20:00Z'),
  ], { name: 'review-pr' });
  assert.equal(v.done, true);
  assert.equal(v.conclusion, 'success');
});

test('selectVerdict 带 after 时忽略之前那轮的旧结论', () => {
  const runs = [run('review-pr', 'completed', 'failure', '2026-11-02T07:10:00Z')];
  assert.deepEqual(selectVerdict(runs, { name: 'review-pr', after: '2026-11-02T07:30:00Z' }), { done: false, state: 'missing' });
});

test('selectVerdict 进行中的不算出结论', () => {
  const v = selectVerdict([run('review-pr', 'in_progress', null, '2026-11-02T07:10:00Z')], { name: 'review-pr' });
  assert.equal(v.done, false);
  assert.equal(v.state, 'in_progress');
});

test('CLI 先进行中、后成功：exit 0，轮次 2', () => {
  const r = cli([
    { head: 'a'.repeat(40), runs: [run('review-pr', 'in_progress', null, '2026-11-02T07:10:00Z')] },
    { head: 'a'.repeat(40), runs: [run('review-pr', 'completed', 'success', '2026-11-02T07:10:00Z')] },
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.conclusion, 'success');
  assert.equal(r.out.polls, 2);
});

test('CLI 结论是 failure：exit 1', () => {
  const r = cli([{ head: 'a'.repeat(40), runs: [run('review-pr', 'completed', 'failure', '2026-11-02T07:10:00Z')] }]);
  assert.equal(r.code, 1, r.err);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.conclusion, 'failure');
});

test('CLI 超时仍没结论：exit 3', () => {
  const r = cli([{ head: 'a'.repeat(40), runs: [run('review-pr', 'queued', null, '2026-11-02T07:10:00Z')] }], ['--timeout-min', '0']);
  assert.equal(r.code, 3, r.err);
  assert.equal(r.out.timeout, true);
  assert.equal(r.out.state, 'queued');
});

test('CLI 等待中 head 变了：按新 head 的检查出结论', () => {
  const r = cli([
    { head: 'a'.repeat(40), runs: [run('review-pr', 'in_progress', null, '2026-11-02T07:10:00Z')] },
    { head: 'b'.repeat(40), runs: [run('review-pr', 'completed', 'success', '2026-11-02T08:00:00Z')] },
  ]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.head, 'b'.repeat(40));
});

test('CLI 参数不对：exit 2 并说明期望', () => {
  const r = spawnSync(process.execPath, [CLI, '--repo', 'bad', '--pr', '7', '--check', 'review-pr'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--repo 要 owner\/name，实际 bad/);
});

test('selectVerdict 按时间值比较 after：带时区偏移的 after 不误杀新结论，等于 after 的算旧的', () => {
  const runs = [run('review-pr', 'completed', 'success', '2026-11-02T10:55:40Z')];
  assert.equal(selectVerdict(runs, { name: 'review-pr', after: '2026-11-02T18:00:00+08:00' }).conclusion, 'success');
  assert.equal(selectVerdict(runs, { name: 'review-pr', after: '2026-11-02T10:55:40Z' }).state, 'missing');
});

test('selectVerdict 还没开始（started_at 为空）的排队检查算新的，报 queued 不报 missing', () => {
  const runs = [
    run('review-pr', 'completed', 'failure', '2026-11-02T07:10:00Z'),
    run('review-pr', 'queued', null, null),
  ];
  const v = selectVerdict(runs, { name: 'review-pr', after: '2026-11-02T07:10:00Z' });
  assert.equal(v.done, false);
  assert.equal(v.state, 'queued');
});

test('CLI 超时 JSON 带当前检查的开始时间', () => {
  const r = cli([{ head: 'a'.repeat(40), runs: [run('review-pr', 'in_progress', null, '2026-11-02T07:10:00Z')] }], ['--timeout-min', '0']);
  assert.equal(r.code, 3, r.err);
  assert.equal(r.out.started_at, '2026-11-02T07:10:00Z');
});

for (const [flag, value, expect] of [
  ['--after', null, /--after 要 ISO 时间/],
  ['--after', 'yesterday', /--after 要 ISO 时间.*实际 yesterday/],
  ['--timeout-min', 'abc', /--timeout-min 要非负分钟数，实际 abc/],
  ['--interval-sec', '2m', /--interval-sec 要正数秒，实际 2m/],
  ['--interval-sec', '0', /--interval-sec 要正数秒，实际 0/],
  ['--interval-sec', null, /--interval-sec 要正数秒，实际 true/],
  ['--timeout-min', null, /--timeout-min 要非负分钟数，实际 true/],
  ['--timeout-min', ' ', /--timeout-min 要非负分钟数/],
]) {
  test(`CLI ${flag} ${value ?? '(无值)'}：exit 2，不开始轮询`, () => {
    const args = value === null ? [flag] : [flag, value];
    const r = cli([{ head: 'a'.repeat(40), runs: [run('review-pr', 'completed', 'success', '2026-11-02T07:10:00Z')] }], args);
    assert.equal(r.code, 2);
    assert.equal(r.out, null);
    assert.match(r.err, expect);
  });
}

test('CLI --check 为空串：exit 2，不开始轮询', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wait-check-'));
  const fx = join(dir, 'fx.json');
  writeFileSync(fx, JSON.stringify({ polls: [{ head: 'a'.repeat(40), runs: [] }] }));
  const r = spawnSync(process.execPath, [CLI, '--repo', 'o/r', '--pr', '7', '--check', ' ', '--gh-fixture', fx, '--timeout-min', '0'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--check 要非空的检查名/);
});

test('selectVerdict completed 却没有开始时间的 run 不盖过更新的结论', () => {
  const v = selectVerdict([
    run('review-pr', 'completed', 'success', '2026-11-02T08:00:00Z'),
    run('review-pr', 'completed', 'skipped', null),
  ], { name: 'review-pr' });
  assert.equal(v.conclusion, 'success');
});

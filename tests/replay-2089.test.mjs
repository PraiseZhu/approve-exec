// 历史回放：在 xindong/mivo-canvas-plugin#2089（画布边界）那次真实 run 的时间线上重跑对账器。
// 当时三段各 13 小时以上的等待没有任何东西在看（PraiseZhu/approve-exec#101 背景）；这里断言对账器在期限内各给出一条到期动作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile, toFacts, toReport } from '../scripts/lib/reconcile-rules.mjs';
import { toCharter } from '../scripts/charter.mjs';

const FILE = fileURLToPath(new URL('./fixtures/replay/xindong__mivo-canvas-plugin__2089.json', import.meta.url));
const CLI = fileURLToPath(new URL('../scripts/reconcile.mjs', import.meta.url));
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const M = 'xindong/mivo-canvas-plugin';
const at = (iso, charter) => reconcile(toFacts(data, iso, charter === undefined ? {} : { charter }));
const dueFor = (out, n) => out.due.filter((d) => d.ref === `${M}#${n}`).map((d) => d.action);
const stage = (out, n) => out.children.find((c) => c.ref === `${M}#${n}`)?.stage;
const CHARTER = (bases) => toCharter({
  merge: { auto_request: true, bases }, conflict: { same_file: 'parallel' }, prereview: 'feature', early_start: false,
  max_parallel: 6, manual_test: 'x', user_words: 'x', lead_session: `${'a'.repeat(64)}::lead-1`,
});

test('等待一：PR 2141 判通过（11-10 18:29Z）后一直是 Draft，30 分钟期限过后叫醒执行会话', () => {
  const out = at('2026-11-10T19:30:00Z');
  assert.equal(stage(out, 2092), 'accepted_draft');
  assert.deepEqual(dueFor(out, 2092), ['wake_owner']);
  assert.deepEqual(dueFor(at('2026-11-10T18:50:00Z'), 2092), [], '期限内不催');
});

test('等待二、三：PR 2184（15:38Z）和 PR 2141（16:55Z）审查放行后没进合并队列，10 分钟期限过后叫醒 lead', () => {
  const a = at('2026-11-11T16:00:00Z');
  assert.equal(stage(a, 2093), 'merge_ready');
  assert.deepEqual(dueFor(a, 2093), ['wake_lead']);
  const b = at('2026-11-11T17:30:00Z');
  assert.equal(stage(b, 2092), 'merge_ready');
  assert.deepEqual(dueFor(b, 2092), ['wake_lead']);
});

test('审查中有新提交和新审查结论时不算停滞：11-11 12:00Z 的 PR 2141 没有到期动作', () => {
  const out = at('2026-11-11T12:00:00Z');
  assert.equal(stage(out, 2092), 'in_review');
  assert.deepEqual(dueFor(out, 2092), []);
});

test('没有章程：全程任何时间点都不产生「交合并请求」', () => {
  for (let t = Date.parse('2026-11-10T17:00:00Z'); t <= Date.parse('2026-11-12T14:00:00Z'); t += 30 * 60000) {
    const out = at(new Date(t).toISOString());
    assert.equal(out.due.some((d) => d.action === 'request_merge'), false, new Date(t).toISOString());
  }
});

test('有章程：授权含集成分支时 16:00Z 对 PR 2184 的动作是交合并请求；只授权 main 时仍叫醒 lead 并写出目标分支', () => {
  assert.deepEqual(dueFor(at('2026-11-11T16:00:00Z', CHARTER(['main', 'integration/*'])), 2093), ['request_merge']);
  const out = at('2026-11-11T16:00:00Z', CHARTER(['main']));
  assert.deepEqual(dueFor(out, 2093), ['wake_lead']);
  assert.match(out.due.find((d) => d.ref === `${M}#2093`).reason, /integration\/canvas-bounds-s1/);
});

test('旧手写裁决不产生复核：回放全程没有 recheck', () => {
  for (const iso of ['2026-11-11T10:00:00Z', '2026-11-11T17:30:00Z', '2026-11-12T08:00:00Z']) {
    assert.equal(at(iso).due.some((d) => d.action === 'recheck'), false, iso);
  }
});

test('运行报告：PR 2141 判通过到转正式 14.5 小时、判通过后新增 6 个提交；没有预审记录的格子写「无记录」', () => {
  const { rows, markdown } = toReport(toFacts(data, '2026-11-13T00:00:00Z'));
  const row = rows.find((r) => r.ref === `${M}#2092`);
  assert.ok(Math.abs(row.to_ready_h - 14.5) <= 0.1, `实际 ${row.to_ready_h}`);
  assert.equal(row.commits_after_pass, 6);
  assert.equal(row.prereview_rounds, null);
  assert.ok(row.review_rounds >= 5, `转正式后的审查次数 ${row.review_rounds}`);
  assert.match(markdown.split('\n').find((l) => l.includes(`${M}#2092`)), /无记录/);
});

test('CLI：--replay --at 输出一行 JSON；缺 --at 退出码 2；--charter 生效', () => {
  const ok = spawnSync(process.execPath, [CLI, '--replay', FILE, '--at', '2026-11-11T16:00:00Z'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).due.some((d) => d.action === 'wake_lead'), true);
  assert.equal(spawnSync(process.execPath, [CLI, '--replay', FILE], { encoding: 'utf8' }).status, 2);
  const cfile = join(mkdtempSync(join(tmpdir(), 'charter-')), 'c.json');
  writeFileSync(cfile, JSON.stringify(CHARTER(['main', 'integration/*'])));
  const withCharter = spawnSync(process.execPath, [CLI, '--replay', FILE, '--at', '2026-11-11T16:00:00Z', '--charter', cfile], { encoding: 'utf8' });
  assert.equal(JSON.parse(withCharter.stdout).due.some((d) => d.action === 'request_merge'), true);
  const report = spawnSync(process.execPath, [CLI, '--replay', FILE, '--at', '2026-11-13T00:00:00Z', '--report'], { encoding: 'utf8' });
  assert.match(JSON.parse(report.stdout).markdown, /批准执行运行报告/);
});

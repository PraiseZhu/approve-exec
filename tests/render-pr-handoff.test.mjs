import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderPrHandoff } from '../scripts/render-pr-handoff.mjs';
import { LedgerError } from '../scripts/run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/render-pr-handoff.mjs');
const FIXTURE = join(ROOT, 'tests/fixtures/sample-manifest.json');
const SHA3 = 'c'.repeat(40);

function packet() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')).dispatch.packets[0];
}

function baseArgs(overrides = {}) {
  return {
    packet: packet(),
    identity: { worktree: '/wt/g4', branch: 'feat/g4', base: SHA3 },
    leadSessionId: 'lead-1',
    seq: 1,
    repo: 'xindong/mivo-canvas-plugin',
    title: 'MivoPlugin-存图补图修复丨 0902',
    snapshot: '渲染当时快照，派工时再读',
    ...overrides,
  };
}

test('render-pr-handoff: 0–10 段齐全，含开工闸与绝对路径', () => {
  const out = renderPrHandoff(baseArgs());
  assert.equal(out.startsWith('用 goal skill 执行。\n'), true);
  for (const t of ['0. 开工闸', '1. 身份', '5. allowed_paths', '6. SC 全文', '8. 做完之后（自动，不要问 lead）', '10. 回报格式']) {
    assert.ok(out.includes(`## ${t}`), `缺段 ${t}`);
  }
  assert.ok(out.includes('/Users/praise/.agents/skills/goal/SKILL.md'));
  assert.ok(out.includes('/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json'));
  assert.ok(out.includes('丨 0902'));
  assert.ok(out.includes('model-route show'));
  assert.ok(out.includes('子 session 不合入'), '开工包第 8 段应禁止子 session 合入');
  assert.ok(out.includes('合入由 lead'), '开工包应写明合入由 lead 执行');
});

test('render-pr-handoff: 缺 allowed_paths 或乱序身份拒', () => {
  const p = packet();
  p.allowed_paths = ['scripts/'];
  assert.throws(() => renderPrHandoff(baseArgs({ packet: p })), LedgerError);
  assert.throws(() => renderPrHandoff(baseArgs({ identity: { worktree: 'rel', branch: 'b', base: SHA3 } })), LedgerError);
  assert.throws(() => renderPrHandoff(baseArgs({ title: 'no-sep 0902' })), LedgerError);
});

test('render-pr-handoff CLI: --packet + --identity 出包', () => {
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--packet', JSON.stringify(packet()),
    '--identity', JSON.stringify({ worktree: '/wt/g4', branch: 'feat/g4', base: SHA3 }),
    '--lead-session-id', 'lead-1',
    '--seq', '1',
    '--repo', 'Skills',
    '--title', 'Skills-开工闸收据丨 0902',
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /用 goal skill 执行。/);
  assert.match(r.stdout, /## 0\. 开工闸/);
});

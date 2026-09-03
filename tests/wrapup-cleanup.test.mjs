import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertReadyPr, confirmPrOpen } from '../scripts/confirm-pr-open.mjs';
import { wrapupCleanup } from '../scripts/wrapup-cleanup.mjs';
import {
  LedgerError,
  PR_OPEN_RECEIPT_KEYS,
  CLEANUP_RECEIPT_KEYS,
  readPrOpenReceipt,
  readCleanupReceipt,
} from '../scripts/run-ledger.mjs';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const NOW = '2026-08-09T00:00:00Z';

test('confirm-pr-open: draft 拒、OPEN ready 过', () => {
  assert.throws(
    () => assertReadyPr({
      url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
      state: 'OPEN',
      isDraft: true,
      headRefOid: SHA,
      expectedHead: SHA,
    }),
    LedgerError,
  );
  const ok = assertReadyPr({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    state: 'OPEN',
    isDraft: false,
    headRefOid: SHA,
    expectedHead: SHA,
  });
  assert.equal(ok.number, 1);
  assert.equal(ok.isDraft, false);
});

test('wrapup-cleanup: 远端 SHA 不对则跳过且不删 remote', () => {
  const calls = [];
  const gitRunner = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return SHA;
    if (args[0] === 'ls-remote') return `${SHA2}\trefs/heads/feat/x`;
    return '';
  };
  const out = wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    remote: 'origin',
    gitRunner,
    now: NOW,
  });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.equal(out.remoteDeleted, undefined);
  assert.equal(out.checked_at, NOW);
  assert.equal(calls.some((a) => a.includes('push') || a.includes('--delete')), false);
  assert.equal(calls.some((a) => a[0] === 'worktree' && a[1] === 'remove'), false);
});

test('confirm-pr-open: gh pr view 用分支名，不用 --head', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'gh-bin-'));
  const gh = join(binDir, 'gh');
  const log = join(binDir, 'args.txt');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nprintf '{"url":"https://github.com/acme/app/pull/9","state":"OPEN","isDraft":false,"headRefOid":"${SHA}","number":9}\\n'\n`);
  chmodSync(gh, 0o755);
  const out = confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA, ghBin: gh, now: NOW });
  assert.equal(out.number, 9);
  assert.equal(out.branch, 'feat/x');
  assert.equal(out.checked_at, NOW);
  const args = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 5), ['pr', 'view', 'feat/x', '--repo', 'acme/app']);
  assert.equal(args.includes('--head'), false);
});

test('ready 冻结后仍可 pr-open / watch_registered / local-cleaned', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'ready-wrapup-'));
  const ledgerPath = join(dir, 'ledger.json');
  const T = '2026-08-09T00:00:00Z';
  const SHA1 = 'a'.repeat(40);
  const SHA3 = 'c'.repeat(40);
  const GATE_GOAL_SHA = '7d7b9d9b97c99b39de5cbbd6b20e4869afe4cb16dab1dc91833a94a29dca356e';
  const GATE_ROUTING_SHA = 'e88009fec5d61472d41554b8c0238c6eedd1395d8b301cbc1524d121dc386c23';
  const ROUTING_LIVE = '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json';
  const GOAL_SKILL_PI = '/Users/praise/.agents/skills/goal/SKILL.md';
  const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/run-ledger.mjs'), ...args], { encoding: 'utf8' });
  const manifestPath = join(dir, 'sample-manifest.json');
  copyFileSync(join(root, 'tests/fixtures/sample-manifest.json'), manifestPath);
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'wrapup-ready', '--now', T, '--baseline', SHA3);
  assert.equal(r.status, 0, r.stderr);
  const g = 'g4';
  r = cli('set-state', ledgerPath, '--group', g, '--identity', JSON.stringify({
    worktree: '/wt/g4', branch: 'feat/run-ledger', base: SHA3, session_id: 'sess-g4',
  }), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('render-packet', ledgerPath, '--group', g);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'dispatched', '--worker-label', 'w1', '--now', T,
    '--mem-snapshot', JSON.stringify({ used_slots: 0, platform_cap: 8, concurrency: 8, available_bytes: 34359738368 }));
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'executing', '--now', T, '--detail', JSON.stringify({
    goal_skill_path: GOAL_SKILL_PI, goal_skill_sha256: GATE_GOAL_SHA,
  }));
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'e2e', '--now', T, '--detail', JSON.stringify({
    route_source: ROUTING_LIVE, routing_sha256: GATE_ROUTING_SHA,
    e2e_model: 'codex/gpt-5.6-luna', review_model: 'codex/gpt-5.6-sol',
  }));
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'review', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const packet = manifest.dispatch.packets.find((p) => p.group_id === g);
  r = cli('record-delivery', ledgerPath, '--group', g, '--payload', JSON.stringify({
    branch: 'feat/run-ledger', tip_sha: SHA1,
    scs: packet.scs_inline.map((s) => ({ id: s.id, status: 'pass' })),
    goal_skill_path: GOAL_SKILL_PI,
    e2e: { status: 'pass', candidate_sha: SHA1, model: 'codex/gpt-5.6-luna', route_source: ROUTING_LIVE },
    review: { unresolved: 0, candidate_sha: SHA1, model: 'codex/gpt-5.6-sol', route_source: ROUTING_LIVE },
    size_gate: { result: 'PASS', candidate_sha: SHA1 },
  }), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const frozen = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  frozen.phase = 'ready';
  frozen.phase_at = T;
  writeFileSync(ledgerPath, `${JSON.stringify(frozen, null, 2)}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'executing', '--now', T);
  assert.equal(r.status, 2, 'ready 后非收尾跳转仍冻结');
  assert.match(r.stderr, /FROZEN/);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T);
  assert.equal(r.status, 2, 'ready 后 pr-open 缺 confirm-pr-open 回执必须拒');
  assert.match(r.stderr, /pr-open-receipt|confirm-pr-open/);
  const draftReceipt = join(dir, 'pr-open-draft.json');
  writeFileSync(draftReceipt, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1,
    headRefOid: SHA1,
    isDraft: true,
    state: 'OPEN',
    branch: 'feat/run-ledger',
    checked_at: T,
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', draftReceipt);
  assert.equal(r.status, 2, 'draft PR 回执不得入账');
  const prOpenReceipt = join(dir, 'pr-open-receipt.json');
  writeFileSync(prOpenReceipt, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1,
    headRefOid: SHA1,
    isDraft: false,
    state: 'OPEN',
    branch: 'feat/run-ledger',
    checked_at: T,
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', prOpenReceipt);
  assert.equal(r.status, 0, r.stderr);
  const watchState = join(dir, 'acme__app__1.json');
  writeFileSync(watchState, `${JSON.stringify({ owner: 'acme', repo: 'app', pr_number: 1, session_id: null })}\n`);
  r = cli('note-event', ledgerPath, '--event', 'watch_registered', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    state_file: watchState,
  }), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const cleanupReceipt = join(dir, 'cleanup-receipt.json');
  writeFileSync(cleanupReceipt, `${JSON.stringify({
    ok: true,
    skipped: false,
    branch: 'feat/run-ledger',
    worktree: '/wt/g4',
    sha: SHA1,
    remoteDeleted: false,
    checked_at: T,
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'local-cleaned', '--now', T);
  assert.equal(r.status, 2, 'pr-open→local-cleaned 缺 wrapup-cleanup 回执必须拒');
  assert.match(r.stderr, /cleanup-receipt|wrapup-cleanup/);
  const skippedCleanup = join(dir, 'cleanup-skipped.json');
  writeFileSync(skippedCleanup, `${JSON.stringify({
    ok: false,
    skipped: true,
    branch: 'feat/run-ledger',
    worktree: '/wt/g4',
    sha: SHA1,
    remoteDeleted: false,
    checked_at: T,
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'local-cleaned', '--now', T, '--cleanup-receipt', skippedCleanup);
  assert.equal(r.status, 2, 'skipped 清理回执不得入账');
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'local-cleaned', '--now', T, '--cleanup-receipt', cleanupReceipt);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'archived', '--now', T);
  assert.equal(r.status, 2, 'local-cleaned→archived 缺 archive_sessions 回执必须拒');
  assert.match(r.stderr, /archive-receipt|archive_sessions/);
  const archiveReceipt = join(dir, 'archive-receipt.json');
  writeFileSync(archiveReceipt, `${JSON.stringify({
    session_id: 'sess-g4',
    archived: true,
    checked_at: T,
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'archived', '--now', T, '--archive-receipt', archiveReceipt);
  assert.equal(r.status, 0, r.stderr);
});

test('confirm-pr-open / wrapup-cleanup stdout 必须能被台账回执闸直接吃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrapup-stdout-'));
  const binDir = mkdtempSync(join(tmpdir(), 'gh-bin-'));
  const gh = join(binDir, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '{"url":"https://github.com/acme/app/pull/9","state":"OPEN","isDraft":false,"headRefOid":"${SHA}","number":9}\\n'\n`);
  chmodSync(gh, 0o755);
  const pr = confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA, ghBin: gh, now: NOW });
  assert.deepEqual(Object.keys(pr).sort(), [...PR_OPEN_RECEIPT_KEYS].sort());
  const prPath = join(dir, 'pr-open.json');
  writeFileSync(prPath, `${JSON.stringify(pr)}\n`);
  assert.equal(readPrOpenReceipt(prPath).number, 9);

  const gitRunner = (args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return SHA;
    if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/feat/x`;
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git';
    return '';
  };
  const cleaned = wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    remote: 'origin',
    gitRunner,
    now: NOW,
  });
  assert.deepEqual(Object.keys(cleaned).sort(), [...CLEANUP_RECEIPT_KEYS].sort());
  const cleanupPath = join(dir, 'cleanup.json');
  writeFileSync(cleanupPath, `${JSON.stringify(cleaned)}\n`);
  assert.equal(readCleanupReceipt(cleanupPath).ok, true);
});

test('confirm-pr-open / wrapup-cleanup 缺 --now 拒', () => {
  assert.throws(() => confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA }), LedgerError);
  assert.throws(() => wrapupCleanup({ worktree: '/wt/feat', branch: 'feat/x' }), LedgerError);
});

test('wrapup-cleanup: SHA 对得上才 remove worktree，不 push --delete', () => {
  const calls = [];
  const gitRunner = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return SHA;
    if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/feat/x`;
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git';
    return '';
  };
  const out = wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    remote: 'origin',
    gitRunner,
    now: NOW,
  });
  assert.equal(out.ok, true);
  assert.equal(out.remoteDeleted, false);
  assert.equal(out.checked_at, NOW);
  assert.ok(calls.some((a) => a[0] === 'worktree' && a[1] === 'remove'));
  assert.equal(calls.some((a) => a.includes('--delete') || a[0] === 'push'), false);
});

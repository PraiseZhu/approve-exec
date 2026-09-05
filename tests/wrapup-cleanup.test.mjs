import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertReadyPr, confirmPrOpen } from '../scripts/confirm-pr-open.mjs';
import { wrapupCleanup } from '../scripts/wrapup-cleanup.mjs';
import { confirmWatchRegistered, parseRegisterStdout, runWatchCli, MINI_WATCH_STATE_DIR, MINI_HOST } from '../scripts/confirm-watch-registered.mjs';
import { confirmSessionArchived, extractArchiveResult } from '../scripts/confirm-session-archived.mjs';
import {
  LedgerError,
  PR_OPEN_RECEIPT_KEYS,
  CLEANUP_RECEIPT_KEYS,
  readPrOpenReceipt,
  readCleanupReceipt,
} from '../scripts/run-ledger.mjs';
import { miniWatchConfigSha256 } from '../scripts/lib/mini-watch-config.mjs';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const NOW = '2026-08-09T00:00:00Z';
const LATER = '2026-08-09T00:00:01Z';
const AFTER = '2026-08-09T00:00:02Z';
const takeoverAt = (at) => ({ schedule_id: 'fixture-script', first_scan_ack: NOW, last_scan_at: at, config_sha256: miniWatchConfigSha256() });
const STAMP = { ledgerVersion: 0, assignmentSeq: 0 };
const PATH_SEP = process.platform === 'win32' ? ';' : ':';

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
  assert.throws(
    () => assertReadyPr({
      url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
      state: 'OPEN',
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
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x';
    if (args[0] === 'status') return '';
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
    ...STAMP,
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
  const out = confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA, ghBin: gh, now: NOW, ...STAMP });
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
    fallbacks_tried: [],
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
  const stamp = () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const group = ledger.waves.flatMap((w) => w.groups).find((item) => item.group_id === g);
    return { ledger_version: ledger.version, assignment_seq: group?.assignment_seq ?? 0 };
  };
  const draftReceipt = join(dir, 'pr-open-draft.json');
  writeFileSync(draftReceipt, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1,
    headRefOid: SHA1,
    isDraft: true,
    state: 'OPEN',
    branch: 'feat/run-ledger',
    checked_at: LATER,
    ...stamp(),
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', draftReceipt);
  assert.equal(r.status, 2, 'draft PR 回执不得入账');
  const stalePrOpen = join(dir, 'pr-open-stale.json');
  writeFileSync(stalePrOpen, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1,
    headRefOid: SHA1,
    isDraft: false,
    state: 'OPEN',
    branch: 'feat/run-ledger',
    checked_at: T,
    ...stamp(),
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', stalePrOpen);
  assert.equal(r.status, 2, '早于 accepted 的 pr-open 回执不得入账');
  const prOpenReceipt = join(dir, 'pr-open-receipt.json');
  writeFileSync(prOpenReceipt, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1,
    headRefOid: SHA1,
    isDraft: false,
    state: 'OPEN',
    branch: 'feat/run-ledger',
    checked_at: LATER,
    ...stamp(),
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', prOpenReceipt);
  assert.equal(r.status, 0, r.stderr);
  const mintedEarly = stamp();
  const watchTooSoon = join(dir, 'watch-too-soon.json');
  writeFileSync(watchTooSoon, `${JSON.stringify({
    ok: true, owner: 'xindong', repo: 'mivo-canvas-plugin', pr_number: 1, branch: 'feat/run-ledger',
    state_file: '/mini/runtime/state/xindong__mivo-canvas-plugin__1.json',
    session_id: null, checked_at: LATER, takeover: takeoverAt(LATER), mini_watch_config_sha256: miniWatchConfigSha256(), ...mintedEarly,
  })}\n`);
  r = cli('note-event', ledgerPath, '--event', 'watch_registered', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    receipt: watchTooSoon,
  }), '--now', AFTER);
  assert.equal(r.status, 2, '仅 pr-open、本组尚未 pr_ready 不得发 Mini 盯梢');
  assert.match(r.stderr, /pr_ready/);
  r = cli('note-event', ledgerPath, '--event', 'pr_ready', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    current_pr_head_sha: 'f'.repeat(40),
  }), '--now', LATER);
  assert.equal(r.status, 2, '格式合法但不是已验收提交的 SHA 不得冒充 Ready');
  assert.match(r.stderr, /同代已验收/);
  r = cli('note-event', ledgerPath, '--event', 'pr_ready', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    current_pr_head_sha: SHA1, receipt: prOpenReceipt,
  }), '--now', LATER);
  assert.equal(r.status, 0, r.stderr);
  r = cli('note-event', ledgerPath, '--event', 'watch_registered', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    receipt: watchTooSoon,
  }), '--now', LATER);
  assert.equal(r.status, 2, 'pr_ready 入账后不得重放 Ready 前铸的 Mini 回执');
  assert.match(r.stderr, /pr_ready/);
  const fakeLocalWatch = join(dir, 'acme__app__1.json');
  writeFileSync(fakeLocalWatch, `${JSON.stringify({ owner: 'acme', repo: 'app', pr_number: 1, session_id: null })}\n`);
  r = cli('note-event', ledgerPath, '--event', 'watch_registered', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    state_file: fakeLocalWatch,
  }), '--now', AFTER);
  assert.equal(r.status, 2, '本机假名册不得冒充 Mini register 回执');
  const minted = stamp();
  const watchReceiptBody = confirmWatchRegistered({
    stdout: 'REGISTERED /mini/runtime/state/xindong__mivo-canvas-plugin__1.json\n',
    owner: 'xindong', repo: 'mivo-canvas-plugin', prNumber: 1, branch: 'feat/run-ledger',
    now: AFTER, takeover: takeoverAt(AFTER), ledgerVersion: minted.ledger_version, assignmentSeq: minted.assignment_seq,
  });
  const watchReceipt = join(dir, 'watch-receipt.json');
  writeFileSync(watchReceipt, `${JSON.stringify(watchReceiptBody)}\n`);
  r = cli('note-event', ledgerPath, '--event', 'watch_registered', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    receipt: watchReceipt,
  }), '--now', AFTER);
  assert.equal(r.status, 0, r.stderr);
  const cleanupReceipt = join(dir, 'cleanup-receipt.json');
  writeFileSync(cleanupReceipt, `${JSON.stringify({
    ok: true,
    skipped: false,
    branch: 'feat/run-ledger',
    worktree: '/wt/g4',
    sha: SHA1,
    remoteDeleted: false,
    checked_at: '2026-08-09T00:00:03Z',
    ...stamp(),
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
    checked_at: '2026-08-09T00:00:03Z',
    ...stamp(),
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'local-cleaned', '--now', T, '--cleanup-receipt', skippedCleanup);
  assert.equal(r.status, 2, 'skipped 清理回执不得入账');
  writeFileSync(cleanupReceipt, `${JSON.stringify({
    ok: true,
    skipped: false,
    branch: 'feat/run-ledger',
    worktree: '/wt/g4',
    sha: SHA1,
    remoteDeleted: false,
    checked_at: '2026-08-09T00:00:03Z',
    ...stamp(),
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'local-cleaned', '--now', T, '--cleanup-receipt', cleanupReceipt);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'archived', '--now', T);
  assert.equal(r.status, 2, 'local-cleaned→archived 缺 archive_sessions 回执必须拒');
  assert.match(r.stderr, /archive-receipt|archive_sessions/);
  const archiveMinted = stamp();
  const archiveReceiptBody = confirmSessionArchived({
    sessionId: 'sess-g4',
    archiveResult: {
      ok: true,
      status: 'archived',
      count: 1,
      changed: [{ session_id: 'sess-g4', status: 'archived' }],
    },
    now: AFTER, ledgerVersion: archiveMinted.ledger_version, assignmentSeq: archiveMinted.assignment_seq,
  });
  const archiveReceipt = join(dir, 'archive-receipt.json');
  writeFileSync(archiveReceipt, `${JSON.stringify(archiveReceiptBody)}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'archived', '--now', T, '--archive-receipt', archiveReceipt);
  assert.equal(r.status, 0, r.stderr);
});

test('cleanup 回执在其它写入先推高 version 后仍可消费（不绑全局 version 等值）', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'ready-wrapup-stale-version-'));
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
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'wrapup-stale-version', '--now', T, '--baseline', SHA3);
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
    fallbacks_tried: [],
  }), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const frozen = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  frozen.phase = 'ready';
  frozen.phase_at = T;
  writeFileSync(ledgerPath, `${JSON.stringify(frozen, null, 2)}\n`);
  const stamp = () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const item = ledger.waves.flatMap((w) => w.groups).find((x) => x.group_id === g);
    return { ledger_version: ledger.version, assignment_seq: item?.assignment_seq ?? 0 };
  };
  const prOpenReceipt = join(dir, 'pr-open-receipt.json');
  writeFileSync(prOpenReceipt, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1, headRefOid: SHA1, isDraft: false, state: 'OPEN', branch: 'feat/run-ledger',
    checked_at: LATER, ...stamp(),
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', prOpenReceipt);
  assert.equal(r.status, 0, r.stderr);
  r = cli('note-event', ledgerPath, '--event', 'pr_ready', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    current_pr_head_sha: SHA1, receipt: prOpenReceipt,
  }), '--now', LATER);
  assert.equal(r.status, 0, r.stderr);
  const watchReceipt = join(dir, 'watch-receipt.json');
  writeFileSync(watchReceipt, `${JSON.stringify({
    ok: true, owner: 'xindong', repo: 'mivo-canvas-plugin', pr_number: 1, branch: 'feat/run-ledger',
    state_file: '/mini/runtime/state/xindong__mivo-canvas-plugin__1.json',
    session_id: null, checked_at: AFTER, takeover: takeoverAt(AFTER), mini_watch_config_sha256: miniWatchConfigSha256(), ...stamp(),
  })}\n`);
  r = cli('note-event', ledgerPath, '--event', 'watch_registered', '--detail', JSON.stringify({
    group_id: g,
    pr_url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    receipt: watchReceipt,
  }), '--now', AFTER);
  assert.equal(r.status, 0, r.stderr);
  const cleanupReceipt = join(dir, 'cleanup-stale-version.json');
  writeFileSync(cleanupReceipt, `${JSON.stringify({
    ok: true, skipped: false, branch: 'feat/run-ledger', worktree: '/wt/g4', sha: SHA1,
    remoteDeleted: false, checked_at: '2026-08-09T00:00:03Z', ...stamp(),
  })}\n`);
  const bumped = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const minted = JSON.parse(readFileSync(cleanupReceipt, 'utf8'));
  bumped.version += 1;
  writeFileSync(ledgerPath, `${JSON.stringify(bumped, null, 2)}\n`);
  assert.ok(bumped.version > minted.ledger_version, '其它写入必须把 version 推高过 cleanup 回执');
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'local-cleaned', '--now', T, '--cleanup-receipt', cleanupReceipt);
  assert.equal(r.status, 0, '其它写入先推高 version 后，旧 ledger_version 的 cleanup 回执仍应可入账');
});

test('confirm-pr-open / wrapup-cleanup stdout 必须能被台账回执闸直接吃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrapup-stdout-'));
  const binDir = mkdtempSync(join(tmpdir(), 'gh-bin-'));
  const gh = join(binDir, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '{"url":"https://github.com/acme/app/pull/9","state":"OPEN","isDraft":false,"headRefOid":"${SHA}","number":9}\\n'\n`);
  chmodSync(gh, 0o755);
  const pr = confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA, ghBin: gh, now: NOW, ...STAMP });
  assert.deepEqual(Object.keys(pr).sort(), [...PR_OPEN_RECEIPT_KEYS].sort());
  const prPath = join(dir, 'pr-open.json');
  writeFileSync(prPath, `${JSON.stringify(pr)}\n`);
  assert.equal(readPrOpenReceipt(prPath).number, 9);

  const gitRunner = (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x';
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return SHA;
    if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/feat/x`;
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git';
    if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /repo\n';
    if (args[0] === 'branch' && args[1] === '--list') return '';
    return '';
  };
  const cleaned = wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    remote: 'origin',
    gitRunner,
    now: NOW,
    ...STAMP,
  });
  assert.deepEqual(Object.keys(cleaned).sort(), [...CLEANUP_RECEIPT_KEYS].sort());
  const cleanupPath = join(dir, 'cleanup.json');
  writeFileSync(cleanupPath, `${JSON.stringify(cleaned)}\n`);
  assert.equal(readCleanupReceipt(cleanupPath).ok, true);
});

test('pr-open 时区偏移不得绕过晚于 accepted 的 epoch 比较', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'pr-open-tz-'));
  const ledgerPath = join(dir, 'ledger.json');
  const T = '2026-08-08T16:00:00Z';
  const SHA1 = 'a'.repeat(40);
  const SHA3 = 'c'.repeat(40);
  const GATE_GOAL_SHA = '7d7b9d9b97c99b39de5cbbd6b20e4869afe4cb16dab1dc91833a94a29dca356e';
  const GATE_ROUTING_SHA = 'e88009fec5d61472d41554b8c0238c6eedd1395d8b301cbc1524d121dc386c23';
  const ROUTING_LIVE = '/Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/orca-fanout/routing.json';
  const GOAL_SKILL_PI = '/Users/praise/.agents/skills/goal/SKILL.md';
  const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/run-ledger.mjs'), ...args], { encoding: 'utf8' });
  const manifestPath = join(dir, 'sample-manifest.json');
  copyFileSync(join(root, 'tests/fixtures/sample-manifest.json'), manifestPath);
  let r = cli('init', ledgerPath, '--manifest', manifestPath, '--run-id', 'tz-pr-open', '--now', T, '--baseline', SHA3);
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
    fallbacks_tried: [],
  }), '--now', T);
  assert.equal(r.status, 0, r.stderr);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'accepted', '--now', T);
  assert.equal(r.status, 0, r.stderr);
  const frozen = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  frozen.phase = 'ready';
  frozen.phase_at = T;
  writeFileSync(ledgerPath, `${JSON.stringify(frozen, null, 2)}\n`);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const tzEarlier = join(dir, 'pr-open-tz.json');
  writeFileSync(tzEarlier, `${JSON.stringify({
    url: 'https://github.com/xindong/mivo-canvas-plugin/pull/1',
    number: 1, headRefOid: SHA1, isDraft: false, state: 'OPEN', branch: 'feat/run-ledger',
    checked_at: '2026-08-09T00:00:00+09:00',
    ledger_version: ledger.version, assignment_seq: 0,
  })}\n`);
  r = cli('set-state', ledgerPath, '--group', g, '--to', 'pr-open', '--now', T, '--pr-open-receipt', tzEarlier);
  assert.equal(r.status, 2, '时区偏移后实际更早的 pr-open 回执必须拒');
  assert.match(r.stderr, /不得早于或等于/);
});

test('confirm-watch-registered 只吃 register.mjs 真实 stdout', () => {
  const parsed = parseRegisterStdout('REGISTERED /mini/runtime/state/xindong__mivo-canvas-plugin__1.json\n');
  assert.equal(parsed.kind, 'REGISTERED');
  const receipt = confirmWatchRegistered({
    stdout: 'ALREADY /mini/runtime/state/xindong__mivo-canvas-plugin__1.json\n',
    owner: 'xindong', repo: 'mivo-canvas-plugin', prNumber: 1, branch: 'feat/run-ledger',
    now: LATER, takeover: takeoverAt(LATER), ledgerVersion: 12, assignmentSeq: 0,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.pr_number, 1);
  assert.equal(receipt.session_id, null);
  assert.equal(receipt.mini_watch_config_sha256, miniWatchConfigSha256());
  assert.throws(() => parseRegisterStdout('ok true\n'), LedgerError);
});

test('confirm-session-archived 只吃 archive_sessions 工具结果', () => {
  const payload = {
    ok: true,
    status: 'archived',
    count: 1,
    changed: [{ session_id: 'sess-g4', status: 'archived' }],
  };
  const extracted = extractArchiveResult(payload, 'sess-g4');
  assert.equal(extracted.archived, true);
  const receipt = confirmSessionArchived({
    sessionId: 'sess-g4',
    archiveResult: JSON.stringify(payload),
    now: LATER, ledgerVersion: 13, assignmentSeq: 0,
  });
  assert.equal(receipt.archived, true);
  assert.throws(() => extractArchiveResult({ ok: true, archived: true }, 'never-archived'), LedgerError);
  assert.throws(() => extractArchiveResult({
    ok: true, status: 'archived', changed: [{ session_id: 'other', status: 'archived' }],
  }, 'target-not-in-changed'), LedgerError);
});

test('confirm-watch-registered CLI 拒 --stdout，state-dir 必须钉 Mini 名册', () => {
  assert.throws(() => runWatchCli([
    '--stdout', 'REGISTERED /fake/xindong__mivo-canvas-plugin__22.json',
    '--owner', 'xindong', '--repo', 'mivo-canvas-plugin', '--pr', '22',
    '--branch', 'feat/x', '--now', LATER, '--ledger-version', '1', '--assignment-seq', '0',
  ]), LedgerError);
  assert.throws(() => runWatchCli([
    '--state-dir', '/tmp/not-watch-state',
    '--owner', 'xindong', '--repo', 'mivo-canvas-plugin', '--pr', '22',
    '--branch', 'feat/x', '--now', LATER, '--ledger-version', '1', '--assignment-seq', '0',
  ]), LedgerError);
  assert.throws(() => runWatchCli([
    '--host', 'Not-Mini',
    '--owner', 'xindong', '--repo', 'mivo-canvas-plugin', '--pr', '22',
    '--branch', 'feat/x', '--now', LATER, '--ledger-version', '1', '--assignment-seq', '0',
  ]), LedgerError);
  const sshCalls = [];
  const out = runWatchCli([
    '--state-dir', MINI_WATCH_STATE_DIR,
    '--owner', 'xindong', '--repo', 'mivo-canvas-plugin', '--pr', '1',
    '--branch', 'feat/run-ledger', '--now', LATER, '--ledger-version', '1', '--assignment-seq', '0',
  ], {
    sshRunner: (args) => {
      sshCalls.push(args);
      if (args.at(-1).includes('takeover.mjs')) return {status:0,stdout:JSON.stringify(takeoverAt(LATER)),stderr:''};
      return { status: 0, stdout: 'REGISTERED /Users/praise/pr-autopilot-runtime/state/xindong__mivo-canvas-plugin__1.json\n', stderr: '' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.pr_number, 1);
  assert.ok(JSON.stringify(sshCalls[0]).includes(MINI_WATCH_STATE_DIR));
  assert.equal(sshCalls[0][2], MINI_HOST);
});

test('watch CLI 的 ssh 不经 PATH 解析：PATH 前置伪 ssh 铸不出回执', () => {
  // Sol 六轮: spawnSync('ssh') 裸命令名经 PATH 解析，前置伪 ssh 可在未连接 Mini 时铸 ok:true。
  // 修复: 生产 runner 钉死 config/mini-watch.json ssh_bin 绝对路径。验证方式（无副作用）:
  // PATH 前置伪 ssh（被调用会留 called.txt 并伪造 REGISTERED 成功输出 + exit 0），
  // 用 --pr 0 跑生产 CLI——0 不匹配 register.mjs 的 /^[1-9]\d*$/，远端 registerPr 必然
  // 拒绝（不写任何状态文件，连接本身无害）。断言:
  //   1) called.txt 不存在——生产代码没经 PATH 解析到伪 ssh（走了配置里的绝对 ssh_bin）;
  //   2) CLI exit 非 0——若走了伪 ssh，其 exit 0 + 伪造 stdout 会让 CLI 铸出 ok:true;
  //   3) stdout 无 ok:true、无伪 ssh 的 REGISTERED 内容。
  const binDir = mkdtempSync(join(tmpdir(), 'fake-ssh-bin-'));
  const fakeSsh = join(binDir, 'ssh');
  const called = join(binDir, 'called.txt');
  writeFileSync(fakeSsh, `#!/bin/sh\nprintf 'called\\n' > "${called}"\nprintf 'REGISTERED /Users/praise/pr-autopilot-runtime/state/fakeowner__fakerepo__999.json\\n'\nexit 0\n`);
  chmodSync(fakeSsh, 0o755);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync(process.execPath, [join(root, 'scripts/confirm-watch-registered.mjs'),
    '--owner', 'xindong', '--repo', 'mivo-canvas-plugin', '--pr', '0',
    '--branch', 'feat/x', '--now', LATER, '--ledger-version', '1', '--assignment-seq', '0',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
    },
    timeout: 60_000,
  });
  assert.equal(existsSync(called), false, '生产 CLI 不得经 PATH 解析到伪 ssh');
  assert.notEqual(r.status, 0, `--pr 0 必须失败: 远端 register 拒绝或本地校验拒绝（stdout: ${r.stdout}）`);
  assert.doesNotMatch(r.stdout, /"ok":\s*true/, 'PATH 劫持下不得铸出 ok:true watch 回执');
  assert.doesNotMatch(r.stdout, /fakeowner__fakerepo__999/, '伪 ssh 的 REGISTERED 输出不得进入回执');
});

test('confirm-pr-open / wrapup-cleanup 缺 --now 拒', () => {
  assert.throws(() => confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA }), LedgerError);
  assert.throws(() => wrapupCleanup({ worktree: '/wt/feat', branch: 'feat/x' }), LedgerError);
  assert.throws(() => confirmPrOpen({ repo: 'acme/app', branch: 'feat/x', head: SHA, now: 'zzzz', ...STAMP }), LedgerError);
  assert.throws(() => wrapupCleanup({ worktree: '/wt/feat', branch: 'feat/x', now: 'zzzz', ...STAMP }), LedgerError);
});

test('wrapup-cleanup: 分支不对 / dirty / 删不掉都拒', () => {
  assert.throws(() => wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    gitRunner: (args) => (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'feat/other' : ''),
    now: NOW,
    ...STAMP,
  }), LedgerError);
  assert.throws(() => wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    gitRunner: (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x';
      if (args[0] === 'status') return ' M src.ts';
      return '';
    },
    now: NOW,
    ...STAMP,
  }), LedgerError);
  assert.throws(() => wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    gitRunner: (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x';
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return SHA;
      if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/feat/x`;
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git';
      if (args[0] === 'worktree' && args[1] === 'remove') return '';
      if (args[0] === 'branch' && args[1] === '-D') throw Object.assign(new Error('branch still there'), { code: 'PRECONDITION' });
      return '';
    },
    now: NOW,
    ...STAMP,
  }));
});

test('wrapup-cleanup: SHA 对得上才 remove worktree，不 push --delete', () => {
  const calls = [];
  const gitRunner = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feat/x';
    if (args[0] === 'status') return '';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return SHA;
    if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/feat/x`;
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git';
    if (args[0] === 'worktree' && args[1] === 'list') return 'worktree /repo\n';
    if (args[0] === 'branch' && args[1] === '--list') return '';
    return '';
  };
  const out = wrapupCleanup({
    worktree: '/wt/feat',
    branch: 'feat/x',
    remote: 'origin',
    gitRunner,
    now: NOW,
    ...STAMP,
  });
  assert.equal(out.ok, true);
  assert.equal(out.remoteDeleted, false);
  assert.equal(out.checked_at, NOW);
  assert.ok(calls.some((a) => a[0] === 'worktree' && a[1] === 'remove'));
  assert.equal(calls.some((a) => a.includes('--delete') || a[0] === 'push'), false);
});

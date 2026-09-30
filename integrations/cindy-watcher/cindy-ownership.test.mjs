import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WATCH_HOMES, WATCHED_REPO, lookupWatchOwner, resolveWatchHome, runOwnershipCli,
} from './bin/cindy-ownership.mjs';

const bin = fileURLToPath(new URL('./bin/cindy-ownership.mjs', import.meta.url));
const nodeId = 'PR_790';
const sessionId = '7d1b6bc0-aaaa-bbbb-cccc-ddddeeeeffff';

function homeOf(t, { v2 = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const entry = {
    number: 790, nodeId, sessionId, scheduleId: 'sched-790',
    eligibility: 'active', activeTask: { status: 'accepted' },
    optOut: false, closedHandled: false,
    dispatchConflict: {
      bindSession: sessionId, receiptSession: 'sess-other', dispatchId: 'live-790-x', at: '2026-09-28T00:00:00Z',
    },
  };
  if (v2) {
    fs.mkdirSync(path.join(home, 'state/prs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state/prs', `${nodeId}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  } else {
    fs.writeFileSync(path.join(home, 'state/state.json'), JSON.stringify({ version: 1, prs: { [nodeId]: entry } }));
  }
  return { home, entry };
}

function spawnCli(args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', env: { ...process.env, ...extra.env }, timeout: 15_000,
  });
}

test('v2 按 --pr 命中且带 dispatchConflict', (t) => {
  const { home } = homeOf(t);
  const result = lookupWatchOwner({ home, repo: WATCHED_REPO, pr: 790 });
  assert.equal(result.owned, true);
  assert.equal(result.pr, 790);
  assert.equal(result.nodeId, nodeId);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.scheduleId, 'sched-790');
  assert.equal(result.status, 'accepted');
  assert.equal(result.source, 'v2');
  assert.equal(result.home, home);
  assert.equal(result.closed, false);
  assert.equal(result.dispatchConflict.bindSession, sessionId);
  assert.equal(result.dispatchConflict.receiptSession, 'sess-other');
  const cli = spawnCli(['--repo', WATCHED_REPO, '--pr', '790', '--home', home]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).sessionId, sessionId);
  assert.equal(JSON.parse(cli.stdout).dispatchConflict.receiptSession, 'sess-other');
});

test('v2 按 --session-id 命中', (t) => {
  const { home } = homeOf(t);
  const result = lookupWatchOwner({ home, repo: WATCHED_REPO, sessionId });
  assert.equal(result.owned, true);
  assert.equal(result.pr, 790);
  const cli = spawnCli(['--repo', WATCHED_REPO, '--session-id', sessionId, '--home', home]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).owned, true);
});

test('legacy 回退命中', (t) => {
  const { home } = homeOf(t, { v2: false });
  const result = lookupWatchOwner({ home, repo: WATCHED_REPO, pr: 790 });
  assert.equal(result.owned, true);
  assert.equal(result.source, 'legacy');
  assert.equal(result.sessionId, sessionId);
});

test('v2 目录存在时不回退 legacy', (t) => {
  const { home } = homeOf(t);
  fs.writeFileSync(path.join(home, 'state/state.json'), JSON.stringify({
    prs: { PR_1: { number: 1, sessionId: 'legacy-only' } },
  }));
  const result = lookupWatchOwner({ home, repo: WATCHED_REPO, sessionId: 'legacy-only' });
  assert.equal(result.owned, false);
  assert.equal(result.reason, 'not-found');
});

test('未命中', (t) => {
  const { home } = homeOf(t);
  const result = lookupWatchOwner({ home, repo: WATCHED_REPO, pr: 1 });
  assert.equal(result.owned, false);
  assert.equal(result.reason, 'not-found');
  const cli = spawnCli(['--repo', WATCHED_REPO, '--pr', '1', '--home', home]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).reason, 'not-found');
});

test('非 Cindy 仓直接 repo-not-watched', (t) => {
  const { home } = homeOf(t);
  const result = lookupWatchOwner({ home, repo: 'acme/app', pr: 790 });
  assert.equal(result.owned, false);
  assert.equal(result.reason, 'repo-not-watched');
});

test('state 不可读退出码 3', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-bad-'));
  t.after(() => { try { fs.chmodSync(path.join(home, 'state/prs'), 0o700); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, 'state/prs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/prs', `${nodeId}.json`), '{not-json');
  const result = lookupWatchOwner({ home, repo: WATCHED_REPO, pr: 790 });
  assert.equal(result.owned, false);
  assert.equal(result.reason, 'state-unreadable');
  assert.ok(result.error);
  const cli = spawnCli(['--repo', WATCHED_REPO, '--pr', '790', '--home', home]);
  assert.equal(cli.status, 3, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).reason, 'state-unreadable');
});

test('缺 state 也是 state-unreadable 退出码 3', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-empty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cli = spawnCli(['--repo', WATCHED_REPO, '--pr', '790', '--home', home]);
  assert.equal(cli.status, 3, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).reason, 'state-unreadable');
});

test('home 解析优先级 --home > 环境 > 第一个含 state 的默认路径', (t) => {
  const envHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-env-'));
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-first-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-second-'));
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-explicit-'));
  t.after(() => {
    for (const dir of [envHome, first, second, explicit]) fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(envHome, 'state'));
  fs.mkdirSync(path.join(first, 'state'));
  fs.mkdirSync(path.join(second, 'state'));
  const candidates = [first, second];
  assert.equal(resolveWatchHome({ home: explicit, env: { CINDY_WATCHER_HOME: envHome }, candidates }), explicit);
  assert.equal(resolveWatchHome({ env: { CINDY_WATCHER_HOME: envHome }, candidates }), envHome);
  assert.equal(resolveWatchHome({ env: {}, candidates }), first);
  fs.rmSync(path.join(first, 'state'), { recursive: true, force: true });
  assert.equal(resolveWatchHome({ env: {}, candidates }), second);
  assert.equal(DEFAULT_WATCH_HOMES[0].includes('Project CINDY'), true);
  assert.equal(DEFAULT_WATCH_HOMES[1].includes('cindy-watcher'), true);
});

test('CLI 缺参或同时给 --pr 与 --session-id 退出码 2', () => {
  const missing = spawnCli(['--pr', '1']);
  assert.equal(missing.status, 2);
  const both = spawnCli(['--repo', WATCHED_REPO, '--pr', '1', '--session-id', 'x']);
  assert.equal(both.status, 2);
  assert.equal(runOwnershipCli(['--repo', WATCHED_REPO]), 2);
});

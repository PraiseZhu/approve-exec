import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireDeployExclusive, acquireLock, listPrs, lockAcquireHooks,
  LOCK_RECLAIM_GUARD_STALE_MS, LOCK_STALE_GRACE_MS,
  migrateLegacy, PR_LOCK_TOKEN_ENV, readPr, statePaths, withLock, writePr,
} from './bin/cindy-state.mjs';

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function stuck(extra = {}) {
  return {
    number: extra.number ?? 790,
    pendingDispatch: { status: 'unconfirmed', dispatchId: 'old' },
    dispatchError: { kind: 'unknown-dispatch-receipt', message: 'timeout' },
    ...extra,
  };
}

test('writePr is atomic 0600 and readPr/listPrs round-trip', (t) => {
  const home = homeOf(t);
  writePr(home, 'PR_1', { number: 1, sessionId: 's1' });
  const file = path.join(statePaths(home).prsDir, 'PR_1.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(statePaths(home).prsDir).some((n) => n.includes('.tmp-')), false);
  writePr(home, 'PR_1', { number: 1, sessionId: 's2' });
  assert.equal(readPr(home, 'PR_1').sessionId, 's2');
  assert.equal(readPr(home, 'PR_missing'), null);
  assert.equal(listPrs(home).length, 1);
});

function lockJson(pid, token = 'tok') {
  return `${JSON.stringify({ pid, token, createdAt: '2026-09-28T00:00:00.000Z' })}\n`;
}
function lockLegacy(pid, token = 'oldtok') {
  return `${pid} 2026-09-28T00:00:00.000Z ${token}\n`;
}

function waitForFile(file, timeoutMs, label) {
  const start = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
}

test('live lock returns held and does not run fn', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'pr-PR_1.lock'), lockJson(process.pid, 'live'));
  let ran = false;
  const result = withLock(home, 'pr-PR_1', () => { ran = true; return 'ran'; });
  assert.deepEqual(result, { held: true });
  assert.equal(ran, false);
});

test('dead lock is reclaimed and fn runs', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'discover.lock'), lockJson(999999, 'dead'));
  const result = withLock(home, 'discover', () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(fs.existsSync(path.join(locksDir, 'discover.lock')), false);
});

test('two different PR locks do not block each other', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'pr-PR_1.lock'), lockJson(process.pid, 'live'));
  let ran = false;
  const result = withLock(home, 'pr-PR_2', () => { ran = true; return 'b'; });
  assert.equal(result, 'b');
  assert.equal(ran, true);
});

test('child process with lock token reenters; without token is held', (t) => {
  const home = homeOf(t);
  const lock = acquireLock(home, 'pr-PR_1');
  t.after(() => lock.release());
  assert.equal(lock.held, false);
  const modulePath = fileURLToPath(new URL('./bin/cindy-state.mjs', import.meta.url));
  const script = `import { acquireLock } from ${JSON.stringify(modulePath)}; const r = acquireLock(process.argv[1], 'pr-PR_1'); process.stdout.write(JSON.stringify({ held: r.held === true, reentrant: r.reentrant === true }));`;
  const withToken = spawnSync(process.execPath, ['--input-type=module', '-e', script, home], {
    encoding: 'utf8', env: { ...process.env, [PR_LOCK_TOKEN_ENV]: lock.token },
  });
  assert.equal(withToken.status, 0, withToken.stderr);
  assert.deepEqual(JSON.parse(withToken.stdout), { held: false, reentrant: true });
  const without = spawnSync(process.execPath, ['--input-type=module', '-e', script, home], {
    encoding: 'utf8', env: { ...process.env, [PR_LOCK_TOKEN_ENV]: '' },
  });
  assert.equal(without.status, 0, without.stderr);
  assert.equal(JSON.parse(without.stdout).held, true);
});

test('migrateLegacy only copies open entries and leaves state.json untouched', (t) => {
  const home = homeOf(t);
  const paths = statePaths(home);
  fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
  const legacy = {
    version: 2,
    prs: {
      PR_open: { number: 1, sessionId: 's-open' },
      PR_closed: { number: 2, sessionId: 's-closed' },
      PR_stuck: stuck({ number: 790, sessionId: 's-790' }),
    },
  };
  const raw = `${JSON.stringify(legacy, null, 2)}\n`;
  fs.writeFileSync(paths.legacyPath, raw);
  const first = migrateLegacy(home, ['PR_open', 'PR_stuck']);
  assert.equal(first.migrated, true);
  assert.equal(first.count, 2);
  assert.equal(fs.readFileSync(paths.legacyPath, 'utf8'), raw);
  assert.equal(readPr(home, 'PR_closed'), null);
  assert.equal(readPr(home, 'PR_open').migratedFrom, 'state.json');
  assert.equal(readPr(home, 'PR_open').sessionId, 's-open');
  const index = JSON.parse(fs.readFileSync(paths.indexPath, 'utf8'));
  assert.equal(index.version, 2);
  assert.equal(index.legacySha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(typeof index.migratedAt, 'string');
  const second = migrateLegacy(home, ['PR_open', 'PR_stuck', 'PR_closed']);
  assert.deepEqual(second, { migrated: false, reason: 'prs-not-empty' });
  assert.equal(readPr(home, 'PR_closed'), null);
  assert.equal(listPrs(home).length, 2);
});

test('migrateLegacy lifts stuck pending with sessionId into legacyPending', (t) => {
  const home = homeOf(t);
  const paths = statePaths(home);
  fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
  fs.writeFileSync(paths.legacyPath, JSON.stringify({ prs: { PR_790: stuck({ sessionId: 'sess-790' }) } }));
  migrateLegacy(home, ['PR_790']);
  const entry = readPr(home, 'PR_790');
  assert.equal(entry.sessionId, 'sess-790');
  assert.equal(entry.pendingDispatch, null);
  assert.equal(entry.dispatchError, null);
  assert.equal(entry.legacyPending.pendingDispatch.status, 'unconfirmed');
  assert.equal(entry.legacyPending.dispatchError.kind, 'unknown-dispatch-receipt');
});

test('migrateLegacy lifts stuck pending without sessionId into legacyPending', (t) => {
  const home = homeOf(t);
  const paths = statePaths(home);
  fs.mkdirSync(path.dirname(paths.legacyPath), { recursive: true });
  fs.writeFileSync(paths.legacyPath, JSON.stringify({ prs: { PR_811: stuck({ number: 811 }) } }));
  migrateLegacy(home, ['PR_811']);
  const entry = readPr(home, 'PR_811');
  assert.equal(entry.sessionId, undefined);
  assert.equal(entry.pendingDispatch, null);
  assert.equal(entry.dispatchError, null);
  assert.equal(entry.legacyPending.dispatchError.kind, 'unknown-dispatch-receipt');
});

test('unparseable lock is live until mtime exceeds grace', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, 'discover.lock');
  fs.writeFileSync(lockPath, 'not-json\n');
  const live = acquireLock(home, 'discover');
  assert.equal(live.held, true);
  const past = (Date.now() - LOCK_STALE_GRACE_MS - 2000) / 1000;
  fs.utimesSync(lockPath, past, past);
  const reclaimed = withLock(home, 'discover', () => 'ok');
  assert.equal(reclaimed, 'ok');
  assert.equal(fs.existsSync(lockPath), false);
});

test('release only deletes lock when token matches', (t) => {
  const home = homeOf(t);
  const lockPath = path.join(statePaths(home).locksDir, 'pr-PR_1.lock');
  const held = acquireLock(home, 'pr-PR_1');
  t.after(() => held.release());
  assert.equal(held.held, false);
  const other = acquireLock(home, 'pr-PR_1');
  assert.equal(other.held, true);
  other.release();
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, held.token);
  held.release();
  assert.equal(fs.existsSync(lockPath), false);
});

function spawnPauser(t, home, lockName, dir, label) {
  const modulePath = fileURLToPath(new URL('./bin/cindy-state.mjs', import.meta.url));
  const pause = path.join(dir, `${label}.pause`);
  const resume = path.join(dir, `${label}.resume`);
  const result = path.join(dir, `${label}.result`);
  const releaseAt = path.join(dir, `${label}.release`);
  const script = `
    import fs from 'node:fs';
    import { acquireLock, lockAcquireHooks } from ${JSON.stringify(modulePath)};
    const [home, name, pause, resume, result, releaseAt] = process.argv.slice(1);
    lockAcquireHooks.afterStaleDetected = () => {
      fs.writeFileSync(pause, '1');
      while (!fs.existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    };
    const r = acquireLock(home, name);
    fs.writeFileSync(result, JSON.stringify({
      held: r.held === true, token: r.token ?? null, pid: process.pid,
    }));
    if (r.held === true) r.release();
    else {
      while (!fs.existsSync(releaseAt)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      r.release();
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, home, lockName, pause, resume, result, releaseAt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [PR_LOCK_TOKEN_ENV]: '' },
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return { label, pause, resume, result, releaseAt, child };
}

function deployBusy(home, lockName) {
  if (lockName === 'deploy') assert.throws(() => acquireDeployExclusive(home), /deploy lock held/);
  else assert.throws(() => acquireDeployExclusive(home), /runtime lock held/);
}

function runStaleRace(t, lockName) {
  const home = homeOf(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => { lockAcquireHooks.afterStaleDetected = null; });
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, `${lockName}.lock`);
  fs.writeFileSync(lockPath, lockJson(999999, 'stale'));
  const children = ['a', 'b'].map((label) => spawnPauser(t, home, lockName, dir, label));
  for (const item of children) waitForFile(item.pause, 8000, `${item.label}.pause`);
  for (const item of children) fs.writeFileSync(item.resume, '1');
  for (const item of children) waitForFile(item.result, 8000, `${item.label}.result`);
  const reports = children.map((item) => JSON.parse(fs.readFileSync(item.result, 'utf8')));
  const winners = reports.filter((item) => item.held === false);
  const losers = reports.filter((item) => item.held === true);
  assert.equal(winners.length, 1, JSON.stringify(reports));
  assert.equal(losers.length, 1, JSON.stringify(reports));
  assert.equal(fs.existsSync(lockPath), true);
  const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(payload.token, winners[0].token);
  assert.equal(payload.pid, winners[0].pid);
  deployBusy(home, lockName);
  for (const item of children) fs.writeFileSync(item.releaseAt, '1');
  const goneAt = Date.now() + 8000;
  while (fs.existsSync(lockPath) && Date.now() < goneAt) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(fs.existsSync(lockPath), false);
  return { home, reports };
}

test('stale PR lock reclaim is atomic across two processes', (t) => {
  runStaleRace(t, 'pr-PR_1');
});

test('stale deploy.lock reclaim is atomic across two processes', (t) => {
  runStaleRace(t, 'deploy');
});

function runStalePauseThenOtherTakes(t, lockName) {
  const home = homeOf(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-pause-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => { lockAcquireHooks.afterStaleDetected = null; });
  const lockPath = path.join(statePaths(home).locksDir, `${lockName}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, lockJson(999999, 'stale'));
  const child = spawnPauser(t, home, lockName, dir, 'a');
  waitForFile(child.pause, 8000, 'a.pause');
  const taken = acquireLock(home, lockName);
  t.after(() => taken.release());
  assert.equal(taken.held, false);
  const before = fs.readFileSync(lockPath, 'utf8');
  assert.equal(JSON.parse(before).token, taken.token);
  deployBusy(home, lockName);
  const third = acquireLock(home, lockName);
  assert.equal(third.held, true);
  third.release();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
  fs.writeFileSync(child.resume, '1');
  waitForFile(child.result, 8000, 'a.result');
  const report = JSON.parse(fs.readFileSync(child.result, 'utf8'));
  assert.equal(report.held, true);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), before);
  assert.equal(JSON.parse(before).token, taken.token);
  deployBusy(home, lockName);
  fs.writeFileSync(child.releaseAt, '1');
  taken.release();
}

test('paused stale reclaim cannot steal a lock taken by another process', (t) => {
  runStalePauseThenOtherTakes(t, 'pr-PR_1');
});

test('paused stale deploy.lock reclaim cannot steal a lock taken by another process', (t) => {
  runStalePauseThenOtherTakes(t, 'deploy');
});

test('occupied reclaim guard returns busy and leaves the lock unchanged', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, 'discover.lock');
  const stale = lockJson(999999, 'dead');
  fs.writeFileSync(lockPath, stale);
  const guardPath = `${lockPath}.reclaim`;
  fs.mkdirSync(guardPath);
  fs.writeFileSync(path.join(guardPath, 'owner'), `${JSON.stringify({
    pid: process.pid, token: 'guard', createdAt: new Date().toISOString(),
  })}\n`);
  t.after(() => fs.rmSync(guardPath, { recursive: true, force: true }));
  const result = acquireLock(home, 'discover');
  assert.equal(result.held, true);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), stale);
  assert.equal(fs.existsSync(guardPath), true);
  assert.throws(() => acquireDeployExclusive(home), /runtime lock held/);
});

test('stale reclaim guard is swept after 30s; same call stays busy', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  const lockPath = path.join(locksDir, 'discover.lock');
  const guardPath = `${lockPath}.reclaim`;
  const stale = lockJson(999999, 'dead');
  fs.writeFileSync(lockPath, stale);
  fs.mkdirSync(guardPath);
  fs.writeFileSync(path.join(guardPath, 'owner'), `${JSON.stringify({
    pid: 999999, token: 'g', createdAt: '2020-01-01T00:00:00.000Z',
  })}\n`);
  const past = (Date.now() - LOCK_RECLAIM_GUARD_STALE_MS - 1000) / 1000;
  fs.utimesSync(guardPath, past, past);
  const first = acquireLock(home, 'discover');
  assert.equal(first.held, true);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), stale);
  assert.equal(fs.existsSync(guardPath), false);
  const second = withLock(home, 'discover', () => 'ok');
  assert.equal(second, 'ok');
});

test('legacy live lock with old mtime is not reclaimed and old token reenters', (t) => {
  const home = homeOf(t);
  const lockPath = path.join(statePaths(home).locksDir, 'pr-PR_1.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const bytes = lockLegacy(process.pid, 'legacy-token');
  fs.writeFileSync(lockPath, bytes);
  const past = (Date.now() - 90_000) / 1000;
  fs.utimesSync(lockPath, past, past);
  const blocked = acquireLock(home, 'pr-PR_1');
  assert.equal(blocked.held, true);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), bytes);
  assert.throws(() => acquireDeployExclusive(home), /runtime lock held/);
  const reenter = acquireLock(home, 'pr-PR_1', { ...process.env, [PR_LOCK_TOKEN_ENV]: 'legacy-token' });
  assert.equal(reenter.held, false);
  assert.equal(reenter.reentrant, true);
  reenter.release();
  assert.equal(fs.existsSync(lockPath), true);
});

test('legacy lock token can be released', (t) => {
  const home = homeOf(t);
  const held = acquireLock(home, 'pr-PR_1');
  t.after(() => held.release());
  const lockPath = path.join(statePaths(home).locksDir, 'pr-PR_1.lock');
  fs.writeFileSync(lockPath, lockLegacy(process.pid, held.token));
  held.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('legacy dead lock can be reclaimed', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'discover.lock'), lockLegacy(999999, 'dead-legacy'));
  const result = withLock(home, 'discover', () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(fs.existsSync(path.join(locksDir, 'discover.lock')), false);
});

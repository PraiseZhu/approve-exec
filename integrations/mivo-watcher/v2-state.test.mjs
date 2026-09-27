import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { listPrs, migrateLegacy, readPr, statePaths, withLock, writePr } from './bin/mivo-state.mjs';

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

test('live lock returns held and does not run fn', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'pr-PR_1.lock'), `${process.pid} 2026-09-28T00:00:00.000Z\n`);
  let ran = false;
  const result = withLock(home, 'pr-PR_1', () => { ran = true; return 'ran'; });
  assert.deepEqual(result, { held: true });
  assert.equal(ran, false);
});

test('dead lock is reclaimed and fn runs', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'discover.lock'), '999999 2026-09-28T00:00:00.000Z\n');
  const result = withLock(home, 'discover', () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(fs.existsSync(path.join(locksDir, 'discover.lock')), false);
});

test('two different PR locks do not block each other', (t) => {
  const home = homeOf(t);
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true });
  fs.writeFileSync(path.join(locksDir, 'pr-PR_1.lock'), `${process.pid} 2026-09-28T00:00:00.000Z\n`);
  let ran = false;
  const result = withLock(home, 'pr-PR_2', () => { ran = true; return 'b'; });
  assert.equal(result, 'b');
  assert.equal(ran, true);
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

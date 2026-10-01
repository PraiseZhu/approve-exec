#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Shared by watcher (writes it) and repair helper (refuses superseded tasks).
export const AUTHOR_RECLAIMED = 'author-reclaimed';
export const PR_LOCK_TOKEN_ENV = 'CINDY_PR_LOCK_TOKEN';
export const DEPLOY_LOCK_NAME = 'deploy';
export const HELPER_LOCK_NAME = 'helper';
export const LOCK_STALE_GRACE_MS = 60_000;
export const lockAcquireHooks = { afterStaleDetected: null };

export function helperLockName(pr) {
  const number = Number(pr);
  if (Number.isInteger(number) && number >= 1) return `helper-pr-${number}`;
  return HELPER_LOCK_NAME;
}

export function statePaths(home) {
  const stateDir = path.join(home, 'state');
  return {
    prsDir: path.join(stateDir, 'prs'),
    indexPath: path.join(stateDir, 'index.json'),
    legacyPath: path.join(stateDir, 'state.json'),
    locksDir: path.join(stateDir, 'locks'),
  };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function prPath(home, nodeId) {
  return path.join(statePaths(home).prsDir, `${nodeId}.json`);
}

export function readPr(home, nodeId) {
  const file = prPath(home, nodeId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writePr(home, nodeId, entry) {
  atomicJson(prPath(home, nodeId), entry);
}

export function listPrs(home) {
  const { prsDir } = statePaths(home);
  if (!fs.existsSync(prsDir)) return [];
  return fs.readdirSync(prsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readPr(home, name.slice(0, -'.json'.length)));
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function parseLockPayload(text) {
  try {
    const data = JSON.parse(String(text));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (!Number.isSafeInteger(data.pid) || data.pid <= 0) return null;
    if (typeof data.token !== 'string' || !data.token.trim()) return null;
    if (typeof data.createdAt !== 'string' || !data.createdAt) return null;
    return { pid: data.pid, token: data.token, createdAt: data.createdAt };
  } catch {
    return null;
  }
}

function readLock(lockPath) {
  try { return fs.readFileSync(lockPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function lockAgeMs(lockPath) {
  try { return Date.now() - fs.statSync(lockPath).mtimeMs; }
  catch { return 0; }
}

function isStaleLock(lockPath, payload) {
  if (payload) return !pidAlive(payload.pid);
  return lockAgeMs(lockPath) > LOCK_STALE_GRACE_MS;
}

function encodeLock(token) {
  return `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;
}

function makeRelease(lockPath, token) {
  return () => {
    try {
      const current = readLock(lockPath);
      if (current == null) return;
      if (parseLockPayload(current)?.token !== token) return;
      fs.unlinkSync(lockPath);
    } catch {}
  };
}

function confirmOwnLock(lockPath, token) {
  const payload = parseLockPayload(readLock(lockPath) ?? '');
  return payload?.token === token && payload?.pid === process.pid;
}

function invokeAfterStaleDetected(options) {
  const hook = options?.afterStaleDetected ?? lockAcquireHooks.afterStaleDetected;
  if (typeof hook === 'function') hook();
}

function tryCreate(lockPath, token) {
  fs.writeFileSync(lockPath, encodeLock(token), { mode: 0o600, flag: 'wx' });
  if (!confirmOwnLock(lockPath, token)) return { held: true, release: () => {} };
  return { held: false, reentrant: false, token, release: makeRelease(lockPath, token) };
}

function reclaimStale(lockPath, token, options, retryAcquire, expectedPrevious) {
  invokeAfterStaleDetected(options);
  const tombstone = `${lockPath}.tomb-${process.pid}-${randomBytes(8).toString('hex')}`;
  try { fs.renameSync(lockPath, tombstone); }
  catch (error) {
    if (error.code === 'ENOENT') return retryAcquire();
    return { held: true, release: () => {} };
  }
  const moved = readLock(tombstone);
  if (moved !== expectedPrevious) {
    try { fs.renameSync(tombstone, lockPath); } catch {}
    return { held: true, release: () => {} };
  }
  try { fs.unlinkSync(tombstone); } catch {}
  try { return tryCreate(lockPath, token); }
  catch (error) {
    if (error.code === 'EEXIST') return { held: true, release: () => {} };
    throw error;
  }
}

export function acquireLock(home, name, env = process.env, options = {}) {
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locksDir, `${name}.lock`);
  const token = randomBytes(12).toString('hex');
  const inherited = env[PR_LOCK_TOKEN_ENV];
  const attempt = (allowReclaim) => {
    if (inherited) {
      const current = readLock(lockPath);
      if (current != null && parseLockPayload(current)?.token === inherited) {
        return { held: false, reentrant: true, token: inherited, release: () => {} };
      }
    }
    try { return tryCreate(lockPath, token); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readLock(lockPath);
      if (previous == null) return allowReclaim ? attempt(false) : { held: true, release: () => {} };
      if (inherited && parseLockPayload(previous)?.token === inherited) {
        return { held: false, reentrant: true, token: inherited, release: () => {} };
      }
      const payload = parseLockPayload(previous);
      if (!isStaleLock(lockPath, payload) || !allowReclaim) return { held: true, release: () => {} };
      return reclaimStale(lockPath, token, options, () => attempt(false), previous);
    }
  };
  return attempt(true);
}

export function lockStatus(home, name) {
  const lockPath = path.join(statePaths(home).locksDir, `${name}.lock`);
  if (!fs.existsSync(lockPath)) return { exists: false, live: false, pid: null };
  const payload = parseLockPayload(readLock(lockPath) ?? '');
  if (!payload) return { exists: true, live: !isStaleLock(lockPath, null), pid: null };
  return { exists: true, live: pidAlive(payload.pid), pid: payload.pid };
}
export function anyLiveRuntimeLock(home) {
  const { locksDir } = statePaths(home);
  if (!fs.existsSync(locksDir)) return false;
  for (const name of fs.readdirSync(locksDir).filter((item) => item.endsWith('.lock'))) {
    if (name === `${DEPLOY_LOCK_NAME}.lock`) continue;
    if (lockStatus(home, name.slice(0, -'.lock'.length)).live) return true;
  }
  return false;
}
export function acquireDeployExclusive(home, afterLock) {
  const deployLock = acquireLock(home, DEPLOY_LOCK_NAME);
  if (deployLock.held) {
    const error = new Error('deploy lock held');
    throw error;
  }
  try {
    if (typeof afterLock === 'function') afterLock();
    if (anyLiveRuntimeLock(home)) throw new Error('runtime lock held');
    return deployLock;
  } catch (error) {
    deployLock.release();
    throw error;
  }
}
export function withLock(home, name, fn) {
  const lock = acquireLock(home, name);
  if (lock.held) return { held: true };
  let result;
  try { result = fn(); }
  catch (error) {
    lock.release();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).finally(() => lock.release());
  }
  lock.release();
  return result;
}

function liftStuck(entry) {
  const stuck = entry?.pendingDispatch?.status === 'unconfirmed'
    && entry?.dispatchError?.kind === 'unknown-dispatch-receipt';
  if (!stuck) return { ...entry, migratedFrom: 'state.json' };
  return {
    ...entry,
    migratedFrom: 'state.json',
    legacyPending: { pendingDispatch: entry.pendingDispatch, dispatchError: entry.dispatchError },
    pendingDispatch: null,
    dispatchError: null,
  };
}

export function migrateLegacy(home, openNodeIds) {
  const paths = statePaths(home);
  fs.mkdirSync(paths.prsDir, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(paths.prsDir).some((name) => name.endsWith('.json'))) {
    return { migrated: false, reason: 'prs-not-empty' };
  }
  if (!fs.existsSync(paths.legacyPath)) return { migrated: false, reason: 'no-legacy' };
  const raw = fs.readFileSync(paths.legacyPath);
  const legacy = JSON.parse(raw.toString('utf8'));
  const prs = legacy?.prs && typeof legacy.prs === 'object' ? legacy.prs : {};
  let count = 0;
  for (const nodeId of openNodeIds ?? []) {
    const entry = prs[nodeId];
    if (!entry) continue;
    writePr(home, nodeId, liftStuck({ ...entry, nodeId }));
    count += 1;
  }
  atomicJson(paths.indexPath, {
    version: 2,
    migratedAt: new Date().toISOString(),
    legacySha256: createHash('sha256').update(raw).digest('hex'),
  });
  return { migrated: true, count };
}

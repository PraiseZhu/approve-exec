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
export const LOCK_RECLAIM_GUARD_STALE_MS = 30_000;
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
  const raw = String(text);
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('shape');
    if (!Number.isSafeInteger(data.pid) || data.pid <= 0) throw new Error('pid');
    if (typeof data.token !== 'string' || !data.token.trim()) throw new Error('token');
    if (typeof data.createdAt !== 'string' || !data.createdAt) throw new Error('createdAt');
    return { pid: data.pid, token: data.token, createdAt: data.createdAt };
  } catch {
    const parts = raw.trim().split(/\s+/);
    if (parts.length >= 3) {
      const pid = Number(parts[0]);
      const token = parts[2];
      if (Number.isSafeInteger(pid) && pid > 0 && token) return { pid, token, createdAt: parts[1] };
    }
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

function busy() { return { held: true, release: () => {} }; }

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
  if (!confirmOwnLock(lockPath, token)) return busy();
  return { held: false, reentrant: false, token, release: makeRelease(lockPath, token) };
}

function reclaimGuardPath(lockPath) { return `${lockPath}.reclaim`; }

function readGuardOwner(guardPath) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(guardPath, 'owner'), 'utf8'));
    if (!Number.isSafeInteger(data?.pid) || data.pid <= 0) return null;
    return data;
  } catch { return null; }
}

// A crashed reclaimer leaves `${lock}.reclaim` behind. Only sweep it when the
// owner pid is dead AND the directory mtime is older than 30s, then return busy
// without reclaiming in the same call. The delay avoids racing a still-running
// unlink+wx; the extra round is cheaper than deleting a live lock.
function sweepStaleGuard(guardPath) {
  try {
    const stat = fs.statSync(guardPath);
    if (!stat.isDirectory()) return false;
    const owner = readGuardOwner(guardPath);
    const ownerDead = !owner || !pidAlive(owner.pid);
    if (!ownerDead || Date.now() - stat.mtimeMs <= LOCK_RECLAIM_GUARD_STALE_MS) return false;
    fs.rmSync(guardPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeOwnGuard(guardPath, token, created) {
  if (!created) return;
  try {
    const owner = readGuardOwner(guardPath);
    if (owner && (owner.pid !== process.pid || (owner.token && owner.token !== token))) return;
    fs.rmSync(guardPath, { recursive: true, force: true });
  } catch {}
}

function reclaimStale(lockPath, token, options, expectedPrevious) {
  invokeAfterStaleDetected(options);
  const guardPath = reclaimGuardPath(lockPath);
  let created = false;
  try {
    fs.mkdirSync(guardPath);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    sweepStaleGuard(guardPath);
    return busy();
  }
  try {
    fs.writeFileSync(path.join(guardPath, 'owner'), `${JSON.stringify({
      pid: process.pid, token, createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const again = readLock(lockPath);
    if (again == null || again !== expectedPrevious) return busy();
    if (!isStaleLock(lockPath, parseLockPayload(again))) return busy();
    fs.unlinkSync(lockPath);
    try { return tryCreate(lockPath, token); }
    catch (error) {
      if (error.code === 'EEXIST') return busy();
      throw error;
    }
  } finally {
    removeOwnGuard(guardPath, token, created);
  }
}

export function acquireLock(home, name, env = process.env, options = {}) {
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locksDir, `${name}.lock`);
  const token = randomBytes(12).toString('hex');
  const inherited = env[PR_LOCK_TOKEN_ENV];
  try { return tryCreate(lockPath, token); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readLock(lockPath);
    if (previous == null) {
      try { return tryCreate(lockPath, token); }
      catch (retry) {
        if (retry.code === 'EEXIST') return busy();
        throw retry;
      }
    }
    if (inherited && parseLockPayload(previous)?.token === inherited) {
      return { held: false, reentrant: true, token: inherited, release: () => {} };
    }
    const payload = parseLockPayload(previous);
    if (!isStaleLock(lockPath, payload)) return busy();
    return reclaimStale(lockPath, token, options, previous);
  }
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
  for (const item of fs.readdirSync(locksDir)) {
    if (item.endsWith('.lock.reclaim')) {
      try {
        if (fs.statSync(path.join(locksDir, item)).isDirectory()) return true;
      } catch { continue; }
    }
    if (!item.endsWith('.lock') || item === `${DEPLOY_LOCK_NAME}.lock`) continue;
    if (lockStatus(home, item.slice(0, -'.lock'.length)).live) return true;
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

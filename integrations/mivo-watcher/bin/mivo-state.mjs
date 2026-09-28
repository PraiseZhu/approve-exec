#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
export const PR_LOCK_TOKEN_ENV = 'MIVO_PR_LOCK_TOKEN';

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

export function acquireLock(home, name, env = process.env) {
  const { locksDir } = statePaths(home);
  fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locksDir, `${name}.lock`);
  const token = randomBytes(12).toString('hex');
  const payload = `${process.pid} ${new Date().toISOString()} ${token}\n`;
  const acquire = () => fs.writeFileSync(lockPath, payload, { mode: 0o600, flag: 'wx' });
  const release = () => { try { fs.unlinkSync(lockPath); } catch {} };
  const inherited = env[PR_LOCK_TOKEN_ENV];
  if (inherited && fs.existsSync(lockPath)) {
    const current = fs.readFileSync(lockPath, 'utf8');
    const parts = current.trim().split(/\s+/);
    if (parts[2] === inherited) return { held: false, reentrant: true, token: inherited, release: () => {} };
  }
  try { acquire(); return { held: false, reentrant: false, token, release }; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
    const pid = Number(previous.split(' ')[0]);
    if (pidAlive(pid)) return { held: true, release: () => {} };
    if (!(fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8') === previous)) return { held: true, release: () => {} };
    try { fs.unlinkSync(lockPath); } catch { return { held: true, release: () => {} }; }
    try { acquire(); return { held: false, reentrant: false, token, release }; }
    catch (retry) {
      if (retry.code === 'EEXIST') return { held: true, release: () => {} };
      throw retry;
    }
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

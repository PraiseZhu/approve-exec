#!/usr/bin/env node
// 只读查询 watcher session 归属。不写盘、不调 gh/ssh、不访问网络。
import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const WATCHED_REPO = 'xindong/mivo-canvas-plugin';
export const DEFAULT_WATCH_HOMES = [
  '/Users/praise/AI-Agent/Claude/projects/Project Mivo Canvas-Plugin/_ops/mivo-watcher',
  '/Users/praise/AI-Agent/Claude/projects/Project MivoCanvas/_ops/Project Mivo Mini Automation/_ops/mivo-watcher',
];

const defaultFs = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
};

export function resolveWatchHome({
  home, env = process.env, fs: io = defaultFs, candidates = DEFAULT_WATCH_HOMES,
} = {}) {
  if (home) return home;
  if (env?.MIVO_WATCHER_HOME) return env.MIVO_WATCHER_HOME;
  for (const candidate of candidates) {
    if (io.existsSync(path.join(candidate, 'state'))) return candidate;
  }
  return candidates[0];
}

function matches(entry, { pr, sessionId }) {
  if (pr !== undefined && pr !== null && pr !== '') {
    return Number(entry?.number) === Number(pr);
  }
  if (sessionId) return entry?.sessionId === sessionId;
  return false;
}

function hit(entry, { repo, home, source, nodeId }) {
  return {
    owned: true,
    repo,
    pr: entry.number ?? null,
    nodeId: entry.nodeId ?? nodeId ?? null,
    sessionId: entry.sessionId ?? null,
    scheduleId: entry.scheduleId ?? null,
    status: entry.activeTask?.status ?? entry.eligibility ?? null,
    optOut: entry.optOut === true,
    closed: entry.closedHandled === true,
    source,
    home,
    needsHuman: entry.needsHuman ?? null,
  };
}

export function lookupWatchOwner({
  home, repo, pr, sessionId, fs: io = defaultFs, env = process.env, candidates,
} = {}) {
  try {
    if (repo !== WATCHED_REPO) return { owned: false, reason: 'repo-not-watched' };
    if ((pr === undefined || pr === null || pr === '') && !sessionId) {
      return { owned: false, reason: 'not-found' };
    }
    const resolved = resolveWatchHome({ home, env, fs: io, candidates });
    const prsDir = path.join(resolved, 'state', 'prs');
    const legacyPath = path.join(resolved, 'state', 'state.json');
    if (io.existsSync(prsDir)) {
      const names = io.readdirSync(prsDir).filter((name) => name.endsWith('.json'));
      for (const name of names) {
        const entry = JSON.parse(io.readFileSync(path.join(prsDir, name), 'utf8'));
        const nodeId = entry?.nodeId ?? name.slice(0, -'.json'.length);
        if (matches({ ...entry, nodeId }, { pr, sessionId })) {
          return hit({ ...entry, nodeId }, { repo, home: resolved, source: 'v2', nodeId });
        }
      }
      return { owned: false, reason: 'not-found' };
    }
    if (io.existsSync(legacyPath)) {
      const legacy = JSON.parse(io.readFileSync(legacyPath, 'utf8'));
      const prs = legacy?.prs && typeof legacy.prs === 'object' ? legacy.prs : {};
      for (const [key, entry] of Object.entries(prs)) {
        const nodeId = entry?.nodeId ?? key;
        if (matches({ ...entry, nodeId }, { pr, sessionId })) {
          return hit({ ...entry, nodeId }, { repo, home: resolved, source: 'legacy', nodeId });
        }
      }
      return { owned: false, reason: 'not-found' };
    }
    return { owned: false, reason: 'state-unreadable', error: 'missing watcher state' };
  } catch (error) {
    return { owned: false, reason: 'state-unreadable', error: String(error?.message ?? error) };
  }
}

export function parseOwnershipArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`非法参数: ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

export function runOwnershipCli(argv, options = {}) {
  try {
    const flags = parseOwnershipArgs(argv);
    if (!flags.repo) throw new Error('必须传 --repo <owner/repo>');
    const hasPr = flags.pr !== undefined;
    const hasSession = flags['session-id'] !== undefined;
    if (hasPr === hasSession) throw new Error('必须传 --pr <N> 或 --session-id <id> 之一');
    const result = lookupWatchOwner({
      home: flags.home,
      repo: flags.repo,
      pr: flags.pr,
      sessionId: flags['session-id'],
      fs: options.fs,
      env: options.env,
      candidates: options.candidates,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.reason === 'state-unreadable' ? 3 : 0;
  } catch (error) {
    console.error(`mivo-ownership: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined) {
  let entryReal;
  try { entryReal = realpathSync(process.argv[1]); } catch (error) {
    console.error(`mivo-ownership: 无法解析脚本真实路径 ${process.argv[1]}（${error.message}）`);
    process.exit(2);
  }
  if (import.meta.url === pathToFileURL(entryReal).href) {
    process.exitCode = runOwnershipCli(process.argv.slice(2));
  }
}

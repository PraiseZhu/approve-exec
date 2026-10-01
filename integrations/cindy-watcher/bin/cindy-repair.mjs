#!/usr/bin/env node
// Mini PR repair contract. This helper owns one task file and one PR worktree.
// It deliberately has no session-runtime integration: the watcher is the
// source of the session binding and Cindy is responsible for the session.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectCindyCiSync } from './cindy-ci.mjs';
import { taskRepairPolicy } from './cindy-feedback-policy.mjs';
import { acquireLock, AUTHOR_RECLAIMED, clearOrphanGuard, DEPLOY_LOCK_NAME, helperLockName, inspectLocks, lockStatus, readPr, writePr } from './cindy-state.mjs';

export const REPO = 'makecindy/cindy';
export const DEFAULT_PLUGIN_REPO = '/Users/praise/AI-Agent/Claude/projects/Project CINDY';
export const DEFAULT_PREFLIGHT = '/Users/praise/.claude/skills/cindy-pr-preflight/preflight.sh';
const GH = process.env.GH_BIN ?? 'gh';
const GIT = process.env.GIT_BIN ?? 'git';
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_PUSH_TIMEOUT_MS = 60 * 60 * 1000;
// A fork clone borrows objects from the local Cindy repo, but the first fetch of a
// new fork branch can still exceed the default helper timeout.
const GIT_CLONE_TIMEOUT_MS = 15 * 60 * 1000;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function requireAbs(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function isSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function pluginRepoPath(env = process.env) {
  return env.CINDY_WATCHER_REPO || DEFAULT_PLUGIN_REPO;
}
export function githubRepoUrl(repo, style = 'https') {
  if (style === 'ssh') return `git@github.com:${repo}.git`;
  return `https://github.com/${repo}.git`;
}
export function normalizeGithubUrl(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/$/, '')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '')
    .toLowerCase();
}
export function isBaseGithubUrl(url) {
  const normalized = normalizeGithubUrl(url);
  return normalized === normalizeGithubUrl(githubRepoUrl(REPO))
    || normalized === normalizeGithubUrl(githubRepoUrl(REPO, 'ssh'));
}
export function sameGithubRepo(url, repo) {
  const normalized = normalizeGithubUrl(url);
  return normalized === normalizeGithubUrl(githubRepoUrl(repo))
    || normalized === normalizeGithubUrl(githubRepoUrl(repo, 'ssh'));
}
function resolveHeadRepo(task) {
  if (typeof task?.headRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(task.headRepo)) return task.headRepo;
  fail('task.headRepo is required (PR fork owner/name)');
}
export function watchBranchName(number) { return `watch/pr-${number}`; }
export function watchWorktreePath(pluginRepo, number) {
  return path.join(pluginRepo, '.worktrees', 'watch', `pr-${number}`);
}
export function repairPaths(home) {
  const root = requireAbs(home, 'home');
  return {
    home: root,
    state: path.join(root, 'state', 'state.json'),
    tasks: path.join(root, 'state', 'tasks'),
    results: path.join(root, 'state', 'results'),
    validations: path.join(root, 'state', 'validations'),
    approvals: path.join(root, 'state', 'approvals'),
    worktrees: path.join(root, 'worktrees'),
  };
}
function taskWorktree(task, env = process.env) {
  return watchWorktreePath(pluginRepoPath(env), task.number);
}

function under(file, dir) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function immutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function identity(task, sessionId) {
  return { dispatchId: task.dispatchId, nodeId: task.nodeId, number: task.number, repo: task.repo, sessionId };
}

function assertIdentity(value, task, sessionId, label) {
  for (const [key, expected] of Object.entries(identity(task, sessionId))) {
    if (value?.[key] !== expected) fail(`${label} ${key} does not match task binding`);
  }
}

function saveResult(paths, task, sessionId, payload) {
  const lock = acquireLock(paths.home, `pr-${task.nodeId}`);
  if (lock.held) fail('PR 状态锁占用，请稍后重试写结果');
  try {
    refuseDeployLock(paths.home);
    return saveResultLocked(paths, task, sessionId, payload);
  } finally { lock.release(); }
}
function saveResultLocked(paths, task, sessionId, payload) {
  const latest = path.join(paths.results, `${task.dispatchId}.json`);
  const history = path.join(paths.results, 'history', task.dispatchId);
  if (fs.existsSync(latest)) {
    const bytes = fs.readFileSync(latest);
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    const old = path.join(history, `prior-${hash(bytes)}.json`);
    try { fs.writeFileSync(old, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const receiptId = randomUUID();
  const result = {
    ...payload, schemaVersion: 2, kind: 'cindy-repair-result', ...identity(task, sessionId),
    scope: 'feedback-task', prReady: false,
    sourceHead: task.headRefOid, repairPolicy: taskRepairPolicy(task), observedAt: new Date().toISOString(), receiptId,
    historyPath: path.join(history, `${receiptId}.json`),
  };
  immutableJson(result.historyPath, result);
  atomicJson(latest, result);
  return result;
}

export function command(binary, args, options = {}, runner = execFileSync) {
  const timeout = options.timeout ?? (binary === GIT && args.includes('push') ? GIT_PUSH_TIMEOUT_MS
    : binary === GIT && args[0] === 'clone' ? GIT_CLONE_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS);
  return runner(binary, args, {
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
}

function ghJson(args, ghFn = command) {
  let raw;
  try { raw = ghFn(GH, args); }
  catch (error) {
    // gh pr checks uses exit 1/8 for failing or pending checks while still
    // emitting the JSON payload needed for classification.
    if (args[0] === 'pr' && args[1] === 'checks' && error?.status === 1
      && /no (?:required status )?checks reported/i.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) return [];
    if (args[0] === 'pr' && args[1] === 'checks' && [1, 8].includes(error?.status) && error?.stdout) raw = error.stdout;
    else throw error;
  }
  try { return JSON.parse(String(raw)); }
  catch (error) { fail(`gh returned invalid JSON: ${error.message}`); }
}

function gitOutput(args, gitFn = command) { return String(gitFn(GIT, args)); }

function refuseDeployLock(home) {
  if (lockStatus(home, DEPLOY_LOCK_NAME).live) fail('deploy lock held');
}
function peekTaskNumber(taskPath) {
  if (typeof taskPath !== 'string') return undefined;
  try {
    const number = Number(JSON.parse(fs.readFileSync(taskPath, 'utf8'))?.number);
    return Number.isInteger(number) && number >= 1 ? number : undefined;
  } catch {
    return undefined;
  }
}
function withHelperOp(home, pr, fn) {
  const root = requireAbs(home, 'home');
  const lock = acquireLock(root, helperLockName(pr));
  if (lock.held) {
    const why = typeof lock.reason === 'string' && lock.reason.startsWith('reclaim-guard-orphan:')
      ? lock.reason : 'helper 运行锁占用，请稍后重试';
    fail(`busy: ${why}`, 2);
  }
  try {
    refuseDeployLock(root);
    return fn();
  } finally { lock.release(); }
}
function taskFrom(home, taskPath) {
  const paths = repairPaths(home);
  refuseDeployLock(paths.home);
  const file = requireAbs(taskPath, 'task');
  if (!under(file, paths.tasks)) fail('task must be inside home/state/tasks');
  const task = readJson(file, 'task');
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task must be an object');
  if (typeof task.dispatchId !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(task.dispatchId)) fail('task.dispatchId is invalid');
  if (typeof task.nodeId !== 'string' || !task.nodeId.trim()) fail('task.nodeId is required');
  if (!Number.isInteger(task.number) || task.number < 1) fail('task.number is invalid');
  if (task.repo !== REPO) fail(`task.repo must be ${REPO}`);
  if (!isSha(task.headRefOid)) fail('task.headRefOid must be a 40-character SHA');
  if (typeof task.headRefName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(task.headRefName) || task.headRefName.includes('..')) fail('task.headRefName is invalid');
  resolveHeadRepo(task);
  const headOwner = task.headRepo.split('/')[0];
  if (typeof task.headOwner === 'string' && task.headOwner !== headOwner) fail('task.headOwner does not match headRepo');
  return { paths, file, task };
}

function boundSession(paths, task) {
  let entry = readPr(paths.home, task.nodeId);
  if (!entry) {
    const state = fs.existsSync(paths.state) ? readJson(paths.state, 'scanner state') : { prs: {} };
    entry = state?.prs?.[task.nodeId];
  }
  if (!entry?.sessionId) fail(`scanner state has no bound session for nodeId ${task.nodeId}`);
  if (task.sessionId && task.sessionId !== entry.sessionId) fail('task sessionId does not match scanner binding');
  const dispatches = entry.activeTask?.dispatchId
    ? [entry.activeTask.dispatchId]
    : [entry.lastDispatch?.dispatchId, entry.pendingDispatch?.dispatchId].filter(Boolean);
  if (dispatches.length && !dispatches.includes(task.dispatchId)) fail('task dispatchId is not the active watcher dispatch');
  if (entry.activeTask?.blockedKind === AUTHOR_RECLAIMED && entry.activeTask.dispatchId === task.dispatchId) {
    fail('task superseded: the author reclaimed this PR (Ready -> Draft); wait for the next watcher dispatch');
  }
  return { sessionId: entry.sessionId };
}

function ghPr(task, ghFn, requireHead = true) {
  const pr = ghJson(['pr', 'view', String(task.number), '--repo', task.repo, '--json', 'state,isDraft,headRefOid,headRefName,baseRefOid'], ghFn);
  if (pr.state !== 'OPEN' || pr.isDraft === true) fail('PR must be OPEN and non-draft');
  if (pr.headRefName !== task.headRefName) fail(`PR branch mismatch: expected ${task.headRefName}`);
  if (!isSha(pr.headRefOid)) fail('gh PR headRefOid is invalid');
  if (requireHead && pr.headRefOid !== task.headRefOid) fail(`task head is stale: ${task.headRefOid} != ${pr.headRefOid}`);
  return pr;
}

function remoteUrl(repo) { return githubRepoUrl(repo); }

export function originPushUrls(worktree, gitFn) {
  const raw = gitOutput(['-C', worktree, 'remote', 'get-url', '--push', '--all', 'origin'], gitFn);
  return String(raw).split(/\n/).map((item) => item.trim()).filter(Boolean);
}
export function insteadOfRewritesFork(worktree, forkUrl, gitFn) {
  let listed = '';
  try {
    listed = gitOutput(['-C', worktree, 'config', '--get-regexp', '^url\..*insteadOf$'], gitFn);
  } catch { return null; }
  const fork = normalizeGithubUrl(forkUrl);
  for (const line of String(listed).split(/\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^(url\.(.+)\.(pushInsteadOf|insteadOf))\s+(.+)$/i.exec(line);
    if (!match) continue;
    const replacement = match[2];
    const source = match[4];
    if (normalizeGithubUrl(source) !== fork) continue;
    if (normalizeGithubUrl(replacement) !== fork) return match[1];
  }
  return null;
}
export function assertOriginPushTargets(worktree, repo, gitFn, expectedUrl = remoteUrl(repo)) {
  const rewrite = insteadOfRewritesFork(worktree, expectedUrl, gitFn);
  if (rewrite) fail(`refusing ${rewrite} rewriting fork ${expectedUrl}`);
  const urls = originPushUrls(worktree, gitFn);
  if (!urls.length) fail('origin has no push URL');
  for (const url of urls) {
    if (isBaseGithubUrl(url)) fail(`refusing origin pushurl pointing at base repo ${REPO}: ${url}`);
    if (!sameGithubRepo(url, repo) && normalizeGithubUrl(url) !== normalizeGithubUrl(expectedUrl)) {
      fail(`origin pushurl mismatch: ${url}`);
    }
  }
  return urls;
}
export function assertOrigin(worktree, repo, gitFn, expectedUrl = remoteUrl(repo)) {
  const origin = gitOutput(['-C', worktree, 'remote', 'get-url', 'origin'], gitFn);
  if (!sameGithubRepo(origin, repo) && normalizeGithubUrl(origin) !== normalizeGithubUrl(expectedUrl)) {
    fail(`worktree origin mismatch: ${origin}`);
  }
  if (repo !== REPO && isBaseGithubUrl(origin)) fail(`refusing origin pointing at base repo ${REPO}`);
  if (isBaseGithubUrl(expectedUrl) && repo !== REPO) fail(`refusing origin=${REPO}`);
  assertOriginPushTargets(worktree, repo, gitFn, expectedUrl);
}

export function assertUpstreamFetchOnly(worktree, gitFn) {
  let upstream;
  try { upstream = gitOutput(['-C', worktree, 'remote', 'get-url', 'upstream'], gitFn); }
  catch { fail('worktree missing upstream remote (must be makecindy/cindy, fetch-only)'); }
  if (!sameGithubRepo(upstream, REPO) && !isBaseGithubUrl(upstream)) fail(`worktree upstream mismatch: ${upstream}`);
  let pushUrl = '';
  try { pushUrl = gitOutput(['-C', worktree, 'remote', 'get-url', '--push', 'upstream'], gitFn); } catch { pushUrl = ''; }
  if (pushUrl && !/DISABLED|no_push|disabled/i.test(pushUrl) && isBaseGithubUrl(pushUrl)) {
    fail('upstream push URL must be disabled; never push to makecindy/cindy');
  }
}

function assertWorktree(worktree, task, gitFn, expectedUrl = remoteUrl(task.headRepo || task.repo)) {
  if (!fs.existsSync(worktree)) return false;
  if (!fs.statSync(worktree).isDirectory()) fail('worktree path exists but is not a directory');
  const top = gitOutput(['-C', worktree, 'rev-parse', '--show-toplevel'], gitFn);
  if (fs.realpathSync(top) !== fs.realpathSync(worktree)) fail('worktree path is not an independent git checkout');
  const originRepo = task.headRepo || task.repo;
  assertOrigin(worktree, originRepo, gitFn, expectedUrl);
  const originSeen = gitOutput(['-C', worktree, 'remote', 'get-url', 'origin'], gitFn);
  if (normalizeGithubUrl(originSeen).startsWith('https://github.com/') && !isBaseGithubUrl(originSeen)) {
    assertUpstreamFetchOnly(worktree, gitFn);
  }
  const branch = gitOutput(['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], gitFn);
  if (branch !== watchBranchName(task.number)) fail(`worktree branch mismatch: ${branch}`);
  const tracking = gitOutput(['-C', worktree, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitFn);
  if (tracking !== `origin/${task.headRefName}`) fail(`worktree upstream mismatch: ${tracking}`);
  const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
  if (status) fail('worktree is dirty');
  const head = gitOutput(['-C', worktree, 'rev-parse', 'HEAD'], gitFn);
  if (!isSha(head)) fail('worktree HEAD is invalid');
  return { head };
}

export function cloneWorktree(paths, task, gitFn, cloneUrl, expectedUrl, remoteHead = task.headRefOid, env = process.env) {
  const plugin = pluginRepoPath(env);
  const worktree = watchWorktreePath(plugin, task.number);
  const branch = watchBranchName(task.number);
  const headRepo = resolveHeadRepo(task);
  const originUrl = cloneUrl ?? githubRepoUrl(headRepo);
  const expectUrl = expectedUrl ?? originUrl;
  if (isBaseGithubUrl(originUrl) || headRepo === REPO) fail(`refusing to clone base repo ${REPO} as origin`);
  const existing = assertWorktree(worktree, task, gitFn, expectUrl);
  if (existing) return { worktree, head: existing.head, created: false };
  fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  if (fs.existsSync(worktree)) fail('worktree path is unknown; refusing to remove it');
  // --reference-if-able reuses the local repo's objects (both remotes are already
  // fetched there), so only the PR's new commits cross the network.
  gitOutput(['clone', '--reference-if-able', plugin, '--origin', 'origin', '--branch', task.headRefName, '--single-branch', originUrl, worktree], gitFn);
  gitOutput(['-C', worktree, 'checkout', '-B', branch], gitFn);
  gitOutput(['-C', worktree, 'branch', '--set-upstream-to', `origin/${task.headRefName}`], gitFn);
  gitOutput(['-C', worktree, 'remote', 'add', 'upstream', githubRepoUrl(REPO)], gitFn);
  gitOutput(['-C', worktree, 'remote', 'set-url', '--push', 'upstream', 'DISABLED'], gitFn);
  const checked = assertWorktree(worktree, task, gitFn, expectUrl);
  if (!checked || checked.head !== remoteHead) fail('cloned worktree HEAD does not match observed remote head');
  return { worktree, head: checked.head, created: true };
}

// Recompute from the trusted task's feedback, including legacy tasks. A cached
// category, an SC assertion, or a successful preflight is not repair authority.
export function assertTaskRepairScope(task, head) {
  if (!isSha(task?.headRefOid) || !isSha(head)) fail('repair scope requires valid source and target HEAD');
  const repairPolicy = taskRepairPolicy(task);
  if (head !== task.headRefOid && !repairPolicy.canChangeCode) {
    fail('[REPAIR_SCOPE_NO_CODE] This task has no P0/P1, required-CI or conflict repair authority; preserve local changes, do not push. P2/P3 and unknown findings are no-change only.');
  }
  return repairPolicy;
}

export function prepare({ home, taskPath, ghFn = command, gitFn = command, cloneUrl, originUrl, viewer } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  const headRepo = resolveHeadRepo(task);
  const headOwner = headRepo.split('/')[0];
  const login = viewer ?? String(ghFn(GH, ['api', 'user', '-q', '.login'])).replace(/^"|"$/g, '').trim();
  if (headOwner !== login) fail(`head owner ${headOwner} is not the current viewer ${login}; blocked`);
  const forkUrl = originUrl ?? cloneUrl ?? githubRepoUrl(headRepo);
  if (isBaseGithubUrl(forkUrl) || headRepo === REPO) fail(`refusing origin=${REPO}; push only to the PR fork`);
  const pr = ghPr(task, ghFn, false);
  const checkout = cloneWorktree(paths, task, gitFn, forkUrl, forkUrl, pr.headRefOid);
  const repairPolicy = assertTaskRepairScope(task, checkout.head);
  const needsSync = checkout.head !== pr.headRefOid || task.headRefOid !== pr.headRefOid;
  return { ...identity(task, sessionId), repairPolicy, status: needsSync ? 'needs-sync' : 'prepared', needsSync,
    worktree: checkout.worktree, head: checkout.head, remoteHead: pr.headRefOid, sourceHead: task.headRefOid,
    origin: forkUrl, headRepo, created: checkout.created };
  });
}

export function validateScs(report, task) {
  const scs = Array.isArray(report) ? report : report?.scs;
  if (!Array.isArray(scs) || scs.length === 0) fail('SC report must contain a non-empty scs array');
  const feedback = task.feedback ?? [];
  if (!Array.isArray(feedback)) fail('task feedback must be an array');
  const expected = new Set(feedback.map((item) => item?.key));
  if ([...expected].some((key) => typeof key !== 'string' || !key.trim()) || expected.size !== feedback.length) fail('task feedback keys must be non-empty and unique');
  const permissions = new Map(taskRepairPolicy(task).items.map((item) => [item.key, item]));
  const ids = new Set();
  const covered = new Set();
  const checked = scs.map((sc, index) => {
    if (!sc || typeof sc !== 'object' || typeof sc.id !== 'string' || !sc.id.trim()) fail(`SC[${index}] id is required`);
    if (ids.has(sc.id.trim())) fail(`duplicate SC id: ${sc.id.trim()}`);
    ids.add(sc.id.trim());
    if (!['pass', 'no-change'].includes(sc.status)) fail(`SC[${index}] status must be pass or no-change`);
    if (!Array.isArray(sc.evidence) || sc.evidence.length === 0 || sc.evidence.some((item) => typeof item !== 'string' || !item.trim())) fail(`SC[${index}] evidence must be non-empty strings`);
    const keys = sc.feedbackKeys ?? (expected.size ? null : []);
    if (!Array.isArray(keys) || (expected.size && !keys.length) || new Set(keys).size !== keys.length) fail(`SC[${index}] feedbackKeys must name task feedback`);
    if (sc.status === 'pass' && !keys.length) fail(`[REPAIR_SCOPE_NO_CODE] SC[${index}] pass requires an authorized feedback key`);
    for (const key of keys) {
      if (!expected.has(key)) fail(`SC[${index}] contains an external feedback key: ${key}`);
      if (sc.status === 'pass' && permissions.get(key)?.canChangeCode !== true) {
        fail(`[REPAIR_SCOPE_NO_CODE] SC[${index}] cannot mark ${key} fixed; P2/P3, mixed or unconfirmed findings require no-change/triage`);
      }
      covered.add(key);
    }
    return { id: sc.id.trim(), status: sc.status, evidence: sc.evidence, feedbackKeys: keys };
  });
  const missing = [...expected].filter((key) => !covered.has(key));
  if (missing.length) fail(`SC report does not cover task feedback: ${missing.join(', ')}`);
  const dispositions = feedback.map((item) => ({
    key: item.key, disposition: checked.some((sc) => sc.feedbackKeys.includes(item.key) && sc.status === 'pass') ? 'fixed' : 'no-change',
    ...(item.source === 'thread' || item.key.startsWith('thread:') ? { resolved: null, resolutionEvidence: 'not-checked-by-helper' } : {}),
  }));
  return { scs: checked, feedbackCoverage: { mode: expected.size ? 'task-feedback' : 'legacy-empty', requiredKeys: [...expected], coveredKeys: [...covered], dispositions, complete: true } };
}

function loadScs(scReport, task) {
  return validateScs(readJson(requireAbs(scReport, 'sc-report'), 'SC report'), task);
}

function rejectSkip(env = process.env) {
  for (const key of ['PREFLIGHT_SKIP', 'CINDY_PREFLIGHT_SKIP', 'CINDY_PREFLIGHT_FAST']) {
    if (env[key] && env[key] !== '0') fail(`${key} cannot authorize cindy repair validation or push`);
  }
}

export function preflightFile(env = process.env) {
  return env.CINDY_PREFLIGHT_BIN || DEFAULT_PREFLIGHT;
}

function validationPolicy(_worktree, _task, _gitFn, env = process.env) {
  const file = preflightFile(env);
  if (!fs.existsSync(file)) fail(`cindy preflight script missing: ${file}`);
  const actual = fs.readFileSync(file, 'utf8');
  return { file, sourceHead: null, sha256: hash(actual) };
}

export function commitsMissingDco(worktree, fromSha, toSha, gitFn) {
  if (!isSha(fromSha) || !isSha(toSha) || fromSha === toSha) return [];
  const raw = gitOutput(['-C', worktree, 'log', `${fromSha}..${toSha}`, '--format=%H%n%B%x1e'], gitFn);
  const missing = [];
  for (const entry of raw.split('\x1e')) {
    const text = entry.trim();
    if (!text) continue;
    const nl = text.indexOf('\n');
    const sha = (nl === -1 ? text : text.slice(0, nl)).trim();
    const body = nl === -1 ? '' : text.slice(nl + 1);
    if (!/^Signed-off-by:\s+\S.+/m.test(body)) missing.push(sha);
  }
  return missing;
}

function assertDco(worktree, fromSha, toSha, gitFn) {
  const missing = commitsMissingDco(worktree, fromSha, toSha, gitFn);
  if (missing.length) fail(`commits missing Signed-off-by: ${missing.join(', ')}`);
}

function validationPointer(paths, task, head) {
  return path.join(paths.validations, task.dispatchId, `${head}.json`);
}

function validationException(paths, task, sessionId, head, worktree, gitFn) {
  const binding = task.validationException;
  if (!binding) return null;
  const file = requireAbs(binding.approvalPath, 'validation exception approval');
  if (!under(file, paths.approvals)) fail('validation approval must be inside state/approvals');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== binding.approvalSha256) fail('validation approval hash mismatch');
  const approval = JSON.parse(bytes);
  assertIdentity(approval, task, sessionId, 'validation approval');
  if (approval.kind !== 'local-preflight-exception' || approval.head !== head || approval.approvedBy !== 'user'
    || typeof approval.approvalRef !== 'string' || !approval.approvalRef.trim()
    || typeof approval.reason !== 'string' || !approval.reason.trim()
    || !Array.isArray(approval.allowedChangedPaths) || !approval.allowedChangedPaths.length) fail('validation approval is incomplete');
  const changed = gitOutput(['-C', worktree, 'diff', '--name-only', task.headRefOid, head], gitFn).trim().split('\n').filter(Boolean);
  if (changed.some((fileName) => !approval.allowedChangedPaths.includes(fileName))) fail('validation exception does not cover changed paths');
  return { approvalPath: file, approvalSha256: binding.approvalSha256, approvalRef: approval.approvalRef, reason: approval.reason };
}

export function validate({ home, taskPath, validatedHead, gitFn = command, runFn = command, env = process.env, originUrl } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  rejectSkip(env);
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  if (!isSha(validatedHead)) fail('validated-head must be a 40-character SHA');
  assertTaskRepairScope(task, validatedHead);
  const worktree = taskWorktree(task);
  const forkUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  const checkout = assertWorktree(worktree, task, gitFn, forkUrl);
  if (!checkout || checkout.head !== validatedHead) fail('worktree HEAD does not match validated-head');
  assertDco(worktree, task.headRefOid, validatedHead, gitFn);
  const exception = validationException(paths, task, sessionId, validatedHead, worktree, gitFn);
  const policy = exception ? null : validationPolicy(worktree, task, gitFn, env);
  const startedAt = new Date().toISOString();
  let exitCode = null;
  let outputHash = null;
  let status = exception ? 'approved-exception' : 'pass';
  if (!exception) {
    try {
      const output = String(runFn('/bin/bash', [policy.file], {
        cwd: worktree, env: { ...env, PREFLIGHT_SKIP: '0' }, timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024,
      }));
      exitCode = 0;
      outputHash = hash(output);
      if (/^\[preflight\] skipped(?: |$)/m.test(output)) status = 'fail';
    } catch (error) {
      status = 'fail';
      exitCode = Number.isInteger(error.status) ? error.status : null;
      outputHash = hash(String(error.stdout ?? '') + String(error.stderr ?? ''));
    }
  }
  let reason;
  try {
    const after = assertWorktree(worktree, task, gitFn, originUrl);
    if (!after || after.head !== validatedHead) fail('HEAD changed during local validation');
    if (policy && validationPolicy(worktree, task, gitFn, env).sha256 !== policy.sha256) fail('preflight policy changed during validation');
  } catch (error) { status = 'fail'; reason = error.message; }
  const receipt = {
    schemaVersion: 2, kind: 'cindy-repair-validation', ...identity(task, sessionId), head: validatedHead,
    status, policy, exception, command: exception ? null : { binary: '/bin/bash', args: [policy.file] },
    exitCode, outputHash, ...(reason ? { reason } : {}), startedAt, finishedAt: new Date().toISOString(),
  };
  const receiptPath = path.join(paths.validations, task.dispatchId, `${validatedHead}-${randomUUID()}.json`);
  immutableJson(receiptPath, receipt);
  const verification = { status, head: validatedHead, receiptPath, receiptSha256: hash(fs.readFileSync(receiptPath)) };
  atomicJson(validationPointer(paths, task, validatedHead), verification);
  return verification;
  });
}

function verifiedLocal(paths, task, sessionId, head, worktree, gitFn, receiptPath = null, env = process.env) {
  const pointer = readJson(validationPointer(paths, task, head), 'local validation pointer');
  const file = requireAbs(receiptPath ?? pointer.receiptPath, 'local validation receipt');
  if (!under(file, path.join(paths.validations, task.dispatchId)) || file !== pointer.receiptPath) fail('local validation receipt is not the latest bound receipt');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== pointer.receiptSha256) fail('local validation receipt hash mismatch');
  const receipt = JSON.parse(bytes);
  assertIdentity(receipt, task, sessionId, 'local validation');
  if (receipt.schemaVersion !== 2 || receipt.kind !== 'cindy-repair-validation' || receipt.head !== head || pointer.head !== head) fail('local validation HEAD or schema mismatch');
  if (receipt.status === 'approved-exception') {
    const exception = validationException(paths, task, sessionId, head, worktree, gitFn);
    if (!exception || exception.approvalSha256 !== receipt.exception?.approvalSha256) fail('local validation exception is no longer bound');
  } else if (receipt.status !== 'pass' || receipt.exitCode !== 0
    || receipt.policy?.sha256 !== validationPolicy(worktree, task, gitFn, env).sha256) fail('local validation did not pass for this HEAD');
  return { status: receipt.status, head, receiptPath: file, receiptSha256: pointer.receiptSha256 };
}

function pages(value, key) {
  return (Array.isArray(value) ? value : [value]).flatMap((page) => Array.isArray(page?.[key]) ? page[key] : []);
}

function checkBucket(check) {
  if (check.status !== 'completed') return 'pending';
  if (['success', 'skipped', 'neutral'].includes(check.conclusion)) return 'pass';
  if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(check.conclusion)) return 'fail';
  return 'unknown';
}

function workflowRunId(link, repo) {
  try {
    const url = new URL(link);
    const prefix = `/${repo}/actions/runs/`;
    if (url.hostname !== 'github.com' || !url.pathname.startsWith(prefix)) return null;
    const id = url.pathname.slice(prefix.length).split('/')[0];
    return /^\d+$/.test(id) ? id : null;
  } catch { return null; }
}

function legacyCheckStatus(task, head, ghFn) {
  const ci = { head, requiredGreen: false, requiredChecks: [], optionalFailures: [], pending: [], missing: [] };
  const pr = ghPr(task, ghFn, false);
  if (pr.headRefOid !== head) return { ...ci, missing: ['GitHub PR HEAD has not reached the validated HEAD'] };
  const required = ghJson(['pr', 'checks', String(task.number), '--repo', task.repo, '--required', '--json', 'name,state,bucket,link'], ghFn);
  if (!Array.isArray(required)) fail('gh required PR checks did not return an array');
  if (required.length === 0) return { ...ci, missing: ['required-checks'] };
  const checks = pages(ghJson(['api', `repos/${task.repo}/commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp'], ghFn), 'check_runs')
    .filter((check) => check.head_sha === head);
  const runs = new Map();
  for (const expected of required) {
    const found = checks.find((check) => check.name === expected.name && check.details_url === expected.link);
    if (!found) { ci.missing.push(expected.name); continue; }
    const runId = workflowRunId(found.details_url, task.repo);
    let runHeadSha = null;
    if (runId) {
      if (!runs.has(runId)) runs.set(runId, ghJson(['api', `repos/${task.repo}/actions/runs/${runId}`], ghFn));
      runHeadSha = runs.get(runId)?.head_sha;
      if (runHeadSha !== head) { ci.missing.push(`${expected.name}:workflow-head-mismatch`); continue; }
    }
    const check = {
      id: found.id, name: found.name, headSha: found.head_sha, link: found.details_url,
      state: found.status, conclusion: found.conclusion, bucket: checkBucket(found), runId, runHeadSha,
    };
    ci.requiredChecks.push(check);
    if (check.bucket === 'pending' || check.bucket === 'unknown') ci.pending.push(check.name);
  }
  const requiredLinks = new Set(required.map((check) => check.link));
  ci.optionalFailures = checks.filter((check) => !requiredLinks.has(check.details_url) && checkBucket(check) === 'fail')
    .map((check) => ({ id: check.id, name: check.name, headSha: check.head_sha, link: check.details_url, conclusion: check.conclusion }));
  if (ghPr(task, ghFn, false).headRefOid !== head) ci.missing.push('PR HEAD changed during CI verification');
  ci.requiredGreen = ci.missing.length === 0 && ci.pending.length === 0
    && ci.requiredChecks.length === required.length && ci.requiredChecks.every((check) => check.bucket === 'pass');
  return ci;
}

export function policyCiResult(ci, head) {
  return {head, requiredGreen:ci.status === 'green', policyHash:ci.policyHash,
    requiredChecks:(ci.required??[]).map(r=>({name:r.context,bucket:r.status==='green'?'pass':r.status==='failed'?'fail':'pending',headSha:head,evidence:r.evidence})),
    optionalFailures:[],pending:(ci.required??[]).filter(r=>r.status==='pending').map(r=>r.context),
    missing:ci.status==='unknown'?[ci.reason??'required-policy-unknown']:[]};
}
function checkStatus(task, head, ghFn) {
  const pr=ghJson(['pr','view',String(task.number),'--repo',task.repo,'--json','id,number,state,isDraft,headRefOid,baseRefOid,baseRefName'],ghFn);
  if(pr.headRefOid!==head || pr.state!=='OPEN' || pr.isDraft) return policyCiResult({status:'unknown',reason:'PR changed before CI collection'},head);
  return policyCiResult(collectCindyCiSync({pr:{...pr,repo:task.repo},ghFn:args=>ghFn(GH,args)}),head);
}

export function ciResult(ci) {
  const failures = ci.requiredChecks.filter((check) => check.bucket === 'fail');
  if (failures.length) return { status: 'blocked', blockedKind: 'required-ci', reason: `required CI failed: ${failures.map((check) => check.name).join(', ')}` };
  if (!ci.requiredGreen) return { status: 'waiting-ci', reason: `waiting for current HEAD required CI: ${[...ci.missing, ...ci.pending].join(', ')}` };
  return { status: 'complete' };
}

export function pushIfNeeded(worktree, task, validatedHead, remoteHead, gitFn, originUrl) {
  const forkUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  if (isBaseGithubUrl(forkUrl)) fail(`refusing to push to base repo ${REPO}`);
  if (remoteHead === validatedHead) return { pushed: false };
  const checkout = assertWorktree(worktree, task, gitFn, forkUrl);
  if (!checkout || checkout.head !== validatedHead) fail('local HEAD changed before push');
  const latest = gitOutput(['ls-remote', forkUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (latest !== remoteHead) fail('remote branch changed before push');
  const ancestor = (() => {
    try { gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', remoteHead, validatedHead], gitFn); return true; }
    catch { return false; }
  })();
  if (!ancestor) fail('remote branch advanced independently; refusing non-fast-forward push');
  assertOriginPushTargets(worktree, resolveHeadRepo(task), gitFn, forkUrl);
  gitOutput(['-C', worktree, 'push', 'origin', `${validatedHead}:refs/heads/${task.headRefName}`], gitFn);
  const after = gitOutput(['ls-remote', forkUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (after !== validatedHead) fail('remote branch changed after push; pushed commit requires reconciliation');
  return { pushed: true };
}

export function finalize({ home, taskPath, scReport, validatedHead, validationReceipt, ghFn = command, gitFn = command, env = process.env, originUrl } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  rejectSkip(env);
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  if (!isSha(validatedHead)) fail('validated-head must be a 40-character SHA');
  assertTaskRepairScope(task, validatedHead);
  const pr = ghPr(task, ghFn, false);
  const worktree = taskWorktree(task);
  originUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  if (isBaseGithubUrl(originUrl)) fail(`refusing to push to base repo ${REPO}`);
  assertDco(worktree, task.headRefOid, validatedHead, gitFn);
  const checkout = assertWorktree(worktree, { ...task, headRefOid: validatedHead }, gitFn, originUrl);
  if (!checkout || checkout.head !== validatedHead) fail('worktree HEAD does not match validated-head');
  const branchHead = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (!isSha(branchHead)) fail('remote branch head is unavailable');
  if (branchHead !== pr.headRefOid) fail(`remote branch and PR head disagree: ${branchHead} != ${pr.headRefOid}`);
  const { scs, feedbackCoverage } = loadScs(scReport, task);
  if (validatedHead !== task.headRefOid && scs.every((sc) => sc.status === 'no-change')) {
    fail('[REPAIR_SCOPE_NO_CODE] Changed HEAD requires an SC bound to an authorized fix; no-change cannot cover commits');
  }
  const noChange = validatedHead === task.headRefOid && branchHead === validatedHead && scs.every((sc) => sc.status === 'no-change');
  const verification = noChange
    ? { status: 'not-required-no-change', head: validatedHead, localTests: 'not-run', reason: 'all SCs are no-change and task, checkout and remote HEAD match' }
    : verifiedLocal(paths, task, sessionId, validatedHead, worktree, gitFn, validationReceipt, env);
  const push = pushIfNeeded(worktree, task, validatedHead, branchHead, gitFn, originUrl);
  let ci;
  try { ci = checkStatus(task, validatedHead, ghFn); }
  catch (error) {
    return saveResult(paths, task, sessionId, { status: 'blocked', blockedKind: 'ci-transport', reason: error.message,
      head: validatedHead, scs, feedbackCoverage, verification, checks: [], pushed: push.pushed });
  }
  return saveResult(paths, task, sessionId, { ...ciResult(ci), head: validatedHead, scs, feedbackCoverage, verification, ci, checks: ci.requiredChecks, pushed: push.pushed });
  });
}

export function recheck({ home, taskPath, validatedHead, ghFn = command, gitFn = command, originUrl, env = process.env } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  const { paths, task } = taskFrom(home, taskPath);
  originUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  const { sessionId } = boundSession(paths, task);
  const previous = readJson(path.join(paths.results, `${task.dispatchId}.json`), 'repair result');
  if (previous.schemaVersion !== 2 || previous.kind !== 'cindy-repair-result') fail('legacy result is unverified; a new finalize receipt is required');
  assertIdentity(previous, task, sessionId, 'repair result');
  const head = validatedHead ?? previous.head;
  if (!isSha(head) || previous.head !== head) fail('recheck HEAD does not match the result');
  assertTaskRepairScope(task, head);
  const { scs, feedbackCoverage } = validateScs(previous.scs, task);
  const worktree = taskWorktree(task);
  const checkout = assertWorktree(worktree, task, gitFn, originUrl);
  if (!checkout || checkout.head !== head) fail('recheck worktree HEAD changed');
  let verification;
  if (previous.verification?.status === 'not-required-no-change') {
    if (head !== task.headRefOid || !previous.scs.every((sc) => sc.status === 'no-change')) fail('no-change verification cannot cover code changes');
    verification = previous.verification;
  } else {
    verification = verifiedLocal(paths, task, sessionId, head, worktree, gitFn, previous.verification?.receiptPath, env);
    if (verification.receiptSha256 !== previous.verification?.receiptSha256) fail('result validation receipt hash mismatch');
  }
  const remoteHead = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (!isSha(remoteHead)) fail('remote branch head is unavailable during recheck');
  const observedPrHead = ghPr(task, ghFn, false).headRefOid;
  const common = { head, scs, feedbackCoverage, verification, pushed: previous.pushed === true, remoteHead, observedPrHead };
  if (remoteHead !== observedPrHead) {
    return saveResult(paths, task, sessionId, { ...common, status: 'waiting-ci', reason: 'GitHub PR and remote branch views differ', checks: [],
      ci: { head, requiredGreen: false, requiredChecks: [], optionalFailures: [], pending: [], missing: ['github-remote-head-mismatch'] } });
  }
  if (remoteHead !== head) {
    return saveResult(paths, task, sessionId, { ...common, status: 'blocked', blockedKind: 'head-drift',
      reason: 'remote HEAD advanced independently; preserve local work and reconcile before validation', checks: [],
      drift: { validatedHead: head, remoteHead, githubHead: observedPrHead, sourceHead: task.headRefOid } });
  }
  const ci = checkStatus(task, head, ghFn);
  return saveResult(paths, task, sessionId, { ...common, ...ciResult(ci), ci, checks: ci.requiredChecks });
  });
}

export function blocked({ home, taskPath, reason, ghFn = command } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  if (typeof reason !== 'string' || !reason.trim()) fail('blocked reason is required');
  return saveResult(paths, task, sessionId, { status: 'blocked', blockedKind: 'external', reason: reason.trim(), worktree: taskWorktree(task) });
  });
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function scheduleCreatePayload(params) {
  if (!params || typeof params !== 'object') fail('schedule params required');
  const { fallback, fallbackUsed, fallbackReason, ...rest } = params;
  void fallback; void fallbackUsed; void fallbackReason;
  return rest;
}
export function clearOwnerUnknown({ home, pr, nodeId, now = new Date().toISOString() }) {
  return withHelperOp(home, pr, () => {
  const root = requireAbs(home, 'home');
  const lock = acquireLock(root, `pr-${nodeId}`);
  if (lock.held) fail('PR 状态锁占用，请稍后重试');
  try {
    refuseDeployLock(root);
    const previous = readPr(root, nodeId) || {};
    if (previous.needsHuman?.reason !== 'owner-unknown') fail('PR 没有 owner-unknown 标记');
    const abandonedId = previous.needsHuman.abandonedDispatchId ?? previous.pendingDispatch?.dispatchId;
    const abandoned = [...(previous.abandonedDispatches ?? []), abandonedId].filter(Boolean);
    const entry = {
      ...previous, number: Number(pr), nodeId,
      needsHuman: null, pendingDispatch: null, dispatchError: null, clearedOwnerUnknownAt: now,
      abandonedDispatches: [...new Set(abandoned)],
    };
    writePr(root, nodeId, entry);
    return entry;
  } finally { lock.release(); }
  });
}

function isLinkedWorktree(worktree, plugin, gitFn) {
  try {
    const common = gitOutput(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], gitFn);
    const root = gitOutput(['-C', plugin, 'rev-parse', '--path-format=absolute', '--git-common-dir'], gitFn);
    return fs.realpathSync(common) === fs.realpathSync(root);
  } catch { return false; }
}
function removeWatchCheckout({ plugin, worktree, number, branch, gitFn, force = false }) {
  if (path.resolve(worktree) !== path.resolve(watchWorktreePath(plugin, number))) fail('refusing to remove unexpected path');
  if (isLinkedWorktree(worktree, plugin, gitFn)) {
    gitOutput(['-C', plugin, 'worktree', 'remove', worktree], gitFn);
    try { gitOutput(['-C', plugin, 'branch', force ? '-D' : '-d', branch], gitFn); } catch {}
    return 'worktree';
  }
  fs.rmSync(worktree, { recursive: true, force: false });
  return 'clone';
}
function refExists(worktree, ref, gitFn) {
  try { gitOutput(['-C', worktree, 'rev-parse', '--verify', ref], gitFn); return true; }
  catch { return false; }
}
export function localCommitsNotReachable({ worktree, gitFn, branch, headRefName }) {
  const excludes = [];
  for (const ref of [`origin/${headRefName}`, 'upstream/main', 'origin/main']) {
    if (headRefName && refExists(worktree, ref, gitFn)) excludes.push(ref);
  }
  const args = ['-C', worktree, 'rev-list', branch];
  if (excludes.length) args.push('--not', ...excludes);
  const out = gitOutput(args, gitFn);
  return String(out).split(/\n/).map((item) => item.trim()).filter(Boolean);
}
export function cleanupWatch({ home, pr, ghFn = command, gitFn = command, env = process.env, now = new Date().toISOString() }) {
  return withHelperOp(home, pr, () => {
  const plugin = pluginRepoPath(env);
  const number = Number(pr);
  const view = ghJson(['pr', 'view', String(number), '--repo', REPO, '--json', 'state,headRefName'], ghFn);
  if (!['MERGED', 'CLOSED'].includes(view.state)) fail('cleanup requires MERGED or CLOSED PR');
  const worktree = watchWorktreePath(plugin, number);
  const branch = watchBranchName(number);
  if (!fs.existsSync(worktree)) return { removed: false, reason: 'missing', worktree, branch };
  const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
  if (status) fail('worktree is dirty');
  if (view.state === 'CLOSED') return { removed: false, reason: 'closed-unmerged', worktree, branch };
  const unreachable = localCommitsNotReachable({ worktree, gitFn, branch, headRefName: view.headRefName });
  let backup = null;
  if (unreachable.length) {
    backup = backupWatchBranch({ plugin, number, branch, gitFn, now, worktree });
    gitOutput(['bundle', 'verify', backup.bundlePath], gitFn);
  }
  removeWatchCheckout({ plugin, worktree, number, branch, gitFn, force: unreachable.length > 0 });
  return { removed: true, worktree, branch, backup, unreachableCount: unreachable.length };
  });
}

// branchAncestorOfMain 判断 watch 分支的提交是否已全部并入 origin/main（即已被合并、
// 不会因删除分支丢失内容）。用于决定自动清理时是否需要先备份。
export function branchAncestorOfMain(plugin, branch, gitFn = command, worktree = null) {
  const cwd = worktree && fs.existsSync(worktree) ? worktree : plugin;
  for (const ref of ['upstream/main', 'origin/main']) {
    try {
      gitOutput(['-C', cwd, 'merge-base', '--is-ancestor', branch, ref], gitFn);
      return true;
    } catch {}
  }
  return false;
}

// backupWatchBranch 在删除前把 watch 分支打成 git bundle，存进插件仓的
// `_backup/pr<N>-<日期>/` 下，只在分支可能含未合入 main 的提交时调用。
export function backupWatchBranch({ plugin, number, branch, gitFn = command, now = new Date().toISOString(), worktree } = {}) {
  const day = now.slice(0, 10);
  const dir = path.join(plugin, '_backup', `pr${number}-${day}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(dir, `${String(branch).replace(/\//g, '-')}.bundle`);
  const cwd = worktree && fs.existsSync(worktree) ? worktree : plugin;
  gitOutput(['-C', cwd, 'bundle', 'create', bundlePath, branch], gitFn);
  return { bundlePath };
}

// autoCleanupWatch 是脚本自己（无人工环节）对 watch worktree/分支执行的兜底清理：
// 只在明确已合并、worktree 干净的前提下删除；分支已完全并入 main 直接删，否则先
// bundle 备份再强删；worktree 脏、PR 未合并、或出现任何异常都只记录、不删除。
export function autoCleanupWatch({
  home, pr, plugin, gitFn = command, ghFn = command, env = process.env,
  now = new Date().toISOString(), knownMerged = false,
}) {
  const number = Number(pr);
  const repoPlugin = plugin || pluginRepoPath(env);
  const branch = watchBranchName(number);
  const worktree = watchWorktreePath(repoPlugin, number);
  try {
    if (!knownMerged) {
      const view = ghJson(['pr', 'view', String(number), '--repo', REPO, '--json', 'state'], ghFn);
      if (view.state !== 'MERGED') return { removed: false, reason: 'not-merged', worktree, branch };
    }
    if (!fs.existsSync(worktree)) {
      try { gitOutput(['-C', repoPlugin, 'branch', '-d', branch], gitFn); } catch {}
      return { removed: true, worktree, branch, backup: null, note: 'worktree-missing' };
    }
    const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
    if (status) return { removed: false, reason: 'dirty', worktree, branch };
    const ancestor = branchAncestorOfMain(repoPlugin, branch, gitFn, worktree);
    let backup = null;
    if (!ancestor) backup = backupWatchBranch({ plugin: repoPlugin, number, branch, gitFn, now, worktree });
    removeWatchCheckout({ plugin: repoPlugin, worktree, number, branch, gitFn, force: !ancestor });
    return { removed: true, worktree, branch, backup };
  } catch (error) {
    return { removed: false, reason: 'error', error: String(error?.message || error), worktree, branch };
  }
}

export function lockDoctor({ home } = {}) {
  return inspectLocks(requireAbs(home, 'home'));
}
export function lockDoctorClearGuard({ home, lockName, now } = {}) {
  return clearOrphanGuard(requireAbs(home, 'home'), lockName, now);
}

function cli(argv) {
  const args = [...argv];
  const modes = new Set(['prepare', 'validate', 'finalize', 'recheck', 'blocked', 'cleanup', 'clear-owner-unknown', 'lock-doctor']);
  const modeIndex = args.findIndex((item) => modes.has(item));
  const mode = modeIndex >= 0 ? args.splice(modeIndex, 1)[0] : undefined;
  const value = (name, required = true) => {
    const index = args.indexOf(name);
    if (index < 0) { if (required) fail(`${name} is required`); return undefined; }
    const item = args[index + 1];
    if (!item || item.startsWith('--')) fail(`${name} requires a value`);
    return item;
  };
  const home = value('--home');
  let result;
  if (mode === 'cleanup') result = cleanupWatch({ home, pr: value('--pr') });
  else if (mode === 'clear-owner-unknown') result = clearOwnerUnknown({ home, pr: value('--pr'), nodeId: value('--node-id') });
  else if (mode === 'lock-doctor') {
    const lockName = value('--clear-guard', false);
    result = lockName ? lockDoctorClearGuard({ home, lockName }) : lockDoctor({ home });
  }
  else {
    const task = value('--task');
    if (mode === 'prepare') result = prepare({ home, taskPath: task });
    else if (mode === 'validate') result = validate({ home, taskPath: task, validatedHead: value('--validated-head') });
    else if (mode === 'finalize') result = finalize({ home, taskPath: task, scReport: value('--sc-report'), validatedHead: value('--validated-head'), validationReceipt: value('--validation-receipt', false) });
    else if (mode === 'recheck') result = recheck({ home, taskPath: task, validatedHead: value('--validated-head', false) });
    else if (mode === 'blocked') result = blocked({ home, taskPath: task, reason: value('--reason') });
    else fail('mode must be prepare, validate, finalize, recheck, blocked, cleanup, clear-owner-unknown, or lock-doctor');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (mode === 'validate' && result.status === 'fail') process.exitCode = 1;
}

if (process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`cindy-repair: ${error.message}\n`); process.exitCode = Number(error.exitCode) || 1; }
}

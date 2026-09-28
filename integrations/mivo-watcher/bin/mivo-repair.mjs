#!/usr/bin/env node
// Mini PR repair contract. This helper owns one task file and one PR worktree.
// It deliberately has no session-runtime integration: the watcher is the
// source of the session binding and Cindy is responsible for the session.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectMivoCiSync } from './mivo-ci.mjs';
import { acquireLock, readPr, writePr } from './mivo-state.mjs';

export const REPO = 'xindong/mivo-canvas-plugin';
export const DEFAULT_PLUGIN_REPO = '/Users/praise/AI-Agent/Claude/projects/Project Mivo Canvas-Plugin';
const GH = process.env.GH_BIN ?? 'gh';
const GIT = process.env.GIT_BIN ?? 'git';
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_PUSH_TIMEOUT_MS = 60 * 60 * 1000;

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
  return env.MIVO_PLUGIN_REPO || DEFAULT_PLUGIN_REPO;
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
    ...payload, schemaVersion: 2, kind: 'mivo-repair-result', ...identity(task, sessionId),
    scope: 'feedback-task', prReady: false,
    sourceHead: task.headRefOid, observedAt: new Date().toISOString(), receiptId,
    historyPath: path.join(history, `${receiptId}.json`),
  };
  immutableJson(result.historyPath, result);
  atomicJson(latest, result);
  return result;
}

export function command(binary, args, options = {}, runner = execFileSync) {
  const timeout = options.timeout ?? (binary === GIT && args.includes('push')
    ? GIT_PUSH_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS);
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

function taskFrom(home, taskPath) {
  const paths = repairPaths(home);
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

function remoteUrl(repo) { return `https://github.com/${repo}.git`; }

function assertOrigin(worktree, repo, gitFn, expectedUrl = remoteUrl(repo)) {
  const origin = gitOutput(['-C', worktree, 'remote', 'get-url', 'origin'], gitFn).replace(/\/$/, '');
  const expected = expectedUrl.replace(/\/$/, '');
  const normalize = (value) => value.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  if (normalize(origin) !== normalize(expected)) fail(`worktree origin mismatch: ${origin}`);
}

function assertWorktree(worktree, task, gitFn, expectedUrl = remoteUrl(task.repo)) {
  if (!fs.existsSync(worktree)) return false;
  if (!fs.statSync(worktree).isDirectory()) fail('worktree path exists but is not a directory');
  const top = gitOutput(['-C', worktree, 'rev-parse', '--show-toplevel'], gitFn);
  if (fs.realpathSync(top) !== fs.realpathSync(worktree)) fail('worktree path is not an independent git checkout');
  assertOrigin(worktree, task.repo, gitFn, expectedUrl);
  const branch = gitOutput(['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], gitFn);
  if (branch !== watchBranchName(task.number)) fail(`worktree branch mismatch: ${branch}`);
  const upstream = gitOutput(['-C', worktree, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitFn);
  if (upstream !== `origin/${task.headRefName}`) fail(`worktree upstream mismatch: ${upstream}`);
  const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
  if (status) fail('worktree is dirty');
  const head = gitOutput(['-C', worktree, 'rev-parse', 'HEAD'], gitFn);
  if (!isSha(head)) fail('worktree HEAD is invalid');
  return { head };
}

export function cloneWorktree(paths, task, gitFn, cloneUrl = remoteUrl(task.repo), expectedUrl = remoteUrl(task.repo), remoteHead = task.headRefOid, env = process.env) {
  const plugin = pluginRepoPath(env);
  const worktree = watchWorktreePath(plugin, task.number);
  const branch = watchBranchName(task.number);
  const existing = assertWorktree(worktree, task, gitFn, expectedUrl);
  if (existing) return { worktree, head: existing.head, created: false };
  fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  if (fs.existsSync(worktree)) fail('worktree path is unknown; refusing to remove it');
  gitOutput(['-C', plugin, 'fetch', 'origin', task.headRefName], gitFn);
  gitOutput(['-C', plugin, 'worktree', 'add', '-B', branch, worktree, `origin/${task.headRefName}`], gitFn);
  gitOutput(['-C', worktree, 'branch', '--set-upstream-to', `origin/${task.headRefName}`], gitFn);
  const checked = assertWorktree(worktree, task, gitFn, expectedUrl);
  if (!checked || checked.head !== remoteHead) fail('cloned worktree HEAD does not match observed remote head');
  return { worktree, head: checked.head, created: true };
}

export function prepare({ home, taskPath, ghFn = command, gitFn = command, cloneUrl, originUrl = remoteUrl(REPO) } = {}) {
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  const pr = ghPr(task, ghFn, false);
  const checkout = cloneWorktree(paths, task, gitFn, cloneUrl ?? originUrl, originUrl, pr.headRefOid);
  const needsSync = checkout.head !== pr.headRefOid || task.headRefOid !== pr.headRefOid;
  return { ...identity(task, sessionId), status: needsSync ? 'needs-sync' : 'prepared', needsSync,
    worktree: checkout.worktree, head: checkout.head, remoteHead: pr.headRefOid, sourceHead: task.headRefOid, created: checkout.created };
}

function validateScs(report, task) {
  const scs = Array.isArray(report) ? report : report?.scs;
  if (!Array.isArray(scs) || scs.length === 0) fail('SC report must contain a non-empty scs array');
  const feedback = task.feedback ?? [];
  if (!Array.isArray(feedback)) fail('task feedback must be an array');
  const expected = new Set(feedback.map((item) => item?.key));
  if ([...expected].some((key) => typeof key !== 'string' || !key.trim()) || expected.size !== feedback.length) fail('task feedback keys must be non-empty and unique');
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
    for (const key of keys) {
      if (!expected.has(key)) fail(`SC[${index}] contains an external feedback key: ${key}`);
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
  if (env.PREFLIGHT_SKIP === '1') fail('PREFLIGHT_SKIP=1 cannot authorize repair validation or push; a bound approval receipt is required for an exception');
}

function validationPolicy(worktree, task, gitFn) {
  const file = '.githooks/pre-push';
  const expected = gitOutput(['-C', worktree, 'show', `${task.headRefOid}:${file}`], gitFn).trim();
  const actual = fs.readFileSync(path.join(worktree, file), 'utf8').trim();
  if (!expected || expected !== actual) fail('local preflight policy changed from the dispatched baseline');
  return { file, sourceHead: task.headRefOid, sha256: hash(actual) };
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

export function validate({ home, taskPath, validatedHead, gitFn = command, runFn = command, env = process.env, originUrl = remoteUrl(REPO) } = {}) {
  rejectSkip(env);
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  if (!isSha(validatedHead)) fail('validated-head must be a 40-character SHA');
  const worktree = taskWorktree(task);
  const checkout = assertWorktree(worktree, task, gitFn, originUrl);
  if (!checkout || checkout.head !== validatedHead) fail('worktree HEAD does not match validated-head');
  const exception = validationException(paths, task, sessionId, validatedHead, worktree, gitFn);
  const policy = exception ? null : validationPolicy(worktree, task, gitFn);
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
    if (policy && validationPolicy(worktree, task, gitFn).sha256 !== policy.sha256) fail('preflight policy changed during validation');
  } catch (error) { status = 'fail'; reason = error.message; }
  const receipt = {
    schemaVersion: 2, kind: 'mivo-repair-validation', ...identity(task, sessionId), head: validatedHead,
    status, policy, exception, command: exception ? null : { binary: '/bin/bash', args: [policy.file] },
    exitCode, outputHash, ...(reason ? { reason } : {}), startedAt, finishedAt: new Date().toISOString(),
  };
  const receiptPath = path.join(paths.validations, task.dispatchId, `${validatedHead}-${randomUUID()}.json`);
  immutableJson(receiptPath, receipt);
  const verification = { status, head: validatedHead, receiptPath, receiptSha256: hash(fs.readFileSync(receiptPath)) };
  atomicJson(validationPointer(paths, task, validatedHead), verification);
  return verification;
}

function verifiedLocal(paths, task, sessionId, head, worktree, gitFn, receiptPath = null) {
  const pointer = readJson(validationPointer(paths, task, head), 'local validation pointer');
  const file = requireAbs(receiptPath ?? pointer.receiptPath, 'local validation receipt');
  if (!under(file, path.join(paths.validations, task.dispatchId)) || file !== pointer.receiptPath) fail('local validation receipt is not the latest bound receipt');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== pointer.receiptSha256) fail('local validation receipt hash mismatch');
  const receipt = JSON.parse(bytes);
  assertIdentity(receipt, task, sessionId, 'local validation');
  if (receipt.schemaVersion !== 2 || receipt.kind !== 'mivo-repair-validation' || receipt.head !== head || pointer.head !== head) fail('local validation HEAD or schema mismatch');
  if (receipt.status === 'approved-exception') {
    const exception = validationException(paths, task, sessionId, head, worktree, gitFn);
    if (!exception || exception.approvalSha256 !== receipt.exception?.approvalSha256) fail('local validation exception is no longer bound');
  } else if (receipt.status !== 'pass' || receipt.exitCode !== 0
    || receipt.policy?.sha256 !== validationPolicy(worktree, task, gitFn).sha256) fail('local validation did not pass for this HEAD');
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
  return policyCiResult(collectMivoCiSync({pr:{...pr,repo:task.repo},ghFn:args=>ghFn(GH,args)}),head);
}

export function ciResult(ci) {
  const failures = ci.requiredChecks.filter((check) => check.bucket === 'fail');
  if (failures.length) return { status: 'blocked', blockedKind: 'required-ci', reason: `required CI failed: ${failures.map((check) => check.name).join(', ')}` };
  if (!ci.requiredGreen) return { status: 'waiting-ci', reason: `waiting for current HEAD required CI: ${[...ci.missing, ...ci.pending].join(', ')}` };
  return { status: 'complete' };
}

export function pushIfNeeded(worktree, task, validatedHead, remoteHead, gitFn, originUrl = remoteUrl(task.repo)) {
  if (remoteHead === validatedHead) return { pushed: false };
  const checkout = assertWorktree(worktree, task, gitFn, originUrl);
  if (!checkout || checkout.head !== validatedHead) fail('local HEAD changed before push');
  const latest = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (latest !== remoteHead) fail('remote branch changed before push');
  const ancestor = (() => {
    try { gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', remoteHead, validatedHead], gitFn); return true; }
    catch { return false; }
  })();
  if (!ancestor) fail('remote branch advanced independently; refusing non-fast-forward push');
  gitOutput(['-C', worktree, 'push', 'origin', `HEAD:refs/heads/${task.headRefName}`], gitFn);
  const after = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (after !== validatedHead) fail('remote branch changed after push; pushed commit requires reconciliation');
  return { pushed: true };
}

export function finalize({ home, taskPath, scReport, validatedHead, validationReceipt, ghFn = command, gitFn = command, env = process.env, originUrl = remoteUrl(REPO) } = {}) {
  rejectSkip(env);
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  if (!isSha(validatedHead)) fail('validated-head must be a 40-character SHA');
  const pr = ghPr(task, ghFn, false);
  const worktree = taskWorktree(task);
  const checkout = assertWorktree(worktree, { ...task, headRefOid: validatedHead }, gitFn, originUrl);
  if (!checkout || checkout.head !== validatedHead) fail('worktree HEAD does not match validated-head');
  const branchHead = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (!isSha(branchHead)) fail('remote branch head is unavailable');
  if (branchHead !== pr.headRefOid) fail(`remote branch and PR head disagree: ${branchHead} != ${pr.headRefOid}`);
  const { scs, feedbackCoverage } = loadScs(scReport, task);
  const noChange = validatedHead === task.headRefOid && branchHead === validatedHead && scs.every((sc) => sc.status === 'no-change');
  const verification = noChange
    ? { status: 'not-required-no-change', head: validatedHead, localTests: 'not-run', reason: 'all SCs are no-change and task, checkout and remote HEAD match' }
    : verifiedLocal(paths, task, sessionId, validatedHead, worktree, gitFn, validationReceipt);
  const push = pushIfNeeded(worktree, task, validatedHead, branchHead, gitFn, originUrl);
  let ci;
  try { ci = checkStatus(task, validatedHead, ghFn); }
  catch (error) {
    return saveResult(paths, task, sessionId, { status: 'blocked', blockedKind: 'ci-transport', reason: error.message,
      head: validatedHead, scs, feedbackCoverage, verification, checks: [], pushed: push.pushed });
  }
  return saveResult(paths, task, sessionId, { ...ciResult(ci), head: validatedHead, scs, feedbackCoverage, verification, ci, checks: ci.requiredChecks, pushed: push.pushed });
}

export function recheck({ home, taskPath, validatedHead, ghFn = command, gitFn = command, originUrl = remoteUrl(REPO) } = {}) {
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  const previous = readJson(path.join(paths.results, `${task.dispatchId}.json`), 'repair result');
  if (previous.schemaVersion !== 2 || previous.kind !== 'mivo-repair-result') fail('legacy result is unverified; a new finalize receipt is required');
  assertIdentity(previous, task, sessionId, 'repair result');
  const head = validatedHead ?? previous.head;
  if (!isSha(head) || previous.head !== head) fail('recheck HEAD does not match the result');
  const { scs, feedbackCoverage } = validateScs(previous.scs, task);
  const worktree = taskWorktree(task);
  const checkout = assertWorktree(worktree, task, gitFn, originUrl);
  if (!checkout || checkout.head !== head) fail('recheck worktree HEAD changed');
  let verification;
  if (previous.verification?.status === 'not-required-no-change') {
    if (head !== task.headRefOid || !previous.scs.every((sc) => sc.status === 'no-change')) fail('no-change verification cannot cover code changes');
    verification = previous.verification;
  } else {
    verification = verifiedLocal(paths, task, sessionId, head, worktree, gitFn, previous.verification?.receiptPath);
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
}

export function blocked({ home, taskPath, reason, ghFn = command } = {}) {
  const { paths, task } = taskFrom(home, taskPath);
  const { sessionId } = boundSession(paths, task);
  if (typeof reason !== 'string' || !reason.trim()) fail('blocked reason is required');
  return saveResult(paths, task, sessionId, { status: 'blocked', blockedKind: 'external', reason: reason.trim(), worktree: taskWorktree(task) });
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function scheduleParams({ home, pr, nodeId, env = process.env }) {
  const root = requireAbs(home, 'home');
  const plugin = pluginRepoPath(env);
  const script = path.join(root, 'bin', 'mivo-watch-script.py');
  const commandLine = `/usr/bin/env MIVO_WATCHER_LIVE=1 MIVO_WATCHER_HOME=${shellQuote(root)} PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/python3 ${shellQuote(script)} --mode poll --pr ${pr} --node-id ${nodeId}`;
  return {
    name: `Mivo watch #${pr}`,
    executionMode: 'script',
    scriptConfig: { command: commandLine, capabilities: ['sessions.dispatch'], timeoutMs: 180000 },
    cronExpr: '*/5 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'codex',
    kind: 'cron',
    workingDir: plugin,
    useWorktree: false,
    bindToCurrentSession: true,
    notify: { desktop: false, feishu: false },
  };
}

export function bindSchedule({
  home, pr, nodeId, resultPath, dispatchId, now = new Date().toISOString(),
  retryMs = 180000, retryDelayMs = 5000, sleepFn = null,
} = {}) {
  const root = requireAbs(home, 'home');
  const result = readJson(requireAbs(resultPath, 'result'), 'schedule_create result');
  const command = result.scriptConfig?.command ?? result.command ?? '';
  if (result.ok !== true) fail('schedule_create result is not ok');
  if (result.executionMode !== 'script') fail('schedule_create executionMode must be script');
  if (result.status !== 'active') fail('schedule_create status must be active');
  if (typeof result.targetSessionId !== 'string' || !result.targetSessionId) fail('schedule_create targetSessionId is required');
  if (!String(command).includes(`--pr ${pr}`)) fail('schedule command does not target this PR');
  const sleep = sleepFn ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
  const deadline = Date.now() + retryMs;
  let lock = acquireLock(root, `pr-${nodeId}`);
  while (lock.held && Date.now() < deadline) {
    sleep(retryDelayMs);
    lock = acquireLock(root, `pr-${nodeId}`);
  }
  if (lock.held) fail('busy: PR 状态锁占用，请等 1 分钟后重试 bind-schedule', 2);
  try {
    const previous = readPr(root, nodeId) || {};
    const incoming = result.targetSessionId;
    const pendingId = previous.pendingDispatch?.dispatchId;
    const lateUnknown = previous.needsHuman?.abandonedDispatchId;
    const currentOwner = Boolean(previous.sessionId && previous.sessionId === incoming);
    if (!dispatchId) {
      if (!currentOwner || pendingId || previous.needsHuman?.reason === 'owner-unknown') {
        fail('owner-conflict: bind-schedule 需要 --dispatch-id', 3);
      }
    } else {
      const abandoned = previous.abandonedDispatches ?? [];
      if (abandoned.includes(dispatchId)) fail('owner-conflict: dispatch-id 已作废', 3);
      if (pendingId && pendingId !== dispatchId) fail('owner-conflict: dispatch-id 与当前 pending 不一致', 3);
      if (!pendingId && previous.needsHuman?.reason === 'owner-unknown' && dispatchId !== lateUnknown) {
        fail('owner-conflict: dispatch-id 与 owner-unknown 记录不一致', 3);
      }
      if (!pendingId && !previous.sessionId && previous.needsHuman?.reason !== 'owner-unknown') {
        fail('owner-conflict: 无 pending 的未知 dispatch-id', 3);
      }
      if (previous.sessionId && previous.sessionId !== incoming) {
        const awaiting = previous.pendingDispatch?.status === 'awaiting-claim';
        const needsHuman = previous.needsHuman?.reason === 'owner-unknown';
        if (!awaiting && !needsHuman) fail(`owner-conflict: 本 PR 已由 ${previous.sessionId} 持有，你应停止`, 3);
      }
    }
    const entry = {
      ...previous, number: Number(pr), nodeId,
      scheduleId: result.id ?? result.scheduleId,
      sessionId: incoming, claimedAt: now, pendingDispatch: null, dispatchError: null, needsHuman: null,
    };
    writePr(root, nodeId, entry);
    return entry;
  } finally { lock.release(); }
}

export function clearOwnerUnknown({ home, pr, nodeId, now = new Date().toISOString() }) {
  const root = requireAbs(home, 'home');
  const lock = acquireLock(root, `pr-${nodeId}`);
  if (lock.held) fail('PR 状态锁占用，请稍后重试');
  try {
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
}

export function cleanupWatch({ home, pr, ghFn = command, gitFn = command, env = process.env }) {
  const plugin = pluginRepoPath(env);
  const number = Number(pr);
  const view = ghJson(['pr', 'view', String(number), '--repo', REPO, '--json', 'state'], ghFn);
  if (!['MERGED', 'CLOSED'].includes(view.state)) fail('cleanup requires MERGED or CLOSED PR');
  const worktree = watchWorktreePath(plugin, number);
  if (fs.existsSync(worktree)) {
    const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
    if (status) fail('worktree is dirty');
    gitOutput(['-C', plugin, 'worktree', 'remove', worktree], gitFn);
  }
  try { gitOutput(['-C', plugin, 'branch', '-d', watchBranchName(number)], gitFn); } catch {}
  return { removed: true, worktree, branch: watchBranchName(number) };
}

function cli(argv) {
  const args = [...argv];
  const modes = new Set(['prepare', 'validate', 'finalize', 'recheck', 'blocked', 'schedule-params', 'bind-schedule', 'cleanup', 'clear-owner-unknown']);
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
  if (mode === 'schedule-params') result = scheduleParams({ home, pr: value('--pr'), nodeId: value('--node-id') });
  else if (mode === 'bind-schedule') result = bindSchedule({ home, pr: value('--pr'), nodeId: value('--node-id'), resultPath: value('--result'), dispatchId: value('--dispatch-id', false) });
  else if (mode === 'cleanup') result = cleanupWatch({ home, pr: value('--pr') });
  else if (mode === 'clear-owner-unknown') result = clearOwnerUnknown({ home, pr: value('--pr'), nodeId: value('--node-id') });
  else {
    const task = value('--task');
    if (mode === 'prepare') result = prepare({ home, taskPath: task });
    else if (mode === 'validate') result = validate({ home, taskPath: task, validatedHead: value('--validated-head') });
    else if (mode === 'finalize') result = finalize({ home, taskPath: task, scReport: value('--sc-report'), validatedHead: value('--validated-head'), validationReceipt: value('--validation-receipt', false) });
    else if (mode === 'recheck') result = recheck({ home, taskPath: task, validatedHead: value('--validated-head', false) });
    else if (mode === 'blocked') result = blocked({ home, taskPath: task, reason: value('--reason') });
    else fail('mode must be prepare, validate, finalize, recheck, blocked, schedule-params, bind-schedule, cleanup, or clear-owner-unknown');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (mode === 'validate' && result.status === 'fail') process.exitCode = 1;
}

if (process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`mivo-repair: ${error.message}\n`); process.exitCode = Number(error.exitCode) || 1; }
}

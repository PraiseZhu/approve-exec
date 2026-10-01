import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply, FILES, stateFingerprint, verify } from './deploy.mjs';
import { finalize, recheck, repairPaths, validate, watchWorktreePath } from './bin/cindy-repair.mjs';
import { acquireLock, DEPLOY_LOCK_NAME, helperLockName, HELPER_LOCK_NAME, lockStatus, writePr } from './bin/cindy-state.mjs';

const REPO = 'makecindy/cindy';
const finding = (priority, key = `thread:${priority}`) => ({
  key, source: 'thread', user: { login: 'github-actions[bot]', type: 'Bot' },
  body: `**${priority}**: synthetic finding in src/example.ts`,
});

// Every Git mutation is confined to this test's disposable repositories. gh is
// entirely simulated; unexpected API calls fail instead of reaching the network.
function fixture(t, { changed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-repair-scope-'));
  const home = path.join(root, 'watcher');
  const plugin = path.join(root, 'plugin');
  const worktree = watchWorktreePath(plugin, 790);
  const originUrl = path.join(root, 'origin.git');
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  }).trim();
  const previousPlugin = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => {
    if (previousPlugin === undefined) delete process.env.CINDY_WATCHER_REPO;
    else process.env.CINDY_WATCHER_REPO = previousPlugin;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(worktree, { recursive: true });
  git('init', '--bare', originUrl);
  git('init', '-b', 'watch/pr-790', worktree);
  git('-C', worktree, 'config', 'user.name', 'Repair scope fixture');
  git('-C', worktree, 'config', 'user.email', 'repair-scope@example.invalid');
  fs.mkdirSync(path.join(worktree, '.githooks'));
  fs.writeFileSync(path.join(worktree, '.githooks/pre-push'), '#!/bin/bash\nset -eu\nprintf "fixture checks passed\\n"\n');
  fs.writeFileSync(path.join(worktree, 'example.txt'), 'baseline\n');
  git('-C', worktree, 'add', '.');
  git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'fixture baseline');
  const sourceHead = git('-C', worktree, 'rev-parse', 'HEAD');
  git('-C', worktree, 'remote', 'add', 'origin', originUrl);
  git('-C', worktree, 'push', '-u', 'origin', 'HEAD:refs/heads/fix/scope');
  if (changed) {
    fs.writeFileSync(path.join(worktree, 'example.txt'), 'synthetic repair\n');
    git('-C', worktree, 'add', '.');
    git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'fixture repair');
  }
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const taskPath = path.join(paths.tasks, 'scope-dispatch.json');
  const task = { dispatchId: 'scope-dispatch', nodeId: 'PR_790', number: 790, repo: REPO,
    sessionId: 'scope-session', headRefOid: sourceHead, headRefName: 'fix/scope',
    headRepo: 'PraiseZhu/cindy-fork', headOwner: 'PraiseZhu', feedback: [finding('P1')] };
  const saveTask = (feedback) => {
    task.feedback = feedback;
    // A stale or forged cached policy must not override the underlying feedback.
    task.repairPolicy = { canChangeCode: true, allowedFeedbackKeys: feedback.map(item => item.key) };
    fs.writeFileSync(taskPath, JSON.stringify(task));
  };
  saveTask(task.feedback);
  writePr(home, task.nodeId, { number: task.number, nodeId: task.nodeId, sessionId: task.sessionId,
    activeTask: { dispatchId: task.dispatchId } });
  let remoteHead = sourceHead;
  const pushCalls = [];
  const ghCalls = [];
  const gitFn = (_binary, args) => {
    if (args.includes('push')) {
      pushCalls.push(args);
      // Check the destination before delegating even a test-only push.
      assert.equal(git('-C', worktree, 'remote', 'get-url', 'origin'), originUrl);
    }
    const out = git(...args);
    if (args.includes('push')) remoteHead = git('--git-dir', originUrl, 'rev-parse', 'refs/heads/fix/scope');
    return out;
  };
  const pr = () => ({ id: task.nodeId, number: task.number, state: 'OPEN', isDraft: false,
    headRefOid: remoteHead, headRefName: task.headRefName, baseRefOid: sourceHead, baseRefName: 'main' });
  const ghFn = (_binary, args) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr());
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ required_status_checks: {
      contexts: ['verify'], checks: [{ context: 'verify', app_id: 123 }],
    } });
    if (String(endpoint).startsWith(`repos/${REPO}/rules/branches/main`)) return JSON.stringify([[]]);
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${sourceHead}`) {
      assert.fail('cindy policy must not read docs/sync/required-checks.json');
    }
    if (endpoint === `repos/${REPO}/commits/${remoteHead}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: [{
      id: 101, name: 'verify', head_sha: remoteHead, status: 'completed', conclusion: 'success',
      started_at: '2026-09-29T00:00:00Z', app: { id: 123, slug: 'fixture-ci' },
      details_url: 'https://example.invalid/fixture-ci',
    }] }]);
    if (endpoint === `repos/${REPO}/commits/${remoteHead}/statuses?per_page=100`) return JSON.stringify([[]]);
    assert.fail(`unexpected GitHub call: ${JSON.stringify(args)}`);
  };
  const scReport = path.join(root, 'sc-report.json');
  const report = scs => fs.writeFileSync(scReport, JSON.stringify({ scs }));
  const sc = (status, feedbackKeys) => ({ id: `SC-${feedbackKeys.join('-') || 'empty'}`, status,
    feedbackKeys, evidence: ['synthetic fixture checked locally'] });
  const options = { home, taskPath, scReport, validatedHead: head, originUrl, gitFn, ghFn,
    env: { ...process.env, PREFLIGHT_SKIP: '0', CINDY_PREFLIGHT_BIN: path.join(worktree, '.githooks/pre-push') } };
  return { task, paths, sourceHead, head, options, saveTask, report, sc, pushCalls, ghCalls,
    remoteHead: () => git('--git-dir', originUrl, 'rev-parse', 'refs/heads/fix/scope'),
    validate: () => validate(options), finalize: () => finalize(options) };
}

for (const status of ['pass', 'no-change']) {
  test(`P3-only changed HEAD cannot finalize ${status}, even with a valid prior validation receipt`, (t) => {
    const f = fixture(t);
    assert.equal(f.validate().status, 'pass');
    f.saveTask([{ ...finding('P3'), category: 'actionable-fix', priority: 'P1',
      repairPolicy: { action: 'code-fix', canChangeCode: true } }]);
    f.report([f.sc(status, ['thread:P3'])]);
    assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(f.remoteHead(), f.sourceHead);
    assert.equal(fs.existsSync(path.join(f.paths.results, `${f.task.dispatchId}.json`)), false);
  });
}

test('P3-only unchanged HEAD closes the complete no-change flow without validation or push', (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P3')]);
  f.report([f.sc('no-change', ['thread:P3'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(result.pushed, false);
  assert.equal(result.verification.status, 'not-required-no-change');
  assert.equal(result.feedbackCoverage.dispositions[0].disposition, 'no-change');
  assert.equal(result.ci.requiredGreen, true);
  assert.ok(f.ghCalls.some(args => args[1]?.includes('/check-runs?')));
  assert.equal(f.pushCalls.length, 0);
});

test('a P1 in the same task does not authorize an SC marking P3 fixed', (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P3')]);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('pass', ['thread:P3'])]);
  assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限|no.change/i);
  assert.equal(f.pushCalls.length, 0);
  assert.equal(f.remoteHead(), f.sourceHead);
});

for (const kind of ['P1', 'P2', 'required-ci']) {
  test(`${kind} authorized repair can validate, push to fixture origin and close against current-head CI`, (t) => {
    const f = fixture(t);
    const feedback = kind === 'P1' || kind === 'P2' ? finding(kind) : {
      key: 'ci:verify', source: 'ci', sha: f.sourceHead,
      requiredFailure: { verified: true, status: 'failed', headSha: f.sourceHead },
    };
    f.saveTask([feedback]);
    assert.equal(f.validate().status, 'pass');
    f.report([f.sc('pass', [feedback.key])]);
    const result = f.finalize();
    assert.equal(result.status, 'complete');
    assert.equal(result.pushed, true);
    assert.equal(result.verification.status, 'pass');
    assert.equal(result.ci.requiredGreen, true);
    assert.equal(f.pushCalls.length, 1);
    assert.equal(f.remoteHead(), f.head);
  });
}

for (const kind of ['P3', 'unknown', 'empty']) {
  test(`${kind} feedback cannot publish a changed HEAD through no-change SCs`, (t) => {
    const f = fixture(t);
    assert.equal(f.validate().status, 'pass');
    const feedback = kind === 'empty' ? [] : kind === 'unknown'
      ? [{ ...finding('P1'), key: 'thread:unknown', body: 'Please consider this improvement.' }]
      : [finding('P3')];
    f.saveTask(feedback);
    f.report([f.sc('no-change', feedback.map(item => item.key))]);
    assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(f.remoteHead(), f.sourceHead);
  });
}

test('mixed task can fix P1 while explicitly leaving P3 unchanged', (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P3')]);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('no-change', ['thread:P3'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(f.pushCalls.length, 1);
  assert.deepEqual(result.feedbackCoverage.dispositions.map(item => [item.key, item.disposition]),
    [['thread:P1', 'fixed'], ['thread:P3', 'no-change']]);
});

test('P3-only validation rejects a changed HEAD before running preflight', (t) => {
  const f = fixture(t);
  f.saveTask([finding('P3')]);
  let preflightRuns = 0;
  assert.throws(() => validate({ ...f.options, runFn: () => { preflightRuns++; return 'passed'; } }),
    /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
  assert.equal(preflightRuns, 0);
  assert.equal(f.pushCalls.length, 0);
});

test('recheck cannot certify a changed HEAD after its feedback loses repair authority', (t) => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  assert.equal(f.finalize().status, 'complete');
  f.saveTask([{ ...finding('P3'), key: 'thread:P1' }]);
  const pushesBefore = f.pushCalls.length;
  assert.throws(() => recheck(f.options), /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限|no.change/i);
  assert.equal(f.pushCalls.length, pushesBefore);
});

test('apply during validate preflight is refused; validate still writes a receipt', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.options.home, 'bin'), { recursive: true });
  for (const name of FILES) fs.writeFileSync(path.join(f.options.home, 'bin', name), 'old');
  fs.writeFileSync(path.join(f.options.home, 'state/index.json'), '{"version":2}\n');
  const plan = {
    version: 1, home: f.options.home, database: path.join(f.options.home, 'metadata.db'), id: 'lock-test',
    files: verify(f.options.home), stateSha: stateFingerprint(f.options.home), sessionIds: [],
  };
  let applyError;
  const result = validate({
    ...f.options,
    runFn: () => {
      try { apply(plan); } catch (error) { applyError = error; }
      return 'preflight ok\n';
    },
  });
  assert.match(String(applyError?.message ?? applyError), /runtime lock held/);
  assert.equal(result.status, 'pass');
  assert.ok(result.receiptPath);
  assert.equal(fs.existsSync(result.receiptPath), true);
  assert.equal(lockStatus(f.options.home, HELPER_LOCK_NAME).live, false);
  assert.equal(lockStatus(f.options.home, helperLockName(790)).live, false);
  assert.equal(fs.readFileSync(path.join(f.options.home, 'bin', FILES[0]), 'utf8'), 'old');
});

test('validate refuses immediately when deploy.lock is live and writes no receipt', (t) => {
  const f = fixture(t);
  const deploy = acquireLock(f.options.home, DEPLOY_LOCK_NAME);
  t.after(() => deploy.release());
  let preflightRuns = 0;
  assert.throws(
    () => validate({ ...f.options, runFn: () => { preflightRuns++; return 'passed'; } }),
    /deploy lock held/,
  );
  assert.equal(preflightRuns, 0);
  const dir = path.join(f.paths.validations, f.task.dispatchId);
  assert.equal(fs.existsSync(dir), false);
});

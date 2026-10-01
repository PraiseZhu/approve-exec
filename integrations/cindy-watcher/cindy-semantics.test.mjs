import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feedbackRepairPolicy, normalizeActorLogin } from './bin/cindy-feedback-policy.mjs';
import { evaluateCindyReview } from './bin/cindy-review-status.mjs';
import { collectCindyPolicySync } from './bin/cindy-pr-policy.mjs';
import {
  commitsMissingDco, isBaseGithubUrl, normalizeGithubUrl,
} from './bin/cindy-repair.mjs';
import {
  DISPATCH_PARAM_KEYS, dispatchParams, hasWatchOffComment, headOwnerOf, ownershipMatchesViewer, readOptout, scanOnce, watcherPaths,
} from './bin/cindy-watcher.mjs';
import { writePr } from './bin/cindy-state.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

test('GraphQL Bot.login without [bot] suffix is trusted after normalization', () => {
  assert.equal(normalizeActorLogin({ login: 'greptile-apps', __typename: 'Bot' }), 'greptile-apps[bot]');
  assert.equal(normalizeActorLogin({ login: 'github-actions', __typename: 'Bot' }), 'github-actions[bot]');
  assert.equal(normalizeActorLogin({ login: 'PraiseZhu', __typename: 'User' }), 'PraiseZhu');
  const body = '<a href="#"><img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=9" align="top"></a> **未接受输入就持久化 fork ID**';
  const p = feedbackRepairPolicy({ source: 'thread', author: { login: 'greptile-apps', __typename: 'Bot' }, body });
  assert.equal(p.action, 'code-fix');
  assert.equal(p.canChangeCode, true);
});

test('PR #5307 greptile summary HTML P1 badge authorizes a fix', () => {
  const summary = `<!-- greptile_summary -->\n<h2>Confidence Score: 4/5</h2>\n<h2>Findings</h2>\n1. <img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=9" align="top">&nbsp;**未接受输入就持久化 fork ID**`;
  const p = feedbackRepairPolicy({ source: 'comment', user: { login: 'greptile-apps', __typename: 'Bot' }, body: summary });
  assert.equal(p.action, 'code-fix');
  assert.deepEqual(p.severities, ['P1']);
});

test('required checks come from rules API, not required-checks.json', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const endpoint = args[1];
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ id: 'PR_1', number: 1, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    }
    if (endpoint === 'repos/makecindy/cindy/branches/main') return JSON.stringify({ protected: true });
    if (String(endpoint).startsWith('repos/makecindy/cindy/rules/branches/main')) {
      return JSON.stringify([[{
        type: 'required_status_checks', ruleset_id: 9,
        parameters: { required_status_checks: [
          { context: 'DCO', integration_id: 1 },
          { context: 'verify', integration_id: 15368 },
          { context: 'Windows unit tests', integration_id: 15368 },
        ] },
      }]]);
    }
    if (endpoint === 'repos/makecindy/cindy/branches/main/protection') {
      return JSON.stringify({ required_status_checks: { contexts: [], checks: [] } });
    }
    throw new Error(`unexpected ${JSON.stringify(args)}`);
  };
  const policy = collectCindyPolicySync({ repo: 'makecindy/cindy', number: 1, gh });
  assert.equal(policy.status, 'verified');
  assert.equal(policy.source, 'rules-api');
  assert.ok(policy.required.some((item) => item.context === 'DCO'));
  assert.ok(policy.required.some((item) => item.context === 'verify'));
  assert.equal(calls.some((args) => String(args[1] ?? '').includes('required-checks.json')), false);
});

test('https and ssh origin URLs normalize to the same github repo', () => {
  assert.equal(normalizeGithubUrl('git@github.com:PraiseZhu/cindy-fork.git'), 'https://github.com/praisezhu/cindy-fork');
  assert.equal(normalizeGithubUrl('https://github.com/PraiseZhu/cindy-fork'), 'https://github.com/praisezhu/cindy-fork');
  assert.equal(isBaseGithubUrl('https://github.com/makecindy/cindy.git'), true);
  assert.equal(isBaseGithubUrl('git@github.com:PraiseZhu/cindy-fork.git'), false);
});

test('viewer !== head owner is blocked', () => {
  const pr = {
    state: 'OPEN', isDraft: false, author: { login: 'PraiseZhu' },
    headRepositoryOwner: { login: 'someone-else' }, headRepository: { name: 'cindy-fork' },
  };
  assert.equal(headOwnerOf(pr), 'someone-else');
  assert.equal(ownershipMatchesViewer(pr, 'PraiseZhu'), false);
});

test('optout file and author /cindy-watch off comments are recognized', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-optout-'));
  try {
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config/optout.json'), '[5307, 12]\n');
    assert.deepEqual(readOptout(home), { ok: true, prs: [5307, 12] });
    assert.equal(hasWatchOffComment([{ author: { login: 'PraiseZhu' }, body: '/cindy-watch off' }], 'PraiseZhu'), true);
    assert.equal(hasWatchOffComment([{ author: { login: 'other' }, body: '/cindy-watch off' }], 'PraiseZhu'), false);
    assert.equal(hasWatchOffComment([{ author: { login: 'PraiseZhu' }, body: '/cindy-watch off please' }], 'PraiseZhu'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('DCO helper reports commits missing Signed-off-by', () => {
  const missing = commitsMissingDco('/tmp', 'a'.repeat(40), 'b'.repeat(40), (_bin, args) => {
    if (args.includes('log')) return `${'c'.repeat(40)}\nfix without signoff\n\x1e${'d'.repeat(40)}\nfix\n\nSigned-off-by: Praise <zhuzan@xd.com>\n`;
    return '';
  });
  assert.deepEqual(missing, ['c'.repeat(40)]);
});

test('poll MERGED runs script-driven closedown and never wakes a session', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-merged-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-merged-plugin-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(plugin, { recursive: true, force: true });
  });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writePr(home, 'PR_1', { number: 1, nodeId: 'PR_1', sessionId: 'sess-1', scheduleId: 'sched-1' });
  let dispatches = 0;
  // autoCleanupWatch is fully faked here: gitFn never shells out, and
  // CINDY_WATCHER_REPO points at an empty tmp dir, so this can never touch
  // the real plugin repo even on the "worktree missing" fallback path.
  const result = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now: '2026-09-29T00:00:00Z',
    nodeId: 'PR_1', prNumber: 1, gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
    snapshotFn: () => ({ state: 'MERGED', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE', labels: [] }),
    dispatchFn: () => { dispatches++; return { target_session_id: 'sess-1' }; },
  });
  assert.equal(dispatches, 0, 'MERGED closedown must not dispatch to a session');
  assert.equal(result.prs[0].dispatch.attempted, false);
  assert.equal(result.prs[0].dispatch.reason, 'closedown-script');
});

test('dispatchParams only emits Cindy broker-legal keys', () => {
  const params = dispatchParams({
    pr: { number: 1, id: 'PR_1', headRefOid: HEAD, title: 't', headRepositoryOwner: { login: 'PraiseZhu' }, headRepository: { name: 'cindy-fork' } },
    mapping: {}, fresh: [], now: '2026-09-29T00:00:00Z', taskPath: '/tmp/task.json', home: '/tmp/home',
  });
  for (const key of Object.keys(params)) assert.equal(DISPATCH_PARAM_KEYS.includes(key), true, key);
  assert.equal(Object.hasOwn(params, 'model'), false);
  assert.equal(Object.hasOwn(params, 'effort'), false);
  assert.equal(Object.hasOwn(params, 'providerId'), false);
  assert.equal(Object.hasOwn(params, 'agentKind'), false);
  assert.equal(Object.hasOwn(params, 'fallback'), false);
});

test('awaiting-maintainer-approval is ready but not a merge instruction', () => {
  const v = evaluateCindyReview({
    snapshot: {
      pr: { state: 'OPEN', isDraft: false },
      requiredChecksGreen: true, mergeable: 'MERGEABLE', threads: [], reviews: [],
      checks: [{ name: 'verify', state: 'SUCCESS', bucket: 'pass' }],
    },
    ci: { status: 'green' },
  });
  assert.equal(v.ready, true);
  assert.equal(v.reason, 'awaiting-maintainer-approval');
});

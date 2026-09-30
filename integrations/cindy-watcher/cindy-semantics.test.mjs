import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { feedbackRepairPolicy, normalizeActorLogin } from './bin/cindy-feedback-policy.mjs';
import { evaluateCindyReview } from './bin/cindy-review-status.mjs';
import { collectCindyPolicySync } from './bin/cindy-pr-policy.mjs';
import {
  commitsMissingDco, isBaseGithubUrl, isScheduleModelUnavailable, normalizeGithubUrl,
  scheduleCreatePayload, scheduleModelFromResult, scheduleParams,
  SCHEDULE_MODEL_FALLBACK, SCHEDULE_MODEL_PRIMARY,
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

test('schedule-params uses Cindy watch name, fork-safe env, and omits silentWhenIdle', () => {
  const home = '/Users/praise/AI-Agent/Claude/projects/Project CINDY/_ops/cindy-watcher';
  const out = scheduleParams({ home, pr: 5307, nodeId: 'PR_5307' });
  assert.equal(out.name, 'Cindy watch #5307');
  assert.equal(out.agentKind, 'codex');
  assert.equal(out.model, 'openai/gpt-6-luna');
  assert.equal(out.providerId, 'xd');
  assert.equal(out.effort, 'max');
  assert.deepEqual(out.fallback, SCHEDULE_MODEL_FALLBACK);
  assert.equal(out.fallback.model, 'gpt-6-luna');
  assert.equal(out.fallback.providerId, 'art-cindy');
  assert.equal(out.fallback.effort, 'max');
  assert.equal(scheduleCreatePayload(out).providerId, 'xd');
  assert.equal(Object.hasOwn(scheduleCreatePayload(out), 'fallback'), false);
  assert.equal(out.cronExpr, '*/5 * * * *');
  assert.deepEqual(out.scriptConfig.capabilities, ['sessions.dispatch']);
  assert.equal(Object.hasOwn(out, 'silentWhenIdle'), false);
  assert.match(out.scriptConfig.command, /CINDY_WATCHER_LIVE=1/);
  assert.match(out.scriptConfig.command, /CINDY_NODE_BIN=\/opt\/homebrew\/bin\/node/);
  assert.match(out.scriptConfig.command, /cindy-watch-script\.py/);
});

test('poll MERGED delivers closedown and does not treat awaiting-maintainer as merge', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-merged-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  writePr(home, 'PR_1', { number: 1, nodeId: 'PR_1', sessionId: 'sess-1', scheduleId: 'sched-1' });
  const result = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now: '2026-09-29T00:00:00Z',
    nodeId: 'PR_1', prNumber: 1,
    snapshotFn: () => ({ state: 'MERGED', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE', labels: [] }),
    dispatchFn: (params) => {
      assert.match(params.message, /已合并/);
      return { target_session_id: 'sess-1' };
    },
  });
  assert.equal(result.prs[0].dispatch.reason, 'closedown');
});

test('model-unavailable classifier only matches provider/model route errors', () => {
  assert.equal(isScheduleModelUnavailable({ message: 'NO_PROVIDER_FOR_AGENT: xd' }), true);
  assert.equal(isScheduleModelUnavailable({ code: 'PROVIDER_ROUTE_UNAVAILABLE', message: 'xd' }), true);
  assert.equal(isScheduleModelUnavailable(new Error('模型不存在')), true);
  assert.equal(isScheduleModelUnavailable(new Error('busy: PR 状态锁占用')), false);
  assert.equal(isScheduleModelUnavailable(new Error('ARCHIVED')), false);
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

test('scheduleModelFromResult defaults to primary when route is omitted', () => {
  assert.deepEqual(scheduleModelFromResult({}), { ...SCHEDULE_MODEL_PRIMARY, fallback: false, reason: null });
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cloudReady, validateSnapshot, evaluate, emptyCursors } from '../scripts/pr-watch/gate.mjs';

test('cloud gate rejects unknown/conflicting mergeability and malformed feedback identity', () => {
  const head = 'a'.repeat(40);
  const base = { state: 'open', draft: false, head_sha: head, mergeable: true,
    ci: { green: true, failing: [], pending: false, blocked: false, head_sha: head },
    review_complete: true, unresolved_review_count: 0, reviews: [], comments: [] };
  assert.equal(cloudReady(base), true);
  for (const mergeable of [null, false, undefined]) assert.equal(cloudReady({ ...base, mergeable }), false);
  const approved = { id: 'approved', state: 'APPROVED', commitOid: head, body: '' };
  assert.equal(validateSnapshot({ ...base, reviews: [approved] }).valid, true);
  const missingHead = { id: 'old-review', state: 'COMMENTED', body: 'fix' };
  assert.equal(validateSnapshot({ ...base, reviews: [missingHead] }).valid, false);
  assert.equal(evaluate(emptyCursors(), { ...base, reviews: [missingHead] }).decision, 'none');
  assert.equal(validateSnapshot({ ...base, comments: [{ body: 'fix' }] }).valid, false);
  assert.equal(validateSnapshot({ ...base, comments: [{ id: 'issue:undefined', body: 'fix' }] }).valid, false);
});

const snapshotBin = fileURLToPath(new URL('../deploy/wrappers/gh-snapshot.mjs', import.meta.url));

function snapshot(scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'ae-snapshot-'));
  try {
    const ghBin = join(directory, 'gh');
    writeFileSync(ghBin, '#!' + process.execPath + '\n' +
      '(' + fakeGh.toString() + ')(' + JSON.stringify(scenario) + ');\n', { mode: 0o700 });
    const result = spawnSync(process.execPath, [snapshotBin, 'acme', 'app', '7'], {
      encoding: 'utf8',
      env: { ...process.env, GH_BIN: ghBin, SNAPSHOT_CACHE_DIR: '', REQUIRED_CONTEXTS_FILE: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fakeGh(scenario) {
  const args = process.argv.slice(2);
  const head = 'a'.repeat(40);
  if (args[0] === 'pr') {
    process.stdout.write(JSON.stringify(scenario === 'no-required' ? [] : [{ name: 'verify' }]));
    process.exit(scenario === 'pending' ? 8 : scenario === 'failure' ? 1 : 0);
  }
  if (args[1] === 'graphql') {
    if (scenario === 'review-error') process.exit(1);
    const nodes = scenario === 'unresolved' ? [{ id: 'thread-1', isResolved: false, isOutdated: false, comments: { nodes: [{ body: 'fix regression', author: { login: 'reviewer' }, commit: { oid: head } }] } }] : [];
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false } } } } } }));
    return;
  }
  const endpoint = args.at(-1);
  let body;
  if (endpoint === 'user') body = { login: 'author' };
  else if (endpoint.endsWith('/pulls/7')) body = { state: 'open', draft: false, head: { sha: head }, labels: [], mergeable: true };
  else if (endpoint.includes('/check-runs')) body = { check_runs: [{ id: 1, name: 'verify', status: scenario === 'pending' ? 'in_progress' : 'completed', conclusion: scenario === 'failure' ? 'failure' : 'success', started_at: '2026-09-06T00:00:00Z', completed_at: '2026-09-06T00:01:00Z' }] };
  else if (endpoint.includes('/comments')) body = [{ id: 123, body: 'full feedback', user: { login: 'reviewer' } }];
  else body = [];
  process.stdout.write('HTTP/2.0 200 OK\n\n' + JSON.stringify(body));
}

test('snapshot discovers real required contexts and exposes complete review state', () => {
  const result = snapshot('green');
  assert.equal(result.ci.green, true);
  assert.deepEqual(result.ci.required, ['verify']);
  assert.equal(result.review_complete, true);
  assert.equal(result.unresolved_review_count, 0);
  assert.equal(result.draft, false);
  assert.deepEqual(result.comments.map((entry) => entry.id), ['review:123', 'issue:123']);
});

test('pending checks are not repair failures and required-check exit 8 is accepted', () => {
  const result = snapshot('pending');
  assert.equal(result.ci.green, false);
  assert.equal(result.ci.pending, true);
  assert.equal(result.ci.blocked, false);
});

test('failed checks carry failure detail and accept required-check exit 1', () => {
  const result = snapshot('failure');
  assert.equal(result.ci.pending, false);
  assert.match(result.ci.failing[0], /verify=failure/);
});

test('unknown requirements and incomplete reviews never look cloud-ready', () => {
  assert.equal(snapshot('no-required').ci.blocked, true);
  const incomplete = snapshot('review-error');
  assert.equal(incomplete.review_complete, false);
  assert.equal(incomplete.unresolved_review_count, null);
  assert.equal(snapshot('unresolved').unresolved_review_count, 1);
});

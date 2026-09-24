import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmPrOpen } from '../scripts/confirm-pr-open.mjs';

const head = 'a'.repeat(40);
const repo = 'xindong/mivo-canvas-plugin';
const input = { repo, branch: 'feat/example', head, now: '2026-09-08T08:00:00Z', ledgerVersion: 1, assignmentSeq: 0 };
const pr = { url: `https://github.com/${repo}/pull/1`, number: 1, state: 'OPEN', isDraft: false, headRefOid: head };
const success = [{ name: 'unit', bucket: 'pass', state: 'SUCCESS' }];

function fixture({ checks = success, status = 0, after, before, repo: fixtureRepo = repo } = {}) {
  const base = { url: `https://github.com/${fixtureRepo}/pull/1`, number: 1, state: 'OPEN', isDraft: false, headRefOid: head };
  const beforePr = before ?? base;
  const afterPr = after ?? base;
  const calls = [];
  let reads = 0;
  return { calls, runner: (_bin, args) => {
    calls.push(args);
    if (args[1] === 'checks') return { status, stdout: JSON.stringify(checks) };
    return { status: 0, stdout: JSON.stringify(reads++ === 0 ? beforePr : afterPr) };
  } };
}

test('Mivo handoff queries required checks and confirms the same OPEN head afterward', () => {
  const f = fixture();
  const receipt = confirmPrOpen({ ...input, runner: f.runner });
  assert.equal(receipt.headRefOid, head);
  assert.deepEqual(f.calls.map(args => args[1]), ['view', 'checks', 'view']);
  assert.ok(f.calls[1].includes('--required'));
});

test('missing, pending, failed, skipped, and unknown checks cannot release the local owner', () => {
  for (const checks of [[], null, [{ name: 'unit', bucket: 'pending', state: 'IN_PROGRESS' }],
    [{ name: 'unit', bucket: 'fail', state: 'FAILURE' }],
    [{ name: 'unit', bucket: 'skipping', state: 'SKIPPED' }],
    [{ name: 'unit', bucket: 'pass', state: 'UNKNOWN' }]]) {
    assert.throws(() => confirmPrOpen({ ...input, runner: fixture({ checks }).runner }), /CI/);
  }
  for (const status of [1, 8, null]) {
    assert.throws(() => confirmPrOpen({ ...input, runner: fixture({ status }).runner }), /CI/);
  }
});

test('head drift, closed PR, draft, or wrong PR identity prevent a green handoff receipt', () => {
  for (const after of [{ ...pr, headRefOid: 'b'.repeat(40) }, { ...pr, state: 'CLOSED' },
    { ...pr, isDraft: true }, { ...pr, number: 2 }]) {
    assert.throws(() => confirmPrOpen({ ...input, runner: fixture({ after }).runner }));
  }
  assert.throws(() => confirmPrOpen({ ...input, head: undefined, runner: fixture().runner }), /head SHA/);
  assert.throws(() => confirmPrOpen({ ...input, runner: fixture({ before: { ...pr, url: 'https://github.com/other/repo/pull/1' } }).runner }), /身份/);
});

test('non-Mivo PR confirmation also queries required checks and re-reads the same OPEN head', () => {
  const f = fixture({ repo: 'acme/app' });
  const receipt = confirmPrOpen({ ...input, repo: 'acme/app', runner: f.runner });
  assert.equal(receipt.headRefOid, head);
  assert.deepEqual(f.calls.map(args => args[1]), ['view', 'checks', 'view']);
  assert.ok(f.calls[1].includes('--required'));
});

test('non-Mivo missing, pending, failed, skipped, and unknown required checks cannot confirm OPEN', () => {
  const other = { ...input, repo: 'acme/app' };
  for (const checks of [[], null, [{ name: 'unit', bucket: 'pending', state: 'IN_PROGRESS' }],
    [{ name: 'unit', bucket: 'fail', state: 'FAILURE' }],
    [{ name: 'unit', bucket: 'skipping', state: 'SKIPPED' }],
    [{ name: 'unit', bucket: 'pass', state: 'UNKNOWN' }]]) {
    assert.throws(() => confirmPrOpen({ ...other, runner: fixture({ checks, repo: 'acme/app' }).runner }), /CI/);
  }
  for (const status of [1, 8, null]) {
    assert.throws(() => confirmPrOpen({ ...other, runner: fixture({ status, repo: 'acme/app' }).runner }), /CI/);
  }
});

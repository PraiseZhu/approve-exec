import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initLedger, readLedger } from '../scripts/run-ledger.mjs';
import { hashObject } from '../scripts/lib/common.mjs';
import { issueLeadSignal, validateLeadSignal, assertLeadSignalShape, readSenderRuntime } from '../scripts/pr-watch/lead-signal.mjs';
import { registerPr } from '../scripts/pr-watch/register.mjs';

const SHA = 'a'.repeat(40);
const NOW = '2026-09-06T10:04:00.000Z';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'ae-lead-signal-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, 'manifest.json');
  const source = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/sample-manifest.json', import.meta.url)), 'utf8'));
  writeFileSync(manifestPath, JSON.stringify(source));
  const ledgerPath = join(directory, 'ledger.json');
  initLedger({ ledgerPath, manifestPath, runId: 'signal-test', now: NOW, baseline: SHA });
  const ledger = readLedger(ledgerPath);
  const group = ledger.waves[0].groups[0];
  Object.assign(group, { state: 'pr-open', branch: 'fix/chain', base: SHA, tip_sha: SHA,
    session_id: 'owner-A', title: 'Skills-完整链路丨 0906', pr_url: 'https://github.com/PraiseZhu/approve-exec/pull/7' });
  group.review.unresolved = 0;
  const receipt = { url: group.pr_url, number: 7, headRefOid: SHA, isDraft: false, state: 'OPEN',
    branch: group.branch, checked_at: '2026-09-06T10:03:00.000Z', ledger_version: ledger.version, assignment_seq: 0 };
  const receiptPath = join(directory, 'pr-receipt.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const common = { group_id: group.group_id, assignment_seq: 0 };
  ledger.events.push(
    { type: 'delivery', at: '2026-09-06T10:00:00.000Z', detail: { ...common, branch: group.branch, tip_sha: SHA,
      e2e: { status: 'pass' }, size_gate: { result: 'PASS' },
      scs: group.sc_ids.map((id) => ({ id, status: 'pass' })) } },
    { type: 'local_validated', at: '2026-09-06T10:01:00.000Z', detail: { ...common, tip_sha: SHA, base: SHA, manifest_core_hash: ledger.manifest_core_hash } },
    { type: 'pr_opened', at: '2026-09-06T10:02:00.000Z', detail: { ...common, pr_url: group.pr_url, headRefOid: SHA } },
    { type: 'pr_ready', at: '2026-09-06T10:03:00.000Z', detail: { ...common, pr_url: group.pr_url, current_pr_head_sha: SHA, receipt: receiptPath } },
  );
  writeFileSync(ledgerPath, JSON.stringify(ledger));
  const claimDir = realpathSync(ledgerPath) + '.owners';
  mkdirSync(claimDir);
  const request = { message: 'lead session id=lead-A\nfull immutable handoff' };
  const claim = { status: 'bound', group_id: group.group_id, run_id: ledger.run_id, assignment_seq: 0,
    session_id: group.session_id, manifest_core_hash: ledger.manifest_core_hash, request, request_hash: hashObject(request) };
  const claimPath = join(claimDir, hashObject({ groupId: group.group_id }) + '.json');
  writeFileSync(claimPath, JSON.stringify(claim));
  const options = { ledgerPath, groupId: group.group_id, leadSessionId: 'lead-A', senderSessionId: 'lead-A', hostSessionId: 'lead-A', now: NOW };
  return { directory, options, ledger, group, claim, claimPath, receipt, receiptPath };
}

test('original task lead issues an evidence-bound idempotent signal', (context) => {
  const { options, directory } = fixture(context);
  const first = issueLeadSignal(options).signal;
  assert.equal(issueLeadSignal(options).signal.signal_id, first.signal_id);
  assert.equal(validateLeadSignal({ ...options, signal: first }).ok, true);
  const stateDir = join(directory, 'state');
  const registration = { stateDir, owner: 'PraiseZhu', repo: 'approve-exec', prNumber: 7,
    branch: 'fix/chain', pushRemote: 'origin', leadSignal: first };
  registerPr(registration);
  assert.doesNotThrow(() => registerPr(registration));
  assert.throws(() => registerPr({ ...registration, prNumber: 8 }), /不一致|不符/);
});

test('owner and another task lead cannot authorize this PR', (context) => {
  const { options } = fixture(context);
  for (const sender of ['owner-A', 'different-lead']) {
    assert.throws(() => issueLeadSignal({ ...options, leadSessionId: sender, senderSessionId: sender, hostSessionId: sender }), /原任务 lead|不得是 owner/);
  }
});

test('modified SC, old head and changed owner claim prevent registration', (context) => {
  const { options, ledger, group, claim, claimPath } = fixture(context);
  const signal = issueLeadSignal(options).signal;
  ledger.events.find((event) => event.type === 'delivery').detail.scs[0].status = 'fail';
  writeFileSync(options.ledgerPath, JSON.stringify(ledger));
  assert.throws(() => validateLeadSignal({ ...options, signal }), /全部 SC pass/);
  ledger.events.find((event) => event.type === 'delivery').detail.scs[0].status = 'pass';
  group.tip_sha = 'b'.repeat(40);
  writeFileSync(options.ledgerPath, JSON.stringify(ledger));
  assert.throws(() => validateLeadSignal({ ...options, signal }), /head/);
  group.tip_sha = SHA;
  writeFileSync(options.ledgerPath, JSON.stringify(ledger));
  claim.assignment_seq = 1;
  writeFileSync(claimPath, JSON.stringify(claim));
  assert.throws(() => validateLeadSignal({ ...options, signal }), /claim\/代次/);
});

test('PI and Claude leads can use actual Cindy runtime receipts', (context) => {
  const { options, directory } = fixture(context);
  const senderRuntimePath = join(directory, 'runtime.json');
  writeFileSync(senderRuntimePath, JSON.stringify({ ok: true, session_id: 'lead-A', generation: 3 }));
  const signal = issueLeadSignal({ ...options, hostSessionId: undefined, senderRuntimePath }).signal;
  assert.equal(signal.sender.identity_source, 'get_session_runtime');
  assert.equal(readSenderRuntime(senderRuntimePath), 'lead-A');
  writeFileSync(senderRuntimePath, JSON.stringify({ ok: true, session_id: 'somebody-else', generation: 3 }));
  assert.throws(() => validateLeadSignal({ ...options, signal, senderRuntimePath }), /sender/);
});

test('draft PR and altered signal payload fail closed', (context) => {
  const { options, receipt, receiptPath } = fixture(context);
  const signal = issueLeadSignal(options).signal;
  assert.throws(() => assertLeadSignalShape({ ...signal, owner_title: 'Skills-伪造任务丨 0906' }), /摘要/);
  receipt.isDraft = true;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => issueLeadSignal(options), /draft/);
});

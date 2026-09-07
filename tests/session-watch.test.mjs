import { test } from 'node:test';


test('Python production protocol binds queued session, then requires durable SC acknowledgement', (context) => {
  const stateDir = tmpState();
  const fixture = writeSnapshot(snapshot({ comments: [{ id: 'ci-comment', body: 'repair failing test' }] }));
  context.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(fixture.dir, { recursive: true, force: true }); });
  registerWatched(stateDir);
  const frames = [
    { protocol: 'cindy-script/1', type: 'start', context: { scheduleId: 'production-fixture' } },
    { protocol: 'cindy-script/1', type: 'call_result', id: 'py-1', ok: true, result: { status: 'queued', target_session_id: 'mini-protocol' } },
  ];
  const py = join(ROOT, 'scripts/pr-watch/session-watch-script.py');
  const runner = [
    'import importlib.util, types',
    'spec = importlib.util.spec_from_file_location("session_watch_script", ' + JSON.stringify(py) + ')',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.main(lambda: types.SimpleNamespace(nodename="PraisedeMac-mini.local"))',
  ].join('\n');
  const run = (input) => spawnSync('python3', ['-c', runner], {
    encoding: 'utf8', input: input.map((frame) => JSON.stringify(frame)).join('\n') + '\n', timeout: 10000,
    env: { ...process.env, CINDY_SCRIPT_PROTOCOL: '1', AE_WATCH_STATE_DIR: stateDir, AE_WATCH_SNAPSHOT_CMD: fixture.snapshotCmd },
  });
  const first = run(frames);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const messages = first.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(messages[0].method, 'sessions.dispatch');
  assert.equal(messages[0].params.title, OWNER_TITLE);
  const stateFile = join(stateDir, stateFileName('acme', 'app', 1));
  const pending = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(pending.session_id, 'mini-protocol');
  assert.equal(pending.cursors, null);
  assert.ok(messages[0].params.message.includes(pending.pending_dispatch.dispatch_id));
  const second = run(frames.slice(0, 1));
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(second.stdout.includes('"type": "call"'), false);
  const receipt = { dispatch_id: pending.pending_dispatch.dispatch_id, session_id: 'mini-protocol', head_sha: SHA,
    sc_receipt: { sc_id: 'sc-protocol', recorded_at: '2026-09-06T11:00:00.000Z' }, scs: [{ id: 'issue:ci-comment', verify: 'node --test' }] };
  mkdirSync(join(stateDir, 'receipts'));
  const receiptPath = join(stateDir, 'receipts', receipt.dispatch_id + '.json');
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const acknowledged = spawnSync(process.execPath, [join(ROOT, 'scripts/pr-watch/session-watch.mjs'), 'ack-received',
    '--state-dir', stateDir, '--owner', 'acme', '--repo', 'app', '--pr', '1', '--session-id', 'mini-protocol',
    '--dispatch-id', receipt.dispatch_id, '--head', SHA, '--receipt', '@' + receiptPath], { encoding: 'utf8' });
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  const acknowledgedState = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(acknowledgedState.pending_dispatch, null);
  const postFix = {
    dispatch_id: receipt.dispatch_id,
    session_id: 'mini-protocol',
    base_head_sha: SHA,
    head_sha: SHA,
    artifact_head_sha: SHA,
    no_changes: true,
    finalizer_entry: '/Users/praise/AI-Agent/Claude/capabilities/source/approve-exec-src/scripts/pr-watch/finalize.mjs',
    source_sc_digest: acknowledgedState.post_fix_pending[0].source_sc_digest,
    scs: [{ id: 'issue:ci-comment', status: 'pass', evidence: [{ id: 'issue:ci-comment' }] }],
  };
  const postFixPath = acknowledgedState.post_fix_pending[0].post_fix_receipt_path;
  writeFileSync(postFixPath, JSON.stringify({ ...postFix, source_sc_digest: 'bad' }));
  assert.throws(() => acknowledgePostFix({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, sessionId: 'mini-protocol', dispatchId: receipt.dispatch_id, headSha: SHA, receipt: { ...postFix, source_sc_digest: 'bad' } }), /digest/);
  writeFileSync(postFixPath, JSON.stringify({ ...postFix, scs: [{ id: 'issue:ci-comment', status: 'fail', evidence: [] }] }));
  assert.throws(() => acknowledgePostFix({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, sessionId: 'mini-protocol', dispatchId: receipt.dispatch_id, headSha: SHA, receipt: { ...postFix, scs: [{ id: 'issue:ci-comment', status: 'fail', evidence: [] }] } }), /SC source/);
  for (const evidence of [[null], [''], [{}]]) {
    const invalidPostFix = { ...postFix, scs: [{ id: 'issue:ci-comment', status: 'pass', evidence }] };
    writeFileSync(postFixPath, JSON.stringify(invalidPostFix));
    assert.throws(() => acknowledgePostFix({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, sessionId: 'mini-protocol', dispatchId: receipt.dispatch_id, headSha: SHA, receipt: invalidPostFix }), /SC source/);
  }
  writeFileSync(postFixPath, JSON.stringify(postFix));
  assert.doesNotThrow(() => acknowledgePostFix({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, sessionId: 'mini-protocol', dispatchId: receipt.dispatch_id, headSha: SHA, receipt: postFix }));
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).post_fix_pending, []);
});

import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerPr, stateFileName } from '../scripts/pr-watch/register.mjs';
import { hashObject } from '../scripts/lib/common.mjs';
import { loadMiniWatchConfig } from '../scripts/lib/mini-watch-config.mjs';
import {
  planDispatch,
  sessionsDispatchParams,
  scanWatch,
  applyWatchRound,
  preparePendingDispatch,
  acknowledgeReceived,
  acknowledgePostFix,
  claimCreate,
  releaseCreateClaim,
  MINI_WATCH_PROVIDER,
  OLD_WATCH_SCHEDULE_IDS,
  CREATE_CLAIM_TTL_MS,
  createClaimStale,
} from '../scripts/pr-watch/session-watch.mjs';
import { emptyCursors, evaluate } from '../scripts/pr-watch/gate.mjs';
import { validateLeadSignal } from '../scripts/pr-watch/gate.mjs';
import { acknowledgeTakeover, assertTakeover } from '../scripts/pr-watch/takeover.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);
const OWNER_TITLE = 'Project-App-任务丨 0906';
const CFG = loadMiniWatchConfig();

function tmpState() {
  return mkdtempSync(join(tmpdir(), 'ae-watch-'));
}

function leadSignal(headSha = SHA) {
  const unsigned = {
    version: 1,
    standing_authorization: 'PR_PUSH_AND_REPLY',
    group_id: 'group-1',
    repository: 'acme/app',
    pr_number: 1,
    pr_url: 'https://github.com/acme/app/pull/1',
    branch: 'feat/x',
    lead_session_id: 'lead-1',
    owner_session_id: 'owner-1',
    owner_title: OWNER_TITLE,
    head_sha: headSha,
    issued_at: '2026-09-06T10:00:00.000Z',
    ledger_version: 1,
    assignment_seq: 0,
    evidence: {
      pr_ready_event_at: '2026-09-06T09:00:00.000Z',
      pr_ready_digest: 'c'.repeat(64),
      local_validated_event_at: '2026-09-06T09:01:00.000Z',
      local_validated_digest: 'd'.repeat(64),
      pr_opened_event_at: '2026-09-06T09:02:00.000Z',
      pr_opened_digest: 'e'.repeat(64),
      pr_open_receipt_digest: 'f'.repeat(64),
      pr_state: 'OPEN',
      pr_is_draft: false,
      local_tip_sha: headSha,
      base: 'base-ref',
      manifest_core_hash: 'a'.repeat(64),
      execution_plan_hash: null,
    },
    sender: { session_id: 'lead-1', role: 'lead', identity_source: 'CODEX_SESSION_ID' },
  };
  return { ...unsigned, signal_id: hashObject(unsigned) };
}

function snapshot(overrides = {}) {
  return {
    state: 'open',
    head_sha: SHA,
    draft: false,
    ci: { green: true, pending: false, blocked: false, failing: [], head_sha: SHA },
    reviews: [],
    comments: [],
    labels: [],
    mergeable: true,
    review_complete: false,
    unresolved_review_count: 1,
    ...overrides,
  };
}

function writeSnapshot(snapshotValue) {
  const dir = tmpState();
  const file = join(dir, 'snapshot.json');
  const command = join(dir, 'snapshot.sh');
  writeFileSync(file, JSON.stringify(snapshotValue));
  writeFileSync(command, '#!/bin/sh\ncat "' + file + '"\n');
  chmodSync(command, 0o755);
  return { dir, file, command, snapshotCmd: command + ' {owner} {repo} {pr}' };
}

function registerWatched(stateDir, prNumber = 1, signal = leadSignal()) {
  const result = registerPr({
    stateDir,
    owner: 'acme',
    repo: 'app',
    prNumber,
    branch: 'feat/x',
    pushRemote: 'origin',
    registeredBy: 'test',
  });
  const state = JSON.parse(readFileSync(result.file, 'utf8'));
  state.lead_signal = { ...signal, pr_number: prNumber };
  writeFileSync(result.file, JSON.stringify(state));
  return result.file;
}

test('无有效 lead_signal 不派发并返回可见错误', () => {
  const stateDir = tmpState();
  registerPr({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test' });
  const fixture = writeSnapshot(snapshot({ comments: [{ id: '1', body: 'fix' }] }));
  const result = scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
  assert.equal(result.dispatches.length, 0);
  assert.match(result.errors[0].error, /lead_signal/);
});

test('lead signal 的 sender、evidence、hash 篡改均 fail-closed', () => {
  const valid = leadSignal();
  assert.equal(validateLeadSignal({ lead_signal: valid }).valid, true);
  const senderTampered = { ...valid, sender: { ...valid.sender, role: 'owner' } };
  const evidenceTampered = { ...valid, evidence: { ...valid.evidence, base: 'tampered' } };
  const hashTampered = { ...valid, signal_id: '0'.repeat(64) };
  for (const signal of [senderTampered, evidenceTampered, hashTampered]) {
    const result = validateLeadSignal({ lead_signal: signal });
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /完整校验失败/);
  }
});

test('lead signal 授权后派发包复用 owner title、携带 CI 与真实 worktree 入口', () => {
  const stateDir = tmpState();
  registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({
    ci: { green: false, pending: false, blocked: false, failing: [{ name: 'unit', url: 'ci://1' }], head_sha: SHA },
    comments: [{ id: '7', body: 'please fix', author_is_self: true }],
  }));
  const result = scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
  assert.equal(result.errors.length, 0);
  assert.equal(result.dispatches.length, 1);
  const plan = result.dispatches[0];
  assert.equal(plan.title, OWNER_TITLE);
  assert.equal(plan.branch, 'feat/x');
  assert.equal(plan.push_remote, 'origin');
  assert.equal(plan.head_sha, SHA);
  plan.dispatch_id = 'dispatch-test';
  const params = sessionsDispatchParams(plan);
  const lines = params.message.split('\n');
  assert.equal(lines.includes('--until-sc'), true);
  assert.equal(lines.includes('OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY'), true);
  assert.equal(lines.includes('DISPATCH_ID: dispatch-test'), true);
  assert.match(params.message, /PR_REPO: acme\/app/);
  assert.match(params.message, /PR_BRANCH: feat\/x/);
  assert.match(params.message, /PR_PUSH_REMOTE: origin/);
  assert.match(params.message, new RegExp('PR_HEAD_SHA: ' + SHA));
  assert.match(params.message, /ci failing\[\]/);
  assert.match(params.message, /issue:7/);
  assert.match(params.message, /prepare-worktree\.mjs --state-dir/);
  assert.match(params.message, new RegExp('--head ' + SHA));
  assert.match(params.message, /ARTIFACT_COMPLETION_RECEIPT_REQUIRED: head_sha/);
  assert.match(params.message, /artifact head_sha/);
  assert.match(params.message, /^用 goal skill 执行。$/m);
  assert.match(params.message, /kind: pr-fix/);
  assert.match(params.message, /从反馈提炼 SC/);
  assert.match(params.message, /\/Users\/praise\/AI-Agent\/Claude\/capabilities\/source\/approve-exec-src\/scripts\/pr-watch\/finalize\.mjs/);
  assert.match(params.message, /禁止直接 git push/);
});

test('同一 PR 首次 create、后续 jump，成功回执后只推进一次游标', () => {
  const stateDir = tmpState();
  registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ comments: [{ id: 'issue-1', body: 'fix' }] }));
  let calls = 0;
  const first = applyWatchRound({
    stateDir,
    snapshotCmd: fixture.snapshotCmd,
    gatewayAvailable: true,
    dispatchFn: (params) => {
      calls += 1;
      assert.equal(params.title, OWNER_TITLE);
      assert.equal(Object.prototype.hasOwnProperty.call(params, 'target_session_id'), false);
      return { status: 'completed', target_session_id: 'mini-1' };
    },
  });
  assert.equal(first.errors.length, 0);
  assert.equal(first.dispatches[0].action, 'create');
  const stateAfterCreate = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 1)), 'utf8'));
  assert.equal(stateAfterCreate.session_id, 'mini-1');
  assert.equal(stateAfterCreate.pending_dispatch.host_session_id, 'mini-1');
  assert.equal(stateAfterCreate.cursors, null);
  const dispatchId = stateAfterCreate.pending_dispatch.dispatch_id;
  mkdirSync(join(stateDir, 'receipts'), { recursive: true });
  writeFileSync(join(stateDir, 'receipts', dispatchId + '.json'), JSON.stringify({ dispatch_id: dispatchId,
    session_id: 'mini-1', head_sha: SHA, sc_receipt: { sc_id: 'sc-1' }, scs: [{ id: 'issue:issue-1', verify: 'node --test' }] }));
  acknowledgeReceived({
    stateDir,
    owner: 'acme',
    repo: 'app',
    prNumber: 1,
    sessionId: 'mini-1',
    dispatchId,
    headSha: SHA,
    receipt: {
      dispatch_id: dispatchId,
      session_id: 'mini-1',
      head_sha: SHA,
      sc_receipt: { sc_id: 'sc-1', recorded_at: '2026-09-06T11:00:00.000Z', head_sha: SHA },
    },
  });
  const stateAfterAck = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 1)), 'utf8'));
  assert.equal(stateAfterAck.pending_dispatch, null);
  assert.deepEqual(stateAfterAck.cursors.comment_ids, ['issue:issue-1']);
  const quiet = snapshot({ comments: [{ id: 'issue-1', body: 'fix' }] });
  writeFileSync(fixture.file, JSON.stringify(quiet));
  const second = applyWatchRound({
    stateDir,
    snapshotCmd: fixture.snapshotCmd,
    dispatchFn: () => {
      calls += 1;
      return { status: 'completed', target_session_id: 'mini-1' };
    },
  });
  assert.equal(second.dispatches.length, 0);
  assert.equal(calls, 1);
});

test('queued 回执写入 pending outbox、不推进游标，恢复轮次不重复 create', () => {
  const stateDir = tmpState();
  const stateFile = registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ comments: [{ id: 'issue-2', body: 'fix' }] }));
  let calls = 0;
  const first = applyWatchRound({
    stateDir,
    snapshotCmd: fixture.snapshotCmd,
    gatewayAvailable: true,
    dispatchFn: () => {
      calls += 1;
      return { status: 'queued', target_session_id: 'mini-queued' };
    },
  });
  assert.equal(first.dispatches.length, 1);
  assert.equal(first.dispatches[0].ack_pending, true);
  const pending = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(pending.pending_dispatch.status, 'queued');
  assert.deepEqual(pending.cursors, null);
  const second = applyWatchRound({
    stateDir,
    snapshotCmd: fixture.snapshotCmd,
    dispatchFn: () => {
      calls += 1;
      return { status: 'completed', target_session_id: 'duplicate' };
    },
  });
  assert.equal(second.dispatches.length, 0);
  assert.equal(calls, 1);
  assert.match(second.errors.at(-1).error, /未确认 outbox/);
  mkdirSync(join(stateDir, 'receipts'), { recursive: true });
  writeFileSync(join(stateDir, 'receipts', pending.pending_dispatch.dispatch_id + '.json'), JSON.stringify({ dispatch_id: pending.pending_dispatch.dispatch_id,
    session_id: 'mini-queued', head_sha: SHA, sc_receipt: { sc_id: 'sc-queued' }, scs: [{ id: 'issue:issue-2', verify: 'node --test' }] }));
  const completed = acknowledgeReceived({
    stateDir,
    owner: 'acme',
    repo: 'app',
    prNumber: 1,
    dispatchId: pending.pending_dispatch.dispatch_id,
    sessionId: 'mini-queued',
    headSha: SHA,
    receipt: {
      dispatch_id: pending.pending_dispatch.dispatch_id,
      session_id: 'mini-queued',
      head_sha: SHA,
      sc_receipt: { sc_id: 'sc-queued', recorded_at: '2026-09-06T11:00:00.000Z', head_sha: SHA },
    },
  });
  assert.equal(completed.acknowledged, true);
  const recovered = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(recovered.session_id, 'mini-queued');
  assert.equal(recovered.pending_dispatch, null);
  assert.deepEqual(recovered.cursors.comment_ids, ['issue:issue-2']);
});

test('SC receipt 必须精确覆盖反馈、ci-red 与 conflict，单条 SC 不得推进全部游标', () => {
  const stateDir = tmpState();
  registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({
    ci: { green: false, pending: false, blocked: false, failing: ['unit'], head_sha: SHA },
    mergeable: false,
    comments: [{ id: 'feedback-1', body: 'fix' }],
  }));
  const first = applyWatchRound({
    stateDir,
    snapshotCmd: fixture.snapshotCmd,
    gatewayAvailable: true,
    dispatchFn: () => ({ status: 'completed', target_session_id: 'mini-sc' }),
  });
  const stateFile = join(stateDir, stateFileName('acme', 'app', 1));
  const pending = JSON.parse(readFileSync(stateFile, 'utf8')).pending_dispatch;
  assert.deepEqual(pending.feedback_ids, ['issue:feedback-1', 'ci-red', 'conflict']);
  mkdirSync(join(stateDir, 'receipts'), { recursive: true });
  const partial = {
    dispatch_id: pending.dispatch_id,
    session_id: 'mini-sc',
    head_sha: SHA,
    sc_receipt: { sc_id: 'sc-partial', recorded_at: '2026-09-06T11:00:00.000Z' },
    scs: [{ id: 'issue:feedback-1', verify: 'node --test' }],
  };
  const receiptPath = join(stateDir, 'receipts', pending.dispatch_id + '.json');
  writeFileSync(receiptPath, JSON.stringify(partial));
  assert.throws(() => acknowledgeReceived({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, sessionId: 'mini-sc', dispatchId: pending.dispatch_id, headSha: SHA, receipt: partial }), /真实 SC 清单/);
  assert.ok(JSON.parse(readFileSync(stateFile, 'utf8')).pending_dispatch);
  const complete = {
    ...partial,
    sc_receipt: { ...partial.sc_receipt, sc_id: 'sc-complete' },
    scs: pending.feedback_ids.map((id) => ({ id, verify: 'node --test' })),
  };
  writeFileSync(receiptPath, JSON.stringify(complete));
  acknowledgeReceived({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, sessionId: 'mini-sc', dispatchId: pending.dispatch_id, headSha: SHA, receipt: complete });
  const acknowledged = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(acknowledged.pending_dispatch, null);
  assert.deepEqual(acknowledged.cursors.comment_ids, ['issue:feedback-1']);
  assert.equal(acknowledged.cursors.ci_red_key !== null, true);
  assert.equal(acknowledged.cursors.conflict_sha, SHA);
});

test('同一 PR 的并发 prepare 只保留一个 dispatch_id', () => {
  const stateDir = tmpState();
  registerWatched(stateDir);
  const pending = { action: 'create', owner: 'acme', repo: 'app', pr: 1, head_sha: SHA, signal_id: 'signal-' + SHA, title: OWNER_TITLE, next_cursors: { review_ids: [], comment_ids: ['issue:1'], ci_red_sha: null, ci_red_key: null, conflict_sha: null } };
  const first = preparePendingDispatch({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, pending });
  const second = preparePendingDispatch({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, pending: { ...pending, signal_id: 'different' } });
  assert.equal(first.prepared, true);
  assert.equal(second.prepared, false);
  assert.equal(second.pending.dispatch_id, first.pending.dispatch_id);
});

test('同一 head 不同 CI failing[] 仍产生新 ci-red，pending/blocked 显示错误且不派修代码', () => {
  const first = evaluate(emptyCursors(), snapshot({ ci: { green: false, pending: false, blocked: false, failing: ['a'], head_sha: SHA } }));
  const second = evaluate(first.cursors, snapshot({ ci: { green: false, pending: false, blocked: false, failing: ['b'], head_sha: SHA } }));
  assert.equal(first.signals.includes('ci-red'), true);
  assert.equal(second.signals.includes('ci-red'), true);
  const stateDir = tmpState();
  registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ ci: { green: false, pending: true, blocked: false, failing: [], head_sha: SHA }, comments: [{ id: 'pending', body: 'not enough data' }] }));
  const result = scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
  assert.equal(result.dispatches.length, 0);
  assert.match(result.errors.map((item) => item.error).join('\n'), /pending/);
});

test('cloud_ready 只由 OPEN、非 draft、CI 绿、review complete 且 unresolved 为零产生', () => {
  const stateDir = tmpState();
  registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ review_complete: true, unresolved_review_count: 0 }));
  const result = scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
  assert.equal(result.dispatches.length, 0);
  assert.equal(result.cloud_ready.length, 1);
  const state = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 1)), 'utf8'));
  assert.equal(state.cloud_ready.head_sha, SHA);
});

test('仅接收SC而未完成修复时不能标记 cloud_ready', (context) => {
  const stateDir = tmpState();
  const stateFile = registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ review_complete: true, unresolved_review_count: 0 }));
  context.after(() => { rmSync(stateDir, { recursive: true, force: true }); rmSync(fixture.dir, { recursive: true, force: true }); });
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.post_fix_pending = [{ dispatch_id: 'f'.repeat(24), base_head_sha: SHA, session_id: 'mini-1' }];
  state.cloud_ready = { head_sha: SHA };
  writeFileSync(stateFile, JSON.stringify(state));
  const result = scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
  assert.equal(result.cloud_ready.length, 0);
  assert.match(result.errors.map((entry) => entry.error).join(' '), /未完成反馈/);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).cloud_ready, null);
});

test('旧 cloud_ready 在新 head、CI 红、新反馈与取数失败时失效', () => {
  const stateDir = tmpState();
  const stateFile = registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ review_complete: true, unresolved_review_count: 0 }));
  scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
  writeFileSync(fixture.file, JSON.stringify(snapshot({
    head_sha: NEXT_SHA,
    ci: { green: false, pending: false, blocked: false, failing: ['unit'], head_sha: NEXT_SHA },
    review_complete: true,
    unresolved_review_count: 0,
  })));
  assert.equal(scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true }).dispatches.length, 1);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).cloud_ready, null);

  const feedbackStateDir = tmpState();
  const feedbackStateFile = registerWatched(feedbackStateDir);
  const feedbackFixture = writeSnapshot(snapshot({ review_complete: true, unresolved_review_count: 0 }));
  scanWatch({ stateDir: feedbackStateDir, snapshotCmd: feedbackFixture.snapshotCmd, gatewayAvailable: true });
  writeFileSync(feedbackFixture.file, JSON.stringify(snapshot({ review_complete: true, unresolved_review_count: 0, comments: [{ id: 'new-feedback', body: 'fix' }] })));
  assert.equal(scanWatch({ stateDir: feedbackStateDir, snapshotCmd: feedbackFixture.snapshotCmd, gatewayAvailable: true }).dispatches.length, 1);
  assert.equal(JSON.parse(readFileSync(feedbackStateFile, 'utf8')).cloud_ready, null);

  const failedStateDir = tmpState();
  const failedStateFile = registerWatched(failedStateDir);
  const failedFixture = writeSnapshot(snapshot({ review_complete: true, unresolved_review_count: 0 }));
  scanWatch({ stateDir: failedStateDir, snapshotCmd: failedFixture.snapshotCmd, gatewayAvailable: true });
  scanWatch({ stateDir: failedStateDir, snapshotCmd: '/bin/false {owner} {repo} {pr}', gatewayAvailable: true });
  assert.equal(JSON.parse(readFileSync(failedStateFile, 'utf8')).cloud_ready, null);
});

test('draft、首次 head 不符、缺正文与 host error 都返回 errors', () => {
  const cases = [
    { value: snapshot({ draft: true }), pattern: /draft/ },
    { value: snapshot({ head_sha: NEXT_SHA, ci: { green: true, pending: false, blocked: false, failing: [], head_sha: NEXT_SHA } }), pattern: /head_sha/ },
    { value: snapshot({ comments: [{ id: 'empty', body: '' }] }), pattern: /完整正文/ },
  ];
  for (const item of cases) {
    const stateDir = tmpState();
    registerWatched(stateDir);
    const fixture = writeSnapshot(item.value);
    const result = scanWatch({ stateDir, snapshotCmd: fixture.snapshotCmd, gatewayAvailable: true });
    assert.equal(result.dispatches.length, 0);
    assert.match(result.errors.map((error) => error.error).join('\n'), item.pattern);
  }
  const stateDir = tmpState();
  registerWatched(stateDir);
  const fixture = writeSnapshot(snapshot({ comments: [{ id: 'host', body: 'fix' }] }));
  const result = scanWatch({ stateDir, snapshotCmd: '/bin/false {owner} {repo} {pr}', gatewayAvailable: true });
  assert.equal(result.dispatches.length, 0);
  assert.ok(result.errors.length > 0);
});

test('派发实现不包含 merge，Python 入口复用 outbox ack 且引用 prepare-worktree', () => {
  const nodeSource = readFileSync(join(ROOT, 'scripts/pr-watch/session-watch.mjs'), 'utf8');
  const pythonSource = readFileSync(join(ROOT, 'scripts/pr-watch/session-watch-script.py'), 'utf8');
  assert.equal(nodeSource.includes('gh pr merge'), false);
  assert.equal(nodeSource.includes('prepare-worktree.mjs'), true);
  assert.equal(pythonSource.includes('prepare-dispatch'), true);
  assert.equal(pythonSource.includes('record-dispatch'), true);
  assert.equal(nodeSource.includes('ack-received'), true);
  assert.equal(pythonSource.includes('status='), true);
});

test('auto_merge=true 永远 fail-closed，Mini provider 与旧调度 blocklist 来自配置', () => {
  const state = { owner: 'o', repo: 'r', pr_number: 1, session_id: 'sess-1' };
  const config = { ...CFG, auto_merge: true };
  for (const decision of ['none', 'blocked-external', 'terminal']) {
    assert.throws(() => planDispatch({ decision, state, signals: [], newItems: {}, watchConfig: config }), /auto_merge=true/);
  }
  assert.equal(MINI_WATCH_PROVIDER, CFG.hosts.mini.provider_id);
  assert.deepEqual([...OLD_WATCH_SCHEDULE_IDS], CFG.old_schedule_ids_blocklist);
});

test('状态文件名编码保持身份单射，不把 slash/hash 直接写进文件名', () => {
  const first = stateFileName('mame/_', 'repo#1', 7);
  const second = stateFileName('mame/-', 'repo#1', 7);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /[\\/]/);
  assert.doesNotMatch(second, /[\\/]/);
});

test('claim 在途不自动回收，过期死亡 claim 仍 fail-closed', () => {
  const stateDir = tmpState();
  const stateFile = registerWatched(stateDir);
  const now = Date.now();
  const claim = {
    claim_id: 'old-claim',
    claimed_at: new Date(now - CREATE_CLAIM_TTL_MS - 1).toISOString(),
    owner_pid: 99999999,
  };
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, create_pending: true, create_claim: claim }));
  assert.equal(createClaimStale(claim, { nowMs: now }), true);
  assert.throws(() => claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, nowMs: now }), /已有 create 在途/);
  const second = releaseCreateClaim({ stateDir, owner: 'acme', repo: 'app', prNumber: 1, claimId: 'other' });
  assert.equal(second.create_claim.claim_id, 'old-claim');
});

test('takeover 只接受当前 schedule 与首扫回执，旧 schedule 被拒', () => {
  const stateDir = tmpState();
  registerWatched(stateDir);
  const firstScan = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 1)), 'utf8'));
  writeFileSync(join(stateDir, stateFileName('acme', 'app', 1)), JSON.stringify({ ...firstScan, first_scan_ack: '2026-09-06T10:00:00.000Z' }));
  const takeover = acknowledgeTakeover({ stateDir, owner: 'acme', repo: 'app', pr: 1, scheduleId: 'current-schedule', at: '2026-09-06T10:01:00.000Z' });
  assert.equal(takeover.schedule_id, 'current-schedule');
  assert.doesNotThrow(() => assertTakeover(takeover, { now: '2026-09-06T10:02:00.000Z' }));
  assert.throws(() => acknowledgeTakeover({ stateDir, owner: 'acme', repo: 'app', pr: 1, scheduleId: OLD_WATCH_SCHEDULE_IDS[0] }), /旧班车/);
});

test('Node CLI 与 Python script 入口可启动并显式完成空扫描', () => {
  const stateDir = tmpState();
  const node = spawnSync(process.execPath, [join(ROOT, 'scripts/pr-watch/session-watch.mjs'), '--state-dir', stateDir, '--snapshot-cmd', '/bin/false'], { encoding: 'utf8' });
  assert.equal(node.status, 0, node.stderr);
  assert.match(node.stdout, /"scanned":0/);
  const py = join(ROOT, 'scripts/pr-watch/session-watch-script.py');
  const runner = [
    'import importlib.util, types',
    'spec = importlib.util.spec_from_file_location("session_watch_script", ' + JSON.stringify(py) + ')',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.main(lambda: types.SimpleNamespace(nodename="PraisedeMac-mini.local"))',
  ].join('\n');
  const python = spawnSync('python3', ['-c', runner], {
    encoding: 'utf8',
    input: JSON.stringify({ protocol: 'cindy-script/1', type: 'start', context: { scheduleId: 'script-current', workingDir: stateDir } }) + '\n',
    env: { ...process.env, CINDY_SCRIPT_PROTOCOL: '1', AE_WATCH_STATE_DIR: stateDir, AE_WATCH_SNAPSHOT_CMD: '/bin/false' },
  });
  assert.equal(python.status, 0, python.stderr || python.stdout);
  assert.equal(JSON.parse(python.stdout.trim()).type, 'complete');
});

test('Python 生产入口校验 Mini hostname，测试只注入 uname 函数而不提供环境绕过', () => {
  const py = join(ROOT, 'scripts/pr-watch/session-watch-script.py');
  const code = [
    'import importlib.util, types',
    'spec = importlib.util.spec_from_file_location("session_watch_script", ' + JSON.stringify(py) + ')',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module._assert_mini_hostname(module._load_watch_config(), lambda: types.SimpleNamespace(nodename="wrong-host"))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Mini hostname/);
  assert.equal(CFG.hosts.mini.hostname, 'PraisedeMac-mini.local');
});

test('Python script 无 env 时使用 config 默认路径，已有 env 仍优先覆盖', () => {
  const py = join(ROOT, 'scripts/pr-watch/session-watch-script.py');
  const code = [
    'import importlib.util, json',
    'spec = importlib.util.spec_from_file_location("session_watch_script", ' + JSON.stringify(py) + ')',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'print(json.dumps(module._resolve_watch_paths(module._load_watch_config())))',
  ].join('\n');
  const baseEnv = { ...process.env };
  delete baseEnv.AE_WATCH_STATE_DIR;
  delete baseEnv.AE_WATCH_SNAPSHOT_CMD;
  const defaults = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: baseEnv });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout.trim()), [
    CFG.hosts.mini.state_dir,
    'node /Users/praise/AI-Agent/Claude/capabilities/source/skills/claude-active/approve-exec/deploy/wrappers/gh-snapshot.mjs {owner} {repo} {pr}',
  ]);

  const overrides = spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...baseEnv, AE_WATCH_STATE_DIR: '/tmp/override-state', AE_WATCH_SNAPSHOT_CMD: 'node /tmp/override-snapshot.mjs {owner}' },
  });
  assert.equal(overrides.status, 0, overrides.stderr);
  assert.deepEqual(JSON.parse(overrides.stdout.trim()), ['/tmp/override-state', 'node /tmp/override-snapshot.mjs {owner}']);
});

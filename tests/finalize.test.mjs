import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashObject } from '../scripts/lib/common.mjs';
import { stateFileName } from '../scripts/pr-watch/register.mjs';
import { FINALIZE_ENTRY, finalize } from '../scripts/pr-watch/finalize.mjs';
import { acknowledgePostFix } from '../scripts/pr-watch/session-watch.mjs';

const BASE = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const DISPATCH = '0123456789abcdef01234567';

function leadSignal() {
  const signal = { version: 1, standing_authorization: 'PR_PUSH_AND_REPLY', group_id: 'group-7',
    repository: 'acme/app', pr_number: 7, pr_url: 'https://github.com/acme/app/pull/7', branch: 'fix/pr-7',
    lead_session_id: 'lead-7', owner_session_id: 'owner-7', owner_title: '项目-修复丨 0906',
    head_sha: BASE, issued_at: '2026-09-06T10:00:00.000Z', ledger_version: 1, assignment_seq: 0,
    evidence: { pr_ready_event_at: '2026-09-06T09:03:00.000Z', pr_ready_digest: 'c'.repeat(64),
      local_validated_event_at: '2026-09-06T09:01:00.000Z', local_validated_digest: 'd'.repeat(64),
      pr_opened_event_at: '2026-09-06T09:02:00.000Z', pr_opened_digest: 'e'.repeat(64),
      pr_open_receipt_digest: 'f'.repeat(64), pr_state: 'OPEN', pr_is_draft: false,
      local_tip_sha: BASE, base: 'base-ref', manifest_core_hash: 'a'.repeat(64), execution_plan_hash: null },
    sender: { session_id: 'lead-7', role: 'lead', identity_source: 'CODEX_SESSION_ID' } };
  return { ...signal, signal_id: hashObject(signal) };
}

function fixture({ localHead = CANDIDATE, remoteHead = BASE, gh = {}, statePatch = {}, completionPatch = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ae-finalize-'));
  const stateDir = join(root, 'state');
  const worktree = join(root, 'worktree');
  const receipts = join(stateDir, 'receipts');
  mkdirSync(receipts, { recursive: true });
  mkdirSync(worktree);
  const sourcePath = join(receipts, DISPATCH + '.json');
  const postFixPath = join(receipts, DISPATCH + '.post-fix.json');
  const completionPath = join(root, 'completion.json');
  const source = {
    dispatch_id: DISPATCH,
    session_id: 'mini-7',
    head_sha: BASE,
    sc_receipt: { sc_id: 'sc-1', recorded_at: '2026-09-06T11:00:00.000Z' },
    scs: [{ id: 'sc-1', verify: 'node --test tests/finalize.test.mjs' }, { id: 'sc-2', verify: 'git status --porcelain' }],
  };
  writeFileSync(sourcePath, JSON.stringify(source));
  const completion = {
    dispatch_id: DISPATCH,
    session_id: 'mini-7',
    base_head_sha: BASE,
    artifact_head_sha: localHead,
    no_changes: localHead === BASE,
    scs: source.scs.map((entry) => ({ id: entry.id, status: 'PASS', evidence: ['verified ' + entry.id] })),
    ...completionPatch,
  };
  writeFileSync(completionPath, JSON.stringify(completion));
  const state = {
    lead_signal: leadSignal(),
    owner: 'acme',
    repo: 'app',
    pr_number: 7,
    branch: 'fix/pr-7',
    push_repo: 'acme/app',
    push_remote: 'origin',
    session_id: 'mini-7',
    worktree: { path: worktree, session_id: 'mini-7', branch: 'fix/pr-7', push_remote: 'origin', push_repo: 'acme/app' },
    post_fix_pending: [{
      dispatch_id: DISPATCH,
      session_id: 'mini-7',
      base_head_sha: BASE,
      feedback_ids: source.scs.map((entry) => entry.id),
      source_sc_path: sourcePath,
      source_sc_digest: hashObject(source),
      post_fix_receipt_path: postFixPath,
    }],
    ...statePatch,
  };
  writeFileSync(join(stateDir, stateFileName('acme', 'app', 7)), JSON.stringify(state));
  const calls = [];
  const control = { localHead, remoteHead, gh: { state: 'OPEN', isDraft: false, ...gh } };
  const runner = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'gh') {
      return JSON.stringify({
        state: control.gh.state,
        isDraft: control.gh.isDraft,
        headRefName: 'fix/pr-7',
        headRefOid: control.gh.headRefOid ?? control.remoteHead,
        headRepository: control.gh.headRepository ?? { nameWithOwner: 'acme/app' },
        headRepositoryOwner: control.gh.headRepositoryOwner ?? { login: 'acme' },
      });
    }
    if (args[0] === 'check-ref-format') return '';
    if (args.includes('rev-parse')) return control.localHead;
    if (args.includes('--show-current')) return 'fix/pr-7';
    if (args.includes('status')) return '';
    if (args.at(-1) === 'remote') return 'origin';
    if (args.includes('get-url')) return 'https://github.com/acme/app.git';
    if (args.includes('merge-base')) return '';
    if (args.includes('ls-remote')) return control.remoteHead + '\trefs/heads/fix/pr-7';
    if (args.includes('push')) { control.remoteHead = control.localHead; return ''; }
    return '';
  };
  return {
    root, stateDir, worktree, sourcePath, postFixPath, completionPath, state, source, calls, control, runner,
    options(extra = {}) {
      return { stateDir, owner: 'acme', repo: 'app', pr: 7, sessionId: 'mini-7', dispatchId: DISPATCH, feedbackHead: BASE, receipt: completionPath, run: runner, ...extra };
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('成功路径只通过注入 runner 普通 push，并落盘 post-fix receipt', () => {
  const env = fixture();
  try {
    const result = finalize(env.options());
    assert.equal(result.pushed, true);
    assert.equal(result.idempotent, false);
    const receipt = JSON.parse(readFileSync(env.postFixPath, 'utf8'));
    assert.equal(receipt.finalizer_entry, FINALIZE_ENTRY);
    assert.equal(receipt.dispatch_id, DISPATCH);
    assert.equal(receipt.session_id, 'mini-7');
    assert.equal(receipt.base_head_sha, BASE);
    assert.equal(receipt.artifact_head_sha, CANDIDATE);
    assert.equal(receipt.head_sha, CANDIDATE);
    assert.equal(receipt.no_changes, false);
    assert.equal(receipt.status, 'pass');
    assert.equal(receipt.sc_digest, env.state.post_fix_pending[0].source_sc_digest);
    assert.deepEqual(receipt.scs.map((entry) => [entry.id, entry.status]), [['sc-1', 'pass'], ['sc-2', 'pass']]);
    assert.ok(receipt.scs.every((entry) => entry.evidence.length > 0));
    const push = env.calls.find((command) => command.includes('push'));
    assert.deepEqual(push, ['git', '-C', env.worktree, 'push', 'origin', 'HEAD:refs/heads/fix/pr-7']);
    const acknowledged = acknowledgePostFix({ ...env.options(), prNumber: 7, headSha: CANDIDATE, receipt });
    assert.equal(acknowledged.state.post_fix_pending.length, 0);
    assert.equal(acknowledged.state.cloud_head_sha, CANDIDATE);
  } finally { env.cleanup(); }
});

test('same-head 合法 no-op，不创建空 commit', () => {
  const env = fixture({ localHead: BASE, remoteHead: BASE });
  try {
    const result = finalize(env.options());
    assert.equal(result.pushed, false);
    const receipt = JSON.parse(readFileSync(env.postFixPath, 'utf8'));
    assert.equal(receipt.no_changes, true);
    assert.equal(receipt.empty_commit, false);
    assert.equal(env.calls.some((command) => command.includes('push')), false);
    const acknowledged = acknowledgePostFix({ ...env.options(), prNumber: 7, headSha: BASE, receipt });
    assert.equal(acknowledged.state.post_fix_pending.length, 0);
  } finally { env.cleanup(); }
});

test('缺 state、缺 completion receipt 或错绑 worktree 均 fail-closed', () => {
  const missingState = fixture();
  try {
    rmSync(join(missingState.stateDir, stateFileName('acme', 'app', 7)));
    assert.throws(() => finalize(missingState.options()), /state 不存在/);
  } finally { missingState.cleanup(); }
  const missingReceipt = fixture();
  try {
    rmSync(missingReceipt.completionPath);
    assert.throws(() => finalize(missingReceipt.options()), /completion receipt 读取失败/);
  } finally { missingReceipt.cleanup(); }
  const wrongWorktree = fixture({ statePatch: { worktree: { path: '', session_id: 'other', branch: 'fix/pr-7', push_remote: 'origin', push_repo: 'acme/app' } } });
  try { assert.throws(() => finalize(wrongWorktree.options()), /worktree/); }
  finally { wrongWorktree.cleanup(); }
});

test('脏树、branch、push URL 错配均在 push 前拒绝', () => {
  for (const mode of ['dirty', 'branch', 'url']) {
    const env = fixture();
    const original = env.runner;
    env.runner = (file, args, options) => {
      if (mode === 'dirty' && args.includes('status')) return ' M file.js';
      if (mode === 'branch' && args.includes('--show-current')) return 'other';
      if (mode === 'url' && args.includes('get-url')) return 'https://github.com/other/app.git';
      return original(file, args, options);
    };
    try { assert.throws(() => finalize(env.options({ run: env.runner }))); }
    finally { env.cleanup(); }
  }
});

test('closed、draft、fork PR 均拒绝 push', () => {
  for (const gh of [{ state: 'CLOSED' }, { isDraft: true }, { headRepository: { nameWithOwner: 'fork/app' }, headRepositoryOwner: { login: 'fork' } }]) {
    const env = fixture({ gh });
    try { assert.throws(() => finalize(env.options()), /PR/); }
    finally { env.cleanup(); }
  }
});

test('SC 缺证据或集合不精确、远程 head 不匹配均拒绝', () => {
  const noEvidence = fixture({ completionPatch: { scs: [{ id: 'sc-1', status: 'PASS', evidence: [] }, { id: 'sc-2', status: 'PASS', evidence: ['ok'] }] } });
  try { assert.throws(() => finalize(noEvidence.options()), /evidence/); }
  finally { noEvidence.cleanup(); }
  const wrongIds = fixture({ completionPatch: { scs: [{ id: 'sc-1', status: 'PASS', evidence: ['ok'] }, { id: 'other', status: 'PASS', evidence: ['ok'] }] } });
  try { assert.throws(() => finalize(wrongIds.options()), /集合/); }
  finally { wrongIds.cleanup(); }
  const wrongRemote = fixture({ remoteHead: OTHER, gh: { headRefOid: BASE } });
  try { assert.throws(() => finalize(wrongRemote.options()), /gh before|远程/); }
  finally { wrongRemote.cleanup(); }
});

test('禁止 force、merge、删除远端；post-fix receipt 幂等且 schema 稳定', () => {
  const env = fixture();
  try {
    finalize(env.options());
    const firstPushCount = env.calls.filter((command) => command.includes('push')).length;
    const second = finalize(env.options());
    assert.equal(second.idempotent, true);
    assert.equal(env.calls.filter((command) => command.includes('push')).length, firstPushCount);
    assert.equal(env.calls.some((command) => command.includes('--force') || command.includes('delete') || command.includes('merge')), false);
    const receipt = JSON.parse(readFileSync(env.postFixPath, 'utf8'));
    for (const key of ['finalizer_entry', 'dispatch_id', 'session_id', 'base_head_sha', 'artifact_head_sha', 'head_sha', 'no_changes', 'status', 'sc_digest', 'scs']) assert.ok(Object.hasOwn(receipt, key), key);
  } finally { env.cleanup(); }
});

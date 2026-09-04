import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { registerPr, stateFileName } from '../scripts/pr-watch/register.mjs';
import {
  planDispatch, sessionsDispatchParams, scanWatch, bindSessionId, applyWatchRound, claimCreate, releaseCreateClaim,
  acknowledgeFirstScan,
  MINI_WATCH_PROVIDER, OLD_WATCH_SCHEDULE_IDS, CREATE_CLAIM_TTL_MS, createClaimStale,
} from '../scripts/pr-watch/session-watch.mjs';
import { emptyCursors } from '../scripts/pr-watch/gate.mjs';
import { loadMiniWatchConfig } from '../scripts/lib/mini-watch-config.mjs';

const SHA = 'a'.repeat(40);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = loadMiniWatchConfig();
const MERGE_BAN = /禁止调用 GitHub 合并/;

function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), 'ae-watch-'));
  return dir;
}

const AUTO_MERGE_TRUE = { ...CFG, auto_merge: true };
const AUTO_MERGE_STATE = { owner: 'o', repo: 'r', pr_number: 1, session_id: 'sess-1' };

test('planDispatch: auto_merge=true 时 decision=none 必须抛，不得返回 null', () => {
  let returned;
  assert.throws(
    () => {
      returned = planDispatch({
        decision: 'none', state: AUTO_MERGE_STATE, signals: [], newItems: {}, watchConfig: AUTO_MERGE_TRUE,
      });
    },
    /auto_merge=true/,
  );
  assert.equal(returned, undefined);
});

test('planDispatch: auto_merge=true 时 decision=blocked-external 必须抛，不得返回 null', () => {
  let returned;
  assert.throws(
    () => {
      returned = planDispatch({
        decision: 'blocked-external', state: AUTO_MERGE_STATE, signals: ['hold-label'], newItems: {}, watchConfig: AUTO_MERGE_TRUE,
      });
    },
    /auto_merge=true/,
  );
  assert.equal(returned, undefined);
});

test('planDispatch: auto_merge=true 时 decision=terminal 必须抛，不得返回 unregister', () => {
  let returned;
  assert.throws(
    () => {
      returned = planDispatch({
        decision: 'terminal', state: AUTO_MERGE_STATE, signals: ['merged'], newItems: {}, watchConfig: AUTO_MERGE_TRUE,
      });
    },
    /auto_merge=true/,
  );
  assert.equal(returned, undefined);
});

test('planDispatch: none / hold 不派；actionable 无 session_id 则 create', () => {
  const state = { owner: 'o', repo: 'r', pr_number: 1, session_id: null };
  assert.equal(planDispatch({ decision: 'none', state, signals: [], newItems: {} }), null);
  assert.equal(planDispatch({ decision: 'blocked-external', state, signals: ['hold-label'], newItems: {} }), null);
  const create = planDispatch({
    decision: 'actionable',
    state,
    signals: ['comment'],
    newItems: { comments: [{ id: 'c1', body: 'fix this' }] },
  });
  assert.equal(create.action, 'create');
  assert.equal(create.wake_kind, 'create');
  assert.equal(create.provider_id, CFG.hosts.mini.provider_id);
  assert.equal(create.provider_id, MINI_WATCH_PROVIDER);
  assert.equal(create.session_id, null);
  assert.equal(Object.prototype.hasOwnProperty.call(create, 'merge'), false);
  assert.match(create.title, /盯梢修复1丨 \d{4}$/);
  assert.doesNotMatch(create.title, /[#/]1 盯梢$/);
  assert.doesNotMatch(create.title, /o\/r#1/);
  const params = sessionsDispatchParams(create);
  assert.equal(Object.prototype.hasOwnProperty.call(params, 'target_session_id'), false);
  assert.match(params.message, MERGE_BAN);
  assert.doesNotMatch(params.message, /gh pr merge/);
});

test('planDispatch: 已有 session_id 则 jump，不 create', () => {
  const state = { owner: 'o', repo: 'r', pr_number: 1, session_id: 'sess-1' };
  const jump = planDispatch({
    decision: 'actionable',
    state,
    signals: ['review'],
    newItems: { reviews: [{ id: 'r1', body: 'nits' }] },
  });
  assert.equal(jump.action, 'jump');
  assert.equal(jump.wake_kind, 'jump');
  const params = sessionsDispatchParams(jump);
  assert.equal(params.target_session_id, 'sess-1');
});

test('planDispatch: terminal 只销册', () => {
  const term = planDispatch({
    decision: 'terminal',
    state: { owner: 'o', repo: 'r', pr_number: 9, session_id: 'sess-9' },
    signals: ['merged'],
    newItems: {},
  });
  assert.equal(term.action, 'unregister');
  assert.equal(Object.prototype.hasOwnProperty.call(term, 'merge'), false);
});

test('scanWatch: 无新信号零 dispatch；第二次同 PR 是 jump', () => {
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 7,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const snapDir = tmpState();
  const quiet = {
    state: 'open', head_sha: SHA,
    ci: { green: true, failing: [], head_sha: SHA },
    reviews: [], comments: [], labels: [], mergeable: true,
  };
  const snapFile = join(snapDir, 'snap.json');
  writeFileSync(snapFile, JSON.stringify(quiet));
  const snapSh = join(snapDir, 'snap.sh');
  writeFileSync(snapSh, `#!/bin/sh\ncat "${snapFile}"\n`);
  chmodSync(snapSh, 0o755);
  const quietScan = scanWatch({ stateDir, snapshotCmd: `${snapSh} {owner} {repo} {pr}` });
  assert.equal(quietScan.dispatches.length, 0);
  const acked = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 7)), 'utf8'));
  assert.ok(acked.first_scan_ack, '成功扫描必须写回首扫 ack');

  writeFileSync(snapFile, JSON.stringify({
    ...quiet,
    comments: [{ id: 'c1', body: 'please fix' }],
  }));
  const first = scanWatch({ stateDir, snapshotCmd: `${snapSh} {owner} {repo} {pr}` });
  assert.equal(first.dispatches.length, 1);
  assert.equal(first.dispatches[0].wake_kind, 'create');
  bindSessionId({ stateDir, owner: 'acme', repo: 'app', prNumber: 7, sessionId: 'sess-7' });
  const second = scanWatch({ stateDir, snapshotCmd: `${snapSh} {owner} {repo} {pr}` });
  assert.equal(second.dispatches[0].wake_kind, 'jump');
  assert.equal(second.dispatches[0].session_id, 'sess-7');
});

test('applyWatchRound: create 必须写回 session_id；缺返回值拒空跑；第二次 jump', () => {
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 8,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const snapDir = tmpState();
  const quiet = {
    state: 'open', head_sha: SHA,
    ci: { green: true, failing: [], head_sha: SHA },
    reviews: [], comments: [{ id: 'c1', body: 'please fix' }], labels: [], mergeable: true,
  };
  const snapFile = join(snapDir, 'snap.json');
  writeFileSync(snapFile, JSON.stringify(quiet));
  const snapSh = join(snapDir, 'snap.sh');
  writeFileSync(snapSh, `#!/bin/sh\ncat "${snapFile}"\n`);
  chmodSync(snapSh, 0o755);
  const snapshotCmd = `${snapSh} {owner} {repo} {pr}`;

  assert.throws(
    () => applyWatchRound({
      stateDir,
      snapshotCmd,
      dispatchFn: () => ({}),
    }),
    /未返回 target_session_id/,
  );
  const unbound = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 8)), 'utf8'));
  assert.equal(unbound.session_id, null, '空跑失败后不得写 session_id');

  const first = applyWatchRound({
    stateDir,
    snapshotCmd,
    dispatchFn: (params) => {
      assert.equal(Object.prototype.hasOwnProperty.call(params, 'target_session_id'), false);
      assert.match(params.message, MERGE_BAN);
      return { target_session_id: 'sess-8' };
    },
  });
  assert.equal(first.dispatches[0].wake_kind, 'create');
  assert.equal(first.dispatches[0].session_id, 'sess-8');
  const bound = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 8)), 'utf8'));
  assert.equal(bound.session_id, 'sess-8');
  assert.ok(bound.cursors.comment_ids.includes('c1'), 'create 成功后必须推进游标，避免同评重复 create');

  const second = applyWatchRound({
    stateDir,
    snapshotCmd,
    dispatchFn: (params) => {
      assert.equal(params.target_session_id, 'sess-8');
      return { target_session_id: 'sess-8' };
    },
  });
  assert.equal(second.dispatches.length, 0, '游标推进后同评不得再派');
});

test('python apply_watch_round: create 写回 session_id；缺客户端拒绝空跑', () => {
  const py = join(dirname(fileURLToPath(import.meta.url)), '../scripts/pr-watch/session-watch-script.py');
  const src = readFileSync(py, 'utf8');
  assert.ok(src.includes('apply_watch_round'));
  assert.ok(src.includes('未返回 target_session_id'));
  assert.ok(src.includes('协议客户端缺失，拒绝空跑'));
  assert.equal(src.includes('缺客户端就把清单打到 stderr'), false);
  assert.ok(existsSync(join(dirname(py), 'maker_client.py')));
  assert.ok(existsSync(join(dirname(py), 'protocol.py')));
  assert.ok(src.includes("sys.path.insert(0, str(HERE))"));
  assert.equal(src.includes('vendor'), false);
  assert.ok(src.includes('"--owner-pid"'), 'claim lease 必须绑定长驻 Python 进程，不得绑定短命 Node helper');

  const helper = `
import os, importlib.util
spec = importlib.util.spec_from_file_location('watch', ${JSON.stringify(py)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
state_dir = os.environ['AE_WATCH_STATE_DIR']
scan = {
  'scanned': 1,
  'dispatches': [{
    'action': 'create', 'owner': 'acme', 'repo': 'app', 'pr': 4,
    'title': 't', 'message': 'm', 'session_id': None,
  }],
  'terminals': [],
}
try:
  mod.apply_watch_round(lambda params: {}, scan=scan, claim_fn=lambda sd, plan: {'claimed': True, 'session_id': None}, release_fn=lambda *a, **k: None)
  raise SystemExit('should have failed')
except SystemExit as e:
  assert '未返回 target_session_id' in str(e)
bound = []
def dispatch(params):
  assert 'target_session_id' not in params
  return {'target_session_id': 'sess-4'}
out = mod.apply_watch_round(
  dispatch,
  scan=scan,
  bind_fn=lambda sd, plan, sid: bound.append((sd, plan['pr'], sid)),
  persist_fn=lambda *a, **k: None,
  unregister_fn=lambda *a, **k: None,
  claim_fn=lambda sd, plan: {'claimed': True, 'session_id': None},
  release_fn=lambda *a, **k: None,
)
assert bound == [(state_dir, 4, 'sess-4')]
assert out['dispatches'][0]['session_id'] == 'sess-4'
print('PY-OK')
`;
  const stateDir = tmpState();
  const r = spawnSync('python3', ['-c', helper], {
    encoding: 'utf8',
    env: { ...process.env, AE_WATCH_STATE_DIR: stateDir },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /PY-OK/);
});

test('claimCreate: 并发第二轮不得再 create', () => {
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 5,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const first = claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 5 });
  assert.equal(first.claimed, true);
  assert.throws(
    () => claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 5 }),
    /已有 create 在途/,
  );
});

test('claimCreate: 崩溃遗留 claim 仅在租约过期且持有 pid 已死时回收', () => {
  const stateDir = tmpState();
  const { file } = registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 55,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const nowMs = Date.now();
  const oldClaim = {
    claim_id: 'crashed-claim',
    claimed_at: new Date(nowMs - CREATE_CLAIM_TTL_MS - 1).toISOString(),
    owner_pid: 99999999,
  };
  const stale = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...stale, create_pending: true, create_claim: oldClaim }));
  assert.equal(createClaimStale(oldClaim, { nowMs }), true);
  const recovered = claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 55, nowMs });
  assert.equal(recovered.claimed, true);
  assert.notEqual(recovered.state.create_claim.claim_id, 'crashed-claim');
  assert.equal(recovered.state.create_claim.owner_pid, process.pid);
  const explicitDir = tmpState();
  registerPr({
    stateDir: explicitDir, owner: 'acme', repo: 'app', prNumber: 58,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const explicit = claimCreate({ stateDir: explicitDir, owner: 'acme', repo: 'app', prNumber: 58, ownerPid: 424242 });
  assert.equal(explicit.state.create_claim.owner_pid, 424242);
});

test('releaseCreateClaim: 旧 dispatch 的迟到失败不得清掉新 claim（ABA）', () => {
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 59,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const first = claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 59 });
  const firstId = first.state.create_claim.claim_id;
  releaseCreateClaim({ stateDir, owner: 'acme', repo: 'app', prNumber: 59, claimId: firstId });
  const second = claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 59 });
  const secondId = second.state.create_claim.claim_id;
  const late = releaseCreateClaim({ stateDir, owner: 'acme', repo: 'app', prNumber: 59, claimId: firstId });
  assert.equal(late.create_claim.claim_id, secondId);
  const done = releaseCreateClaim({ stateDir, owner: 'acme', repo: 'app', prNumber: 59, claimId: secondId });
  assert.equal(done.create_pending, false);
  assert.equal(done.create_claim, null);
});

test('claimCreate: 活进程 claim 即使超租约也不得抢占；旧 bool claim fail-closed', () => {
  const stateDir = tmpState();
  const { file } = registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 56,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const nowMs = Date.now();
  const oldLiveClaim = {
    claim_id: 'live-claim',
    claimed_at: new Date(nowMs - CREATE_CLAIM_TTL_MS - 1).toISOString(),
    owner_pid: process.pid,
  };
  const stale = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...stale, create_pending: true, create_claim: oldLiveClaim }));
  assert.equal(createClaimStale(oldLiveClaim, { nowMs }), false);
  assert.equal(createClaimStale({ ...oldLiveClaim, owner_pid: '99999999' }, { nowMs }), false);
  assert.throws(
    () => claimCreate({ stateDir, owner: 'acme', repo: 'app', prNumber: 56, nowMs }),
    /已有 create 在途/,
  );

  const legacyDir = tmpState();
  const legacy = registerPr({
    stateDir: legacyDir, owner: 'acme', repo: 'app', prNumber: 57,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const legacyState = JSON.parse(readFileSync(legacy.file, 'utf8'));
  writeFileSync(legacy.file, JSON.stringify({ ...legacyState, create_pending: true }));
  assert.throws(
    () => claimCreate({ stateDir: legacyDir, owner: 'acme', repo: 'app', prNumber: 57, nowMs }),
    /旧版 claim 缺少可安全恢复/,
  );
});

test('cindy-script stdin: start → sessions.dispatch → complete，create 写回 session_id', () => {
  const py = join(dirname(fileURLToPath(import.meta.url)), '../scripts/pr-watch/session-watch-script.py');
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 6,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const snapDir = tmpState();
  const snapFile = join(snapDir, 'snap.json');
  writeFileSync(snapFile, JSON.stringify({
    state: 'open', head_sha: SHA,
    ci: { green: true, failing: [], head_sha: SHA },
    reviews: [], comments: [{ id: 'c2', body: 'please fix' }], labels: [], mergeable: true,
  }));
  const snapSh = join(snapDir, 'snap.sh');
  writeFileSync(snapSh, `#!/bin/sh\ncat "${snapFile}"\n`);
  chmodSync(snapSh, 0o755);
  const stdin = [
    JSON.stringify({ protocol: 'cindy-script/1', type: 'start', context: { scheduleId: 'sched-1', workingDir: stateDir } }),
    JSON.stringify({ protocol: 'cindy-script/1', type: 'call_result', id: 'py-1', ok: true, result: { target_session_id: 'sess-6' } }),
  ].join('\n') + '\n';
  const r = spawnSync('python3', [py], {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      CINDY_SCRIPT_PROTOCOL: '1',
      AE_WATCH_STATE_DIR: stateDir,
      AE_WATCH_SNAPSHOT_CMD: `${snapSh} {owner} {repo} {pr}`,
    },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const frames = r.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(frames[0].type, 'call');
  assert.equal(frames[0].method, 'sessions.dispatch');
  assert.equal(Object.prototype.hasOwnProperty.call(frames[0].params, 'target_session_id'), false);
  assert.equal(frames[1].type, 'complete');
  assert.equal(frames[1].primarySessionId, 'sess-6');
  const bound = JSON.parse(readFileSync(join(stateDir, stateFileName('acme', 'app', 6)), 'utf8'));
  assert.equal(bound.session_id, 'sess-6');
  assert.ok(bound.first_scan_ack, 'script-mode 首扫必须写回 first_scan_ack');
});

test('acknowledgeFirstScan: 只补空值且身份不符 fail-closed', () => {
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 66,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const at = '2026-09-03T00:00:00.000Z';
  const first = acknowledgeFirstScan({ stateDir, owner: 'acme', repo: 'app', prNumber: 66, at });
  assert.equal(first.first_scan_ack, at);
  const second = acknowledgeFirstScan({ stateDir, owner: 'acme', repo: 'app', prNumber: 66, at: '2026-09-04T00:00:00.000Z' });
  assert.equal(second.first_scan_ack, at);
  writeFileSync(join(stateDir, stateFileName('acme', 'app', 66)), JSON.stringify({
    ...second, owner: 'other',
  }));
  assert.throws(
    () => acknowledgeFirstScan({ stateDir, owner: 'acme', repo: 'app', prNumber: 66, at }),
    /身份不符/,
  );
});

test('isMain: 路径含空格仍判定为主模块，不得静默空跑', () => {
  const repoRoot = dirname(fileURLToPath(import.meta.url)) === join(ROOT, 'tests')
    ? ROOT
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const spaceRoot = mkdtempSync(join(tmpdir(), 'Project Skills '));
  cpSync(join(repoRoot, 'scripts'), join(spaceRoot, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'config'), join(spaceRoot, 'config'), { recursive: true });
  const script = join(spaceRoot, 'scripts/pr-watch/session-watch.mjs');
  const r = spawnSync(process.execPath, [script, '--state-dir', tmpState(), '--snapshot-cmd', '/bin/false'], {
    encoding: 'utf8',
  });
  rmSync(spaceRoot, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /"scanned":/);
});

test('新注册带 session_id=null；不引用旧班车 id', () => {
  const stateDir = tmpState();
  const { file } = registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 3,
    branch: 'feat/y', pushRemote: 'origin',
  });
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(state.session_id, null);
  const src = readFileSync(new URL('../scripts/pr-watch/session-watch.mjs', import.meta.url), 'utf8');
  assert.equal(/spawnSync\([^)]*gh pr merge/.test(src), false);
  assert.equal(src.includes('schedule_resume'), false);
  assert.ok(src.includes('禁止调用 GitHub 合并'));
  assert.ok(src.includes('OLD_WATCH_SCHEDULE_IDS'));
  assert.deepEqual([...OLD_WATCH_SCHEDULE_IDS], CFG.old_schedule_ids_blocklist);
});

test('SC-4: fixture none 零 dispatch；第一次 create 读配置 provider；第二次 jump；terminal 只 unregister',
() => {
  const stateDir = tmpState();
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 11,
    branch: 'feat/x', pushRemote: 'origin', registeredBy: 'test',
  });
  const snapDir = tmpState();
  const quiet = {
    state: 'open', head_sha: SHA,
    ci: { green: true, failing: [], head_sha: SHA },
    reviews: [], comments: [], labels: [], mergeable: true,
  };
  const snapFile = join(snapDir, 'snap.json');
  writeFileSync(snapFile, JSON.stringify(quiet));
  const snapSh = join(snapDir, 'snap.sh');
  writeFileSync(snapSh, `#!/bin/sh\ncat "${snapFile}"\n`);
  chmodSync(snapSh, 0o755);
  const snapshotCmd = `${snapSh} {owner} {repo} {pr}`;

  const noneScan = scanWatch({ stateDir, snapshotCmd });
  assert.equal(noneScan.dispatches.length, 0, 'fixture none 必须零 dispatch');
  assert.equal(noneScan.terminals.length, 0);

  writeFileSync(snapFile, JSON.stringify({
    ...quiet,
    comments: [{ id: 'c-sc4', body: 'please fix' }],
  }));
  const first = applyWatchRound({
    stateDir,
    snapshotCmd,
    dispatchFn: (params) => {
      assert.equal(Object.prototype.hasOwnProperty.call(params, 'target_session_id'), false);
      assert.match(params.message, MERGE_BAN);
      assert.doesNotMatch(params.message, /gh pr merge/);
      return { target_session_id: 'sess-sc4' };
    },
  });
  assert.equal(first.dispatches.length, 1);
  assert.equal(first.dispatches[0].action, 'create');
  assert.equal(first.dispatches[0].wake_kind, 'create');
  assert.equal(first.dispatches[0].provider_id, CFG.hosts.mini.provider_id);
  assert.equal(first.dispatches[0].provider_id, 'super-grok');
  assert.equal(Object.prototype.hasOwnProperty.call(first.dispatches[0], 'merge'), false);

  writeFileSync(snapFile, JSON.stringify({
    ...quiet,
    comments: [
      { id: 'c-sc4', body: 'please fix' },
      { id: 'c-sc4b', body: 'still broken' },
    ],
  }));
  const second = applyWatchRound({
    stateDir,
    snapshotCmd,
    dispatchFn: (params) => {
      assert.equal(params.target_session_id, 'sess-sc4');
      return { target_session_id: 'sess-sc4' };
    },
  });
  assert.equal(second.dispatches.length, 1);
  assert.equal(second.dispatches[0].wake_kind, 'jump');
  assert.equal(second.dispatches[0].action, 'jump');

  writeFileSync(snapFile, JSON.stringify({ ...quiet, state: 'merged' }));
  const calls = [];
  const term = applyWatchRound({
    stateDir,
    snapshotCmd,
    dispatchFn: (params) => {
      calls.push(['dispatch', params]);
      return {};
    },
    unregisterFn: (args) => {
      calls.push(['unregister', args]);
      return { removed: true };
    },
  });
  assert.equal(term.dispatches.length, 0, 'terminal 不得 dispatch');
  assert.equal(term.unregistered.length, 1);
  assert.equal(term.unregistered[0].action, 'unregister');
  assert.equal(calls.some((c) => c[0] === 'dispatch'), false);
  assert.equal(calls.filter((c) => c[0] === 'unregister').length, 1);
  const closedSnap = { ...quiet, state: 'closed' };
  writeFileSync(snapFile, JSON.stringify(closedSnap));
  registerPr({
    stateDir, owner: 'acme', repo: 'app', prNumber: 12,
    branch: 'feat/z', pushRemote: 'origin', registeredBy: 'test',
  });
  const closed = scanWatch({ stateDir, snapshotCmd });
  assert.ok(closed.terminals.every((t) => t.action === 'unregister'));
  assert.equal(closed.dispatches.length, 0);
});

test('SC-4: scripts/pr-watch/ 不得出现 gh pr merge 字面量', () => {
  const dir = join(ROOT, 'scripts/pr-watch');
  const hits = [];
  for (const file of walkFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes('gh pr merge')) hits.push(file);
  }
  assert.deepEqual(hits, [], `scripts/pr-watch/ 不得含 gh pr merge: ${hits.join(', ')}`);
});

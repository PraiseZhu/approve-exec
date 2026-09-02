// decision-broker 独立 journal / 资格门 / 配额 / CAS / T1 事后闸。
// 不碰 graph / routing / defaults / 执行台账 events。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnv } from '../scripts/run-tests.mjs';
import {
  assertEligibility,
  openDecision,
  requestEvidence,
  attachEvidence,
  resolveDecision,
  computeContextHash,
  computeDecisionKey,
  computeBundleHash,
  decisionPacketBanner,
  readDecisionConfig,
} from '../scripts/decision-broker.mjs';
import { LedgerError } from '../scripts/run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/decision-broker.mjs');
const NOW = '2026-08-24T00:00:00.000Z';
const HEAD = 'a'.repeat(40);
const MANIFEST = 'b'.repeat(64);

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sampleRequest(overrides = {}) {
  const base = {
    origin: 'grok_user_choice',
    original_question: '若无代理，grok 将停下来问用户：波 1 先合 A 还是先合 B？',
    why_autonomy_cannot_choose: '两套包分类都合法，规则不能唯一决定',
    human_exclusive: false,
    options: [
      { id: 'A', summary: '先合 A', consequences: 'B 延后一波' },
      { id: 'B', summary: '先合 B', consequences: 'A 延后一波' },
    ],
    constraints: ['不得改 CI', '不得越域'],
    active_scope: {
      run_id: 'run-dec-1',
      phase: 'running',
      wave: 1,
      groups: ['g4'],
      manifest_core_hash: MANIFEST,
      head_sha: HEAD,
    },
    handoff: {
      scene: 'E 自跑中，g4 已 dispatched',
      changes: 'no_changes',
      bottleneck: '波序二选一',
      process: 'init → identity → render-packet → dispatched',
      original_question: '若无代理，grok 将停下来问用户：波 1 先合 A 还是先合 B？',
      choice: { success: '选出唯一波序并继续 E' },
    },
  };
  return { ...base, ...overrides, active_scope: { ...base.active_scope, ...(overrides.active_scope || {}) }, handoff: { ...base.handoff, ...(overrides.handoff || {}) } };
}

function journalPath() {
  const dir = mkdtempSync(join(tmpdir(), 'decision-j-'));
  return { dir, path: join(dir, 'journal.json') };
}

function makeCleanRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'decision-wt-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: buildChildEnv(process.env) });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  git(['init', '-q', repo]);
  git(['config', 'user.email', 'dec@test.local']);
  git(['config', 'user.name', 'Dec']);
  writeFileSync(join(repo, 'keep.txt'), 'ok\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return repo;
}

function evidenceBundle(revision, items = [{ summary: 'wave1 integrated' }]) {
  return { revision, bundle_hash: computeBundleHash(items), items };
}

test('config 钉死 fable5/low/T1，且不进 defaults/routing', () => {
  const cfg = readDecisionConfig();
  assert.equal(cfg.model, 'claude-fable-5');
  assert.equal(cfg.effort, 'low');
  assert.equal(cfg.isolationLevel, 'T1');
  const defaults = JSON.parse(readFileSync(join(ROOT, 'config/defaults.json'), 'utf8'));
  assert.equal(defaults.fableDecision, undefined);
  assert.equal(defaults.decisionModel, undefined);
  const routing = JSON.parse(readFileSync(defaults.routingPath, 'utf8'));
  assert.equal(routing.decision, undefined);
  const graph = JSON.parse(readFileSync(join(ROOT, 'graph.json'), 'utf8'));
  assert.deepEqual(Object.keys(graph.phases).sort(), ['E', 'P', 'R', 'T', 'V']);
});

test('资格门：缺原问句 / 单选项 / 人独占 / 非 grok_user_choice / 禁入场句式均拒', () => {
  assert.throws(() => assertEligibility(sampleRequest({ original_question: ' ' })), /ELIGIBILITY|非空/);
  assert.throws(
    () => assertEligibility(sampleRequest({ options: [{ id: 'A', summary: 'x', consequences: 'y' }] })),
    /至少两个/,
  );
  assert.throws(
    () => assertEligibility(sampleRequest({ human_exclusive: true })),
    (err) => err instanceof LedgerError && err.code === 'HUMAN_EXCLUSIVE',
  );
  assert.throws(
    () => assertEligibility(sampleRequest({ origin: 'lead_curious' })),
    /grok_user_choice/,
  );
  assert.throws(
    () => assertEligibility(sampleRequest({
      original_question: '查一下资料',
      handoff: { original_question: '查一下资料' },
    })),
    /查资料/,
  );
  assert.throws(
    () => assertEligibility(sampleRequest({ handoff: { scene: '' } })),
    /handoff.scene 必须是非空字符串/,
  );
  assert.throws(
    () => assertEligibility(sampleRequest({ handoff: { scene: '   ' } })),
    /handoff.scene 必须是非空字符串/,
  );
  assert.throws(
    () => assertEligibility(sampleRequest({ handoff: { choice: {} } })),
    /handoff.choice 必须是非空对象/,
  );
});

test('open 成功计数配额；同 key 复用 lease 不再加配额', () => {
  const { dir, path } = journalPath();
  try {
    const first = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    assert.equal(first.reused, false);
    assert.match(first.packet, /禁止执行/);
    assert.equal(first.packet.includes(decisionPacketBanner()), true);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(journal.quota.per_run, 1);
    assert.equal(journal.quota.per_wave['1'], 1);
    assert.equal(journal.events.filter((e) => e.type === 'decision_opened').length, 1);
    assert.equal(journal.events[0].detail.group_id, null);
    const second = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    assert.equal(second.reused, true);
    assert.equal(second.decision_id, first.decision_id);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.quota.per_run, 1);
    assert.equal(after.events.filter((e) => e.type === 'decision_opened').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HEAD 变则 context_hash 变，另开一条并占配额', () => {
  const { dir, path } = journalPath();
  try {
    openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    const other = sampleRequest({ active_scope: { head_sha: 'c'.repeat(40) } });
    const opened = openDecision({ journalPath: path, now: NOW, request: other });
    assert.equal(opened.reused, false);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(journal.quota.per_run, 2);
    assert.equal(journal.requests[0].status, 'superseded');
    assert.equal(journal.requests[1].status, 'open');
    assert.notEqual(
      computeContextHash(sampleRequest().active_scope),
      computeContextHash(other.active_scope),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('每 wave 配额 2：第三次 open 拒且不落 opened', () => {
  const { dir, path } = journalPath();
  try {
    openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    openDecision({
      journalPath: path,
      now: NOW,
      request: sampleRequest({ original_question: '第二问', handoff: { original_question: '第二问' } }),
    });
    const before = readFileSync(path, 'utf8');
    assert.throws(
      () => openDecision({
        journalPath: path,
        now: NOW,
        request: sampleRequest({ original_question: '第三问', handoff: { original_question: '第三问' } }),
      }),
      (err) => err instanceof LedgerError && err.code === 'QUOTA',
    );
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve 缺 tools_used 拒；错 nonce 记 SUPERSEDED；过期不覆盖', () => {
  const { dir, path } = journalPath();
  const repo = makeCleanRepo();
  try {
    const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    assert.throws(
      () => resolveDecision({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        worktree: repo,
        result: {
          decision_id: opened.decision_id,
          handoff_hash: opened.handoff_hash,
          lease_nonce: opened.lease_nonce,
          selected_option_id: 'A',
          rationale: '选 A',
          residual: [],
        },
      }),
      /缺键: tools_used|tools_used 必须/,
    );
    assert.throws(
      () => resolveDecision({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        worktree: repo,
        result: {
          decision_id: opened.decision_id,
          handoff_hash: opened.handoff_hash,
          lease_nonce: 'deadbeef',
          selected_option_id: 'A',
          rationale: '选 A',
          residual: [],
          tools_used: [],
        },
      }),
      (err) => err instanceof LedgerError && err.code === 'DECISION_SUPERSEDED',
    );
    const mid = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(mid.requests[0].status, 'open');
    assert.ok(mid.events.some((e) => e.type === 'decision_superseded'));
    assert.throws(
      () => resolveDecision({
        journalPath: path,
        decisionId: opened.decision_id,
        now: '2026-08-25T00:00:01.000Z',
        worktree: repo,
        result: {
          decision_id: opened.decision_id,
          handoff_hash: opened.handoff_hash,
          lease_nonce: opened.lease_nonce,
          selected_option_id: 'A',
          rationale: '选 A',
          residual: [],
          tools_used: [],
        },
      }),
      (err) => err instanceof LedgerError && err.code === 'DECISION_SUPERSEDED',
    );
    const late = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(late.requests[0].status, 'superseded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('声称已核实但无 evidence_attached → ABUSE；有证据且零 diff 可 resolve', () => {
  const { dir, path } = journalPath();
  const repo = makeCleanRepo();
  try {
  const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
  assert.throws(
    () => resolveDecision({
      journalPath: path,
      decisionId: opened.decision_id,
      now: NOW,
      worktree: repo,
      optionIds: ['A', 'B'],
      result: {
        decision_id: opened.decision_id,
        handoff_hash: opened.handoff_hash,
        lease_nonce: opened.lease_nonce,
        selected_option_id: 'A',
        rationale: '我已核实选 A',
        residual: [],
        tools_used: ['Read'],
      },
    }),
    (err) => err instanceof LedgerError && err.code === 'ABUSE',
  );

  requestEvidence({
    journalPath: path,
    decisionId: opened.decision_id,
    now: NOW,
    query: { queries: ['只读查 wave 1 集成点'] },
  });
  attachEvidence({
    journalPath: path,
    decisionId: opened.decision_id,
    now: NOW,
    bundle: evidenceBundle(1, [{ summary: 'wave1 integrated' }]),
  });
  const ok = resolveDecision({
    journalPath: path,
    decisionId: opened.decision_id,
    now: NOW,
    worktree: repo,
    optionIds: ['A', 'B'],
    result: {
      decision_id: opened.decision_id,
      handoff_hash: opened.handoff_hash,
      lease_nonce: opened.lease_nonce,
      selected_option_id: 'B',
      rationale: '按证据选 B',
      residual: [],
      tools_used: [],
    },
  });
  assert.equal(ok.selected_option_id, 'B');
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(journal.requests[0].status, 'resolved');
  assert.deepEqual(
    journal.events.map((e) => e.type),
    ['decision_opened', 'evidence_requested', 'evidence_attached', 'decision_resolved'],
  );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worktree dirty → ABUSE 且交卷作废', () => {
  const { dir, path } = journalPath();
  const repo = makeCleanRepo();
  writeFileSync(join(repo, 'dirty.txt'), 'nope\n');
  try {

  const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
  assert.throws(
    () => resolveDecision({
      journalPath: path,
      decisionId: opened.decision_id,
      now: NOW,
      worktree: repo,
      result: {
        decision_id: opened.decision_id,
        handoff_hash: opened.handoff_hash,
        lease_nonce: opened.lease_nonce,
        selected_option_id: 'A',
        rationale: '选 A',
        residual: [],
        tools_used: [],
      },
    }),
    (err) => err instanceof LedgerError && err.code === 'ABUSE',
  );
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(journal.requests[0].status, 'abused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI check 绿；open/resolve 黑盒可用', () => {
  const chk = cli('check');
  assert.equal(chk.status, 0, chk.stderr);
  assert.match(chk.stdout, /claude-fable-5/);
  const dir = mkdtempSync(join(tmpdir(), 'decision-cli-'));
  const repo = makeCleanRepo();
  try {
    const path = join(dir, 'j.json');
    const reqFile = join(dir, 'req.json');
    writeFileSync(reqFile, JSON.stringify(sampleRequest()));
    const opened = cli('open', '--run-id', 'run-dec-1', '--now', NOW, '--request', `@${reqFile}`, '--journal', path);
    assert.equal(opened.status, 0, opened.stderr);
    const bannerAt = opened.stdout.indexOf('【决策席禁令】');
    assert.ok(bannerAt > 0, `open 应先打 JSON 再打禁令包文:\n${opened.stdout}`);
    const parsed = JSON.parse(opened.stdout.slice(0, bannerAt));
    const resFile = join(dir, 'res.json');
    writeFileSync(resFile, JSON.stringify({
      decision_id: parsed.decision_id,
      handoff_hash: parsed.handoff_hash,
      lease_nonce: parsed.lease_nonce,
      selected_option_id: 'A',
      rationale: '选 A',
      residual: [],
      tools_used: [],
    }));
    const skipped = cli('resolve', '--journal', path, '--decision-id', parsed.decision_id, '--now', NOW, '--result', `@${resFile}`);
    assert.equal(skipped.status, 2, skipped.stderr);
    assert.match(skipped.stderr, /必须携带 --worktree/);
    const resolved = cli(
      'resolve', '--journal', path, '--decision-id', parsed.decision_id,
      '--now', NOW, '--result', `@${resFile}`, '--worktree', repo,
    );
    assert.equal(resolved.status, 0, resolved.stderr);
    const shown = cli('show', '--journal', path);
    assert.equal(shown.status, 0, shown.stderr);
    const journal = JSON.parse(shown.stdout);
    assert.equal(journal.requests[0].status, 'resolved');
    assert.equal(journal.events.every((e) => e.detail.group_id === null), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI resolve 越界选项 C 拒；option_ids 已落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-opt-'));
  const repo = makeCleanRepo();
  try {
    const path = join(dir, 'j.json');
    const reqFile = join(dir, 'req.json');
    writeFileSync(reqFile, JSON.stringify(sampleRequest()));
    const opened = cli('open', '--run-id', 'run-dec-1', '--now', NOW, '--request', `@${reqFile}`, '--journal', path);
    assert.equal(opened.status, 0, opened.stderr);
    const parsed = JSON.parse(opened.stdout.slice(0, opened.stdout.indexOf('【决策席禁令】')));
    const resFile = join(dir, 'res.json');
    writeFileSync(resFile, JSON.stringify({
      decision_id: parsed.decision_id,
      handoff_hash: parsed.handoff_hash,
      lease_nonce: parsed.lease_nonce,
      selected_option_id: 'C',
      rationale: '选 C',
      residual: [],
      tools_used: [],
    }));
    const resolved = cli(
      'resolve', '--journal', path, '--decision-id', parsed.decision_id,
      '--now', NOW, '--result', `@${resFile}`, '--worktree', repo,
    );
    assert.equal(resolved.status, 2, resolved.stderr);
    assert.match(resolved.stderr, /不在选项集/);
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(journal.requests[0].option_ids, ['A', 'B']);
    assert.equal(journal.requests[0].status, 'open');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('旧 HEAD lease 在新 context open 后 resolve 必须 SUPERSEDED', () => {
  const { dir, path } = journalPath();
  const repo = makeCleanRepo();
  try {
    const first = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    openDecision({
      journalPath: path,
      now: NOW,
      request: sampleRequest({ active_scope: { head_sha: 'c'.repeat(40) } }),
    });
    assert.throws(
      () => resolveDecision({
        journalPath: path,
        decisionId: first.decision_id,
        now: NOW,
        worktree: repo,
        result: {
          decision_id: first.decision_id,
          handoff_hash: first.handoff_hash,
          lease_nonce: first.lease_nonce,
          selected_option_id: 'A',
          rationale: '选 A',
          residual: [],
          tools_used: [],
        },
      }),
      (err) => err instanceof LedgerError && err.code === 'DECISION_SUPERSEDED',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('rationale 声称已核实且 tools_used 空 → ABUSE', () => {
  const { dir, path } = journalPath();
  const repo = makeCleanRepo();
  try {
    const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    assert.throws(
      () => resolveDecision({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        worktree: repo,
        result: {
          decision_id: opened.decision_id,
          handoff_hash: opened.handoff_hash,
          lease_nonce: opened.lease_nonce,
          selected_option_id: 'A',
          rationale: '我已核实但没有证据',
          residual: [],
          tools_used: [],
        },
      }),
      (err) => err instanceof LedgerError && err.code === 'ABUSE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('attach 跳号 revision / 未 request 先 attach 均拒', () => {
  const { dir, path } = journalPath();
  try {
    const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    assert.throws(
      () => attachEvidence({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        bundle: evidenceBundle(99, []),
      }),
      (err) => err instanceof LedgerError && err.code === 'EVIDENCE',
    );
    requestEvidence({
      journalPath: path,
      decisionId: opened.decision_id,
      now: NOW,
      query: { queries: ['q1'] },
    });
    assert.throws(
      () => attachEvidence({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        bundle: evidenceBundle(99, []),
      }),
      /当前\+1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--now 非法日期 fail-closed，不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-now-'));
  try {
    const path = join(dir, 'j.json');
    const reqFile = join(dir, 'req.json');
    writeFileSync(reqFile, JSON.stringify(sampleRequest()));
    const opened = cli('open', '--run-id', 'run-dec-1', '--now', 'not-a-date', '--request', `@${reqFile}`, '--journal', path);
    assert.equal(opened.status, 2, opened.stderr);
    assert.match(opened.stderr, /NOW_REQUIRED|ISO/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve 省略 worktree → ABUSE，交卷不落盘', () => {
  const { dir, path } = journalPath();
  try {
    const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    assert.throws(
      () => resolveDecision({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        result: {
          decision_id: opened.decision_id,
          handoff_hash: opened.handoff_hash,
          lease_nonce: opened.lease_nonce,
          selected_option_id: 'A',
          rationale: '选 A',
          residual: [],
          tools_used: [],
        },
      }),
      (err) => err instanceof LedgerError && err.code === 'ABUSE' && /必须携带 worktree/.test(err.message),
    );
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(journal.requests[0].status, 'open');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bundle_hash 必须等于 sha256(canonical(items))，自报字符串拒', () => {
  const { dir, path } = journalPath();
  try {
    const opened = openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    requestEvidence({
      journalPath: path,
      decisionId: opened.decision_id,
      now: NOW,
      query: { queries: ['q1'] },
    });
    const items = [{ summary: 'wave1 integrated' }];
    assert.throws(
      () => attachEvidence({
        journalPath: path,
        decisionId: opened.decision_id,
        now: NOW,
        bundle: { revision: 1, bundle_hash: 'ev1', items },
      }),
      (err) => err instanceof LedgerError && err.code === 'EVIDENCE' && /bundle_hash 必须等于/.test(err.message),
    );
    const ok = attachEvidence({
      journalPath: path,
      decisionId: opened.decision_id,
      now: NOW,
      bundle: evidenceBundle(1, items),
    });
    assert.equal(ok.ok, true);
    assert.equal(computeBundleHash(items).length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal requests[] 按 REQUEST_RECORD_KEYS exact 落盘', () => {
  const { dir, path } = journalPath();
  try {
    openDecision({ journalPath: path, now: NOW, request: sampleRequest() });
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(journal.requests[0]).sort(), [
      'context_hash',
      'decision_id',
      'decision_key',
      'expires_at',
      'handoff_hash',
      'lease_nonce',
      'model_config_digest',
      'opened_at',
      'option_ids',
      'pending_evidence',
      'rationale',
      'residual',
      'revision',
      'selected_option_id',
      'status',
      'tools_used',
      'wave',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decision_key 含 context，不只是问句', () => {
  const a = computeDecisionKey({
    runId: 'r',
    manifestCoreHash: MANIFEST,
    phase: 'running',
    wave: 1,
    groups: ['g4'],
    originalQuestion: 'Q',
    options: [{ id: 'A' }],
    constraints: [],
    contextHash: 'ctx1',
  });
  const b = computeDecisionKey({
    runId: 'r',
    manifestCoreHash: MANIFEST,
    phase: 'running',
    wave: 1,
    groups: ['g4'],
    originalQuestion: 'Q',
    options: [{ id: 'A' }],
    constraints: [],
    contextHash: 'ctx2',
  });
  assert.notEqual(a, b);
});

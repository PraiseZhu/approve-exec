import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildManifest, runIntake, validateBrief, PROVENANCE_KIND, MANIFEST_SCHEMA } from '../scripts/context-intake.mjs';
import { LedgerError, initLedger, readLedger, manifestCoreHash, readManifest } from '../scripts/run-ledger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/context-intake.mjs');
const BASE = 'a'.repeat(40);
const NOW = '2026-09-23T08:00:00.000Z';

function pr(id, overrides = {}) {
  return {
    pr_id: id,
    title_cn: `存图补图修复${id}`,
    why: `${id}：复制 PNG 失败时仍提示已复制。`,
    how: `${id}：imageNodeClipboard 走 libraryClipboardPort.write，失败走 copyPngFailed。`,
    excerpts: [{ file: 'src/a.ts', line: 2, behavior: '当前吞掉写入失败' }],
    allowed_paths: [`src/${id}.ts`, `src/${id}.test.ts`],
    forbidden: [],
    scs: [{ id: `${id}-SC1`, kind: 'fix', change: '失败时报错', holds: '成功路径不变', expect: '单测转绿', anchor_paths: [`src/${id}.ts`] }],
    verify_cmds: [`npx vitest run src/${id}.test.ts`],
    needs_three_review: true,
    depends_on: [],
    ...overrides,
  };
}

function brief(overrides = {}) {
  return {
    schema: 'approve-exec-brief-v1',
    slug: 'mivo-copy-png-20260923',
    goal: '修复复制 PNG 失败误报',
    repo: 'xindong/mivo-canvas-plugin',
    base: BASE,
    source: { session_id: 'lead-1', approved_message: '批准执行', approved_at: NOW },
    prs: [pr('PR1')],
    ...overrides,
  };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'ctx-intake-'));
}

test('context-intake: 同形 manifest，过输入门，带 provenance 与顶层 scs', () => {
  const m = buildManifest(brief());
  assert.equal(m.schema_version, MANIFEST_SCHEMA);
  assert.equal(m.provenance.kind, PROVENANCE_KIND);
  assert.deepEqual(m.receipts, []);
  assert.equal(m.manifest_core_hash, manifestCoreHash(m));
  const pkt = m.dispatch.packets[0];
  for (const k of ['scs_inline', 'allowed_paths', 'verify_cmds', 'forbidden', 'submit_format', 'needs_three_review', 'why', 'how', 'excerpts']) {
    assert.ok(Object.hasOwn(pkt, k), `packet 缺 ${k}`);
  }
  assert.deepEqual(m.scs.map((s) => s.id), ['PR1-SC1']);
  assert.deepEqual(m.waves, [{ wave: 0, groups: [{ group_id: 'PR1', sc_ids: ['PR1-SC1'], worker_count: 1 }] }]);
});

test('context-intake: 产物能被 run-ledger init 建账（与 task-priority final 走同一下游）', () => {
  const dir = tmp();
  try {
    const out = runIntake({ briefPath: writeBrief(dir, brief()), outDir: join(dir, 'goal'), now: NOW });
    assert.equal(out.ok, true);
    readManifest(out.manifest_path);
    const ledgerPath = join(dir, 'ledger.json');
    initLedger({ ledgerPath, manifestPath: out.manifest_path, runId: 'ctx-run', now: NOW, baseline: BASE });
    const ledger = readLedger(ledgerPath);
    assert.equal(ledger.manifest_core_hash, out.manifest_core_hash);
    assert.deepEqual(ledger.waves[0].groups.map((g) => g.group_id), ['PR1']);
    const receipt = JSON.parse(readFileSync(out.receipt_path, 'utf8'));
    assert.equal(receipt.manifest_core_hash, out.manifest_core_hash);
    assert.equal(receipt.source.approved_message, '批准执行');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-intake: depends_on 分前后波；同波写同一文件拒；依赖成环拒', () => {
  const serial = buildManifest(brief({ prs: [pr('PR1'), pr('PR2', { depends_on: ['PR1'] })] }));
  assert.deepEqual(serial.waves.map((w) => w.groups.map((g) => g.group_id)), [['PR1'], ['PR2']]);
  const parallel = buildManifest(brief({ prs: [pr('PR1'), pr('PR2')] }));
  assert.deepEqual(parallel.waves.map((w) => w.groups.map((g) => g.group_id)), [['PR1', 'PR2']]);
  assert.throws(() => buildManifest(brief({ prs: [pr('PR1'), pr('PR2', { allowed_paths: ['src/PR1.ts'] })] })), /同波并行却写同一文件/);
  assert.throws(() => buildManifest(brief({ prs: [pr('PR1', { depends_on: ['PR2'] }), pr('PR2', { depends_on: ['PR1'] })] })), /无法分层/);
});

test('context-intake: 形状与语义 fail-closed', () => {
  assert.throws(() => validateBrief({ ...brief(), extra: 1 }), LedgerError);
  assert.throws(() => validateBrief(brief({ base: 'main' })), /40 位/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { title_cn: 'CopyPngFix' })] })), /汉字/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { how: 'x', why: 'x' })] })), /不得复制 why/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { allowed_paths: ['src/'] })] })), /allowed_paths/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { needs_three_review: undefined })] })), /needs_three_review/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { scs: [{ ...pr('PR1').scs[0], kind: 'probe' }] })] })), /probe/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1'), pr('PR2', { scs: pr('PR1').scs })] })), /全局重复/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { depends_on: ['PR9'] })] })), /不存在的 PR/);
  assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { excerpts: [] })] })), /excerpts/);
});

test('context-intake: --repo-dir 核摘录行号、npm script 与仓内路径', () => {
  const repo = tmp();
  try {
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'line1\nline2\n');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'vitest' } }));
    assert.doesNotThrow(() => validateBrief(brief({ prs: [pr('PR1', { verify_cmds: ['npm run test:unit', 'npx vitest run src/PR1.test.ts'] })] }), { repoDir: repo }));
    assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { verify_cmds: ['npm run test:e2e'] })] }), { repoDir: repo }), /不存在的 npm script: test:e2e/);
    assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { verify_cmds: ['node scripts/ci/missing.mjs'] })] }), { repoDir: repo }), /不存在、也不在本 PR 写域/);
    assert.throws(() => validateBrief(brief({ prs: [pr('PR1', { excerpts: [{ file: 'src/a.ts', line: 99, behavior: 'x' }] })] }), { repoDir: repo }), /行号超出/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('context-intake: 不覆盖 task-priority 产物；可覆盖自己上一版', () => {
  const dir = tmp();
  try {
    const out = join(dir, 'goal');
    mkdirSync(out);
    writeFileSync(join(out, 'task-manifest.json'), JSON.stringify({ schema_version: 1, receipts: [] }));
    const briefPath = writeBrief(dir, brief());
    assert.throws(() => runIntake({ briefPath, outDir: out, now: NOW }), /拒绝覆盖/);
    rmSync(join(out, 'task-manifest.json'));
    runIntake({ briefPath, outDir: out, now: NOW });
    assert.doesNotThrow(() => runIntake({ briefPath, outDir: out, now: NOW }));
    assert.throws(() => runIntake({ briefPath, outDir: out }), /--now/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-intake CLI: 成功 exit 0 出 JSON；坏 brief exit 2', () => {
  const dir = tmp();
  try {
    const ok = spawnSync(process.execPath, [SCRIPT, '--brief', writeBrief(dir, brief()), '--out-dir', join(dir, 'goal'), '--now', NOW], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const summary = JSON.parse(ok.stdout);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.waves, [['PR1']]);
    const bad = spawnSync(process.execPath, [SCRIPT, '--brief', writeBrief(dir, brief({ base: 'x' }), 'bad.json'), '--out-dir', join(dir, 'g2'), '--now', NOW], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /\[BRIEF\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeBrief(dir, obj, name = 'brief.json') {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

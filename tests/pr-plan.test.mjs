import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLedger, readLedger, readExecutionManifest, manifestCoreHash, assertLedgerSchema, noteEvent } from '../scripts/run-ledger.mjs';
import { compilePrPlan } from '../scripts/lib/pr-plan.mjs';
import { libraryManifests } from './fixtures/library-pr-manifests.mjs';
import { checkSite } from '../scripts/site-check.mjs';

function mapping(manifest, id = 'PR1') {
  return { schema_version: 'pr-map-v1', source_manifest_core_hash: manifestCoreHash(manifest), prs: [{ pr_id: id, source_groups: manifest.waves.flatMap(wave => wave.groups.map(group => group.group_id)) }] };
}

function fixture(context, manifest = libraryManifests()[0]) {
  const directory = mkdtempSync(join(tmpdir(), 'pr-plan-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, 'manifest.json');
  const prMapPath = join(directory, 'pr-map.json');
  const ledgerPath = join(directory, 'ledger.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(prMapPath, JSON.stringify(mapping(manifest)));
  return { directory, manifest, manifestPath, prMapPath, ledgerPath, runId: 'fixture', now: '2026-09-05T00:00:00Z', baseline: 'b'.repeat(40) };
}

test('six sanitized production-shaped manifests become six PRs with all 84 SCs', () => {
  const plans = libraryManifests().map((manifest, index) => compilePrPlan(manifest, mapping(manifest, 'PR' + (index + 1)), manifestCoreHash(manifest)));
  assert.equal(plans.flatMap(plan => plan.waves.flatMap(wave => wave.groups)).length, 6);
  const ids = plans.flatMap(plan => plan.dispatch.packets.flatMap(packet => packet.scs_inline.map(sc => sc.id)));
  assert.equal(ids.length, 84);
  assert.equal(new Set(ids).size, 84);
  assert.equal(ids.filter(id => id.startsWith('presubmit-total-lines-')).length, 4);
  for (const plan of plans) {
    assert.equal(plan.kind, 'pr-execution-plan');
    assert.equal(Object.hasOwn(plan, 'receipts'), false);
    assert.deepEqual(plan.dispatch.packets[0].stages.map(stage => stage.kind), ['probe', 'fix', 'verify']);
  }
});

test('new ledger preserves source bytes and detects mapping and source drift', context => {
  const input = fixture(context);
  const before = readFileSync(input.manifestPath, 'utf8');
  initLedger(input);
  const ledger = readLedger(input.ledgerPath);
  assert.equal(ledger.schema_version, 'pr-ledger-v2');
  assert.equal(ledger.waves.length, 1);
  assert.equal(ledger.waves[0].groups.length, 1);
  assert.equal(readExecutionManifest(ledger).scs.length, 14);
  assert.equal(readFileSync(input.manifestPath, 'utf8'), before);
  const changed = mapping(input.manifest, 'WRONG');
  writeFileSync(input.prMapPath, JSON.stringify(changed));
  assert.throws(() => readExecutionManifest(ledger), /PR_MAP_HASH_MISMATCH/);
  assert.throws(() => noteEvent({ ledgerPath: input.ledgerPath, now: input.now, event: 'pr_ready', detail: { group_id: 'PR1' } }), /PR_MAP_HASH_MISMATCH/);
  writeFileSync(input.prMapPath, JSON.stringify(mapping(input.manifest)));
  input.manifest.scs[0].holds = 'weakened';
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest));
  assert.throws(() => readExecutionManifest(ledger), /hash|HASH/);
});

test('phase-based final cannot silently start without explicit PR mapping', context => {
  const input = fixture(context);
  assert.throws(() => initLedger({ ...input, prMapPath: undefined }), /PR_MAPPING_REQUIRED/);
});

test('legacy ledger remains unchanged and cannot acquire a PR mapping', context => {
  const legacy = JSON.parse(readFileSync(new URL('./fixtures/sample-manifest.json', import.meta.url), 'utf8'));
  const input = fixture(context, legacy);
  initLedger({ ...input, prMapPath: undefined });
  const before = readFileSync(input.ledgerPath, 'utf8');
  const ledger = readLedger(input.ledgerPath);
  assert.deepEqual(readExecutionManifest(ledger), legacy);
  ledger.pr_plan = { map_path: input.prMapPath, map_hash: 'a'.repeat(64), plan_hash: 'b'.repeat(64) };
  assert.throws(() => assertLedgerSchema(ledger), /legacy ledger/);
  assert.throws(() => initLedger({ ...input, prMapPath: undefined }), /台账已存在/);
  assert.equal(readFileSync(input.ledgerPath, 'utf8'), before);
});

test('mapping rejects missing, duplicated, unknown groups and privilege fields', () => {
  const manifest = libraryManifests()[0];
  for (const edit of [
    map => map.prs[0].source_groups.pop(),
    map => map.prs[0].source_groups.push('p1'),
    map => map.prs[0].source_groups.push('missing'),
    map => { map.prs[0].allowed_paths = ['outside.js']; },
    map => { map.source_manifest_core_hash = 'f'.repeat(64); },
  ]) {
    const map = mapping(manifest); edit(map);
    assert.throws(() => compilePrPlan(manifest, map, manifestCoreHash(manifest)), /PR_PLAN/);
  }
});

test('source SCs and packet contents must match exactly, including failure and budget gates', () => {
  for (const mutate of [
    source => source.dispatch.packets[2].scs_inline.pop(),
    source => { source.dispatch.packets[0].scs_inline[0].holds = 'different'; },
    source => { source.scs[0].depends_on = ['missing']; },
    source => { source.scs[0].depends_on = [source.scs[1].id]; },
  ]) {
    const source = JSON.parse(JSON.stringify(libraryManifests()[0]));
    mutate(source);
    source.manifest_core_hash = manifestCoreHash(source);
    source.receipts[0].manifest_core_hash = source.manifest_core_hash;
    assert.throws(() => compilePrPlan(source, mapping(source), manifestCoreHash(source)), /PR_PLAN/);
  }
});

test('site preserves intra-PR ordering and stage-specific write scopes', () => {
  const manifest = libraryManifests()[0];
  manifest.dispatch.packets[2].allowed_paths = ['test.js'];
  manifest.manifest_core_hash = manifestCoreHash(manifest);
  manifest.receipts[0].manifest_core_hash = manifest.manifest_core_hash;
  const plan = compilePrPlan(manifest, mapping(manifest), manifestCoreHash(manifest));
  const report = { manifest_core_hash: manifest.manifest_core_hash, execution_plan_hash: plan.execution_plan_hash,
    cross_sc_edges: [], open_unknowns: [], per_sc: plan.scs.map(sc => ({ sc_id: sc.id, group_id: 'PR1', read_only: true, real_write_paths: [] })) };
  assert.equal(checkSite(plan, report).groups.length, 1);
  const verify = plan.scs.find(sc => sc.kind === 'verify');
  const entry = report.per_sc.find(sc => sc.sc_id === verify.id);
  entry.real_write_paths = ['README.md'];
  assert.throws(() => checkSite(plan, report), /阶段授权/);
  entry.real_write_paths = ['test.js'];
  assert.equal(checkSite(plan, report).ok, true);
  report.cross_sc_edges.push({ from: verify.id, to: plan.scs.find(sc => sc.kind === 'probe').id });
  assert.throws(() => checkSite(plan, report), /反序/);
  report.cross_sc_edges = [];
  report.execution_plan_hash = 'f'.repeat(64);
  assert.throws(() => checkSite(plan, report), /归属/);
});

test('explicit ownership keeps distinct PRs and contracts only cross-PR dependencies', () => {
  const [source, second] = libraryManifests();
  for (const sc of second.scs) sc.priority_id = 'PR1';
  for (const packet of second.dispatch.packets) packet.group_id += '-second';
  for (const wave of second.waves) {
    wave.wave += 3;
    for (const group of wave.groups) group.group_id += '-second';
  }
  source.scs.push(...second.scs);
  source.dispatch.packets.push(...second.dispatch.packets);
  source.waves.push(...second.waves);
  const seal = () => {
    source.manifest_core_hash = manifestCoreHash(source);
    source.receipts[0].manifest_core_hash = source.manifest_core_hash;
    return { schema_version: 'pr-map-v1', source_manifest_core_hash: source.manifest_core_hash, prs: [
      { pr_id: 'PR1', source_groups: ['p1', 'g1', 'v1'] },
      { pr_id: 'PR2', source_groups: ['p1-second', 'g1-second', 'v1-second'] } ] };
  };
  let plan = compilePrPlan(source, seal(), manifestCoreHash(source));
  assert.equal(plan.waves[0].groups.length, 2);
  const report = { manifest_core_hash: source.manifest_core_hash, execution_plan_hash: plan.execution_plan_hash, cross_sc_edges: [], open_unknowns: [],
    per_sc: plan.dispatch.packets.flatMap(packet => packet.scs_inline.map(sc => ({ sc_id: sc.id, group_id: packet.group_id, read_only: sc.kind !== 'fix', real_write_paths: sc.kind === 'fix' ? ['README.md'] : [] }))) };
  assert.throws(() => checkSite(plan, report), /共享写入文件/);
  second.scs.find(sc => sc.kind === 'probe').depends_on.push('PR1-acceptance');
  plan = compilePrPlan(source, seal(), manifestCoreHash(source));
  assert.deepEqual(plan.waves.map(wave => wave.groups.map(group => group.group_id)), [['PR1'], ['PR2']]);
});

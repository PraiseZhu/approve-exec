import { manifestCoreHash } from '../../scripts/run-ledger.mjs';

const rows = [
  [
    ["PR1-goal","fix",["PR1-baseline"]],
    ["PR1-a1","fix",["PR1-baseline"]],
    ["PR1-a2","fix",["PR1-baseline"]],
    ["PR1-a3","fix",["PR1-baseline"]],
    ["PR1-a4","fix",["PR1-baseline"]],
    ["PR1-baseline","probe",[]],
    ["presubmit-total-lines-PR1","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["PR1-security","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["PR1-mutation","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["PR1-docs","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["presubmit-size-PR1","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["presubmit-format-PR1","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["presubmit-intent-PR1","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]],
    ["PR1-acceptance","verify",["PR1-goal","PR1-a1","PR1-a2","PR1-a3","PR1-a4"]]
  ],
  [
    ["PR2-goal","fix",["PR2-baseline"]],
    ["PR2-a1","fix",["PR2-baseline"]],
    ["PR2-a2","fix",["PR2-baseline"]],
    ["PR2-a3","fix",["PR2-baseline"]],
    ["PR2-a4","fix",["PR2-baseline"]],
    ["PR2-baseline","probe",[]],
    ["presubmit-total-lines-PR2","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["PR2-security","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["PR2-mutation","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["PR2-docs","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["presubmit-size-PR2","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["presubmit-format-PR2","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["presubmit-intent-PR2","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]],
    ["PR2-acceptance","verify",["PR2-goal","PR2-a1","PR2-a2","PR2-a3","PR2-a4"]]
  ],
  [
    ["PR3-goal","fix",["PR3-baseline"]],
    ["PR3-a1","fix",["PR3-baseline"]],
    ["PR3-a2","fix",["PR3-baseline"]],
    ["PR3-a3","fix",["PR3-baseline"]],
    ["PR3-a4","fix",["PR3-baseline"]],
    ["PR3-baseline","probe",[]],
    ["presubmit-total-lines-PR3","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["PR3-security","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["PR3-mutation","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["PR3-docs","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["presubmit-size-PR3","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["presubmit-format-PR3","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["presubmit-intent-PR3","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]],
    ["PR3-acceptance","verify",["PR3-goal","PR3-a1","PR3-a2","PR3-a3","PR3-a4"]]
  ],
  [
    ["PR4-goal","fix",["PR4-baseline"]],
    ["PR4-a1","fix",["PR4-baseline"]],
    ["PR4-a2","fix",["PR4-baseline"]],
    ["PR4-a3","fix",["PR4-baseline"]],
    ["PR4-a4","fix",["PR4-baseline"]],
    ["PR4-baseline","probe",[]],
    ["PR4-security","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]],
    ["PR4-mutation","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]],
    ["PR4-docs","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]],
    ["presubmit-size-PR4","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]],
    ["presubmit-format-PR4","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]],
    ["presubmit-intent-PR4","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]],
    ["PR4-acceptance","verify",["PR4-goal","PR4-a1","PR4-a2","PR4-a3","PR4-a4"]]
  ],
  [
    ["PR5-goal","fix",["PR5-baseline"]],
    ["PR5-a1","fix",["PR5-baseline"]],
    ["PR5-a2","fix",["PR5-baseline"]],
    ["PR5-a3","fix",["PR5-baseline"]],
    ["PR5-a4","fix",["PR5-baseline"]],
    ["PR5-baseline","probe",[]],
    ["PR5-security","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]],
    ["PR5-mutation","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]],
    ["PR5-docs","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]],
    ["presubmit-size-PR5","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]],
    ["presubmit-format-PR5","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]],
    ["presubmit-intent-PR5","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]],
    ["PR5-acceptance","verify",["PR5-goal","PR5-a1","PR5-a2","PR5-a3","PR5-a4"]]
  ],
  [
    ["PR6-goal","fix",["PR6-baseline"]],
    ["PR6-a1","fix",["PR6-baseline"]],
    ["PR6-a2","fix",["PR6-baseline"]],
    ["PR6-a3","fix",["PR6-baseline"]],
    ["PR6-a4","fix",["PR6-baseline"]],
    ["PR6-a5","fix",["PR6-baseline"]],
    ["PR6-baseline","probe",[]],
    ["presubmit-total-lines-PR6","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["PR6-security","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["PR6-mutation","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["PR6-docs","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["presubmit-size-PR6","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["presubmit-format-PR6","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["presubmit-intent-PR6","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["PR6-acceptance","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]],
    ["PR6-release-evidence","verify",["PR6-goal","PR6-a1","PR6-a2","PR6-a3","PR6-a4","PR6-a5"]]
  ]
];

export function libraryManifests() {
  return rows.map((entries, index) => {
    const scs = entries.map(([id, kind, depends_on]) => ({ id, kind, depends_on, priority_id: 'PR' + (index + 1), granularity: 'assertion', change: 'Fixture ' + id, holds: 'Preserve the original invariant', expect: 'exit 0', anchor_paths: ['README.md'], verify: { cmd: 'node', args: ['-e', 'process.exit(0)'] }, preflight: { status: 'exists_not_run' } }));
    const pools = [['p1', 'probe'], ['g1', 'fix'], ['v1', 'verify']];
    const packets = pools.map(([group_id, kind]) => ({ group_id, scs_inline: scs.filter(sc => sc.kind === kind), allowed_paths: ['README.md'], forbidden: ['secrets/'], verify_cmds: ['node -e \"process.exit(0)\"'], submit_format: 'Report every SC with candidate SHA', instruction: 'Use the complete invariant set', needs_three_review: true }));
    const manifest = { schema_version: 'v1', slug: 'library-pr' + (index + 1), goal: 'One business PR', priorities: [{ id: 'PR' + (index + 1), title: 'Library repair', why: 'fixture', pr_split: { suggested_prs: 1, functional_pr: true } }], context_refs: [], scs, coverage: [], waves: packets.map((packet, position) => ({ wave: position + 1, groups: [{ group_id: packet.group_id, sc_ids: packet.scs_inline.map(sc => sc.id), worker_count: 1 }] })), dispatch: { capacity: 8, packets }, receipts: [] };
    manifest.manifest_core_hash = manifestCoreHash(manifest);
    manifest.receipts = [{ slug: manifest.slug, manifest_core_hash: manifest.manifest_core_hash, plan_hash: 'a'.repeat(64), recorded_at: '2026-09-05T00:00:00Z' }];
    return manifest;
  });
}

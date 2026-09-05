import { hashObject, normalizeRepoPath } from './common.mjs';

const fail = message => { throw new Error('PR_PLAN: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const exact = (value, keys) => {
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) fail('invalid object keys: ' + keys.join(','));
};
const unique = values => [...new Set(values)];
const sameIds = (left, right) => hashObject([...left].sort()) === hashObject([...right].sort());

function layers(ids, dependencies) {
  const remaining = new Set(ids);
  const completed = new Set();
  const result = [];
  for (const id of ids) for (const dependency of dependencies.get(id) ?? []) {
    if (!remaining.has(dependency)) fail('unknown dependency: ' + dependency);
  }
  while (remaining.size) {
    const ready = [...remaining].filter(id => [...(dependencies.get(id) ?? [])].every(dependency => completed.has(dependency))).sort();
    if (!ready.length) fail('dependency cycle');
    result.push(ready);
    for (const id of ready) { remaining.delete(id); completed.add(id); }
  }
  return result;
}

export function executionPlanHash(plan) {
  const { execution_plan_hash, ...content } = plan;
  return hashObject(content);
}

export function compilePrPlan(source, mapping, sourceHash) {
  exact(mapping, ['schema_version', 'source_manifest_core_hash', 'prs']);
  if (mapping.schema_version !== 'pr-map-v1' || mapping.source_manifest_core_hash !== sourceHash
    || source.manifest_core_hash !== sourceHash) fail('source hash mismatch');
  if (!source.receipts?.some(receipt => receipt.slug === source.slug && receipt.manifest_core_hash === sourceHash)) fail('source final receipt missing');
  if (!Array.isArray(mapping.prs) || !mapping.prs.length || !Array.isArray(source.scs) || !source.scs.length) fail('empty PR or SC list');
  const scById = new Map();
  const dependencies = new Map();
  for (const sc of source.scs) {
    if (!text(sc.id) || scById.has(sc.id) || !['probe', 'fix', 'verify', 'archive'].includes(sc.kind)
      || !Array.isArray(sc.depends_on ?? []) || !text(sc.verify?.cmd) || !Array.isArray(sc.verify?.args)
      || sc.verify.args.some(argument => typeof argument !== 'string')) fail('invalid SC: ' + sc.id);
    scById.set(sc.id, sc);
    dependencies.set(sc.id, sc.depends_on ?? []);
  }
  const scOrder = layers([...scById.keys()], dependencies).flat();
  const groups = new Map();
  const seenSc = new Set();
  const packets = source.dispatch?.packets;
  if (!Array.isArray(packets) || !Array.isArray(source.waves)) fail('missing phase groups');
  let previousWave = -1;
  for (const wave of source.waves) {
    if (!Number.isSafeInteger(wave.wave) || wave.wave <= previousWave || !wave.groups?.length) fail('invalid phase order');
    previousWave = wave.wave;
    for (const group of wave.groups) {
      if (!text(group.group_id) || groups.has(group.group_id) || !group.sc_ids?.length) fail('invalid phase group');
      const matches = packets.filter(packet => packet.group_id === group.group_id);
      if (matches.length !== 1) fail('missing or duplicate source packet');
      const packet = matches[0];
      if (!Array.isArray(packet.scs_inline) || !sameIds(group.sc_ids, packet.scs_inline.map(sc => sc.id))) fail('packet SC coverage differs');
      for (const sc of packet.scs_inline) {
        if (seenSc.has(sc.id) || !scById.has(sc.id) || hashObject(sc) !== hashObject(scById.get(sc.id))) fail('SC missing, duplicated or changed: ' + sc.id);
        seenSc.add(sc.id);
      }
      for (const field of ['allowed_paths', 'forbidden', 'verify_cmds']) {
        if (!Array.isArray(packet[field]) || packet[field].some(value => typeof value !== 'string')) fail('invalid packet ' + field);
      }
      if (packet.allowed_paths.some(path => !normalizeRepoPath(path).ok || path.endsWith('/'))) fail('invalid write path');
      if (!text(packet.submit_format) || typeof packet.needs_three_review !== 'boolean') fail('incomplete packet contract');
      const kinds = unique(packet.scs_inline.map(sc => sc.kind));
      if (kinds.length !== 1) fail('mixed source stage');
      groups.set(group.group_id, { group_id: group.group_id, wave: wave.wave, kind: kinds[0], packet, sc_ids: group.sc_ids });
    }
  }
  if (packets.length !== groups.size || !sameIds([...seenSc], [...scById.keys()])) fail('source SC coverage differs');
  const owners = new Map();
  const prs = new Map();
  for (const entry of mapping.prs) {
    exact(entry, ['pr_id', 'source_groups']);
    if (!text(entry.pr_id) || prs.has(entry.pr_id) || !Array.isArray(entry.source_groups) || !entry.source_groups.length) fail('invalid PR mapping');
    const stages = [];
    for (const id of entry.source_groups) {
      if (!groups.has(id) || owners.has(id)) fail('unknown or duplicated source group: ' + id);
      owners.set(id, entry.pr_id);
      stages.push(groups.get(id));
    }
    stages.sort((left, right) => left.wave - right.wave || left.group_id.localeCompare(right.group_id));
    if (!stages.some(stage => stage.kind === 'fix')) fail('probe/verify cannot be an independent PR');
    const rank = { probe: 0, fix: 1, verify: 2, archive: 3 };
    if (stages.some((stage, index) => index > 0 && rank[stage.kind] < rank[stages[index - 1].kind])) fail('stage order reversed');
    prs.set(entry.pr_id, stages);
  }
  if (owners.size !== groups.size) fail('unassigned source group');
  const groupBySc = new Map([...groups.values()].flatMap(group => group.sc_ids.map(id => [id, group])));
  const prDependencies = new Map([...prs.keys()].map(id => [id, new Set()]));
  for (const sc of source.scs) for (const dependency of sc.depends_on ?? []) {
    const before = groupBySc.get(dependency);
    const after = groupBySc.get(sc.id);
    if (before.group_id !== after.group_id && before.wave >= after.wave) fail('source dependency order reversed');
    const fromPr = owners.get(before.group_id);
    const toPr = owners.get(after.group_id);
    if (fromPr !== toPr) prDependencies.get(toPr).add(fromPr);
  }
  const prWaves = layers([...prs.keys()], prDependencies);
  const outputPackets = [...prs].map(([id, stages]) => {
    const owned = new Set(stages.flatMap(stage => stage.sc_ids));
    const scs = scOrder.filter(scId => owned.has(scId)).map(scId => scById.get(scId));
    return {
      group_id: id,
      scs_inline: scs,
      stages: stages.map(stage => ({ group_id: stage.group_id, kind: stage.kind, wave: stage.wave, sc_ids: scOrder.filter(scId => stage.sc_ids.includes(scId)), allowed_paths: stage.packet.allowed_paths, forbidden: stage.packet.forbidden })),
      allowed_paths: unique(stages.flatMap(stage => stage.packet.allowed_paths)).sort(),
      forbidden: unique(stages.flatMap(stage => stage.packet.forbidden)),
      verify_cmds: unique([...scs.map(sc => [sc.verify.cmd, ...sc.verify.args.map(argument => JSON.stringify(argument))].join(' ')), ...stages.flatMap(stage => stage.packet.verify_cmds)]),
      submit_format: unique(stages.map(stage => stage.packet.submit_format)).join('\n'),
      instruction: unique(stages.map(stage => stage.packet.instruction).filter(text)).join('\n'),
      needs_three_review: stages.some(stage => stage.packet.needs_three_review),
    };
  });
  const plan = {
    kind: 'pr-execution-plan', schema_version: 'pr-plan-v1', slug: source.slug, goal: source.goal,
    source_manifest_core_hash: sourceHash, pr_map_hash: hashObject(mapping),
    priorities: source.priorities, scs: source.scs,
    waves: prWaves.map((ids, index) => ({ wave: index + 1, groups: ids.map(id => ({ group_id: id, sc_ids: outputPackets.find(packet => packet.group_id === id).scs_inline.map(sc => sc.id), worker_count: 1 })) })),
    dispatch: { capacity: source.dispatch.capacity, packets: outputPackets },
  };
  plan.execution_plan_hash = executionPlanHash(plan);
  return plan;
}

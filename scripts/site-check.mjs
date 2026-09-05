#!/usr/bin/env node
// Read-only scout evidence is mandatory before dispatch. Never silently rewrite
// the final manifest: a conflict is returned to task-priority for a new final.
import { readFileSync } from 'node:fs';
import { hashObject, normalizeRepoPath, isMain, parseArgs } from './lib/common.mjs';
import { readManifest, manifestCoreHash, LedgerError } from './run-ledger.mjs';

export function checkSite(manifest, report) {
  const reject = (why) => { throw new LedgerError('SITE_REPLAN_REQUIRED', why + '；请重新汇总任务优先级，禁止直接派窗'); };
  if (report?.manifest_core_hash !== manifestCoreHash(manifest)) reject('现场报告未绑定当前 final manifest');
  if (!Array.isArray(report.per_sc) || !Array.isArray(report.cross_sc_edges)
    || !Array.isArray(report.open_unknowns)) reject('现场报告缺 per_sc/cross_sc_edges/open_unknowns');
  if (report.open_unknowns.length) reject('现场仍有未决问题，不允许把未知依赖当作可并行');
  const bySc = new Map();
  const groups = new Map();
  for (const wave of manifest.waves) for (const group of wave.groups) {
    if (groups.has(group.group_id)) reject('重复 PR group');
    const packet = manifest.dispatch.packets.find((p) => p.group_id === group.group_id);
    if (!packet) reject('PR 缺派工包');
    groups.set(group.group_id, { wave: wave.wave, writes: new Set(), packet });
    for (const id of group.sc_ids) {
      if (bySc.has(id)) reject('同一 SC 被派给多个 PR');
      bySc.set(id, { group: group.group_id, wave: wave.wave });
    }
  }
  const ids = new Set(manifest.scs.map((sc) => sc.id));
  if (ids.size !== manifest.scs.length || ids.size !== bySc.size || [...ids].some((id) => !bySc.has(id))) reject('SC 与 PR 分区不一致');
  const seen = new Set();
  for (const sc of report.per_sc) {
    const slot = bySc.get(sc.sc_id);
    if (!slot || seen.has(sc.sc_id) || (sc.group_id && sc.group_id !== slot.group)) reject('现场 SC/group 对不上 final');
    seen.add(sc.sc_id);
    if (!Array.isArray(sc.real_write_paths)) reject('缺真实写入路径');
    if (!sc.real_write_paths.length && sc.read_only !== true) reject('空写入路径必须明确 read_only=true');
    const group = groups.get(slot.group);
    for (const path of sc.real_write_paths) {
      if (!normalizeRepoPath(path).ok || !group.packet.allowed_paths.includes(path)) reject('真实写入路径超出本 PR 授权: ' + path);
      group.writes.add(path);
    }
  }
  if (seen.size !== ids.size) reject('现场报告漏 SC');
  const entries = [...groups];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const [a, left] = entries[i]; const [b, right] = entries[j];
    if (left.wave !== right.wave) continue;
    const common = [...left.writes].filter((path) => right.writes.has(path));
    if (common.length) reject('同波 PR ' + a + '/' + b + ' 共享写入文件: ' + common.join(','));
  }
  const edges = [...report.cross_sc_edges];
  for (const sc of manifest.scs) for (const dep of sc.depends_on ?? []) edges.push({ from: dep, to: sc.id });
  for (const edge of edges) {
    const from = bySc.get(edge.from); const to = bySc.get(edge.to);
    if (!from || !to) reject('依赖边引用未知 SC');
    if (from.group !== to.group && from.wave >= to.wave) reject('依赖必须先于下游 PR，不能同波或反序');
  }
  return { ok: true, site_hash: hashObject(report), manifest_core_hash: report.manifest_core_hash,
    groups: [...groups].map(([group_id, g]) => ({ group_id, wave: g.wave, real_write_paths: [...g.writes].sort() })) };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(checkSite(readManifest(args.manifest), JSON.parse(readFileSync(args.site, 'utf8')))));
  } catch (error) { console.error('site-check: ' + error.message); process.exitCode = 2; }
}

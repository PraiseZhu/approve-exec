import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLedger, setState, renderPacket, readLedger, manifestCoreHash, latestPrHandoffDelivery, latestGroupEvent } from '../scripts/run-ledger.mjs';
import { renderPrHandoff } from '../scripts/render-pr-handoff.mjs';
import { prepareOwner, bindOwner, retireOwner } from '../scripts/owner-dispatch.mjs';
import { ownerGate } from '../scripts/owner-gate.mjs';
import { checkSite } from '../scripts/site-check.mjs';
import { assertTakeover } from '../scripts/pr-watch/takeover.mjs';
import { miniWatchConfigSha256 } from '../scripts/lib/mini-watch-config.mjs';

const NOW = '2026-09-05T00:00:00Z';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-chain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo with spaces');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'feat/fixture', repo);
  writeFileSync(join(repo, 'README.md'), 'fixture original source\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const sha = git('-C', repo, 'rev-parse', 'HEAD');
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/sample-manifest.json', import.meta.url)), 'utf8'));
  const mp = join(dir, 'manifest.json');
  writeFileSync(mp, JSON.stringify(manifest));
  const ledgerPath = join(dir, 'ledger.json');
  initLedger({ ledgerPath, manifestPath: mp, runId: 'owner-fixture', now: NOW, baseline: sha });
  const identity = { worktree: repo, base: sha, branch: 'feat/fixture', title: 'Skills-独立负责验收丨 0905' };
  setState({ ledgerPath, group: 'g4', now: NOW, identity });
  const packet = manifest.dispatch.packets[0];
  const handoff = renderPrHandoff({ packet, identity, leadSessionId: 'lead-test', seq: 1,
    repo: 'Skills', title: identity.title, why: '派窗重试会重复创建', how: '绑定一次性派工记录和回执',
    excerpts: [{ file: 'README.md', line: 1, behavior: '测试初始内容' }] });
  const handoffPath = join(dir, 'handoff.md'); writeFileSync(handoffPath, handoff);
  const report = { manifest_core_hash: manifestCoreHash(manifest), cross_sc_edges: [], open_unknowns: [],
    per_sc: manifest.dispatch.packets.flatMap((p) => p.scs_inline.map((sc) => ({ sc_id: sc.id,
      group_id: p.group_id, read_only: p.allowed_paths.length === 0, real_write_paths: p.allowed_paths }))) };
  const sitePath = join(dir, 'site.json'); writeFileSync(sitePath, JSON.stringify(report));
  return { dir, repo, sha, manifest, report, ledgerPath, handoffPath, sitePath, groupId: 'g4', now: NOW };
}

test('两个独立进程同时 prepare：只能发放一个 create 请求', async (t) => {
  const f=fixture(t);
  const script=fileURLToPath(new URL('../scripts/owner-dispatch.mjs',import.meta.url));
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script,'prepare','--ledger',f.ledgerPath,'--group',f.groupId,
      '--handoff',f.handoffPath,'--site',f.sitePath,'--now',NOW],{timeout:15000});
    let out='',err='';
    child.stdout.on('data',data=>{out+=data;});
    child.stderr.on('data',data=>{err+=data;});
    child.on('error',reject);
    child.on('close',code=>resolve({code,out,err}));
  });
  const results=await Promise.all([run(),run()]);
  assert.deepEqual(results.map(r=>r.code).sort(),[0,2],JSON.stringify(results));
  assert.equal(JSON.parse(results.find(r=>r.code===0).out).action,'create_once');
  assert.match(results.find(r=>r.code===2).err,/禁止自动再次 create/);
});

test('skill owner 集成夹具: 单次派窗→模拟工具回执绑定→goal 闸→显式 bypass 路由闸', (t) => {
  const f = fixture(t);
  const request = prepareOwner(f);
  assert.equal(request.action, 'create_once');
  assert.equal(request.args.use_worktree, false, '复用已校验的隔离树，不让宿主另选基线');
  assert.ok(request.args.message.includes('SC 全文'));
  assert.throws(() => prepareOwner(f), /禁止自动再次 create/);
  assert.throws(() => bindOwner({ ...f, claimId: request.claim_id, result: {} }), /唯一 target/);
  const raw = { content: [{ type: 'text', text: JSON.stringify({ ok: true, targetSessionId: 'owner-fixture-id' }) }] };
  assert.equal(bindOwner({ ...f, claimId: request.claim_id, result: raw }).session_id, 'owner-fixture-id');
  assert.equal(prepareOwner(f).action, 'resume');
  assert.throws(() => bindOwner({ ...f, claimId: request.claim_id, result: { target_session_id: 'other' } }), /拒绝改绑/);
  renderPacket({ ledgerPath: f.ledgerPath, group: 'g4', now: NOW });
  setState({ ledgerPath: f.ledgerPath, group: 'g4', to: 'dispatched', now: NOW,
    memSnapshot: { used_slots: 0, platform_cap: 8, concurrency: 2, available_bytes: 16 * 1024 ** 3 } });
  const goalPath = join(f.dir, 'goal.md'); writeFileSync(goalPath, 'test goal instruction');
  ownerGate({ ...f, kind: 'goal', goalPath });
  const routingPath = join(f.dir, 'routing.json');
  const route = { agent: 'codex', model: 'fixture-route', effort: 'high', provider_id: 'fixture' };
  writeFileSync(routingPath, JSON.stringify({ e2e: route, review: { ...route, when_lead: { gpt: { ...route, model: 'conditional-review' } } } }));
  const input = { ...f, kind: 'routing', routingPath, ownerModel: 'gpt-fixture' };
  assert.throws(() => ownerGate({ ...input, teamResult: { worker_permission_mode: 'auto' } }), /bypassPermissions/);
  const output = ownerGate({ ...input, teamResult: { worker_permission_mode: 'bypassPermissions' } });
  assert.equal(output.review.model, 'conditional-review');
  assert.equal(readLedger(f.ledgerPath).events.at(-1).type, 'gate_routing');
  setState({ ledgerPath:f.ledgerPath, group:'g4', to:'e2e', now:NOW });
  const ownerBefore = readLedger(f.ledgerPath).waves[0].groups[0];
  // Seed prior cycle evidence as an isolated fixture; rework must invalidate it
  // even when the owner and assignment are intentionally retained.
  const previous = readLedger(f.ledgerPath);
  previous.events.push({type:'accepted', at:NOW, detail:{group_id:'g4', assignment_seq:ownerBefore.assignment_seq, tip_sha:f.sha}});
  writeFileSync(f.ledgerPath,JSON.stringify(previous));
  assert.ok(latestGroupEvent(previous,'g4','accepted'));
  ownerGate({ ...f, kind:'rework', reason:'独立测试失败，域内修复' });
  const after = readLedger(f.ledgerPath);
  assert.equal(after.waves[0].groups[0].session_id, ownerBefore.session_id);
  assert.equal(after.waves[0].groups[0].assignment_seq, ownerBefore.assignment_seq);
  assert.equal(after.waves[0].groups[0].state, 'executing');
  assert.equal(latestPrHandoffDelivery(after, 'g4'), null);
  assert.equal(latestGroupEvent(after,'g4','accepted'),null);
  assert.ok(latestGroupEvent(after,'g4','gate_goal'));
});

test('现场冲突和依赖顺序决定能否派发，不能用声明锚点蒙混', (t) => {
  const f=fixture(t);
  const parallel=structuredClone(f.manifest);
  parallel.waves[1].wave=parallel.waves[0].wave;
  const report=structuredClone(f.report);
  const packet=parallel.dispatch.packets[1];
  packet.allowed_paths=['scripts/run-ledger.mjs'];
  for(const entry of report.per_sc.filter(s=>s.group_id===packet.group_id)) {
    entry.read_only=false;entry.real_write_paths=[packet.allowed_paths[0]];
  }
  report.manifest_core_hash=manifestCoreHash(parallel);
  assert.throws(()=>checkSite(parallel,report),/共享写入文件/);
  const reverse=structuredClone(f.report);
  reverse.cross_sc_edges=[{from:f.manifest.dispatch.packets[1].scs_inline[0].id,to:f.manifest.dispatch.packets[0].scs_inline[0].id}];
  assert.throws(()=>checkSite(f.manifest,reverse),/反序/);
  const extra=structuredClone(f.report);extra.per_sc.push({sc_id:'unexpected',real_write_paths:[]});
  assert.throws(()=>checkSite(f.manifest,extra),/对不上/);
  const original=readFileSync(f.handoffPath,'utf8');
  writeFileSync(f.handoffPath,original.replace('priority_id=p1','priority_id=wrong'));
  assert.throws(()=>prepareOwner(f),/SC 全文/);
});

test('claim 退役只认已知 session 的归档回执，且只有新代能再派', (t) => {
  const f = fixture(t);
  const first = prepareOwner(f);
  const result = { ok:true, changed:[{session_id:'known-owner', status:'archived'}] };
  assert.throws(() => retireOwner({ ...f, claimId:first.claim_id, result }), /未知 create/);
  bindOwner({ ...f, claimId:first.claim_id, result:{ target_session_id:'known-owner' } });
  assert.throws(() => retireOwner({ ...f, claimId:first.claim_id, result:{ok:true, changed:[]} }), /changed/);
  retireOwner({ ...f, claimId:first.claim_id, result:{content:[{type:'text',text:JSON.stringify(result)}]} });
  assert.throws(() => prepareOwner(f), /已有派工记录/);
  assert.throws(() => bindOwner({ ...f, claimId:first.claim_id, result:{target_session_id:'known-owner'} }), /拒绝改绑/);
  const ledger = readLedger(f.ledgerPath);
  const group = ledger.waves[0].groups[0];
  group.assignment_seq++;
  group.session_id=null;
  writeFileSync(f.ledgerPath, JSON.stringify(ledger));
  const second=prepareOwner(f);
  assert.equal(second.action,'create_once');
  assert.notEqual(second.claim_id,first.claim_id);
  assert.equal(JSON.parse(readFileSync(second.claim_file,'utf8')).retired[0].session_id,'known-owner');
});

test('派窗前拒过期摘录和未知依赖，不用实际创建来试错', (t) => {
  const f = fixture(t);
  const unknown = structuredClone(f.report); unknown.open_unknowns.push('依赖未确认');
  assert.throws(() => checkSite(f.manifest, unknown), /未知依赖/);
  const beyond = structuredClone(f.report); beyond.per_sc[0].real_write_paths.push('outside.js');
  assert.throws(() => checkSite(f.manifest, beyond), /超出本 PR/);
  const missing = structuredClone(f.report); missing.per_sc.pop();
  assert.throws(() => checkSite(f.manifest, missing), /漏 SC/);
  const text = readFileSync(f.handoffPath, 'utf8').replace(/source_sha256\(README.md\)=[a-f0-9]{64}/, 'source_sha256(README.md)=' + 'f'.repeat(64));
  writeFileSync(f.handoffPath, text);
  assert.throws(() => prepareOwner(f), /现场已变化/);
});

test('Mini 接管不是写名册：必须有 Ready 之后的新鲜心跳', () => {
  const takeover = { schedule_id: 'fixture-script', first_scan_ack: NOW,
    last_scan_at: '2026-09-05T00:00:02Z', config_sha256: miniWatchConfigSha256() };
  assert.throws(() => assertTakeover(null, { now: NOW }), /未确认/);
  assertTakeover(takeover, { now: '2026-09-05T00:00:03Z', readyAt: '2026-09-05T00:00:01Z' });
  assert.throws(() => assertTakeover(takeover, { now: NOW }), /心跳/);
  assert.throws(() => assertTakeover(takeover, { now: '2026-09-05T01:00:00Z' }), /心跳/);
  assert.throws(() => assertTakeover(takeover, { now: '2026-09-05T00:00:03Z', readyAt: '2026-09-05T00:00:02Z' }), /心跳/);
});

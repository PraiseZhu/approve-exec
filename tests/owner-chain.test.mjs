import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initLedger, setState, renderPacket, readLedger, readExecutionManifest, manifestCoreHash, latestPrHandoffDelivery, latestGroupEvent } from '../scripts/run-ledger.mjs';
import { libraryManifests } from './fixtures/library-pr-manifests.mjs';
import { recordDelivery, readDefaults, noteEvent } from '../scripts/run-ledger.mjs';
import { renderPrHandoff } from '../scripts/render-pr-handoff.mjs';
import { prepareOwner, bindOwner, retireOwner } from '../scripts/owner-dispatch.mjs';
import { ownerGate } from '../scripts/owner-gate.mjs';
import { checkSite } from '../scripts/site-check.mjs';
import { assertTakeover } from '../scripts/pr-watch/takeover.mjs';
import { miniWatchConfigSha256 } from '../scripts/lib/mini-watch-config.mjs';
import { issueLeadSignal } from '../scripts/pr-watch/lead-signal.mjs';

const NOW = '2026-09-05T00:00:00Z';
function writeContinuation(dir, ledgerPath, schedule = {}) {
  const configPath = join(dir, 'lead-continuation.json');
  writeFileSync(configPath, JSON.stringify({ lead_session_id: 'lead-test', ledger_paths: [realpathSync(ledgerPath)], stalled_after_sec: 1800 }));
  writeFileSync(join(dir, 'lead-continuation-schedule.json'), JSON.stringify({ ok: true, id: 'sched-1', executionMode: 'script', status: 'active',
    command: 'python3 /skill/scripts/lead-continuation.py --config ' + realpathSync(configPath), ...schedule }));
}
function fixture(t, staged = false, probeExit = 0) {
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
  let manifest = staged ? libraryManifests()[0] : JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/sample-manifest.json', import.meta.url)), 'utf8'));
  if (staged && probeExit) {
    manifest.scs.find(sc => sc.kind === 'probe').verify.args = ['-e', 'process.exit(' + probeExit + ')'];
    manifest.manifest_core_hash = manifestCoreHash(manifest);
    manifest.receipts[0].manifest_core_hash = manifest.manifest_core_hash;
  }
  const mp = join(dir, 'manifest.json');
  writeFileSync(mp, JSON.stringify(manifest));
  const ledgerPath = join(dir, 'ledger.json');
  const prMapPath = join(dir, 'pr-map.json');
  if (staged) writeFileSync(prMapPath, JSON.stringify({ schema_version: 'pr-map-v1', source_manifest_core_hash: manifestCoreHash(manifest), prs: [{ pr_id: 'g4', source_groups: ['p1', 'g1', 'v1'] }] }));
  initLedger({ ledgerPath, manifestPath: mp, runId: 'owner-fixture', now: NOW, baseline: sha, ...(staged ? { prMapPath } : {}) });
  if (staged) manifest = readExecutionManifest(readLedger(ledgerPath));
  const identity = { worktree: repo, base: sha, branch: 'feat/fixture', title: 'Skills-独立负责验收丨 0905' };
  setState({ ledgerPath, group: 'g4', now: NOW, identity });
  const packet = manifest.dispatch.packets[0];
  const handoff = renderPrHandoff({ packet, identity, leadSessionId: 'lead-test', seq: 1,
    executionPlanHash: manifest.execution_plan_hash,
    repo: 'Skills', title: identity.title, why: '派窗重试会重复创建', how: '绑定一次性派工记录和回执',
    excerpts: [{ file: 'README.md', line: 1, behavior: '测试初始内容' }] });
  const handoffPath = join(dir, 'handoff.md'); writeFileSync(handoffPath, handoff);
  const report = { manifest_core_hash: manifest.source_manifest_core_hash ?? manifestCoreHash(manifest), execution_plan_hash: manifest.execution_plan_hash, cross_sc_edges: [], open_unknowns: [],
    per_sc: manifest.dispatch.packets.flatMap((p) => p.scs_inline.map((sc) => ({ sc_id: sc.id,
      group_id: p.group_id, read_only: sc.kind === 'probe' || p.allowed_paths.length === 0, real_write_paths: sc.kind === 'probe' ? [] : p.allowed_paths }))) };
  const sitePath = join(dir, 'site.json'); writeFileSync(sitePath, JSON.stringify(report));
  writeContinuation(dir, ledgerPath);
  return { dir, repo, sha, manifest, report, ledgerPath, handoffPath, sitePath, groupId: 'g4', now: NOW };
}

test('派窗核第 5 段：连带策略原文被改写即拒；旧开工包（无连带策略）仍放行', t => {
  const tampered = fixture(t);
  const text = readFileSync(tampered.handoffPath, 'utf8');
  assert.ok(text.includes('上限 10 个文件、200 行'), '夹具开工包应带连带策略');
  writeFileSync(tampered.handoffPath, text.replace('上限 10 个文件、200 行', '上限 50 个文件、200 行'));
  assert.throws(() => prepareOwner(tampered), /授权路径与 final 不一致/);
  const legacy = fixture(t);
  const legacyText = readFileSync(legacy.handoffPath, 'utf8');
  const start = legacyText.indexOf('\n\n连带文件（包内预授权');
  const end = legacyText.indexOf('\n\n## 6. SC 全文');
  assert.ok(start > 0 && end > start, '应能定位第 5 段连带策略块');
  writeFileSync(legacy.handoffPath, legacyText.slice(0, start) + legacyText.slice(end));
  assert.equal(prepareOwner(legacy).action, 'create_once');
});

test('新版 PR 全链：真实格式计划、唯一 owner、核查先行、完整条件验收', t => {
  const input = fixture(t, true);
  const request = prepareOwner(input);
  assert.equal(request.action, 'create_once');
  assert.throws(() => prepareOwner(input), /禁止自动再次 create/);
  bindOwner({ ...input, claimId: request.claim_id, result: { target_session_id: 'staged-owner' } });
  renderPacket({ ledgerPath: input.ledgerPath, group: input.groupId, now: NOW });
  const transition = to => setState({ ledgerPath: input.ledgerPath, group: input.groupId, to, now: NOW,
    memSnapshot: { used_slots: 0, platform_cap: 8, concurrency: 2, available_bytes: 16 * 1024 ** 3 } });
  transition('dispatched');
  const dirty = join(input.repo, 'README.md');
  const original = readFileSync(dirty, 'utf8');
  writeFileSync(dirty, 'premature edit');
  assert.throws(() => ownerGate({ ...input, kind: 'baseline' }), /干净原基线/);
  writeFileSync(dirty, original);
  const goalPath = join(input.dir, 'goal.md');
  writeFileSync(goalPath, 'fixture goal');
  assert.throws(() => ownerGate({ ...input, kind: 'goal', goalPath }), /核查/);
  assert.throws(() => transition('executing'), /核查/);
  ownerGate({ ...input, kind: 'baseline' });
  ownerGate({ ...input, kind: 'goal', goalPath });
  assert.equal(prepareOwner(input).session_id, 'staged-owner');
  const invoke = (...gitArgs) => {
    const result = spawnSync('git', ['-C', input.repo, ...gitArgs], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  writeFileSync(join(input.repo, 'README.md'), original + 'line\n'.repeat(799));
  invoke('add', 'README.md');
  invoke('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', '799-line candidate');
  input.sha = invoke('rev-parse', 'HEAD');
  const routingPath = join(input.dir, 'routing.json');
  const route = { agent: 'codex', model: 'fixture', effort: 'high', provider_id: 'fixture' };
  writeFileSync(routingPath, JSON.stringify({ e2e: route, review: route }));
  ownerGate({ ...input, kind: 'routing', routingPath, ownerModel: 'gpt-fixture', teamResult: { worker_permission_mode: 'bypassPermissions' } });
  transition('e2e');
  transition('review');
  assert.equal(prepareOwner(input).action, 'resume');
  const candidate = { branch: 'feat/fixture', tip_sha: input.sha,
    scs: input.manifest.scs.map(sc => ({ id: sc.id, status: 'pass' })),
    goal_skill_path: '/Users/praise/.agents/skills/goal/SKILL.md',
    e2e: { status: 'pass', candidate_sha: input.sha, model: 'fixture', route_source: readDefaults().routingPath },
    size_gate: { result: 'PASS', candidate_sha: input.sha }, fallbacks_tried: [] };
  const deliver = payload => recordDelivery({ ledgerPath: input.ledgerPath, group: input.groupId, now: NOW, payload });
  assert.throws(() => deliver({ ...candidate, scs: candidate.scs.filter(sc => !sc.id.includes('acceptance')) }), /SC|sc/);
  const incomplete = structuredClone(candidate);
  incomplete.scs.at(-1).status = 'not_run';
  deliver(incomplete);
  assert.throws(() => transition('accepted'), /全部 SC/);
  deliver(candidate);
  assert.throws(() => transition('local_validated'), /七门回执/);
  const ledger = readLedger(input.ledgerPath);
  assert.equal(ledger.waves.length, 1);
  assert.equal(ledger.waves[0].groups[0].session_id, 'staged-owner');
  assert.equal(ledger.waves[0].groups[0].review.rounds, 0);
  assert.equal(ledger.waves[0].integrated_tip, null);
  assert.equal(latestPrHandoffDelivery(ledger, input.groupId).scs.length, 14);
  const verdictPath = join(input.dir, 'verdict.json');
  const evidence = readFileSync(join(input.repo, 'README.md'), 'utf8').trim();
  const verdict = { candidate_sha: input.sha, scs: candidate.scs.map(sc => ({ sc_id: sc.id, status: sc.status,
    evidence: [{ file: 'README.md', command: 'node -e "process.exit(0)"', summary: evidence }] })), output_records: { 'README.md': evidence } };
  writeFileSync(verdictPath, JSON.stringify(verdict));
  const e2ePath = join(input.dir, 'e2e.json');
  writeFileSync(e2ePath, JSON.stringify({ candidate_sha: input.sha, status: 'pass', failed: 0 }));
  for (const name of ['size', 'format', 'intent']) writeFileSync(join(input.dir, name + '.json'), JSON.stringify({ candidate_sha: input.sha, result: name === 'intent' ? 'OK' : 'PASS' }));
  const receiptPath = join(input.dir, 'receipt.json');
  const validatedAt = '2026-09-05T00:00:01Z';
  const args = [fileURLToPath(new URL('../scripts/ready-check.mjs', import.meta.url)), '--group', input.groupId,
    '--repo', input.repo, '--ledger', input.ledgerPath, '--manifest', ledger.manifest_path, '--verdict', verdictPath,
    '--e2e-report', e2ePath, '--presubmit-dir', input.dir, '--receipt', receiptPath, '--now', validatedAt];
  const ready = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(ready.status, 0, ready.stdout + ready.stderr);
  assert.equal(JSON.parse(readFileSync(receiptPath)).execution_plan_hash, ledger.pr_plan.plan_hash);
  const receipt = JSON.parse(readFileSync(receiptPath));
  delete receipt.execution_plan_hash;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => noteEvent({ ledgerPath: input.ledgerPath, now: validatedAt, event: 'local_validated',
    detail: { group_id: input.groupId, receipt: receiptPath } }), /execution_plan_hash|归属/);
  receipt.execution_plan_hash = ledger.pr_plan.plan_hash;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  noteEvent({ ledgerPath: input.ledgerPath, now: validatedAt, event: 'local_validated', detail: { group_id: input.groupId, receipt: receiptPath } });
  assert.equal(readLedger(input.ledgerPath).waves[0].groups[0].state, 'local_validated');
  const openedAt = '2026-09-05T00:00:02Z';
  const readyAt = '2026-09-05T00:00:03Z';
  const remoteReceipt = { url: 'https://github.com/PraiseZhu/approve-exec/pull/7', number: 7,
    headRefOid: input.sha, isDraft: false, state: 'OPEN', branch: 'feat/fixture', checked_at: openedAt,
    ledger_version: readLedger(input.ledgerPath).version, assignment_seq: 0 };
  setState({ ledgerPath: input.ledgerPath, group: input.groupId, to: 'pr-open', now: openedAt, prOpenReceipt: remoteReceipt });
  const remoteReceiptPath = join(input.dir, 'remote-receipt.json');
  writeFileSync(remoteReceiptPath, JSON.stringify({ ...remoteReceipt, checked_at: readyAt }));
  noteEvent({ ledgerPath: input.ledgerPath, now: readyAt, event: 'pr_ready', detail: {
    group_id: input.groupId, pr_url: remoteReceipt.url, current_pr_head_sha: input.sha, receipt: remoteReceiptPath } });
  const signal = issueLeadSignal({ ledgerPath: input.ledgerPath, groupId: input.groupId, leadSessionId: 'lead-test',
    senderSessionId: 'lead-test', hostSessionId: 'lead-test', now: '2026-09-05T00:00:04Z' }).signal;
  assert.equal(signal.evidence.execution_plan_hash, ledger.pr_plan.plan_hash);
  assert.equal(signal.owner_session_id, 'staged-owner');
  writeFileSync(join(input.repo, 'budget.test.mjs'), 'export const fixture = true;\n');
  invoke('add', 'budget.test.mjs');
  invoke('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'oversize fixture');
  const oversize = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(oversize.status, 2);
  assert.match(oversize.stderr, /pr-total-lines/);
  invoke('reset', '--hard', input.sha);
  verdict.scs.pop();
  writeFileSync(verdictPath, JSON.stringify(verdict));
  const missing = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});

test('新版核查失败不能开工，归属变化不能恢复旧 claim', t => {
  const input = fixture(t, true, 1);
  const request = prepareOwner(input);
  bindOwner({ ...input, claimId: request.claim_id, result: { target_session_id: 'failed-probe-owner' } });
  renderPacket({ ledgerPath: input.ledgerPath, group: input.groupId, now: NOW });
  setState({ ledgerPath: input.ledgerPath, group: input.groupId, to: 'dispatched', now: NOW,
    memSnapshot: { used_slots: 0, platform_cap: 8, concurrency: 2, available_bytes: 16 * 1024 ** 3 } });
  assert.throws(() => ownerGate({ ...input, kind: 'baseline' }), /核查失败/);
  const ledger = readLedger(input.ledgerPath);
  assert.equal(latestGroupEvent(ledger, input.groupId, 'baseline_checked'), null);
  const mapPath = ledger.pr_plan.map_path;
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  map.prs[0].pr_id = 'replacement';
  writeFileSync(mapPath, JSON.stringify(map));
  assert.throws(() => prepareOwner(input), /PR_MAP_HASH_MISMATCH/);
  assert.throws(() => bindOwner({ ...input, claimId: request.claim_id, result: { target_session_id: 'failed-probe-owner' } }), /PR_MAP_HASH_MISMATCH/);
});

test('Mivo 首次 CI 红后 local_validated 可由同一 owner 回修', t => {
  const input = fixture(t, true);
  const request = prepareOwner(input);
  bindOwner({ ...input, claimId: request.claim_id, result: { target_session_id: 'ci-red-owner' } });
  renderPacket({ ledgerPath: input.ledgerPath, group: input.groupId, now: NOW });
  setState({ ledgerPath: input.ledgerPath, group: input.groupId, to: 'dispatched', now: NOW,
    memSnapshot: { used_slots: 0, platform_cap: 8, concurrency: 2, available_bytes: 16 * 1024 ** 3 } });
  const goalPath = join(input.dir, 'goal.md'); writeFileSync(goalPath, 'test goal instruction');
  ownerGate({ ...input, kind: 'baseline' });
  ownerGate({ ...input, kind: 'goal', goalPath });
  const routingPath = join(input.dir, 'routing.json');
  writeFileSync(routingPath, JSON.stringify({ e2e: { agent: 'fixture', model: 'fixture-route', effort: 'high', provider_id: 'fixture' } }));
  ownerGate({ ...input, kind: 'routing', routingPath, ownerModel: 'fixture-owner', teamResult: { worker_permission_mode: 'bypassPermissions' } });
  setState({ ledgerPath: input.ledgerPath, group: input.groupId, to: 'e2e', now: NOW });
  setState({ ledgerPath: input.ledgerPath, group: input.groupId, to: 'review', now: NOW });
  const ledger = readLedger(input.ledgerPath);
  const group = ledger.waves[0].groups[0];
  group.state = 'local_validated';
  ledger.events.push({ type: 'local_validated', at: NOW, detail: {
    group_id: input.groupId, assignment_seq: group.assignment_seq, tip_sha: input.sha,
  } });
  ledger.version += 1;
  writeFileSync(input.ledgerPath, JSON.stringify(ledger));
  assert.equal(readLedger(input.ledgerPath).waves[0].groups[0].state, 'local_validated');
  ownerGate({ ...input, kind: 'rework', reason: 'required CI failed on the pushed head' });
  const after = readLedger(input.ledgerPath);
  assert.equal(after.waves[0].groups[0].state, 'executing');
  assert.equal(after.waves[0].groups[0].session_id, 'ci-red-owner');
  assert.equal(after.waves[0].groups[0].assignment_seq, group.assignment_seq);
  assert.equal(latestGroupEvent(after, input.groupId, 'local_validated'), null);
});

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
  assert.equal(output.e2e.model, 'fixture-route');
  assert.equal(output.review, undefined);
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

test('派窗拒手改开工包夹带五类停外的停点（回归 mivo PR3 的 lead 补充）', t => {
  const f = fixture(t);
  const text = readFileSync(f.handoffPath, 'utf8');
  writeFileSync(f.handoffPath, text + '\n【lead 补充，优先于第 8 段】派 GPT 单审 reviewer，写 accept-PR3 后停下等 lead「开 PR」\n');
  assert.throws(() => prepareOwner(f), /PACKET_EXTRA_STOP|五类停以外/);
  writeFileSync(f.handoffPath, text.replace('## 9. 禁做\n', '## 9. 禁做\n- lead 验收前 git push\n'));
  assert.throws(() => prepareOwner(f), /forbid-authorized-push/);
});

test('派窗前必须已登记指向本台账的 active 续跑调度', t => {
  const missing = fixture(t);
  unlinkSync(join(missing.dir, 'lead-continuation-schedule.json'));
  assert.throws(() => prepareOwner(missing), /派窗前必须先登记整包续跑/);
  const paused = fixture(t);
  writeContinuation(paused.dir, paused.ledgerPath, { status: 'paused' });
  assert.throws(() => prepareOwner(paused), /active script 调度/);
  const otherLedger = fixture(t);
  writeFileSync(join(otherLedger.dir, 'lead-continuation.json'), JSON.stringify({ lead_session_id: 'lead-test', ledger_paths: ['/elsewhere/ledger.json'] }));
  assert.throws(() => prepareOwner(otherLedger), /ledger_paths 未包含本台账/);
});

test('decision_required：owner 停下入账一次、重复不再叫醒、字段不全即拒', t => {
  const f = fixture(t);
  const evidence = join(f.dir, 'decision.json');
  const detail = { group_id: f.groupId, decision_id: 'expand-write-set', evidence_path: evidence };
  const before = readLedger(f.ledgerPath).version;
  noteEvent({ ledgerPath: f.ledgerPath, now: NOW, event: 'decision_required', detail });
  noteEvent({ ledgerPath: f.ledgerPath, now: NOW, event: 'decision_required', detail });
  const ledger = readLedger(f.ledgerPath);
  assert.equal(ledger.version, before + 1);
  assert.equal(ledger.events.filter(e => e.type === 'decision_required').length, 1);
  assert.throws(() => noteEvent({ ledgerPath: f.ledgerPath, now: NOW, event: 'decision_required', detail: { ...detail, evidence_path: 'rel.json' } }), /绝对路径/);
  assert.throws(() => noteEvent({ ledgerPath: f.ledgerPath, now: NOW, event: 'decision_required', detail: { group_id: f.groupId } }), /decision_id/);
});

test('owner-checkpoint 写 decision 时同步入账 decision_required，lead 续跑能看见', t => {
  const f = fixture(t);
  const request = prepareOwner(f);
  bindOwner({ ...f, claimId: request.claim_id, result: { target_session_id: 'bound-owner' } });
  const checkpoint = join(f.dir, 'owner-checkpoints', 'g4.json');
  const evidence = join(f.dir, 'decision.json');
  const script = fileURLToPath(new URL('../scripts/owner-checkpoint.py', import.meta.url));
  const run = () => spawnSync('python3', ['-B', script, '--ledger', f.ledgerPath, '--group', f.groupId, '--checkpoint', checkpoint,
    '--phase', 'decision', '--step', 'await-expansion', '--decision-id', 'expand-write-set', '--decision-evidence', evidence], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(run().status, 0);
  const events = readLedger(f.ledgerPath).events.filter(e => e.type === 'decision_required');
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.decision_id, 'expand-write-set');
  assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).phase, 'decision');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanOnce,watcherPaths,applyDispatchReceipt,runGh} from './bin/cindy-watcher.mjs';
const now='2026-09-10T10:00:00Z';
const makePr=n=>({number:n,id:`PR_${n}`,headRefOid:'a'.repeat(40),headRefName:`branch-${n}`,title:`task ${n}`,isDraft:false});
function fixture(t,status='complete') {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-scan-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const paths=watcherPaths(home);fs.mkdirSync(path.join(paths.stateDir,'results'),{recursive:true});
 const pr=makePr(1), entry={...pr,nodeId:pr.id,sessionId:'session-1',eligibilityInitialized:true,activeTask:{dispatchId:'dispatch-1',status:'running'},lastDispatch:{dispatchId:'dispatch-1'}};
 fs.writeFileSync(paths.statePath,JSON.stringify({prs:{[pr.id]:entry}}));
 const result={dispatchId:'dispatch-1',nodeId:pr.id,sessionId:'session-1',schemaVersion:2,status,head:pr.headRefOid,ci:{head:pr.headRefOid,requiredGreen:true},verification:{status:'pass'}};
 fs.writeFileSync(path.join(paths.stateDir,'results/dispatch-1.json'),JSON.stringify(result));
 return {paths,pr,result,read:()=>JSON.parse(fs.readFileSync(paths.statePath))};
}
for(const status of ['complete','waiting-ci','blocked'])test(`persist ${status} before failed first API`,t=>{
 const f=fixture(t,status);
 assert.throws(()=>scanOnce({paths:f.paths,now,ghFn:()=>{assert.equal(f.read().prs.PR_1.activeTask.status,status);throw Error('network offline');}}),/network offline/);
 assert.equal(f.read().prs.PR_1.activeTask.status,status);
});
test('wrong receipt identity is quarantined before network',t=>{
 const f=fixture(t);f.result.sessionId='other';fs.writeFileSync(path.join(f.paths.stateDir,'results/dispatch-1.json'),JSON.stringify(f.result));
 assert.throws(()=>scanOnce({paths:f.paths,ghFn:()=>{throw Error('offline');}}));
 assert.equal(f.read().prs.PR_1.activeTask.blockedKind,'invalid-result');
});
test('old dispatch receipt cannot terminate current dispatch',t=>{
 const f=fixture(t);f.result.dispatchId='old-dispatch';fs.writeFileSync(path.join(f.paths.stateDir,'results/dispatch-1.json'),JSON.stringify(f.result));
 assert.throws(()=>scanOnce({paths:f.paths,ghFn:()=>{throw Error('offline');}}));
 assert.equal(f.read().prs.PR_1.activeTask.blockedKind,'invalid-result');
});
test('new listed head invalidates result currentness and never implies merge ready',t=>{
 const f=fixture(t);const current={...f.pr,headRefOid:'b'.repeat(40)};
 scanOnce({paths:f.paths,ghFn:a=>a[0]==='api'?'owner':JSON.stringify([current]),collect:()=>{throw Error('not verified');}});
 const state=f.read().prs.PR_1;assert.equal(state.activeTask.status,'complete');assert.equal(state.activeTask.resultHeadCurrent,false);assert.equal(state.mergeReady,false);
});
test('fair cursor survives restart and each PR error checkpoint',t=>{
 const f=fixture(t);const prs=[1,2,3,4,5].map(makePr),seen=[];
 const run=()=>scanOnce({paths:f.paths,now,maxPrs:2,ghFn:a=>a[0]==='api'?'owner':JSON.stringify(prs),collect:p=>{seen.push(p.number);throw Error('temporary outage');}});
 const a=run(),b=run(),c=run();
 assert.deepEqual(seen,[1,2,3,4,5,1]);assert.equal(a.scan.partial,true);assert.equal(b.scan.cursor,4);assert.equal(c.scan.cursor,1);
 assert.equal(f.read().prs.PR_1.activeTask.status,'complete');
});
test('global budget interruption retries incomplete PR first next scan',t=>{
 const f=fixture(t);let clock=0;const seen=[];
 const options={paths:f.paths,now,budgetMs:2000,clock:()=>clock,ghFn:a=>a[0]==='api'?'owner':JSON.stringify([1,2,3].map(makePr)),collect:p=>{seen.push(p.number);clock+=1500;throw Error('slow PR');}};
 const first=scanOnce(options);assert.equal(first.scan.partial,true);assert.deepEqual(seen,[1]);
 scanOnce(options);assert.deepEqual(seen,[1,1]);
 assert.equal(first.scan.deferredNumber,1);
});
test('per-PR cap advances poison PR while global budget remains',t=>{
 const f=fixture(t);let clock=0;const seen=[];
 const options={paths:f.paths,now,budgetMs:120000,perPrBudgetMs:1000,maxPrs:1,clock:()=>clock,ghFn:a=>a[0]==='api'?'owner':JSON.stringify([1,2,3].map(makePr)),collect:p=>{seen.push(p.number);clock+=1100;throw Error('slow PR');}};
 scanOnce(options);scanOnce(options);scanOnce(options);assert.deepEqual(seen,[1,2,3]);
});
test('upgrade retries legacy last PR proven cut short by global budget',t=>{
 const f=fixture(t),state=f.read();state.scan={cursor:2,startedAt:now,elapsedMs:119966};state.prs.PR_2={...makePr(2),lastCollectionError:{at:now,reason:'scan-budget-exhausted'}};
 fs.writeFileSync(f.paths.statePath,JSON.stringify(state));const seen=[];
 scanOnce({paths:f.paths,now,maxPrs:1,ghFn:a=>a[0]==='api'?'owner':JSON.stringify([1,2,3].map(makePr)),collect:p=>{seen.push(p.number);return {mergeReady:false};}});
 assert.deepEqual(seen,[2]);assert.equal(f.read().scan.version,2);
});
test('transport stops subsequent calls once PR budget exhausted',t=>{
 const f=fixture(t);let clock=0,calls=0;
 scanOnce({paths:f.paths,now,clock:()=>clock,perPrBudgetMs:1000,ghFn:a=>{calls++;return a[0]==='api'?'owner':JSON.stringify([makePr(1)]);},collect:(_,{ghFn})=>{clock=1100;ghFn(['api','should-not-run']);}});
 assert.equal(calls,2);
});
for(const wake of ['created','resumed','already-active','queued'])test(`${wake} receipt does not claim active Host turn`,t=>{
 const f=fixture(t);const state=f.read();
 applyDispatchReceipt({state,pr:f.pr,mapping:{sessionId:'session-1'},receipt:{target_session_id:'session-1',wake_kind:wake,dispatch_id:'new'},now,paths:f.paths});
 assert.equal(f.read().prs.PR_1.activeTask.status,wake==='queued'?'queued':'accepted');assert.equal(f.read().prs.PR_1.activeTask.hostTurnStatus,'unverified');
});
test('gh subprocess timeout is capped independently',()=>{
 runGh(['api','x'],(_bin,_args,options)=>{assert.equal(options.timeout,12000);return '{}';});
 runGh(['api','x'],(_bin,_args,options)=>{assert.equal(options.timeout,350);return '{}';},350);
});
test('queued delivery remains inflight, does not duplicate dispatch',t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.paths.stateDir,'results/dispatch-1.json'));
 const state=f.read();state.prs.PR_1.activeTask.status='queued';state.prs.PR_1.admissionVerified=true;state.prs.PR_1.lastDispatch.at=now;fs.writeFileSync(f.paths.statePath,JSON.stringify(state));
 let sent=0;
 scanOnce({paths:f.paths,now,enabled:true,allowDispatch:true,ghFn:a=>a[0]==='api'?'owner':JSON.stringify([f.pr]),collect:()=>({checks:[{name:'unit',state:'FAILURE'}],mergeReady:false}),dispatchFn:()=>{sent++;}});
 assert.equal(sent,0);
});

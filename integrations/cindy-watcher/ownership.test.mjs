import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanOnce,watcherPaths,REPO} from './bin/cindy-watcher.mjs';
const pr={id:'PR_test',number:1,headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),headRefName:'fix/test',title:'修复测试',isDraft:false,state:'OPEN',sameRepository:false,isCrossRepository:true,author:{login:'owner'},headRepositoryOwner:{login:'owner'},headRepository:{name:'cindy-fork'},releaseEpoch:'epoch-new'};
function probe(t,{collectedPr=pr,livePr=pr,priorEpoch='epoch-new',admission=false}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'watch-owner-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const paths=watcherPaths(home);fs.mkdirSync(paths.stateDir,{recursive:true});
 fs.writeFileSync(paths.statePath,JSON.stringify({version:2,repo:REPO,prs:{[pr.id]:{number:1,nodeId:pr.id,sessionId:'original-session',eligibilityInitialized:true,eligibility:'active',admissionVerified:true,admissionEpoch:priorEpoch,activeTask:{status:'complete'}}}}));
 let calls=0;
 const result=scanOnce({enabled:true,allowDispatch:true,paths,now:'2026-09-10T00:00:00Z',ghFn:args=>args[0]==='api'?'owner':JSON.stringify([pr]),
 collect:()=>({pr:collectedPr,admissionVerified:admission,checks:[{name:'unit',state:'FAILURE',bucket:'fail'}],ci:{status:'failed',required:[{context:'unit',status:'failed',evidence:{id:1,runId:2,attempt:1}}]},policy:{status:'verified',required:[{context:'unit'}]},comments:[],reviews:[],threads:[],labels:[],mergeReady:false}),
 ownershipSnapshot:function*(){return {pr:livePr};},dispatchFn:params=>{calls++;assert.equal(params.target_session_id,'original-session');return {target_session_id:'original-session'};}});
 return {calls,result};
}
for(const [name,change] of [['closed',{state:'CLOSED'}],['draft',{isDraft:true}],['owner',{author:{login:'other'}}]]) {
 test(`list open but collector ${name} cannot dispatch`,t=>assert.equal(probe(t,{collectedPr:{...pr,...change}}).calls,0));
 test(`last-moment ${name} cannot dispatch`,t=>{const p=probe(t,{livePr:{...pr,...change}});assert.equal(p.calls,0);assert.equal(p.result.prs[0].dispatch.reason,'ownership-changed-before-dispatch');});
}
test('new release epoch cannot inherit previous green admission',t=>{const p=probe(t,{priorEpoch:'epoch-old'});assert.equal(p.calls,0);assert.equal(p.result.prs[0].dispatch.reason,'admission-not-verified');});
test('same admitted release repairs CI failure in same session',t=>assert.equal(probe(t).calls,1));
test('last-moment head change cannot dispatch stale task',t=>assert.equal(probe(t,{livePr:{...pr,headRefOid:'c'.repeat(40)}}).calls,0));
test('last-moment release cycle cannot dispatch stale task',t=>assert.equal(probe(t,{livePr:{...pr,releaseEpoch:'newer-epoch'}}).calls,0));

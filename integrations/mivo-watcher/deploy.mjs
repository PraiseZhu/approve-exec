#!/usr/bin/env node
// Source-only deployer. No scheduler or database writes; apply requires a saved preview.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNTIME='/Users/praise/AI-Agent/Claude/projects/Project Mivo Canvas-Plugin/_ops/mivo-watcher';
export const FILES=['mivo-ci.mjs','mivo-pr-policy.mjs','mivo-pr-snapshot.mjs','mivo-repair.mjs','mivo-state.mjs','mivo-ownership.mjs','mivo-watcher.mjs','public-review.mjs','session-title.mjs','mivo-watch-script.py','protocol.py','session-title-maintenance.py'];
const sha=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const requireValue=(v,m)=>{if(!v)throw Error(m);};
export function verify(runtime,source=path.join(here,'bin')) {
 return FILES.map(name=>({name,source:sha(path.join(source,name)),runtime:sha(path.join(runtime,'bin',name))}));
}
function identitiesFromState(state){
 const ids=Object.values(state.prs||{}).map(v=>v.sessionId).filter(Boolean).sort();
 requireValue(new Set(ids).size===ids.length&&ids.every(v=>/^[a-f0-9-]+$/.test(v)),'invalid session identities');return ids;
}
function identities(home){
 const prsDir=path.join(home,'state/prs');
 if(fs.existsSync(prsDir)){
  const ids=[];
  for(const name of fs.readdirSync(prsDir).filter(n=>n.endsWith('.json')).sort()){
   const entry=JSON.parse(fs.readFileSync(path.join(prsDir,name),'utf8'));
   if(entry?.sessionId)ids.push(entry.sessionId);
  }
  ids.sort();
  requireValue(new Set(ids).size===ids.length&&ids.every(v=>/^[a-f0-9-]+$/.test(v)),'invalid session identities');
  return ids;
 }
 const stateFile=path.join(home,'state/state.json');
 return identitiesFromState(JSON.parse(fs.readFileSync(stateFile)));
}
export function stateFingerprint(home){
 const index=path.join(home,'state/index.json'),prsDir=path.join(home,'state/prs');
 if(fs.existsSync(index)||fs.existsSync(prsDir)){
  const files=fs.existsSync(prsDir)?fs.readdirSync(prsDir).filter(n=>n.endsWith('.json')).sort():[];
  return createHash('sha256').update(JSON.stringify({
   index:sha(index),
   files:files.map(name=>({name,sha:sha(path.join(prsDir,name))})),
  })).digest('hex');
 }
 return sha(path.join(home,'state/state.json'));
}
function idle(database,ids){
 if(!ids.length)return;
 const rows=JSON.parse(execFileSync('sqlite3',['-readonly','-json',database,`select id,active_turn_pid from sessions where id in (${ids.map(v=>`'${v}'`).join(',')})`],{encoding:'utf8'}));
 requireValue(rows.length===ids.length&&rows.every(r=>r.active_turn_pid===null),'Host session active or missing');
}
export function validatePlan(plan){
 requireValue(plan?.version===1&&path.isAbsolute(plan.home)&&path.isAbsolute(plan.database)&&plan.database.endsWith('.db'),'invalid runtime/database');
 requireValue(/^[a-z0-9][a-z0-9-]{1,80}$/.test(plan.id),'invalid release id');
 requireValue(Array.isArray(plan.files)&&plan.files.length===FILES.length&&new Set(plan.files.map(f=>f.name)).size===FILES.length&&plan.files.every(f=>FILES.includes(f.name)&&/^[a-f0-9]{64}$/.test(f.source)&&(f.runtime===null||/^[a-f0-9]{64}$/.test(f.runtime))),'invalid artifact manifest');
 requireValue(/^[a-f0-9]{64}$/.test(plan.stateSha),'missing state identity');
 requireValue(Array.isArray(plan.sessionIds),'missing session identities');
}
export function apply(plan){
 validatePlan(plan);
 const state=path.join(plan.home,'state/state.json'),lease=path.join(plan.home,'state/lease');
 const record=path.join(plan.home,'deployments',plan.id),owner=`${process.pid} ${plan.id}\n`;
 const check=()=>{
  requireValue(stateFingerprint(plan.home)===plan.stateSha,'state changed since preview');
  requireValue(JSON.stringify(identities(plan.home))===JSON.stringify(plan.sessionIds),'session binding changed');
  idle(plan.database,plan.sessionIds);
  for(const item of plan.files){requireValue(sha(path.join(here,'bin',item.name))===item.source,'source changed since preview');requireValue(sha(path.join(plan.home,'bin',item.name))===item.runtime,'runtime changed since preview');}
 };
 check();
 // Never steal a live or unknown lease. Let the watcher recover stale leases.
 fs.writeFileSync(lease,owner,{flag:'wx',mode:0o600});
 const installed=[];
 try{
  check();requireValue(!fs.existsSync(record),'release id already exists');
  fs.mkdirSync(path.join(record,'before'),{recursive:true,mode:0o700});
  if(fs.existsSync(state))fs.copyFileSync(state,path.join(record,'before/state.json'));
  fs.writeFileSync(path.join(record,'manifest.json'),JSON.stringify(plan,null,2),{mode:0o600});
  for(const item of plan.files){
   if(item.runtime===item.source)continue;
   const target=path.join(plan.home,'bin',item.name),tmp=target+`.install-${process.pid}`;
   requireValue(sha(target)===item.runtime&&sha(path.join(here,'bin',item.name))===item.source,'artifact changed during install');
   if(item.runtime)fs.copyFileSync(target,path.join(record,'before',item.name));
   fs.copyFileSync(path.join(here,'bin',item.name),tmp);fs.chmodSync(tmp,0o755);fs.renameSync(tmp,target);installed.push(item);
  }
  requireValue(stateFingerprint(plan.home)===plan.stateSha,'state changed during install');idle(plan.database,plan.sessionIds);
  requireValue(verify(plan.home).every(v=>v.source===v.runtime),'installed hash mismatch');
  const receipt={status:'installed',at:new Date().toISOString(),files:plan.files,stateChanged:false,sessionIds:plan.sessionIds,schedulerChanged:false,databaseChanged:false};
  fs.writeFileSync(path.join(record,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});return receipt;
 }catch(error){
  for(const item of installed.reverse()){
   const target=path.join(plan.home,'bin',item.name),tmp=target+`.rollback-${process.pid}`;
   if(item.runtime){fs.copyFileSync(path.join(record,'before',item.name),tmp);fs.chmodSync(tmp,0o755);fs.renameSync(tmp,target);}else fs.unlinkSync(target);
  }throw error;
 }finally{if(fs.existsSync(lease)&&fs.readFileSync(lease,'utf8')===owner)fs.unlinkSync(lease);}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),mode=args[0],get=name=>args[args.indexOf(name)+1];
 if(mode==='verify'){
  const runtime=get('--home');requireValue(args.includes('--home')&&path.isAbsolute(runtime),'--home required');
  const files=verify(runtime);console.log(JSON.stringify({files,match:files.every(v=>v.source&&v.source===v.runtime)}));
  if(!files.every(v=>v.source&&v.source===v.runtime))process.exitCode=1;
 }else if(mode==='preview'){
  const home=get('--home'),database=get('--database'),id=get('--id'),file=get('--plan');
  requireValue(['--home','--database','--id','--plan'].every(k=>args.includes(k))&&path.isAbsolute(file),'explicit home/database/id/absolute plan required');
  const plan={version:1,home,database,id,files:verify(home),stateSha:stateFingerprint(home),sessionIds:identities(home)};
  validatePlan(plan);idle(database,plan.sessionIds);fs.writeFileSync(file,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({mode:'preview',plan:file,files:plan.files.length}));
 }else if(mode==='apply'){
  requireValue(args.includes('--plan'),'--plan required');console.log(JSON.stringify(apply(JSON.parse(fs.readFileSync(get('--plan'))))));
 }else throw Error(`use verify --home, preview --home --database --id --plan, or apply --plan (example runtime ${DEFAULT_RUNTIME})`);
}

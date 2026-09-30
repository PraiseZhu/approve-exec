#!/usr/bin/env node
// Source-only deployer. No scheduler or database writes; apply requires a saved preview.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNTIME='/Users/praise/AI-Agent/Claude/projects/Project CINDY/_ops/cindy-watcher';
export const FILES=['cindy-feedback-policy.mjs','cindy-ci.mjs','cindy-pr-policy.mjs','cindy-pr-snapshot.mjs','cindy-repair.mjs','cindy-review-resolve.mjs','cindy-state.mjs','cindy-ownership.mjs','cindy-watcher.mjs','cindy-review-status.mjs','session-title.mjs','cindy-watch-script.py','protocol.py','session-title-maintenance.py'];
// Entry points actually spawned/imported directly by the runtime. Any relative import reachable
// from these (transitively) must be listed in FILES, or the runtime will 500 on `import()` with
// a healthy-looking manifest (2026-09-29 incident: cindy-review-resolve.mjs was imported by
// cindy-watcher.mjs but missing from FILES; verify() still reported all-green because it only
// hashes what's in FILES, never what the entry points actually require).
const ENTRY_POINTS=['cindy-watcher.mjs','cindy-repair.mjs'];
const sha=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const requireValue=(v,m)=>{if(!v)throw Error(m);};
function relativeImportNames(file){
 if(!fs.existsSync(file))return [];
 const src=fs.readFileSync(file,'utf8');
 return [...src.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(m=>m[1]);
}
function importClosure(sourceDir,entry){
 const seen=new Set(),stack=[entry];
 while(stack.length){
  const name=stack.pop();
  if(seen.has(name))continue;
  seen.add(name);
  for(const dep of relativeImportNames(path.join(sourceDir,name)))stack.push(dep);
 }
 return seen;
}
export function checkManifestCompleteness(sourceDir=path.join(here,'bin')){
 const missing=new Set();
 for(const entry of ENTRY_POINTS){
  if(!FILES.includes(entry))continue;
  for(const name of importClosure(sourceDir,entry))if(!FILES.includes(name))missing.add(name);
 }
 requireValue(missing.size===0,`deploy manifest missing modules imported by entry points: ${[...missing].join(', ')}`);
}
export function verify(runtime,source=path.join(here,'bin')) {
 checkManifestCompleteness(source);
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
 if(!fs.existsSync(stateFile)) return [];
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
 const legacy=sha(path.join(home,'state/state.json'));
 return legacy ?? createHash('sha256').update('empty-runtime').digest('hex');
}
export function bootstrap(home){
 requireValue(home&&path.isAbsolute(home),'absolute --home required');
 fs.mkdirSync(path.join(home,'bin'),{recursive:true,mode:0o700});
 fs.mkdirSync(path.join(home,'state','prs'),{recursive:true,mode:0o700});
 fs.mkdirSync(path.join(home,'config'),{recursive:true,mode:0o700});
 const index=path.join(home,'state/index.json');
 if(!fs.existsSync(index)) fs.writeFileSync(index,`${JSON.stringify({version:2,bootstrappedAt:new Date().toISOString()},null,2)}\n`,{mode:0o600});
 const optout=path.join(home,'config/optout.json');
 if(!fs.existsSync(optout)) fs.writeFileSync(optout,'[]\n',{mode:0o600});
 return {home,bootstrapped:true,stateSha:stateFingerprint(home),sessionIds:identities(home)};
}
function idle(database,ids){
 if(!ids.length)return;
 const rows=JSON.parse(execFileSync('sqlite3',['-readonly','-json',database,`select id,active_turn_pid from sessions where id in (${ids.map(v=>`'${v}'`).join(',')})`],{encoding:'utf8'}));
 requireValue(rows.length===ids.length&&rows.every(r=>r.active_turn_pid===null),'Host session active or missing');
}
export function validatePlan(plan){
 checkManifestCompleteness();
 requireValue(plan?.version===1&&path.isAbsolute(plan.home)&&path.isAbsolute(plan.database)&&plan.database.endsWith('.db'),'invalid runtime/database');
 requireValue(/^[a-z0-9][a-z0-9-]{1,80}$/.test(plan.id),'invalid release id');
 requireValue(Array.isArray(plan.files)&&plan.files.length===FILES.length&&new Set(plan.files.map(f=>f.name)).size===FILES.length&&plan.files.every(f=>FILES.includes(f.name)&&/^[a-f0-9]{64}$/.test(f.source)&&(f.runtime===null||/^[a-f0-9]{64}$/.test(f.runtime))),'invalid artifact manifest');
 requireValue(/^[a-f0-9]{64}$/.test(plan.stateSha),'missing state identity');
 requireValue(Array.isArray(plan.sessionIds),'missing session identities');
}
export function apply(plan){
 validatePlan(plan);
 fs.mkdirSync(path.join(plan.home,'bin'),{recursive:true,mode:0o700});
 fs.mkdirSync(path.join(plan.home,'state'),{recursive:true,mode:0o700});
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
  if(!args.includes('--home')){
   checkManifestCompleteness();
   const files=FILES.map(name=>({name,source:sha(path.join(here,'bin',name))}));
   const match=files.every(v=>v.source);
   console.log(JSON.stringify({files,match,sourceOnly:true}));
   if(!match)process.exitCode=1;
  }else{
   const runtime=get('--home');requireValue(path.isAbsolute(runtime),'--home required');
   const files=verify(runtime);console.log(JSON.stringify({files,match:files.every(v=>v.source&&v.source===v.runtime)}));
   if(!files.every(v=>v.source&&v.source===v.runtime))process.exitCode=1;
  }
 }else if(mode==='bootstrap'){
  const home=get('--home');requireValue(args.includes('--home')&&path.isAbsolute(home),'--home required');
  console.log(JSON.stringify(bootstrap(home)));
 }else if(mode==='preview'){
  const home=get('--home'),database=get('--database'),id=get('--id'),file=get('--plan');
  requireValue(['--home','--database','--id','--plan'].every(k=>args.includes(k))&&path.isAbsolute(file),'explicit home/database/id/absolute plan required');
  if(!fs.existsSync(path.join(home,'state'))) bootstrap(home);
  const plan={version:1,home,database,id,files:verify(home),stateSha:stateFingerprint(home),sessionIds:identities(home)};
  validatePlan(plan);idle(database,plan.sessionIds);fs.writeFileSync(file,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({mode:'preview',plan:file,files:plan.files.length}));
 }else if(mode==='apply'){
  requireValue(args.includes('--plan'),'--plan required');console.log(JSON.stringify(apply(JSON.parse(fs.readFileSync(get('--plan'))))));
 }else throw Error(`use verify [--home], bootstrap --home, preview --home --database --id --plan, or apply --plan (example runtime ${DEFAULT_RUNTIME})`);
}

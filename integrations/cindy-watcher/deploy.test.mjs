import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FILES,verify,validatePlan,apply,stateFingerprint,bootstrap} from './deploy.mjs';
function fixture(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-deploy-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'bin'));fs.mkdirSync(path.join(home,'state'));
 fs.writeFileSync(path.join(home,'state/state.json'),JSON.stringify({prs:{}}));
 for(const name of FILES)fs.writeFileSync(path.join(home,'bin',name),'old bytes');
 const state=fs.readFileSync(path.join(home,'state/state.json'));
 const plan={version:1,home,database:path.join(home,'metadata.db'),id:'fixture-release',files:verify(home),stateSha:createHash('sha256').update(state).digest('hex'),sessionIds:[]};
 return {home,plan,state};
}
test('full source deploy preserves state and verifies all artifact hashes',t=>{
 const f=fixture(t),r=apply(f.plan);assert.equal(r.status,'installed');assert.equal(r.stateChanged,false);assert.equal(verify(f.home).filter(v=>v.source===v.runtime).length,FILES.length);assert.deepEqual(fs.readFileSync(path.join(f.home,'state/state.json')),f.state);
 assert.ok(FILES.includes('cindy-feedback-policy.mjs'));
 assert.ok(FILES.includes('cindy-state.mjs'));
 assert.ok(FILES.includes('cindy-ownership.mjs'));
 assert.equal(fs.readFileSync(path.join(f.home,'deployments/fixture-release/before/cindy-watcher.mjs'),'utf8'),'old bytes');
});
test('state drift and source drift refuse before lease',t=>{
 const f=fixture(t);f.plan.files[0].source='a'.repeat(64);assert.throws(()=>apply(f.plan),/source changed/);assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
 f.plan.files=verify(f.home);fs.writeFileSync(path.join(f.home,'state/state.json'),'{}');assert.throws(()=>apply(f.plan),/state changed/);
});
test('held lease is never stolen',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.home,'state/lease'),'someone');assert.throws(()=>apply(f.plan),/EEXIST/);assert.equal(fs.readFileSync(path.join(f.home,'state/lease'),'utf8'),'someone');
});
test('artifact injection or missing dependency rejected',t=>{
 const {plan}=fixture(t);assert.throws(()=>validatePlan({...plan,files:plan.files.slice(1)}),/manifest/);assert.throws(()=>validatePlan({...plan,files:[{...plan.files[0],name:'../state.json'},...plan.files.slice(1)]}),/manifest/);
});
test('mid-install failure rolls back installed files and releases own lease',t=>{
 const f=fixture(t),rename=fs.renameSync;let failed=false;
 fs.renameSync=(from,to)=>{if(!failed&&to.endsWith('cindy-pr-policy.mjs')&&from.includes('.install-')){failed=true;throw Error('injected failure');}return rename(from,to);};
 try{assert.throws(()=>apply(f.plan),/injected/);}finally{fs.renameSync=rename;}
 for(const name of FILES)assert.equal(fs.readFileSync(path.join(f.home,'bin',name),'utf8'),'old bytes');
 assert.deepEqual(fs.readFileSync(path.join(f.home,'state/state.json')),f.state);assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
});
test('legacy deploy symlink invokes CLI and cannot silently succeed',t=>{
 const f=fixture(t),link=path.join(f.home,'legacy-deploy.mjs');fs.symlinkSync(fileURLToPath(new URL('./deploy.mjs',import.meta.url)),link);
 const result=spawnSync(process.execPath,[link,'verify','--home',f.home],{encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).match,false);
});
test('new policy artifact is installed and removed again on failed deployment',t=>{
 const f=fixture(t),name='cindy-feedback-policy.mjs';
 fs.unlinkSync(path.join(f.home,'bin',name));f.plan.files=verify(f.home);
 assert.equal(f.plan.files.find(item=>item.name===name).runtime,null);
 const rename=fs.renameSync;let failed=false;
 fs.renameSync=(from,to)=>{if(!failed&&to.endsWith('cindy-pr-policy.mjs')&&from.includes('.install-')){failed=true;throw Error('injected after new module');}return rename(from,to);};
 try{assert.throws(()=>apply(f.plan),/injected after new module/);}finally{fs.renameSync=rename;}
 assert.equal(fs.existsSync(path.join(f.home,'bin',name)),false);
 assert.deepEqual(fs.readFileSync(path.join(f.home,'state/state.json')),f.state);
 assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
});
test('state fingerprint includes PR file content hashes',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-fp-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'state/prs'),{recursive:true});
 fs.writeFileSync(path.join(home,'state/index.json'),'{"version":2}\n');
 fs.writeFileSync(path.join(home,'state/prs/PR_1.json'),'{"sessionId":"a"}\n');
 const first=stateFingerprint(home);
 fs.writeFileSync(path.join(home,'state/prs/PR_1.json'),'{"sessionId":"b"}\n');
 assert.notEqual(stateFingerprint(home),first);
});
test('manifest missing a dependency imported by an entry point is rejected', t => {
 const source = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-manifest-'));
 t.after(() => fs.rmSync(source, { recursive: true, force: true }));
 for (const name of FILES) fs.writeFileSync(path.join(source, name), name.endsWith('.mjs') ? 'export const x = 1;\n' : '# stub\n');
 // cindy-watcher.mjs is an entry point; make it import a module that is not in FILES.
 fs.writeFileSync(path.join(source, 'cindy-watcher.mjs'), "import { x } from './not-in-manifest.mjs';\nexport { x };\n");
 assert.throws(() => verify(source, source), /not-in-manifest\.mjs/);
});
test('validatePlan (used by apply) also enforces manifest completeness, not just verify()', t => {
 const f = fixture(t);
 const realFile = fileURLToPath(new URL('./bin/cindy-watcher.mjs', import.meta.url));
 const original = fs.readFileSync(realFile, 'utf8');
 t.after(() => fs.writeFileSync(realFile, original));
 fs.writeFileSync(realFile, original + "\nimport { y } from './not-in-manifest-either.mjs';\n");
 assert.throws(() => validatePlan(f.plan), /not-in-manifest-either\.mjs/);
});
test('bootstrap then apply works when runtime has no old files', t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-empty-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const boot=bootstrap(home);
 assert.equal(fs.existsSync(path.join(home,'config/optout.json')),true);
 assert.match(boot.stateSha,/^[a-f0-9]{64}$/);
 assert.deepEqual(boot.sessionIds,[]);
 const plan={version:1,home,database:path.join(home,'metadata.db'),id:'first-release',files:verify(home),stateSha:boot.stateSha,sessionIds:[]};
 validatePlan(plan);
 const r=apply(plan);
 assert.equal(r.status,'installed');
 assert.equal(verify(home).every(v=>v.source&&v.source===v.runtime),true);
});

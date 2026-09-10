import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPrSnapshotSync,collectPrOwnership} from './bin/mivo-pr-snapshot.mjs';
const basic={id:'PR_1',number:1,title:'t',state:'OPEN',isDraft:false,headRefOid:'a'.repeat(40),headRefName:'feature',baseRefOid:'b'.repeat(40),baseRefName:'main',createdAt:'2026-09-09T00:00:00Z',author:{login:'owner'},isCrossRepository:false,headRepository:{name:'mivo-canvas-plugin'},headRepositoryOwner:{login:'xindong'}};
function fixture({overflow=false,broken=false,drift=false}={}){
 let childCalls=0,views=0,total=0;
 const page=(nodes,hasNextPage=false,endCursor=null)=>({nodes,pageInfo:{hasNextPage,endCursor}});
 const ghFn=args=>{
  total++;
  if(args[1]==='view')return JSON.stringify({...basic,...(++views>1&&drift?{author:{login:'other'}}:{})});
  if(args[1]==='checks')return '[]';
  if(args[1].startsWith('repos/'))return '[[]]';
  const q=args.at(-1),field=['timelineItems','reviewThreads','comments','reviews','labels'].find(f=>q.includes(f+'('));
  let value=page([]);
  if(field==='reviewThreads')value=page(Array.from({length:80},(_,i)=>({id:`T${i}`,isResolved:false,isOutdated:false,comments:page([{id:`C${i}`,body:'x'}],overflow&&i===0,broken?null:'next')})));
  if(field==='comments'){childCalls++;assert.match(q,/after:"next"/);value=page([{id:'overflow',body:'y'}]);}
  return JSON.stringify({data:{node:{[field]:value}}});
 };
 return {ghFn,counts:()=>({childCalls,total})};
}
test('80 threads use one embedded page, not 80 child requests',()=>{
 const f=fixture(),s=collectPrSnapshotSync({pr:{number:1},ghFn:f.ghFn});assert.equal(s.threads.length,80);assert.equal(s.threads[79].comments[0].id,'C79');assert.equal(f.counts().childCalls,0);
});
test('embedded overflow resumes only unfinished thread without dropping comments',()=>{
 const f=fixture({overflow:true}),s=collectPrSnapshotSync({pr:{number:1},ghFn:f.ghFn});assert.deepEqual(s.threads[0].comments.map(c=>c.id),['C0','overflow']);assert.equal(f.counts().childCalls,1);
});
test('missing embedded continuation fails closed',()=>assert.throws(()=>collectPrSnapshotSync({pr:{number:1},ghFn:fixture({overflow:true,broken:true}).ghFn}),/cursor/));
test('ownership last-moment reads four identity/epoch calls, no feedback',()=>{
 const f=fixture(),g=collectPrOwnership({pr:{number:1},ghFn:f.ghFn});let s=g.next();while(!s.done)s=g.next(s.value());assert.equal(s.value.pr.author.login,'owner');assert.equal(f.counts().total,4);
});
test('ownership lightweight path refuses changed author',()=>{
 const f=fixture({drift:true}),g=collectPrOwnership({pr:{number:1},ghFn:f.ghFn});assert.throws(()=>{let s=g.next();while(!s.done)s=g.next(s.value());},/owner/);
});

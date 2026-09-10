import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicReview, verdictComment} from './bin/public-review.mjs';
const h='a'.repeat(40),b='b'.repeat(40);
function fixture(verdict='APPROVE') {
  const comment={id:12,user:{id:41898282,login:'github-actions[bot]',type:'Bot'},created_at:'2026-09-10T00:10:00Z',updated_at:'2026-09-10T00:10:00Z',
    body:`## 🤖 自动 Review 结论：${verdict}\n三席聚合：CRITICAL 0 · HIGH 0 · MEDIUM 0\n<!-- review-complete head_sha=${h} base_sha=${b} -->`};
  return {snapshot:{pr:{state:'OPEN',isDraft:false,sameRepository:true,number:10,headRefOid:h,baseRefOid:b,releaseEpoch:'ready:2026-09-10T00:00:00Z',author:{login:'owner'}},comments:[comment],requiredChecksGreen:true,mergeable:'MERGEABLE',threads:[],reviews:[],labels:[]},
    runs:[{id:3,run_attempt:1,display_title:'Code Review [pr:10]',event:'pull_request_target',path:'.github/workflows/code-review.yml',repository:{full_name:'xindong/mivo-canvas-plugin'},head_sha:h,pull_requests:[{number:10,head:{sha:h},base:{sha:b}}],status:'completed',conclusion:'success',run_started_at:'2026-09-10T00:05:00Z',updated_at:'2026-09-10T00:11:00Z'}],
    jobs:{3:['gate','seat1','seat2','seat3','publish'].map(name=>({name,run_id:3,run_attempt:1,status:'completed',conclusion:'success'}))}};
}
test('current APPROVE uses production PR-head run binding without native bundle',()=>assert.equal(evaluatePublicReview(fixture()).ready,true));
for (const verdict of ['COMMENT','REQUEST_CHANGES','REFUSE','INCOMPLETE','PARSE-FAILED','CI-NOT-GREEN']) test(`${verdict} is not passed`,()=>assert.equal(evaluatePublicReview(fixture(verdict)).ready,false));
for (const verdict of ['SKIP-LLM','SKIP-LOCAL']) test(`classified ${verdict} needs gate but no paid seats`,()=>{const f=fixture(verdict);f.jobs[3]=f.jobs[3].slice(0,1);assert.equal(evaluatePublicReview(f).ready,true);});
for (const change of ['head','base','bot','edited','epoch','ci','conflict','thread','veto','draft','closed','jobs','newer','count']) test(`reject ${change}`,()=>{
  const f=fixture(),s=f.snapshot,c=s.comments[0];
  if(change==='head')s.pr.headRefOid='c'.repeat(40);
  if(change==='base')s.pr.baseRefOid='c'.repeat(40);
  if(change==='bot')c.user.id=1;
  if(change==='edited')c.updated_at='2026-09-10T00:12:00Z';
  if(change==='epoch')s.pr.releaseEpoch='ready:2026-09-10T00:20:00Z';
  if(change==='ci')s.requiredChecksGreen=false;
  if(change==='conflict')s.mergeable='CONFLICTING';
  if(change==='thread')s.threads=[{isResolved:false}];
  if(change==='veto')s.reviewDecision='CHANGES_REQUESTED';
  if(change==='draft')s.pr.isDraft=true;
  if(change==='closed')s.pr.state='CLOSED';
  if(change==='jobs')f.jobs[3][1].conclusion='skipped';
  if(change==='newer')f.runs.push({...f.runs[0],id:4,status:'in_progress',conclusion:null,run_started_at:'2026-09-10T00:12:00Z'});
  if(change==='count')c.body=c.body.replace('MEDIUM 0','MEDIUM 1');
  assert.equal(evaluatePublicReview(f).ready,false);
});
test('later unsealed infrastructure failure invalidates old pass',()=>{const f=fixture();f.snapshot.comments.push({...f.snapshot.comments[0],id:13,created_at:'2026-09-10T00:12:00Z',updated_at:'2026-09-10T00:12:00Z',body:`mivo-code-review depth=INCOMPLETE head_sha=${h}\n## 🤖 自动 Review 结论：INCOMPLETE`});assert.equal(evaluatePublicReview(f).ready,false);});
test('new external comment invalidates old pass',()=>{const f=fixture();f.snapshot.comments.push({id:14,user:{login:'reviewer'},created_at:'2026-09-10T00:12:00Z',body:'regression'});assert.equal(evaluatePublicReview(f).ready,false);});
test('P0/P1/P2 summary accepted after publisher display-only migration',()=>{const f=fixture();f.snapshot.comments[0].body=f.snapshot.comments[0].body.replace('CRITICAL','P0').replace('HIGH','P1').replace('MEDIUM','P2');assert.equal(evaluatePublicReview(f).ready,true);});

import test from 'node:test';
import assert from 'node:assert/strict';
import {policyCiResult} from './bin/cindy-repair.mjs';
test('BASE required policy green can finish without GitHub branch-required list',()=>{
 const r=policyCiResult({status:'green',policyHash:'bound',required:[{context:'lint',status:'green',evidence:{sha:'head'}}]},'head');
 assert.equal(r.requiredGreen,true);assert.equal(r.requiredChecks[0].bucket,'pass');assert.equal(r.policyHash,'bound');
});
test('failed or unknown policy cannot become green',()=>{
 for(const status of ['failed','unknown','pending'])assert.equal(policyCiResult({status,required:[{context:'lint',status}]},'head').requiredGreen,false);
 assert.equal(policyCiResult({status:'failed',required:[{context:'lint',status:'failed'}]},'head').requiredChecks[0].bucket,'fail');
});

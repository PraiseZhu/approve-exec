import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('owner_continuation', ROOT / 'scripts/owner_continuation.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class Rpc:
    def __init__(self, error=None): self.calls=[]; self.error=error
    def call(self, method, params):
        self.calls.append((method, params))
        if self.error: raise self.error
        return {'target_session_id': params['target_session_id'], 'wake_kind': 'resumed'}


class OwnerContinuationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
        self.db=self.root/'host.db'
        with sqlite3.connect(self.db) as c:
            c.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,active_turn_pid INTEGER)')
            c.executemany('INSERT INTO sessions VALUES(?,?,?)',[('lead','active',None),('owner1','active',None),('owner2','active',None)])
        auth=self.root/'authorization.md';auth.write_text('Approved full package owner implementation and delivery')
        self.cfg={'schemaVersion':2,'package_id':'package-1','lead_session_id':'lead','session_metadata_db':str(self.db),
                  'expected_group_ids':['PR1','PR2'],'authorization_path':str(auth),'authorization_sha256':hashlib.sha256(auth.read_bytes()).hexdigest(),'owners':[],
                  'schedule_timeout_sec':150,'stalled_after_sec':30,'retry_after_sec':5}
        for i in [1,2]:
            sid=f'owner{i}'; group=f'PR{i}'; ledger=self.root/f'{group}.ledger.json'; point=self.root/f'{group}.checkpoint.json'
            ledger.write_text(json.dumps({'manifest_core_hash':'manifest','waves':[{'groups':[{'group_id':group,'session_id':sid,'assignment_seq':0,'branch':f'feature/{group}','state':'executing'}]}]}))
            point.write_text(json.dumps({'schemaVersion':1,'group_id':group,'session_id':sid,'assignment_seq':0,'phase':'executing','progress':{'step':'implement','head':'a'*40,'passed_scs':[]}}))
            self.cfg['owners'].append({'group_id':group,'session_id':sid,'assignment_seq':0,'ledger_path':str(ledger),'checkpoint_path':str(point),'manifest_core_hash':'manifest','completion':'delivered'})
        self.state={};self.client=Rpc();self.writes=[]
    def tearDown(self): self.tmp.cleanup()
    def run_tick(self,now=100,**kwargs):
        return m.run(self.cfg,self.state,rpc=kwargs.pop('rpc',self.client),now=now,write=lambda s:self.writes.append(json.loads(json.dumps(s))),**kwargs)
    def point(self,index,**updates):
        p=Path(self.cfg['owners'][index]['checkpoint_path']); d=json.loads(p.read_text());d.update(updates);p.write_text(json.dumps(d))
    def test_idle_direct_owner_busy_never_catalyzed_and_no_lead(self):
        with sqlite3.connect(self.db) as c:c.execute("UPDATE sessions SET active_turn_pid=999 WHERE id='owner2'")
        before=self.db.read_bytes();self.run_tick(); self.run_tick(101)
        self.assertEqual([p['target_session_id'] for _,p in self.client.calls],['owner1'])
        self.assertEqual(self.db.read_bytes(),before)
        self.assertEqual(self.state['outcomes']['PR2:0'],'busy')
    def test_observation_metadata_does_not_reset_progress_or_dispatch(self):
        self.run_tick();self.point(0,checked_at='new',updated_at='new');self.run_tick(110)
        self.assertEqual(len(self.client.calls),2)
        self.assertEqual(self.state['owners']['PR1:0']['last_progress_at'],100)
    def test_ci_and_window_wait_without_rpc(self):
        self.point(0,phase='waiting-ci',repo='xindong/mivo-canvas-plugin',pr_number=1)
        self.point(1,phase='waiting-window',resume_after_epoch=1000)
        self.run_tick(evidence_fn=lambda _: {'status':'pending'})
        self.assertEqual(len(self.client.calls),0)
        self.run_tick(110,evidence_fn=lambda _: {'status':'green'})
        self.assertEqual([p['target_session_id'] for _,p in self.client.calls],['owner1'])
    def test_unknown_blocks_even_new_checkpoint_and_never_repeats(self):
        class E(Exception): code='TRANSPORT_CLOSED'
        rpc=Rpc(E('response lost'));self.run_tick(rpc=rpc)
        self.point(0,progress={'step':'new-step','head':'b'*40});self.run_tick(1000,rpc=rpc)
        self.assertEqual(len([p for _,p in rpc.calls if p['target_session_id']!='lead']),2)
        self.assertTrue(all(i['status']=='unknown' for i in self.state['intents'].values()))
    def test_rejected_retry_limit_grant_preserves_error_and_busy_does_not_consume_grant(self):
        class E(Exception): code='HOST_NOT_READY'
        rpc=Rpc(E('host temporarily unavailable'))
        for t in [100,106,112,118]: self.run_tick(t,rpc=rpc)
        self.assertEqual(len([p for _,p in rpc.calls if p['target_session_id']!='lead']),6)
        key,nextintent=next(iter(self.state['intents'].items()))
        self.cfg['recovery_grants']=[{'request_id':key,'target_session_id':nextintent['target_session_id'],'authorization_ref':'host recovered receipt','grant_id':'grant1'}]
        target=nextintent['target_session_id']
        with sqlite3.connect(self.db) as c:c.execute('UPDATE sessions SET active_turn_pid=1 WHERE id=?',(target,))
        self.run_tick(125,rpc=rpc);self.assertNotIn('grant1',nextintent.get('used_grants',[]))
        with sqlite3.connect(self.db) as c:c.execute('UPDATE sessions SET active_turn_pid=NULL WHERE id=?',(target,))
        self.run_tick(130,rpc=rpc);self.assertEqual(len([p for _,p in rpc.calls if p['target_session_id']!='lead']),7)
        self.assertEqual(self.state['intents'][key]['attempts'],4)
        self.run_tick(140,rpc=rpc);self.assertEqual(len([p for _,p in rpc.calls if p['target_session_id']!='lead']),7)
    def test_no_progress_three_bounded_owner_recoveries_then_single_lead_decision(self):
        for t in [100,131,162,193,224,255]:self.run_tick(t)
        ownercalls=[p for _,p in self.client.calls if p['target_session_id']!='lead']
        self.assertEqual(len(ownercalls),8)
        self.assertEqual(len([p for _,p in self.client.calls if p['target_session_id']=='lead']),1)
    def test_delivery_claim_alone_cannot_complete(self):
        self.point(0,phase='delivered')
        self.run_tick(evidence_fn=lambda _: {'verified':False})
        self.assertNotEqual(self.state['status'],'complete')
        self.assertEqual(self.state['outcomes']['PR1:0'],'blocked-evidence')
    def test_explicit_delivery_contract_terminal_waits_all_then_single_lead_event(self):
        self.point(0,phase='delivered');self.run_tick(evidence_fn=lambda _: {'verified':True})
        self.assertNotEqual(self.state['status'],'complete')
        self.point(1,phase='delivered');self.run_tick(102,evidence_fn=lambda _: {'verified':True});self.run_tick(103,evidence_fn=lambda _: {'verified':True})
        self.assertEqual(self.state['status'],'complete')
        self.assertEqual(len([p for _,p in self.client.calls if p['target_session_id']=='lead']),1)
    def test_legacy_unknown_cannot_be_laundered_by_recovery_grant(self):
        self.state.update(version=1,pending={'target_session_id':'lead'},status='pending-receipt',dispatch_error_code='TRANSPORT_CLOSED')
        self.cfg['legacy_recovery']={'previous_state_digest':m.digest(self.state),'grant_id':'g','authorization_ref':'oldscope'}
        self.run_tick();self.assertTrue(self.state['legacy_lead_blocked']);self.assertEqual(self.state['legacy']['status'],'pending-receipt')
    def test_legacy_confirmed_refusal_latch_recovers_only_exact_authorized_digest(self):
        self.state.update(version=1,pending={'target_session_id':'lead'},status='blocked',dispatch_error_code='HOST_NOT_READY',retryable_attempts=3)
        self.cfg['legacy_recovery']={'previous_state_digest':m.digest(self.state),'grant_id':'g','authorization_ref':'host recovery evidence'}
        self.run_tick();self.assertFalse(self.state['legacy_lead_blocked']);self.assertEqual(self.state['legacy']['retryable_attempts'],3)
    def test_real_jsonl_host_frames_route_existing_idle_owner(self):
        self.cfg['owners']=self.cfg['owners'][:1];self.cfg['expected_group_ids']=['PR1']
        config=self.root/'config.json';config.write_text(json.dumps(self.cfg))
        frames=[{'protocol':'cindy-script/1','type':'start','context':{}},
                {'protocol':'cindy-script/1','type':'call_result','id':'py-1','ok':True,'result':{'methods':['sessions.dispatch'],'granted':['sessions.dispatch']}},
                {'protocol':'cindy-script/1','type':'call_result','id':'py-2','ok':True,'result':{'target_session_id':'owner1','wake_kind':'resumed'}}]
        before=self.db.read_bytes()
        p=subprocess.run(['python3','-B',str(ROOT/'scripts/lead-continuation.py'),'--config',str(config)],input='\n'.join(map(json.dumps,frames))+'\n',capture_output=True,text=True,env={**os.environ,'CINDY_SCRIPT_PROTOCOL':'1'})
        self.assertEqual(p.returncode,0,p.stderr)
        calls=[json.loads(line) for line in p.stdout.splitlines() if json.loads(line).get('method')=='sessions.dispatch']
        self.assertEqual(len(calls),1);self.assertEqual(calls[0]['params']['target_session_id'],'owner1')
        self.assertEqual(before,self.db.read_bytes())

    def test_scope_subset_cannot_claim_full_package_completion(self):
        self.cfg['owners']=self.cfg['owners'][:1]
        with self.assertRaisesRegex(ValueError,'full approved group scope'):self.run_tick()
    def test_writer_produces_bound_checkpoint_without_touching_ledger(self):
        owner=self.cfg['owners'][0]; before=Path(owner['ledger_path']).read_bytes()
        result=subprocess.run(['python3','-B',str(ROOT/'scripts/owner-checkpoint.py'),'--ledger',owner['ledger_path'],'--group','PR1','--checkpoint',owner['checkpoint_path'],'--phase','waiting-ci','--step','ci','--repo','xindong/mivo-canvas-plugin','--pr-number','1','--head','a'*40],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(Path(owner['checkpoint_path']).read_text())['session_id'],'owner1')
        self.assertEqual(Path(owner['ledger_path']).read_bytes(),before)
    def test_preview_preserves_missing_future_scope_and_cannot_execute(self):
        status=self.root/'status.json';status.write_text(json.dumps({'prs':[{'pr_id':'PR1','session_id':'owner1'},{'pr_id':'PR2','session_id':'owner2'},{'pr_id':'PR3','session_id':None}]}))
        cfg=self.root/'legacy.json';cfg.write_text(json.dumps({'lead_session_id':'lead','ledger_paths':[o['ledger_path'] for o in self.cfg['owners']],'status_path':str(status)}))
        result=subprocess.run(['python3','-B',str(ROOT/'scripts/preview-owner-continuation.py'),'--config',str(cfg),'--authorization',self.cfg['authorization_path'],'--session-metadata-db',str(self.db),'--package-id','package-1'],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);preview=json.loads(result.stdout)
        self.assertFalse(preview['ready']);self.assertIn('PR3',preview['config']['expected_group_ids'])
        self.assertEqual(preview['config']['scopePending'][0]['group_id'],'PR3')
        self.assertIn('--initialize-from-ledger',preview['checkpoint_initialization'][0]['command'])
        with self.assertRaisesRegex(ValueError,'preview config'):m.validate_config(preview['config'])
    def test_approved_legacy_archive_uses_existing_receipts_and_preserves_ledger(self):
        self.cfg['owners'][0]['completion']='approved-legacy-archive'
        before=Path(self.cfg['owners'][0]['ledger_path']).read_bytes()
        self.run_tick(legacy_archive_fn=lambda owner: owner['group_id']=='PR1')
        self.assertEqual(self.state['outcomes']['PR1:0'],'complete')
        self.assertEqual(Path(self.cfg['owners'][0]['ledger_path']).read_bytes(),before)
    def test_busy_race_after_intent_does_not_send(self):
        counts={}
        def moving(db,target):
            counts[target]=counts.get(target,0)+1
            return {'status':'active','busy':counts[target]>1,'session_id':target}
        self.run_tick(metadata_fn=moving)
        self.assertEqual(self.client.calls,[])
        self.assertTrue(all(i['status']=='deferred' for i in self.state['intents'].values()))
    def test_released_pr_waiting_ci_cannot_wake_local_owner_for_review_work(self):
        self.point(0,phase='waiting-ci',repo='xindong/mivo-canvas-plugin',pr_number=1)
        self.run_tick(evidence_fn=lambda _: {'status':'failed','isDraft':False,'state':'OPEN'})
        self.assertNotIn('owner1',[p['target_session_id'] for _,p in self.client.calls])
        self.assertEqual(self.state['outcomes']['PR1:0'],'blocked-evidence')


    def test_verified_delivery_still_resumes_archive_only(self):
        self.cfg['owners'][0]['completion']='archived'
        self.point(0,phase='delivered',repo='xindong/mivo-canvas-plugin',pr_number=1)
        self.run_tick(evidence_fn=lambda _: {'verified':True,'isDraft':False,'state':'OPEN'})
        calls=[p for _,p in self.client.calls if p['target_session_id']=='owner1']
        self.assertEqual(len(calls),1);self.assertIn('Only complete',calls[0]['message'])
    def test_scheduler_timeout_must_cover_all_owner_probes(self):
        self.cfg['schedule_timeout_sec']=60
        with self.assertRaisesRegex(ValueError,'schedule_timeout_sec'):self.run_tick()
    def test_stale_executing_and_window_after_ready_never_resume_local_edits(self):
        for i,phase in enumerate(['executing','waiting-window']):
            self.point(i,phase=phase,repo='xindong/mivo-canvas-plugin',pr_number=i+1,resume_after_epoch=1)
        self.run_tick(evidence_fn=lambda _: {'isDraft':False,'state':'OPEN'})
        self.assertEqual([p['target_session_id'] for _,p in self.client.calls],['lead'])
        self.assertEqual(self.state['outcomes']['PR1:0'],'blocked-evidence')
        self.assertEqual(self.state['outcomes']['PR2:0'],'blocked-evidence')
    def test_late_legacy_grant_gives_one_attempt_not_a_reset(self):
        self.state.update(version=1,pending={'target_session_id':'lead'},status='blocked',dispatch_error_code='HOST_NOT_READY',retryable_attempts=3)
        old_digest=m.digest(self.state)
        self.point(0,phase='decision',decision={'id':'d','evidence_path':'fixture'})
        self.run_tick()
        self.assertTrue(self.state['legacy_lead_blocked'])
        self.cfg['legacy_recovery']={'previous_state_digest':old_digest,'grant_id':'late','authorization_ref':'authorized recovery'}
        class E(Exception): code='HOST_NOT_READY'
        rpc=Rpc(E('host temporarily unavailable'))
        self.run_tick(200,rpc=rpc);self.run_tick(300,rpc=rpc)
        calls=[p for _,p in rpc.calls if p['target_session_id']=='lead']
        self.assertEqual(len(calls),1)
        self.assertEqual(self.state['intents'][self.state['legacy_request_id']]['attempts'],4)
    def test_busy_second_check_preserves_recovery_grant_and_attempts(self):
        self.state={'intents':{'r':{'status':'rejected','attempts':3,'attempted_at':1,'target_session_id':'owner1'}}}
        self.cfg['recovery_grants']=[{'request_id':'r','target_session_id':'owner1','grant_id':'g','authorization_ref':'approved'}]
        count=[0]
        def moving(db,target):
            count[0]+=1
            return {'status':'active','busy':count[0]==2}
        result=m.dispatch(self.cfg,self.state,'r','owner1','work',self.client,100,lambda _:None,moving)
        self.assertEqual(result,'busy');self.assertEqual(self.client.calls,[])
        self.assertEqual(self.state['intents']['r']['attempts'],3)
        self.assertNotIn('g',self.state['intents']['r'].get('used_grants',[]))


    def test_pending_scope_does_not_block_bound_owners_and_notifies_lead_once(self):
        self.cfg['expected_group_ids'].append('PR3')
        self.cfg['scopePending']=[{'group_id':'PR3','reason':'unassigned','status_path':str(self.root/'status.json'),'status_item_sha256':'pinned'}]
        self.run_tick();self.run_tick(101)
        targets=[p['target_session_id'] for _,p in self.client.calls]
        self.assertEqual(targets.count('owner1'),1);self.assertEqual(targets.count('owner2'),1);self.assertEqual(targets.count('lead'),1)
        self.point(0,phase='delivered');self.point(1,phase='delivered')
        self.run_tick(102,evidence_fn=lambda _: {'verified':True})
        self.assertNotEqual(self.state['status'],'complete')
        self.assertEqual(self.state['outcomes']['scope:PR3'],'decision')
    def test_pending_scope_duplicate_or_unidentified_cannot_hide_assignment(self):
        self.cfg['scopePending']=[{'group_id':'PR1','reason':'unassigned','status_path':str(self.root/'status.json'),'status_item_sha256':'pinned'}]
        with self.assertRaisesRegex(ValueError,'pending scope identity'):self.run_tick()
    def test_initialize_checkpoint_claims_only_reconciliation_and_never_completion(self):
        owner=self.cfg['owners'][0];path=Path(owner['checkpoint_path']);path.unlink()
        before=Path(owner['ledger_path']).read_bytes()
        command=['python3','-B',str(ROOT/'scripts/owner-checkpoint.py'),'--ledger',owner['ledger_path'],'--group','PR1','--checkpoint',str(path),'--initialize-from-ledger']
        p=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(p.returncode,0,p.stderr)
        point=json.loads(path.read_text())
        self.assertEqual(point['phase'],'reconciling');self.assertEqual(point['progress']['passed_scs'],[]);self.assertIsNone(point['progress']['head'])
        self.assertEqual(before,Path(owner['ledger_path']).read_bytes())
        p=subprocess.run(command,capture_output=True,text=True)
        self.assertNotEqual(p.returncode,0);self.assertIn('existing checkpoint',p.stderr)

if __name__=='__main__':unittest.main()

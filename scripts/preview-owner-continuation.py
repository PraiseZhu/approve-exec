#!/usr/bin/env python3
"""Read explicitly configured legacy ledgers/status; emit non-executable v2 preview."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',required=True);parser.add_argument('--authorization',required=True)
    parser.add_argument('--session-metadata-db',required=True);parser.add_argument('--package-id',required=True)
    args=parser.parse_args()
    for value in [args.config,args.authorization,args.session_metadata_db]:
        if not Path(value).is_absolute():raise ValueError('explicit absolute paths required')
    legacy=json.loads(Path(args.config).read_text());status=json.loads(Path(legacy['status_path']).read_text())
    values=status.get('prs',[]);values=list(values.values()) if isinstance(values,dict) else values
    issues=[];owners=[];checkpoints=[]
    expected=[v.get('pr_id') for v in values]
    if not expected or len(set(expected))!=len(expected) or any(not x for x in expected):raise ValueError('status full scope invalid')
    for raw in legacy['ledger_paths']:
        path=Path(raw);ledger=json.loads(path.read_text())
        for wave in ledger.get('waves',[]):
            for group in wave.get('groups',[]):
                gid=group.get('group_id');matches=[v for v in values if v.get('pr_id')==gid]
                if len(matches)!=1 or matches[0].get('session_id')!=group.get('session_id') or not group.get('session_id'):
                    issues.append({'group_id':gid,'reason':'ledger/status owner identity unavailable'});continue
                item=matches[0];checkpoint=path.parent/'owner-checkpoints'/(hashlib.sha256(gid.encode()).hexdigest()+'.json')
                owner={'group_id':gid,'session_id':group['session_id'],'assignment_seq':group.get('assignment_seq',0),
                       'ledger_path':str(path),'manifest_core_hash':ledger.get('manifest_core_hash'),'checkpoint_path':str(checkpoint),'completion':'delivered'}
                if item.get('owner_archived') is True:
                    owner.update(completion='approved-legacy-archive',legacy_status_path=legacy['status_path'])
                if not owner['manifest_core_hash']:issues.append({'group_id':gid,'reason':'manifest binding missing'})
                if not checkpoint.exists():
                    issues.append({'group_id':gid,'reason':'owner must initialize checkpoint with writer'})
                    checkpoints.append({'group_id':gid,'checkpoint_path':str(checkpoint),'command':['python3',str(Path(__file__).with_name('owner-checkpoint.py')),'--ledger',str(path),'--group',gid,'--checkpoint',str(checkpoint),'--phase','executing','--step','resume-bound-ledger-'+str(group.get('state'))]})
                owners.append(owner)
    mapped={o['group_id'] for o in owners}
    issues.extend({'group_id':gid,'reason':'approved future/other assignment lacks configured ledger; do not silently omit'} for gid in expected if gid not in mapped)
    result={'schemaVersion':2,'preview_only':True,'package_id':args.package_id,'lead_session_id':legacy['lead_session_id'],
            'session_metadata_db':args.session_metadata_db,'authorization_path':args.authorization,
            'authorization_sha256':hashlib.sha256(Path(args.authorization).read_bytes()).hexdigest(),
            'schedule_timeout_sec':len(owners)*45+60,'expected_group_ids':expected,'owners':owners,'stalled_after_sec':1800,'retry_after_sec':300}
    print(json.dumps({'ready':not issues,'issues':issues,'config':result,'checkpoint_initialization':checkpoints},ensure_ascii=False,indent=2))

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError) as error:raise SystemExit(str(error))

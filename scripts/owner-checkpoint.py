#!/usr/bin/env python3
"""Write one bound owner checkpoint; no dispatch, PR mutation, or ledger edits."""
import argparse
import json
import os
from pathlib import Path


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ledger',required=True);parser.add_argument('--group',required=True)
    parser.add_argument('--checkpoint',required=True);parser.add_argument('--phase',required=True,choices=['executing','waiting-ci','waiting-window','decision','blocked','delivered','archived'])
    parser.add_argument('--step',required=True);parser.add_argument('--head');parser.add_argument('--passed-sc',action='append',default=[])
    parser.add_argument('--repo');parser.add_argument('--pr-number',type=int);parser.add_argument('--resume-after-epoch',type=float)
    for name in ['delivery-receipt','release-receipt','archive-receipt','archive-tool-result','decision-id','decision-evidence']:parser.add_argument('--'+name)
    args=parser.parse_args()
    ledger_path=Path(args.ledger); target=Path(args.checkpoint)
    if not ledger_path.is_absolute() or not target.is_absolute():raise ValueError('absolute ledger/checkpoint required')
    ledger=json.loads(ledger_path.read_text());groups=[g for w in ledger.get('waves',[]) for g in w.get('groups',[]) if g.get('group_id')==args.group]
    if len(groups)!=1 or not groups[0].get('session_id'):raise ValueError('bound owner ledger required')
    group=groups[0]
    point={'schemaVersion':1,'group_id':args.group,'session_id':group['session_id'],'assignment_seq':group.get('assignment_seq',0),
           'phase':args.phase,'progress':{'step':args.step,'head':args.head,'passed_scs':sorted(set(args.passed_sc))}}
    if args.phase=='waiting-ci':
        if not args.repo or not args.pr_number or not args.head:raise ValueError('waiting-ci needs repo/pr/head')
        point.update(repo=args.repo,pr_number=args.pr_number)
    if args.phase=='waiting-window':
        if args.resume_after_epoch is None:raise ValueError('window requires explicit resume time')
        point['resume_after_epoch']=args.resume_after_epoch
    if args.phase in ['decision','blocked']:
        if not args.decision_id or not args.decision_evidence:raise ValueError('decision id/evidence required')
        point['decision']={'id':args.decision_id,'evidence_path':args.decision_evidence}
    for field in ['delivery_receipt','release_receipt','archive_receipt','archive_tool_result']:
        value=getattr(args,field)
        if value:
            if not Path(value).is_absolute():raise ValueError('evidence path must be absolute')
            point[field]=value
    if args.phase in ['delivered','archived'] and not all(point.get(k) for k in ['delivery_receipt','release_receipt']):raise ValueError('delivery requires original receipts')
    if args.repo and args.pr_number:point.update(repo=args.repo,pr_number=args.pr_number)
    if target.exists():
        prior=json.loads(target.read_text())
        for key in ['repo','pr_number']:
            if key not in point and key in prior:point[key]=prior[key]
        if any(prior.get(k)!=point[k] for k in ['group_id','session_id','assignment_seq']):raise ValueError('refusing to replace another owner checkpoint')
    target.parent.mkdir(parents=True,exist_ok=True)
    temporary=target.with_name(target.name+'.'+str(os.getpid())+'.tmp')
    with temporary.open('x') as out:json.dump(point,out,ensure_ascii=False,indent=2);out.write('\n')
    os.replace(temporary,target)
    print(json.dumps({'written':str(target),'group_id':args.group,'phase':args.phase}))

if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit(str(error))

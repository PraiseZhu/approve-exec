#!/usr/bin/env python3
"""Explicit package owner continuation. No raw sessions, no invented host RPC."""
import hashlib
import json
import re
import shlex
import sqlite3
import subprocess
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read(path):
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError('absolute configured path required')
    return json.loads(Path(path).read_text())


def metadata(db, session_id):
    if not isinstance(db, str) or not Path(db).is_absolute():
        raise ValueError('session_metadata_db absolute path required')
    with sqlite3.connect('file:' + quote(db) + '?mode=ro', uri=True, timeout=2) as connection:
        connection.execute('PRAGMA query_only=ON')
        row = connection.execute('SELECT id, status, active_turn_pid FROM sessions WHERE id=?', (session_id,)).fetchone()
    if not row or row[0] != session_id:
        raise ValueError('bound session metadata missing')
    return {'session_id': row[0], 'status': row[1], 'busy': row[2] is not None}


def evidence(request):
    result = subprocess.run(['node', str(HERE / 'owner-continuation-evidence.mjs')], input=json.dumps(request),
                            text=True, capture_output=True, timeout=45)
    if result.returncode:
        raise ValueError('owner evidence unavailable: ' + result.stderr[:200])
    return json.loads(result.stdout)


def validate_config(cfg):
    if cfg.get('preview_only') is True:
        raise ValueError('preview config is not executable')
    if cfg.get('schemaVersion') != 2 or not cfg.get('package_id') or not cfg.get('lead_session_id'):
        raise ValueError('v2 package and lead binding required')
    path = cfg.get('authorization_path')
    if not isinstance(path, str) or not Path(path).is_absolute() or hashlib.sha256(Path(path).read_bytes()).hexdigest() != cfg.get('authorization_sha256'):
        raise ValueError('approved package authorization changed')
    owners = cfg.get('owners')
    if not isinstance(owners, list) or not owners:
        raise ValueError('explicit complete owner mapping required')
    timeout = cfg.get('schedule_timeout_sec')
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout < len(owners) * 45 + 60:
        raise ValueError('schedule_timeout_sec must cover owners * 45 + 60 seconds; verify actual scheduler before deployment')
    identities, sessions = set(), set()
    for owner in owners:
        if not isinstance(owner, dict) or not owner.get('group_id') or not owner.get('session_id') or owner.get('completion') not in ['delivered', 'archived', 'approved-legacy-archive']:
            raise ValueError('owner mapping incomplete')
        if owner['group_id'] in identities or owner['session_id'] in sessions:
            raise ValueError('duplicate owner mapping')
        identities.add(owner['group_id']); sessions.add(owner['session_id'])
        if type(owner.get('assignment_seq')) is not int or owner['assignment_seq'] < 0:
            raise ValueError('owner assignment required')
    pending = cfg.get('scopePending', [])
    if not isinstance(pending, list):
        raise ValueError('scopePending must be explicit assignments')
    for item in pending:
        if not isinstance(item, dict) or not item.get('group_id') or item['group_id'] in identities or not item.get('reason') or not isinstance(item.get('status_path'), str) or not Path(item['status_path']).is_absolute() or not item.get('status_item_sha256'):
            raise ValueError('pending scope identity/evidence invalid')
        identities.add(item['group_id'])
    if set(cfg.get('expected_group_ids', [])) != identities or len(cfg.get('expected_group_ids', [])) != len(identities):
        raise ValueError('full approved group scope must match owner mapping')
    if cfg['lead_session_id'] in sessions:
        raise ValueError('lead cannot also own a product assignment')
    for key, default in [('stalled_after_sec', 1800), ('retry_after_sec', 300)]:
        if not isinstance(cfg.get(key, default), (int, float)) or cfg.get(key, default) < 1:
            raise ValueError('invalid cooldown')
    return cfg


def owner_checkpoint(owner):
    ledger = read(owner['ledger_path'])
    if ledger.get('manifest_core_hash') != owner.get('manifest_core_hash') or not owner.get('manifest_core_hash'):
        raise ValueError('owner manifest binding changed')
    groups = [g for w in ledger.get('waves', []) for g in w.get('groups', []) if g.get('group_id') == owner['group_id']]
    if len(groups) != 1 or groups[0].get('session_id') != owner['session_id'] or groups[0].get('assignment_seq', 0) != owner['assignment_seq']:
        raise ValueError('owner ledger identity changed')
    point = read(owner['checkpoint_path'])
    if point.get('schemaVersion') != 1 or any(point.get(k) != owner[k] for k in ['group_id', 'session_id', 'assignment_seq']):
        raise ValueError('owner checkpoint identity changed')
    if point.get('phase') not in ['reconciling', 'executing', 'waiting-ci', 'waiting-window', 'decision', 'delivered', 'archived', 'blocked']:
        raise ValueError('unknown owner checkpoint phase')
    progress = point.get('progress')
    if not isinstance(progress, dict) or not isinstance(progress.get('step'), str) or not progress['step']:
        raise ValueError('semantic progress step required')
    passed = progress.get('passed_scs', [])
    if not isinstance(passed, list) or any(not isinstance(value, str) or not value for value in passed):
        raise ValueError('passed SC IDs must be a string list')
    return point, groups[0]


def progress_key(point):
    progress = point['progress']
    return digest({'phase': point['phase'], 'step': progress['step'], 'head': progress.get('head'),
                   'passed_scs': sorted(set(progress.get('passed_scs', [])))})


def ready(owner, point, group, evidence_fn, legacy_archive_fn=None):
    if owner['completion'] == 'approved-legacy-archive':
        if not legacy_archive_fn or legacy_archive_fn(owner) is not True:
            raise ValueError('approved legacy archive evidence unavailable')
        return True
    if point['phase'] not in ['delivered', 'archived']:
        return False
    proof = evidence_fn({'mode': 'delivery', 'receipt': point.get('delivery_receipt'), 'release': point.get('release_receipt'),
                         'branch': group.get('branch'), 'head': group.get('tip_sha'), 'assignmentSeq': owner['assignment_seq']})
    if proof.get('verified') is not True:
        raise ValueError('delivery not verified')
    if owner['completion'] == 'delivered':
        return True
    if point['phase'] != 'archived':
        return False
    receipt, tool = read(point.get('archive_receipt')), read(point.get('archive_tool_result'))
    if receipt.get('session_id') != owner['session_id'] or receipt.get('archived') is not True or receipt.get('assignment_seq') != owner['assignment_seq']:
        raise ValueError('archive receipt changed')
    if tool.get('ok') is not True or tool.get('status') != 'archived' or not any(x.get('session_id') == owner['session_id'] and x.get('status') == 'archived' for x in tool.get('changed', [])):
        raise ValueError('real archive result missing')
    return True


def accepted(receipt, target):
    return isinstance(receipt, dict) and receipt.get('ok') is not False and not receipt.get('error') and not receipt.get('error_code') and receipt.get('target_session_id') == target and receipt.get('wake_kind') in ['resumed', 'queued', 'already-active']


def receipt_metadata(value):
    if not isinstance(value, dict):
        return {'shape': type(value).__name__}
    result = {}
    for key in ['target_session_id', 'wake_kind']:
        if isinstance(value.get(key), str):
            result[key] = value[key][:200]
    if isinstance(value.get('ok'), bool):
        result['ok'] = value['ok']
    code = value.get('error_code') or (value.get('error', {}).get('code') if isinstance(value.get('error'), dict) else None)
    if isinstance(code, str):
        result['error_code'] = code[:100]
    return result


def rejected(error):
    return getattr(error, 'code', None) == 'HOST_NOT_READY' or (getattr(error, 'code', None) == 'PRECONDITION_FAILED' and '伙伴能力正在刷新，请稍后再发送' in str(error))


def dispatch(cfg, state, key, target, message, rpc, now, write, metadata_fn):
    intents = state.setdefault('intents', {})
    pending = [(request, item) for request, item in intents.items() if item.get('target_session_id') == target and item.get('status') in ['unknown', 'rejected']]
    if pending:
        prior_key, prior_intent = pending[0]
        if prior_key != key and prior_key != state.get('legacy_request_id'):
            return 'blocked-prior-request'
        if prior_key != key: key = prior_key
        intent = prior_intent
    else:
        intent = intents.get(key)
    if intent and intent['status'] == 'delivered':
        return 'already-delivered'
    if intent and intent['status'] == 'unknown':
        # The actual script broker has no lookup RPC. Never invent one or repeat send.
        return 'blocked-unknown-receipt'
    if intent and intent['status'] == 'rejected':
        if intent['attempts'] >= 3:
            configured_grants = list(cfg.get('recovery_grants', []))
            if key == state.get('legacy_request_id') and state.get('legacy_recovery'):
                configured_grants.append({**state['legacy_recovery'], 'request_id': key, 'target_session_id': target})
            grants = [g for g in configured_grants if g.get('request_id') == key and g.get('target_session_id') == target and g.get('authorization_ref') and g.get('grant_id')]
            unused = [g for g in grants if g['grant_id'] not in intent.get('used_grants', [])]
            if not unused:
                return 'blocked-confirmed-rejection'
            grant_to_use = unused[0]['grant_id']
        if now - intent['attempted_at'] < cfg.get('retry_after_sec', 300):
            return 'retry-cooldown'
    live = metadata_fn(cfg['session_metadata_db'], target)
    if live['status'] != 'active':
        return 'blocked-session-unavailable'
    if live['busy']:
        return 'busy'
    prior = dict(intent or {})
    intent = {**prior, 'status': 'unknown', 'target_session_id': target, 'attempted_at': now,
              'attempts': prior.get('attempts', 0) + 1, 'request_id': key}
    intents[key] = intent
    write(state)  # Persist before non-idempotent host send; crash means unknown.
    latest = metadata_fn(cfg['session_metadata_db'], target)
    if latest['status'] != 'active' or latest['busy']:
        intents[key] = prior if prior else {**intent, 'status': 'deferred', 'attempts': 0}
        write(state)
        return 'busy' if latest['busy'] else 'blocked-session-unavailable'
    if prior.get('status') == 'rejected' and prior.get('attempts', 0) >= 3:
        intent['used_grants'] = [*prior.get('used_grants', []), grant_to_use]
        write(state)
    try:
        receipt = rpc.call('sessions.dispatch', {'target_session_id': target, 'message': message + '\ncontinuation_request_id=' + key})
    except Exception as error:
        intent.update(status='rejected' if rejected(error) else 'unknown', error_code=getattr(error, 'code', ''), error=str(error)[:300])
        write(state)
        return 'confirmed-rejected' if rejected(error) else 'blocked-unknown-receipt'
    if accepted(receipt, target):
        intent.update(status='delivered', receipt=receipt_metadata(receipt))
        write(state)
        return 'dispatched'
    intent.update(receipt=receipt_metadata(receipt))
    write(state)
    return 'blocked-unknown-receipt'


def run(cfg, state, *, rpc, now, write, metadata_fn=metadata, evidence_fn=evidence, legacy_archive_fn=None):
    validate_config(cfg)
    if state.get('version') != 2:
        legacy = state.copy()
        state.clear(); state.update(version=2, package_id=cfg['package_id'], owners={}, intents={}, legacy=legacy)
        if legacy.get('pending'):
            # Preserve old unknown delivery and explicit refusals. Neither is silently erased.
            state['legacy_lead_blocked'] = True
        write(state)
    if state.get('legacy_lead_blocked'):
        legacy = state['legacy']; grant = cfg.get('legacy_recovery')
        known = legacy.get('dispatch_error_code') == 'HOST_NOT_READY' or legacy.get('dispatch_error_code') == 'PRECONDITION_FAILED' and '伙伴能力正在刷新，请稍后再发送' in legacy.get('dispatch_error', '')
        if known and legacy.get('pending', {}).get('target_session_id') == cfg['lead_session_id'] and isinstance(grant, dict) and grant.get('previous_state_digest') == digest(legacy) and grant.get('authorization_ref') and grant.get('grant_id'):
            request = digest(['legacy', legacy['pending']])
            state['legacy_request_id'] = request
            state['intents'][request] = {'status': 'rejected', 'target_session_id': cfg['lead_session_id'], 'request_id': request,
                'attempted_at': legacy.get('last_dispatch_at', 0), 'attempts': max(3, legacy.get('retryable_attempts', 3)),
                'error_code': legacy.get('dispatch_error_code'), 'error': legacy.get('dispatch_error')}
            state['legacy_lead_blocked'] = False; state['legacy_recovery'] = grant; write(state)
    if state.get('package_id') != cfg['package_id']:
        raise ValueError('continuation state belongs to another package')
    outcomes, decisions, completed = {}, [], []
    for item in cfg.get('scopePending', []):
        outcomes['scope:' + item['group_id']] = 'decision'
        decisions.append({'owner': item['group_id'], 'event': {'id': 'scope-pending:' + digest(item), 'evidence_path': item['status_path'], 'reason': item['reason']}})
    for owner in cfg['owners']:
        key = owner['group_id'] + ':' + str(owner['assignment_seq'])
        try:
            point, group = owner_checkpoint(owner)
            row = state['owners'].setdefault(key, {})
            progress = progress_key(point)
            if progress != row.get('progress_key'):
                row.update(progress_key=progress, last_progress_at=now, stalled_attempts=0)
            if ready(owner, point, group, evidence_fn, legacy_archive_fn):
                row['status'] = 'complete'; completed.append(key); outcomes[key] = 'complete'; continue
            row['status'] = 'pending'
            if point['phase'] in ['decision', 'blocked']:
                event = point.get('decision')
                if not isinstance(event, dict) or not event.get('id') or not event.get('evidence_path'):
                    raise ValueError('structured decision evidence required')
                decisions.append({'owner': key, 'event': event}); outcomes[key] = 'decision'; continue
            if point['phase'] not in ['waiting-ci', 'delivered']:
                match = re.fullmatch(r'https://github.com/([^/]+/[^/]+)/pull/(\d+)', group.get('pr_url') or '')
                repo = point.get('repo') or (match.group(1) if match else None)
                number = point.get('pr_number') or (int(match.group(2)) if match else None)
                if repo and number:
                    ownership = evidence_fn({'mode': 'ownership', 'repo': repo, 'number': number})
                    if ownership.get('isDraft') is not True or ownership.get('state') != 'OPEN':
                        raise ValueError('PR released or closed; reconcile delivery evidence only, never resume local product edits')
            if point['phase'] == 'waiting-ci':
                ci = evidence_fn({'mode': 'ci', 'repo': point.get('repo'), 'number': point.get('pr_number'), 'head': point['progress'].get('head')})
                if ci.get('isDraft') is False:
                    raise ValueError('PR already released; owner must supply delivery receipt, never repair Mini feedback')
                if ci.get('state') not in [None, 'OPEN']:
                    raise ValueError('PR is no longer open')
                if ci.get('status') in ['pending', 'unknown']:
                    outcomes[key] = 'waiting-ci'; continue
                if ci.get('status') not in ['green', 'failed']:
                    raise ValueError('CI status not verified')
            if point['phase'] == 'waiting-window':
                opening = point.get('resume_after_epoch')
                if not isinstance(opening, (int, float)):
                    raise ValueError('verified window opening required')
                if now < opening:
                    outcomes[key] = 'waiting-window'; continue
            if row.get('last_dispatched_progress') == progress:
                if now - max(row.get('last_dispatch_at', now), row['last_progress_at']) < cfg.get('stalled_after_sec', 1800):
                    outcomes[key] = 'monitoring'; continue
                if row.get('stalled_attempts', 0) >= 3:
                    decisions.append({'owner': key, 'event': {'id': 'stalled:' + progress, 'evidence_path': owner['checkpoint_path']}})
                    outcomes[key] = 'blocked-stalled'; continue
            attempt = row.get('stalled_attempts', 0) + (1 if row.get('last_dispatched_progress') == progress else 0)
            request = digest([cfg['package_id'], key, owner['session_id'], progress, attempt])
            message = ('Continue your already authorized owner assignment; finish the remaining SC and local delivery contract. '
                       'Do not ask lead for routine steps. Do not merge or take over Mini-owned feedback. '
                       'Read only your bound checkpoint and ledger: ' + owner['checkpoint_path'] + ' ; ' + owner['ledger_path'])
            if point['phase'] == 'reconciling':
                message = 'Reconcile your actual bound ledger and current PR first; this initialization claims no SC or phase completion. Continue only remaining authorized local work after checking ownership, then write a truthful checkpoint. Read ' + owner['ledger_path']
            if point['phase'] == 'delivered':
                message = 'Delivery is already verified. Only complete the explicitly authorized cleanup/archive contract; never modify product, remote branch, or Mini review work. Read ' + owner['checkpoint_path']
            writer_command = shlex.join(['python3', str(HERE / 'owner-checkpoint.py'), '--ledger', owner['ledger_path'], '--group', owner['group_id'], '--checkpoint', owner['checkpoint_path'], '--phase', 'reconciling', '--step', 'inspect-actual-assignment'])
            message += ('\nBound checkpoint: ' + owner['checkpoint_path'] + '\nCheckpoint writer: ' + writer_command
                        + '\nAfter actual progress or phase changes, update this exact checkpoint using the writer with truthful --phase/--step, --head and --passed-sc as applicable. CI waiting requires --repo/--pr-number/--head; delivery requires original --delivery-receipt/--release-receipt. Do not leave initialization as your final progress.')
            outcome = dispatch(cfg, state, request, owner['session_id'], message, rpc, now, write, metadata_fn)
            outcomes[key] = outcome
            if outcome.startswith('blocked-'):
                decisions.append({'owner': key, 'event': {'id': outcome, 'evidence_path': owner['checkpoint_path']}})
            if outcome in ['dispatched', 'already-delivered']:
                if row.get('last_dispatched_progress') == progress:
                    row['stalled_attempts'] = attempt
                dispatched_at = now if outcome == 'dispatched' else state['intents'][request]['attempted_at']
                row.update(last_dispatched_progress=progress, last_dispatch_at=dispatched_at)
        except (ValueError, OSError, sqlite3.Error, KeyError, subprocess.SubprocessError) as error:
            outcomes[key] = 'blocked-evidence'
            decisions.append({'owner': key, 'event': {'id': 'evidence:' + digest(str(error)), 'evidence_path': owner.get('checkpoint_path'), 'reason': str(error)[:200]}})
    all_done = not cfg.get('scopePending') and len(completed) == len(cfg['owners'])
    events = ([{'event': {'id': 'package-complete', 'completed': completed}}] if all_done else decisions)
    acknowledged = state.setdefault('lead_events', [])
    fresh = [e for e in events if digest(e) not in acknowledged]
    if fresh and not state.get('legacy_lead_blocked'):
        request = digest([cfg['package_id'], 'lead-events', fresh])
        result = dispatch(cfg, state, request, cfg['lead_session_id'], 'Decide only these new package events; all routine owner work is script-routed.\n' + json.dumps(fresh), rpc, now, write, metadata_fn)
        outcomes['lead'] = result
        if result in ['dispatched', 'already-delivered']:
            acknowledged.extend(digest(e) for e in fresh)
    state.update(status='complete' if all_done and not fresh else 'attention-required' if any(value.startswith('blocked-') or value == 'decision' for value in outcomes.values()) or state.get('legacy_lead_blocked') else 'monitoring', outcomes=outcomes, dispatched=any(v == 'dispatched' for v in outcomes.values()))
    if all_done and all(digest(e) in acknowledged for e in events):
        state['status'] = 'complete'
    write(state)
    return state

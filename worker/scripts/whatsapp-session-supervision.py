"""Read-only ledger decision; no network, messages, credentials or mutations."""
def supervision_decision(grant, operations, now_ms, approved_notice=False):
    """Return (action, reason, deadline_ms). Caller always cleans up on errors."""
    end = grant['expires_at']
    if now_ms >= end:
        return ('stop', 'expired', end)
    if grant['historical_micros'] != 405100 or grant['historical_model_micros'] != 330000 or grant['fee_cushion_micros'] != 500000:
        raise ValueError('unexpected historical holds')
    if not 0 <= grant['spent_micros'] <= 1094900 or not 0 <= grant['model_micros'] <= 150000:
        raise ValueError('budget invalid')
    reason = grant['stopped_reason']
    if reason is None:
        if grant['lock_id'] is None and any(grant[k] >= v for k,v in {'inbound':10,'outbound':10,'address':3,'model':5}.items()):
            return ('stop','quota_reached',end)
        return ('continue','active',end)
    if reason != 'model_uncertain' or not approved_notice:
        return ('stop','grant_stopped',end)
    failed = [o for o in operations if o['grant_id']==grant['id'] and o['kind']=='model' and o['status']=='uncertain']
    if len(failed)!=1 or type(failed[0]['finished_at']) is not int or failed[0]['finished_at']>now_ms:
        return ('stop','failure_unverified',end)
    finished=failed[0]['finished_at'];deadline=min(end,finished+30000)
    if now_ms>=deadline:
        return ('stop','notice_deadline',deadline)
    notices=[o for o in operations if o['id']==grant['id']+':outbound:failure-notice']
    if len(notices)>1:
        raise ValueError('duplicate notice')
    if notices:
        notice=notices[0]
        if notice['status']!='pending':
            return ('stop','notice_finished',deadline)
        if notice['grant_id']!=grant['id'] or notice['kind']!='outbound' or notice['reserved_micros']!=11300 or grant['lock_id']!=notice['id']:
            return ('stop','notice_unverified',deadline)
        expected='notice_sending:'+failed[0]['id'].rsplit(':model:',1)[-1]+':0'
        if notice['outcome']!=expected or not finished<=notice['created_at']<=min(now_ms,finished+15000):
            return ('stop','notice_unverified',deadline)
    elif grant['lock_id'] is not None or grant['outbound']>=10 or grant['spent_micros']+11300>1094900 or now_ms>finished+15000:
        return ('stop','notice_unavailable',deadline)
    return ('grace','fixed_notice_only',deadline)

// v8 only: one fresh read transaction per guard. No cross-call cache or fallback.
export async function continuationHistorySnapshot(DB,pilot,proofIds) {
  const queries=[
    ['SELECT * FROM whatsapp_pilot_budgets WHERE pilot_id=?',[pilot],'first'],
    ['SELECT * FROM whatsapp_pilot_model_attempts WHERE pilot_id=? ORDER BY id',[pilot],'all'],
    ['SELECT key,count FROM rate_limits WHERE key LIKE ? ORDER BY key',[`wa-pilot:${pilot}:%`],'all'],
    ['SELECT * FROM whatsapp_continuation_grants WHERE pilot_id=?',[pilot],'first'],
    ['SELECT COUNT(*) n FROM whatsapp_continuation_operations WHERE grant_id=?',[`${pilot}:quote-v2-handset-1`],'first'],
    ['SELECT * FROM whatsapp_continuation_followon_grants WHERE pilot_id=?',[pilot],'first'],
    ['SELECT * FROM whatsapp_continuation_followon_operations WHERE grant_id=? ORDER BY id',[`${pilot}:quote-v2-handset-2`],'all'],
    ['SELECT * FROM whatsapp_continuation_retry_grants WHERE pilot_id=?',[pilot],'first'],
    ['SELECT * FROM whatsapp_continuation_retry_operations WHERE grant_id=? ORDER BY id',[`${pilot}:quote-v2-handset-3`],'all'],
    ['SELECT * FROM whatsapp_continuation_sol_grants WHERE pilot_id=?',[pilot],'first'],
    ['SELECT COUNT(*) n FROM whatsapp_continuation_sol_operations WHERE grant_id=?',[`${pilot}:quote-v2-handset-4`],'first'],
    ['SELECT * FROM whatsapp_continuation_voice_grants WHERE pilot_id=?',[pilot],'first'],
    ['SELECT * FROM whatsapp_continuation_voice_operations WHERE grant_id=? ORDER BY id',[`${pilot}:quote-v2-handset-5`],'all'],
    ['SELECT * FROM whatsapp_voice_grants ORDER BY id',[],'all'],
    ['SELECT COUNT(*) n FROM whatsapp_voice_attempts',[],'first'],
    ['SELECT * FROM whatsapp_review_preflight WHERE id=?',[proofIds[0]],'first'],
    ['SELECT (SELECT COUNT(*) FROM whatsapp_continuation_review_grants) AS grants, (SELECT COUNT(*) FROM whatsapp_continuation_review_operations) AS operations',[],'first'],
    ['SELECT * FROM whatsapp_review_r2_preflight WHERE id=?',[proofIds[1]],'first'],
    ['SELECT (SELECT COUNT(*) FROM whatsapp_continuation_review_r2_grants) AS grants, (SELECT COUNT(*) FROM whatsapp_continuation_review_r2_operations) AS operations',[],'first'],
    ['SELECT * FROM whatsapp_review_r3_preflight WHERE id=?',[proofIds[2]],'first'],
  ];
  const results=await DB.batch(queries.map(([sql,args])=>DB.prepare(sql).bind(...args)));
  if(!Array.isArray(results)||results.length!==queries.length||results.some((r,i)=>r?.success!==true||!Array.isArray(r.results)
    ||r.results.some(row=>!row||Array.isArray(row)||typeof row!=='object')||queries[i][2]==='first'&&r.results.length>1))throw Error('history_snapshot_invalid');
  const used=new Set(), lookup=new Map(queries.map(([sql,args,method],i)=>[JSON.stringify([sql,args]),{method,index:i}]));
  if(lookup.size!==queries.length)throw Error('history_snapshot_duplicate');
  function consume(sql,args,method){
    const entry=lookup.get(JSON.stringify([sql,args]));
    if(!entry||entry.method!==method||used.has(entry.index))throw Error('history_snapshot_lookup');
    used.add(entry.index);const rows=results[entry.index].results;
    return method==='first'?rows[0]||null:{results:rows};
  }
  return {proofExpiresAt:results.at(-1).results[0]?.expires_at,
    assertConsumed(){if(used.size!==queries.length)throw Error('history_snapshot_incomplete');},
    prepare(sql){let args=[];return {bind(...values){args=values;return this;},async first(){return consume(sql,args,'first');},async all(){return consume(sql,args,'all');}};}
  };
}

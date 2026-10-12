// Diagnostic only: fixed keys, bounded numeric aggregates; no text or identifiers.
const STAGES=new Set(['initial_off','reservation','presend_off','transport','usage_validation','envelope','proposal_validation','semantics','final_off','settlement',
  'source_fingerprint','deployments_list','version_view','history_read','history_hash','model_reservation','presend_guard','provider_headers','response_body','postresponse_guard','strict_proposal','model_settlement','final_guard']);
export function stageTimings(clock=()=>performance.now()){
  const entries=new Map();
  return {
    async measure(name,fn){
      if(!STAGES.has(name))throw Error('timing_stage_unknown');
      const start=clock();
      try{return await fn();}finally{
        const elapsed=clock()-start,entry=entries.get(name)||{calls:0,totalMs:0,maxMs:0};
        const ms=Number.isFinite(elapsed)?Math.min(60000,Math.max(0,Math.round(elapsed))):60000;
        if(entry.calls<32){entry.calls++;entry.totalMs=Math.min(1920000,entry.totalMs+ms);entry.maxMs=Math.max(entry.maxMs,ms);entries.set(name,entry);}
      }
    },
    snapshot(){return Object.fromEntries([...entries].map(([k,v])=>[k,{...v}]));}
  };
}

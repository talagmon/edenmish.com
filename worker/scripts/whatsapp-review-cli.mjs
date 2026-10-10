#!/usr/bin/env node
// Guarded operator CLI. No automatic activation, grant issuance or chat sends.
import {readFileSync,writeFileSync,readdirSync,statSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {CONTRACT,sha256,verifyApproval,runPreflight,supervise} from './whatsapp-review-runner.mjs';
const exec=(file,args,options)=>new Promise((resolve,reject)=>{const {input,...rest}=options;const child=execFile(file,args,rest,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr}));child.stdin.end(input||'');}),root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),worker=join(root,'worker');
const proposalPath=join(root,'docs/reviews/whatsapp-release-readiness-20261010/provider-proposal.json');
const flags=['WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED'];
const histories=['whatsapp_pilot_budgets','whatsapp_pilot_model_attempts','whatsapp_continuation_grants','whatsapp_continuation_operations','whatsapp_continuation_followon_grants','whatsapp_continuation_followon_operations','whatsapp_continuation_retry_grants','whatsapp_continuation_retry_operations','whatsapp_continuation_sol_grants','whatsapp_continuation_sol_operations','whatsapp_continuation_voice_grants','whatsapp_continuation_voice_operations','whatsapp_voice_grants','whatsapp_voice_attempts'];
export function sourceFingerprint(){const paths=[...readdirSync(join(worker,'src')).filter(f=>f.endsWith('.js')).map(f=>'worker/src/'+f),...readdirSync(join(worker,'scripts')).filter(f=>f.startsWith('whatsapp-review-')).map(f=>'worker/scripts/'+f),'worker/migrations/047_whatsapp_review_session.sql','docs/reviews/whatsapp-release-readiness-20261010/provider-proposal.json'].sort();return sha256(JSON.stringify(paths.map(p=>[p,sha256(readFileSync(join(root,p)))])));}
function privateJson(path){if((statSync(path).mode&0o077)!==0)throw Error('private_file_permissions');return JSON.parse(readFileSync(path,'utf8'));}
export function verifyDeploymentSurface(c){
 const allowed=['name','main','compatibility_date','routes','triggers','vars','ai','secrets','d1_databases'];
 const routes=[{pattern:'find-staging.edenmish.com',custom_domain:true},{pattern:'ops-staging.edenmish.com',custom_domain:true}];
 if(Object.keys(c).some(k=>!allowed.includes(k))||c.compatibility_date!=='2024-11-01'||JSON.stringify(c.routes)!==JSON.stringify(routes)
  ||(c.triggers&&JSON.stringify(c.triggers)!==JSON.stringify({crons:['*/5 * * * *','17 2 * * *']}))
  ||(c.ai&&JSON.stringify(c.ai)!==JSON.stringify({binding:'AI'})))throw Error('deployment_surface_unverified');
 const names=['OPS_PIN','SESSION_SECRET','DRIVER_ONE_TIME_CODE','GOOGLE_PLACES_SERVER_KEY','GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT_JSON','SENDGRID_API_KEY','APNS_TEAM_ID','APNS_KEY_ID','APNS_PRIVATE_KEY_P8'];
 if(c.secrets&&(Object.keys(c.secrets).join(',')!=='required'||!Array.isArray(c.secrets.required)||c.secrets.required.some(n=>!names.includes(n))))throw Error('secret_schema_unverified');
 if(Object.keys(c.vars||{}).length>64)throw Error('variable_limit_unverified');
}
function configSafe(c,a,{off=false,cleanup=false}={}){
 verifyDeploymentSurface(c);
 if(c.name!==CONTRACT.worker||c.d1_databases?.length!==1||c.d1_databases[0].database_id!==CONTRACT.database||c.d1_databases[0].binding!=='DB'||resolve(dirname(a.configPath),c.main)!==join(worker,'src/index.js')||c.env)throw Error('staging_config_unverified');
 const v=c.vars||{};
 if(v.AUTO_DRIVER_DISPATCH!=='off'||v.WHATSAPP_BOOKING_MODE!=='conversation_only'||v.WHATSAPP_BOOKING_VOICE_PROFILE!=='off'||v.TWILIO_RECIPIENT_POLICY!=='allowlist'||v.TWILIO_RECIPIENT_ALLOWLIST!==a.recipient||v.TWILIO_BOOKING_FROM!=='whatsapp:'+CONTRACT.sender||Object.keys(v).some(k=>/TOKEN|SECRET|API_KEY|PASSWORD/.test(k)))throw Error('scope_unverified');
 if(off&&flags.some(k=>v[k]!=='off'))throw Error('off_required');
 if(cleanup&&(v.WHATSAPP_BOOKING_CONTINUATION_START||v.WHATSAPP_BOOKING_CONTINUATION_END))throw Error('cleanup_window_must_be_blank');
}
const sqlValue=v=>v===null?'NULL':typeof v==='number'&&Number.isSafeInteger(v)?String(v):"'"+String(v).replaceAll("'","''")+"'";
export function createAdapter(a,hash,{command=exec,fetchImpl=globalThis.fetch,isAlive=pid=>process.kill(pid,0)}={}){
 const cfg=privateJson(a.configPath);configSafe(cfg,a);if(sha256(readFileSync(a.configPath))!==a.configSha256)throw Error('off_config_pin_required');
 const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',CI:'true'};
 async function wrangler(args,{json=true,config=a.configPath,input}={}){try{const r=await command(process.execPath,[join(worker,'node_modules/wrangler/bin/wrangler.js'),...args,'--config',config,...(json?['--json']:[])],{cwd:worker,env,timeout:60000,maxBuffer:4000000,...(input?{input}:{})});return json?JSON.parse(r.stdout):true;}catch{throw Error('staging_command_unconfirmed');}}
 async function sql(command){const rows=await wrangler(['d1','execute','edenmish-staging','--remote','--command',command]);if(!Array.isArray(rows)||rows.some(r=>r.success===false))throw Error('ledger_unconfirmed');return rows;}
 async function metadata(){const list=await wrangler(['deployments','list','--name',CONTRACT.worker]);const deployments=Array.isArray(list)?list:list.deployments;const latest=deployments?.sort((a,b)=>b.created_on.localeCompare(a.created_on))[0];if(latest?.versions?.length!==1||latest.versions[0].percentage!==100)throw Error('deployment_unverified');const version=await wrangler(['versions','view',latest.versions[0].version_id,'--name',CONTRACT.worker]);const bindings=version.resources?.bindings;if(!Array.isArray(bindings))throw Error('bindings_unverified');const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text]));return {vars,keyPresent:bindings.some(b=>b.name==='WHATSAPP_BOOKING_OPENAI_API_KEY'),database:bindings.find(b=>b.name==='DB')?.id,version:version.id};}
 async function historyHash(){const results=await sql(histories.map(t=>`SELECT * FROM ${t} ORDER BY 1;`).join('\n'));return sha256(JSON.stringify(results.map(r=>r.results)));}
 async function verifyRemote({off=false,keyAbsent=false,window=false}={}){
  if(sourceFingerprint()!==hash)throw Error('source_changed');const m=await metadata(),v=m.vars;
  configSafe({...cfg,vars:v},a,{off});
  if(m.database!==CONTRACT.database||v.WHATSAPP_BOOKING_REVIEW_SOURCE_SHA256!==hash||v.WHATSAPP_BOOKING_CONTINUATION_VERSION!=='6'||v.WHATSAPP_BOOKING_REVIEW_AUTHORIZATION!=='release-smoke-035-v1'||v.WHATSAPP_BOOKING_MULTILINGUAL_ENABLED!=='on'||v.WHATSAPP_BOOKING_MODEL!=='gpt-6.1-sol'||v.WHATSAPP_BOOKING_REASONING_EFFORT!=='low'||keyAbsent&&m.keyPresent)throw Error('remote_scope_unverified');
  if(window&&(Date.parse(v.WHATSAPP_BOOKING_CONTINUATION_START)!==a.startsAt||Date.parse(v.WHATSAPP_BOOKING_CONTINUATION_END)!==a.endsAt||flags.some(k=>!['on','off'].includes(v[k]))||new Set(flags.map(k=>v[k])).size!==1))throw Error('remote_window_unverified');
  if(await historyHash()!==a.priorHistorySha256)throw Error('history_changed');return m;
 }
 function owners(){const now=Date.now(),pids=[];for(const kind of ['primary','watchdog']){const h=privateJson(join(a.stateDirectory,kind+'.json'));if(h.kind!==kind||h.sourceSha256!==hash||h.grantId!==CONTRACT.grantId||h.endsAt!==a.endsAt||h.at>now||now-h.at>15000||h.pid===process.pid||!Number.isSafeInteger(h.pid)||h.pid<=0)throw Error('supervisor_unverified');isAlive(h.pid);pids.push(h.pid);}if(new Set(pids).size!==2)throw Error('independent_watchdog_required');}
 async function accountVerified(){const m=await metadata();if(m.database!==CONTRACT.database||await historyHash()!==a.priorHistorySha256)throw Error('account_history_unverified');return m;}
 async function cleanup(reason){
  const results={grantStopped:false,flagsOff:false,keyAbsent:false,callbackVerified:false,browserRemovalRequired:true};
  // Ledger stop first: suppresses fresh IO even if OFF deployment cannot complete.
  try{await sql(`UPDATE whatsapp_continuation_review_grants SET stopped_reason='operator_stop' WHERE id=${sqlValue(CONTRACT.grantId)};`);results.grantStopped=true;}catch{}
  try{const clean=privateJson(a.cleanupConfigPath);configSafe(clean,{...a,configPath:a.cleanupConfigPath},{off:true,cleanup:true});if(sha256(readFileSync(a.cleanupConfigPath))!==a.cleanupConfigSha256||sourceFingerprint()!==hash)throw Error('cleanup_source_changed');await wrangler(['deploy'],{config:a.cleanupConfigPath,json:false});}catch{}
  // Delete only the temporary named booking secret; never retrieve its value.
  try{const m=await metadata();if(m.database!==CONTRACT.database)throw Error('account_unverified');if(m.keyPresent)await wrangler(['secret','delete','WHATSAPP_BOOKING_OPENAI_API_KEY','--name',CONTRACT.worker],{json:false});}catch{}
  try{const m=await metadata();results.flagsOff=flags.every(k=>m.vars[k]==='off')&&m.vars.AUTO_DRIVER_DISPATCH==='off'&&m.vars.WHATSAPP_BOOKING_VOICE_PROFILE==='off'&&!m.vars.WHATSAPP_BOOKING_CONTINUATION_START&&!m.vars.WHATSAPP_BOOKING_CONTINUATION_END;results.keyAbsent=!m.keyPresent;}catch{}
  return results;
 }
 return {fetch:fetchImpl,metadata,historyHash,cleanup,
  deployOff:async()=>{configSafe(cfg,a,{off:true});if(sourceFingerprint()!==hash)throw Error('source_changed');await accountVerified();await wrangler(['deploy'],{json:false});await verifyRemote({off:true,keyAbsent:true});},
  migrate:async()=>{if(sourceFingerprint()!==hash)throw Error('source_changed');const m=await accountVerified();if(flags.some(k=>m.vars[k]!=='off'))throw Error('off_required');await wrangler(['d1','execute','edenmish-staging','--remote','--file',join(worker,'migrations/047_whatsapp_review_session.sql')]);},
  installKey:async key=>{if(Date.now()>=a.startsAt)throw Error('key_install_window');owners();await verifyRemote({off:true,keyAbsent:true,window:true});const rows=await sql(`SELECT status,source_sha256,expires_at FROM whatsapp_review_preflight WHERE id=${sqlValue(CONTRACT.id)};`);const p=rows[0]?.results?.[0];if(p?.status!=='matched'||p.source_sha256!==hash||p.expires_at<a.endsAt||!/^sk-[A-Za-z0-9_-]{12,}$/.test(key||''))throw Error('key_install_gate');try{if(Date.now()>=a.startsAt)throw Error('key_install_window');owners();await wrangler(['secret','put','WHATSAPP_BOOKING_OPENAI_API_KEY','--name',CONTRACT.worker],{json:false,input:key+'\n'});if(!(await metadata()).keyPresent||Date.now()>=a.startsAt)throw Error('key_install_unverified');owners();}catch{await cleanup('setup_failed');throw Error('key_install_unverified');}},
  activate:async()=>{
   await verifyRemote({off:true,window:true});const now=Date.now();if(now<a.startsAt||now>=a.endsAt)throw Error('activation_window');
   owners();
   const browser=privateJson(a.browserReceiptPath);if(browser.verified!==true||browser.sender!==CONTRACT.sender||browser.incoming!=='https://ops-staging.edenmish.com/webhooks/twilio/booking'||browser.method!=='POST'||browser.fallback!==''||browser.endsAt!==a.endsAt||browser.verifiedAt<a.approvedAt||browser.verifiedAt>now||now-browser.verifiedAt>300000)throw Error('browser_callback_unverified');
   const rows=await sql(`SELECT * FROM whatsapp_continuation_review_grants WHERE id=${sqlValue(CONTRACT.grantId)}; SELECT status,source_sha256,expires_at FROM whatsapp_review_preflight WHERE id=${sqlValue(CONTRACT.id)};`);const g=rows[0]?.results?.[0],p=rows[1]?.results?.[0];
   if(!g||g.version!==6||g.starts_at!==a.startsAt||g.expires_at!==a.endsAt||g.stopped_reason!==null||g.lock_id!==null||g.spent_micros!==0||g.model_micros!==0||['inbound','outbound','address','model'].some(k=>g[k]!==0)||p?.status!=='matched'||p.source_sha256!==hash||p.expires_at<a.endsAt||!(await metadata()).keyPresent)throw Error('grant_or_key_unverified');
   const active=privateJson(a.activeConfigPath);configSafe(active,{...a,configPath:a.activeConfigPath});if(sha256(readFileSync(a.activeConfigPath))!==a.activeConfigSha256||flags.some(k=>active.vars[k]!=='on')||sourceFingerprint()!==hash)throw Error('active_config_unverified');
   try{await wrangler(['deploy'],{config:a.activeConfigPath,json:false});const m=await verifyRemote({window:true});if(Date.now()>=a.endsAt||flags.some(k=>m.vars[k]!=='on')||!m.keyPresent)throw Error('activation_unverified');owners();const fresh=(await sql(`SELECT stopped_reason,starts_at,expires_at FROM whatsapp_continuation_review_grants WHERE id=${sqlValue(CONTRACT.grantId)};`))[0]?.results?.[0];if(!fresh||fresh.stopped_reason!==null||fresh.starts_at!==a.startsAt||fresh.expires_at!==a.endsAt)throw Error('grant_stopped_during_activation');if(Date.now()>=a.endsAt)throw Error('activation_expired');owners();return {activeVerified:true,endsAt:a.endsAt};}catch{await cleanup('activation_unconfirmed');throw Error('activation_unconfirmed_no_retry');}
  },
  assertOff:()=>verifyRemote({off:true,keyAbsent:true}),
  reserve:async p=>{const names=Object.keys(p);const r=await sql(`INSERT INTO whatsapp_review_preflight (${names.join(',')}) VALUES (${names.map(k=>sqlValue(p[k])).join(',')});`);return r[0]?.meta?.changes===1;},
  finish:async p=>{const r=await sql(`UPDATE whatsapp_review_preflight SET ${Object.entries(p).map(([k,v])=>k+'='+sqlValue(v)).join(',')} WHERE id=${sqlValue(CONTRACT.id)} AND status='pending';`);return r[0]?.meta?.changes===1;},
  snapshot:async()=>{
   await verifyRemote({window:true});
   // One SQLite statement provides a consistent grant/operations/reply snapshot.
   const q=sqlValue(CONTRACT.grantId);
   const grantCols=['id','version','starts_at','expires_at','historical_micros','historical_model_micros','fee_cushion_micros','spent_micros','model_micros','inbound','outbound','address','model','lock_id','stopped_reason'];
   const opCols=['id','grant_id','kind','status','reserved_micros','outcome','created_at','finished_at'];
   const object=(cols,prefix='')=>'json_object('+cols.map(k=>sqlValue(k)+','+prefix+k).join(',')+')';
   const rows=await sql(`SELECT (SELECT ${object(grantCols)} FROM whatsapp_continuation_review_grants WHERE id=${q}) AS grant_json,
    (SELECT json_group_array(${object(opCols)}) FROM whatsapp_continuation_review_operations WHERE grant_id=${q}) AS operations_json,
    (SELECT COUNT(*) FROM whatsapp_booking_conversations WHERE json_extract(state_json,'$.continuation_id')=${q} AND phase='handoff') AS handoff,
    (SELECT json_group_array(${object(['kind','state','created_at'],'r.')}) FROM whatsapp_booking_replies r JOIN whatsapp_booking_conversations c ON c.id=r.conversation_id WHERE json_extract(c.state_json,'$.continuation_id')=${q} AND r.kind='handoff_ack') AS replies_json;`);
   const row=rows[0].results[0];return {sourceVerified:true,configVerified:true,historyVerified:true,grant:JSON.parse(row.grant_json),operations:JSON.parse(row.operations_json),handoff:row.handoff>0,replies:JSON.parse(row.replies_json)};
  },
  heartbeat:async r=>{writeFileSync(join(a.stateDirectory,r.kind+'.json'),JSON.stringify({...r,pid:process.pid,sourceSha256:hash,grantId:CONTRACT.grantId}),{mode:0o600});},
 };
}
export function validateExecutionApproval(a,mode,now,currentHash=sourceFingerprint()){const hash=mode==='stop'?a.sourceSha256:currentHash;verifyApproval(a,hash,now,{window:['supervise','watchdog','stop','key-install','activate'].includes(mode),cleanup:mode==='stop'||mode==='watchdog'});return hash;}
async function main(){const [mode,path]=process.argv.slice(2);if(mode==='fingerprint'){console.log(JSON.stringify({sourceSha256:sourceFingerprint()}));return;}
 if(!['preflight','supervise','watchdog','stop','verify','pin-history','stage-off','migrate','key-install','activate'].includes(mode)||!path)throw Error('usage: fingerprint | <preflight|supervise|watchdog|stop|verify|pin-history> private-approval.json');
 const a=privateJson(resolve(path)),hash=validateExecutionApproval(a,mode,Date.now());
 if(!/^[a-f0-9]{64}$/.test(a.priorHistorySha256||'')&&mode!=='pin-history')throw Error('prior_history_pin_required');
 mkdirSync(a.stateDirectory,{recursive:true,mode:0o700});if(statSync(a.stateDirectory).mode&0o077)throw Error('private_state_required');const io=createAdapter(a,hash);
 if(mode==='migrate'){await io.migrate();console.log(JSON.stringify({migrationApplied:true}));return;}
 if(mode==='stage-off'){await io.deployOff();console.log(JSON.stringify({offVerified:true}));return;}
 if(mode==='activate'){console.log(JSON.stringify(await io.activate()));return;}
 if(mode==='pin-history'){console.log(JSON.stringify({priorHistorySha256:await io.historyHash()}));return;}
 if(mode==='verify'){await io.assertOff();console.log(JSON.stringify({offVerified:true,keyAbsent:true}));return;}
 if(mode==='stop'){console.log(JSON.stringify(await io.cleanup('operator_stop')));return;}
 if(mode==='preflight'||mode==='key-install'){
  let key='';for await(const part of process.stdin){key+=part;if(key.length>512)throw Error('key_input_invalid');}key=key.trim();
  if(mode==='key-install'){await io.installKey(key);key=null;console.log(JSON.stringify({temporaryKeyBindingPresent:true,automationOff:true}));return;}
  const report=await runPreflight({approval:a,sourceHash:hash,proposal:JSON.parse(readFileSync(proposalPath)),key,io});key=null;writeFileSync(join(a.stateDirectory,'preflight-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));return;
 }
 let stopping=false;const interrupted=async()=>{if(stopping)return;stopping=true;const report=await io.cleanup('operator_stop');writeFileSync(join(a.stateDirectory,mode+'-closed.json'),JSON.stringify({reason:'operator_stop',...report})+'\n',{mode:0o600});process.exit(report.flagsOff&&report.keyAbsent?0:1);};process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
 const report=await supervise({io,approval:a,sourceHash:hash,watchdog:mode==='watchdog'});writeFileSync(join(a.stateDirectory,mode+'-closed.json'),JSON.stringify(report)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Review session stopped: configuration or operation unverified. No retry. Inspect sanitized ledger/status; never paste secrets.');process.exitCode=1;});

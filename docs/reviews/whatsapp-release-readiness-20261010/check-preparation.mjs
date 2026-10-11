// Mock-only approval-contract check. No credentials, network, grant writes or IO
// other than reading the proposal and printing bounded test results.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {newBooking,advanceBooking,resolveBookingAddress} from '../../../worker/src/whatsapp-booking.js';
import {splitBookingReply} from '../../../worker/src/whatsapp-booking-store.js';
import {createOfflineBookingModel} from '../../../worker/src/whatsapp-booking-model.js';
const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url)));
const m=read('./execution-grant-manifest.json'),p=read('./provider-proposal.json');
assert.equal(p.requests.length,1);assert.equal(m.preflight.requestSha256,createHash('sha256').update(JSON.stringify(p.requests[0].payload)).digest('hex'));
const a=m.money;
assert.equal(a.earlierCheckpointHeldMicros+a.laterRetainedHoldsMicros.reduce((x,y)=>x+y,0),a.retainedTotalMicros);
assert.equal(a.preflightMicros+a.handsetModelMicros+a.inboundMicros+a.outboundMicros+a.mapsMicros,a.plannedNewMicros);
assert.ok(a.plannedNewMicros<=a.requestedAllocationMicros);assert.equal(a.retainedTotalMicros+a.requestedAllocationMicros,a.forecastAggregateWithFullAllocationMicros);
assert.ok(a.forecastAggregateWithFullAllocationMicros<=a.originalCapMicros);assert.equal(a.releasedMicros,0);assert.equal(a.audioMicros,0);
const activationPermitted=manifest=>manifest.state==='APPROVED'&&Object.values(manifest.activationGates).every(x=>x===true);
assert.equal(activationPermitted(m),false);
for(const key of Object.keys(m.activationGates)){const c=structuredClone(m);c.state='APPROVED';for(const k in c.activationGates)c.activationGates[k]=true;c.activationGates[key]=false;assert.equal(activationPermitted(c),false,key);}
let models=0,maps=0,orders=0,outbound=0;
const message=JSON.parse(p.requests[0].payload.input[0].content).customer_message;
const fields=[['size','מעטפה קטנה'],['notes','מסמכים'],['pickup','מבני מושה 16 תל אביב'],['dropoff','לקרינצקי 111 רמת גן'],['schedule','מחר בבוקר'],['dropoff_detail','לנועה'],['name','יעל כהן'],['email','yael@example.com'],['pickup_detail','אצל השומר']];
const services={multilingual:true,conversationModel:createOfflineBookingModel(()=>{models++;assert.ok(models<=m.handset.model);return {version:4,reply_language:'he',reply_style:'friendly',intent:'update',fields:fields.map(([field,quote])=>({field,quote})),topic:null,clarify_field:null};}),resolveAddress:text=>resolveBookingAddress(text,{GOOGLE_PLACES_SERVER_KEY:'synthetic-only'},{fetchImpl:async(url,init)=>{maps++;assert.ok(maps<=m.handset.mapsNetworkRequests);assert.equal(String(url),'https://places.googleapis.com/v1/places:searchText');const body=JSON.parse(init.body),pickup=body.textQuery.includes('בני');const route=pickup?'בני משה':'קריניצי',house=pickup?'16':'111',city=pickup?'תל אביב':'רמת גן';return Response.json({places:[{formattedAddress:route+' '+house+', '+city,location:{latitude:32.08,longitude:34.78},addressComponents:[{types:['route'],longText:route},{types:['street_number'],longText:house},{types:['locality'],longText:city},{types:['country'],longText:'ישראל'}]}]});}}),quote:async()=>({price:50,currency:'ILS',review:false}),create:()=>{orders++;throw Error('No order');}};
const options={phone:'+972541234567',now:p.now,conversationOnly:true};
let state=newBooking(),turns=0,phases=[];
for(const text of ['שלום','1',message,'1','1','1','1','1']){
 const r=await advanceBooking(state,text,services,options);state=r.state;turns++;outbound+=splitBookingReply(r.reply).length;assert.ok(outbound<=m.handset.outbound);phases.push(state.phase);assert.equal(r.create,undefined);
 if(state.phase==='handoff')break;
}
assert.equal(state.phase,'handoff');assert.ok(turns<=m.handset.inbound);assert.equal(models,1);assert.equal(maps,2);assert.equal(orders,0);
console.log(JSON.stringify({contractChecks:'pass',syntheticFlow:{turns,models,mapsHttpRequests:maps,outboundSegments:outbound,orders,phases},networkCalls:0,activationPermitted:activationPermitted(m)}));

// Additional contract sanity check: final confirmation enters handoff before its ordinary
// completion reply finishes; do not race that existing bounded send. This is not
// a substitute for runner tests; runtime supervision also enforces these bounds.
const terminalDecision=({now,end,operatorStop=false,pending=false,created=0})=>now>=end||operatorStop?'stop':pending&&now<Math.min(end,created+m.terminalReply.maxExistingSendMs)?'await-existing-send':'stop';
assert.equal(terminalDecision({now:1000,end:20000,pending:true,created:1000}),'await-existing-send');
assert.equal(terminalDecision({now:11000,end:20000,pending:true,created:1000}),'stop');
assert.equal(terminalDecision({now:1000,end:20000,pending:true,created:1000,operatorStop:true}),'stop');
assert.equal(terminalDecision({now:20000,end:20000,pending:true,created:19500}),'stop');
assert.equal(terminalDecision({now:1000,end:20000,pending:false}),'stop');
console.log(JSON.stringify({terminalReplyBoundaryChecks:'pass',networkCalls:0}));

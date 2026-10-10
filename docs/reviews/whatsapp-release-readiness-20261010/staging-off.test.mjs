import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeOffConfig,validateOffConfig} from './prepare-staging-off.mjs';
const entry='/synthetic/worker/src/index.js';
const base=()=>({name:'edenmish-ops-staging',main:entry,compatibility_date:'2024-11-01',routes:[{pattern:'find-staging.edenmish.com',custom_domain:true},{pattern:'ops-staging.edenmish.com',custom_domain:true}],triggers:{crons:['*/5 * * * *']},d1_databases:[{binding:'DB',database_name:'edenmish-staging',database_id:'e1fcce7f-a232-4258-b181-f1ab17b25639'}],vars:{WHATSAPP_BOOKING_ENABLED:'on',WHATSAPP_BOOKING_CONTINUATION_VERSION:'5',WHATSAPP_BOOKING_CONTINUATION_ID:'old',WHATSAPP_BOOKING_CONTINUATION_START:'old',WHATSAPP_BOOKING_CONTINUATION_END:'old',WHATSAPP_BOOKING_PILOT_EXPIRES_AT:'old',WHATSAPP_BOOKING_REVIEW_AUTHORIZATION:'old',AUTO_DRIVER_DISPATCH:'on'}});
test('OFF preparation removes all inherited grants, windows and provider approvals; pauses independent jobs',()=>{
 const c=makeOffConfig(base(),entry);assert.equal(validateOffConfig(c,entry),true);
 assert.deepEqual(c.triggers,{crons:[]});
 for(const k of ['WHATSAPP_BOOKING_ENABLED','WHATSAPP_BOOKING_SEND_ENABLED','WHATSAPP_BOOKING_MODEL_ENABLED','AUTO_DRIVER_DISPATCH','ROUTE_OPTIMIZATION_PROVIDER','WHATSAPP_BOOKING_VOICE_ENABLED','WHATSAPP_BOOKING_CONTINUATION_APPROVED'])assert.equal(c.vars[k],'off');
 for(const k of ['WHATSAPP_BOOKING_CONTINUATION_ID','WHATSAPP_BOOKING_CONTINUATION_VERSION','WHATSAPP_BOOKING_CONTINUATION_START','WHATSAPP_BOOKING_CONTINUATION_END','WHATSAPP_BOOKING_PILOT_EXPIRES_AT','WHATSAPP_BOOKING_REVIEW_AUTHORIZATION'])assert.equal(k in c.vars,false);
 for(const k of ['EMAIL_RECIPIENT_ALLOWLIST','TWILIO_RECIPIENT_ALLOWLIST','WHATSAPP_CUSTOMER_DELIVERED_TEMPLATE','WHATSAPP_OPS_PAYMENT_TEMPLATE'])assert.equal(c.vars[k],'');
});
test('production route/database, secret values and additional deployment hooks are refused',()=>{
 for(const change of [b=>b.name='edenmish-ops',b=>b.routes[0].pattern='find.edenmish.com',b=>b.d1_databases[0].database_id='production',b=>b.d1_databases[0].database_name='edenmish',b=>b.vars.OPENAI_API_KEY='synthetic-secret',b=>b.build={command:'unexpected'},b=>b.env={},b=>b.secrets={required:['WHATSAPP_BOOKING_OPENAI_API_KEY']}]){const b=base();change(b);assert.throws(()=>makeOffConfig(b,entry));}
});
test('post-generation toggles, timers, cron restoration and route overrides cannot pass validation',()=>{
 for(const change of [c=>c.vars.WHATSAPP_BOOKING_ENABLED='on',c=>c.vars.EMAIL_RECIPIENT_ALLOWLIST='synthetic@example.com',c=>c.vars.WHATSAPP_BOOKING_CONTINUATION_START='2030-01-01',c=>c.triggers.crons.push('* * * * *'),c=>c.main='/wrong/entry.js',c=>c.routes.push({pattern:'production.example.com',custom_domain:true})]){const c=makeOffConfig(base(),entry);change(c);assert.throws(()=>validateOffConfig(c,entry));}
});

import {test} from 'node:test';import assert from 'node:assert/strict';import {voiceProfileEnvironment} from '../src/whatsapp-booking-voice-profile.js';
test('compact profile preserves legacy config and fails closed for unexpected profile/version',()=>{
const old={WHATSAPP_BOOKING_VOICE_ENABLED:'on'};assert.equal(voiceProfileEnvironment(old),old);
for(const [profile,version] of [['off','5'],['unknown','5'],['v5-20261010','4']]){const e=voiceProfileEnvironment({WHATSAPP_BOOKING_VOICE_PROFILE:profile,WHATSAPP_BOOKING_CONTINUATION_VERSION:version});assert.equal(e.WHATSAPP_BOOKING_VOICE_ENABLED,'off');}
const e=voiceProfileEnvironment({WHATSAPP_BOOKING_VOICE_PROFILE:'v5-20261010',WHATSAPP_BOOKING_CONTINUATION_VERSION:'5'});for(const k of ['WHATSAPP_BOOKING_VOICE_ENABLED','WHATSAPP_BOOKING_VOICE_APPROVED','WHATSAPP_BOOKING_MULTILINGUAL_ENABLED','WHATSAPP_BOOKING_CONTINUATION_VOICE_SCHEMA_READY'])assert.equal(e[k],'on');
});

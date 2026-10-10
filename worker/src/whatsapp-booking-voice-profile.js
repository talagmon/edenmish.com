// One compact deployment binding avoids exhausting Cloudflare's variable limit.
// Existing configurations remain unchanged; unknown profiles disable the test.
export function voiceProfileEnvironment(env) {
 if(env.WHATSAPP_BOOKING_VOICE_PROFILE===undefined)return env;
 const known=['off','v5-20261010'].includes(env.WHATSAPP_BOOKING_VOICE_PROFILE);
 const textOnly=env.WHATSAPP_BOOKING_VOICE_PROFILE==='off' && env.WHATSAPP_BOOKING_CONTINUATION_VERSION==='6' && env.WHATSAPP_BOOKING_MULTILINGUAL_ENABLED==='on';
 const enabled=env.WHATSAPP_BOOKING_VOICE_PROFILE==='v5-20261010'&&env.WHATSAPP_BOOKING_CONTINUATION_VERSION==='5';
 return {...env,WHATSAPP_BOOKING_CONTINUATION_VOICE_SCHEMA_READY:known?'on':'off',
  WHATSAPP_BOOKING_VOICE_ENABLED:enabled?'on':'off',WHATSAPP_BOOKING_VOICE_APPROVED:enabled?'on':'off',
  WHATSAPP_BOOKING_MULTILINGUAL_ENABLED:enabled||textOnly?'on':'off',WHATSAPP_BOOKING_VOICE_GRANT_ID:'edenmish-voice-20261010-a'};
}

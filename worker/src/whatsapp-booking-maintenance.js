import { expireBookingJobs } from './whatsapp-booking-jobs.js';

// Reserved for DB-only booking housekeeping. Never attach the generic business
// scheduler to this expression: cleanup must also run with every live flag OFF.
export const BOOKING_MAINTENANCE_CRON = '* * * * *';
const DAY = 86_400_000;
const scope = `SELECT conversation_id FROM whatsapp_booking_full_fences
  UNION SELECT conversation_id FROM whatsapp_booking_jobs
  UNION SELECT conversation_id FROM whatsapp_booking_full_ingress`;

async function retainDurableBookings(DB, now) {
  // Scope comes from durable relationships, not JSON that the 48h scrub erases.
  // Receipts have no channel identity; only receipts linked to full replies can
  // be removed here. Unattributed/legacy receipts remain with their own owner.
  await DB.batch([
    DB.prepare(`UPDATE whatsapp_booking_conversations
      SET phase=CASE WHEN phase='closed' THEN 'closed' ELSE 'handoff' END,
        state_json=CASE WHEN phase='closed' THEN '{"phase":"closed","data":{}}' ELSE '{"phase":"handoff","data":{}}' END,
        recipient=NULL,lock_id=NULL,lock_at=NULL
      WHERE id IN (SELECT id FROM whatsapp_booking_conversations WHERE id IN (${scope})
        AND created_at<? AND (recipient IS NOT NULL OR lock_id IS NOT NULL OR lock_at IS NOT NULL
          OR state_json!=CASE WHEN phase='closed' THEN '{"phase":"closed","data":{}}' ELSE '{"phase":"handoff","data":{}}' END) LIMIT 1000)`)
      .bind(now-2*DAY),
    DB.prepare(`UPDATE whatsapp_booking_replies SET body=NULL,
      state=CASE WHEN state='pending' THEN 'expired' ELSE state END
      WHERE id IN (SELECT id FROM whatsapp_booking_replies WHERE conversation_id IN (${scope})
        AND created_at<? AND (body IS NOT NULL OR state='pending') LIMIT 1000)`).bind(now-DAY),
    DB.prepare(`DELETE FROM whatsapp_booking_receipts WHERE provider_ref IN (
      SELECT s.provider_ref FROM whatsapp_booking_receipts s JOIN whatsapp_booking_replies r ON r.provider_ref=s.provider_ref
      WHERE r.conversation_id IN (${scope}) AND s.created_at<? LIMIT 1000)`).bind(now-7*DAY),
    DB.prepare(`DELETE FROM whatsapp_booking_replies WHERE id IN (
      SELECT id FROM whatsapp_booking_replies WHERE conversation_id IN (${scope}) AND created_at<?
      AND NOT EXISTS (SELECT 1 FROM whatsapp_booking_receipts s WHERE s.provider_ref=whatsapp_booking_replies.provider_ref)
      LIMIT 1000)`).bind(now-7*DAY),
    DB.prepare(`DELETE FROM whatsapp_booking_events WHERE event_key IN (
      SELECT event_key FROM whatsapp_booking_events WHERE conversation_id IN (${scope}) AND created_at<? LIMIT 1000)`)
      .bind(now-8*DAY),
    // Keep checkout evidence even if the D1 order is cancelled/missing. Neither
    // proves the external invoice cannot be paid. Holds are never deleted.
    DB.prepare(`DELETE FROM whatsapp_booking_conversations WHERE id IN (
      SELECT c.id FROM whatsapp_booking_conversations c WHERE c.id IN (${scope}) AND c.created_at<?
      AND (c.checkout_started_at IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.token=c.order_token AND o.payment_status='paid'))
      AND NOT EXISTS (SELECT 1 FROM whatsapp_booking_replies r WHERE r.conversation_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM whatsapp_booking_events e WHERE e.conversation_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM whatsapp_booking_jobs j WHERE j.conversation_id=c.id AND j.state IN ('pending','processing'))
      LIMIT 1000)`).bind(now-30*DAY),
  ]);
}

export async function cleanupDurableBookings(env, now=Date.now()) {
  if(!env.DB || !Number.isSafeInteger(now) || now<=0)throw Error('booking_maintenance_failed');
  // Run both independently: a failure must not suppress the other privacy task,
  // and a missing table/unavailable database must never report a successful purge.
  let failed=false,expiredJobs=0;
  try { expiredJobs=await expireBookingJobs({DB:env.DB},()=>now,{strict:true}); } catch { failed=true; }
  try { await retainDurableBookings(env.DB,now); } catch { failed=true; }
  if(failed)throw Error('booking_maintenance_failed');
  return {status:'ok',expiredJobs};
}

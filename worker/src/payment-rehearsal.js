// Internal registration only: never infer this capability from customer input,
// names, addresses, product tags, or a public quote/order request.
export async function markPaymentRehearsal(DB, { orderId, runId, actor, now = Date.now() }) {
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !/^[a-z0-9-]{8,64}$/.test(runId || '')
    || !/^[a-z0-9_-]{3,64}$/i.test(actor || '') || !Number.isSafeInteger(now) || now <= 0)
    return { error: 'invalid_rehearsal' };
  const result = await DB.batch([
    DB.prepare(`UPDATE orders SET rehearsal_run_id=?, rehearsal_created_at=?
      WHERE id=? AND rehearsal_run_id IS NULL AND price=1 AND currency='ILS'
        AND payment_status IN ('none','unpaid') AND status IN ('received','review','priced')
        AND shopify_draft_order_id IS NULL AND shopify_order_id IS NULL
        AND business_account_id IS NULL AND wallet_reservation_id IS NULL
        AND COALESCE(discount_amount,0)=0 AND discount_code IS NULL
        AND NOT EXISTS(SELECT 1 FROM driver_assignments WHERE order_id=orders.id)
        AND NOT EXISTS(SELECT 1 FROM driver_route_stops WHERE order_id=orders.id)`)
      .bind(runId, now, orderId),
    DB.prepare(`INSERT INTO status_history(order_id,status,at,note)
      SELECT id,status,?,? FROM orders WHERE id=? AND rehearsal_run_id=? AND changes()=1`)
      .bind(now, `payment_rehearsal_registered:${actor}`, orderId, runId),
  ]);
  if (Number(result[0]?.meta?.changes) === 1) return { marked: true };
  const existing = await DB.prepare('SELECT rehearsal_run_id FROM orders WHERE id=?').bind(orderId).first();
  return existing?.rehearsal_run_id === runId ? { marked: true, unchanged: true } : { error: 'rehearsal_ineligible' };
}

export async function closePaymentRehearsal(DB, orderId, now = Date.now()) {
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(now) || now <= 0)
    return { error: 'invalid_rehearsal' };
  const result = await DB.batch([
    DB.prepare(`UPDATE orders SET rehearsal_closed_at=?
      WHERE id=? AND rehearsal_run_id IS NOT NULL AND rehearsal_closed_at IS NULL`).bind(now, orderId),
    DB.prepare(`INSERT INTO status_history(order_id,status,at,note)
      SELECT id,status,?,'payment_rehearsal_closed:ops' FROM orders
      WHERE id=? AND rehearsal_run_id IS NOT NULL AND changes()=1`).bind(now, orderId),
  ]);
  if (Number(result[0]?.meta?.changes) === 1) return { closed: true };
  const order = await DB.prepare('SELECT rehearsal_run_id,rehearsal_closed_at FROM orders WHERE id=?').bind(orderId).first();
  return order?.rehearsal_run_id && order.rehearsal_closed_at
    ? { closed: true, unchanged: true } : { error: 'not_rehearsal' };
}

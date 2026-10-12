// Offline decision policy only. External stop adapters need separate approved wiring.
export function shutdownDecision(s, now) {
  const reasons = [];
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(s.expiresAt)
      || !Number.isSafeInteger(s.billingAt) || !Number.isSafeInteger(s.projectedGrossMicros)
      || !Number.isSafeInteger(s.requests) || !Number.isSafeInteger(s.queueOperations)
      || [s.projectedGrossMicros,s.requests,s.queueOperations].some(v=>v<0)
      || s.billingAt>now || !s.runID || s.observedRunID!==s.runID) reasons.push('invalid_or_misbound_evidence');
  if (s.operatorStop) reasons.push('operator_stop');
  if (now >= s.expiresAt) reasons.push('expiry');
  if (now - s.billingAt > 300000) reasons.push('stale_billing');
  if (s.projectedGrossMicros >= 8000000) reasons.push('cloudflare_stop');
  if (s.requests > 200) reasons.push('request_limit');
  if (s.queueOperations > 100) reasons.push('queue_limit');
  if (s.providerAllowanceExceeded) reasons.push('provider_limit');
  if (s.uncertainPayment || s.recipientMismatch) reasons.push('uncertain_effect');
  const retainReconciliation = s.invoiceIssued===true && s.financiallyResolved!==true;
  return {stop:reasons.length>0, warning:s.projectedGrossMicros>=7000000, reasons,
    actions:reasons.length ? ['stop_run_and_full_grant','flags_off','queue_pause','booking_callback_blank',
      'remove_unused_bindings', retainReconciliation ? 'retain_scoped_financial_reconciliation'
        : 'remove_new_subscription_and_exposure'] : [],
    // Closing/archive must be a separately reviewed operator action, not a fake delivery.
    retainReconciliation, operationalThresholdsOnly:true};
}

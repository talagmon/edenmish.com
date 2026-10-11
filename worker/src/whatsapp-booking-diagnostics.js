// Fixed codes only: never retain provider output, quotes or customer text.
export const BOOKING_REJECTION_REASONS = Object.freeze([
  'input_json','input_size','input_sensitive','envelope_shape','envelope_values',
  'intent_fields','intent_context','field_shape','field_duplicate','quote_format',
  'quote_missing','quote_ambiguous','quote_boundary','quote_negated','quote_overlap','route_role','route_ambiguous','route_unmarked',
  'size_unsupported','size_context_ambiguous','schedule_unsupported','email_invalid','validation_exception',
]);
export function safeBookingRejection(value) {
  return BOOKING_REJECTION_REASONS.includes(value) ? value : null;
}

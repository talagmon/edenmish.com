(function (root, factory) {
  const businessBooking = factory();
  if (typeof module === "object" && module.exports) module.exports = businessBooking;
  if (root) root.EdenBusinessBooking = businessBooking;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SERVICE_ORDER = ["eco", "standard", "flash"];

  function planServiceState(plan) {
    const rates = plan && plan.rates || {};
    const available = SERVICE_ORDER.filter((service) => (
      Object.keys(rates).some((key) => key.split(":")[1] === service)
    ));
    const recommended = plan && plan.value && plan.value.example && plan.value.example.service;
    return {
      available,
      preferred: available.includes(recommended) ? recommended : (available[0] || null),
    };
  }

  function businessEmailFieldState(value) {
    const email = String(value || "").trim();
    return { value: email, readOnly: Boolean(email) };
  }

  async function prepareAuthoritativeQuote({ businessMode, quote, quoteFingerprint, expectedFingerprint, fetchQuote }) {
    if (!businessMode) return { quote: quote || null, canSubmit: true, refreshed: false };
    if (quote && quoteFingerprint === expectedFingerprint) {
      return { quote, canSubmit: true, refreshed: false };
    }
    const refreshedQuote = await fetchQuote();
    return { quote: refreshedQuote || null, canSubmit: false, refreshed: true };
  }

  return { businessEmailFieldState, planServiceState, prepareAuthoritativeQuote };
});

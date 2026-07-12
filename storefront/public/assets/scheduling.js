(function (root, factory) {
  const scheduling = factory();
  if (typeof module === "object" && module.exports) module.exports = scheduling;
  if (root) root.EdenScheduling = scheduling;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const WEEKDAY_HOURS = { start: 9, end: 20 };
  const FRIDAY_HOURS = { start: 8, end: 13 };
  const ECO_PICKUP_CUTOFF_HOUR = 13;
  const SAME_DAY_LEAD_MINUTES = 3 * 60;
  const PICKUP_WINDOW_HOURS = 3;

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function businessHours(day) {
    if (day === 6) return null;
    return day === 5 ? FRIDAY_HOURS : WEEKDAY_HOURS;
  }

  function earliestSameDayHour(now) {
    const earliestMinutes = now.getHours() * 60 + now.getMinutes() + SAME_DAY_LEAD_MINUTES;
    return Math.ceil(earliestMinutes / 60);
  }

  function generatePickupWindows({ service, dateType, day, now = new Date() }) {
    const hours = businessHours(day);
    if (!hours) return [];

    let startHour = hours.start;
    const endHour = service === "eco"
      ? Math.min(hours.end, ECO_PICKUP_CUTOFF_HOUR)
      : hours.end;

    if (dateType === "today") {
      startHour = Math.max(startHour, earliestSameDayHour(now));
    }

    const windows = [];
    for (let hour = startHour; hour < endHour; hour++) {
      let windowEnd = hour + PICKUP_WINDOW_HOURS;
      if (windowEnd > endHour) {
        // Same-day orders may use the pickup time that remains before closing.
        // Future dates keep the standard full three-hour windows.
        if (dateType !== "today") break;
        windowEnd = endHour;
      }
      windows.push(pad2(hour) + ":00-" + pad2(windowEnd) + ":00");
    }
    return windows;
  }

  return {
    businessHours,
    earliestSameDayHour,
    generatePickupWindows,
  };
});

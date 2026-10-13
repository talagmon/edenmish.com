import { scheduleError } from './validate.js';

const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function israelDay(now) {
  return dayFormatter.format(now);
}

// Timing eligibility only, not a capacity reservation. Keep the website policy
// in storefront/public/assets/scheduling.js: three-hour same-day lead, full
// three-hour future windows, and truncated same-day windows before closing.
// Parity tests exercise the actual storefront generator as an independent oracle.
export function bookingScheduleError(date, hour, now = Date.now()) {
  const stamp = Date.parse(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp)
    || new Date(stamp).toISOString().slice(0, 10) !== date
    || !Number.isInteger(hour) || hour < 0 || hour > 23) return 'invalid_schedule';
  const today = israelDay(now);
  if (date < today) return 'past_schedule';
  if (stamp > now + 30 * 86400000) return 'outside_booking_horizon';
  const day = new Date(stamp).getUTCDay();
  const hoursError = scheduleError('standard', day, hour);
  if (hoursError) return hoursError;
  if (date === today) {
    const localTime = timeFormatter.format(now);
    const [currentHour, minute] = localTime.split(':').map(Number);
    // Minute precision matches the website, including exactly on the hour.
    if (hour < Math.ceil((currentHour * 60 + minute + 180) / 60)) return 'insufficient_lead_time';
  } else if (hour + 3 > (day === 5 ? 13 : 20)) return 'incomplete_pickup_window';
  return null;
}

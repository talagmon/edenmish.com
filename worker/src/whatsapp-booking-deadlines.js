// Local deadline mechanics only. No provider calls, activation, retries, refunds,
// or extension of existing grants. Runtime full-booking consent/config is separate.
export const BOOKING_DEADLINES = Object.freeze({ softMs: 10000, transportMs: 20000, customerMs: 30000, operatorMs: 60000 });
const contexts = new WeakMap();
const deadlineError = code => Object.assign(new Error(code === 'booking_aborted' ? 'Booking operation aborted' : 'Booking deadline exceeded'), { code });
const readClock = clock => {
  const value = clock();
  if (!Number.isFinite(value)) throw new TypeError('Invalid booking clock');
  return value;
};

// A nested operation is clipped to the known parent signal's absolute deadline.
// remainingMs() is checked fresh: an awaited stage must not restart the budget.
export async function withBookingDeadline(operation, { timeoutMs, clock = Date.now, signal } = {}) {
  if (typeof operation !== 'function' || typeof clock !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > BOOKING_DEADLINES.operatorMs) throw new TypeError('Invalid booking deadline');
  if (signal?.aborted) throw deadlineError('booking_aborted');
  const startedAt = readClock(clock), parent = signal && contexts.get(signal);
  const deadlineAt = Math.min(startedAt + timeoutMs, parent?.deadlineAt ?? Infinity);
  if (deadlineAt <= startedAt) throw deadlineError('booking_deadline_exceeded');
  const controller = new AbortController();
  const context = { signal: controller.signal, deadlineAt, remainingMs: () => Math.max(0, deadlineAt - readClock(clock)) };
  contexts.set(controller.signal, { deadlineAt });
  let timer, abortListener;
  const stopped = new Promise((_, reject) => {
    const stop = code => {
      const error = deadlineError(code);
      controller.abort(error);
      reject(error);
    };
    abortListener = () => stop(signal?.reason?.code === 'booking_deadline_exceeded' ? 'booking_deadline_exceeded' : 'booking_aborted');
    if (signal) signal.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => stop('booking_deadline_exceeded'), deadlineAt - startedAt);
  });
  try {
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (readClock(clock) >= deadlineAt) throw deadlineError('booking_deadline_exceeded');
      return operation(context);
    });
    const result = await Promise.race([work, stopped]);
    // Catch a late return even when an injected clock or a blocked event loop
    // reaches the boundary before the timer callback is scheduled.
    if (controller.signal.aborted) throw controller.signal.reason;
    if (readClock(clock) >= deadlineAt) throw deadlineError('booking_deadline_exceeded');
    return result;
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error?.code === 'booking_deadline_exceeded' ? deadlineError('booking_deadline_exceeded') : deadlineError('booking_aborted'));
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}

// An operator preflight has a separate 60s envelope. Preparation and settlement
// consume that envelope; its single customer-shaped run gets at most 30s within
// it. Exhausting the envelope never runs cleanup outside it or retries work.
export async function runBookingPreflight({ prepare, run, settle }, { clock = Date.now, signal } = {}) {
  if (![prepare, run, settle].every(operation => typeof operation === 'function')) throw new TypeError('Invalid booking preflight');
  return withBookingDeadline(async outer => {
    let prepared, result, failure;
    try {
      prepared = await prepare(outer);
      result = await withBookingDeadline(inner => run({ ...inner, prepared }), {
        timeoutMs: BOOKING_DEADLINES.customerMs, clock, signal: outer.signal,
      });
    } catch (error) { failure = error; }
    if (outer.signal.aborted || outer.remainingMs() <= 0) throw failure || deadlineError('booking_deadline_exceeded');
    const outcome = !failure ? 'success' : failure.code === 'booking_deadline_exceeded' ? 'timeout' : failure.code === 'booking_aborted' ? 'aborted' : 'failed';
    await settle({ ...outer, outcome, prepared, ...(failure ? {} : { result }) });
    if (failure) throw failure;
    return result;
  }, { timeoutMs: BOOKING_DEADLINES.operatorMs, clock, signal });
}

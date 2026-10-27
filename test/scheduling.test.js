"use strict";

// Scheduling and config-validation checks for pi-igniter (pure functions).
//
// Grid points are windowStart + delay + k x interval, in absolute time. The
// interval is the cadence (5 hours in the field report that shaped this) and the
// delay is the offset after every boundary, so 03:00-19:00 with a 300 minute
// interval and a 60 second delay fires at 03:01, 08:01, 13:01 and 18:01.

const assert = require("node:assert/strict");
const path = require("node:path");
const T = require(path.join(__dirname, "..", "src", "main.js")).__test;

// Local time, the schedule's own frame. 2026-10-27 is a Tuesday.
function at(hour, minute = 0, dayOffset = 0, second = 0) {
  const d = new Date(2026, 9, 27, hour, minute, second, 0);
  if (dayOffset) d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// The reported configuration: 5 hour cadence, one minute after each boundary.
const OFFICE = { enabled: true, startHour: 3, endHour: 19, intervalMinutes: 300, delaySeconds: 60, modelKey: "p/m" };

function reset(runtime = {}, config = {}) {
  T.setConfig({ ...OFFICE, ...config });
  T.setRuntime({ circuitUntil: 0, retryAt: 0, lastFiredAt: 0, lastScheduledAt: 0, ...runtime });
}

console.log("window bounds (the delay is not part of the window)");
reset();
check("a plain window runs from start to end on the same day", () => {
  const bounds = T.windowBounds(at(10));
  assert.equal(bounds.start, at(3));
  assert.equal(bounds.end, at(19));
});
check("end hour 24 closes at the next midnight", () => {
  const bounds = T.windowBounds(at(10), {});
  T.setConfig({ ...OFFICE, startHour: 0, endHour: 24 });
  const wide = T.windowBounds(at(10));
  assert.equal(wide.start, at(0));
  assert.equal(wide.end, at(0, 0, 1));
  assert.ok(bounds.start);
});
check("a window crossing midnight is anchored the day before", () => {
  T.setConfig({ ...OFFICE, startHour: 22, endHour: 6 });
  const bounds = T.windowBounds(at(3));
  assert.equal(bounds.start, at(22, 0, -1));
  assert.equal(bounds.end, at(6));
});
check("start === end is a full day", () => {
  T.setConfig({ ...OFFICE, startHour: 7, endHour: 7 });
  const bounds = T.windowBounds(at(20));
  assert.equal(bounds.end - bounds.start, 24 * 60 * 60 * 1000);
});
check("start === end: before the start hour the window opened yesterday", () => {
  T.setConfig({ ...OFFICE, startHour: 3, endHour: 3 });
  const bounds = T.windowBounds(at(1));
  assert.equal(bounds.start, at(3, 0, -1));
  assert.equal(bounds.end, at(3));
  assert.equal(T.inWindow(at(1)), true, "01:00 is inside a full-day window that starts at 03:00");
  assert.equal(T.inWindow(at(2, 59)), true);
  assert.equal(T.inWindow(at(3)), true);
});
check("start === end: every hour of the day is inside", () => {
  for (const startEnd of [0, 3, 12, 23]) {
    T.setConfig({ ...OFFICE, startHour: startEnd, endHour: startEnd });
    for (let hour = 0; hour < 24; hour += 1) {
      assert.equal(T.inWindow(at(hour, 30)), true, `${hour}:30 with start = end = ${startEnd}`);
    }
  }
});
check("start === end: a missed point before the start hour is owed", () => {
  reset({ lastScheduledAt: at(18, 1, -1) }, { startHour: 3, endHour: 3 });
  assert.equal(T.nextDueAt(at(1)), at(1));
});
check("start === end: after the last point the next run is today's first point", () => {
  reset({ lastScheduledAt: at(23, 1, -1) }, { startHour: 3, endHour: 3 });
  assert.equal(T.nextDueAt(at(1)), at(3, 1));
});

console.log("window membership");
reset();
check("09:00 inside", () => assert.equal(T.inWindow(at(9)), true));
check("02:59 outside", () => assert.equal(T.inWindow(at(2, 59)), false));
check("03:00 inside (inclusive start)", () => assert.equal(T.inWindow(at(3)), true));
check("18:59 inside", () => assert.equal(T.inWindow(at(18, 59)), true));
check("19:00 outside (exclusive end)", () => assert.equal(T.inWindow(at(19)), false));
T.setConfig({ ...OFFICE, startHour: 22, endHour: 6 });
check("23:00 inside a crossing window", () => assert.equal(T.inWindow(at(23)), true));
check("03:00 inside a crossing window", () => assert.equal(T.inWindow(at(3)), true));
check("06:00 outside a crossing window", () => assert.equal(T.inWindow(at(6)), false));

console.log("grid points (03:00 start, 300 min interval, 60 s delay)");
reset();
check("before the first point the grid still reports it", () => {
  assert.equal(T.gridPointAt(at(3), T.windowBounds(at(3))), at(3, 1));
});
check("03:01 is the first point", () => {
  assert.equal(T.gridPointAt(at(3, 1), T.windowBounds(at(3, 1))), at(3, 1));
});
check("08:00 still belongs to the 03:01 point", () => {
  assert.equal(T.gridPointAt(at(8), T.windowBounds(at(8))), at(3, 1));
});
check("08:01 opens the second point", () => {
  assert.equal(T.gridPointAt(at(8, 1), T.windowBounds(at(8, 1))), at(8, 1));
});
check("13:01 is the third point", () => {
  assert.equal(T.gridPointAt(at(15), T.windowBounds(at(15))), at(13, 1));
});
check("18:01 is the last point of the day", () => {
  assert.equal(T.gridPointAt(at(18, 30), T.windowBounds(at(18, 30))), at(18, 1));
});

console.log("due time");
reset();
check("disabled schedules nothing", () => {
  T.setConfig({ ...OFFICE, enabled: false });
  assert.equal(T.nextDueAt(at(10)), 0);
});
reset({}, { modelKey: "" });
check("nothing scheduled without a model", () => assert.equal(T.nextDueAt(at(10)), 0));
reset();
check("before the window it waits for the first point", () => assert.equal(T.nextDueAt(at(1)), at(3, 1)));
check("after the window it waits for tomorrow's first point", () => assert.equal(T.nextDueAt(at(20)), at(3, 1, 1)));
check("inside the window but before the delay it still waits", () => {
  assert.equal(T.nextDueAt(at(3)), at(3, 1));
});
reset({ lastScheduledAt: at(3, 1) });
check("after the 03:01 run the next point is 08:01", () => assert.equal(T.nextDueAt(at(3, 30)), at(8, 1)));
check("a due point fires at once", () => assert.equal(T.nextDueAt(at(8, 1)), at(8, 1)));
check("a missed point is caught up instead of sliding", () => assert.equal(T.nextDueAt(at(10)), at(10)));

// The field report: with the cycle anchored at 13:01, a manual ignition at
// 17:00 must leave 18:01 as the next run.
reset({ lastScheduledAt: at(13, 1), lastFiredAt: at(17) });
check("a manual run does not move the schedule (still 18:01)", () => {
  assert.equal(T.nextDueAt(at(17)), at(18, 1));
});

reset({ lastScheduledAt: at(18, 1), lastFiredAt: at(18, 1) });
check("a point past the window end becomes tomorrow's first point", () => {
  assert.equal(T.nextDueAt(at(18, 5)), at(3, 1, 1));
});
reset({ lastScheduledAt: at(18, 1) });
check("no due time is ever outside the window", () => {
  for (const [h, m] of [[3, 0], [3, 1], [8, 30], [13, 1], [18, 1], [18, 30], [19, 0], [23, 0], [2, 0]]) {
    const now = at(h, m);
    const due = T.nextDueAt(now);
    const bounds = T.windowBounds(now);
    const inside = due >= bounds.start && due < bounds.end;
    const nextWindow = T.windowStartAfter(now, 3) + T.delayMs();
    assert.ok(inside || due === nextWindow, `${h}:${m} produced ${new Date(due).toString()}`);
  }
});

reset({}, { intervalMinutes: 1440, delaySeconds: 0 });
check("an interval longer than the window runs once a day", () => {
  T.setRuntime({ lastScheduledAt: at(3), lastFiredAt: at(3) });
  assert.equal(T.nextDueAt(at(10)), at(3, 0, 1));
});

// A one-hour window with a one-hour delay has no point before the end.
reset({}, { startHour: 3, endHour: 4, delaySeconds: 3600 });
check("a delay longer than the window leaves no point today", () => {
  assert.equal(T.nextDueAt(at(3, 30)), at(3, 0, 1) + 3600 * 1000);
});

console.log("protection still holds the schedule back");
reset();
check("the circuit wins over a due point", () => {
  T.setRuntime({ circuitUntil: at(20) });
  assert.equal(T.nextDueAt(at(10)), at(20));
});
reset();
check("a retry delay wins over a due point", () => {
  T.setRuntime({ retryAt: at(10, 5) });
  assert.equal(T.nextDueAt(at(10)), at(10, 5));
});
// A rate-limit backoff can wait an hour, which from late in the window lands
// past endHour. Nothing runs outside the window, so the reported time must be
// the next window's first point rather than a time that never fires.
reset();
check("a retry that would land after the window end reports the next window", () => {
  T.setRuntime({ retryAt: at(19, 30) });
  assert.equal(T.nextDueAt(at(18, 30)), at(3, 1, 1));
});
check("a retry that still lands inside the window keeps its own time", () => {
  T.setRuntime({ retryAt: at(18, 50) });
  assert.equal(T.nextDueAt(at(18, 30)), at(18, 50));
});
// The panel's progress bar divides the remaining wait by this total.
reset();
check("a backoff is drawn against its own length", () => {
  T.setRuntime({ lastAttemptAt: at(10), retryAt: at(10, 5), lastScheduledAt: at(8, 1) });
  const due = T.nextDueAt(at(10, 2));
  assert.equal(due, at(10, 5));
  assert.equal(T.waitTotalMs(due, at(10, 2)), 5 * 60 * 1000, "five minutes, not the five hour interval");
});
check("a normal wait is one interval", () => {
  T.setRuntime({ lastAttemptAt: at(8, 1), retryAt: 0, lastScheduledAt: at(8, 1) });
  const due = T.nextDueAt(at(10));
  assert.equal(due, at(13, 1));
  assert.equal(T.waitTotalMs(due, at(10)), 300 * 60 * 1000);
});
check("a backoff past the window end falls back to the interval", () => {
  T.setRuntime({ lastAttemptAt: at(18, 30), retryAt: at(19, 30), lastScheduledAt: at(18, 1) });
  const due = T.nextDueAt(at(18, 40));
  assert.equal(due, at(3, 1, 1), "the next window's first point");
  assert.equal(T.waitTotalMs(due, at(18, 40)), 300 * 60 * 1000, "the retry is not what the bar is waiting for");
});

console.log("crossing window grid (start 22, end 6, interval 60, delay 30)");
T.setConfig({ enabled: true, startHour: 22, endHour: 6, intervalMinutes: 60, delaySeconds: 30, modelKey: "p/m" });
check("points step hourly from 22:00:30", () => {
  T.setRuntime({ circuitUntil: 0, retryAt: 0, lastScheduledAt: at(23, 0, 0, 30) });
  assert.equal(T.nextDueAt(at(23, 30)), at(0, 0, 1, 30));
});
check("the last point before 06:00 hands over to the next window", () => {
  T.setRuntime({ lastScheduledAt: at(5, 0, 0, 30) });
  assert.equal(T.nextDueAt(at(5, 30)), at(22, 0, 0, 30));
});

console.log("quiet hours");
const quiet = (patch) => T.setConfig({ ...OFFICE, quietEnabled: true, quietStartHour: 23, quietEndHour: 7, ...patch });
quiet({});
check("a span across midnight covers the night and not the day", () => {
  assert.equal(T.inQuietHours(at(23)), true, "23:00 is the inclusive start");
  assert.equal(T.inQuietHours(at(23, 59)), true);
  assert.equal(T.inQuietHours(at(0)), true, "the span continues after midnight");
  assert.equal(T.inQuietHours(at(6, 59)), true);
  assert.equal(T.inQuietHours(at(7)), false, "07:00 is the exclusive end");
  assert.equal(T.inQuietHours(at(12)), false);
  assert.equal(T.inQuietHours(at(22, 59)), false);
});
quiet({ quietStartHour: 13, quietEndHour: 15 });
check("a same-day span covers only its own hours", () => {
  assert.equal(T.inQuietHours(at(12, 59)), false);
  assert.equal(T.inQuietHours(at(13)), true);
  assert.equal(T.inQuietHours(at(14, 30)), true);
  assert.equal(T.inQuietHours(at(15)), false);
  assert.equal(T.inQuietHours(at(23)), false);
});
check("the switch turns the whole span off", () => {
  quiet({ quietEnabled: false });
  assert.equal(T.inQuietHours(at(3)), false);
});
check("start === end means off, never a silent day", () => {
  quiet({ quietStartHour: 0, quietEndHour: 0 });
  for (const hour of [0, 3, 12, 23]) assert.equal(T.inQuietHours(at(hour)), false, `${hour}:00`);
});
check("end hour 24 reaches midnight", () => {
  quiet({ quietStartHour: 22, quietEndHour: 24 });
  assert.equal(T.inQuietHours(at(22)), true);
  assert.equal(T.inQuietHours(at(23, 59)), true);
  assert.equal(T.inQuietHours(at(3)), false, "00:00 is outside 22-24");
});
check("out-of-range quiet hours are clamped", () => {
  const clamped = T.sanitize({ quietStartHour: -5, quietEndHour: 99 });
  assert.equal(clamped.quietStartHour, 0);
  assert.equal(clamped.quietEndHour, 24);
  // sanitize() starts from the live config, so pin it before checking defaults.
  T.setConfig({ ...OFFICE, quietEnabled: false });
  assert.equal(T.sanitize({ quietEnabled: "yes" }).quietEnabled, false, "a non-boolean is ignored");
  assert.equal(T.sanitize({ quietEnabled: true }).quietEnabled, true);
});

console.log("config validation");
T.setConfig({ enabled: true, startHour: 8, endHour: 23, intervalMinutes: 60, delaySeconds: 0, modelKey: "" });
check("interval floor is 1 minute", () => assert.equal(T.sanitize({ intervalMinutes: 0 }).intervalMinutes, 1));
check("negative interval clamps to 1", () => assert.equal(T.sanitize({ intervalMinutes: -30 }).intervalMinutes, 1));
check("interval ceiling is 1440", () => assert.equal(T.sanitize({ intervalMinutes: 99999 }).intervalMinutes, 1440));
check("delay floor is 0", () => assert.equal(T.sanitize({ delaySeconds: -5 }).delaySeconds, 0));
check("delay ceiling is 3600", () => assert.equal(T.sanitize({ delaySeconds: 99999 }).delaySeconds, 3600));
check("delay accepts a plain value", () => assert.equal(T.sanitize({ delaySeconds: 60 }).delaySeconds, 60));
check("start hour clamps to 0", () => assert.equal(T.sanitize({ startHour: -3 }).startHour, 0));
check("start hour clamps to 23", () => assert.equal(T.sanitize({ startHour: 30 }).startHour, 23));
check("end hour allows 24", () => assert.equal(T.sanitize({ endHour: 24 }).endHour, 24));
check("end hour clamps above 24", () => assert.equal(T.sanitize({ endHour: 99 }).endHour, 24));
check("model key is trimmed", () => assert.equal(T.sanitize({ modelKey: "  p/m  " }).modelKey, "p/m"));
check("non-boolean enabled is ignored", () => assert.equal(T.sanitize({ enabled: "yes" }).enabled, true));
check("unknown keys are dropped", () => assert.equal(Object.hasOwn(T.sanitize({ nope: 1 }), "nope"), false));
check("fractional values round", () => assert.equal(T.sanitize({ intervalMinutes: 90.6 }).intervalMinutes, 91));
check("a Bark URL must be empty or http(s)", () => {
  assert.equal(T.sanitize({ barkUrl: "  https://api.day.app/k  " }).barkUrl, "https://api.day.app/k");
  assert.equal(T.sanitize({ barkUrl: "http://bark.local/k" }).barkUrl, "http://bark.local/k");
  assert.equal(T.sanitize({ barkUrl: "ftp://bark.local/k" }).barkUrl, "", "ftp is not a push target");
  assert.equal(T.sanitize({ barkUrl: "javascript:alert(1)" }).barkUrl, "");
  assert.equal(T.sanitize({ barkUrl: "file:///etc/passwd" }).barkUrl, "");
  assert.equal(T.sanitize({ barkUrl: "api.day.app/k" }).barkUrl, "", "a bare host has no scheme");
});
check("an invalid Bark URL keeps the previous value, an empty one turns push off", () => {
  T.setConfig({ barkUrl: "https://api.day.app/old" });
  assert.equal(T.sanitize({ barkUrl: "ftp://x" }).barkUrl, "https://api.day.app/old");
  assert.equal(T.sanitize({ barkUrl: "" }).barkUrl, "");
});

console.log("state read from disk");
const RUNTIME_BASE = { lastFiredAt: 0, lastScheduledAt: 0, lastAttemptAt: 0, lastMs: 0, failures: 0, circuitUntil: 0, retryAt: 0, lastOk: null, lastError: "", log: [] };
check("damaged runtime fields fall back to safe values", () => {
  const out = T.sanitizeRuntime(
    { lastFiredAt: "yesterday", failures: -2, circuitUntil: null, retryAt: Infinity, lastMs: {}, lastOk: "yes", lastError: 5, log: "nope" },
    RUNTIME_BASE
  );
  assert.equal(out.lastFiredAt, 0);
  assert.equal(out.failures, 0);
  assert.equal(out.circuitUntil, 0);
  assert.equal(out.retryAt, 0);
  assert.equal(out.lastMs, 0);
  assert.equal(out.lastOk, null);
  assert.equal(out.lastError, "");
  assert.deepEqual(out.log, []);
});
check("valid runtime fields survive", () => {
  const entry = { t: 5, ok: true, ms: 12 };
  const out = T.sanitizeRuntime(
    { lastFiredAt: 1700000000000, lastScheduledAt: 1700000000000, failures: 2, lastOk: false, lastError: "boom", log: [entry] },
    RUNTIME_BASE
  );
  assert.equal(out.lastFiredAt, 1700000000000);
  assert.equal(out.failures, 2);
  assert.equal(out.lastOk, false);
  assert.equal(out.lastError, "boom");
  assert.deepEqual(out.log, [entry]);
});
check("junk log entries are dropped and the log is capped", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ t: i, ok: true }));
  const out = T.sanitizeRuntime({ log: [null, "x", 3, ...many] }, RUNTIME_BASE);
  assert.equal(out.log.length, 50);
  assert.ok(out.log.every((entry) => entry && typeof entry === "object"));
});
check("a non-object runtime leaves the base untouched", () => {
  assert.deepEqual(T.sanitizeRuntime(null, RUNTIME_BASE), RUNTIME_BASE);
  assert.deepEqual(T.sanitizeRuntime("x", RUNTIME_BASE), RUNTIME_BASE);
});

console.log("push text");
check("a UUID provider prefix is dropped from the model name", () => {
  assert.equal(T.modelDisplay("a620698c-58f5-4478-b773-6f3746373067/claude-haiku-5-5"), "claude-haiku-5-5");
});
check("a readable provider id is kept", () => assert.equal(T.modelDisplay("cpa/model-a"), "cpa/model-a"));
check("a key without a slash and an empty key pass through", () => {
  assert.equal(T.modelDisplay("model-a"), "model-a");
  assert.equal(T.modelDisplay(""), "");
  assert.equal(T.modelDisplay(undefined), "");
});


console.log("helpers");
check("hourOf is fractional", () => assert.equal(T.hourOf(at(7, 30)), 7.5));
T.setConfig({ intervalMinutes: 5, delaySeconds: 90 });
check("intervalMs converts to ms", () => assert.equal(T.intervalMs(), 300000));
check("delayMs converts to ms", () => assert.equal(T.delayMs(), 90000));

console.log("failure classification");
check("an upstream 429 message is a rate limit", () => {
  const { kind } = T.classifyFailure(
    new Error('429: custom API error (429): {"code":"upstream_rate_limited","message":"Upstream rate limit exceeded."}')
  );
  assert.equal(kind, "rate-limit");
});
check("the host's own RATE_LIMITED code is a rate limit", () => {
  assert.equal(T.classifyFailure(new Error("RATE_LIMITED plugin completion rate exceeded")).kind, "rate-limit");
  assert.equal(T.classifyFailure({ message: "nope", code: "RATE_LIMITED" }).kind, "rate-limit");
});
check("a status of 429 is enough, even without the text", () => {
  assert.equal(T.classifyFailure({ message: "custom API error", status: 429 }).kind, "rate-limit");
  assert.equal(T.classifyFailure({ message: "custom API error", details: { providerStatus: 429 } }).kind, "rate-limit");
});
check("a plain failure stays a plain failure", () => {
  for (const message of [
    "model not found: cpa/gone",
    "HTTP 500 upstream unavailable",
    "HTTP 403 forbidden",
    "ECONNREFUSED",
    "4290 tokens exceed the limit",
  ]) {
    assert.equal(T.classifyFailure(new Error(message)).kind, "error", message);
  }
});
check("Retry-After is read from seconds and from milliseconds", () => {
  assert.equal(T.parseRetryAfterMs("429 retry-after: 600"), 600000);
  assert.equal(T.parseRetryAfterMs('{"retry_after":120}'), 120000);
  assert.equal(T.parseRetryAfterMs("retry-after-ms: 25000"), 25000);
  assert.equal(T.parseRetryAfterMs("429 without a hint"), 0);
});
check("Retry-After is clamped to a sane range", () => {
  assert.equal(T.parseRetryAfterMs("retry-after: 0"), 0);
  assert.equal(T.parseRetryAfterMs("retry-after: 999999"), 60 * 60 * 1000, "an hour is the ceiling");
  assert.equal(T.clampRetryAfter(-5), 0);
  assert.equal(T.clampRetryAfter(100), 1000, "one second is the floor");
});
check("the rate-limit ladder doubles and outranks a short Retry-After", () => {
  const minute = 60 * 1000;
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => T.rateLimitBackoff(n, 0)),
    [5 * minute, 10 * minute, 20 * minute, 40 * minute]
  );
  assert.equal(T.rateLimitBackoff(9, 0), 60 * minute, "capped at an hour");
  assert.equal(T.rateLimitBackoff(1, 30 * minute), 30 * minute, "the provider's wish wins when longer");
  assert.equal(T.rateLimitBackoff(3, 5 * minute), 20 * minute, "the ladder wins when longer");
});

console.log(`\n${passed} checks passed`);

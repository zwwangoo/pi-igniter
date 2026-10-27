"use strict";

/**
 * Igniter — keep a model warm on a fixed schedule.
 *
 * Between a daily start and end hour, send one minimal completion every N
 * minutes through PI-Desktop's own provider configuration. The request goes
 * through the host's agent.complete API, so this plugin never sees an API key
 * and never chooses a URL.
 *
 * Borrowed from the CPA Lamplighter plugin: decision-based scheduling (due time
 * computed from absolute time, never accumulated, so it cannot drift), failure
 * classification with exponential backoff, a circuit that trips to the next
 * daily start, and a status view that answers "when next, what happened last".
 * Dropped: everything that needed 5-hour quota windows, because the reverse
 * proxy in front of the account reports none.
 */

const fs = require("node:fs");
const path = require("node:path");

// Service ids may not contain a dot: the host requires
// [a-zA-Z][a-zA-Z0-9_-]{0,63} for contributes.services.
const SERVICE_ID = "igniter-scheduler";
const COMMAND_ID = "igniter.open";

const TICK_MS = 30 * 1000;
const MAX_LOG = 50;
const MAX_FAILURES = 3;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;
const MAX_DELAY_SECONDS = 3600;
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_FACTOR = 3;
// A 429 is a "come back later", not a broken setup: it gets its own, slower
// retry ladder and a higher tolerance before the day is given up on.
const MAX_RATE_LIMIT_FAILURES = 6;
const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
// Bark is fire-and-forget: a slow push server must never delay an ignition.
const BARK_TIMEOUT_MS = 8 * 1000;
const BARK_GROUP = "Igniter";
const PROMPT_TEXT = "OK";
const SYSTEM_PROMPT =
  "You are a keep-alive probe. Reply with exactly: OK. Do not use tools, do not explain.";

const DEFAULTS = {
  enabled: true,
  // Shipped defaults describe the 5-hour-window setup this plugin was written
  // for: 03:00-19:00, one ignition every 5 hours, one minute after each
  // boundary. The model and the Bark URL stay empty on purpose.
  startHour: 3,
  endHour: 19,
  intervalMinutes: 300,
  // Added after every interval boundary, so a window that resets on the hour
  // is ignited a little after it rather than exactly on it.
  delaySeconds: 60,
  modelKey: "",
  // Bark push target. Empty disables push notifications.
  barkUrl: "",
  notifyOnCircuit: true,
  // Quiet hours: an optional daily span in which notifications are not
  // delivered. Off by default, so an upgrade never surprises anyone.
  quietEnabled: false,
  quietStartHour: 23,
  quietEndHour: 7,
};

let dataPath = "";
let stateFile = "";
let cfg = { ...DEFAULTS };
// Runtime state. Deliberately separate from cfg: config is user intent,
// runtime is evidence.
let rt = {
  lastFiredAt: 0,
  // Last grid point an automatic run satisfied. Manual ignition does not move
  // it, so pressing "ignite now" never shifts the schedule.
  lastScheduledAt: 0,
  lastAttemptAt: 0,
  lastOk: null,
  lastError: "",
  // "rate-limit" when the provider asked us to back off; "" after a success and
  // for a plain failure. The panel and the push titles read it.
  lastKind: "",
  lastMs: 0,
  failures: 0,
  circuitUntil: 0,
  retryAt: 0,
  log: [],
};
let tickTimer = null;
let inFlight = false;
let tickTimerBusy = false;

// ---------------------------------------------------------------- scheduling

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function intervalMs() {
  return clampInt(cfg.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, DEFAULTS.intervalMinutes) * 60 * 1000;
}

function delayMs() {
  return clampInt(cfg.delaySeconds, 0, MAX_DELAY_SECONDS, DEFAULTS.delaySeconds) * 1000;
}
/** local hour as a fraction, e.g. 07:30 -> 7.5 */
function hourOf(ms) {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

function startHourValue() {
  return clampInt(cfg.startHour, 0, 23, DEFAULTS.startHour);
}

function endHourValue() {
  return clampInt(cfg.endHour, 0, 24, DEFAULTS.endHour);
}

/**
 * The window that covers ms, as [start, end).
 * A window crossing midnight is anchored at yesterday's start hour when ms is
 * before endHour, so 03:00 with start 22 / end 6 belongs to yesterday's window.
 * start === end means one window per day, running the full 24 hours.
 */
function windowBounds(ms) {
  const start = startHourValue();
  const end = endHourValue();
  const anchor = new Date(ms);
  anchor.setHours(start, 0, 0, 0);
  // start === end is a full day, so before the start hour the window is still
  // the one that opened yesterday.
  if (start >= end && hourOf(ms) < end) anchor.setDate(anchor.getDate() - 1);
  const windowStart = anchor.getTime();
  const close = new Date(windowStart);
  if (start === end) {
    close.setDate(close.getDate() + 1);
  } else if (end > start) {
    close.setHours(end, 0, 0, 0);
  } else {
    close.setDate(close.getDate() + 1);
    close.setHours(end, 0, 0, 0);
  }
  return { start: windowStart, end: close.getTime() };
}

/** Whether ms falls inside [startHour, endHour). */
function inWindow(ms) {
  const bounds = windowBounds(ms);
  return ms >= bounds.start && ms < bounds.end;
}

function quietStartValue() {
  return clampInt(cfg.quietStartHour, 0, 23, DEFAULTS.quietStartHour);
}

function quietEndValue() {
  return clampInt(cfg.quietEndHour, 0, 24, DEFAULTS.quietEndHour);
}

/**
 * Whether ms falls in the configured quiet span.
 *
 * The span may cross midnight, like the ignition window, but a span whose start
 * equals its end means "off" here rather than "all day": silently swallowing
 * every notification is a worse accident than a setting that does nothing.
 */
function inQuietHours(ms) {
  if (!cfg.quietEnabled) return false;
  const start = quietStartValue();
  const end = quietEndValue();
  if (start === end) return false;
  const hour = hourOf(ms);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Next occurrence of startHour strictly after ms. */
function windowStartAfter(ms, startHour) {
  const d = new Date(ms);
  d.setHours(startHour, 0, 0, 0);
  if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * The latest grid point at or before ms. Grid points are
 * windowStart + delay + k x interval, so the schedule is anchored to the window
 * start in absolute time: it cannot drift, a manual ignition cannot move it, and
 * every boundary carries the same delay. Before the first point ms it returns
 * the first point, which is still in the future.
 */
function gridPointAt(ms, bounds) {
  const first = bounds.start + delayMs();
  if (ms <= first) return first;
  const step = intervalMs();
  return first + Math.floor((ms - first) / step) * step;
}

/**
 * When the next ignition is due.
 * Returns 0 when nothing is scheduled, a value <= now when it is due right now,
 * and a future timestamp otherwise.
 *
 * A grid point that would land at or after the window end is dropped: the next
 * run is the next window's first point, never a time outside the window.
 */
function nextDueAt(nowMs) {
  if (!cfg.enabled || !cfg.modelKey) return 0;
  if (rt.circuitUntil > nowMs) return rt.circuitUntil;
  const bounds = windowBounds(nowMs);
  const firstOfNextWindow = () => windowStartAfter(nowMs, startHourValue()) + delayMs();
  if (nowMs < bounds.start || nowMs >= bounds.end) return firstOfNextWindow();
  // A backoff can outlast the window (a rate limit waits up to an hour). The
  // tick would then find itself outside the window and defer anyway, so report
  // the next window's first point instead of a time nothing will ever run at.
  if (rt.retryAt > nowMs) return rt.retryAt < bounds.end ? rt.retryAt : firstOfNextWindow();
  const first = bounds.start + delayMs();
  // A delay longer than the window leaves no point to run today.
  if (first >= bounds.end) return firstOfNextWindow();
  if (nowMs < first) return first;
  const point = gridPointAt(nowMs, bounds);
  // An automatic run that never happened for this grid point is owed now, so a
  // missed point is caught up instead of sliding a whole interval later.
  if (rt.lastScheduledAt < point) return nowMs;
  const next = point + intervalMs();
  if (next >= bounds.end) return firstOfNextWindow();
  return next;
}

// ------------------------------------------------------------------ state io

const RUNTIME_NUMBERS = ["lastFiredAt", "lastScheduledAt", "lastAttemptAt", "lastMs", "failures", "circuitUntil", "retryAt"];

/**
 * Runtime state read from disk is evidence the file may have been edited or
 * damaged, so every field is checked: a string where a timestamp belongs would
 * otherwise turn into NaN arithmetic in the scheduler.
 */
function sanitizeRuntime(raw, base) {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  for (const key of RUNTIME_NUMBERS) {
    if (raw[key] === undefined) continue;
    const n = Number(raw[key]);
    out[key] = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  }
  if (raw.lastOk === true || raw.lastOk === false || raw.lastOk === null) out.lastOk = raw.lastOk;
  if (typeof raw.lastError === "string") out.lastError = raw.lastError;
  if (typeof raw.lastKind === "string") out.lastKind = raw.lastKind;
  out.log = Array.isArray(raw.log)
    ? raw.log.filter((entry) => entry && typeof entry === "object").slice(0, MAX_LOG)
    : [];
  return out;
}

function load() {
  try {
    if (!stateFile || !fs.existsSync(stateFile)) return;
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (parsed && typeof parsed.cfg === "object" && parsed.cfg) {
      cfg = { ...DEFAULTS, ...sanitize(parsed.cfg) };
    }
    if (parsed && typeof parsed.rt === "object" && parsed.rt) {
      rt = sanitizeRuntime(parsed.rt, rt);
    }
  } catch (error) {
    console.warn(`[igniter] could not read state: ${String(error && error.message ? error.message : error)}`);
  }
}

function save() {
  if (!stateFile) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const body = JSON.stringify({ version: 1, cfg, rt }, null, 2);
    const temporary = `${stateFile}.tmp`;
    fs.writeFileSync(temporary, body, "utf8");
    fs.renameSync(temporary, stateFile);
  } catch (error) {
    console.warn(`[igniter] could not write state: ${String(error && error.message ? error.message : error)}`);
  }
}

function sanitize(patch) {
  const out = { ...cfg };
  if (!patch || typeof patch !== "object") return out;
  if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
  if (typeof patch.notifyOnCircuit === "boolean") out.notifyOnCircuit = patch.notifyOnCircuit;
  if (patch.startHour !== undefined) out.startHour = clampInt(patch.startHour, 0, 23, out.startHour);
  if (patch.quietEnabled !== undefined && typeof patch.quietEnabled === "boolean") out.quietEnabled = patch.quietEnabled;
  if (patch.quietStartHour !== undefined) {
    out.quietStartHour = clampInt(patch.quietStartHour, 0, 23, out.quietStartHour);
  }
  if (patch.quietEndHour !== undefined) {
    out.quietEndHour = clampInt(patch.quietEndHour, 0, 24, out.quietEndHour);
  }
  if (patch.endHour !== undefined) out.endHour = clampInt(patch.endHour, 0, 24, out.endHour);
  if (patch.intervalMinutes !== undefined) {
    out.intervalMinutes = clampInt(patch.intervalMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, out.intervalMinutes);
  }
  if (patch.delaySeconds !== undefined) {
    out.delaySeconds = clampInt(patch.delaySeconds, 0, MAX_DELAY_SECONDS, out.delaySeconds);
  }
  if (typeof patch.modelKey === "string") out.modelKey = patch.modelKey.trim();
  if (typeof patch.barkUrl === "string") {
    const url = patch.barkUrl.trim();
    // Anything but an empty value or an http(s) URL is ignored here; the save
    // channel rejects it loudly before it gets this far.
    if (url === "" || isHttpUrl(url)) out.barkUrl = url;
  }
  return out;
}

/** Bark pushes go through net.fetch, so only plain web URLs make sense. */
function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** providerId/modelId without an opaque UUID provider prefix, for push text. */
function modelDisplay(key) {
  const raw = String(key || "");
  const slash = raw.indexOf("/");
  if (slash < 0) return raw;
  const provider = raw.slice(0, slash);
  const modelId = raw.slice(slash + 1);
  return modelId && UUID.test(provider) ? modelId : raw;
}

function shorten(text, limit = 200) {
  const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function pushLog(entry) {
  rt.log.unshift(entry);
  if (rt.log.length > MAX_LOG) rt.log.length = MAX_LOG;
}

// ------------------------------------------------------------------- results

function onSuccess(reason) {
  rt.failures = 0;
  rt.retryAt = 0;
  rt.circuitUntil = 0;
  rt.lastOk = true;
  rt.lastError = "";
  rt.lastKind = "";
  rt.lastFiredAt = Date.now();
  // Only an automatic run satisfies a grid point; a manual one is extra.
  if (reason !== "manual") rt.lastScheduledAt = rt.lastFiredAt;
}

/**
 * Work out what a failed completion actually was.
 *
 * PI-Desktop turns an upstream 429 into a RateLimitError whose message starts
 * with the status ("429: custom API error (429): ..."), and its own per-minute
 * budget answers RATE_LIMITED. Both mean "ask again later", which is a different
 * situation from a bad model key or a dead provider: retrying a misconfiguration
 * is pointless, while giving up on a rate limit for the rest of the day loses the
 * window it was meant to keep warm. The kind therefore decides the pacing; the
 * message is searched because the error crossing the plugin boundary is usually
 * a plain Error carrying only text.
 */
function classifyFailure(error) {
  const message = String(error && error.message ? error.message : error);
  const code = String((error && (error.code || error.errorCode)) || "");
  const status = Number((error && (error.status || error.statusCode)) || 0);
  const details = (error && error.details) || {};
  const providerStatus = Number(details.providerStatus || details.status || 0);
  const rateLimited =
    status === 429 ||
    providerStatus === 429 ||
    /RATE[_\s-]?LIMIT/i.test(code) ||
    /(^|\D)429(\D|$)|rate[_\s-]?limit|too many requests|upstream_rate_limited/i.test(message);
  return { kind: rateLimited ? "rate-limit" : "error", retryAfterMs: parseRetryAfterMs(message) };
}

/** Retry-After as milliseconds, when the provider bothered to send one. */
function parseRetryAfterMs(message) {
  const text = String(message == null ? "" : message);
  const asMs = text.match(/retry[-_\s]?after[-_\s]?ms"?\s*[:=]\s*"?(\d+)/i);
  if (asMs) return clampRetryAfter(Number(asMs[1]));
  const asSeconds = text.match(/retry[-_\s]?after"?\s*[:=]\s*"?(\d+)/i);
  if (asSeconds) return clampRetryAfter(Number(asSeconds[1]) * 1000);
  return 0;
}

function clampRetryAfter(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, Math.round(ms)));
}

/**
 * Backoff for a rate limit: 5, 10, 20, 40, 60 minutes, never shorter than what
 * the provider asked for. Going slowly keeps the window alive without hammering
 * an endpoint that just said no.
 */
function rateLimitBackoff(attempt, retryAfterMs) {
  const exponential = RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(RATE_LIMIT_BACKOFF_MAX_MS, Math.max(exponential, retryAfterMs || 0));
}

function onFailure(message, kind = "error", retryAfterMs = 0, reason = "scheduled") {
  rt.lastOk = false;
  rt.lastError = message;
  rt.lastKind = kind;
  // A manual press is a configuration check, not part of the schedule: its
  // failure is recorded and shown, but it neither counts toward the circuit nor
  // moves the next automatic run. Otherwise three test presses while fixing a
  // setting would silence the scheduler until tomorrow.
  if (reason === "manual") {
    return { circuit: false, until: 0, retryMs: 0, kind, manual: true };
  }
  rt.failures += 1;
  // A rate limit is worth several more tries before the day is written off.
  const threshold = kind === "rate-limit" ? MAX_RATE_LIMIT_FAILURES : MAX_FAILURES;
  if (rt.failures >= threshold) {
    rt.circuitUntil = windowStartAfter(Date.now(), startHourValue());
    rt.retryAt = 0;
    notifyOnce(
      "Igniter paused",
      () =>
        kind === "rate-limit"
          ? `点火器已暂停到下一次开始时段：连续 ${rt.failures} 次被限流（${shorten(message, 120)}）`
          : `点火器已暂停到下一次开始时段：连续 ${rt.failures} 次失败（${shorten(message, 120)}）`
    );
    return { circuit: true, until: rt.circuitUntil, retryMs: 0, kind };
  }
  const backoff =
    kind === "rate-limit"
      ? rateLimitBackoff(rt.failures, retryAfterMs)
      : Math.min(intervalMs(), BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, rt.failures - 1));
  rt.retryAt = Date.now() + backoff;
  return { circuit: false, until: 0, retryMs: backoff, kind };
}

function notifyOnce(title, bodyFactory) {
  try {
    const body = typeof bodyFactory === "function" ? bodyFactory() : String(bodyFactory);
    // Only the OS notification can disturb someone, so only it is switchable:
    // notifyOnCircuit and quiet hours both gate it. The in-app toast always
    // shows, because an open panel should still explain why runs stopped.
    if (cfg.notifyOnCircuit && !inQuietHours(Date.now())) {
      Promise.resolve(pi.ui.showNativeNotification({ title, body })).catch(() => {});
    }
    Promise.resolve(pi.ui.showToast(body, "warning")).catch(() => {});
  } catch {
    /* notifications are best effort */
  }
}

// ---------------------------------------------------------------------- bark

/** Percent-encode everything outside the RFC 3986 unreserved set. */
function barkEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Bark takes GET /<title>/<body>. A configured URL that already carries
 * {title} or {body} is used as a template and otherwise left untouched.
 */
function barkUrlFor(title, body, level) {
  const base = String(cfg.barkUrl || "").trim();
  if (!base) return "";
  let url;
  if (base.includes("{title}") || base.includes("{body}")) {
    url = base.replaceAll("{title}", barkEncode(title)).replaceAll("{body}", barkEncode(body));
  } else {
    url = `${base.replace(/\/+$/, "")}/${barkEncode(title)}/${barkEncode(body)}`;
  }
  const query = [`group=${barkEncode(BARK_GROUP)}`];
  if (level) query.push(`level=${barkEncode(level)}`);
  return `${url}${url.includes("?") ? "&" : "?"}${query.join("&")}`;
}

/**
 * Keep the Bark device key out of logs and state: an error text can echo the
 * request URL, so every absolute URL is reduced to its origin.
 */
function redactUrls(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      return `${new URL(url).origin}/[redacted]`;
    } catch {
      return "[redacted]";
    }
  });
}

/**
 * Push one Bark message. Never throws: a dead push server must not change the
 * ignition outcome, so the caller only records the result.
 */
async function sendBark(title, body, level) {
  const url = barkUrlFor(title, body, level);
  if (!url) return { ok: false, skipped: "no-url" };
  try {
    const response = await pi.net.fetch({ url, method: "GET", timeoutMs: BARK_TIMEOUT_MS });
    const status = Number(response && response.status ? response.status : 0);
    const text = String((response && response.bodyText) || "");
    let code = 0;
    try {
      const parsed = JSON.parse(text);
      code = Number(parsed && parsed.code ? parsed.code : 0);
    } catch {
      // A self-hosted server may answer non-JSON; the status code decides then.
    }
    if (status < 200 || status >= 300) return { ok: false, status, error: shorten(redactUrls(text), 200) };
    if (code && code !== 200) return { ok: false, status, error: shorten(redactUrls(text), 200) };
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      error: shorten(redactUrls(String(error && error.message ? error.message : error)), 200),
    };
  }
}

/** Push the outcome of one ignition, when Bark is configured. */
async function pushBarkForRun(entry, outcome) {
  if (!cfg.barkUrl) return;
  // Quiet hours silence the push, but the record says why: a push you asked to
  // hold back must not read like one that failed. The manual test button calls
  // sendBark directly, so pressing it during quiet hours still delivers.
  if (inQuietHours(Date.now())) {
    entry.bark = "quiet";
    return;
  }
  let title;
  let body;
  let level = "active";
  if (entry.ok) {
    title = "Igniter ✅ 点火成功";
    body = `${modelDisplay(entry.model)} · ${entry.ms}ms`;
  } else if (outcome && outcome.manual) {
    // A manual failure schedules no retry, so the push must not promise one.
    // The user just pressed the button, so nothing here is time sensitive.
    const limited = outcome.kind === "rate-limit";
    title = limited ? "Igniter ⏳ 被限流（手动）" : "Igniter ⚠️ 点火失败（手动）";
    body = `${modelDisplay(entry.model || cfg.modelKey)} · ${entry.error}`;
    level = limited ? "passive" : "active";
  } else if (outcome && outcome.circuit) {
    title = "Igniter 🔴 已暂停";
    body = `连续 ${rt.failures} 次失败，暂停到 ${clockText(outcome.until)} · ${entry.error}`;
    level = "timeSensitive";
  } else if (outcome && outcome.kind === "rate-limit") {
    // Rate limiting is the provider asking for quiet, not a broken setup, so the
    // push is passive: it must not make a phone buzz on every retry.
    title = "Igniter ⏳ 被限流";
    body = `${modelDisplay(entry.model || cfg.modelKey)} · ${retryText(outcome.retryMs)}后重试 · ${entry.error}`;
    level = "passive";
  } else {
    title = "Igniter ⚠️ 点火失败";
    body = `${modelDisplay(entry.model || cfg.modelKey)} · ${retryText(outcome ? outcome.retryMs : 0)}后重试 · ${entry.error}`;
    level = "timeSensitive";
  }
  const result = await sendBark(title, body, level);
  if (!result.ok) {
    console.warn(`[igniter] bark push failed: ${result.error || result.skipped || `status ${result.status}`}`);
  }
  entry.bark = result.ok ? "ok" : shorten(result.error || result.skipped || `status ${result.status}`, 120);
}

function retryText(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分钟`;
}

function clockText(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ------------------------------------------------------------------- ignition

async function fire(reason) {
  if (!cfg.modelKey) return { ok: false, skipped: "no-model" };
  if (inFlight) return { ok: false, skipped: "in-flight" };
  inFlight = true;
  const startedAt = Date.now();
  rt.lastAttemptAt = startedAt;
  let entry;
  let outcome;
  try {
    const result = await pi.agent.complete({
      modelKey: cfg.modelKey,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: PROMPT_TEXT }],
      thinkingLevel: "off",
    });
    rt.lastMs = Date.now() - startedAt;
    entry = {
      t: Date.now(),
      ok: true,
      ms: rt.lastMs,
      reason,
      model: String(result && result.modelKey ? result.modelKey : cfg.modelKey),
      text: shorten(result && result.text ? result.text : "", 80),
    };
    onSuccess(reason);
  } catch (error) {
    rt.lastMs = Date.now() - startedAt;
    const message = redactUrls(String(error && error.message ? error.message : error));
    const { kind, retryAfterMs } = classifyFailure(error);
    entry = { t: Date.now(), ok: false, ms: rt.lastMs, reason, model: cfg.modelKey, kind, error: shorten(message, 300) };
    outcome = onFailure(message, kind, retryAfterMs, reason);
  } finally {
    inFlight = false;
  }
  // The run is on disk before Bark is contacted: a slow or dead push server
  // must neither delay the record nor lose it if the process dies meanwhile.
  // inFlight is already released, so a manual run is never blocked by a push.
  pushLog(entry);
  save();
  await pushBarkForRun(entry, outcome);
  if (entry.bark !== undefined) save();
  return entry;
}

async function tick() {
  if (tickTimerBusy) return;
  tickTimerBusy = true;
  try {
    const now = Date.now();
    // A circuit lasts until the next daily start; once it expires the failure
    // counter starts fresh, otherwise one more failure would re-trip it at once.
    if (rt.circuitUntil && rt.circuitUntil <= now) {
      rt.circuitUntil = 0;
      rt.failures = 0;
      rt.retryAt = 0;
      save();
    }
    if (!cfg.enabled || !cfg.modelKey) return;
    const due = nextDueAt(now);
    if (!due || due > now) return;
    await fire("scheduled");
  } finally {
    tickTimerBusy = false;
  }
}

function startTicker() {
  if (tickTimer) return;
  void tick();
  tickTimer = setInterval(() => void tick(), TICK_MS);
  // Deliberately not unref'd: an unreferenced timer could let the plugin
  // process exit while the host still considers the service running.
}

function stopTicker() {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

// --------------------------------------------------------------------- panel

async function listModels() {
  try {
    const models = await pi.models.list();
    if (!Array.isArray(models)) return [];
    return models
      .filter((model) => model && typeof model.key === "string" && model.key)
      .map((model) => ({
        key: model.key,
        label: String(model.label || model.key),
        providerName: String(model.providerName || ""),
      }));
  } catch (error) {
    return [{ key: "", label: `模型列表读取失败：${shorten(String(error && error.message ? error.message : error), 120)}` }];
  }
}

/**
 * How long the wait that ends at `due` lasts in total, for the panel's progress
 * bar. A backoff runs from the failed attempt to its retry; anything else is one
 * interval. Without this a 5 minute retry was drawn against a 5 hour interval
 * and the bar sat almost full the whole time.
 */
function waitTotalMs(due, now) {
  if (due && rt.retryAt > now && due === rt.retryAt && rt.lastAttemptAt) {
    return Math.max(1, rt.retryAt - rt.lastAttemptAt);
  }
  return intervalMs();
}

function snapshot() {
  const now = Date.now();
  const due = nextDueAt(now);
  return {
    waitTotalMs: waitTotalMs(due, now),
    cfg,
    rt,
    now,
    inFlight,
    intervalMinutes: cfg.intervalMinutes,
    nextDue: due || 0,
    dueNow: Boolean(due) && due <= now,
    inWindow: inWindow(now),
    limits: { minIntervalMinutes: MIN_INTERVAL_MINUTES, maxIntervalMinutes: MAX_INTERVAL_MINUTES },
  };
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    case "igniter.get":
      return snapshot();
    case "igniter.models":
      return { models: await listModels() };
    case "igniter.save": {
      const input = payload || {};
      if (typeof input.barkUrl === "string" && input.barkUrl.trim() !== "" && !isHttpUrl(input.barkUrl.trim())) {
        throw new Error("Bark 地址必须以 http:// 或 https:// 开头");
      }
      cfg = sanitize(input);
      save();
      return snapshot();
    }
    case "igniter.fire": {
      const entry = await fire("manual");
      return { entry, state: snapshot() };
    }
    case "igniter.barkTest": {
      const result = await sendBark(
        "Igniter 测试推送",
        `${cfg.modelKey ? modelDisplay(cfg.modelKey) : "未选择模型"} · 来自面板的测试`,
        "active"
      );
      return { result, state: snapshot() };
    }
    case "igniter.reset": {
      rt.failures = 0;
      rt.retryAt = 0;
      rt.circuitUntil = 0;
      rt.lastError = "";
      rt.lastKind = "";
      rt.lastOk = null;
      rt.log = [];
      save();
      return snapshot();
    }
    default:
      return { ok: false, error: `unknown channel: ${String(channel)}` };
  }
}

// ---------------------------------------------------------------- lifecycle

async function onLoad() {
  dataPath = await pi.plugin.getDataPath();
  stateFile = path.join(dataPath, "state.json");
  load();
  await pi.commands.register({
    id: COMMAND_ID,
    title: "Igniter: Open Panel",
    keywords: ["igniter", "ignite", "activation", "keepalive", "点火", "激活", "保活"],
    category: "Automation",
    run: () => pi.ui.openPanel({ title: "Igniter" }),
  });
  try {
    await pi.services.register({
      id: SERVICE_ID,
      start: async () => startTicker(),
      stop: async () => stopTicker(),
    });
  } catch {
    /* the host still starts declared services after onLoad */
  }
  startTicker();
}

async function onUnload() {
  stopTicker();
  save();
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    /* ignore */
  }
  try {
    await pi.services.unregister(SERVICE_ID);
  } catch {
    /* ignore */
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };

// Exported for offline tests only.
module.exports.__test = {
  inWindow,
  windowStartAfter,
  sanitize,
  sanitizeRuntime,
  isHttpUrl,
  modelDisplay,
  classifyFailure,
  parseRetryAfterMs,
  rateLimitBackoff,
  clampRetryAfter,
  MAX_RATE_LIMIT_FAILURES,
  nextDueAt,
  clampInt,
  hourOf,
  intervalMs,
  barkUrlFor,
  barkEncode,
  delayMs,
  inQuietHours,
  waitTotalMs,
  quietStartValue,
  quietEndValue,
  windowBounds,
  gridPointAt,
  startHourValue,
  endHourValue,
  DEFAULTS,
  // Mutable state for offline tests only.
  setConfig(patch) {
    cfg = { ...DEFAULTS, ...patch };
  },
  setRuntime(patch) {
    rt = { ...rt, ...patch };
  },
  getRuntime() {
    return rt;
  },
  tick,
  // The automatic path without waiting for the grid: fire("scheduled").
  fire,
};

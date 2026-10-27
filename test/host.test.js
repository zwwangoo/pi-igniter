"use strict";

// Integration test against a stubbed host: exercises onLoad, the panel RPC
// channels and both ignition paths (manual and scheduled) with the exact API
// shapes the host exposes (pi.plugin.getDataPath, pi.commands.register,
// pi.services.register, pi.agent.complete, pi.models.list, pi.ui.*).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "igniter-test-"));
const calls = { register: 0, unregister: 0, completions: 0, toasts: 0, notifications: 0, bark: 0 };
let completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
const barkCalls = [];
let barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' });

global.pi = {
  plugin: {
    getDataPath: async () => dataPath,
    getSettings: async () => ({}),
    setSettings: async () => ({ ok: true }),
  },
  commands: {
    register: async (command) => {
      assert.equal(typeof command.run, "function", "command.run must be a function");
      calls.register += 1;
    },
    unregister: async () => {
      calls.unregister += 1;
    },
  },
  services: {
    register: async (service) => {
      assert.equal(service.id, "igniter-scheduler");
      assert.equal(typeof service.start, "function");
      assert.equal(typeof service.stop, "function");
    },
    unregister: async () => {},
  },
  ui: {
    openPanel: async () => {},
    showToast: async () => {
      calls.toasts += 1;
    },
    showNativeNotification: async () => {
      calls.notifications += 1;
    },
  },
  models: {
    list: async () => [
      { key: "cpa/model-a", providerId: "cpa", providerName: "cpa", modelId: "model-a", label: "model-a (cpa)" },
      { key: "cpa/model-b", providerId: "cpa", providerName: "cpa", modelId: "model-b", label: "model-b (cpa)" },
    ],
  },
  agent: {
    complete: async (input) => {
      calls.completions += 1;
      assert.ok(typeof input.modelKey === "string" && input.modelKey.includes("/"), "modelKey must be provider/model");
      assert.ok(Array.isArray(input.messages) && input.messages.length > 0, "messages are required");
      return completionBehaviour(input);
    },
  },
  net: {
    fetch: async (input) => {
      calls.bark += 1;
      barkCalls.push(input);
      return barkBehaviour(input);
    },
  },
};

const plugin = require(path.join(__dirname, "..", "src", "main.js"));
const T = plugin.__test;

const HOUR = 60 * 60 * 1000;
let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function save(patch) {
  return plugin.onPanelInvoke("igniter.save", patch);
}

// One automatic run, answered in the same shape as the panel's igniter.fire.
// Backoff, circuit and push levels belong to the schedule, so the checks for
// them go through here; a manual press no longer feeds any of them.
async function auto() {
  const entry = await T.fire("scheduled");
  return { entry, state: await plugin.onPanelInvoke("igniter.get", {}) };
}

// A schedule that has never run an automatic grid point: the current point is
// owed, so a tick must fire.
function owed() {
  return { lastScheduledAt: 0, lastFiredAt: 0, retryAt: 0, circuitUntil: 0, failures: 0 };
}

(async () => {
  await plugin.onLoad();

  await check("onLoad registers the command and the service", () => {
    assert.equal(calls.register, 1);
  });

  await check("a fresh install starts from the shipped defaults", async () => {
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.deepEqual(state.cfg, {
      enabled: true,
      startHour: 3,
      endHour: 19,
      intervalMinutes: 300,
      delaySeconds: 60,
      modelKey: "",
      barkUrl: "",
      notifyOnCircuit: true,
      // Notifications are never held back until the user asks for it.
      quietEnabled: false,
      quietStartHour: 23,
      quietEndHour: 7,
    });
  });

  await check("models are exposed to the panel", async () => {
    const answer = await plugin.onPanelInvoke("igniter.models", {});
    assert.equal(answer.models.length, 2);
    assert.equal(answer.models[0].key, "cpa/model-a");
  });

  await check("saving config persists it to disk", async () => {
    const state = await save({
      enabled: true,
      startHour: 0,
      endHour: 24,
      intervalMinutes: 60,
      modelKey: "cpa/model-a",
      notifyOnCircuit: true,
    });
    assert.equal(state.cfg.modelKey, "cpa/model-a");
    const saved = JSON.parse(fs.readFileSync(path.join(dataPath, "state.json"), "utf8"));
    assert.equal(saved.cfg.modelKey, "cpa/model-a");
    assert.equal(saved.version, 1);
  });

  await check("out-of-range interval is clamped on save", async () => {
    const state = await save({ intervalMinutes: 0 });
    assert.equal(state.cfg.intervalMinutes, 1);
    await save({ intervalMinutes: 60 });
  });

  await check("manual ignition uses the configured model and schedules the next run", async () => {
    const before = calls.completions;
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(calls.completions, before + 1);
    assert.equal(answer.entry.ok, true);
    assert.equal(answer.entry.model, "cpa/model-a");
    assert.equal(answer.state.rt.lastOk, true);
    assert.equal(answer.state.rt.failures, 0);
    assert.ok(answer.state.rt.lastFiredAt > 0, "last success recorded");
    assert.ok(answer.state.nextDue > 0, "next run scheduled");
  });

  // ---------------------------------------------------------- automatic path

  await check("a scheduled tick fires a due grid point", async () => {
    // No delay: with the shipped 60 s delay the minute after midnight is before
    // the first point, and this check would fail when run at 00:00.
    await save({ enabled: true, startHour: 0, endHour: 24, intervalMinutes: 60, delaySeconds: 0, modelKey: "cpa/model-a" });
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime(owed());
    const before = calls.completions;
    await T.tick();
    assert.equal(calls.completions, before + 1, "the automatic path must fire");
  });

  await check("a scheduled tick does nothing right after a run", async () => {
    const before = calls.completions;
    await T.tick();
    assert.equal(calls.completions, before, "not due yet");
  });

  await check("a scheduled tick respects the daily window", async () => {
    const hour = new Date().getHours();
    await save({ startHour: (hour + 1) % 24, endHour: (hour + 2) % 24 });
    T.setRuntime(owed());
    const before = calls.completions;
    await T.tick();
    assert.equal(calls.completions, before, "outside the window nothing fires");
    await save({ startHour: 0, endHour: 24 });
  });

  await check("a disabled scheduler never fires on its own", async () => {
    await save({ enabled: false });
    T.setRuntime(owed());
    const before = calls.completions;
    await T.tick();
    assert.equal(calls.completions, before, "disabled means no automatic runs");
    await save({ enabled: true });
  });

  // The two reports from the field: a manual ignition must not shift the
  // schedule, and no due time may land outside the configured window.
  await check("a manual ignition leaves the schedule untouched", async () => {
    await save({ enabled: true, startHour: 0, endHour: 24, intervalMinutes: 60, modelKey: "cpa/model-a" });
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    const now = Date.now();
    T.setRuntime({ lastScheduledAt: now, lastFiredAt: now, retryAt: 0, circuitUntil: 0, failures: 0 });
    const before = await plugin.onPanelInvoke("igniter.get", {});
    await plugin.onPanelInvoke("igniter.fire", {});
    const after = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(after.nextDue, before.nextDue, "the next due time must not move");
  });

  await check("the next due time is inside the window or the next window start", async () => {
    await save({ enabled: true, startHour: 3, endHour: 19, intervalMinutes: 301, modelKey: "cpa/model-a" });
    const state = await plugin.onPanelInvoke("igniter.get", {});
    const bounds = T.windowBounds(state.now);
    const inside = state.nextDue >= bounds.start && state.nextDue < bounds.end;
    // The first point of a window is start + delay, not the bare start hour:
    // after the last point of the day the next run is tomorrow's first point.
    const nextWindow = T.windowStartAfter(state.now, 3) + T.delayMs();
    assert.ok(
      inside || state.nextDue === nextWindow,
      `next due ${new Date(state.nextDue).toString()} escaped the 03:00-19:00 window`
    );
    await save({ startHour: 0, endHour: 24, intervalMinutes: 60 });
  });
  await check("the snapshot reports window state to the panel", async () => {
    await save({ enabled: true, startHour: 0, endHour: 24 });
    const open = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(open.inWindow, true, "an all-day window is open");

    const hour = new Date().getHours();
    await save({ startHour: (hour + 1) % 24, endHour: (hour + 2) % 24 });
    const closed = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(closed.inWindow, false, "the window is closed now");
    assert.ok(closed.nextDue > Date.now(), "next due points at the window start");

    await save({ startHour: 0, endHour: 24 });
  });

  // -------------------------------------------------------------- protection

  await check("failures back off, then trip the circuit", async () => {
    completionBehaviour = () => {
      throw new Error("HTTP 500 upstream unavailable");
    };
    T.setRuntime({ lastFiredAt: 0, retryAt: 0, circuitUntil: 0, failures: 0 });

    const first = await auto();
    assert.equal(first.entry.ok, false);
    assert.equal(first.state.rt.failures, 1);
    assert.equal(first.state.rt.lastOk, false);
    assert.ok(first.state.rt.retryAt > Date.now(), "backoff scheduled");
    assert.equal(first.state.rt.circuitUntil, 0, "no circuit on the first failure");

    const second = await auto();
    assert.equal(second.state.rt.failures, 2);
    assert.equal(second.state.rt.circuitUntil, 0);

    const third = await auto();
    assert.equal(third.state.rt.failures, 3);
    assert.ok(third.state.rt.circuitUntil > Date.now(), "circuit open until the next daily start");
    assert.ok(calls.notifications >= 1, "the trip was notified");
  });

  await check("the circuit blocks scheduled runs", async () => {
    T.setRuntime({ lastFiredAt: Date.now() - 2 * HOUR, retryAt: 0 });
    const before = calls.completions;
    await T.tick();
    assert.equal(calls.completions, before, "nothing fires while the circuit is open");
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.ok(state.rt.circuitUntil > Date.now());
    assert.ok(state.nextDue >= state.rt.circuitUntil, "next due waits for the circuit");
  });

  await check("a manual run still works while the circuit is open and clears it", async () => {
    completionBehaviour = () => ({ modelKey: "cpa/model-b", text: "OK", usage: {} });
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(answer.entry.ok, true);
    assert.equal(answer.entry.model, "cpa/model-b");
    assert.equal(answer.state.rt.failures, 0, "success clears the failure counter");
    assert.equal(answer.state.rt.circuitUntil, 0, "success closes the circuit");
  });

  await check("the circuit expires at the next daily start and resets the counter", async () => {
    T.setRuntime({ failures: 3, circuitUntil: Date.now() - 1000, retryAt: 0, lastFiredAt: 0, lastOk: false });
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await T.tick();
    const rt = T.getRuntime();
    assert.equal(rt.circuitUntil, 0, "expired circuit cleared");
    assert.equal(rt.failures, 0, "counter starts fresh for the new day");
  });

  await check("errors surface a readable message", async () => {
    completionBehaviour = () => {
      throw new Error("RATE_LIMITED plugin completion rate exceeded");
    };
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(answer.entry.ok, false);
    assert.match(answer.state.rt.lastError, /RATE_LIMITED/);
    assert.match(answer.entry.error, /RATE_LIMITED/);
  });

  await check("provider errors keep URLs and keys out of the recorded text", async () => {
    completionBehaviour = () => {
      throw new Error("request to https://api.example.com/v1/chat?key=SECRETAPIKEY failed");
    };
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    const onDisk = fs.readFileSync(path.join(dataPath, "state.json"), "utf8");
    for (const [label, text] of [
      ["entry", answer.entry.error],
      ["lastError", answer.state.rt.lastError],
      ["state.json", onDisk],
    ]) {
      assert.ok(!String(text).includes("SECRETAPIKEY"), `the key leaked into ${label}`);
    }
    assert.match(answer.entry.error, /\[redacted\]/);
    assert.match(answer.entry.error, /api\.example\.com/, "the origin stays useful for diagnosis");
  });

  await check("reset clears history and failures", async () => {
    const state = await plugin.onPanelInvoke("igniter.reset", {});
    assert.equal(state.rt.failures, 0);
    assert.equal(state.rt.log.length, 0);
    assert.equal(state.rt.circuitUntil, 0);
  });

  await check("a manual ignition without a model does nothing instead of failing", async () => {
    await save({ modelKey: "", barkUrl: "https://api.day.app/KEY" });
    await plugin.onPanelInvoke("igniter.reset", {});
    const before = { completions: calls.completions, bark: calls.bark, notifications: calls.notifications };
    let answer;
    for (let i = 0; i < 4; i += 1) answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(answer.entry.skipped, "no-model");
    assert.equal(calls.completions, before.completions, "no request may go out with an empty model key");
    assert.equal(calls.bark, before.bark, "no failure push for a run that never happened");
    assert.equal(calls.notifications, before.notifications);
    assert.equal(answer.state.rt.failures, 0, "it is not a failure");
    assert.equal(answer.state.rt.circuitUntil, 0, "and it must not trip the circuit");
    assert.equal(answer.state.rt.log.length, 0);
    await save({ modelKey: "cpa/model-a", barkUrl: "" });
  });

  await check("an invalid Bark URL is rejected and nothing else is saved", async () => {
    await save({ barkUrl: "https://api.day.app/KEY", enabled: true });
    await assert.rejects(() => save({ barkUrl: "ftp://api.day.app/KEY" }), /http/);
    await assert.rejects(() => save({ barkUrl: "javascript:alert(1)", enabled: false }), /http/);
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.barkUrl, "https://api.day.app/KEY", "the saved URL stays");
    assert.equal(state.cfg.enabled, true, "a rejected save changes nothing");
    const cleared = await save({ barkUrl: "" });
    assert.equal(cleared.cfg.barkUrl, "", "an empty URL still turns push off");
  });

  await check("unknown channels are rejected instead of throwing", async () => {
    const answer = await plugin.onPanelInvoke("igniter.nope", {});
    assert.equal(answer.ok, false);
    assert.match(answer.error, /unknown channel/);
  });

  // -------------------------------------------------------------------- bark

  await check("no push happens while no Bark URL is configured", async () => {
    await save({ barkUrl: "" });
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    const before = calls.bark;
    await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(calls.bark, before, "an empty URL must not reach the network");
  });

  await check("a successful ignition pushes one Bark message", async () => {
    await save({ barkUrl: "https://api.day.app/KEY" });
    barkCalls.length = 0;
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(barkCalls.length, 1, "exactly one push per run");
    const url = String(barkCalls[0].url);
    assert.ok(url.startsWith("https://api.day.app/KEY/"), `unexpected push URL: ${url}`);
    assert.ok(url.includes(encodeURIComponent("点火成功")), "the title should be in the path");
    assert.ok(url.includes("group=Igniter"), "the push should carry the group");
    assert.ok(url.includes("level=active"), "a success is not time sensitive");
    assert.equal(barkCalls[0].timeoutMs, 8000);
    assert.equal(answer.entry.bark, "ok");
  });

  await check("the run is on disk before Bark is contacted", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    const stateFile = path.join(dataPath, "state.json");
    let logOnDisk = -1;
    barkBehaviour = () => {
      logOnDisk = JSON.parse(fs.readFileSync(stateFile, "utf8")).rt.log.length;
      return { status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' };
    };
    await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(logOnDisk, 1, "a slow push must not hold the record back");
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(saved.rt.log[0].bark, "ok", "the push result is written afterwards");
    barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' });
  });

  await check("push text shows the model name without an opaque provider id", async () => {
    const key = "a620698c-58f5-4478-b773-6f3746373067/claude-haiku-5-5";
    await save({ modelKey: key });
    await plugin.onPanelInvoke("igniter.reset", {});
    const bodyOf = (call) => decodeURIComponent(String(call.url).split("/")[5] || "");

    barkCalls.length = 0;
    completionBehaviour = (input) => ({ modelKey: input.modelKey, text: "OK", usage: {} });
    await plugin.onPanelInvoke("igniter.fire", {});
    assert.ok(bodyOf(barkCalls[0]).includes("claude-haiku-5-5"), bodyOf(barkCalls[0]));
    assert.ok(!bodyOf(barkCalls[0]).includes("a620698c"), `provider id leaked: ${bodyOf(barkCalls[0])}`);

    barkCalls.length = 0;
    completionBehaviour = () => {
      throw new Error("HTTP 503 upstream unavailable");
    };
    await plugin.onPanelInvoke("igniter.fire", {});
    assert.ok(bodyOf(barkCalls[0]).includes("claude-haiku-5-5"), bodyOf(barkCalls[0]));
    assert.ok(!bodyOf(barkCalls[0]).includes("a620698c"), `provider id leaked: ${bodyOf(barkCalls[0])}`);

    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await save({ modelKey: "cpa/model-a" });
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("a failed ignition pushes a time-sensitive message", async () => {
    barkCalls.length = 0;
    completionBehaviour = () => {
      throw new Error("HTTP 503 upstream unavailable");
    };
    const answer = await auto();
    assert.equal(barkCalls.length, 1);
    const url = String(barkCalls[0].url);
    assert.ok(url.includes("level=timeSensitive"), `expected timeSensitive, got ${url}`);
    assert.ok(url.includes(encodeURIComponent("点火失败")), "the failure title should be in the path");

    assert.equal(answer.entry.ok, false);
    assert.equal(answer.entry.bark, "ok");
  });

  await check("an upstream 429 is treated as a rate limit, not a broken setup", async () => {
    // The exact text PI-Desktop produced in the field for this provider.
    const upstream =
      '429: custom API error (429): {"code":"upstream_rate_limited","message":"Upstream rate limit exceeded."}';
    await plugin.onPanelInvoke("igniter.reset", {});
    await save({ enabled: true, startHour: 0, endHour: 24, intervalMinutes: 300, modelKey: "cpa/model-a", barkUrl: "" });
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    completionBehaviour = () => {
      throw new Error(upstream);
    };

    const first = await auto();
    assert.equal(first.entry.ok, false, "the ignition did fail");
    assert.equal(first.entry.kind, "rate-limit");
    assert.equal(first.state.rt.lastKind, "rate-limit");
    assert.equal(first.state.rt.failures, 1);
    const wait = first.state.rt.retryAt - Date.now();
    assert.ok(wait > 4 * 60 * 1000, `expected a 5 minute wait, got ${Math.round(wait / 1000)}s`);
    assert.ok(wait <= 5 * 60 * 1000 + 1000, `expected a 5 minute wait, got ${Math.round(wait / 1000)}s`);
  });

  await check("three rate limits no longer pause the whole day", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    completionBehaviour = () => {
      throw new Error("429: custom API error (429): {\"code\":\"upstream_rate_limited\"}");
    };
    let answer;
    for (let i = 0; i < 3; i += 1) answer = await auto();
    assert.equal(answer.state.rt.failures, 3);
    assert.equal(answer.state.rt.circuitUntil, 0, "a rate limit must not trip the circuit at 3");
    assert.ok(answer.state.rt.retryAt > Date.now(), "it keeps retrying instead");
  });

  await check("six consecutive rate limits do pause until the next window", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    let answer;
    for (let i = 0; i < 6; i += 1) answer = await auto();
    assert.equal(answer.state.rt.failures, 6);
    assert.ok(answer.state.rt.circuitUntil > Date.now(), "the ladder ends after six attempts");
    assert.equal(answer.entry.kind, "rate-limit");
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("a hard failure still trips the circuit after three tries", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    completionBehaviour = () => {
      throw new Error("model not found: cpa/gone");
    };
    let answer;
    for (let i = 0; i < 3; i += 1) answer = await auto();
    assert.equal(answer.entry.kind, "error", "a dead model is not a rate limit");
    assert.ok(answer.state.rt.circuitUntil > Date.now());
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("a rate-limit push is passive instead of time sensitive", async () => {
    await save({ barkUrl: "https://api.day.app/KEY" });
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    barkCalls.length = 0;
    completionBehaviour = () => {
      throw new Error("429: rate limited");
    };
    const answer = await auto();
    const url = String(barkCalls[0].url);
    assert.ok(url.includes("level=passive"), `a quiet push is expected, got ${url}`);
    assert.ok(url.includes(encodeURIComponent("被限流")), "the title should say so");
    assert.equal(answer.entry.bark, "ok");
    // Leave the URL as the surrounding tests expect it.
    await save({ barkUrl: "https://api.day.app/KEY" });
    await plugin.onPanelInvoke("igniter.reset", {});
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
  });

  await check("Retry-After from the provider replaces the ladder step", async () => {
    await save({ enabled: true, startHour: 0, endHour: 24, intervalMinutes: 300, modelKey: "cpa/model-a" });
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    completionBehaviour = () => {
      throw new Error("429 too many requests, retry-after: 600");
    };
    const answer = await auto();
    const wait = answer.state.rt.retryAt - Date.now();
    assert.ok(wait > 590 * 1000, `expected the provider's 10 minutes, got ${Math.round(wait / 1000)}s`);
    assert.ok(wait <= 600 * 1000 + 1000, `expected the provider's 10 minutes, got ${Math.round(wait / 1000)}s`);
    await plugin.onPanelInvoke("igniter.reset", {});
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
  });

  await check("the circuit pushes its own message", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastScheduledAt: 0 });
    barkCalls.length = 0;
    completionBehaviour = () => {
      throw new Error("HTTP 500 upstream unavailable");
    };
    for (let i = 0; i < 3; i += 1) await auto();
    const titles = barkCalls.map((call) => decodeURIComponent(String(call.url).split("/")[4] || ""));
    assert.ok(
      titles.some((title) => title.includes("已暂停")),
      `expected a pause push, got ${JSON.stringify(titles)}`
    );
    const bodies = barkCalls.map((call) => decodeURIComponent(String(call.url).split("/")[5] || ""));
    assert.ok(
      bodies.some((body) => body.includes("连续 3 次失败")),
      `expected a pause body, got ${JSON.stringify(bodies)}`
    );
  });

  await check("a failing push server does not change the ignition outcome", async () => {
    barkBehaviour = () => ({ status: 500, headers: {}, bodyText: "boom" });
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastScheduledAt: 0 });
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(answer.entry.ok, true, "the ignition itself succeeded");
    assert.match(String(answer.entry.bark), /boom/);
    assert.equal(answer.state.rt.failures, 0, "a push failure must not count as an ignition failure");
    barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' });
  });

  await check("a Bark code other than 200 counts as a failed push", async () => {
    barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":400,"message":"bad device key"}' });
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(answer.entry.ok, true, "the ignition still succeeded");
    assert.match(String(answer.entry.bark), /bad device key/);
    barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' });
  });

  await check("the test push channel reports success and failure", async () => {
    await save({ barkUrl: "https://api.day.app/KEY" });
    barkCalls.length = 0;
    const ok = await plugin.onPanelInvoke("igniter.barkTest", {});
    assert.equal(ok.result.ok, true);
    assert.equal(barkCalls.length, 1);

    barkBehaviour = () => {
      throw new Error("ECONNREFUSED");
    };
    const failed = await plugin.onPanelInvoke("igniter.barkTest", {});
    assert.equal(failed.result.ok, false);
    assert.match(String(failed.result.error), /ECONNREFUSED/);
    barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' });
  });

  await check("a {title}/{body} template is used verbatim", async () => {
    await save({ barkUrl: "https://bark.example.com/push?token=T&t={title}&b={body}" });
    barkCalls.length = 0;
    await plugin.onPanelInvoke("igniter.fire", {});
    const url = String(barkCalls[0].url);
    assert.ok(url.startsWith("https://bark.example.com/push?token=T"), `template ignored: ${url}`);
    assert.ok(!url.includes("{title}") && !url.includes("{body}"), "placeholders should be replaced");
    assert.ok(url.includes("&group=Igniter"), "query parameters must append with &");
    await save({ barkUrl: "https://api.day.app/KEY" });
  });

  await check("push errors keep the device key out of the recorded text", async () => {
    await save({ barkUrl: "https://api.day.app/SECRETKEY" });
    barkBehaviour = () => {
      throw new Error("request to https://api.day.app/SECRETKEY/title/body failed");
    };
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    const recorded = JSON.stringify(answer.entry);
    assert.ok(!recorded.includes("SECRETKEY"), `the device key leaked: ${recorded}`);
    assert.ok(recorded.includes("[redacted]"), "the URL should be reduced to its origin");
    barkBehaviour = () => ({ status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' });
  });

  // ------------------------------------------------------------ quiet hours

  // Pin the quiet span around "now" so these checks do not depend on the clock.
  async function quietNow(on) {
    const hour = new Date().getHours();
    return save({ quietEnabled: on, quietStartHour: hour, quietEndHour: (hour + 2) % 24 });
  }

  await check("quiet hours stop the push and say so in the record", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    await save({ barkUrl: "https://api.day.app/KEY", modelKey: "cpa/model-a", enabled: true });
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await quietNow(true);
    barkCalls.length = 0;
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(barkCalls.length, 0, "no request may leave during quiet hours");
    assert.equal(answer.entry.bark, "quiet", "the record must not look like a failed push");
    assert.equal(answer.entry.ok, true, "the ignition itself still happened");
  });

  await check("quiet hours stop the OS notification but keep the in-app toast", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0, lastOk: null, lastKind: "" });
    completionBehaviour = () => {
      throw new Error("model not found: cpa/gone");
    };
    await quietNow(true);
    const before = { notifications: calls.notifications, toasts: calls.toasts };
    for (let i = 0; i < 3; i += 1) await auto();
    assert.equal(calls.notifications, before.notifications, "no native notification in quiet hours");
    assert.ok(calls.toasts > before.toasts, "the panel still gets told");
    await plugin.onPanelInvoke("igniter.reset", {});
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
  });

  await check("the manual test push ignores quiet hours", async () => {
    await save({ barkUrl: "https://api.day.app/KEY" });
    await quietNow(true);
    barkCalls.length = 0;
    const answer = await plugin.onPanelInvoke("igniter.barkTest", {});
    assert.equal(barkCalls.length, 1, "a button the user pressed must deliver");
    assert.equal(answer.result.ok, true);
  });

  await check("outside quiet hours the push goes out again", async () => {
    await quietNow(false);
    await plugin.onPanelInvoke("igniter.reset", {});
    barkCalls.length = 0;
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    const answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(barkCalls.length, 1);
    assert.equal(answer.entry.bark, "ok");
    await save({ barkUrl: "" });
  });

  // ------------------------------------------------------ manual vs schedule

  await check("manual failures never trip the circuit or move the schedule", async () => {
    await save({ enabled: true, startHour: 0, endHour: 24, intervalMinutes: 300, delaySeconds: 0, modelKey: "cpa/model-a", barkUrl: "" });
    await plugin.onPanelInvoke("igniter.reset", {});
    const now = Date.now();
    T.setRuntime({ lastScheduledAt: now, lastFiredAt: now, failures: 0, retryAt: 0, circuitUntil: 0 });
    const before = await plugin.onPanelInvoke("igniter.get", {});
    completionBehaviour = () => {
      throw new Error("model not found: cpa/gone");
    };
    let answer;
    // More presses than any threshold, of both kinds.
    for (let i = 0; i < 4; i += 1) answer = await plugin.onPanelInvoke("igniter.fire", {});
    completionBehaviour = () => {
      throw new Error("429: rate limited");
    };
    for (let i = 0; i < 7; i += 1) answer = await plugin.onPanelInvoke("igniter.fire", {});
    assert.equal(answer.state.rt.failures, 0, "manual presses do not count");
    assert.equal(answer.state.rt.circuitUntil, 0, "and cannot open the circuit");
    assert.equal(answer.state.rt.retryAt, 0, "nor schedule a retry");
    assert.equal(answer.state.nextDue, before.nextDue, "the next automatic run did not move");
    // The failure is still visible.
    assert.equal(answer.state.rt.lastOk, false);
    assert.equal(answer.state.rt.lastKind, "rate-limit");
    assert.equal(answer.state.rt.log.length, 11, "every press is recorded");
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("a manual failure push promises no retry and does not alarm", async () => {
    await save({ barkUrl: "https://api.day.app/KEY", quietEnabled: false });
    await plugin.onPanelInvoke("igniter.reset", {});
    barkCalls.length = 0;
    completionBehaviour = () => {
      throw new Error("model not found: cpa/gone");
    };
    await plugin.onPanelInvoke("igniter.fire", {});
    const url = String(barkCalls[0].url);
    const body = decodeURIComponent(url.split("/")[5] || "");
    assert.ok(decodeURIComponent(url).includes("（手动）"), `title should say manual: ${url}`);
    assert.ok(!body.includes("后重试"), `no retry is scheduled, so none may be promised: ${body}`);
    assert.ok(url.includes("level=active"), "a press the user just made is not time sensitive");
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await save({ barkUrl: "" });
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("the notification switch only silences the OS notification, never the toast", async () => {
    await save({ notifyOnCircuit: false, quietEnabled: false, barkUrl: "" });
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0 });
    completionBehaviour = () => {
      throw new Error("model not found: cpa/gone");
    };
    const before = { notifications: calls.notifications, toasts: calls.toasts };
    for (let i = 0; i < 3; i += 1) await auto();
    assert.ok(T.getRuntime().circuitUntil > Date.now(), "the circuit did open");
    assert.equal(calls.notifications, before.notifications, "the switch is off: no OS notification");
    assert.ok(calls.toasts > before.toasts, "the panel is still told why runs stopped");

    // With the switch on, both arrive.
    await save({ notifyOnCircuit: true });
    await plugin.onPanelInvoke("igniter.reset", {});
    T.setRuntime({ failures: 0, retryAt: 0, circuitUntil: 0 });
    const on = { notifications: calls.notifications, toasts: calls.toasts };
    for (let i = 0; i < 3; i += 1) await auto();
    assert.ok(calls.notifications > on.notifications);
    assert.ok(calls.toasts > on.toasts);
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("the progress bar is measured against the backoff, not the interval", async () => {
    await save({ enabled: true, startHour: 0, endHour: 24, intervalMinutes: 300, delaySeconds: 0, modelKey: "cpa/model-a" });
    await plugin.onPanelInvoke("igniter.reset", {});
    const now = Date.now();
    T.setRuntime({ lastScheduledAt: now, failures: 0, retryAt: 0, circuitUntil: 0 });
    const idle = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(idle.waitTotalMs, 300 * 60 * 1000, "a normal wait is one interval");

    completionBehaviour = () => {
      throw new Error("model not found: cpa/gone");
    };
    await auto();
    completionBehaviour = () => ({ modelKey: "cpa/model-a", text: "OK", usage: {} });
    const backing = await plugin.onPanelInvoke("igniter.get", {});
    if (backing.nextDue === backing.rt.retryAt) {
      const expected = backing.rt.retryAt - backing.rt.lastAttemptAt;
      assert.equal(backing.waitTotalMs, expected, "a backoff is its own length");
      assert.ok(backing.waitTotalMs <= 2 * 60 * 1000, `a first failure waits about a minute, got ${backing.waitTotalMs}`);
    }
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  await check("unload unregisters the command and keeps state on disk", async () => {
    await plugin.onUnload();
    assert.equal(calls.unregister, 1);
    assert.ok(fs.existsSync(path.join(dataPath, "state.json")));
  });

  console.log(`\n${passed} checks passed`);
  fs.rmSync(dataPath, { recursive: true, force: true });
})().catch((error) => {
  console.error(`\nFAILED: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

"use strict";

// Panel <-> plugin round trip: runs the real renderer script against the real
// plugin, with a stub DOM and a stub host in between. This is the layer that was
// missing when a lost fillForm() line made the end hour empty forever.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "igniter-panel-"));
const toasts = [];
const barkCalls = [];

global.pi = {
  plugin: { getDataPath: async () => dataPath, getSettings: async () => ({}), setSettings: async () => ({}) },
  commands: { register: async () => {}, unregister: async () => {} },
  services: { register: async () => {}, unregister: async () => {} },
  ui: {
    openPanel: async () => {},
    showToast: async (message) => toasts.push(String(message)),
    showNativeNotification: async () => {},
  },
  models: {
    list: async () => [
      { key: "cpa/model-a", providerId: "cpa", providerName: "cpa", label: "model-a (cpa)" },
      {
        key: "a620698c-58f5-4478-b773-6f3746373067/claude-haiku-5-5",
        providerId: "a620698c-58f5-4478-b773-6f3746373067",
        providerName: "MYCPA",
        label: "claude-haiku-5-5 (MYCPA)",
      },
    ],
  },
  agent: { complete: async (input) => ({ modelKey: input.modelKey, text: "OK", usage: {} }) },
  net: {
    fetch: async (input) => {
      barkCalls.push(input);
      return { status: 200, headers: {}, bodyText: '{"code":200,"message":"success"}' };
    },
  },
};

const plugin = require(path.join(root, "src", "main.js"));

// ------------------------------------------------------------------ stub DOM

function makeNode(id) {
  return {
    id,
    value: "",
    checked: false,
    textContent: "",
    className: "",
    hidden: false,
    disabled: false,
    style: {},
    children: [],
    handlers: {},
    // Like the real DOM: assigning innerHTML replaces the children, so
    // `list.innerHTML = ""` before a re-render really empties the list.
    get innerHTML() {
      return "";
    },
    set innerHTML(value) {
      if (value === "") this.children = [];
    },
    append(...children) {
      this.children.push(...children);
    },
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    },
  };
}

const nodes = new Map();
const node = (id) => {
  if (!nodes.has(id)) nodes.set(id, makeNode(id));
  return nodes.get(id);
};

function fire(id, type = "change") {
  const handler = node(id).handlers[type];
  assert.ok(typeof handler === "function", `no ${type} handler on #${id}`);
  return handler({ target: node(id) });
}

// The real panel bridge answers a few channels itself and forwards the rest to
// the plugin, so the stub does the same.
function bridgeInvoke(channel, payload) {
  const body = payload ?? {};
  if (channel === "ui.showToast") {
    toasts.push(String(body.message ?? ""));
    return Promise.resolve({ ok: true });
  }
  if (channel === "app.getAppearance") return Promise.resolve({ theme: "dark", locale: "zh-CN" });
  return plugin.onPanelInvoke(channel, body);
}

const context = vm.createContext({
  console,
  Date,
  Math,
  JSON,
  String,
  Number,
  Boolean,
  Object,
  Array,
  Promise,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  document: {
    hidden: false,
    documentElement: { dataset: {}, lang: "" },
    getElementById: node,
    querySelectorAll: () => [],
    createElement: () => makeNode("created"),
  },
  window: {
    pluginBridge: {
      invoke: bridgeInvoke,
      on: () => {},
    },
  },
});

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

(async () => {
  await plugin.onLoad();
  await plugin.onPanelInvoke("igniter.save", {
    enabled: true,
    startHour: 8,
    endHour: 23,
    intervalMinutes: 300,
    delaySeconds: 60,
    modelKey: "cpa/model-a",
    notifyOnCircuit: true,
  });
  await plugin.onPanelInvoke("igniter.reset", {});

  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  await settle();

  await check("the form is filled from the saved config", () => {
    assert.equal(String(node("startHour").value), "8");
    assert.equal(String(node("endHour").value), "23", "the end hour must be filled, not left empty");
    assert.equal(String(node("intervalMinutes").value), "300");
    assert.equal(String(node("delaySeconds").value), "60");
    assert.equal(node("enabled").checked, true);
    assert.equal(node("modelKey").value, "cpa/model-a");
  });

  await check("editing the end hour reaches the plugin and the disk", async () => {
    node("endHour").value = "19";
    await fire("endHour");
    await settle();
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.endHour, 19);
    const saved = JSON.parse(fs.readFileSync(path.join(dataPath, "state.json"), "utf8"));
    assert.equal(saved.cfg.endHour, 19);
  });

  await check("editing the delay reaches the plugin", async () => {
    node("delaySeconds").value = "120";
    await fire("delaySeconds");
    await settle();
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.delaySeconds, 120);
  });

  await check("the delay is part of the next due time", async () => {
    // 00:00-24:00, 300 minute interval, 120 second delay: every point sits at
    // HH:(05k):02. Satisfy the current point first, otherwise the plugin owes it
    // and reports "now" as due.
    await plugin.onPanelInvoke("igniter.save", { startHour: 0, endHour: 24, intervalMinutes: 300, delaySeconds: 120 });
    const now = Date.now();
    plugin.__test.setRuntime({ lastScheduledAt: now, lastFiredAt: now, failures: 0, circuitUntil: 0, retryAt: 0 });
    const state = await plugin.onPanelInvoke("igniter.get", {});
    const bounds = plugin.__test.windowBounds(state.now);
    const offset = state.nextDue - bounds.start;
    assert.ok(state.nextDue > state.now, "the next run is in the future");
    assert.ok(offset >= 120000, `next due ${new Date(state.nextDue).toString()} ignores the delay`);
    if (state.nextDue < bounds.end) {
      assert.equal((offset - 120000) % (300 * 60000), 0, "the point must sit on the 5 hour grid plus the delay");
    } else {
      // Past the last point of the day the next run is the next window's first
      // point. A 24h window is not a multiple of a 5h interval, so the grid
      // check only applies to points inside the window.
      assert.equal(
        state.nextDue,
        plugin.__test.windowStartAfter(state.now, 0) + 120000,
        "after the last point the next run is the next window's first point"
      );
    }
  });

  await check("reopening the panel shows the saved values", async () => {
    await plugin.onPanelInvoke("igniter.save", { startHour: 8, endHour: 19, intervalMinutes: 300, delaySeconds: 120 });
    node("endHour").value = "";
    node("delaySeconds").value = "";
    await vm.runInContext("(async () => { await refresh(true); })()", context);
    await settle();
    assert.equal(String(node("endHour").value), "19");
    assert.equal(String(node("delaySeconds").value), "120");
  });

  await check("an empty number box does not overwrite the stored value", async () => {
    const before = await plugin.onPanelInvoke("igniter.get", {});
    node("endHour").value = "";
    await fire("endHour");
    await settle();
    const after = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(after.cfg.endHour, before.cfg.endHour, "an empty field must not become 0");
  });

  await check("a rejected save surfaces a message instead of failing silently", async () => {
    const saved = context.window.pluginBridge.invoke;
    context.window.pluginBridge.invoke = (channel, payload) =>
      channel === "igniter.save" ? Promise.reject(new Error("host refused the save")) : saved(channel, payload);
    toasts.length = 0;
    node("enabled").checked = true;
    await fire("enabled");
    await settle();
    context.window.pluginBridge.invoke = saved;
    assert.ok(
      toasts.some((message) => message.includes("host refused the save")),
      `expected a failure toast, got ${JSON.stringify(toasts)}`
    );
  });

  await check("manual ignition through the panel records a run", async () => {
    await plugin.onPanelInvoke("igniter.reset", {});
    node("modelKey").value = "cpa/model-a";
    await fire("modelKey");
    await settle();
    await fire("fire", "click");
    await settle();
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.rt.lastOk, true, "the manual run should have succeeded");
    assert.equal(state.rt.log.length, 1);
    assert.equal(state.inFlight, false);
  });

  await check("igniting without a model tells the user instead of recording a failure", async () => {
    await plugin.onPanelInvoke("igniter.save", { modelKey: "" });
    await plugin.onPanelInvoke("igniter.reset", {});
    toasts.length = 0;
    await fire("fire", "click");
    await settle();
    assert.ok(
      toasts.some((message) => message.includes("未选择模型")),
      `expected a no-model toast, got ${JSON.stringify(toasts)}`
    );
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.rt.log.length, 0, "nothing was attempted");
    assert.equal(state.rt.failures, 0);
    assert.equal(node("fire").disabled, false, "the button comes back");
    await plugin.onPanelInvoke("igniter.save", { modelKey: "cpa/model-a" });
  });

  await check("an empty model list does not wipe the saved model", async () => {
    await plugin.onPanelInvoke("igniter.save", { modelKey: "cpa/model-a", enabled: true });
    const listModels = global.pi.models.list;
    global.pi.models.list = async () => [];
    await vm.runInContext("(async () => { modelsLoaded = false; await refresh(true); })()", context);
    await settle();
    assert.equal(node("modelKey").value, "cpa/model-a", "the select keeps showing the saved model");

    // Even if the select were showing a bare placeholder, saving must not send it.
    node("modelKey").value = "";
    node("enabled").checked = false;
    await fire("enabled");
    await settle();
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.enabled, false, "the other field was saved");
    assert.equal(state.cfg.modelKey, "cpa/model-a", "the model must survive");

    global.pi.models.list = listModels;
    await vm.runInContext("(async () => { modelsLoaded = false; await refresh(true); })()", context);
    await settle();
    node("enabled").checked = true;
    await fire("enabled");
    await settle();
    const after = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(after.cfg.modelKey, "cpa/model-a");
    assert.equal(node("modelKey").value, "cpa/model-a");
  });

  await check("the Bark URL round-trips through the form", async () => {
    node("barkUrl").value = "https://api.day.app/KEY";
    await fire("barkUrl");
    await settle();
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.barkUrl, "https://api.day.app/KEY");
    const saved = JSON.parse(fs.readFileSync(path.join(dataPath, "state.json"), "utf8"));
    assert.equal(saved.cfg.barkUrl, "https://api.day.app/KEY");

    // Clearing the field must turn push off again.
    node("barkUrl").value = "";
    await fire("barkUrl");
    await settle();
    const cleared = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(cleared.cfg.barkUrl, "");
  });

  await check("quiet hours round-trip through the form", async () => {
    node("quietEnabled").checked = true;
    node("quietStartHour").value = "22";
    node("quietEndHour").value = "8";
    await fire("quietEnabled");
    await settle();
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.quietEnabled, true);
    assert.equal(state.cfg.quietStartHour, 22);
    assert.equal(state.cfg.quietEndHour, 8);
    const saved = JSON.parse(fs.readFileSync(path.join(dataPath, "state.json"), "utf8"));
    assert.equal(saved.cfg.quietEnabled, true, "the switch must reach the disk");

    // Reopening the panel must show what was saved, not the defaults.
    node("quietEnabled").checked = false;
    node("quietStartHour").value = "";
    node("quietEndHour").value = "";
    await vm.runInContext("(async () => { await refresh(true); })()", context);
    await settle();
    assert.equal(node("quietEnabled").checked, true);
    assert.equal(String(node("quietStartHour").value), "22");
    assert.equal(String(node("quietEndHour").value), "8");

    // And turning it off again persists too.
    node("quietEnabled").checked = false;
    await fire("quietEnabled");
    await settle();
    const off = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(off.cfg.quietEnabled, false);
  });

  await check("the test button pushes one message with the URL in the box", async () => {
    node("barkUrl").value = "https://api.day.app/PANELKEY";
    barkCalls.length = 0;
    await fire("barkTest", "click");
    await settle();
    assert.equal(barkCalls.length, 1, "the button should push exactly once");
    assert.ok(String(barkCalls[0].url).startsWith("https://api.day.app/PANELKEY/"), "the box value must be used");
  });

  await check("the test button reports a missing URL", async () => {
    node("barkUrl").value = "";
    toasts.length = 0;
    barkCalls.length = 0;
    await fire("barkTest", "click");
    await settle();
    assert.equal(barkCalls.length, 0);
    assert.ok(
      toasts.some((message) => message.includes("no-url")),
      `expected a failure toast, got ${JSON.stringify(toasts)}`
    );
  });

  await check("an invalid Bark URL is refused with a visible reason", async () => {
    node("barkUrl").value = "ftp://api.day.app/KEY";
    toasts.length = 0;
    await fire("barkUrl");
    await settle();
    assert.ok(
      toasts.some((message) => message.includes("http")),
      `expected a refusal toast, got ${JSON.stringify(toasts)}`
    );
    const state = await plugin.onPanelInvoke("igniter.get", {});
    assert.equal(state.cfg.barkUrl, "", "the invalid URL must not be stored");
    node("barkUrl").value = "";
  });

  await check("the log shows the model name, not the provider id", async () => {
    const key = "a620698c-58f5-4478-b773-6f3746373067/claude-haiku-5-5";
    await plugin.onPanelInvoke("igniter.save", { modelKey: key });
    await plugin.onPanelInvoke("igniter.reset", {});
    node("modelKey").value = key;
    await fire("fire", "click");
    await settle();
    const rows = node("log").children;
    const text = rows[rows.length - 1].children[1].textContent;
    assert.ok(text.includes("claude-haiku-5-5 (MYCPA)"), `expected the label, got ${text}`);
    assert.ok(!text.includes("a620698c"), `the provider id leaked: ${text}`);
  });

  await check("a model that left the list drops the UUID prefix", async () => {
    const key = "ffffffff-0000-4000-8000-000000000000/ghost-model";
    await plugin.onPanelInvoke("igniter.save", { modelKey: key });
    await plugin.onPanelInvoke("igniter.reset", {});
    await fire("fire", "click");
    await settle();
    const rows = node("log").children;
    const text = rows[rows.length - 1].children[1].textContent;
    assert.ok(text.includes("ghost-model"), `expected the bare model id, got ${text}`);
    assert.ok(!text.includes("ffffffff"), `the provider id leaked: ${text}`);
  });

  await check("a rate-limited run is labelled as such, not as a plain failure", async () => {
    // The real message from the field: PI-Desktop wraps an upstream 429.
    const upstream =
      '429: custom API error (429): {"code":"upstream_rate_limited","message":"Upstream rate limit exceeded."}';
    const complete = global.pi.agent.complete;
    global.pi.agent.complete = async () => {
      throw new Error(upstream);
    };
    await plugin.onPanelInvoke("igniter.save", { modelKey: "cpa/model-a" });
    await plugin.onPanelInvoke("igniter.reset", {});
    node("modelKey").value = "cpa/model-a";
    await fire("fire", "click");
    await settle();
    assert.ok(String(node("last").textContent).includes("被限流"), `got ${node("last").textContent}`);
    global.pi.agent.complete = complete;
    await plugin.onPanelInvoke("igniter.reset", {});
  });

  // Render the panel straight from a hand-made state, so each check controls
  // exactly what the record says.
  async function renderWith(rt) {
    const real = await plugin.onPanelInvoke("igniter.get", {});
    const state = { ...real, rt: { ...real.rt, ...rt } };
    context.__state = state;
    vm.runInContext("state = __state; render();", context);
  }
  const rowText = (index) => node("log").children[index].children[1].textContent;

  await check("log rows say rate-limited, manual, and what happened to the push", async () => {
    const now = Date.now();
    await renderWith({
      log: [
        { t: now, ok: false, kind: "rate-limit", reason: "scheduled", error: "429: upstream", bark: "quiet" },
        { t: now, ok: false, kind: "error", reason: "manual", error: "model not found", bark: "status 500" },
        { t: now, ok: true, reason: "manual", model: "cpa/model-a", ms: 120, bark: "ok" },
        { t: now, ok: true, reason: "scheduled", model: "cpa/model-a", ms: 80 },
      ],
    });
    assert.equal(node("log").children.length, 4);
    assert.match(rowText(0), /^被限流 · 429: upstream · 免打扰未推送$/, rowText(0));
    assert.match(rowText(1), /^model not found · 手动 · 推送失败$/, rowText(1));
    assert.match(rowText(2), /手动/, rowText(2));
    assert.ok(!/推送/.test(rowText(2)), `a delivered push needs no note: ${rowText(2)}`);
    assert.ok(!/手动|推送|被限流/.test(rowText(3)), `a plain scheduled success stays plain: ${rowText(3)}`);
  });

  await check("the backoff warning names the retry time and the kind", async () => {
    const retryAt = Date.now() + 5 * 60 * 1000;
    const at = new Date(retryAt);
    const two = (n) => String(n).padStart(2, "0");
    const hhmm = `${two(at.getHours())}:${two(at.getMinutes())}`;

    await renderWith({ failures: 2, retryAt, circuitUntil: 0, lastKind: "error", log: [] });
    assert.equal(node("warn").hidden, false);
    assert.ok(node("warn").textContent.includes(hhmm), `no retry time in: ${node("warn").textContent}`);
    assert.ok(node("warn").textContent.includes("第 2 次失败"), node("warn").textContent);

    await renderWith({ failures: 3, retryAt, circuitUntil: 0, lastKind: "rate-limit", log: [] });
    assert.ok(node("warn").textContent.includes("被限流"), node("warn").textContent);
    assert.ok(node("warn").textContent.includes(hhmm), node("warn").textContent);
  });

  await check("the progress bar follows the snapshot's wait length", async () => {
    const real = await plugin.onPanelInvoke("igniter.get", {});
    const now = Date.now();
    // Halfway through a 10 minute backoff, while the interval is 5 hours.
    context.__state = {
      ...real,
      cfg: { ...real.cfg, enabled: true, modelKey: "cpa/model-a" },
      rt: { ...real.rt, circuitUntil: 0, log: [] },
      nextDue: now + 5 * 60 * 1000,
      waitTotalMs: 10 * 60 * 1000,
      intervalMinutes: 300,
    };
    vm.runInContext("state = __state; render();", context);
    const width = parseFloat(node("progress").style.width);
    assert.ok(width > 45 && width < 55, `expected about half, got ${node("progress").style.width}`);
  });

  await check("unload keeps the state on disk", async () => {
    await plugin.onUnload();
    assert.ok(fs.existsSync(path.join(dataPath, "state.json")));
  });

  fs.rmSync(dataPath, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((error) => {
  console.error(`\nFAILED: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

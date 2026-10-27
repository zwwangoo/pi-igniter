"use strict";

// Manifest checks equivalent to what PluginCheck enforces, runnable offline.
// Rules taken from the PI-Desktop host bundle: required keys, id shape, the
// permission allowlist, path containment, permission/service coupling and the
// package limits.

const fs = require("node:fs");
const path = require("node:path");

// The repository root holds sources and tooling; the plugin itself is the
// assembled dist/<id>/ directory, which is what PluginPack would package.
const repo = path.join(__dirname, "..");
const { build, FILES } = require(path.join(repo, "scripts", "build.js"));
let dir;
try {
  dir = build();
} catch (error) {
  console.error(`build failed: ${error.message}`);
  process.exit(1);
}

// The host's PLUGIN_PERMISSIONS list (src/plugin permissions of PI-Desktop).
const PERMISSIONS = new Set([
  "ui.panel",
  "ui.view",
  "ui.microphone",
  "ui.theme",
  "ui.settings",
  "ui.window.appearance",
  "clipboard.read",
  "clipboard.write",
  "notify",
  "fs.read",
  "fs.write",
  "fs.delete",
  "agent.tool.register",
  "agent.prompt.inject",
  "agent.complete",
  "composer.transform",
  "composer.suggest",
  "agent.extension",
  "renderer.extension",
  "provider.register",
  "provider.oauth",
  "desktop.control",
  "models.list",
  "project.create",
  "session.read",
  "session.import",
  "session.read.own",
  "session.update.own",
  "session.delete.own",
  "session.autoTitle",
  "usage.read",
  "net.fetch",
  "net.anyHost",
  "shell.openExternal",
  "mcp.server.local",
  "mcp.server.remote",
  "background.service",
  "bus.publish",
  "bus.subscribe",
  "browser.cdp",
  "audio.capture.background",
  "audio.playback.background",
  "speech.adapter.register",
  "keyboard.globalShortcut",
  "net.websocket",
]);

const HIGH_RISK = new Set([
  "net.fetch",
  "net.anyHost",
  "net.websocket",
  "fs.write",
  "fs.delete",
  "agent.prompt.inject",
  "agent.tool.register",
  "agent.extension",
  "agent.complete",
  "renderer.extension",
  "provider.register",
  "provider.oauth",
  "desktop.control",
  "project.create",
  "session.read",
  "session.autoTitle",
  "session.import",
  "session.delete.own",
  "mcp.server.local",
  "mcp.server.remote",
  "browser.cdp",
  "audio.capture.background",
  "speech.adapter.register",
]);

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(repo, "manifest.json"), "utf8"));
} catch (error) {
  console.error(`manifest.json is not readable JSON: ${error.message}`);
  process.exit(1);
}

for (const key of ["schemaVersion", "id", "name", "version", "main"]) {
  if (manifest[key] === undefined || manifest[key] === "") fail(`missing required key: ${key}`);
}
if (manifest.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${JSON.stringify(manifest.schemaVersion)}`);
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(String(manifest.id))) fail(`id fails [a-zA-Z0-9][a-zA-Z0-9._-]*: ${manifest.id}`);
if (!/^\d+\.\d+\.\d+/.test(String(manifest.version))) warn(`version is not semver-like: ${manifest.version}`);
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  if (pkg.version !== manifest.version) fail(`package.json version ${pkg.version} differs from manifest ${manifest.version}`);
} catch (error) {
  fail(`package.json is not readable: ${error.message}`);
}
if (!manifest.safetyNotes) warn("no safetyNotes: the plugins page cannot explain what this does with your data");

// Paths must exist and stay inside the plugin directory.
const declaredPaths = [];
if (manifest.main) declaredPaths.push(["main", manifest.main]);
if (manifest.ui && manifest.ui.panel) declaredPaths.push(["ui.panel", manifest.ui.panel]);
if (manifest.renderer) declaredPaths.push(["renderer", manifest.renderer]);
for (const skill of manifest.contributes?.skills ?? []) declaredPaths.push(["contributes.skills", skill]);
for (const [label, value] of declaredPaths) {
  const resolved = path.resolve(dir, value);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) fail(`${label} escapes the plugin directory: ${value}`);
  else if (!fs.existsSync(resolved)) fail(`${label} does not exist: ${value}`);
}

// Permissions.
const declared = manifest.permissions ?? [];
if (!Array.isArray(declared)) fail("permissions must be an array");
for (const permission of declared) {
  if (!PERMISSIONS.has(permission)) fail(`unknown permission: ${permission}`);
}
const needs = (permission, why) => {
  if (!declared.includes(permission)) fail(`${why} requires permission ${permission}`);
};
if (manifest.ui) needs("ui.panel", "ui.panel");
if ((manifest.contributes?.services ?? []).length) needs("background.service", "contributes.services");
if ((manifest.contributes?.agentTools ?? []).length) needs("agent.tool.register", "contributes.agentTools");
if ((manifest.contributes?.skills ?? []).length) needs("agent.prompt.inject", "contributes.skills");
if (manifest.renderer) needs("renderer.extension", "renderer entry");
if ((manifest.net?.domains ?? []).length) needs("net.fetch", "net.domains");
if (manifest.fs) {
  if (manifest.fs.read) needs("fs.read", "fs.read scope");
  if (manifest.fs.write) needs("fs.write", "fs.write scope");
  if (manifest.fs.delete) needs("fs.delete", "fs.delete scope");
}

// Contributions.
for (const command of manifest.contributes?.commands ?? []) {
  if (!command.id || !String(command.id).trim()) fail("a contributed command has no id");
  if (!command.title || !String(command.title).trim()) warn(`command ${command.id} has no title`);
}
for (const service of manifest.contributes?.services ?? []) {
  // The host rejects a dot here: contributes.services id must match
  // [a-zA-Z][a-zA-Z0-9_-]{0,63}. Command ids and setting keys do allow dots.
  if (typeof service.id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(service.id)) {
    fail(`service id must match [a-zA-Z][a-zA-Z0-9_-]{0,63} (no dots): ${JSON.stringify(service.id)}`);
  }
  if (!service.label) warn(`service ${service.id} has no label`);
}

// Host APIs the code actually calls must be covered by declared permissions.
const main = fs.readFileSync(path.join(dir, manifest.main), "utf8");
const used = {
  "agent.complete": "pi.agent.complete(",
  "models.list": "pi.models.list(",
  "net.fetch": "pi.net.fetch(",
};
for (const [permission, marker] of Object.entries(used)) {
  if (main.includes(marker) && !declared.includes(permission)) fail(`code calls ${marker} but ${permission} is not declared`);
}

// A user-typed endpoint no manifest can name needs the anyHost escape hatch;
// without it every request outside manifest.net.domains is refused at runtime.
if (main.includes("pi.net.fetch(") && !declared.includes("net.anyHost") && !(manifest.net?.domains ?? []).length) {
  fail("pi.net.fetch is used but neither net.anyHost nor net.domains is declared, so every request would be refused");
}

// Package limits, measured on the assembled directory: that is exactly what
// PluginPack puts into the .piplug.
const EXCLUDED = new Set([".git", "node_modules", "dist"]);
const packaged = [];
let files = 0;
let bytes = 0;
(function walk(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink not allowed: ${absolute}`);
    else if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile()) {
      files += 1;
      bytes += fs.statSync(absolute).size;
      packaged.push(path.relative(dir, absolute).split(path.sep).join("/"));
    }
  }
})(dir);
if (files > 2000) fail(`too many files: ${files}`);
if (bytes > 50 * 1024 * 1024) fail(`package too large: ${bytes} bytes`);

// Only run-time files belong in the package: tests, tooling and the lockfile
// would be shipped to every user otherwise.
const expected = FILES.map(([, to]) => to).sort();
if (JSON.stringify([...packaged].sort()) !== JSON.stringify(expected)) {
  fail(`package content differs from the expected run-time files:\n         got      ${[...packaged].sort().join(", ")}\n         expected ${expected.join(", ")}`);
}
for (const name of packaged) {
  if (/^(test|scripts|src)\//.test(name) || name === "package.json" || name.endsWith(".test.js")) {
    fail(`development file in the package: ${name}`);
  }
}

// The assembled manifest must be the one in the repository.
if (fs.readFileSync(path.join(dir, "manifest.json"), "utf8") !== fs.readFileSync(path.join(repo, "manifest.json"), "utf8")) {
  fail("dist manifest.json differs from the repository manifest.json");
}

const highRisk = declared.filter((permission) => HIGH_RISK.has(permission));
console.log(`plugin   ${manifest.id}@${manifest.version}`);
console.log(`files    ${files} (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`perms    ${declared.length} declared, high risk: ${highRisk.join(", ") || "none"}`);
for (const warning of warnings) console.log(`warning  ${warning}`);
for (const error of errors) console.log(`ERROR    ${error}`);
console.log(errors.length ? `\n${errors.length} error(s)` : `\n0 errors, ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);

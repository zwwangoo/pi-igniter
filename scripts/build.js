"use strict";

/**
 * Assemble the installable plugin directory: dist/<manifest.id>/.
 *
 * The repository keeps sources under src/ next to tests and tooling, but a
 * .piplug must hold only what the plugin needs at run time (the installer packs
 * everything except .git, node_modules and dist). PluginCheck / PluginPack are
 * pointed at the assembled directory, never at the repository root.
 *
 * manifest.json stays at the repository root as the single source of truth; its
 * paths ("main.js", "renderer/index.html") are relative to the assembled
 * directory.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// Source file -> path inside the package. MIT requires the licence to travel
// with every copy, so LICENSE ships in the .piplug as well.
const FILES = [
  ["manifest.json", "manifest.json"],
  ["README.md", "README.md"],
  ["LICENSE", "LICENSE"],
  ["src/main.js", "main.js"],
  ["src/renderer/index.html", "renderer/index.html"],
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

/** Build dist/<id>/ and return its absolute path. Throws on any inconsistency. */
function build() {
  const manifest = readJson("manifest.json");
  const pkg = readJson("package.json");
  if (!manifest.id) throw new Error("manifest.json has no id");
  if (pkg.version !== manifest.version) {
    throw new Error(`package.json version ${pkg.version} differs from manifest.json ${manifest.version}`);
  }

  const out = path.join(root, "dist", String(manifest.id));
  fs.rmSync(out, { recursive: true, force: true });
  for (const [from, to] of FILES) {
    const source = path.join(root, from);
    if (!fs.existsSync(source)) throw new Error(`missing source file: ${from}`);
    const target = path.join(out, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  // Every path the manifest declares must resolve inside the package.
  const declared = [manifest.main, manifest.ui && manifest.ui.panel, manifest.renderer].filter(Boolean);
  for (const relative of declared) {
    const resolved = path.resolve(out, relative);
    if (!resolved.startsWith(out + path.sep) || !fs.existsSync(resolved)) {
      throw new Error(`manifest path is not in the package: ${relative}`);
    }
  }
  return out;
}

module.exports = { build, FILES };

if (require.main === module) {
  try {
    const out = build();
    console.log(`assembled ${path.relative(root, out)}/`);
    for (const [, to] of FILES) console.log(`  ${to}`);
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exit(1);
  }
}

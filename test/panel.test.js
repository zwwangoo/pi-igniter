"use strict";

// Panel text checks. The dictionaries hold strings and functions; a function
// rendered instead of called once put `(t, d) => \`...\`` on screen. These
// checks run the panel's real t() and I18N from src/renderer/index.html.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "panel script block not found");

const localeSrc = script.match(/let locale = "[^"]+";/)?.[0];
const i18nSrc = script.match(/const I18N = \{[\s\S]*?\n {6}\};/)?.[0];
const tSrc = script.match(/const t = \(key, \.\.\.args\) => \{[\s\S]*?\n {6}\};/)?.[0];
assert.ok(localeSrc, "could not extract locale from the panel");
assert.ok(i18nSrc, "could not extract I18N from the panel");
assert.ok(tSrc, "could not extract t() from the panel");

const context = vm.createContext({});
vm.runInContext(`${localeSrc}\n${i18nSrc}\n${tSrc}\nthis.t = t; this.I18N = I18N; this.setLocale = (value) => { locale = value; };`, context);
const { t, I18N, setLocale } = context;
const LOCALES = Object.keys(I18N);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// The whole panel script must at least compile: an edit that breaks the
// if/else chain or a template literal only shows up as a blank panel.
check("the panel script compiles", () => {
  new vm.Script(script, { filename: "src/renderer/index.html" });
});

// Keys the panel passes arguments to.
const calledWithArgs = new Set([...script.matchAll(/\bt\("([^"]+)"\s*,/g)].map((match) => match[1]));
// Keys used through data-i18n attributes.
const attributeKeys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]));
// Keys passed to t() anywhere (with or without arguments).
const referenced = new Set([...script.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]));

check("both locales exist", () => {
  assert.ok(LOCALES.includes("zh-CN"), "missing zh-CN");
  assert.ok(LOCALES.includes("en"), "missing en");
});

check("the panel calls at least one translated function with arguments", () => {
  assert.ok(calledWithArgs.size > 0, "expected t() to be called with arguments");
});

for (const key of [...calledWithArgs]) {
  check(`t("${key}", …) is a function in every locale`, () => {
    for (const locale of LOCALES) {
      assert.equal(typeof I18N[locale][key], "function", `${locale}.${key} must be a function`);
    }
  });

  check(`t("${key}", …) renders text, not source`, () => {
    for (const locale of LOCALES) {
      setLocale(locale);
      const text = t(key, "05/11 10:00", "30m 0s");
      assert.equal(typeof text, "string", `${locale}.${key} must render a string`);
      assert.ok(text.length > 0, `${locale}.${key} rendered empty`);
      assert.ok(!text.includes("=>"), `${locale}.${key} leaked function source: ${text}`);
      assert.ok(!text.includes("function"), `${locale}.${key} leaked function source: ${text}`);
      assert.ok(text.includes("05/11 10:00"), `${locale}.${key} dropped the first argument: ${text}`);
    }
  });
}

check("every key referenced by the panel exists in both locales", () => {
  for (const key of [...referenced, ...attributeKeys]) {
    for (const locale of LOCALES) {
      assert.ok(
        Object.hasOwn(I18N[locale], key),
        `${locale} is missing the key "${key}"`
      );
    }
  }
});

check("no key is left unused in the dictionaries", () => {
  const used = new Set([...referenced, ...attributeKeys]);
  for (const locale of LOCALES) {
    for (const key of Object.keys(I18N[locale])) {
      assert.ok(used.has(key), `${locale}.${key} is defined but never used`);
    }
  }
});

check("both locales define the same keys", () => {
  const [first, ...rest] = LOCALES;
  const expected = Object.keys(I18N[first]).sort();
  for (const locale of rest) {
    assert.deepEqual(Object.keys(I18N[locale]).sort(), expected, `${locale} keys differ from ${first}`);
  }
});

check("plain string lookups still work and unknown keys fall back to the key", () => {
  setLocale("zh-CN");
  assert.equal(typeof t("next"), "string");
  assert.equal(t("does-not-exist"), "does-not-exist");
});

console.log(`\n${passed} checks passed`);

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createChromeHtml, createSdkJs, readHostTheme } from "../src/server.js";

const THEME = ":root, :host { --bg: #272e33; --accent: #7fbbb3; }";

test("chrome page carries no host theme when the host has none", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  assert.doesNotMatch(html, /review-surface-host-theme/);
});

test("chrome page inlines the host theme after chrome.css so it wins", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }, { hostTheme: THEME });
  const link = html.indexOf('<link rel="stylesheet" href="/chrome.css">');
  const style = html.indexOf('<style id="review-surface-host-theme">');
  assert.ok(link !== -1 && style > link, "host theme follows chrome.css");
  assert.ok(html.includes(THEME));
});

test("a host theme cannot close its own style element", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/a.html" }, { hostTheme: "a{}</style><script>x()</script>" });
  assert.doesNotMatch(html, /<\/style><script>x\(\)/);
});

test("the annotation card's SDK carries the host theme", () => {
  assert.ok(createSdkJs("abc", 0, "", { hostThemeCss: THEME }).includes(JSON.stringify(THEME).slice(1, -1)));
  assert.match(createSdkJs("abc"), /"hostThemeCss":""/);
});

test("readHostTheme reads the file, and a missing one is the built-in look", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rs-theme-"));
  try {
    assert.equal(await readHostTheme(path.join(dir, "theme.css")), "");
    await writeFile(path.join(dir, "theme.css"), THEME);
    assert.equal(await readHostTheme(path.join(dir, "theme.css")), THEME);
    // Unreadable (here a directory) is the built-in look too, never a failed page load.
    assert.equal(await readHostTheme(dir), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chrome.css draws its colours from custom properties a host theme can override", async () => {
  const css = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");
  const rules = css.slice(css.indexOf("}") + 1); // everything after the :root token block
  assert.doesNotMatch(rules, /rgba\((?!0, 0, 0)/, "only neutral shadows may stay literal");
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,6}\b/);
});

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { CHROME_THEME_FAVICON_JS, createChromeHtml, extractArtifactHead } from "../src/server.js";

// A document just big enough for the favicon script: a root element whose computed --accent the
// test sets, a head holding the icon link, a MutationObserver the test can fire, and capturing
// load listeners.
function fakeDocument({ marked = true, accent = "#7fbbb3" } = {}) {
  const state = { accent, observers: [], loadListeners: [], mediaListeners: [] };
  const link = {
    rel: "icon",
    href: "data:image/svg+xml;base64,STATIC",
    hasAttribute: (name) => marked && name === "data-review-surface-theme-icon",
  };
  const documentElement = { nodeName: "HTML" };
  const head = { nodeName: "HEAD" };
  const document = {
    documentElement,
    head,
    querySelector: (selector) =>
      selector === "link[rel~=icon][data-review-surface-theme-icon]" && marked ? link : null,
    addEventListener: (type, fn, capture) => {
      if (type === "load" && capture === true) state.loadListeners.push(fn);
    },
  };
  const context = {
    document,
    getComputedStyle: (element) => ({
      getPropertyValue: (name) => (element === documentElement && name === "--accent" ? ` ${state.accent} ` : ""),
    }),
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn;
        this.targets = [];
        state.observers.push(this);
      }
      observe(target, options) {
        this.targets.push({ target, options });
      }
    },
    matchMedia: () => ({
      addEventListener: (type, fn) => {
        if (type === "change") state.mediaListeners.push(fn);
      },
    }),
    encodeURIComponent,
  };
  return { context, link, state, documentElement, head };
}

const decoded = (href) => decodeURIComponent(href.replace(/^data:image\/svg\+xml,/, ""));

test("the chrome draws its default tab icon in the theme's --accent", () => {
  const { context, link } = fakeDocument({ accent: "#7fbbb3" });
  vm.runInNewContext(CHROME_THEME_FAVICON_JS, context);

  assert.match(link.href, /^data:image\/svg\+xml,/);
  const svg = decoded(link.href);
  assert.match(svg, /stroke='#7fbbb3'/);
  assert.equal((svg.match(/<circle /g) || []).length, 2, "the Hololoop mark: two rings");
});

test("the tab icon redraws when the theme changes, and only then", () => {
  const { context, link, state, documentElement, head } = fakeDocument({ accent: "#7fbbb3" });
  vm.runInNewContext(CHROME_THEME_FAVICON_JS, context);

  const observer = state.observers[0];
  const watched = observer.targets.map((entry) => entry.target);
  assert.ok(watched.includes(documentElement), "watches the root element's class/style/data-theme");
  assert.ok(watched.includes(head), "watches stylesheets in the head");
  const root = observer.targets.find((entry) => entry.target === documentElement).options;
  assert.deepEqual([...root.attributeFilter].sort(), ["class", "data-theme", "style"]);

  state.accent = "oklch(70% 0.1 200)";
  observer.fn([]);
  assert.match(decoded(link.href), /stroke='oklch\(70% 0.1 200\)'/);

  const before = link.href;
  link.href = "sentinel";
  observer.fn([]); // our own icon swap lands in the head too: same accent, no rewrite
  assert.equal(link.href, "sentinel");
  link.href = before;

  state.accent = "#e69875";
  state.loadListeners[0](); // a stylesheet finished loading
  assert.match(decoded(link.href), /stroke='#e69875'/);

  state.accent = "#a7c080";
  state.mediaListeners[0](); // the system light/dark setting flipped
  assert.match(decoded(link.href), /stroke='#a7c080'/);
});

test("an artifact's own icon is left alone", () => {
  const { context, link, state } = fakeDocument({ marked: false });
  vm.runInNewContext(CHROME_THEME_FAVICON_JS, context);

  assert.equal(link.href, "data:image/svg+xml;base64,STATIC");
  assert.equal(state.observers.length, 0);
});

test("with no --accent yet the built-in icon stays", () => {
  const { context, link, state } = fakeDocument({ accent: "" });
  vm.runInNewContext(CHROME_THEME_FAVICON_JS, context);
  assert.equal(link.href, "data:image/svg+xml;base64,STATIC");

  state.accent = "#7fbbb3";
  state.loadListeners[0]();
  assert.match(decoded(link.href), /stroke='#7fbbb3'/);
});

test("a quote in --accent cannot break out of the icon's markup", () => {
  const { context, link } = fakeDocument({ accent: "red' onload='x" });
  vm.runInNewContext(CHROME_THEME_FAVICON_JS, context);
  assert.doesNotMatch(decoded(link.href), /onload='/);
});

test("only the default favicon is marked to follow the theme", () => {
  assert.match(extractArtifactHead("<head></head>").faviconTag, /data-review-surface-theme-icon/);
  const own = extractArtifactHead('<head><link rel="icon" href="https://example.com/fav.ico"></head>');
  assert.doesNotMatch(own.faviconTag, /data-review-surface-theme-icon/);
});

test("the chrome page runs the favicon script before the client script", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const script = html.indexOf(CHROME_THEME_FAVICON_JS);
  assert.ok(script > 0, "favicon script is inlined");
  assert.ok(script < html.indexOf('src="/chrome-client.js'), "it does not depend on the client loading");
  assert.ok(script > html.indexOf('id="review-surface-host-theme"') || !html.includes("review-surface-host-theme"));
});

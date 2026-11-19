import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";

// The SDK the browser actually runs is a serialized bundle, not the module: `createSdkJs` has to
// declare every helper `createArtifactSdk` reaches for. A helper left out compiles fine and only
// ReferenceErrors on the first click, so these tests boot the served bundle and drive the real
// annotation path through a DOM stub instead of inspecting the module directly.

function createElement(tag) {
  const attributes = new Map();
  const queried = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    offsetWidth: 100,
    offsetHeight: 100,
    hidden: false,
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          if (selector.startsWith("[")) return attributes.has(selector.slice(1, selector.indexOf("]")).split("=")[0]);
          return selector === element.tagName.toLowerCase();
        });
    },
    closest(selectorList) {
      let current = element;
      while (current) {
        if (current.matches(selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    remove() {
      const index = element.parentElement?.children.indexOf(element) ?? -1;
      if (index >= 0) element.parentElement.children.splice(index, 1);
    },
    // Card internals are looked up by class after innerHTML is assigned, so hand back a stable
    // stub per selector: the test drives the very buttons the SDK wired up.
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement(selector.replace(/^[.#]/, "")));
      return queried.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    },
    addEventListener(type, handler) {
      element.listeners.push({ type, handler });
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
    attachShadow() {
      element.shadowRoot = createElement("shadow-root");
      return element.shadowRoot;
    },
  };
  return element;
}

function appendTo(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function cell(tag, text) {
  const element = createElement(tag);
  element.textContent = text;
  return element;
}

function bootSdk({ querySelectorAll = () => [], sdkOptions = {}, setup = (/** @type {any} */ _sandbox) => {} } = {}) {
  const posted = [];
  const documentListeners = [];
  // Deferred work the SDK schedules, run only when a test asks for it: the draft-anchor settle
  // re-query is a real timer, and asserting on it means running it rather than assuming it.
  const timers = [];
  const scheduleTimer = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  const cancelTimer = (id) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  /** @type {(selector: string) => any} */
  let documentQuery = () => null;
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  appendTo(documentElement, head);
  appendTo(documentElement, body);

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform: "Linux" },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    URL: class TestURL extends URL {
      static createObjectURL() {
        return "blob:review-surface-test";
      }
      static revokeObjectURL() {}
    },
    getComputedStyle: () => ({}),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: () => 0,
    document: {
      readyState: "complete",
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement,
      getElementById: () => null,
      querySelector: (selector) => documentQuery(selector),
      querySelectorAll,
      getSelection: () => null,
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: () => 0,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { origin: "http://127.0.0.1" },
    URL: sandbox.URL,
  };
  sandbox.globalThis = sandbox;
  setup(sandbox);

  vm.runInNewContext(createSdkJs("abc", 3, "load-token", sdkOptions), sandbox);

  return {
    posted,
    body,
    api: sandbox.window.reviewSurface,
    resize() {
      for (const entry of windowListeners.filter((listener) => listener.type === "resize")) entry.handler({});
    },
    dispatch(type, event) {
      for (const entry of documentListeners.filter((listener) => listener.type === type)) entry.handler(event);
      return event;
    },
    overlay() {
      return documentElement.children.flatMap((child) => child.shadowRoot?.children || []);
    },
    click(target, extra = {}) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      const event = {
        target,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
        ...extra,
      };
      listener.handler(event);
      return event;
    },
    // A whole click as the browser delivers it: the SDK's capture listener on the document, then
    // the page's own handler on the link, then whatever listens on the window as it bubbles out.
    pageClick(target, pageHandler = (/** @type {any} */ _event) => {}) {
      const event = this.click(target);
      pageHandler(event);
      for (const entry of windowListeners.filter((listener) => listener.type === "click")) entry.handler(event);
      return event;
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    pendingTimers() {
      return timers.filter((timer) => !timer.cancelled);
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) {
        if (!timer.cancelled) timer.fn();
      }
    },
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) listener.handler({ source: sandbox.parent, data });
    },
    cards() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "review-surface-annotation-card");
    },
    card() {
      const card = this.cards().at(-1);
      assert.ok(card, "clicking an element opens an annotation card");
      return card;
    },
    queue(text) {
      const card = this.card();
      card.querySelector("textarea").value = text;
      card.querySelector(".review-surface-send").onclick();
      return posted.at(-1);
    },
  };
}

function buildTable(sdk) {
  const table = appendTo(sdk.body, createElement("table"));
  const thead = appendTo(table, createElement("thead"));
  const headerRow = appendTo(thead, createElement("tr"));
  for (const label of ["Permission / setting", "Visible state", "Database evidence"]) {
    appendTo(headerRow, cell("th", label));
  }
  const tbody = appendTo(table, createElement("tbody"));
  const dataRow = appendTo(tbody, createElement("tr"));
  appendTo(dataRow, cell("td", "Media & Apple Music"));
  appendTo(dataRow, cell("td", "4 apps"));
  const evidence = appendTo(dataRow, cell("td", "Drive, Neovide, Cursor"));
  const badge = appendTo(evidence, cell("code", "Drive"));
  return { evidence, badge };
}

test("the served SDK bundle queues a table-cell annotation without a missing-helper ReferenceError", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  const message = sdk.queue("Check this permission");

  assert.equal(message.type, "review-surface:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
  assert.deepEqual(
    { ...message.prompt.target },
    {
      type: "table-cell",
      selector: "body > table > tbody > tr > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor",
    },
  );
});

test("the served SDK bundle keeps the clicked element's own identity inside a table cell", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);
  const message = sdk.queue("Rename this app");

  assert.equal(message.prompt.tag, "code");
  assert.equal(message.prompt.selector, "table > tbody > tr > td:nth-of-type(3) > code");
  assert.equal(message.prompt.text, "Drive");
  assert.equal(message.prompt.target.selector, "body > table > tbody > tr > td:nth-of-type(3)");
  assert.equal(message.prompt.target.columnLabel, "Database evidence");
});

test("the annotation card names the cell it annotates when the cell itself is clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);

  assert.match(sdk.card().innerHTML, /Annotate cell: Media &amp; Apple Music → Database evidence/);
  assert.match(sdk.card().innerHTML, /about this table cell/);
});

test("the annotation card names the clicked element, not the cell, for a nested click", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);

  assert.match(sdk.card().innerHTML, /Annotate &lt;code&gt; in Media &amp; Apple Music → Database evidence/);
  assert.doesNotMatch(sdk.card().innerHTML, /about this table cell/);
});

test("the served SDK bundle resolves table coordinates only for annotation clicks", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.api.queuePrompt("Programmatic note", { element: evidence });

  assert.equal(sdk.posted.at(-1).prompt.target, undefined);
});

test("the served SDK bundle annotates elements outside tables with no table target", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const message = sdk.queue("Reword this");

  assert.equal(message.prompt.tag, "p");
  assert.equal(message.prompt.target, undefined);
});

// The chrome cannot see into this document, so a draft whose anchor is gone is only ever retired
// if the SDK says so. Silence left it to be retried against every later load.
test("the served SDK bundle reports a draft whose anchor the artifact no longer has", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({
    type: "review-surface:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  // The load event proves the document parsed, not that it finished rendering, so nothing is
  // reported until the anchor has had time to appear.
  assert.equal(
    sdk.posted.some((message) => message.type === "review-surface:reviewDraftUnrestorable"),
    false,
  );

  sdk.runTimers();
  const report = sdk.posted.at(-1);
  assert.equal(report.type, "review-surface:reviewDraftUnrestorable");
  assert.equal(report.selector, "#hero");
  assert.equal(report.artifact_load_token, "load-token");
});

// A section this page builds in script, or a Mermaid diagram, is not in the document when it
// loads. Reporting that as a missing anchor is how a live draft gets thrown away.
test("the served SDK bundle restores a draft whose anchor arrives after the load", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "review-surface:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "review-surface:reviewDraftUnrestorable"),
    false,
    "an anchor that arrived late is restored, not reported gone",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the served SDK bundle reports nothing when there is no draft to restore", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;

  sdk.sendChromeMessage({ type: "review-surface:restoreReviewState", state: { card: null, fields: [] } });
  sdk.sendChromeMessage({
    type: "review-surface:restoreReviewState",
    state: { card: { selector: "#hero", text: "  " } },
  });
  sdk.runTimers();

  assert.equal(sdk.posted.length, before);
});

// `showAnnotationCard` closes whatever card is open before it draws, so a late restore landing on
// a card the user opened inside the settle window would delete text they are still typing - text
// no report has carried to the chrome yet.
test("the served SDK bundle leaves a card the user opened alone when the anchor arrives late", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "review-surface:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "typing something new";
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.card().querySelector("textarea").value, "typing something new");
  // The draft is still stored on the chrome side, so a later load can try again; nothing here
  // claims the anchor is gone either.
  assert.equal(
    sdk.posted.some((message) => message.type === "review-surface:reviewDraftUnrestorable"),
    false,
  );
});

// Cancelling a card reports `card: null`, which is what retires the stored draft on the chrome
// side. A late restore firing after that cancel would draw text the chrome no longer holds and
// report it back as a live draft, so the card the user dismissed reappears with someone else's
// text in it.
test("the served SDK bundle drops a late restore once the user has opened a card of their own", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "review-surface:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector(".review-surface-cancel").onclick();
  const cardsAfterCancel = sdk.cards().length;

  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.cards().length, cardsAfterCancel, "the cancelled card is not replaced by a restored one");
  assert.notEqual(sdk.card().querySelector("textarea").value, "needs a shorter headline");
  assert.equal(
    sdk.posted.some((message) => message.type === "review-surface:reviewDraftUnrestorable"),
    false,
  );
});

function pageLink(sdk, href, attrs = {}) {
  const link = appendTo(sdk.body, cell("a", "the other discussion"));
  link.href = new URL(href, "http://127.0.0.1/artifact/abc/index.html").href;
  for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
  return link;
}

test("a link to another review page is handed to the chrome instead of opening a card", () => {
  const sdk = bootSdk();
  const event = sdk.click(pageLink(sdk, "/open?file=%2Fwork%2Fother.html"));
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(
    { ...sdk.posted.at(-1) },
    {
      type: "review-surface:openPage",
      href: "/open?file=%2Fwork%2Fother.html",
      artifact_load_token: "load-token",
    },
  );
  assert.equal(sdk.cards().length, 0, "following a page link is not an annotation");

  sdk.click(pageLink(sdk, "/session/0123456789abcdef"));
  assert.equal(sdk.posted.at(-1).href, "/session/0123456789abcdef");
});

test("ordinary, foreign, targeted, and modified link clicks keep their old behavior", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;
  sdk.click(pageLink(sdk, "https://example.com/open?file=%2Fx.html"));
  sdk.click(pageLink(sdk, "/docs/readme.html"));
  sdk.click(pageLink(sdk, "/open?file=%2Fx.html", { target: "_blank" }));
  sdk.click(pageLink(sdk, "/open?file=%2Fx.html"), { ctrlKey: true });
  assert.equal(sdk.posted.slice(before).filter((message) => message.type === "review-surface:openPage").length, 0);
});

test("the ready-to-show wait stops re-checking diagrams once its cap gives up on one that never draws", async () => {
  const undrawn = { querySelector: () => null };
  const sdk = bootSdk({ querySelectorAll: (selector) => (selector === ".mermaid" ? [undrawn] : []) });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const diagramChecks = () => sdk.pendingTimers().filter((timer) => timer.ms === 30).length;

  await flush();
  assert.equal(diagramChecks(), 1, "an undrawn diagram is re-checked while the page is still settling");

  let capFired = false;
  for (let round = 0; round < 5 && !capFired; round += 1) {
    capFired = sdk.pendingTimers().some((timer) => timer.ms === 3000);
    sdk.runTimers();
    await flush();
  }
  assert.ok(capFired, "the ready-to-show cap ran");
  sdk.runTimers();
  await flush();
  assert.equal(diagramChecks(), 0, "nothing keeps polling for the diagram after the cap");
});

// Annotation actions: a host declares buttons as data, a page adds them as functions, and both
// run on the card the reviewer opened - its note, its target, its images.

const studyAction = { id: "study", label: "Study", prefix: "study: ", deliver: "now", fallback: "this passage" };

function actionButton(card, index) {
  return card.querySelector('.review-surface-action[data-action-index="' + index + '"]');
}

test("a declared action draws its button between Cancel and Queue", () => {
  const sdk = bootSdk({ sdkOptions: { annotationActions: [studyAction] } });
  sdk.click(appendTo(sdk.body, cell("p", "with reg.lock(): reg.save()")));
  const html = sdk.card().innerHTML;
  assert.match(html, /review-surface-cancel[^]*data-action-index="0"[^]*>Study<\/button>[^]*review-surface-send/);
});

test("a malformed declared action draws no button beside the well-formed one", () => {
  const sdk = bootSdk({ sdkOptions: { annotationActions: [studyAction, { id: "BAD", label: "x" }] } });
  sdk.click(appendTo(sdk.body, cell("p", "with reg.lock(): reg.save()")));
  const html = sdk.card().innerHTML;
  assert.match(html, /data-action-index="0"[^>]*>Study<\/button>/);
  assert.doesNotMatch(html, /data-action-index="1"/, "the malformed action draws nothing");
});

test("a 'now' action sends its note alone, prefixed, on the card's target", () => {
  const sdk = bootSdk({ sdkOptions: { annotationActions: [studyAction] } });
  sdk.click(appendTo(sdk.body, cell("p", "with reg.lock(): reg.save()")));
  const card = sdk.card();
  card.querySelector("textarea").value = "why is the lock taken here?";
  actionButton(card, 0).onclick();

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "review-surface:sendPrompt", "sent now, not queued");
  assert.equal(message.prompt.prompt, "study: why is the lock taken here?");
  assert.equal(message.prompt.text, "with reg.lock(): reg.save()", "it carries what was annotated");
});

test("an empty note uses the action's fallback, and with none the card stays open", () => {
  const sdk = bootSdk({
    sdkOptions: { annotationActions: [studyAction, { id: "flag", label: "Flag", prefix: "flag: " }] },
  });
  sdk.click(appendTo(sdk.body, cell("p", "a passage")));
  actionButton(sdk.card(), 0).onclick();
  assert.equal(sdk.posted.at(-1).prompt.prompt, "study: this passage");

  sdk.click(appendTo(sdk.body, cell("p", "another passage")));
  const before = sdk.posted.length;
  actionButton(sdk.card(), 1).onclick();
  assert.equal(sdk.posted.length, before, "nothing sent without a note");
  assert.equal(sdk.card().querySelector(".review-surface-hint").textContent, "Write a note first.");
});

test("a page adds its own action as a function and it gets the card's context", () => {
  const sdk = bootSdk();
  const seen = [];
  const remove = sdk.api.addAnnotationAction({
    id: "ask",
    label: "Ask",
    run: (context) => {
      seen.push({ note: context.note, text: context.target.text });
      context.queue("ask: " + context.note);
    },
  });
  sdk.click(appendTo(sdk.body, cell("p", "the passage")));
  sdk.card().querySelector("textarea").value = "what does this do?";
  actionButton(sdk.card(), 0).onclick();

  assert.deepEqual(seen, [{ note: "what does this do?", text: "the passage" }]);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "review-surface:queuePrompt");
  assert.equal(message.prompt.prompt, "ask: what does this do?");

  remove();
  sdk.click(appendTo(sdk.body, cell("p", "later")));
  assert.doesNotMatch(sdk.card().innerHTML, /review-surface-action/, "a removed action draws no button");
  assert.throws(() => sdk.api.addAnnotationAction({ id: "x", label: "X" }), /run function/);
});

test("an action that throws keeps the card open and says why", () => {
  const sdk = bootSdk();
  sdk.api.addAnnotationAction({
    id: "broken",
    label: "Broken",
    run: () => {
      throw new Error("no host to ask");
    },
  });
  sdk.click(appendTo(sdk.body, cell("p", "x")));
  actionButton(sdk.card(), 0).onclick();
  assert.equal(sdk.card().querySelector(".review-surface-hint").textContent, "no host to ask");
});

function image(sdk, rect, src = "http://127.0.0.1/artifact/abc/shot.png") {
  const img = appendTo(sdk.body, createElement("img"));
  img.src = src;
  img.currentSrc = src;
  img.alt = "Screenshot";
  img.getBoundingClientRect = () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top });
  return img;
}

function escapeKey() {
  const event = {
    key: "Escape",
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return event;
}

const LARGE = { left: 100, top: 50, right: 500, bottom: 350 };

function expandButton(sdk) {
  return sdk.overlay().find((child) => child.className === "review-surface-image-expand");
}

function lightbox(sdk) {
  return sdk.overlay().find((child) => child.className === "review-surface-lightbox");
}

test("pointing at a large image shows an expand button in its corner", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  const button = expandButton(sdk);
  assert.ok(button, "a large image gets an expand button");
  assert.equal(button.hidden, false);
  assert.equal(button.getAttribute("aria-label"), "Expand image");
  assert.deepEqual([button.style.left, button.style.top], ["460px", "58px"]);
});

test("a small image gets no expand button", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, { left: 0, top: 0, right: 120, bottom: 90 }) });
  const button = expandButton(sdk);
  assert.ok(!button || button.hidden, "an icon-sized image is left alone");
});

test("the expand button opens the image full size, and Esc or a click closes it", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(expandButton(sdk).hidden, true, "the button steps aside while the image is open");

  const box = lightbox(sdk);
  assert.ok(box, "the expand button opens a full-size view");
  assert.equal(box.hidden, false);
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.querySelector("img").src, "http://127.0.0.1/artifact/abc/shot.png");
  assert.equal(sdk.cards().length, 0, "expanding is not an annotation");

  const esc = sdk.dispatch("keydown", escapeKey());
  assert.equal(box.hidden, true, "Esc closes the full-size view");
  assert.equal(esc.defaultPrevented, true);

  sdk.dispatch("pointerover", { target: img });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(box.hidden, false);
  box.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(box.hidden, true, "a click closes the full-size view");
});

test("Esc with no full-size view open is left to the page", () => {
  const sdk = bootSdk();
  const esc = sdk.dispatch("keydown", escapeKey());
  assert.equal(esc.defaultPrevented, false);
});

test("a click on the image itself still annotates it", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img });
  sdk.click(img);
  assert.equal(sdk.cards().length, 1, "the image opens an annotation card as before");
  assert.ok(!lightbox(sdk) || lightbox(sdk).hidden, "and no full-size view");
});

test("pointing away from the image hides its expand button", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  sdk.dispatch("pointerover", { target: appendTo(sdk.body, createElement("p")) });
  assert.equal(expandButton(sdk).hidden, true);
});

test("a full-size view opened after a card was made still draws on top of it", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  sdk.dispatch("keydown", escapeKey());
  sdk.click(appendTo(sdk.body, cell("p", "A paragraph")));
  assert.equal(sdk.cards().length, 1);
  sdk.dispatch("pointerover", { target: img });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(sdk.overlay().at(-1), lightbox(sdk), "the view is the shadow root's last child");
});

test("Tab cannot walk behind an open full-size view", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  const tab = { ...escapeKey(), key: "Tab" };
  tab.preventDefault = () => (tab.defaultPrevented = true);
  sdk.dispatch("keydown", tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(lightbox(sdk).hidden, false, "Tab does not close it");
});

test("leaving the frame hides the expand button", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  sdk.dispatch("pointerout", { target: sdk.body, relatedTarget: null, pointerType: "mouse" });
  assert.equal(expandButton(sdk).hidden, true);
});

test("lifting a finger off a tapped image keeps its expand button for the next tap", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img, pointerType: "touch" });
  sdk.dispatch("pointerout", { target: img, relatedTarget: null, pointerType: "touch" });
  assert.equal(expandButton(sdk).hidden, false, "the button is still there to tap");
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(lightbox(sdk).hidden, false, "and tapping it opens the image");

  sdk.dispatch("keydown", escapeKey());
  sdk.dispatch("pointerover", { target: img, pointerType: "touch" });
  sdk.dispatch("pointerover", { target: appendTo(sdk.body, createElement("p")), pointerType: "touch" });
  assert.equal(expandButton(sdk).hidden, true, "a tap elsewhere puts it away");
});

function fire(element, type, extra = {}) {
  const event = { ...escapeKey(), key: undefined, ...extra };
  event.preventDefault = () => (event.defaultPrevented = true);
  for (const entry of element.listeners.filter((listener) => listener.type === type)) entry.handler(event);
  return { event };
}

test("pressing the expand button does not take focus from what the reader was in", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  const press = fire(expandButton(sdk), "mousedown");
  assert.equal(press.event.defaultPrevented, true, "the press is refused its default focus move");
});

test("an open full-size view keeps keys and touch drags from scrolling the page behind", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  const scrollKeys = [" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
  for (const key of scrollKeys) {
    const press = { ...escapeKey(), key };
    press.preventDefault = () => (press.defaultPrevented = true);
    sdk.dispatch("keydown", press);
    assert.equal(press.defaultPrevented, true, JSON.stringify(key) + " does not scroll the page");
    assert.equal(lightbox(sdk).hidden, false, JSON.stringify(key) + " does not close it");
  }
  const typed = { ...escapeKey(), key: "a" };
  typed.preventDefault = () => (typed.defaultPrevented = true);
  sdk.dispatch("keydown", typed);
  assert.equal(typed.defaultPrevented, false, "other keys are left alone");

  const drag = fire(lightbox(sdk), "touchmove", { touches: [{}] });
  assert.equal(drag.event.defaultPrevented, true, "a one-finger drag does not scroll it");
  assert.equal(fire(lightbox(sdk), "wheel").event.defaultPrevented, true, "nor does the wheel");
});

test("two fingers on the full-size view are left to the browser, so the image can be pinch-zoomed", () => {
  const sdk = bootSdk();
  sdk.dispatch("pointerover", { target: image(sdk, LARGE) });
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  const pinch = fire(lightbox(sdk), "touchmove", { touches: [{}, {}] });
  assert.equal(pinch.event.defaultPrevented, false);
});

test("a resize moves the expand button with its image instead of hiding it", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img });
  const moved = { left: 20, top: 120, right: 420, bottom: 420 };
  img.getBoundingClientRect = () => ({ ...moved, width: 400, height: 300 });
  sdk.resize();
  const button = expandButton(sdk);
  assert.equal(button.hidden, false, "a keyboard opening does not take the button away");
  assert.deepEqual([button.style.left, button.style.top], ["380px", "128px"], "it sits in the image's new corner");
  button.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(lightbox(sdk).hidden, false, "and still opens that image");
});

test("a resize that leaves the image too small or removes it hides the expand button", () => {
  const sdk = bootSdk();
  const shrunk = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: shrunk });
  shrunk.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 90, width: 120, height: 90 });
  sdk.resize();
  assert.equal(expandButton(sdk).hidden, true, "an image no longer large enough loses its button");

  const removed = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: removed });
  removed.isConnected = false;
  sdk.resize();
  assert.equal(expandButton(sdk).hidden, true, "so does one that is gone");
});

test("a resize with no expand button showing brings none back", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img });
  sdk.dispatch("pointerover", { target: appendTo(sdk.body, createElement("p")) });
  sdk.resize();
  assert.equal(expandButton(sdk).hidden, true);
});

test("with no full-size view open the scrolling keys are left to the page", () => {
  const sdk = bootSdk();
  const press = { ...escapeKey(), key: "PageDown" };
  press.preventDefault = () => (press.defaultPrevented = true);
  sdk.dispatch("keydown", press);
  assert.equal(press.defaultPrevented, false);
});

test("an image removed since it was pointed at does not open", () => {
  const sdk = bootSdk();
  const img = image(sdk, LARGE);
  sdk.dispatch("pointerover", { target: img });
  img.isConnected = false;
  expandButton(sdk).onclick({ preventDefault() {}, stopPropagation() {} });
  assert.ok(!lightbox(sdk) || lightbox(sdk).hidden, "nothing opens for a removed image");
  assert.equal(expandButton(sdk).hidden, true);
});

// Leaving a card that holds nothing is Cancel: a click elsewhere closes it instead of opening a
// second card, and Escape in its box does the same. A card with text keeps today's behavior.
test("the served SDK bundle cancels an empty card on a click away and on Escape, and keeps a written one", () => {
  // The harness's shadow root never removes a closed card, so this counts cards opened: a click
  // that cancels opens none, and the click after a cancel opens a fresh one.
  const sdk = bootSdk();
  const first = appendTo(sdk.body, cell("p", "First"));
  const second = appendTo(sdk.body, cell("p", "Second"));

  sdk.click(first);
  assert.equal(sdk.cards().length, 1);
  sdk.click(second);
  assert.equal(sdk.cards().length, 1, "a click away from an empty card opens no second card");
  sdk.click(second);
  assert.equal(sdk.cards().length, 2, "the cancelled card is gone: the next click opens one");

  const keydown = sdk
    .card()
    .querySelector("textarea")
    .listeners.find((entry) => entry.type === "keydown");
  keydown.handler({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  sdk.click(first);
  assert.equal(sdk.cards().length, 3, "Escape closed the card, so this click opens a new one");

  const kept = sdk.card();
  kept.querySelector("textarea").value = "tighten this";
  sdk.click(second);
  assert.equal(sdk.cards().length, 3, "a card with text is modal: a click away opens no other card");
  assert.equal(kept.querySelector("textarea").value, "tighten this");
  kept.querySelector(".review-surface-cancel").onclick();
  sdk.click(second);
  assert.equal(sdk.cards().length, 4, "after Cancel, a click opens a card again");
});

// A written card is modal for links too: neither an ordinary link nor a link to another review page
// is followed while it is open.
test("the served SDK bundle follows no link while a card holds text", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "See the reviews"));
  const link = appendTo(paragraph, cell("a", "the reviews"));
  link.setAttribute("href", "#reviews");
  sdk.click(paragraph);
  const kept = sdk.card();
  kept.querySelector("textarea").value = "tighten this";

  assert.equal(sdk.click(link).defaultPrevented, true, "the link is not followed");
  const before = sdk.posted.length;
  assert.equal(sdk.click(pageLink(sdk, "/session/0123456789abcdef")).defaultPrevented, true);
  assert.equal(sdk.posted.slice(before).filter((message) => message.type === "review-surface:openPage").length, 0);
  assert.equal(sdk.cards().length, 1);
  assert.equal(kept.querySelector("textarea").value, "tighten this");

  kept.querySelector(".review-surface-cancel").onclick();
  assert.equal(sdk.click(link).defaultPrevented, false, "after Cancel the link is followed again");
});

test("the served SDK bundle closes an empty card when a link is clicked, and still follows the link", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "See the reviews"));
  const link = appendTo(paragraph, cell("a", "the reviews"));
  link.setAttribute("href", "#reviews");
  sdk.click(paragraph);
  assert.equal(sdk.cards().length, 1);
  assert.equal(sdk.click(link).defaultPrevented, false, "the link is followed");
  sdk.click(paragraph);
  assert.equal(sdk.cards().length, 2, "the empty card was closed, so this click opens a new one");
});

// With This page or Queued open in the chrome, a click in the page only closes it: one action at a
// time, so the same click never also opens an annotation card.
test("the served SDK bundle spends a click on closing an open footer panel, and nothing else", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Prose"));
  sdk.sendChromeMessage({ type: "review-surface:footerPanel", open: true });
  const event = sdk.click(paragraph);
  assert.equal(event.defaultPrevented, true);
  assert.equal(sdk.cards().length, 0, "the closing click opens no card");
  assert.equal(sdk.posted.at(-1)?.type, "review-surface:closeFooterPanels");
  sdk.click(paragraph);
  assert.equal(sdk.cards().length, 1, "the next click annotates again");
});

// Links are navigation in annotate mode too: a click on one follows it and opens no card, while
// the paragraph around it stays annotatable.
test("the served SDK bundle lets a link be followed in annotate mode, and annotates around it", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "See the reviews"));
  const link = appendTo(paragraph, cell("a", "the reviews"));
  link.setAttribute("href", "#reviews");
  const followed = sdk.click(link);
  assert.equal(followed.defaultPrevented, false, "the browser follows the link");
  assert.equal(sdk.cards().length, 0);
  sdk.click(paragraph);
  assert.equal(sdk.cards().length, 1, "the paragraph itself still annotates");
});

// A page with a section link to an element that exists, in a frame whose address and history the
// test can read back. `styleSheets` is what the page's own CSS would expose.
// Just enough of selector matching for these pages: comma lists of compounds made of a tag,
// classes, and the two pseudo-classes whose answer is the same for every element, :is(*) (always)
// and :not(*) (never). Anything else throws, as an unparseable selector does in a browser.
function matchesSelector(tag, classes, selectorList) {
  return String(selectorList)
    .split(",")
    .some((compound) => {
      const parts = compound.trim().match(/^([a-z0-9]*)((?:\.[\w-]+|:is\(\*\)|:not\(\*\))*)$/);
      if (!parts || !compound.trim()) throw new SyntaxError("unsupported selector: " + compound);
      const [, wantedTag, rest] = parts;
      if (wantedTag && wantedTag !== tag) return false;
      if (rest.includes(":not(*)")) return false;
      return [...rest.matchAll(/\.([\w-]+)/g)].every(([, name]) => classes.includes(name));
    });
}

function bootSectionPage({ styleSheets = [], reducedMotion = false, currentTarget = null } = {}) {
  const page = { scrolls: [], topScrolls: [], replaced: [], hashChanges: [] };
  const section = createElement("section");
  section.scrollIntoView = (options) => page.scrolls.push({ ...options });
  section.matches = (selectorList) => matchesSelector("section", ["tab"], selectorList);
  const sdk = bootSdk({
    setup(sandbox) {
      sandbox.document.getElementById = (id) => (id === "reviews" ? section : null);
      sandbox.document.querySelector = (selector) => (selector === ":target" ? currentTarget : null);
      sandbox.document.styleSheets = styleSheets;
      Object.assign(sandbox.window, {
        scrollTo: (options) => page.topScrolls.push({ ...options }),
        HashChangeEvent: class HashChangeEvent {
          constructor(type, init) {
            Object.assign(this, { type }, init);
          }
        },
        location: { origin: "http://127.0.0.1", href: "http://127.0.0.1/artifact/abc/index.html" },
        matchMedia: () => ({ matches: reducedMotion }),
        dispatchEvent: (event) => page.hashChanges.push(event),
        history: {
          state: null,
          replaceState(_state, _title, url) {
            page.replaced.push(url);
            sandbox.window.location.href = new URL(url, sandbox.window.location.href).href;
          },
        },
      });
    },
  });
  page.link = appendTo(appendTo(sdk.body, cell("p", "See the reviews")), cell("a", "the reviews"));
  page.link.setAttribute("href", "#reviews");
  page.section = section;
  return { sdk, page };
}

// Intent (2): same-page section links scroll smoothly and replace the address rather than adding
// a history entry. The round-1 decision adds that script listeners still hear a hashchange.
test("a same-page section link scrolls smoothly, adds no history entry, and still fires hashchange", () => {
  const { sdk, page } = bootSectionPage();
  const event = sdk.pageClick(page.link);

  assert.equal(event.defaultPrevented, true, "the browser's own jump is replaced");
  assert.deepEqual(page.scrolls, [{ behavior: "smooth", block: "start" }]);
  assert.deepEqual(page.replaced, ["#reviews"]);
  assert.deepEqual(
    page.hashChanges.map((change) => ({ ...change })),
    [
      {
        type: "hashchange",
        oldURL: "http://127.0.0.1/artifact/abc/index.html",
        newURL: "http://127.0.0.1/artifact/abc/index.html#reviews",
      },
    ],
  );

  sdk.pageClick(page.link);
  assert.equal(page.hashChanges.length, 1, "the same section again changes no hash, as in a browser");
});

test("a same-page section link jumps without animation under reduced motion", () => {
  const { sdk, page } = bootSectionPage({ reducedMotion: true });
  sdk.pageClick(page.link);
  assert.deepEqual(page.scrolls, [{ behavior: "auto", block: "start" }]);
});

// Intent (2): defaultPrevented links are left alone. The page's handler runs after the SDK's
// capture listener, so a tab link such as <a href="#panel2" onclick="show(); return false"> must
// still be the page's to cancel.
test("a section link the page's own handler cancels is neither scrolled nor written to the address", () => {
  const { sdk, page } = bootSectionPage();
  let pageHandlerRan = false;
  sdk.pageClick(page.link, (event) => {
    pageHandlerRan = !event.defaultPrevented;
    event.preventDefault();
  });

  assert.equal(pageHandlerRan, true, "the page's handler gets the click first, uncancelled");
  assert.deepEqual(page.scrolls, []);
  assert.deepEqual(page.replaced, []);
  assert.deepEqual(page.hashChanges, []);
});

// Only the browser's own fragment navigation moves :target, so a link whose own destination the
// page styles as :target (CSS-only tabs, lightboxes) keeps that navigation.
test("a link to an element the page styles as :target keeps the browser's own navigation", () => {
  const unreadable = {
    get cssRules() {
      throw new Error("SecurityError");
    },
  };
  const nested = { cssRules: [{ cssRules: [{ selectorText: "h2, .tab:target" }] }] };
  const { sdk, page } = bootSectionPage({ styleSheets: [unreadable, nested] });
  const event = sdk.pageClick(page.link);

  assert.equal(event.defaultPrevented, false, "the browser follows the link itself");
  assert.deepEqual(page.scrolls, []);
  assert.deepEqual(page.replaced, []);
});

// Intent (2) holds on the rest of such a page: a :target rule for other elements, or one whose
// styling this element gets with or without being the target, takes nothing from this link.
test("a :target rule that does not style the link's own destination does not stop the smooth scroll", () => {
  const sheet = {
    cssRules: [
      { selectorText: "h2:target" },
      { selectorText: ".lightbox:target, .tab" },
      { selectorText: "p::target-text" },
      { selectorText: ":target > [data-x]" },
    ],
  };
  const { sdk, page } = bootSectionPage({ styleSheets: [sheet] });
  const event = sdk.pageClick(page.link);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(page.scrolls, [{ behavior: "smooth", block: "start" }]);
  assert.deepEqual(page.replaced, ["#reviews"]);
});

// HTML's fragment rules: an empty fragment, and "top" in any case when no element has that id,
// are the top of the document. They get the same smooth scroll and no history entry.
for (const href of ["#", "#top", "#TOP"]) {
  test(`a back-to-top link (${href}) scrolls smoothly to the top and adds no history entry`, () => {
    const { sdk, page } = bootSectionPage();
    page.link.setAttribute("href", href);
    const event = sdk.pageClick(page.link);

    assert.equal(event.defaultPrevented, true, "the browser's own jump is replaced");
    assert.deepEqual(page.topScrolls, [{ top: 0, left: 0, behavior: "smooth" }]);
    assert.deepEqual(page.scrolls, [], "no section is scrolled to");
    assert.deepEqual(page.replaced, [href]);
  });
}

test("a back-to-top link jumps without animation under reduced motion", () => {
  const { sdk, page } = bootSectionPage({ reducedMotion: true });
  page.link.setAttribute("href", "#top");
  sdk.pageClick(page.link);
  assert.deepEqual(page.topScrolls, [{ top: 0, left: 0, behavior: "auto" }]);
});

test("a fragment that names nothing on the page is left to the browser", () => {
  const { sdk, page } = bootSectionPage();
  page.link.setAttribute("href", "#missing");
  const event = sdk.pageClick(page.link);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(page.topScrolls, []);
  assert.deepEqual(page.replaced, []);
});

// A CSS-only lightbox closes through <a href="#">: leaving the element that is :target now needs
// the browser's navigation just as arriving at it did.
test("a link away from an element shown by :target keeps the browser's own navigation", () => {
  const lightbox = createElement("div");
  lightbox.matches = (selectorList) => matchesSelector("div", ["lightbox"], selectorList);
  const sheet = { cssRules: [{ selectorText: ".lightbox:target" }] };
  const { sdk, page } = bootSectionPage({ styleSheets: [sheet], currentTarget: lightbox });
  page.link.setAttribute("href", "#");
  const event = sdk.pageClick(page.link);

  assert.equal(event.defaultPrevented, false, "the browser clears :target itself");
  assert.deepEqual(page.topScrolls, []);
  assert.deepEqual(page.replaced, []);
});

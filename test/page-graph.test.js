import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.REVIEW_SURFACE_HOST = "127.0.0.1";
process.env.REVIEW_SURFACE_LINK_HOST = "127.0.0.1";

import {
  derivePageState,
  LinkStore,
  parsePageQuery,
  QUIET_AFTER_MS,
  queryPages,
  readLinkRecords,
  searchEverything,
} from "../src/page-graph.js";
import { serve } from "../src/server.js";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "review-surface-page-graph-"));
}

function session(key, file, extra = {}) {
  return { key, file, status: "open", prompts: [], chat: [], updated_at: new Date().toISOString(), ...extra };
}

const SESSIONS = [
  session("aaaa", "/work/project.html"),
  session("bbbb", "/work/round-1.html"),
  session("cccc", "/work/round-2.html"),
  session("dddd", "/work/other/round-1.html"),
  session("eeee", "/work/notes.html"),
];

async function linkStore() {
  const dir = await tempDir();
  return { dir, store: new LinkStore(path.join(dir, "links.jsonl")) };
}

test("the link store refuses every shape the graph must never hold, writing nothing", async () => {
  const { dir, store } = await linkStore();
  try {
    await store.record(SESSIONS, { type: "child-of", from: "bbbb", to: "aaaa" });
    await store.record(SESSIONS, { type: "supersedes", from: "cccc", to: "bbbb" });
    const before = await readFile(store.file, "utf8");

    const refusals = [
      { link: { type: "child-of", from: "aaaa", to: "bbbb" }, message: /Nesting cycle/ },
      { link: { type: "supersedes", from: "bbbb", to: "cccc" }, message: /Supersede cycle/ },
      { link: { type: "supersedes", from: "eeee", to: "bbbb" }, message: /already replaced by another page/ },
      { link: { type: "blocks", from: "eeee", to: "aaaa" }, message: /Link type must be one of/ },
      { link: { type: "child-of", from: "round-1.html", to: "aaaa" }, message: /matches 2 pages/ },
      { link: { type: "derived-from", from: "eeee", to: "eeee" }, message: /cannot link to itself/ },
      { link: { type: "child-of", from: "never-opened.html", to: "aaaa" }, message: /No page matches/ },
    ];
    for (const { link, message } of refusals) {
      await assert.rejects(store.record(SESSIONS, link), message, `${link.type} ${link.from} -> ${link.to}`);
    }
    assert.equal(await readFile(store.file, "utf8"), before, "a refused link appends nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a longer path suffix resolves an ambiguous page name, and re-recording is a no-op", async () => {
  const { dir, store } = await linkStore();
  try {
    const first = await store.record(SESSIONS, { type: "child-of", from: "other/round-1.html", to: "project.html" });
    assert.equal(first.status, "recorded");
    assert.deepEqual(first.link, { type: "child-of", from: "dddd", to: "aaaa" });
    const again = await store.record(SESSIONS, { type: "child-of", from: "dddd", to: "/work/project.html" });
    assert.equal(again.status, "unchanged");
    assert.equal((await readLinkRecords(store.file)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a page that supersedes another takes the older page's place under its parent", async () => {
  const { dir, store } = await linkStore();
  try {
    await store.record(SESSIONS, { type: "child-of", from: "bbbb", to: "aaaa" });
    const result = await store.record(SESSIONS, { type: "supersedes", from: "cccc", to: "bbbb" });
    assert.deepEqual(
      result.records.map(({ type, from, to }) => [type, from, to]),
      [
        ["supersedes", "cccc", "bbbb"],
        ["child-of", "cccc", "aaaa"],
      ],
    );
    const pages = queryPages(
      { sessions: SESSIONS, records: await store.read(), titles: new Map(), now: Date.now() },
      {
        under: "aaaa",
      },
    );
    assert.deepEqual(
      pages.map((page) => page.key),
      ["cccc"],
      "the replaced round drops out; its successor is listed in its place",
    );
    assert.deepEqual(pages[0].links.replaces, ["bbbb"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state comes from recorded session facts, never from the title", async () => {
  const now = Date.now();
  const dir = await tempDir();
  try {
    const decided = path.join(dir, "decided.html");
    await writeFile(decided, "<!doctype html><title>DECIDED: ship it</title><body></body>");
    const { readPageTitle } = await import("../src/page-graph.js");
    const sessions = [session("k1", decided, { chat: [{ role: "user", text: "one more change", at: "" }] })];
    const titles = new Map([["k1", await readPageTitle(decided)]]);
    const [page] = queryPages({ sessions, records: [], titles, now });
    assert.equal(page.title, "DECIDED: ship it");
    assert.equal(page.state, "agent-working");

    const old = new Date(now - QUIET_AFTER_MS - 1000).toISOString();
    assert.equal(derivePageState(session("x", "/f", { status: "ended" }), now), "ended");
    assert.equal(derivePageState(session("x", "/f", { prompts: [{ prompt: "p" }] }), now), "agent-working");
    assert.equal(derivePageState(session("x", "/f", { chat: [{ role: "agent" }] }), now), "needs-you");
    assert.equal(derivePageState(session("x", "/f"), now), "new");
    assert.equal(derivePageState(session("x", "/f", { chat: [{ role: "agent" }], updated_at: old }), now), "quiet");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the page query filters by parent, depth, state, text, and replaced-or-not", () => {
  const sessions = [
    session("root", "/w/home.html"),
    session("proj", "/w/project.html"),
    session("r1", "/w/round-1.html", { chat: [{ role: "agent" }] }),
    session("r2", "/w/round-2.html", { status: "ended" }),
    session("deep", "/w/deep.html"),
  ];
  const records = [
    { type: "child-of", from: "proj", to: "root" },
    { type: "child-of", from: "r1", to: "proj" },
    { type: "child-of", from: "r2", to: "proj" },
    { type: "child-of", from: "deep", to: "r1" },
    { type: "supersedes", from: "r2", to: "r1" },
  ];
  const input = { sessions, records, titles: new Map(), now: Date.now() };
  const keys = (options) => queryPages(input, options).map((page) => page.key);

  assert.deepEqual(keys({ under: "root", depth: 1 }), ["proj"]);
  assert.deepEqual(keys({ under: "proj", replaced: "any" }).sort(), ["deep", "r1", "r2"]);
  assert.deepEqual(keys({ under: "proj" }).sort(), ["deep", "r2"], "replaced pages are hidden by default");
  assert.deepEqual(keys({ replaced: "yes" }), ["r1"]);
  assert.deepEqual(keys({ states: ["needs-you"], replaced: "any" }), ["r1"]);
  assert.deepEqual(keys({ text: "DEEP" }), ["deep"]);
  assert.deepEqual(keys({ depth: 0 }), ["root"]);
  const [r2] = queryPages(input, { text: "round-2" });
  assert.deepEqual(r2.links, { parent: "proj", children: [], replaced_by: null, replaces: ["r1"], derived_from: [] });

  assert.throws(() => parsePageQuery({ state: "decided" }), /Unknown state decided/);
  assert.throws(() => parsePageQuery({ depth: "-1" }), /whole number/);
  assert.throws(() => parsePageQuery({ replaced: "maybe" }), /replaced must be one of/);
});

test("search covers pages, feedback, replies, and events, ignoring the tree", () => {
  const sessions = [
    session("k1", "/w/a.html", { chat: [{ role: "agent", text: "Moved the chart", at: "2026-09-02" }] }),
  ];
  const pages = queryPages({ sessions, records: [], titles: new Map(), now: Date.now() });
  const sources = {
    pages,
    sessions,
    journal: [{ key: "k1", file: "/w/a.html", at: "2026-09-01", prompts: [{ prompt: "make the chart bigger" }] }],
    events: [{ ts: "2026-09-03", type: "page.opened", subject: "k1", data: { file: "/w/a.html" } }],
  };
  assert.deepEqual(
    searchEverything(sources, "chart").map((hit) => hit.kind),
    ["reply", "feedback"],
  );
  assert.deepEqual(
    searchEverything(sources, "a.html", { kinds: ["event", "page"] }).map((hit) => hit.kind),
    ["page", "event"],
    "newest first: the page was touched just now, the event on 2026-09-03",
  );
});

async function served() {
  // Canonical, like the CLI's canonicalPageRef: on Windows tmpdir() can be an 8.3 short path
  // the server's realpath expands, so a raw temp path would not match the stored session file.
  const dir = await realpath(await tempDir());
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route, body, headers = {}) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const page = async (name) => {
    const file = path.join(dir, name);
    await writeFile(file, `<!doctype html><title>${name}</title><body></body>`);
    return file;
  };
  return { dir, server, base, post, page };
}

test("open with supersedes records the link, takes the parent, and logs it on the event stream", async () => {
  const { dir, server, base, post, page } = await served();
  try {
    const project = await page("project.html");
    const original = await page("discussion.html");
    const round = await page("round-2.html");
    await post("/api/sessions", { file: project });
    const opened = await (await post("/api/sessions", { file: original })).json();
    const filed = await post("/api/links", { type: "child-of", from: original, to: "project.html" });
    assert.equal(filed.status, 200);

    const reopened = await (await post("/api/sessions", { file: round, supersedes: original })).json();
    assert.equal(reopened.status, "opened");
    assert.equal(reopened.link.status, "recorded");
    assert.equal(reopened.link.to, opened.key);

    const { pages } = await (await fetch(`${base}/api/pages?under=project.html`)).json();
    assert.deepEqual(
      pages.map((p) => p.title),
      ["round-2.html"],
      "the discussion appears once, as its newest round",
    );

    const events = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "link.recorded")
      .map((event) => event.data.type);
    assert.deepEqual(events, ["child-of", "supersedes", "child-of"]);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refused open-time link is reported and never fails the open", async () => {
  const { dir, server, post, page } = await served();
  try {
    const old = await page("old.html");
    const first = await page("first.html");
    const second = await page("second.html");
    await post("/api/sessions", { file: old });
    await post("/api/sessions", { file: first, supersedes: old });
    const response = await post("/api/sessions", { file: second, supersedes: old });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "opened");
    assert.equal(body.link.status, "refused");
    assert.match(body.link.error, /already replaced by another page/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the link route maps refusals to 400/404/409 and the read routes are origin-guarded", async () => {
  const { dir, server, base, post, page } = await served();
  try {
    const a = await page("a.html");
    await post("/api/sessions", { file: a });
    assert.equal((await post("/api/links", { type: "blocks", from: a, to: a })).status, 400);
    assert.equal((await post("/api/links", { type: "child-of", from: a, to: "missing.html" })).status, 404);
    assert.equal((await post("/api/links", { type: "child-of", from: a, to: a })).status, 409);
    assert.equal(
      (await post("/api/links", { type: "child-of", from: a, to: a }, { origin: "http://evil.test" })).status,
      403,
    );

    const crossOrigin = { headers: { origin: "http://evil.test" } };
    assert.equal((await fetch(`${base}/api/pages`, crossOrigin)).status, 403);
    assert.equal((await fetch(`${base}/api/search?q=a`, crossOrigin)).status, 403);
    assert.equal((await fetch(`${base}/api/pages?state=decided`)).status, 400);
    const { hits } = await (await fetch(`${base}/api/search?q=a.html&kind=page`)).json();
    assert.deepEqual(
      hits.map((hit) => hit.kind),
      ["page"],
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

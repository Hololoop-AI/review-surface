import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.REVIEW_SURFACE_TELEMETRY = "0";
process.env.REVIEW_SURFACE_LINK_HOST = "127.0.0.1";

import { resolveHostPages, serve } from "../src/server.js";

// Round 4 (2026-11-03). The driver: "we should be able to use the review surface ui above other
// UIs... The only change is what html is displayed beneath it" - and, on host pages, "sounds good".
test("host pages: only root-relative addresses the page server does not route itself", () => {
  const logged = [];
  const pages = resolveHostPages(
    {
      REVIEW_SURFACE_HOST_PAGES: JSON.stringify([
        { id: "fleet", url: "/fleet", title: "Fleet" },
        { id: "cards", url: "/cards?due=1" },
        { id: "evil", url: "//evil.test/x" },
        { id: "art", url: "/artifact/abc/index.html" },
        { id: "sess", url: "/session/abc" },
        { id: "Bad Id", url: "/x" },
        { id: "abs", url: "https://evil.test/" },
      ]),
    },
    (line) => logged.push(line),
  );
  assert.deepEqual(pages, [
    { id: "fleet", url: "/fleet", title: "Fleet" },
    { id: "cards", url: "/cards?due=1", title: "cards" },
  ]);
  assert.equal(logged.length, 5, "each refusal is reported");
  assert.deepEqual(
    resolveHostPages({ REVIEW_SURFACE_HOST_PAGES: "{not json" }, () => {}),
    [],
  );
});

test("a host page opens under the full frame: the host's own address, trusted, with no artifact handshake", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "rs-host-pages-")));
  const previous = process.env.REVIEW_SURFACE_HOST_PAGES;
  process.env.REVIEW_SURFACE_HOST_PAGES = JSON.stringify([{ id: "fleet", url: "/fleet", title: "Fleet" }]);
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const opened = await fetch(`${base}/host/fleet`, { redirect: "manual" });
    assert.equal(opened.status, 302);
    const location = opened.headers.get("location");
    assert.match(location, /^\/session\/[0-9a-f]{16}$/);
    const placeholder = path.join(dir, "host-pages", "fleet.html");
    const firstWrite = (await stat(placeholder)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await fetch(`${base}/host/fleet`, { redirect: "manual" });
    assert.equal(again.headers.get("location"), location, "one session per host page");
    assert.equal((await stat(placeholder)).mtimeMs, firstWrite, "a revisit must not touch the watched file");

    const html = await (await fetch(`${base}${location}`)).text();
    const iframe = html.match(/<iframe id="artifact"[^>]*>/)[0];
    assert.match(iframe, / src="\/fleet"/);
    assert.match(iframe, /allow-same-origin/, "the host's own page keeps its forms and cookies");
    assert.doesNotMatch(iframe, /data-artifact-src/, "no agent-artifact load handshake");
    assert.match(html, /"hostUrl":"\/fleet"/);
    assert.match(html, /"layoutGateEnabled":false/);
    assert.match(html, /class="[^"]*host-page/);

    assert.equal((await fetch(`${base}/host/unknown`, { redirect: "manual" })).status, 404);

    // An agent page keeps its locked-down frame.
    const pages = await (await fetch(`${base}/api/pages`)).json();
    assert.equal(pages.pages.length, 1);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_SURFACE_HOST_PAGES;
    else process.env.REVIEW_SURFACE_HOST_PAGES = previous;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a host page still opens as the host's page when the state directory is reached through a symlink", async () => {
  const real = await realpath(await mkdtemp(path.join(tmpdir(), "rs-host-pages-real-")));
  const linkParent = await realpath(await mkdtemp(path.join(tmpdir(), "rs-host-pages-link-")));
  const linked = path.join(linkParent, "state");
  await symlink(real, linked, "dir");
  const previous = process.env.REVIEW_SURFACE_HOST_PAGES;
  process.env.REVIEW_SURFACE_HOST_PAGES = JSON.stringify([{ id: "fleet", url: "/fleet", title: "Fleet" }]);
  const server = await serve({ port: 0, stateFile: path.join(linked, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const location = (await fetch(`${base}/host/fleet`, { redirect: "manual" })).headers.get("location");
    const html = await (await fetch(`${base}${location}`)).text();
    assert.match(html, /<iframe id="artifact"[^>]* src="\/fleet"/);
    assert.match(html, /"layoutGateEnabled":false/);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_SURFACE_HOST_PAGES;
    else process.env.REVIEW_SURFACE_HOST_PAGES = previous;
    await server.close();
    await rm(linkParent, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
  }
});

// Round 5 (2026-11-04): agent messages live in the host's store (track A's runner), and the footer
// is their messenger. The host names its feed; the page server only hands the address to the chrome.
test("the host's message feed reaches the chrome when it is a root-relative address", async () => {
  const { resolveMessageFeed } = await import("../src/server.js");
  const logged = [];
  assert.equal(resolveMessageFeed({ REVIEW_SURFACE_MESSAGE_FEED: "/api/messages" }), "/api/messages");
  assert.equal(resolveMessageFeed({}), "");
  assert.equal(
    resolveMessageFeed({ REVIEW_SURFACE_MESSAGE_FEED: "//evil.test/feed" }, (l) => logged.push(l)),
    "",
  );
  assert.equal(
    resolveMessageFeed({ REVIEW_SURFACE_MESSAGE_FEED: "https://evil.test/" }, (l) => logged.push(l)),
    "",
  );
  assert.equal(logged.length, 2);

  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "rs-feed-")));
  const previous = process.env.REVIEW_SURFACE_MESSAGE_FEED;
  process.env.REVIEW_SURFACE_MESSAGE_FEED = "/api/messages";
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const file = path.join(dir, "page.html");
    await writeFile(file, "<!doctype html><title>p</title><body></body>");
    const { key } = await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      })
    ).json();
    const html = await (await fetch(`${base}/session/${key}`)).text();
    assert.match(html, /"messageFeed":"\/api\/messages"/);
  } finally {
    if (previous === undefined) delete process.env.REVIEW_SURFACE_MESSAGE_FEED;
    else process.env.REVIEW_SURFACE_MESSAGE_FEED = previous;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

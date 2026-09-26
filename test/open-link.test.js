import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.REVIEW_SURFACE_HOST = "127.0.0.1";
process.env.REVIEW_SURFACE_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";

async function servedDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-open-link-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
  });
  return { dir, server, base: `http://127.0.0.1:${server.port}` };
}

test("/open turns an artifact path into its session, creating one on demand", async () => {
  const { dir, server, base } = await servedDir();
  try {
    // The cross-surface link case: one artifact links to another that has
    // never been opened, so no session key exists for the author to write.
    const other = path.join(dir, "other-surface.html");
    await writeFile(other, "<!doctype html><html><body><h1>Other</h1></body></html>");

    const response = await fetch(`${base}/open?file=${encodeURIComponent(other)}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert.match(location, /^\/session\/[0-9a-f]{16}$/);

    // and that session actually serves (the chrome loads the artifact itself)
    const page = await fetch(`${base}${location}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(location.split("/").pop()));

    // a second link click resolves to the SAME session, not a duplicate
    const again = await fetch(`${base}/open?file=${encodeURIComponent(other)}`, {
      redirect: "manual",
    });
    assert.equal(again.headers.get("location"), location);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/open refuses a missing artifact and a missing file parameter", async () => {
  const { dir, server, base } = await servedDir();
  try {
    const missing = await fetch(`${base}/open?file=${encodeURIComponent(path.join(dir, "nope.html"))}`, {
      redirect: "manual",
    });
    assert.equal(missing.status, 404);
    const bare = await fetch(`${base}/open`, { redirect: "manual" });
    assert.equal(bare.status, 400);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a link click never revives a session the human ended", async () => {
  const { dir, server, base } = await servedDir();
  try {
    const artifact = path.join(dir, "ended.html");
    const keepAlive = path.join(dir, "other.html");
    for (const f of [artifact, keepAlive]) {
      await writeFile(f, "<!doctype html><html><body><h1>x</h1></body></html>");
    }
    const open = async (file) =>
      fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      }).then((response) => response.json());
    const created = await open(artifact);
    await open(keepAlive); // the server shuts down on its last session
    const key = created.url.split("/").pop();
    await fetch(`${base}/api/${key}/end`, { method: "POST" });

    const response = await fetch(`${base}/open?file=${encodeURIComponent(artifact)}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302); // still points at the session
    const status = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(status.status, "ended"); // ...but did not reopen it
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/open answers JSON when the chrome asks, so it can navigate itself", async () => {
  const { dir, server, base } = await servedDir();
  try {
    const other = path.join(dir, "other-surface.html");
    await writeFile(other, "<!doctype html><html><body><h1>Other</h1></body></html>");
    const json = { headers: { accept: "application/json" } };

    const found = await fetch(`${base}/open?file=${encodeURIComponent(other)}`, json);
    assert.equal(found.status, 200);
    const body = await found.json();
    assert.match(body.key, /^[0-9a-f]{16}$/);
    assert.equal(body.url, `/session/${body.key}`);

    const missing = await fetch(`${base}/open?file=${encodeURIComponent(path.join(dir, "nope.html"))}`, json);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "that file does not exist." });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

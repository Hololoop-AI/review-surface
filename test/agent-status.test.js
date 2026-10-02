import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.REVIEW_SURFACE_HOST = "127.0.0.1";
process.env.REVIEW_SURFACE_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";

async function servedSession() {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-agent-status-"));
  const artifact = path.join(dir, "artifact.html");
  // poll addresses sessions by FILE (the canonical path is the identity)
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const created = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((response) => response.json());
  const key = created.url.split("/").pop();
  return { dir, server, base, key, artifact };
}

test("agent-status reads presence and pending prompts without consuming anything", async () => {
  const { dir, server, base, key, artifact } = await servedSession();
  try {
    const idle = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(idle.status, "open");
    assert.equal(idle.presence, "waiting");
    assert.equal(idle.pending_prompts, 0);
    assert.equal(idle.last_agent_reply_at, null);
    assert.ok(idle.updated_at);

    // the driver sends feedback (same-origin guarded route, so say who we are)
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        domSnapshot: 'uid=1 h1 "Hi"',
        prompts: [{ uid: "1", prompt: "warmer please", selector: "h1", tag: "h1", text: "Hi" }],
      }),
    });
    assert.equal(queued.status, 200);

    const pending = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(pending.pending_prompts, 1);

    // reading status twice must not consume: the count holds
    const again = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(again.pending_prompts, 1);

    // delivery consumes the queue and flips presence to working
    const delivered = await fetch(
      `${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`,
    ).then((r) => r.json());
    assert.equal(delivered.status, "feedback");
    const working = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(working.pending_prompts, 0);
    assert.equal(working.presence, "working");

    // an agent reply closes the working state and stamps the chat
    const replied = await fetch(`${base}/api/${key}/agent-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "done — take a look" }),
    });
    assert.equal(replied.status, 200);
    const answered = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(answered.presence, "waiting");
    assert.ok(answered.last_agent_reply_at);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent-status is 404 for an unknown session", async () => {
  const { dir, server, base } = await servedSession();
  try {
    const res = await fetch(`${base}/api/no-such-key/agent-status`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function firstPresenceEvent(base, key) {
  const controller = new AbortController();
  const response = await fetch(`${base}/events/${key}`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!/event: agent-presence\ndata: (.*)\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } finally {
    controller.abort();
  }
  return JSON.parse(text.match(/event: agent-presence\ndata: (.*)\n/)[1]).state;
}

test("a push-delivery session never tells the driver the agent is not listening", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-push-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const open = (body) =>
    fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, ...body }),
    }).then((response) => response.json());
  try {
    const created = await open({ delivery: "push" });
    const key = created.url.split("/").pop();

    // The status endpoint stays truthful about polls (the host's own logic reads "waiting")
    // and names the delivery mode separately.
    const status = await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json());
    assert.equal(status.presence, "waiting");
    assert.equal(status.delivery, "push");
    // The chrome is told "push", which shows no "not listening" banner.
    assert.equal(await firstPresenceEvent(base, key), "push");

    // Reopening without a delivery keeps the stored mode.
    await open({});
    assert.equal((await fetch(`${base}/api/${key}/agent-status`).then((r) => r.json())).delivery, "push");

    // A poll session still reports plain waiting to its chrome.
    await open({ delivery: "poll" });
    assert.equal(await firstPresenceEvent(base, key), "waiting");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

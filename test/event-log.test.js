import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.REVIEW_SURFACE_HOST = "127.0.0.1";
process.env.REVIEW_SURFACE_LINK_HOST = "127.0.0.1";

import { EventLog, eventLogFile } from "../src/event-log.js";
import { serve } from "../src/server.js";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "review-surface-event-log-"));
}

async function readLog(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// Read an SSE response until `count` data frames arrive, returning {id, event} per frame.
async function readFrames(response, count, timeoutMs = 5_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (frames.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out with ${frames.length}/${count} frames`);
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("read timed out")), timeoutMs)),
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data) frames.push({ id: Number(id), event: JSON.parse(data) });
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return frames;
}

test("eventLogFile sits beside the state file unless REVIEW_SURFACE_EVENTS names one", () => {
  assert.equal(eventLogFile("/s/state.json", {}), "/s/events.jsonl");
  assert.equal(eventLogFile("/s/state.json", { REVIEW_SURFACE_EVENTS: "/elsewhere/e.jsonl" }), "/elsewhere/e.jsonl");
});

test("append writes one envelope per line and cursors are the byte offset past each line", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "nested", "events.jsonl");
    const log = new EventLog(file);
    const first = await log.append("page.opened", "k1", { file: "/a.html" });
    const second = await log.append("page.ended", "k1", { file: "/a.html", by: "user" });

    const lines = await readLog(file);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]), ["ts", "source", "type", "subject", "data"]);
    assert.equal(lines[0].source, "review-surface");
    assert.equal(lines[1].data.by, "user");
    const raw = await readFile(file);
    assert.equal(second.cursor, raw.length);
    assert.equal(raw.subarray(0, first.cursor).toString().split("\n").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subscribe replays past a cursor, then delivers live, with no gap and no duplicate", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "events.jsonl");
    const writer = new EventLog(file);
    const a = await writer.append("page.opened", "k1");
    await writer.append("page.version", "k1");
    await writer.append("page.agent_reply", "k1");

    // A second instance stands in for a restarted server: its size comes from the file.
    const log = new EventLog(file);
    const seen = [];
    const unsubscribe = await log.subscribe((event, cursor) => seen.push({ type: event.type, cursor }), {
      after: a.cursor,
    });
    const live = await log.append("page.ended", "k1");
    unsubscribe();
    await log.append("page.opened", "k2");

    assert.deepEqual(
      seen.map((s) => s.type),
      ["page.version", "page.agent_reply", "page.ended"],
    );
    assert.equal(seen.at(-1).cursor, live.cursor);
    assert.ok(seen.every((s, i) => i === 0 || s.cursor > seen[i - 1].cursor));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subscribe without a cursor is live only; a cursor past the end replays everything", async () => {
  const dir = await tempDir();
  try {
    const log = new EventLog(path.join(dir, "events.jsonl"));
    await log.append("page.opened", "k1");

    const liveOnly = [];
    await log.subscribe((event) => liveOnly.push(event.type));
    const replaced = [];
    await log.subscribe((event) => replaced.push(event.type), { after: 10_000_000 });
    await log.append("page.ended", "k1");

    assert.deepEqual(liveOnly, ["page.ended"]);
    assert.deepEqual(replaced, ["page.opened", "page.ended"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn trailing line is skipped on replay", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "events.jsonl");
    await new EventLog(file).append("page.opened", "k1");
    await writeFile(file, `${await readFile(file, "utf8")}{"ts":"2026-`, { flag: "w" });
    const seen = [];
    await new EventLog(file).subscribe((event) => seen.push(event.type), { after: 0 });
    assert.deepEqual(seen, ["page.opened"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unwritable log never throws into the caller", async () => {
  const dir = await tempDir();
  try {
    const blocker = path.join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const log = new EventLog(path.join(blocker, "events.jsonl"));
    assert.equal(await log.append("page.opened", "k1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server logs opens, versions, feedback, replies and ends, and pushes them over /api/events", async () => {
  const dir = await tempDir();
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");
  const stateFile = path.join(dir, "state.json");
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const foreign = await fetch(`${base}/api/events`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);

    const live = await fetch(`${base}/api/events`);
    assert.equal(live.headers.get("content-type"), "text/event-stream");
    const liveFrames = readFrames(live, 5);

    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((r) => r.json());
    const key = created.key;

    // A new page version: the watcher debounces the save into one reload.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(artifact, "<!doctype html><html><body><h1>Hi again</h1></body></html>");
    // Let the debounced save land: ending the page closes its watcher, which drops a save
    // still inside the debounce window.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ uid: "1", prompt: "warmer", selector: "h1", tag: "h1", text: "Hi" }] }),
    });
    assert.equal(queued.status, 200);
    await fetch(`${base}/api/${key}/agent-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "done" }),
    });
    await fetch(`${base}/api/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });

    const pushed = await liveFrames;
    const types = pushed.map((f) => f.event.type);
    assert.deepEqual([...types].sort(), [
      "page.agent_reply",
      "page.ended",
      "page.feedback_sent",
      "page.opened",
      "page.version",
    ]);
    assert.equal(types[0], "page.opened");
    // Delivery order is file order, whatever order the writes finished in.
    assert.ok(pushed.every((f, i) => i === 0 || f.id > pushed[i - 1].id));
    const byType = Object.fromEntries(pushed.map((f) => [f.event.type, f.event]));
    assert.equal(byType["page.opened"].subject, key);
    assert.deepEqual(byType["page.opened"].data, { file: created.file, via: "cli", new: true });
    assert.deepEqual(byType["page.feedback_sent"].data, { file: created.file, prompts: 1 });
    assert.deepEqual(byType["page.agent_reply"].data, { file: created.file, chars: 4 });
    assert.deepEqual(byType["page.ended"].data, { file: created.file, by: "agent" });
    // Metadata only: nobody's words reach the log.
    assert.doesNotMatch(await readFile(path.join(dir, "events.jsonl"), "utf8"), /warmer|"done"/);

    // Resume: a reconnecting subscriber that saw the first event gets exactly the rest, from disk.
    const resumed = await fetch(`${base}/api/events`, { headers: { "last-event-id": String(pushed[0].id) } });
    const replay = await readFrames(resumed, 4);
    assert.deepEqual(
      replay.map((f) => f.id),
      pushed.slice(1).map((f) => f.id),
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a link open and a browser send-and-end are logged with who did it", async () => {
  const dir = await tempDir();
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const opened = await fetch(`${base}/open?file=${encodeURIComponent(artifact)}`, { redirect: "manual" });
    assert.equal(opened.status, 302);
    const key = opened.headers.get("location").split("/").pop();
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ endSession: true, prompts: [{ uid: "1", prompt: "ship it", selector: "h1", tag: "h1" }] }),
    });

    const frames = await readFrames(await fetch(`${base}/api/events?after=0`), 3);
    assert.deepEqual(
      frames.map((f) => [f.event.type, f.event.data.via ?? f.event.data.by ?? f.event.data.prompts]),
      [
        ["page.opened", "link"],
        ["page.feedback_sent", 1],
        ["page.ended", "user"],
      ],
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subscriber outlives the last page ending, and an ended page stops reporting versions", async () => {
  const dir = await tempDir();
  const first = path.join(dir, "first.html");
  const second = path.join(dir, "second.html");
  for (const file of [first, second]) await writeFile(file, "<!doctype html><html><body>x</body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route, body) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const live = await fetch(`${base}/api/events`);
    const frames = readFrames(live, 3);
    await post("/api/sessions", { file: first });
    await post("/api/end", { file: first });
    // Nothing is attached now but the subscriber. The server stays up, and the ended page's
    // file watcher is closed, so this save is not a new version of anything under review.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(first, "<!doctype html><html><body>edited after end</body></html>");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await post("/api/sessions", { file: second });

    assert.deepEqual(
      (await frames).map((f) => [f.event.type, path.basename(f.event.data.file)]),
      [
        ["page.opened", "first.html"],
        ["page.ended", "first.html"],
        ["page.opened", "second.html"],
      ],
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

async function storeWithSession(dir) {
  const stateFile = path.join(dir, "state.json");
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<h1>Hello</h1>");
  const store = new SessionStore(stateFile);
  const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
  return { store, session, journalFile: path.join(dir, "feedback-journal.jsonl") };
}

function prompt(uid, text) {
  return { uid, prompt: text, selector: "h1", tag: "h1", text: "Hello" };
}

test("accepted prompt batches are journaled before delivery and survive takeFeedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-journal-"));
  try {
    const { store, session, journalFile } = await storeWithSession(dir);
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [prompt("1", "Make this warmer")],
    });

    // Durable at accept time: journaled even though no poll has run yet.
    const beforeDelivery = (await readFile(journalFile, "utf8")).trim().split("\n");
    assert.equal(beforeDelivery.length, 1);
    const record = JSON.parse(beforeDelivery[0]);
    assert.equal(record.key, session.key);
    assert.equal(record.dom_snapshot, 'uid=1 h1 "Hello"');
    assert.equal(record.prompts.length, 1);
    assert.equal(record.prompts[0].prompt, "Make this warmer");

    // Delivery consumes the pending queue but never the journal.
    const delivered = await store.takeFeedback(session.key);
    assert.equal(delivered.status, "feedback");
    const afterDelivery = (await readFile(journalFile, "utf8")).trim().split("\n");
    assert.equal(afterDelivery.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFeedbackJournal filters by session and honors limit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-journal-"));
  try {
    const { store, session } = await storeWithSession(dir);
    const other = path.join(dir, "other.html");
    await writeFile(other, "<h1>Other</h1>");
    const otherSession = await store.upsertSession(other, "http://localhost:4387/session/other");

    for (const [i, text] of ["first", "second", "third"].entries()) {
      await store.queuePrompts(session.key, { prompts: [prompt(String(i), text)] });
    }
    await store.queuePrompts(otherSession.key, { prompts: [prompt("x", "not ours")] });

    const all = await store.readFeedbackJournal(session.key);
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.map((b) => b.prompts[0].prompt),
      ["first", "second", "third"],
    );

    const last = await store.readFeedbackJournal(session.key, { limit: 1 });
    assert.equal(last.length, 1);
    assert.equal(last[0].prompts[0].prompt, "third");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore replays are not journaled twice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-journal-"));
  try {
    const { store, session, journalFile } = await storeWithSession(dir);
    await store.queuePrompts(session.key, { prompts: [prompt("1", "only once")] });
    const delivered = await store.takeFeedback(session.key);
    assert.equal(delivered.status, "feedback");

    // The server's disconnected-poll path re-queues the delivered batch verbatim.
    await store.queuePrompts(session.key, { prompts: delivered.prompts }, { restore: true });

    const lines = (await readFile(journalFile, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn or corrupt trailing journal line is skipped, earlier batches still read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-journal-"));
  try {
    const { store, session, journalFile } = await storeWithSession(dir);
    await store.queuePrompts(session.key, { prompts: [prompt("1", "kept")] });
    const intact = await readFile(journalFile, "utf8");
    await writeFile(journalFile, intact + '{"key":"' + session.key + '","prompts":[{"pro');

    const batches = await store.readFeedbackJournal(session.key);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].prompts[0].prompt, "kept");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing journal file reads as empty history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-surface-journal-"));
  try {
    const { store, session } = await storeWithSession(dir);
    assert.deepEqual(await store.readFeedbackJournal(session.key), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.REVIEW_SURFACE_TELEMETRY = "0";
process.env.REVIEW_SURFACE_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";

async function served() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "rs-conversations-")));
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

// Round 3 (2026-11-03). The driver: "it doesn't need to be a page. It would be a message right?
// So footer ui." An agent's quick question is a message in a thread on the page it is about.
test("an agent message starts a thread on a page, unread in its footer, and the answer reaches the agent's poll", async () => {
  const { dir, server, base, post, page } = await served();
  try {
    const review = await page("review.html");
    const reviewKey = (await (await post("/api/sessions", { file: review })).json()).key;

    const started = await post("/api/conversations", {
      page: review,
      title: "Which store for messages?",
      text: "Files or SQLite for the conversation store?",
    });
    assert.equal(started.status, 200);
    const thread = await started.json();
    assert.match(thread.file, /conversations/);
    assert.equal(thread.url, `/session/${thread.key}`);

    const { threads } = await (await fetch(`${base}/api/${reviewKey}/threads`)).json();
    assert.equal(threads.length, 1);
    assert.equal(threads[0].key, thread.key);
    assert.equal(threads[0].title, "Which store for messages?");
    assert.equal(threads[0].agent_replies, 1, "the question counts as unread in the footer");
    assert.equal(threads[0].state, "needs-you");

    const conversation = await (await fetch(`${base}/api/${thread.key}/conversation`)).json();
    assert.deepEqual(
      conversation.chat.map((entry) => [entry.role, entry.text]),
      [["agent", "Files or SQLite for the conversation store?"]],
    );
    assert.equal(conversation.title, "Which store for messages?");

    // A second message from the agent goes into the same thread.
    await post("/api/conversations", { thread: thread.key, text: "Leaning files." });
    const again = await (await fetch(`${base}/api/${thread.key}/conversation`)).json();
    assert.equal(again.chat.length, 2);

    // The driver answers from the footer, asking for a quick reply.
    const answered = await post(
      `/api/${thread.key}/prompts`,
      { prompts: [{ prompt: "Files.", tag: "message", text: "Freeform message", speed: "quick" }] },
      { origin: base },
    );
    assert.equal(answered.status, 200);
    const poll = await (await fetch(`${base}/api/poll?file=${encodeURIComponent(thread.file)}&timeoutMs=0`)).json();
    assert.deepEqual(
      poll.prompts.map((prompt) => [prompt.prompt, prompt.speed]),
      [["Files.", "quick"]],
    );

    const crossOrigin = { headers: { origin: "http://evil.test" } };
    assert.equal((await fetch(`${base}/api/${thread.key}/conversation`, crossOrigin)).status, 403);
    assert.equal(
      (await post("/api/conversations", { page: review, text: "x" }, { origin: "http://evil.test" })).status,
      403,
    );
    assert.equal((await post("/api/conversations", { page: review, text: "" })).status, 400);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Round 8 (2026-11-05). The driver: "I'd like to see thinking here as well, this should honestly be
// how all of the chats work" - and Enter in the page's own chat is a direct chat, not a page round.
test("an agent's thinking shows in the conversation but is not a reply, and a direct chat is marked as one", async () => {
  const { dir, server, base, post, page } = await served();
  try {
    const review = await page("review.html");
    const key = (await (await post("/api/sessions", { file: review })).json()).key;

    assert.equal((await post(`/api/${key}/agent-thinking`, { text: "Reading the store tests first." })).status, 200);
    let conversation = await (await fetch(`${base}/api/${key}/conversation`)).json();
    assert.deepEqual(
      conversation.chat.map((entry) => [entry.role, entry.text]),
      [["thinking", "Reading the store tests first."]],
    );
    assert.equal(conversation.state, "new", "thinking is not the agent's turn ending");
    assert.equal((await post(`/api/${key}/agent-thinking`, { text: "" })).status, 400);

    const chatted = await post(
      `/api/${key}/prompts`,
      { prompts: [{ prompt: "Why two locks?", tag: "message", text: "Freeform message", channel: "chat" }] },
      { origin: base },
    );
    assert.equal(chatted.status, 200);
    const poll = await (await fetch(`${base}/api/poll?file=${encodeURIComponent(review)}&timeoutMs=0`)).json();
    assert.deepEqual(
      poll.prompts.map((prompt) => [prompt.prompt, prompt.channel]),
      [["Why two locks?", "chat"]],
    );

    await post(`/api/${key}/agent-reply`, { text: "One guards state.json." });
    conversation = await (await fetch(`${base}/api/${key}/conversation`)).json();
    assert.equal(conversation.state, "needs-you");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

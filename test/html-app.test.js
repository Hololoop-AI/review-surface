import assert from "node:assert/strict";
import test from "node:test";

import { createHtmlAppPayload, htmlAppApiUrl, publishToHtmlApp } from "../src/html-app.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchImpl, calls };
}

test("publishToHtmlApp is retired: throws before any network call", async () => {
  await assert.rejects(
    () => publishToHtmlApp("<html></html>", {}),
    /remote share disabled/,
  );
});

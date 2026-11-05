import assert from "node:assert/strict";
import test from "node:test";

import { summarizeActivity } from "../src/notifications.js";

const event = (type, subject, ts, data = {}) => ({ type, subject, ts, data, source: "review-surface" });

test("one row per page, its latest news, newest first; reopens, threads and this page left out", () => {
  const rows = summarizeActivity(
    [
      event("page.opened", "a", "2026-11-03T01:00:00Z", { new: true }),
      event("page.opened", "b", "2026-11-03T01:30:00Z", { new: false }),
      event("page.version", "a", "2026-11-03T02:00:00Z"),
      event("page.agent_reply", "t", "2026-11-03T02:30:00Z"),
      event("page.feedback_sent", "a", "2026-11-03T03:00:00Z"),
      event("page.version", "here", "2026-11-03T03:30:00Z"),
      event("page.agent_reply", "c", "2026-11-03T04:00:00Z"),
    ],
    { exclude: "here", threadKeys: new Set(["t"]) },
  );
  assert.deepEqual(
    rows.map((row) => [row.key, row.label]),
    [
      ["c", "Agent replied"],
      ["a", "New version"],
    ],
  );
});

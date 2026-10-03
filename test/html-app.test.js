import assert from "node:assert/strict";
import test from "node:test";

import { publishToHtmlApp } from "../src/html-app.js";

test("publishToHtmlApp is retired: throws before any network call", async () => {
  await assert.rejects(() => publishToHtmlApp("<html></html>", {}), /remote share disabled/);
});

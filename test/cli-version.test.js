import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isVersionOnlyArgv, VERSION } from "../src/cli.js";

test("isVersionOnlyArgv matches exactly the SDK's version-flag shapes", () => {
  for (const flag of ["--version", "-v", "-V"]) {
    assert.equal(isVersionOnlyArgv([flag]), true);
  }
  for (const argv of [[], ["--help"], ["open"], ["--version", "extra"], ["open", "--version"]]) {
    assert.equal(isVersionOnlyArgv(argv), false);
  }
});

test("--version prints the version and exits zero", async () => {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "review-surface.js");
  const { stdout } = await promisify(execFile)(process.execPath, [bin, "--version"]);
  assert.match(stdout, /\d+\.\d+\.\d+/);
  assert.equal(stdout.trim(), VERSION);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// An ended session stays readable: links from other pages land on ended sessions, so the page
// loads and the ended notice is a strip under the bar rather than a cover over the artifact.
const runBrowserE2e = process.env.REVIEW_SURFACE_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Prior round</title></head>
<body style="margin:0;padding:24px;font-family:Georgia,serif"><h1>Round one</h1><p>What the agent wrote last time.</p></body></html>`;

const GEOMETRY = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const frame = document.getElementById("artifact");
  const strip = document.getElementById("endedOverlay");
  const f = rect(frame);
  const hit = document.elementFromPoint((f.left + f.right) / 2, (f.top + f.bottom) / 2);
  return JSON.stringify({
    ended: !strip.hidden,
    src: frame.getAttribute("src") || "",
    bar: rect(document.querySelector(".bar")),
    strip: rect(strip),
    frame: f,
    hitIsFrame: hit === frame,
    hit: hit ? (hit.id || hit.className || hit.tagName) : null,
  });
}`;

test(
  "an ended page loads its artifact under a slim read-only strip",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "review-surface-ended-page-"));
    const port = await freePort();
    const reviewSurfaceEnv = {
      REVIEW_SURFACE_PORT: String(port),
      REVIEW_SURFACE_STATE_DIR: path.join(temp, "state"),
      REVIEW_SURFACE_NO_OPEN: "1",
      REVIEW_SURFACE_TELEMETRY: "0",
      REVIEW_SURFACE_HOST: "127.0.0.1",
      REVIEW_SURFACE_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `review-surface-ended-page-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/review-surface.js", artifact, "--no-open"], reviewSurfaceEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      run(process.execPath, ["bin/review-surface.js", "end", artifact], reviewSurfaceEnv);

      run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      run("chrome-devtools-axi", ["wait", "4000"], chromeEnv, 50_000);
      const g = evaluate(GEOMETRY);

      assert.equal(g.ended, true, "the read-only notice is shown");
      assert.match(g.src, /artifact_load_token=/, "the artifact was loaded");
      assert.ok(g.strip.top >= g.bar.bottom, `the strip sits under the bar: ${JSON.stringify(g)}`);
      assert.ok(g.strip.height < g.frame.height / 4, `the notice is a strip, not a cover: ${JSON.stringify(g)}`);
      assert.equal(g.hitIsFrame, true, `the artifact is uncovered and clickable: ${JSON.stringify(g)}`);
    } finally {
      run(process.execPath, ["bin/review-surface.js", "stop", "--port", String(port)], reviewSurfaceEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

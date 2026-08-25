import assert from "node:assert/strict";
import test from "node:test";

import {
  bindHost,
  clientHost,
  extraAllowedHosts,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  LOOPBACK_HOST,
  linkHost,
} from "../src/paths.js";

test("bindHost defaults to loopback and honors REVIEW_SURFACE_HOST", () => {
  assert.equal(bindHost({}), LOOPBACK_HOST);
  assert.equal(bindHost({ REVIEW_SURFACE_HOST: "" }), LOOPBACK_HOST);
  assert.equal(bindHost({ REVIEW_SURFACE_HOST: "  " }), LOOPBACK_HOST);
  assert.equal(bindHost({ REVIEW_SURFACE_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(bindHost({ REVIEW_SURFACE_HOST: " 0.0.0.0 " }), "0.0.0.0");
});

test("clientHost dials the bind host but falls back to the matching-family loopback for wildcard binds", () => {
  assert.equal(clientHost({}), LOOPBACK_HOST);
  assert.equal(clientHost({ REVIEW_SURFACE_HOST: "100.64.0.1" }), "100.64.0.1");
  assert.equal(clientHost({ REVIEW_SURFACE_HOST: "0.0.0.0" }), LOOPBACK_HOST);
  assert.equal(clientHost({ REVIEW_SURFACE_HOST: "::" }), IPV6_LOOPBACK_HOST);
});

test("extraAllowedHosts parses the whitespace-separated opt-in list", () => {
  assert.deepEqual(extraAllowedHosts({}), []);
  assert.deepEqual(extraAllowedHosts({ REVIEW_SURFACE_ALLOWED_HOSTS: "" }), []);
  assert.deepEqual(extraAllowedHosts({ REVIEW_SURFACE_ALLOWED_HOSTS: "  " }), []);
  assert.deepEqual(extraAllowedHosts({ REVIEW_SURFACE_ALLOWED_HOSTS: "proxy.example" }), ["proxy.example"]);
  assert.deepEqual(extraAllowedHosts({ REVIEW_SURFACE_ALLOWED_HOSTS: "  a.example   b.example\tc.example  " }), [
    "a.example",
    "b.example",
    "c.example",
  ]);
  assert.deepEqual(extraAllowedHosts({ REVIEW_SURFACE_ALLOWED_HOSTS: "*" }), ["*"]);
});

test("linkHost prefers REVIEW_SURFACE_LINK_HOST, then falls back to the dial host", () => {
  assert.equal(linkHost({}), LOOPBACK_HOST);
  assert.equal(linkHost({ REVIEW_SURFACE_LINK_HOST: "host.example" }), "host.example");
  assert.equal(linkHost({ REVIEW_SURFACE_LINK_HOST: "  " }), LOOPBACK_HOST);
  // Non-wildcard bind with no explicit link host -> links reuse the bind address.
  assert.equal(linkHost({ REVIEW_SURFACE_HOST: "100.64.0.1" }), "100.64.0.1");
  // Wildcard bind with an explicit link host -> links use the hostname, not 0.0.0.0.
  assert.equal(linkHost({ REVIEW_SURFACE_HOST: "0.0.0.0", REVIEW_SURFACE_LINK_HOST: "host.example" }), "host.example");
  // IPv6 wildcard bind with no explicit link host -> links fall back to the IPv6 loopback.
  assert.equal(linkHost({ REVIEW_SURFACE_HOST: "::" }), IPV6_LOOPBACK_HOST);
});

test("hostForUrl brackets IPv6 literals but leaves IPv4 and hostnames alone", () => {
  assert.equal(hostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(hostForUrl("host.example"), "host.example");
  assert.equal(hostForUrl("::1"), "[::1]");
  assert.equal(hostForUrl("[::1]"), "[::1]");
});

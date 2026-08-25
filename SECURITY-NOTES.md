# Security posture

This project began as a hardened import of [lavish-axi](https://github.com/kunchenguid/lavish-axi)
(MIT). Divergences made deliberately, and kept:

- **No telemetry.** The resolver returns disabled unconditionally — there is
  no beacon, no opt-out to remember, nothing to audit.
- **No remote publishing.** Artifacts never leave the machine: the share
  endpoint answers `410` to every caller and the publish path rejects before
  any network call. Serve artifacts from a host you control.
- **State is private by default.** The state file and directory are created
  `0600`/`0700` — review feedback and DOM snapshots are driver data.
- **Destructive and state-revealing GETs are origin-guarded.** `/api/poll`
  (feedback take) and `/api/:key/export` reject requests carrying a foreign
  Origin/Referer; header-less CLI callers pass and remain gated by the Host
  allowlist and DNS-rebinding defense inherited from upstream.

Known-open, tracked:
- The bundled Excalidraw whiteboard retains its stock "publish shape library"
  UI reachable through deliberate steps this app doesn't surface (planned:
  disable via UIOptions).
- Generated artifacts pin CDN scripts without SRI hashes.

# review-surface

An artifact-first review surface for AI agents. Instead of reading an agent's
work as chat scroll or PR comments, the agent writes a rich, self-contained
HTML artifact — reports, diagrams, decision cards — and you review it in
place: annotate any element, edit whiteboards, answer structured decision
inputs. Your feedback flows back to the agent as consumable events.

Local-only by design: no telemetry, no remote publishing, artifacts served
from your own machine (see SECURITY-NOTES.md).

## Install (GitHub, no registry)

```
npm install -g github:Hololoop-AI/review-surface
review-surface path/to/artifact.html
```

`dist/` ships in the repo, so installs need no build toolchain. If your npm
config sets `install-links=false`, add `--install-links` so npm copies the
package instead of symlinking a temporary clone.

## Provenance

Imported from [lavish-axi](https://github.com/kunchenguid/lavish-axi) by
Kun Chen (MIT) at 0.1.56 and diverging deliberately — this project is being
rebuilt around a different end state: the primary interface between a driver
and a fleet of pipeline agents, with feedback as events on a shared board.
Upstream's license and notices are preserved (LICENSE, THIRD-PARTY-NOTICES.md).

Working name — expect a rename.

## Theme

A host app can restyle the page controls and the annotation card by writing
`theme.css` in the state directory (`REVIEW_SURFACE_STATE_DIR`, default
`~/.review-surface`). It is read on every page load, so no restart is needed,
and it should override custom properties under `:root, :host` (the chrome's
are the token block at the top of `src/chrome.css`). With no file, the
built-in look is used; an unreadable file is reported on stderr and the
built-in look is served.

The tab icon follows the theme too: when `theme.css` is present and the
artifact sets no icon of its own, the page draws the Hololoop mark in the
theme's `--accent` and redraws it when the theme changes. With no `theme.css`,
the built-in amber icon stays.

## Framing hosts

A host app that frames a review page (allowed by `--frame-ancestor`) and owns
notifications can put its bell in the page's bar, in the slot the page's own
bell used to have. It is a `postMessage` handshake, and nothing changes unless
the host answers:

- The page posts `{type: "review-surface:barHello"}` to `window.parent` when
  it loads.
- The host answers `{type: "review-surface-host:carryBell"}`, and the page
  shows the bell button before the pen. A `bellState` sent before this is
  ignored.
- The host sends `{type: "review-surface-host:bellState", count, problem,
open, label}` whenever its bell changes: `count` is the unread count (an
  integer, 0 for none), `problem` and `open` are booleans (a failed run; the
  host's panel is open), and `label` is the button's accessible name, which
  defaults to "Notifications". `problem` colours the bell only while `count`
  is above 0.
- A click on the bell posts `{type: "review-surface:bellClick", rect}`, the
  button's box (`top`, `right`, `bottom`, `left`) in the page's coordinates,
  so the host can open its own panel under it. Escape in the page while the
  panel is open posts `{type: "review-surface:bellClose"}`.

The page hears only the window that frames it and stores none of it; the panel
and what it lists stay the host's. A page opened on its own, a thread window
and a host that never answers show no bell.

## Images

An image drawn larger than about 200px shows an expand button in its top-right
corner when you point at it. The button opens the image full size over the
page; Esc or a click closes it. A click on the image itself still annotates it.

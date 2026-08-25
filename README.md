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

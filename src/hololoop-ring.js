// The Hololoop ring as a loading indicator: the brand mark's two rings, with an arc turning on the
// outer one and the inner one breathing. It carries its own <style>, so it works the same inline,
// as an <img>, or saved as a file in another Hololoop app. Color comes from
// --hololoop-ring-color (neon amber when unset); size comes from the element's width and height.
// With reduced motion the arc stops and only the inner ring breathes, slowly.
export const HOLOLOOP_RING_SVG = `<svg class="hololoop-ring" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Loading">
<style>
.hololoop-ring circle{fill:none;stroke:var(--hololoop-ring-color,#f0a02a);stroke-width:2.8}
.hololoop-ring .hololoop-ring-track{stroke-opacity:.22}
.hololoop-ring .hololoop-ring-arc{stroke-linecap:round;stroke-dasharray:22 78;transform-origin:16px 16px;animation:hololoop-ring-turn 1.1s linear infinite}
.hololoop-ring .hololoop-ring-core{stroke-opacity:.55;transform-origin:16px 16px;animation:hololoop-ring-breathe 1.6s ease-in-out infinite}
@keyframes hololoop-ring-turn{to{transform:rotate(360deg)}}
@keyframes hololoop-ring-breathe{50%{stroke-opacity:.2;transform:scale(.86)}}
@media (prefers-reduced-motion:reduce){.hololoop-ring .hololoop-ring-arc{animation:none}.hololoop-ring .hololoop-ring-core{animation-duration:3.2s}}
</style>
<circle class="hololoop-ring-track" cx="16" cy="16" r="12.6"/>
<circle class="hololoop-ring-arc" cx="16" cy="16" r="12.6" pathLength="100"/>
<circle class="hololoop-ring-core" cx="16" cy="16" r="6"/>
</svg>`;

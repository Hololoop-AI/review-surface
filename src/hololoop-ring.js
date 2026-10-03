// The Hololoop mark as a loading indicator: three concentric amber rings stepping down in opacity,
// breathing in and out with each ring a beat behind the one outside it. Same structure and motion
// as the site's RingMark (hololoop-site/src/components/RingMark.astro), on a 2.4 s cycle instead of
// the mark's 6 s so it reads as working. It carries its own <style>, so it works the same inline,
// as an <img>, or saved as a file in another Hololoop app. Color comes from --hololoop-ring-color
// (neon amber when unset); size comes from the element's width and height. With reduced motion it
// holds still.
export const HOLOLOOP_RING_SVG = `<svg class="hololoop-ring" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" role="img" aria-label="Loading">
<style>
.hololoop-ring circle{fill:none;stroke:var(--hololoop-ring-color,#f0a02a);stroke-width:2.6;transform-origin:18px 18px;animation:hololoop-ring-breathe 2.4s ease-in-out infinite}
.hololoop-ring .hololoop-ring-mid{stroke-opacity:.6;animation-delay:.2s}
.hololoop-ring .hololoop-ring-inner{stroke-opacity:.35;animation-delay:.4s}
@keyframes hololoop-ring-breathe{50%{transform:scale(1.12)}}
@media (prefers-reduced-motion:reduce){.hololoop-ring circle{animation:none}}
</style>
<circle class="hololoop-ring-outer" cx="18" cy="18" r="12.6"/>
<circle class="hololoop-ring-mid" cx="18" cy="18" r="7.8"/>
<circle class="hololoop-ring-inner" cx="18" cy="18" r="3.4"/>
</svg>`;

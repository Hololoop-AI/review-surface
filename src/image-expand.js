// Image expand: which images get a full-size view, and where their expand button goes.
//
// Every helper here is serialized wholesale into the artifact SDK bundle by `createSdkJs`, so
// each one may reference only its own arguments, browser globals, or its sibling exports.

/**
 * Whether an image is drawn large enough to be worth a full-size view: over about 200px on
 * either side. Icons, avatars and inline badges stay as they are.
 * @param {{ width: number, height: number } | null | undefined} rect
 */
export function isExpandableImage(rect) {
  if (!rect) return false;
  return Math.max(Number(rect.width) || 0, Number(rect.height) || 0) >= 200;
}

/**
 * Where the expand button goes: inside the image's top-right corner, clamped so it stays on
 * screen when the image runs past the viewport's edge or is scrolled partly out of view.
 * @param {{ left: number, top: number, right: number, bottom: number }} rect
 * @param {{ width: number, height: number }} viewport
 */
export function expandButtonPosition(rect, viewport) {
  // Matches `.review-surface-image-expand` (32px square) in the SDK's shadow-root stylesheet.
  const size = 32;
  const inset = 8;
  const left = Math.min(rect.right, viewport.width) - size - inset;
  const top = Math.max(rect.top, 0) + inset;
  return {
    left: Math.max(inset, Math.min(left, viewport.width - size - inset)),
    top: Math.max(inset, Math.min(top, viewport.height - size - inset)),
  };
}

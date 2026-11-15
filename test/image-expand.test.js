import assert from "node:assert/strict";
import test from "node:test";

import { expandButtonPosition, isExpandableImage } from "../src/image-expand.js";

test("isExpandableImage offers expand only for images drawn larger than about 200px", () => {
  assert.equal(isExpandableImage({ width: 240, height: 160 }), true);
  assert.equal(isExpandableImage({ width: 120, height: 320 }), true);
  assert.equal(isExpandableImage({ width: 199, height: 199 }), false);
  assert.equal(isExpandableImage({ width: 0, height: 0 }), false);
  assert.equal(isExpandableImage(null), false);
});

test("expandButtonPosition sits in the image's top-right corner and stays on screen", () => {
  const viewport = { width: 1000, height: 800 };
  assert.deepEqual(expandButtonPosition({ left: 100, top: 50, right: 500, bottom: 350 }, viewport), {
    left: 460,
    top: 58,
  });
  // An image running off the right edge or scrolled above the top keeps its button visible.
  assert.deepEqual(expandButtonPosition({ left: 600, top: -200, right: 1400, bottom: 300 }, viewport), {
    left: 960,
    top: 8,
  });
});

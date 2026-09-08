// Window layout geometry, in ONE place.
//
// This used to be duplicated: main.js owns resizeActiveView(), and
// Client/test-panel.js carried its own re-implementation to check that the
// panel is revealed (not covered by the BrowserView) when it is open. The two
// had already drifted - the copy renamed TOP_HEIGHT to CHROME_HEIGHT and
// dropped the STATUS_HEIGHT subtraction entirely.
//
// The test asserts horizontal coverage, so the drift is latent today. It is
// still the failure mode worth removing: the test's notion of "the geometry"
// is not the shipped notion, so it can only be accidentally right, and it
// stays right only as long as nobody changes either side.
//
// Extracted as a PURE function so it is testable without Electron: it takes a
// content size and the panel state, and returns the BrowserView bounds. Both
// main.js and the test then call the same thing.

// Chrome heights. These must match the renderer's CSS - see the comments in
// renderer/style.css for the corresponding rules.
const TOP_HEIGHT = 110;  // group bar (38) + tab bar (36) + address bar (36)
const STATUS_HEIGHT = 22; // bottom status bar
const PANEL_WIDTH = 420;  // right-hand control panel

// Minimum width the BrowserView keeps when the panel is open. Never let the
// panel squeeze the page to nothing.
const MIN_VIEW_WIDTH = 200;

// The BrowserView bounds for a given content size and panel state.
//
//   contentW/contentH - the window's CONTENT size (getContentSize()), not the
//                       outer size; the two differ by the frame.
//   panelOpen         - whether the control panel is showing.
function viewBounds(contentW, contentH, panelOpen) {
  const w = Number(contentW) || 0;
  const h = Number(contentH) || 0;
  const viewWidth = panelOpen ? Math.max(MIN_VIEW_WIDTH, w - PANEL_WIDTH) : w;
  return {
    x: 0,
    y: TOP_HEIGHT,
    width: viewWidth,
    height: h - TOP_HEIGHT - STATUS_HEIGHT,
  };
}

module.exports = {
  TOP_HEIGHT,
  STATUS_HEIGHT,
  PANEL_WIDTH,
  MIN_VIEW_WIDTH,
  viewBounds,
};

# Phone Layout Design

**Status:** approved in chat, 2026-11-15 ("Yes, build it").

## Intent

People (and judges) will open the live site on their phones. Today it is
unusable there: cards pile on each other, tabs hide behind a "Panels"
button, buttons are 22–30 px, pinch does nothing, and placing a point needs
right-click + double-click, which iPhones don't have. Make it easy and
pleasant on a phone with every feature still there, plus a few phone extras.

## Goals

- Phone layout (narrow screens, or short landscape screens): full-screen 3D
  view, slim status at the top, one **bottom sheet** with five tabs:
  Plan, Drive, Walk, Map (layers, legend, full-width map), Info (spot
  readings, Ridgeback's limits and power facts, data and sources).
- Sheet has three heights (peek, half, full): drag it, or tap a tab (tapping
  the open tab folds it to peek). In landscape the sheet is a side panel.
- Touch: **press and hold** a spot on the ground or the map places the point
  and opens Walk / Drive / Remove at once; a tap on the placed point opens it
  too. Pinch zooms the 3D view and the map; drag looks around / pans.
- Thumb-sized controls (44 px), bigger drive pad above the sheet, pop-ups,
  warnings and dialogs sized for phones, clear of the notch and home bar.
- Extras: vibration on battery warnings, battery empty, getting stuck and
  danger warnings (where the phone allows); screen kept awake while driving;
  Add to Home Screen (manifest, icons, full-screen); lighter 3D (pixel ratio
  capped at 1.5 on phones); phone wording ("press and hold", "pinch").

## Non-goals / anti-goals

- No change to the desktop layout or behaviour.
- No offline/service-worker caching (stale copies would confuse the team's
  deploys).
- No feature removed on phones.

## Approaches

1. **Same page, phone mode (chosen).** A new `phone.js` moves the existing
   panels into a bottom sheet when the phone layout applies and puts them
   back when it doesn't; `phone.css` styles it. Every feature keeps its own
   code and listeners.
2. Separate mobile page: duplicates the app and drifts out of date. Rejected.
3. Pure CSS reflow: can't merge the left and right columns into one tabbed
   sheet or add sheet dragging. Rejected.

## Decisions

- Phone layout = `matchMedia("(max-width: 700px), (max-height: 520px)")`;
  `phone.js` sets `body.phone` (and `body.landscape` when wider than tall).
- Touch wording = `(pointer: coarse)` (or `?touch=1` for testing), applied
  inside `content.js` so every script gets it.
- New files: `phone.js`, `phone.css`, `manifest.webmanifest`, `icons/`.
  Edits: `index.html` (links, meta), `ui.js` (hold, tap, pinch, pixel ratio,
  one hint), `rover.js` (pinch camera, vibration), `content.js` (phone text).

## Left to the builder

Exact sheet heights, animation, colours (use the existing theme tokens).

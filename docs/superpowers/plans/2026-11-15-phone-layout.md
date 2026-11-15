# Phone Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app is easy to use on a phone (bottom sheet, press-and-hold, pinch, thumb-sized controls, phone extras) with the desktop unchanged.

**Architecture:** `phone.js` (new) moves existing panels into a five-tab bottom sheet while `body.phone` applies and restores them otherwise; `phone.css` (new) styles phone mode. Gestures live where the canvases are handled (`ui.js` map + ground, `rover.js` camera).

**Tech Stack:** Plain browser JS, three.js r128, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-15-phone-layout-design.md`

## Global Constraints

- Desktop (wider than 700 px and taller than 520 px) must look and behave exactly as before.
- All user-facing wording in `content.js`. Tap targets ≥ 44 px in phone mode.
- No force-push; fetch before committing; push `feature/terrain` and fast-forward `feature/frontend-ui`.

## Review Focus

- Resizing from phone to desktop and back puts every panel back in its place, with its "?" help pop.
- A walk/drive chosen from the popup opens the matching sheet tab (panels opened by other scripts via `.open = true`).
- A two-finger pinch never also places a point (hold timer cancelled by the second finger).
- Dragging the sheet does not also "click" a tab.
- Long-press on Android also fires `contextmenu`: the point must be placed once, not twice.

---

### Task 1: Phone shell (`phone.js`, `phone.css`, `index.html`)

- [ ] `phone.js`: `PHONE_QUERY = "(max-width: 700px), (max-height: 520px)"`; `apply()` toggles `body.phone`, `body.landscape`, builds `#sheet` (handle, tab bar, body) once, and moves: Plan `#route-panel`; Drive `#rb-card .button-row[data-help=rover]` + `#rover-panel`; Walk `#walk-panel`; Map `#layer-panel` + `#minimap`; Info `#info-panel` + `#rb-card .learn` + `#data-panel`. Each move leaves a comment placeholder and carries a following `.help-pop`.
- [ ] Sheet states `peek | half | full` on `#sheet[data-state]`; `--sheet-h` on `<body>` for the pad, popup and toasts. Drag on handle/tab bar snaps to the nearest state; a drag over 8 px cancels the tab click.
- [ ] Tabs: tapping a tab selects it (opening its `<details>`; Map closes all four); tapping the selected tab while open folds to peek. A `toggle` event opening one of the four panels selects its tab and opens the sheet to half.
- [ ] `phone.css`: slim status card, compact risk HUD, 60 px pad above the sheet, choice popup as a bottom card, 44 px buttons/selects, safe-area insets, landscape side panel.
- [ ] Verify at 390×844 and 844×390 in a frame; desktop at 1512 wide unchanged.

### Task 2: Gestures (`ui.js`, `rover.js`)

- [ ] `ui.js` ground + map: touch press held 500 ms without moving 10 px and with one finger → `selectAt(p)` then `openChoice(x, y)`; ignore the `contextmenu` that follows. Touch tap within the hit radius of the placed point → `openChoice`.
- [ ] `ui.js` map: two-finger pinch → `zoomAt(ratio, midX, midY)`; `#map` gets `touch-action: none` in phone CSS.
- [ ] `rover.js` camera: two pointers → pinch changes `cam.d` (chase, stopped), same clamps as the wheel; one-finger look is suspended during a pinch.
- [ ] `ui.js`: pixel ratio `min(dpr, 1.5)` when `(pointer: coarse)`, else `min(dpr, 2)`.

### Task 3: Extras and wording

- [ ] `rover.js` `buzz(pattern)`: battery warnings (20/10: `[200,100,200]`, 5: `[300,120,300,120,300]`), battery empty `[600,200,600]`, newly stuck `[400]`, new danger warning `[150]`.
- [ ] `phone.js`: Screen Wake Lock while `Ridgeback.isMoving()`, released after 20 s stopped; re-requested on `visibilitychange`.
- [ ] `manifest.webmanifest` + `icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png`; meta `theme-color`, `apple-mobile-web-app-capable`.
- [ ] `content.js`: `phone` block (tab names, manual hint) and touch wording applied in place when `(pointer: coarse)` or `?touch=1`; `ui.js` empty-Inspect hint follows it.

### Task 4: Verify, commit, push

- [ ] `node --test tests/` passes; Chrome frames at 390×844 / 844×390 with synthetic touch events: hold places point + popup, pinch zooms, sheet drags and tabs; console clean; desktop unchanged.
- [ ] Commit, fetch, push both branches.

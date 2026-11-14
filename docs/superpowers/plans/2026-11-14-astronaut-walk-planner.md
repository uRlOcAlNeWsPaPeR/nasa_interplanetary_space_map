# Astronaut Walk Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From wherever Ridgeback is parked, show where a suited astronaut can walk and get back within the EVA plan, plan a walking route to a clicked spot, and animate the walk.

**Architecture:** A pure planner (`walk-core.js`, runs in the browser and in Node for tests) does a round-trip shortest-time search over the 400 × 300 data grid. `walk.js` owns the Walk card, the map and 3D drawing, and the walk animation. Teammate files get small hooks only.

**Tech Stack:** Plain browser JS (no build step), three.js r128 already on the page, `node --test` (Node 20) for the planner tests.

**Spec:** `docs/superpowers/specs/2026-11-14-astronaut-walk-planner-design.md`

## Global Constraints

- Planned EVA 6 h; suit maximum 8 h; flat walking speed 2 km/h; steepest walkable ground 20°; mapped sand 30% slower (our estimate); slope slowdown = Tobler's hiking function scaled so grade 0 → 2 km/h.
- Yellow ("fits, but only just") = round trip + site time within the last hour of the 6 h plan.
- Time at the site: 0.5, 1 (default) or 2 h.
- All user-facing wording lives in `content.js` (team rule); `walk.js` reads it under `content.walk`.
- Say that the limits come from NASA's Artemis Moon suit plans, since NASA has no Mars suit specification yet.
- No new dependencies. No force-push. Pull before committing.

## Review Focus

- Ridgeback parked on ground steeper than 20°: the astronaut can still walk off it (the start cell is exempt).
- Clicking exactly where Ridgeback is: a zero-length walk that is reachable and doesn't crash.
- Clicking steep ground, or ground cut off by steep ground: a clear reason, not a silent nothing.
- Ridgeback driving or teleported (start site changed) while the range is shown or someone is walking: the range is hidden until it stops, and a walk in progress ends.
- The walk's animated timing matches the times shown in the card (out and back added up along the drawn path).

---

### Task 1: Planner core

**Files:**
- Create: `walk-core.js`
- Test: `tests/walk-core.test.js`

**Interfaces:**
- Produces `window.WalkCore` (and `module.exports` in Node):
  - `LIMITS = { planHours: 6, suitMaxHours: 8, flatKmh: 2, maxSlopeDeg: 20, sandSlowdown: 0.3, nearLimitHours: 1 }`
  - `maxGrade() -> number` (tan 20°)
  - `toblerFactor(grade) -> number` (1 at grade 0)
  - `walkKmh(grade, sand) -> number`
  - `createGrid({ w, h, cellWm, cellHm, elevation, slope, sand }) -> grid` (adds `blocked: Uint8Array`)
  - `plan(grid, sx, sy) -> { src, total, out, back, prev }` (Float64Array hours, Int32Array predecessors)
  - `routeTo(grid, res, x, y, siteHours) -> { reachable, reason: null|"steep"|"cutOff"|"tooFar", level: 0|1|2, path: [idx], distanceKm, outHours, backHours, walkHours, siteHours, totalHours, climbM, steepestDeg, sandShare }`
  - `cumulativeHours(grid, path) -> number[]` (hours from the first cell, along the path in its order)
  - `classify(walkHours, siteHours) -> 0|1|2` (0 out of reach, 1 easy, 2 only just)

- [ ] **Step 1: Write the failing tests** (`node:test`, synthetic grids, 100 m cells):
  - `toblerFactor(0) ≈ 1`, `toblerFactor(-0.05) > 1`, `toblerFactor(0.3) < toblerFactor(0.1)`
  - flat grid, 2 km straight walk: `outHours ≈ 1`, `backHours ≈ 1`, `distanceKm ≈ 2`
  - ramp (+10 m per cell east): walking east, `outHours > backHours`, `climbM ≈` rise
  - a column of slope 0.5: target beyond it → `reason "cutOff"`; target on it → `reason "steep"`
  - 6 km away with 1 h at the site → `"tooFar"`; `classify(4.5, 1) === 2`; `classify(3, 1) === 1`; `classify(6, 1) === 0`
  - sand = 1 everywhere: 2 km out takes `1 / 0.7` h
  - start cell steeper than 20°: neighbours still reachable; target = start → reachable, `distanceKm 0`
  - `cumulativeHours(grid, route.path)` last value ≈ `route.outHours`; reversed path ≈ `route.backHours`
- [ ] **Step 2: Run** `node --test tests/` → FAIL (module missing)
- [ ] **Step 3: Implement `walk-core.js`.** Edge a→b: `hours = distM / 1000 / walkKmh((elev[b] - elev[a]) / distM, (sand[a] + sand[b]) / 2)`. Dijkstra (binary heap, 8 neighbours) from the start on the symmetric round-trip cost `t(a→b) + t(b→a)`, accumulating `out` and `back` separately along the tree, so the drawn path, its out/back times and the shading all agree. Blocked cells (slope > tan 20° or non-finite elevation) can't be entered; the start is exempt.
- [ ] **Step 4: Run** `node --test tests/` → all pass
- [ ] **Step 5: Commit** `walk-core.js tests/walk-core.test.js`

### Task 2: Hooks in shared files

**Files:**
- Modify: `rover.js` (start section, `step()`, `syncControls()`)
- Modify: `ui.js` (`MapUI`, `render()`, provenance list)
- Modify: `data-layers.js` (`getSources`)

**Interfaces:**
- Produces `window.Ridgeback = { position() -> {nx, ny}|null, isMoving() -> bool, timeScale() -> mission seconds per real second, setLocked(bool) }`. While locked, `step()` keeps Ridgeback still (battery still updates), and the Start drive and mode buttons are disabled.
- Produces `MapUI.addGroundOverlay(draw(ctx, W, H))`, drawn before `world.updateGround`, so it shows on the minimap and the 3D ground.
- `MarsData.getSources()` also lists the NASA EVA sources and Tobler.

- [ ] **Step 1:** Add the three hooks and the provenance wording (computed: walking range and routes; simulated: the astronaut's walk, sped up, with Moon-suit limits).
- [ ] **Step 2: Verify** in the browser console: `Ridgeback.position()` returns the start site; `Ridgeback.setLocked(true)` disables Start drive; the Data & sources card lists the new sources.
- [ ] **Step 3: Commit** `rover.js ui.js data-layers.js`

### Task 3: Walk card, drawing and animation

**Files:**
- Create: `walk.js`
- Modify: `index.html` (Walk card under Navigation, `#walk-here` in the Inspect card, `#walker-2d` beside `#rover-2d`, CSS, script tags for `walk-core.js` and `walk.js` after `rover.js`)
- Modify: `content.js` (new `walk` section)

**Interfaces:**
- Consumes: `WalkCore`, `Ridgeback`, `MapUI.addGroundOverlay`, `MapUI.addOverlay`, `MapUI.on3dReady(api)` (`api.THREE`, `api.scene`, `api.surfacePoint(nx, ny, lift)`), `MapUI.getSelected()`, `MarsTerrain.grid(name)`, `MarsTerrain.gridSize`, `MarsData.getScale()`.

- [ ] **Step 1:** Build the card: Show walking range switch, Time at the site select, status line, legend, route stats, Start/Stop walk, Clear; Walk here in Inspect.
- [ ] **Step 2:** Range shading (green/yellow, about 35% opacity) as a ground overlay; dashed route on the minimap; thin tube on the 3D ground; recompute when Ridgeback stops somewhere new; hide while it moves.
- [ ] **Step 3:** Walk animation: astronaut figure (same visual scale as Ridgeback) and a 2D dot, timed with `cumulativeHours` and `Ridgeback.timeScale()`; out, at the site, back; suit-time countdown; lock Ridgeback while outside; end the walk if Ridgeback jumps.
- [ ] **Step 4: Verify** in the browser: range shows at the start site; Walk here on a nearby spot gives a route and stats; a far spot says too far; a steep spot says too steep; Start walk animates out and back and unlocks Ridgeback; driving hides the range; mobile layout; no console errors.
- [ ] **Step 5: Commit** `walk.js index.html content.js`, then pull, check for conflicts, push.

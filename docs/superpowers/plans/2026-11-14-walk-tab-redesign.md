# Walk Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a spot in the Walk tab → the safest walking route and its times appear → the walk starts only when the user presses Walk. Clicks follow the open tab.

**Architecture:** `walk-core.js` adds a risk-weighted cost (risky cells cost 5× to enter) while keeping real walking times along the chosen path. `ui.js` gains `MapUI.onSelect(cb)`; `rover.js` and `walk.js` act on clicks only when their tab is open. The Inspect jump and the two "…here" buttons go.

**Tech Stack:** Plain browser JS, three.js r128, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-14-walk-tab-redesign-design.md`

## Global Constraints

- Hard limit 20° (unchanged). Risky: slope over 15° (grade > tan 15°), sand share ≥ 0.5, within 2 grid cells (~150 m) of a mapped megabreccia point, or inside a highlighted hazard zone.
- Risk factor 5 on entering a risky cell. Range shading and verdicts use real walking hours (out + back), not the weighted cost.
- Wording in `content.js`. No force-push; fetch before committing.

## Review Focus

- Clicking while a walk is in progress must not change the walk.
- Clicking in Inspect must not set a destination or a walk.
- Turning a hazard highlight on or off re-plans the walk.
- A spot reachable only across risky ground still gets a route, and the card says what it crosses.
- Plan/Drive clicks keep the current tab (no jump to Plan or Inspect).

---

### Task 1: Risk-aware planner

**Files:** Modify `walk-core.js`; Test `tests/walk-core.test.js`

**Interfaces (produces):**
- `LIMITS.riskySlopeDeg = 15`, `LIMITS.sandRisk = 0.5`, `LIMITS.riskFactor = 5`
- `RISK = { STEEP: 1, SAND: 2, BOULDERS: 4, ZONE: 8 }`
- `createGrid({ ..., boulders?: Uint8Array })` adds `grid.risk: Uint8Array`
- `setZones(grid, mask: Uint8Array|null)` sets/clears `RISK.ZONE`
- `plan()` returns `{ src, cost, out, back, walk, prev }` (`walk = out + back`, hours)
- `routeTo()` adds `crosses: { steep, sand, boulders, zone }` (metres along the route) and `direct: { steep, sand, boulders, zone, tooSteep }` (booleans for the straight line)

- [ ] Tests: a 3-cell-wide band of 17° slope with a gap → route avoids it (`crosses.steep === 0`, `direct.steep === true`); same for sand, boulders and zones; a band with no gap → route crosses it (`crosses.steep > 0`, still reachable); existing tests still pass
- [ ] Run → fail; implement; run → pass; commit

### Task 2: Clicks follow the open tab

**Files:** Modify `ui.js` (`MapUI.onSelect`, drop `send-rover`), `rover.js` (click → destination when Plan or Drive is open; no tab change; drop the button), `index.html` (drop both buttons and the jump to Inspect), `content.js` (hints and help text)

- [ ] Implement; verify in the browser: Plan click → 3 routes, tab stays Plan; Drive click → routes, tab stays Drive; Inspect click → readings only

### Task 3: Walk tab flow

**Files:** Modify `walk.js`, `index.html` (no checkbox; `#walk-avoids`; time-at-site inside the fold), `content.js` (walk wording), `data-layers.js` (Apollo slope source)

- [ ] Range shows whenever the Walk tab is open; click → safest route, times, Avoids line, faint red straight line (map and 3D); Walk button starts; Stop walk ends
- [ ] Hazard highlight changes re-plan; boulder mask from `MarsData.getGeologyFeatures().megabreccia`
- [ ] Verify in the browser end to end, phone layout, console; commit; fetch; push both branches

# Walk tab redesign: design

Date: 2026-11-14. Status: waiting for approval.

## Why

The user found the walk pointless and the flow clumsy: you clicked a spot, went to Inspect, pressed Walk here, and the astronaut simply walked there. The walk should *help*: work out how long it takes and recommend the safest path, and only start when the user has seen the details and confirms. Each tab should handle its own clicks.

## What the user sees

1. **Open the Walk tab.** The walking range shows straight away around parked Ridgeback (no checkbox). If Ridgeback is driving: "Stop Ridgeback to plan a walk."
2. **Click a spot in the range** (minimap or 3D ground). The app plans the safest route there and back and shows:
   - a one-line verdict (safe walk, or tight);
   - time there, time back, time at the site, total against the 6-hour plan, suit time to spare, distance;
   - **Avoids:** what the straight line would have crossed (steep ground, mapped sand, boulder outcrops, highlighted hazard zones), with the straight line drawn faint red for comparison.
3. **Nothing moves until you press Walk.** Then the astronaut walks out, works at the site and walks back, with a countdown; Stop walk ends it.
4. Clicking outside the range says why (too far for a safe walk, too steep, cut off) and shows no Walk button.

## Safest path

- Never on ground over 20° (NASA suit limit, unchanged).
- Steers around risky ground when a way round fits in the 6-hour plan:
  - slopes of 15–20° (Apollo crews kept to slopes under 15°);
  - mapped sand;
  - the 28 megabreccia boulder outcrops mapped by USGS (SIM 3464) in the area;
  - hazard zones the user highlights under Map layers & hazards.
- If the only way crosses risky ground, the route still shows, and the details say what it crosses.
- Walking time is unchanged (NASA 2 km/h, Tobler's slope slowdown, sand 30% slower). The shaded range uses the time of the safe route, so a shaded spot always has a safe walk that fits.

## Clicks follow the open tab

- **Plan** and **Drive:** a click sets the destination and shows the three routes.
- **Walk:** a click plans the walk.
- **Inspect:** a click shows the readings, as now.
- Clicking no longer jumps to Inspect. The Plan routes here and Walk here buttons are removed.

## How it is built

- `walk-core.js` (mine): route cost = walking time × a risk factor for risky cells; out/back times are still the real walking times along the chosen path. New tests for each kind of risky ground.
- `walk.js` (mine): Walk tab flow, faint straight line, Avoids line, Walk/Stop.
- Teammate files (approved by the user for this task): `ui.js` (a click hook), `rover.js` (Plan/Drive click sets the destination; remove the button), `index.html` (remove the buttons, the range checkbox and the jump to Inspect), `content.js` (wording, help text).

### Approaches considered

1. **Risk-weighted cost in the existing planner (picked).** Small change, keeps the range, route and times consistent.
2. Plan the fastest route, then reject it if it touches risky ground. Simpler, but can't find a way round, so many spots would just say "no".

## Not in scope

Science targets; walk-home checks for driving; steering the astronaut by hand.

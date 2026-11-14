# Astronaut walk planner: design

Date: 2026-11-14. Status: approved and built.

## Why

The Space Apps brief is about planning a Marswalk for astronauts. Today the app is a rover sim. Ridgeback stays the crew's ride; this adds the part on foot: from wherever Ridgeback is parked, where can a suited astronaut safely walk and still get back in time, and what is the walking route to a chosen spot?

## What the user sees

1. Ridgeback is stopped (at the start site, or after a drive).
2. A new **Walk** card (right side, below Driving, so the drive controls stay where they were) has a **Show walking range** switch. When on, the minimap and the 3D ground shade the area around Ridgeback:
   - green: the round trip fits easily in the EVA plan;
   - yellow: it fits, but only just;
   - no shading: out of reach.
   Ground steeper than the suit limit is never inside the range.
3. Click a spot. The Inspect card gets a **Walk here** button next to **Plan routes here**. Pressing it draws a walking route (dashed on the map, a thin line on the 3D ground) and the Walk card shows:
   distance; time out; time back; time at the site; total against the 6-hour plan; steepest ground; climb; whether it crosses mapped sand.
   If the spot is out of reach, it says why: too far, or cut off by steep ground.
4. **Time at the site**: 30 min, 1 h (default) or 2 h. Changing it redraws the range.
5. **Start walk**: an astronaut figure walks out and back (sped up like the drive), with suit time counting down. Ridgeback can't drive while someone is outside.

## Numbers and sources

| What | Value | Source |
|---|---|---|
| Planned EVA length | 6 h | NASA, Exploration EVA lunar surface concept of operations summary (2020): "EVAs of up to 8 hours in duration (6±2 hours)" |
| Suit maximum | 8 h | same. The 2 h between the plan and the maximum is the safety reserve |
| Walking speed, flat ground | 2 km/h | same deck: unpressurized rover range "~10 km (~5 hr walk back)" |
| Steepest walkable ground | 20° | NASA EVA-EXP-0042 Rev B, xEVA System Concept of Operations: walking up/down/across slopes up to 20° (Apollo 15 walked on ~17°) |
| Slowdown on slopes | Tobler's hiking function, scaled so flat ground = 2 km/h | Tobler (1993). An Earth hiking model; labelled as an estimate |
| Mapped sand | walkable, 30% slower | our estimate, labelled as such |
| Mars context | ~15 km EVA walk-back distance | NASA DRA 5.0 (SP-2009-566) |

These are NASA's Artemis (Moon) suit planning figures. NASA has no Mars suit specification yet, so the app says that the limits come from the lunar suit.

## How it is built

- **New file `walk.js`** holds the planner, the Walk card logic, and the map and 3D drawing. Most new code stays out of teammates' files.
- **Planner:** shortest walking time over the data grid (400 × 300 points, about 75 m apart, 8 neighbours). Time out and time back are computed separately, since uphill and downhill differ. The 20° limit uses the Slope field; walking time uses the grade between neighbouring points.
- Small hooks in teammates' files (approved by the user on 2026-11-14):
  - `rover.js`: expose `window.Ridgeback` with the position, whether it is driving, and a lock while someone is outside.
  - `ui.js`: let an overlay paint the 3D ground as well as the minimap.
  - `index.html`: script tag, the Walk card, the Walk here button, a little CSS.
  - `content.js`: the Walk card text.
- `data-layers.js` (mine): add the NASA EVA sources so the Data & sources card lists them.

### Approaches considered

1. **`walk.js` with its own 75 m grid (picked).** Keeps changes to teammates' files small, and is fine enough for walks of a few km.
2. Build it into `rover.js` and reuse its route planner. Less code, but makes the busiest shared file bigger, and that planner's 250 m cells are too coarse for walking.
3. Playable astronaut steered in 3D. Rejected by the user in favour of the planner; the 3D world is too coarse at walking scale.

## Not in scope

Steering the astronaut by hand; oxygen or energy modelling; radiation or weather; walks with several stops; warnings when Ridgeback drives farther than the crew could walk back (a possible follow-up).

## Left to the builder

Colours and line styles (to match the existing map); how the astronaut figure looks (same visual scale as Ridgeback); exact wording of the card text.

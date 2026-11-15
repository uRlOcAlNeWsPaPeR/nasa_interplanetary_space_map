// Tests for walk-core.js (the astronaut walk planner). Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../walk-core.js");

const CELL = 100; // metres between grid points in these synthetic grids

function makeGrid(w, h, opts) {
  opts = opts || {};
  const n = w * h;
  const elevation = new Float32Array(n);
  const slope = new Float32Array(n);
  const sand = new Float32Array(n);
  const boulders = opts.boulders ? new Uint8Array(n) : undefined;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      elevation[i] = opts.elev ? opts.elev(x, y) : 0;
      slope[i] = opts.slope ? opts.slope(x, y) : 0;
      sand[i] = opts.sand ? opts.sand(x, y) : 0;
      if (boulders) boulders[i] = opts.boulders(x, y) ? 1 : 0;
    }
  }
  return core.createGrid({ w, h, cellWm: CELL, cellHm: CELL, elevation, slope, sand, boulders });
}

// A 3-cell-wide band down the middle (x = 14..16), open at the top (y < 4).
const band = (x, y) => x >= 14 && x <= 16 && y >= 4;
const RISKY_GRADE = Math.tan(17 * Math.PI / 180); // between the 15 and 20 degree limits

function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label || "value"}: expected ${expected} ± ${tol}, got ${actual}`);
}

test("limits match the design", () => {
  assert.equal(core.LIMITS.planHours, 6);
  assert.equal(core.LIMITS.suitMaxHours, 8);
  assert.equal(core.LIMITS.flatKmh, 2);
  assert.equal(core.LIMITS.maxSlopeDeg, 20);
  assert.equal(core.LIMITS.sandSlowdown, 0.3);
  near(core.maxGrade(), Math.tan(20 * Math.PI / 180), 1e-12, "maxGrade");
});

test("Tobler factor is 1 on flat ground, fastest slightly downhill, slower uphill", () => {
  near(core.toblerFactor(0), 1, 1e-12, "flat");
  assert.ok(core.toblerFactor(-0.05) > 1);
  assert.ok(core.toblerFactor(0.3) < core.toblerFactor(0.1));
  near(core.walkKmh(0, 0), 2, 1e-12, "flat speed");
});

test("flat ground: a 2 km walk takes 1 h each way", () => {
  const g = makeGrid(41, 5);
  const res = core.plan(g, 0, 2);
  const r = core.routeTo(g, res, 20, 2, 1);
  assert.equal(r.reachable, true);
  near(r.distanceKm, 2, 1e-9, "distance");
  near(r.outHours, 1, 1e-9, "out");
  near(r.backHours, 1, 1e-9, "back");
  near(r.totalHours, 3, 1e-9, "total with 1 h at the site");
  assert.equal(r.path[0], res.src);
  assert.equal(r.path[r.path.length - 1], 2 * 41 + 20);
});

test("uphill out is slower than downhill back, and climb is counted", () => {
  const g = makeGrid(21, 3, { elev: (x) => x * 10 });
  const res = core.plan(g, 0, 1);
  const r = core.routeTo(g, res, 20, 1, 1);
  assert.ok(r.outHours > r.backHours, `out ${r.outHours} should exceed back ${r.backHours}`);
  near(r.climbM, 200, 1e-6, "climb");
});

test("steep ground blocks walking and gives a reason", () => {
  const g = makeGrid(31, 9, { slope: (x) => (x === 10 ? 0.5 : 0) });
  const res = core.plan(g, 0, 4);
  const beyond = core.routeTo(g, res, 20, 4, 1);
  assert.equal(beyond.reachable, false);
  assert.equal(beyond.reason, "cutOff");
  assert.equal(beyond.level, 0);
  const onIt = core.routeTo(g, res, 10, 4, 1);
  assert.equal(onIt.reachable, false);
  assert.equal(onIt.reason, "steep");
});

test("too far for the 6 h plan, and the easy / only-just levels", () => {
  const g = makeGrid(61, 3);
  const res = core.plan(g, 0, 1);
  const far = core.routeTo(g, res, 60, 1, 1); // 6 km: 6 h walking + 1 h at the site
  assert.equal(far.reachable, false);
  assert.equal(far.reason, "tooFar");
  assert.equal(core.classify(4.5, 1), 2);
  assert.equal(core.classify(3, 1), 1);
  assert.equal(core.classify(6, 1), 0);
  assert.equal(core.classify(Infinity, 1), 0);
  assert.equal(core.routeTo(g, res, 30, 1, 1).level, 1); // 3 km: 3 h + 1 h
  assert.equal(core.routeTo(g, res, 45, 1, 1).level, 2); // 4.5 km: 4.5 h + 1 h
});

test("mapped sand slows walking by 30%", () => {
  const g = makeGrid(41, 3, { sand: () => 1 });
  const res = core.plan(g, 0, 1);
  const r = core.routeTo(g, res, 20, 1, 1);
  near(r.outHours, 1 / 0.7, 1e-9, "out on sand");
  near(r.sandShare, 1, 1e-12, "sand share");
});

test("Ridgeback parked on steep ground: the astronaut can still walk off it", () => {
  const g = makeGrid(11, 11, { slope: (x, y) => (x === 5 && y === 5 ? 0.5 : 0) });
  const res = core.plan(g, 5, 5);
  const r = core.routeTo(g, res, 8, 5, 1);
  assert.equal(r.reachable, true);
  const self = core.routeTo(g, res, 5, 5, 1);
  assert.equal(self.reachable, true);
  assert.equal(self.distanceKm, 0);
  assert.deepEqual(self.path, [res.src]);
});

test("targets off the grid are clamped to its edge", () => {
  const g = makeGrid(11, 11);
  const res = core.plan(g, 0, 0);
  const r = core.routeTo(g, res, 99, -5, 1);
  assert.equal(r.path[r.path.length - 1], 0 * 11 + 10);
});

test("cumulative hours along the path match the route's out and back times", () => {
  const g = makeGrid(25, 25, { elev: (x, y) => 5 * x + 3 * y, sand: (x) => (x > 12 ? 0.6 : 0) });
  const res = core.plan(g, 2, 3);
  const r = core.routeTo(g, res, 20, 18, 1);
  const out = core.cumulativeHours(g, r.path);
  const back = core.cumulativeHours(g, r.path.slice().reverse());
  assert.equal(out[0], 0);
  near(out[out.length - 1], r.outHours, 1e-9, "out");
  near(back[back.length - 1], r.backHours, 1e-9, "back");
});

test("risk limits match the design", () => {
  assert.equal(core.LIMITS.riskySlopeDeg, 15);
  assert.equal(core.LIMITS.sandRisk, 0.5);
  assert.equal(core.LIMITS.riskFactor, 5);
});

test("the plan reports real walking hours, not the risk-weighted cost", () => {
  const g = makeGrid(31, 21, { slope: (x, y) => (band(x, y) ? RISKY_GRADE : 0) });
  const res = core.plan(g, 5, 10);
  const r = core.routeTo(g, res, 25, 10, 1);
  near(res.walk[10 * 31 + 25], r.outHours + r.backHours, 1e-9, "walk = out + back");
  assert.ok(res.cost[10 * 31 + 25] >= res.walk[10 * 31 + 25] - 1e-9);
});

test("the safest route goes around 15-20 degree slopes when there is a way round", () => {
  const g = makeGrid(31, 21, { slope: (x, y) => (band(x, y) ? RISKY_GRADE : 0) });
  const res = core.plan(g, 5, 10);
  const r = core.routeTo(g, res, 25, 10, 1);
  assert.equal(r.reachable, true);
  assert.equal(r.crosses.steep, 0);
  assert.equal(r.direct.steep, true);
  assert.equal(r.direct.tooSteep, false);
  assert.ok(r.distanceKm > 2, "the way round is longer than the straight 2 km");
});

test("the safest route goes around mapped sand, boulders and hazard zones", () => {
  const sandy = makeGrid(31, 21, { sand: (x, y) => (band(x, y) ? 0.8 : 0) });
  let r = core.routeTo(sandy, core.plan(sandy, 5, 10), 25, 10, 1);
  assert.equal(r.crosses.sand, 0);
  assert.equal(r.direct.sand, true);

  const rocky = makeGrid(31, 21, { boulders: band });
  r = core.routeTo(rocky, core.plan(rocky, 5, 10), 25, 10, 1);
  assert.equal(r.crosses.boulders, 0);
  assert.equal(r.direct.boulders, true);

  const zoned = makeGrid(31, 21);
  const mask = new Uint8Array(31 * 21);
  for (let y = 0; y < 21; y++) for (let x = 0; x < 31; x++) if (band(x, y)) mask[y * 31 + x] = 1;
  core.setZones(zoned, mask);
  r = core.routeTo(zoned, core.plan(zoned, 5, 10), 25, 10, 1);
  assert.equal(r.crosses.zone, 0);
  assert.equal(r.direct.zone, true);
  core.setZones(zoned, null);
  r = core.routeTo(zoned, core.plan(zoned, 5, 10), 25, 10, 1);
  near(r.distanceKm, 2, 1e-9, "zones cleared: straight again");
});

test("with no way round, the route still crosses risky ground and says so", () => {
  const g = makeGrid(31, 21, { slope: (x) => (x >= 14 && x <= 16 ? RISKY_GRADE : 0) });
  const r = core.routeTo(g, core.plan(g, 5, 10), 25, 10, 1);
  assert.equal(r.reachable, true);
  near(r.crosses.steep, 300, 1e-6, "three 100 m cells of steep ground");
});

test("the straight line notices ground too steep to walk", () => {
  const g = makeGrid(31, 21, { slope: (x, y) => (band(x, y) ? 0.5 : 0) });
  const r = core.routeTo(g, core.plan(g, 5, 10), 25, 10, 1);
  assert.equal(r.reachable, true);
  assert.equal(r.direct.tooSteep, true);
});

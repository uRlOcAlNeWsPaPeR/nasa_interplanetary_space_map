/*
 * walk-core.js -- the astronaut walk planner's maths (no drawing, no DOM).
 *
 * From the point where Ridgeback is parked, finds the quickest there-and-back
 * walk to every point of the data grid, and the walking route to one point.
 * Runs in the browser (window.WalkCore) and in Node for the tests
 * (tests/walk-core.test.js).
 *
 * Limits (see docs/superpowers/specs/2026-11-14-astronaut-walk-planner-design.md):
 * - EVAs of up to 8 hours, planned at 6 (NASA, "6±2 hours"); the 2 hours
 *   between the plan and the suit maximum are the reserve.
 * - 2 km/h on flat ground (NASA plans ~5 hours to walk back ~10 km).
 * - No ground steeper than 20 degrees (NASA's suit walking limit).
 * - Slopes slow walking following Tobler's hiking function, scaled so flat
 *   ground is 2 km/h. Mapped sand is 30% slower: our estimate.
 * These are NASA's Artemis (Moon) suit planning figures; NASA has no Mars
 * suit specification yet.
 */
(function (root) {
  "use strict";

  var LIMITS = {
    planHours: 6,        // planned EVA length
    suitMaxHours: 8,     // what the suit supports; the rest is reserve
    flatKmh: 2,          // walking speed on flat ground
    maxSlopeDeg: 20,     // steepest ground a suited astronaut walks on
    sandSlowdown: 0.3,   // walking on mapped sand is up to 30% slower (our estimate)
    nearLimitHours: 1    // a walk within the plan's last hour "only just" fits
  };

  var TOBLER_FLAT = Math.exp(-3.5 * 0.05);

  function maxGrade() { return Math.tan(LIMITS.maxSlopeDeg * Math.PI / 180); }

  // Tobler's hiking function relative to flat ground (1 at grade 0). Grade is
  // rise over run along the direction of travel, so uphill and downhill differ.
  function toblerFactor(grade) { return Math.exp(-3.5 * Math.abs(grade + 0.05)) / TOBLER_FLAT; }

  function clamp01(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }

  function walkKmh(grade, sand) {
    return LIMITS.flatKmh * toblerFactor(grade) * (1 - LIMITS.sandSlowdown * clamp01(sand));
  }

  // grid: { w, h, cellWm, cellHm, elevation (m), slope (grade), sand (0-1) },
  // all fields row by row from the north-west corner.
  function createGrid(o) {
    var n = o.w * o.h;
    var blocked = new Uint8Array(n);
    var limit = maxGrade();
    for (var i = 0; i < n; i++) {
      var s = o.slope[i];
      if (!isFinite(o.elevation[i]) || !(s <= limit)) blocked[i] = 1;
    }
    return {
      w: o.w, h: o.h, cellWm: o.cellWm, cellHm: o.cellHm,
      elevation: o.elevation, slope: o.slope, sand: o.sand, blocked: blocked
    };
  }

  function stepMetres(g, a, b) {
    var dx = (b % g.w) - (a % g.w);
    var dy = Math.floor(b / g.w) - Math.floor(a / g.w);
    return Math.sqrt(dx * dx * g.cellWm * g.cellWm + dy * dy * g.cellHm * g.cellHm);
  }

  // Hours to walk from grid point a to its neighbour b.
  function edgeHours(g, a, b, distM) {
    var grade = (g.elevation[b] - g.elevation[a]) / distM;
    var sand = (g.sand[a] + g.sand[b]) / 2;
    return distM / 1000 / walkKmh(grade, sand);
  }

  // ---- binary heap of (key, index) ------------------------------------------

  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v;
    var topV = v[0], topK = k[0];
    var lastK = k.pop(), lastV = v.pop();
    var n = k.length;
    if (n) {
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        var mk = lastK;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lastK; v[i] = lastV;
    }
    this.topK = topK;
    return topV;
  };
  Heap.prototype.size = function () { return this.k.length; };

  // ---- planning -----------------------------------------------------------------

  var NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  // Quickest there-and-back walk from (sx, sy) to every grid point. The search
  // minimises out + back time over one path walked both ways, and keeps the
  // out and back times separately, so the shading, the drawn route and its
  // times all agree.
  function plan(g, sx, sy) {
    var w = g.w, h = g.h, n = w * h;
    sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
    sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
    var src = sy * w + sx;
    var total = new Float64Array(n).fill(Infinity);
    var out = new Float64Array(n).fill(Infinity);
    var back = new Float64Array(n).fill(Infinity);
    var prev = new Int32Array(n).fill(-1);
    var done = new Uint8Array(n);
    total[src] = out[src] = back[src] = 0;
    var heap = new Heap();
    heap.push(0, src);
    while (heap.size()) {
      var u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      var ux = u % w, uy = (u - ux) / w;
      for (var d = 0; d < 8; d++) {
        var vx = ux + NEIGHBOURS[d][0], vy = uy + NEIGHBOURS[d][1];
        if (vx < 0 || vy < 0 || vx >= w || vy >= h) continue;
        var v = vy * w + vx;
        if (done[v] || g.blocked[v]) continue;
        var dist = stepMetres(g, u, v);
        var tOut = edgeHours(g, u, v, dist);
        var tBack = edgeHours(g, v, u, dist);
        var t = total[u] + tOut + tBack;
        if (t < total[v]) {
          total[v] = t;
          out[v] = out[u] + tOut;
          back[v] = back[u] + tBack;
          prev[v] = u;
          heap.push(t, v);
        }
      }
    }
    return { src: src, total: total, out: out, back: back, prev: prev };
  }

  // 0 = out of reach, 1 = easy round trip, 2 = fits, but only just.
  function classify(walkHours, siteHours) {
    var t = walkHours + siteHours;
    if (!(t <= LIMITS.planHours)) return 0;
    return t > LIMITS.planHours - LIMITS.nearLimitHours ? 2 : 1;
  }

  // Hours from the first point, at every point along a path (in its order).
  function cumulativeHours(g, path) {
    var cum = [0];
    for (var i = 1; i < path.length; i++) {
      var a = path[i - 1], b = path[i];
      cum.push(cum[i - 1] + edgeHours(g, a, b, stepMetres(g, a, b)));
    }
    return cum;
  }

  // The walking route from the plan's start to (x, y), with its numbers.
  function routeTo(g, res, x, y, siteHours) {
    x = Math.max(0, Math.min(g.w - 1, Math.round(x)));
    y = Math.max(0, Math.min(g.h - 1, Math.round(y)));
    var idx = y * g.w + x;
    var r = {
      reachable: false, reason: null, level: 0, path: [], distanceKm: 0,
      outHours: 0, backHours: 0, walkHours: 0, siteHours: siteHours,
      totalHours: siteHours, climbM: 0, steepestDeg: 0, sandShare: 0
    };
    if (idx !== res.src && g.blocked[idx]) { r.reason = "steep"; return r; }
    if (!isFinite(res.total[idx])) { r.reason = "cutOff"; return r; }

    var path = [];
    for (var c = idx; c !== -1; c = c === res.src ? -1 : res.prev[c]) path.push(c);
    path.reverse();

    var dist = 0, climb = 0, steep = 0, sandy = 0;
    for (var i = 0; i < path.length; i++) {
      var p = path[i];
      if (i > 0) {
        dist += stepMetres(g, path[i - 1], p);
        var rise = g.elevation[p] - g.elevation[path[i - 1]];
        if (rise > 0) climb += rise;
      }
      if (i > 0 || path.length === 1) steep = Math.max(steep, g.slope[p]);
      if (g.sand[p] >= 0.5) sandy++;
    }
    r.path = path;
    r.distanceKm = dist / 1000;
    r.outHours = res.out[idx];
    r.backHours = res.back[idx];
    r.walkHours = res.total[idx];
    r.totalHours = r.walkHours + siteHours;
    r.climbM = climb;
    r.steepestDeg = Math.atan(steep) * 180 / Math.PI;
    r.sandShare = sandy / path.length;
    r.level = classify(r.walkHours, siteHours);
    r.reachable = r.level > 0;
    if (!r.reachable) r.reason = "tooFar";
    return r;
  }

  var api = {
    LIMITS: LIMITS,
    maxGrade: maxGrade,
    toblerFactor: toblerFactor,
    walkKmh: walkKmh,
    createGrid: createGrid,
    plan: plan,
    routeTo: routeTo,
    cumulativeHours: cumulativeHours,
    classify: classify
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WalkCore = api;
})(this);

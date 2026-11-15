/*
 * rover.js -- hazard-aware route planning, route comparison, and the rover
 * (automatic driving along a route, or manual driving).
 *
 * RULE: no terrain data or site names are hardcoded here. Terrain comes from
 * MarsData.sampleTerrainAt(), sites from MarsData.getNamedSites(). The only
 * constants are planner/driving tuning and drawing style.
 */
(function () {
  "use strict";

  var data = window.MarsData;
  var map = window.MapUI;

  var canvas = document.getElementById("map");
  var fromSelect = document.getElementById("route-from");
  var toSelect = document.getElementById("route-to");
  var avoidBox = document.getElementById("route-avoid");
  var avoidNote = document.getElementById("route-avoid-note");
  var optionsEl = document.getElementById("route-options");
  var summary = document.getElementById("route-summary");
  var legendRoutes = document.getElementById("map-legend-routes");

  // ---- planner tuning (behaviour, not data) ---------------------------------

  var GRID_W = 120;
  var GRID_H = 90;
  var ASPECT = canvas.height / canvas.width; // so lengths are in map widths

  // Three route options for every destination.
  // Fastest: cost per unit distance is the time it takes there (slopes and
  // sand slow Ridgeback down, see speedFactor), so it minimises drive time.
  // Safest / Balanced: cost per unit distance is
  // 1 + hazard * (1 if on hazard ground) + risk * (0-1 terrain risk).
  // "Hazard ground" is the same measure the route comparison reports, so the
  // safest option really does minimise it.
  var PROFILES = [
    { key: "fastest", name: "Fastest", goal: "Least drive time: steep ground and sand slow Ridgeback down", time: true, color: "#ffffff" },
    { key: "safest", name: "Safest", goal: "Lowest overall risk, even if it takes longer", hazard: 30, risk: 6, color: "#7dffa0" },
    { key: "balanced", name: "Balanced", goal: "A little longer than the fastest, much less risk", hazard: 4, risk: 2, color: "#ffd166" }
  ];
  var AVOID_PENALTY = 200; // extra cost for a cell inside a highlighted hazard zone
  var IMPASSABLE = 5000;   // ground beyond Ridgeback's physical limits
  // Used to judge "hazard ground" when a hazard's highlight slider is off.
  // dustRisk is the share of the ground the USGS mapped as sand ripples and
  // dunes (data-layers.js); 0.5 = half the surrounding ground is bedforms.
  var CAUTION = { slope: 0.4, dustRisk: 0.5 };
  var HAZARD_WORDS = { slope: "steep slope", dustRisk: "mapped sand" };
  var RISK_LEVELS = [
    { below: 0.3, name: "Low", color: "#5fd08a" },
    { below: 0.5, name: "Moderate", color: "#ffd166" },
    { below: 0.75, name: "High", color: "#ff9f43" },
    { below: Infinity, name: "Severe", color: "#ff5a4f" }
  ];

  // ---- driving tuning ---------------------------------------------------------

  // Speeds are in map widths per second; the world is 400 units across, so
  // 0.012 is ~4.8 units/s, Ridgeback's "slow and steady" top speed.
  var DRIVE_SPEED = 0.012;     // on flat ground, at 1x
  var SLOPE_SLOWDOWN = 0.7;    // at 100% slope the rover runs at 30% speed
  var DUST_SLOWDOWN = 0.25;    // driving on mapped sand is up to 25% slower
  var REVERSE_FACTOR = 0.5;    // reverse is half speed
  var ACCEL = 2.5;             // how quickly speed follows the throttle
  var TURN_RATE = 1.3;         // radians per second at 1x

  // Ridgeback's physical limits (always on, unlike the highlight sliders).
  var MAX_SLOPE = 0.6;         // steeper than this and it would tip over
  // Simulated rule: where 80%+ of the ground is mapped as sand bedforms (about
  // 10% of this map), the wheels dig in and only reversing works. Perseverance
  // also kept out of Jezero's dense ripple fields.
  var DEEP_SAND = 0.8;
  var STUCK_REVERSE = 0.4;     // reverse speed factor while dug in

  // Battery. The power budget is worked out in watts and watt-hours, using
  // NASA rover figures (sources in content.js, realPower), then shown as %.
  // Game time is compressed: one real second covers TIME_SCALE seconds of
  // mission time, so a full drive fits in a few minutes.
  var BATTERY_WH = 2408;       // Perseverance's rover battery: 2,408 Wh at 20 degC
  var TIME_SCALE = 190;        // mission seconds per real second (~3 min)
  var AWAKE_W = 150;           // Curiosity draws at least 150 W whenever awake
  var DRIVE_W = 350;           // extra at top speed: ~500 W total, Curiosity's driving draw
  var PEAK_W = 900;            // Perseverance's peak demand during science activities
  var CLIMB_DRAIN = 5;         // extra drive load per unit of uphill slope
  // Cold: this map has no measured temperatures, so the simulated cold penalty
  // follows THEMIS night-time IR (relative): ground that gets coldest at night
  // drains the battery up to NIGHT_COLD_DRAIN faster. (Cold cells deliver less:
  // Perseverance's give ~26% less at -20 degC than +35 degC.)
  var NIGHT_COLD_DRAIN = 0.3;
  var COLD_GROUND = 0.15;      // night IR below this counts as "extreme cold" ground
  var SPIN_W = 270;            // spinning wheels while dug in
  var SOLAR_W = 1000;          // Ridgeback's panels while stopped, in clear air (Ridgeback is fictional; real rovers use an RTG)
  var LOW_BATTERY = 40;        // NASA keeps Perseverance's battery at or above 40% every sol
  var CRITICAL_BATTERY = 10;

  // Watts in or out of the battery -> % of a full charge per real second.
  function wattsToPct(w) { return w * TIME_SCALE / 3600 / BATTERY_WH * 100; }
  var SMOOTH_PASSES = 3;       // corner rounding of the planner's grid path
  var TELEMETRY_EVERY = 0.15;  // seconds between panel updates
  var REPLAN_EVERY = 0.7;      // seconds between route updates while driving manually
  var ARRIVE_RADIUS = 0.012;   // map widths

  var sites = data.getNamedSites();
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- helpers ----------------------------------------------------------------

  function pct(v) { return Math.round(v * 100) + "%"; }

  function mapDist(a, b) {
    var dx = a.nx - b.nx;
    var dy = (a.ny - b.ny) * ASPECT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // A distance in map widths, as ground distance when the map knows its size.
  function distText(mapWidths) {
    var scale = data.getScale ? data.getScale() : null;
    if (!scale) return mapWidths.toFixed(2) + " × map width";
    var km = mapWidths * scale.widthKm;
    return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km";
  }

  function latLon(p) {
    var ll = data.toLatLon(p.nx, p.ny);
    return data.formatLatLon(ll.lat, ll.lon);
  }

  function formatTime(seconds) {
    var s = Math.round(seconds);
    return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + (s % 60) + " s";
  }

  // Limit that counts as "hazard" for a field: the highlight slider if it is
  // on, otherwise a default caution level.
  function threshold(key) {
    var limit = map.hazardLimit(key);
    return limit === null ? CAUTION[key] : limit;
  }

  // 0-1 risk for a terrain sample; 0.5 means "right at a hazard limit".
  function riskOf(sample) {
    var rs = sample.slope / (2 * threshold("slope"));
    var rd = sample.dustRisk / (2 * threshold("dustRisk"));
    return { value: Math.min(1, Math.max(rs, rd)), cause: rs >= rd ? "slope" : "dustRisk" };
  }

  function riskLevel(value) {
    for (var i = 0; i < RISK_LEVELS.length; i++) {
      if (value < RISK_LEVELS[i].below) return RISK_LEVELS[i];
    }
    return RISK_LEVELS[RISK_LEVELS.length - 1];
  }

  // Which highlighted hazard zone a sample is inside, if any.
  function zoneOf(sample) {
    var keys = map.hazardKeys();
    for (var i = 0; i < keys.length; i++) {
      if (map.isOverHazardLimit(keys[i], sample[keys[i]])) return keys[i];
    }
    return null;
  }

  function speedFactor(sample) {
    return (1 - SLOPE_SLOWDOWN * sample.slope) * (1 - DUST_SLOWDOWN * sample.dustRisk);
  }

  // ---- terrain grid for the planner -------------------------------------------

  var terrain = null;
  function getTerrain() {
    if (terrain) return terrain;
    terrain = { slope: new Float32Array(GRID_W * GRID_H), dust: new Float32Array(GRID_W * GRID_H) };
    for (var y = 0; y < GRID_H; y++) {
      for (var x = 0; x < GRID_W; x++) {
        var s = data.sampleTerrainAt(x / (GRID_W - 1), y / (GRID_H - 1));
        terrain.slope[y * GRID_W + x] = s.slope;
        terrain.dust[y * GRID_W + x] = s.dustRisk;
      }
    }
    return terrain;
  }

  function buildCost(profile) {
    var t = getTerrain();
    var cost = new Float32Array(GRID_W * GRID_H);
    var limS = avoidBox.checked ? map.hazardLimit("slope") : null;
    var limD = avoidBox.checked ? map.hazardLimit("dustRisk") : null;
    var thrS = threshold("slope"), thrD = threshold("dustRisk");
    for (var i = 0; i < cost.length; i++) {
      var s = t.slope[i], d = t.dust[i];
      var onHazard = s > thrS || d > thrD;
      var risk = Math.min(1, Math.max(s / (2 * thrS), d / (2 * thrD)));
      var c = profile.time
        ? 1 / Math.max(0.05, speedFactor({ slope: s, dustRisk: d }))
        : 1 + (onHazard ? profile.hazard : 0) + profile.risk * risk;
      if ((limS !== null && s > limS) || (limD !== null && d > limD)) c += AVOID_PENALTY;
      if (s > MAX_SLOPE || d > DEEP_SAND) c += IMPASSABLE; // Ridgeback can't drive there at all
      cost[i] = c;
    }
    return cost;
  }

  // True if the straight segment a-b only crosses cells no dearer than maxCost.
  function clearLine(a, b, cost, maxCost) {
    var steps = Math.ceil(Math.max(Math.abs(b.nx - a.nx) * GRID_W, Math.abs(b.ny - a.ny) * GRID_H) * 2) + 1;
    for (var k = 0; k <= steps; k++) {
      var t = k / steps;
      var cx = toCell(a.nx + (b.nx - a.nx) * t, GRID_W);
      var cy = toCell(a.ny + (b.ny - a.ny) * t, GRID_H);
      if (cost[cy * GRID_W + cx] > maxCost) return false;
    }
    return true;
  }

  // "String pulling": replace grid zig-zags with the longest direct lines
  // that stay on ground the original path was allowed on.
  function straighten(points, cost) {
    var maxCost = 1;
    points.forEach(function (p) {
      maxCost = Math.max(maxCost, cost[toCell(p.ny, GRID_H) * GRID_W + toCell(p.nx, GRID_W)]);
    });
    if (maxCost >= AVOID_PENALTY) maxCost = 1; // path had to cross a zone/limit; keep elsewhere clear
    var out = [points[0]];
    var i = 0;
    while (i < points.length - 1) {
      var j = points.length - 1;
      while (j > i + 1 && !clearLine(points[i], points[j], cost, maxCost)) j--;
      out.push(points[j]);
      i = j;
    }
    return out;
  }

  function cellDist(ax, ay, bx, by) {
    var dx = (ax - bx) / (GRID_W - 1);
    var dy = ((ay - by) / (GRID_H - 1)) * ASPECT;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---- A* over the grid -----------------------------------------------------

  function heapPush(heap, node) {
    heap.push(node);
    var i = heap.length - 1;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (heap[parent].f <= heap[i].f) break;
      var tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
      i = parent;
    }
  }

  function heapPop(heap) {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1;
        var r = l + 1;
        var m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        var tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp;
        i = m;
      }
    }
    return top;
  }

  function toCell(n, size) {
    return Math.min(size - 1, Math.max(0, Math.round(n * (size - 1))));
  }

  function findPath(start, end, cost) {
    var sx = toCell(start.nx, GRID_W), sy = toCell(start.ny, GRID_H);
    var ex = toCell(end.nx, GRID_W), ey = toCell(end.ny, GRID_H);
    var startIdx = sy * GRID_W + sx;
    var endIdx = ey * GRID_W + ex;

    // Float64 on purpose: float32 rounding makes fresh heap entries look stale.
    var best = new Float64Array(GRID_W * GRID_H).fill(Infinity);
    var cameFrom = new Int32Array(GRID_W * GRID_H).fill(-1);
    var heap = [];
    best[startIdx] = 0;
    heapPush(heap, { idx: startIdx, g: 0, f: cellDist(sx, sy, ex, ey) });

    while (heap.length) {
      var node = heapPop(heap);
      if (node.idx === endIdx) break;
      if (node.g > best[node.idx]) continue; // stale entry
      var x = node.idx % GRID_W;
      var y = (node.idx - x) / GRID_W;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          var nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          var nIdx = ny * GRID_W + nx;
          var g = node.g + cellDist(x, y, nx, ny) * (cost[node.idx] + cost[nIdx]) / 2;
          if (g < best[nIdx]) {
            best[nIdx] = g;
            cameFrom[nIdx] = node.idx;
            heapPush(heap, { idx: nIdx, g: g, f: g + cellDist(nx, ny, ex, ey) });
          }
        }
      }
    }

    var points = [];
    for (var idx = endIdx; idx !== -1; idx = cameFrom[idx]) {
      var px = idx % GRID_W;
      points.push({ nx: px / (GRID_W - 1), ny: ((idx - px) / GRID_W) / (GRID_H - 1) });
      if (idx === startIdx) break;
    }
    points.reverse();
    // Pin the ends to the exact positions rather than the nearest cell.
    points[0] = { nx: start.nx, ny: start.ny };
    points[points.length - 1] = { nx: end.nx, ny: end.ny };
    return points;
  }

  // Chaikin corner cutting: turns the 8-direction grid path into a smooth drive line.
  function smoothPath(points) {
    var pts = points.slice();
    for (var pass = 0; pass < SMOOTH_PASSES; pass++) {
      if (pts.length < 3) break;
      var out = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        out.push({ nx: a.nx * 0.75 + b.nx * 0.25, ny: a.ny * 0.75 + b.ny * 0.25 });
        out.push({ nx: a.nx * 0.25 + b.nx * 0.75, ny: a.ny * 0.25 + b.ny * 0.75 });
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  function cumulative(path) {
    var cum = [0];
    for (var i = 1; i < path.length; i++) cum.push(cum[i - 1] + mapDist(path[i], path[i - 1]));
    return cum;
  }

  function pointOn(path, cum, s) {
    var total = cum[cum.length - 1];
    s = Math.max(0, Math.min(total, s));
    var lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid; else hi = mid;
    }
    var seg = cum[hi] - cum[lo] || 1;
    var t = (s - cum[lo]) / seg;
    return {
      nx: path[lo].nx + (path[hi].nx - path[lo].nx) * t,
      ny: path[lo].ny + (path[hi].ny - path[lo].ny) * t
    };
  }

  // ---- route metrics ----------------------------------------------------------

  function measure(path, cum) {
    var total = cum[cum.length - 1];
    var n = Math.max(2, Math.ceil(total / 0.004));
    var ds = total / n;
    var thrS = threshold("slope"), thrD = threshold("dustRisk");
    var m = {
      length: total, time: 0, climb: 0, slopeShare: 0, dustShare: 0, hazShare: 0,
      risk: 0, maxSlope: 0, maxDust: 0, stretches: []
    };
    var cur = null, prevE = null;
    for (var i = 0; i <= n; i++) {
      var p = pointOn(path, cum, i * ds);
      var s = data.sampleTerrainAt(p.nx, p.ny);
      var overS = s.slope > thrS, overD = s.dustRisk > thrD;
      if (i > 0) {
        m.time += ds / (DRIVE_SPEED * speedFactor(s));
        if (s.elevation > prevE) m.climb += s.elevation - prevE;
        if (overS) m.slopeShare += ds;
        if (overD) m.dustShare += ds;
        if (overS || overD) m.hazShare += ds;
      }
      m.risk += riskOf(s).value;
      if (s.slope > m.maxSlope) m.maxSlope = s.slope;
      if (s.dustRisk > m.maxDust) m.maxDust = s.dustRisk;
      if (overS || overD) {
        if (!cur) cur = { from: i / n, to: i / n, slope: 0, dust: 0, hasSlope: false, hasDust: false };
        cur.to = i / n;
        cur.slope = Math.max(cur.slope, s.slope);
        cur.dust = Math.max(cur.dust, s.dustRisk);
        cur.hasSlope = cur.hasSlope || overS;
        cur.hasDust = cur.hasDust || overD;
      } else if (cur) {
        m.stretches.push(cur);
        cur = null;
      }
      prevE = s.elevation;
    }
    if (cur) m.stretches.push(cur);
    m.slopeShare /= total;
    m.dustShare /= total;
    m.hazShare /= total;
    m.risk /= n + 1;
    m.crossings = m.stretches.length;
    return m;
  }

  // Advantages, disadvantages and the recommended option.
  function compare(routes) {
    var minLen = Infinity, minTime = Infinity, minHaz = Infinity, minClimb = Infinity;
    routes.forEach(function (r) {
      minLen = Math.min(minLen, r.metrics.length);
      minTime = Math.min(minTime, r.metrics.time);
      minHaz = Math.min(minHaz, r.metrics.hazShare);
      minClimb = Math.min(minClimb, r.metrics.climb);
    });
    var thrS = threshold("slope");
    routes.forEach(function (r, i) {
      var m = r.metrics;
      r.pros = [];
      r.cons = [];
      r.sameAs = null;
      for (var j = 0; j < i; j++) {
        var o = routes[j].metrics;
        if (Math.abs(o.length - m.length) < m.length * 0.005 && Math.abs(o.hazShare - m.hazShare) < 0.005) {
          r.sameAs = routes[j].profile.name;
        }
      }
      if (m.time <= minTime * 1.01) r.pros.push("Fastest drive");
      else r.cons.push("+" + pct(m.time / minTime - 1) + " drive time vs the fastest");
      if (m.length <= minLen * 1.01) r.pros.push("Shortest distance");
      if (m.hazShare <= minHaz + 0.005) {
        r.pros.push(m.hazShare < 0.005 ? "Stays clear of hazard ground" : "Least hazard exposure");
      } else {
        r.cons.push(pct(m.hazShare) + " of the route on hazard ground (best option: " + pct(minHaz) + ")");
      }
      if (m.climb <= minClimb * 1.02 + 1) r.pros.push("Least climbing");
      if (m.crossings > 0) r.cons.push("Crosses " + m.crossings + " hazard stretch" + (m.crossings > 1 ? "es" : ""));
      if (m.maxSlope >= 1.5 * thrS) r.cons.push("Very steep section, up to " + pct(m.maxSlope));
      if (!r.pros.length) r.pros.push("Middle ground on distance and safety");
      if (!r.cons.length) r.cons.push("No notable drawbacks");
    });

    function by(key) { return routes.filter(function (r) { return r.profile.key === key; })[0]; }
    var S = by("safest").metrics, B = by("balanced").metrics, F = by("fastest").metrics;
    var pick, reason;
    if (F.hazShare <= S.hazShare + 0.02 && F.risk <= S.risk + 0.03) {
      pick = "fastest";
      reason = "The fastest route is about as safe as any detour, so there is no reason to take longer.";
    } else if (B.hazShare > S.hazShare + 0.08 && S.time <= B.time * 1.6) {
      pick = "safest";
      var extra = S.time - B.time;
      reason = "It cuts hazard ground from " + pct(B.hazShare) + " to " + pct(S.hazShare) + " of the route" +
        (extra < 1 ? " with almost no extra driving." : " for " + formatTime(extra) + " more driving.");
    } else if (B.hazShare <= S.hazShare + 0.08) {
      pick = "balanced";
      reason = "It is nearly as safe as the safest route and " +
        (B.length < S.length ? pct(1 - B.length / S.length) + " shorter." : "no longer.");
    } else {
      pick = "balanced";
      reason = "The safest route takes " + (S.time / B.time).toFixed(1) + "× as long to drive.";
    }
    // If the pick is the same path as another option, credit the original.
    var chosen = by(pick);
    if (chosen.sameAs) {
      var original = routes.filter(function (r) { return r.profile.name === chosen.sameAs; })[0];
      pick = original.profile.key;
      reason = "The " + chosen.profile.name.toLowerCase() + " and " + original.profile.name.toLowerCase() +
        " options take the same path here" +
        (original.profile.key === "safest" ? ", so the safest route costs nothing extra." : ".");
    }
    return { key: pick, reason: reason };
  }

  // ===========================================================================
  // STATE
  // ===========================================================================

  var rover = {
    pos: null,       // {nx, ny}
    heading: 0,      // radians, map space (0 = east/right, +90deg = south/down)
    speed: 0,        // signed, map widths per second
    mode: "auto",    // "auto" follows the route, "manual" is driven by the user
    playing: false,
    arrived: false,
    sample: null,    // terrain under the rover
    blocked: null,   // limit that stopped the rover: "steepSlope" | "deepSand" | "zone" | "edge"
    stuck: false,    // dug into deep sand
    battery: 100,
    dead: false,     // battery ran out
    drain: 0,        // current battery change per second (for the readout)
    watts: 0,        // current power in (+) or out (-) of the battery, at 1x
    path: null, cum: null, total: 0, s: 0 // the route being followed
  };

  var dest = null;        // { nx, ny, name }
  var origin = null;      // where the current routes start from
  var routes = null;      // [{ profile, path, cum, metrics, pros, cons, sameAs }]
  var recommended = null; // { key, reason }
  var selectedKey = null;
  var userPicked = false; // true once the user chooses an option themselves
  var planMessage = "";
  var scene3d = null;
  var locked = false;     // someone is outside on foot (walk.js): Ridgeback stays parked

  function selectedRoute() {
    if (!routes) return null;
    return routes.filter(function (r) { return r.profile.key === selectedKey; })[0] || routes[0];
  }

  function refreshSample() {
    rover.sample = rover.pos ? data.sampleTerrainAt(rover.pos.nx, rover.pos.ny) : null;
  }

  // Plan all three options from the rover to the destination.
  // If the rover is already at the destination, plan from where it set out,
  // so the comparison stays on screen.
  function plan() {
    routes = null;
    recommended = null;
    planMessage = "";
    if (!dest) {
      planMessage = t("rover.hints.firstMove");
    } else if (!rover.pos) {
      planMessage = "Pick where the rover starts.";
    } else {
      var atDest = mapDist(rover.pos, dest) < ARRIVE_RADIUS;
      if (!atDest) origin = { nx: rover.pos.nx, ny: rover.pos.ny };
      if (!origin || mapDist(origin, dest) < ARRIVE_RADIUS) {
        planMessage = "The rover is already at the destination.";
      } else {
        routes = PROFILES.map(function (profile) {
          var cost = buildCost(profile);
          var raw = findPath(origin, dest, cost);
          if (profile.straight) raw = straighten(raw, cost);
          var path = smoothPath(raw);
          var cum = cumulative(path);
          return { profile: profile, path: path, cum: cum, metrics: measure(path, cum) };
        });
        recommended = compare(routes);
        if (!userPicked) selectedKey = recommended.key;
        followSelected(atDest);
      }
    }
    if (!routes) {
      rover.path = null;
      rover.playing = false;
    }
    renderRoutes();
    map.redraw();
    if (scene3d) scene3d.setRoutes(routes, selectedKey, dest);
    syncControls();
    renderTelemetry();
  }

  function followSelected(atEnd) {
    var r = selectedRoute();
    rover.path = r.path;
    rover.cum = r.cum;
    rover.total = r.cum[r.cum.length - 1];
    rover.s = atEnd ? rover.total : 0;
    rover.arrived = !!atEnd;
    if (atEnd) rover.playing = false;
  }

  var planTimer = null;
  function planSoon() {
    clearTimeout(planTimer);
    planTimer = setTimeout(plan, 120);
  }

  // Put the rover somewhere directly (start site, or "drive again").
  function teleport(p) {
    rover.pos = { nx: p.nx, ny: p.ny };
    rover.speed = 0;
    rover.blocked = null;
    refreshSample();
    if (scene3d) scene3d.resetTrail();
  }

  // A new destination shows its three routes and waits: driving only starts
  // when the user presses Start drive.
  function setDestination(d) {
    dest = d;
    rover.playing = false;
    rover.speed = 0;
    plan();
    syncControls();
    renderTelemetry();
  }

  // ===========================================================================
  // ROUTE PANEL
  // ===========================================================================

  function fillSelect(select, chosenIndex, noneLabel) {
    select.textContent = "";
    if (noneLabel) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = noneLabel;
      select.appendChild(none);
    }
    sites.forEach(function (site, i) {
      var option = document.createElement("option");
      option.value = String(i);
      option.textContent = site.name;
      select.appendChild(option);
    });
    select.value = chosenIndex >= 0 ? String(chosenIndex) : "";
  }

  function firstOfType(type, fallback) {
    for (var i = 0; i < sites.length; i++) {
      if (sites[i].type === type) return i;
    }
    return fallback < sites.length ? fallback : -1;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addRow(list, label, value) {
    list.appendChild(el("dt", "", label));
    list.appendChild(el("dd", "", value));
  }

  function renderRoutes() {
    optionsEl.textContent = "";
    summary.textContent = "";
    var anyLimit = map.hazardKeys().some(function (k) { return map.hazardLimit(k) !== null; });
    avoidNote.textContent = anyLimit
      ? ""
      : "Mark zones under Map layers & hazards (left).";
    if (!routes) {
      summary.appendChild(el("p", "empty", planMessage));
      return;
    }

    routes.forEach(function (r) {
      var m = r.metrics;
      var isSel = r.profile.key === selectedKey;
      var card = el("label", "route-card" + (isSel ? " is-selected" : ""));
      card.style.setProperty("--rc", r.profile.color);
      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "route-option";
      radio.checked = isSel;
      radio.addEventListener("change", function () {
        userPicked = true;
        selectedKey = r.profile.key;
        var wasPlaying = rover.playing;
        // Switching option mid-drive: re-plan from where the rover is now.
        plan();
        rover.playing = wasPlaying && !!routes && rover.mode === "auto";
        syncControls();
      });
      card.appendChild(radio);

      var head = el("span", "route-head");
      head.appendChild(el("span", "route-line"));
      head.appendChild(el("strong", "", r.profile.name));
      if (recommended.key === r.profile.key) head.appendChild(el("em", "badge", "Recommended"));
      card.appendChild(head);
      card.appendChild(el("span", "route-goal", r.sameAs ? "Same path as " + r.sameAs : r.profile.goal));
      card.appendChild(el("span", "route-stats",
        distText(m.length) + " · " + formatTime(m.time) + " · " +
        pct(m.hazShare) + " hazard · risk " + Math.round(m.risk * 100)));

      if (isSel) {
        var list = el("ul", "route-points");
        r.pros.forEach(function (t) { list.appendChild(el("li", "pro", t)); });
        r.cons.forEach(function (t) { list.appendChild(el("li", "con", t)); });
        card.appendChild(list);
      }
      optionsEl.appendChild(card);
    });

    summary.appendChild(el("p", "recommend", "Recommended: " +
      routes.filter(function (r) { return r.profile.key === recommended.key; })[0].profile.name +
      ". " + recommended.reason));

    var sel = selectedRoute();
    var m = sel.metrics;
    // Full numbers and trouble spots fold away until asked for.
    var details = el("details", "more");
    details.open = routeDetailsOpen;
    details.addEventListener("toggle", function () { routeDetailsOpen = details.open; });
    details.appendChild(el("summary", "", sel.profile.name + " route details"));
    summary.appendChild(details);
    var box = details; // the rows below go inside the fold
    var dl = document.createElement("dl");
    addRow(dl, "Length", distText(m.length));
    addRow(dl, "Drive time (1×)", formatTime(m.time));
    addRow(dl, "Total climb", Math.round(m.climb) + " m");
    map.addRow(dl, "Slope exposure", pct(m.slopeShare) + " above " + pct(threshold("slope")), "slope", m.slopeShare > 0.005);
    map.addRow(dl, "Sand exposure", pct(m.dustShare) + " above " + pct(threshold("dustRisk")), "dustRisk", m.dustShare > 0.005);
    addRow(dl, "Hazard crossings", String(m.crossings));
    addRow(dl, "Risk score", Math.round(m.risk * 100) + " / 100 · " + riskLevel(m.risk).name);
    box.appendChild(dl);

    box.appendChild(el("h3", "", "Areas of concern"));
    if (!m.stretches.length) {
      box.appendChild(el("p", "empty", "None on this route."));
    } else {
      var worst = m.stretches.slice().sort(function (a, b) {
        return (b.to - b.from) * Math.max(b.slope, b.dust) - (a.to - a.from) * Math.max(a.slope, a.dust);
      }).slice(0, 3).sort(function (a, b) { return a.from - b.from; });
      var ul = el("ul", "concerns");
      worst.forEach(function (st) {
        var parts = [];
        if (st.hasSlope) parts.push(HAZARD_WORDS.slope + " up to " + pct(st.slope));
        if (st.hasDust) parts.push(HAZARD_WORDS.dustRisk + " up to " + pct(st.dust));
        ul.appendChild(el("li", "", pct(st.from) + "–" + pct(st.to) + " of the way: " + parts.join(", ")));
      });
      box.appendChild(ul);
      if (m.stretches.length > worst.length) {
        box.appendChild(el("p", "empty", "Plus " + (m.stretches.length - worst.length) + " shorter stretches."));
      }
    }
  }

  // ---- drawing the routes on the 2D map ---------------------------------------

  function drawRoutes(ctx, W, H) {
    if (routes) {
      var ordered = routes.filter(function (r) { return r.profile.key !== selectedKey; });
      ordered.push(selectedRoute());
      ordered.forEach(function (r) {
        var isSel = r.profile.key === selectedKey;
        function trace() {
          ctx.beginPath();
          r.path.forEach(function (p, i) {
            var x = p.nx * (W - 1), y = p.ny * (H - 1);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          });
          ctx.stroke();
        }
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.globalAlpha = isSel ? 1 : 0.75;
        ctx.lineWidth = isSel ? 6 : 3.5;
        ctx.strokeStyle = "rgba(20,16,14,.85)";
        trace();
        ctx.lineWidth = isSel ? 3 : 1.5;
        ctx.strokeStyle = r.profile.color;
        if (!isSel) ctx.setLineDash([6, 5]);
        trace();
        ctx.restore();
      });
    }
    if (dest) {
      var dx = dest.nx * (W - 1), dy = dest.ny * (H - 1);
      ctx.save();
      [[5, "rgba(20,16,14,.9)"], [2.5, "#ffd166"]].forEach(function (pass) {
        ctx.lineWidth = pass[0];
        ctx.strokeStyle = pass[1];
        ctx.beginPath();
        ctx.arc(dx, dy, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(dx, dy, 15, 0, Math.PI * 2);
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
      ctx.restore();
    }
  }

  function buildRouteLegend() {
    legendRoutes.textContent = "";
    PROFILES.forEach(function (p) {
      var row = el("div", "map-legend-row");
      var line = el("span", "route-line");
      line.style.setProperty("--rc", p.color);
      row.appendChild(line);
      row.appendChild(el("span", "", p.name + " route"));
      legendRoutes.appendChild(row);
    });
    var roverRow = el("div", "map-legend-row");
    roverRow.appendChild(el("span", "legend-rover"));
    roverRow.appendChild(el("span", "", "Rover (points the way it faces)"));
    legendRoutes.appendChild(roverRow);
    var destRow = el("div", "map-legend-row");
    destRow.appendChild(el("span", "legend-dest"));
    destRow.appendChild(el("span", "", "Destination"));
    legendRoutes.appendChild(destRow);
  }

  // ===========================================================================
  // RIDGEBACK TEXT (content.js)
  // ===========================================================================
  //
  // All rover wording comes from content.js (owned by the content teammate).
  // It is an ES module, so it is loaded with a dynamic import; until it
  // arrives (or if the page is opened from file://, where imports are
  // blocked) the text is simply empty.

  var TEXT = null;

  function t(path) {
    var node = TEXT;
    var parts = path.split(".");
    for (var i = 0; i < parts.length && node; i++) node = node[parts[i]];
    return typeof node === "string" ? node : "";
  }

  function applyContent() {
    document.getElementById("rb-name").textContent = t("rover.name");
    document.getElementById("rb-tag").textContent = t("rover.tagline");
    document.getElementById("rb-reset").textContent = t("rover.buttons.reset");
    document.getElementById("rb-recharge").textContent = t("rover.buttons.recharge");
    var battery = TEXT && TEXT.rover.stats.battery;
    if (battery) {
      document.getElementById("rb-battery-label").textContent = battery.label;
      document.getElementById("rb-battery-label").title = battery.tooltip;
    }
    var limits = TEXT && TEXT.rover.limits;
    var list = document.getElementById("rb-limits");
    list.textContent = "";
    if (limits) {
      document.getElementById("rb-limits-title").textContent = limits.title;
      ["steepSlope", "deepSand", "extremeCold", "dustStorm"].forEach(function (key) {
        list.appendChild(el("li", "", limits[key]));
      });
    }
    renderRealPower(TEXT && TEXT.realPower);
    if (!routes) plan(); // re-word the empty Navigation panel now the text is here
    syncControls();
    renderTelemetry();
  }

  // "How real Mars rovers get power": sourced facts from content.js.
  function renderRealPower(info) {
    var box = document.getElementById("rb-power");
    box.textContent = "";
    if (!info) return;
    document.getElementById("rb-power-title").textContent = info.title;
    box.appendChild(el("p", "", info.intro));
    info.sections.forEach(function (section) {
      box.appendChild(el("h3", "", section.heading));
      var ul = el("ul");
      section.facts.forEach(function (fact) {
        var li = el("li", "", fact.text + " ");
        var a = el("a", "", "[" + info.sourceLabel + "]");
        a.href = fact.source;
        a.target = "_blank";
        a.rel = "noopener";
        li.appendChild(a);
        ul.appendChild(li);
      });
      box.appendChild(ul);
    });
  }

  // ===========================================================================
  // DRIVING
  // ===========================================================================

  var panel = document.getElementById("rover-panel");
  var modeAutoBtn = document.getElementById("mode-auto");
  var modeManualBtn = document.getElementById("mode-manual");
  var playBtn = document.getElementById("rover-play");
  var restartBtn = document.getElementById("rover-restart");
  var speedSelect = document.getElementById("rover-speed");
  var progressInput = document.getElementById("rover-progress");
  var telemetry = document.getElementById("rover-telemetry");
  var marker2d = document.getElementById("rover-2d");
  var riskHud = document.getElementById("risk-hud");
  var riskLevelEl = document.getElementById("risk-level");
  var riskFill = document.getElementById("risk-fill");
  var riskCause = document.getElementById("risk-cause");
  var rbPct = document.getElementById("rb-pct");
  var rbFill = document.getElementById("rb-fill");
  var rbStatus = document.getElementById("rb-status");
  var rbLimit = document.getElementById("rb-limit");
  var rbHint = document.getElementById("rb-hint");

  var input = { up: false, down: false, left: false, right: false };
  var movedSincePlan = 0;
  var sincePlan = 0;
  var everMoved = false;

  function speedMul() { return Number(speedSelect.value) || 1; }

  // Is it physically possible to move from the rover's spot onto `next`?
  // Returns the limit that stops it, or null. Ground the rover is already on
  // never blocks it, so it can always drive back out.
  function limitAhead(next) {
    var here = rover.sample;
    if (next.slope > MAX_SLOPE && next.slope > here.slope) return "steepSlope";
    if (avoidBox.checked && !zoneOf(here) && zoneOf(next)) return "zone";
    return null;
  }

  function stepAuto(dt) {
    if (!rover.path || !rover.playing || rover.dead) {
      rover.speed = 0;
      return;
    }
    rover.speed = DRIVE_SPEED * speedMul() * speedFactor(rover.sample);
    var s = Math.min(rover.total, rover.s + rover.speed * dt);
    var next = pointOn(rover.path, rover.cum, s);
    var block = limitAhead(data.sampleTerrainAt(next.nx, next.ny));
    if (block) {
      // The planner keeps routes off such ground, but hazard limits can change mid-drive.
      rover.blocked = block;
      rover.playing = false;
      rover.speed = 0;
      syncControls();
      return;
    }
    rover.s = s;
    if (rover.s >= rover.total) {
      rover.playing = false;
      rover.arrived = true;
      rover.speed = 0;
      syncControls();
    }
    rover.pos = next;
    var a = pointOn(rover.path, rover.cum, rover.s - 0.003);
    var b = pointOn(rover.path, rover.cum, rover.s + 0.003);
    if (a.nx !== b.nx || a.ny !== b.ny) {
      rover.heading = Math.atan2((b.ny - a.ny) * ASPECT, b.nx - a.nx);
    }
  }

  function stepManual(dt) {
    var throttle = rover.dead ? 0 : (input.up ? 1 : 0) - (input.down ? 1 : 0);
    var steer = rover.dead ? 0 : (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var mul = speedMul();
    rover.stuck = rover.sample.dustRisk > DEEP_SAND;
    var factor = speedFactor(rover.sample) * (throttle < 0 ? (rover.stuck ? STUCK_REVERSE : REVERSE_FACTOR) : 1);
    if (rover.stuck && throttle > 0) factor = 0; // wheels just spin
    var target = throttle * DRIVE_SPEED * mul * factor;
    // Braking (letting go) is quicker than accelerating.
    rover.speed += (target - rover.speed) * (1 - Math.exp(-dt * (throttle ? ACCEL : ACCEL * 2.5)));
    if (!throttle && Math.abs(rover.speed) < DRIVE_SPEED * 0.05) rover.speed = 0;
    if (rover.stuck && throttle > 0) rover.speed = 0;
    // Like Ridgeback: steering is gentler at low speed and flips in reverse.
    var turnScale = 0.35 + 0.65 * Math.min(1, Math.abs(rover.speed) / (DRIVE_SPEED * 0.5));
    rover.heading += steer * TURN_RATE * Math.min(2, mul) * turnScale * dt * (rover.speed < 0 ? -1 : 1);
    if (throttle || steer) rover.blocked = rover.stuck && throttle > 0 ? "deepSand" : null;
    if (throttle) everMoved = true;
    if (!rover.speed) return;

    var nx = rover.pos.nx + Math.cos(rover.heading) * rover.speed * dt;
    var ny = rover.pos.ny + Math.sin(rover.heading) * rover.speed * dt / ASPECT;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      rover.blocked = "edge";
      rover.speed = 0;
      return;
    }
    var block = limitAhead(data.sampleTerrainAt(nx, ny));
    if (block) {
      rover.blocked = block;
      rover.speed = 0;
      return;
    }
    movedSincePlan += mapDist(rover.pos, { nx: nx, ny: ny });
    rover.pos = { nx: nx, ny: ny };
  }

  // Battery: driving drains it (more uphill and in the cold), standing still
  // in sunlight recharges it (clear-air rate: there is no dust-opacity data here).
  function stepBattery(dt, prevElevation) {
    var s = rover.sample;
    var mul = speedMul();
    var watts; // + charging, - drawing from the battery
    var moving = Math.abs(rover.speed) > 0;
    if (moving) {
      var dist = Math.abs(rover.speed) * dt;
      var uphill = dist > 0 && s.elevation > prevElevation ? s.slope : 0;
      var cold = 1 + (isFinite(s.nightIR) ? (1 - s.nightIR) * NIGHT_COLD_DRAIN : 0);
      // Speed is already scaled by the sim-speed multiplier, and so is the drain.
      var load = (AWAKE_W * mul + DRIVE_W * (Math.abs(rover.speed) / DRIVE_SPEED) * (1 + CLIMB_DRAIN * uphill)) * cold;
      watts = -Math.min(PEAK_W * mul, load);
    } else if (rover.blocked === "deepSand" && input.up) {
      watts = -SPIN_W * mul;
    } else if (!rover.dead && rover.battery < 100) {
      watts = SOLAR_W * mul;
    } else {
      watts = 0;
    }
    rover.watts = watts / mul;
    var rate = wattsToPct(watts);
    rover.drain = rate;
    rover.battery = Math.max(0, Math.min(100, rover.battery + rate * dt));
    if (rover.battery <= 0 && !rover.dead) {
      rover.dead = true;
      rover.playing = false;
      rover.speed = 0;
      syncControls();
    }
  }

  function step(dt) {
    if (!rover.pos) return;
    var prevElevation = rover.sample ? rover.sample.elevation : 0;
    if (locked) {
      rover.speed = 0;
      rover.playing = false;
      refreshSample();
      stepBattery(dt, prevElevation);
      return;
    }
    if (rover.mode === "manual") {
      stepManual(dt);
      // Keep the suggested routes current as the rover moves.
      sincePlan += dt;
      if (movedSincePlan > 0.004 && (sincePlan >= REPLAN_EVERY || !rover.speed)) {
        movedSincePlan = 0;
        sincePlan = 0;
        plan();
      }
    } else {
      stepAuto(dt);
      if (rover.playing) everMoved = true;
    }
    refreshSample();
    stepBattery(dt, prevElevation);
  }

  function setMode(mode) {
    if (rover.mode === mode) return;
    rover.mode = mode;
    rover.speed = 0;
    rover.blocked = null;
    if (mode === "manual") {
      rover.playing = false;
    } else {
      // Back to automatic: plan from wherever the rover was driven to, then
      // wait for the user to pick a route and press Start drive.
      input.up = input.down = input.left = input.right = false;
      plan();
      rover.playing = false;
    }
    syncControls();
    renderTelemetry();
  }

  // ---- controls ---------------------------------------------------------------

  function syncControls() {
    var has = !!rover.path;
    var auto = rover.mode === "auto";
    panel.classList.toggle("is-manual", !auto);
    modeAutoBtn.setAttribute("aria-pressed", String(auto));
    modeManualBtn.setAttribute("aria-pressed", String(!auto));
    playBtn.disabled = !has || rover.dead || locked;
    restartBtn.disabled = !has || locked;
    progressInput.disabled = !has || !auto || locked;
    modeAutoBtn.disabled = modeManualBtn.disabled = locked;
    playBtn.textContent = rover.playing ? t("rover.buttons.stop")
      : rover.arrived ? t("rover.buttons.again") : t("rover.buttons.start");
    playBtn.setAttribute("aria-pressed", String(rover.playing));
    progressInput.value = has && rover.total ? String(Math.round(rover.s / rover.total * 1000)) : "0";
    document.getElementById("rb-recharge").disabled = rover.dead || rover.battery >= 99.5;
  }

  function compass(heading) {
    var deg = ((heading * 180 / Math.PI + 90) % 360 + 360) % 360; // 0 = map north (up)
    var names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return names[Math.round(deg / 45) % 8] + " " + Math.round(deg) + "°";
  }

  // content.js status key for the rover's situation, most serious first.
  function statusKey() {
    if (rover.dead) return "failed";
    if (rover.blocked === "deepSand" || rover.blocked === "steepSlope" || (rover.stuck && input.up)) return "stuck";
    if (rover.battery < CRITICAL_BATTERY) return "critical";
    if (rover.battery < LOW_BATTERY) return "lowBattery";
    if (rover.arrived || (dest && mapDist(rover.pos, dest) < ARRIVE_RADIUS)) return "arrived";
    if (rover.speed) return "moving";
    if (rover.battery < 99.5) return "charging";
    return "ready";
  }

  // The limit or condition behind the current situation, from content.js.
  function limitKey() {
    var s = rover.sample;
    if (rover.blocked === "steepSlope") return "steepSlope";
    if (rover.blocked === "deepSand" || rover.stuck) return "deepSand";
    if (rover.drain < 0 && s.nightIR < COLD_GROUND) return "extremeCold";
    return null;
  }

  function hintKey() {
    var s = rover.sample;
    // (The first-move hint is shown once, in the Plan tab, not repeated here.)
    if (rover.battery < LOW_BATTERY) return "lowPower";
    if (s.slope > MAX_SLOPE * 0.75 || rover.blocked === "steepSlope") return "slope";
    return null;
  }

  function renderHud() {
    var b = rover.battery;
    rbPct.textContent = Math.round(b) + "%";
    rbFill.style.width = b + "%";
    rbFill.className = b < CRITICAL_BATTERY ? "bad" : b < LOW_BATTERY ? "warn" : "ok";
    if (!rover.sample) return;
    rbStatus.textContent = t("rover.status." + statusKey());
    if (rover.blocked === "zone") {
      rbLimit.textContent = "";
      rbStatus.textContent = t("rover.status.stuck");
    }
    var lk = limitKey();
    rbLimit.textContent = lk ? t("rover.limits." + lk) : "";
    var hk = hintKey();
    rbHint.textContent = hk ? t("rover.hints." + hk) : "";
  }

  function renderRisk() {
    if (!rover.sample) {
      riskHud.hidden = true;
      return;
    }
    var risk = riskOf(rover.sample);
    var level = riskLevel(risk.value);
    riskHud.hidden = false;
    riskHud.style.setProperty("--risk", level.color);
    riskLevelEl.textContent = level.name;
    riskFill.style.width = Math.max(4, Math.round(risk.value * 100)) + "%";
    var zone = zoneOf(rover.sample);
    var key = zone || risk.cause;
    riskCause.textContent = (zone ? "In " + HAZARD_WORDS[zone] + " zone" : "Main factor: " + HAZARD_WORDS[key]) +
      " · " + pct(rover.sample[key]);
    riskCause.style.color = zone ? map.hazardColor(zone) : "";
  }

  var BLOCK_WORDS = {
    steepSlope: "too steep ahead", deepSand: "dug into deep sand",
    zone: "hazard zone ahead", edge: "edge of the map"
  };

  var moreReadingsOpen = false;  // "More readings" stays open across redraws
  var routeDetailsOpen = false;  // so does "Route details"

  function renderTelemetry() {
    telemetry.textContent = "";
    renderHud();
    renderRisk();
    if (!rover.pos || !rover.sample) return;
    var s = rover.sample;
    // The few readings that matter while driving; the rest fold away.
    var list = document.createElement("dl");
    addRow(list, "Power", rover.watts > 0.5 ? "+" + Math.round(rover.watts) + " W charging"
      : rover.watts < -0.5 ? Math.round(-rover.watts) + " W draw" : "Idle");
    addRow(list, "Speed", pct(Math.abs(rover.speed) / (DRIVE_SPEED * speedMul())) + " of top speed");
    if (dest) addRow(list, "To destination", distText(mapDist(rover.pos, dest)));
    map.addRow(list, "Slope", pct(s.slope) + " (limit " + pct(MAX_SLOPE) + ")", "slope", map.isOverHazardLimit("slope", s.slope));
    telemetry.appendChild(list);

    var more = el("details", "more");
    more.open = moreReadingsOpen;
    more.addEventListener("toggle", function () { moreReadingsOpen = more.open; });
    more.appendChild(el("summary", "", "More readings"));
    var extra = document.createElement("dl");
    addRow(extra, "Mode", (rover.mode === "auto" ? "Auto" : "Manual") +
      (rover.blocked ? " · " + BLOCK_WORDS[rover.blocked] : ""));
    addRow(extra, "Energy left", Math.round(rover.battery / 100 * BATTERY_WH).toLocaleString() +
      " of " + BATTERY_WH.toLocaleString() + " Wh");
    addRow(extra, "Battery change", (rover.drain > 0.01 ? "+" : "") + rover.drain.toFixed(1) + "% per second");
    addRow(extra, "Heading", compass(rover.heading));
    if (rover.mode === "auto" && rover.path) addRow(extra, "Route progress", pct(rover.s / rover.total));
    addRow(extra, "Position", data.formatLatLon ? latLon(rover.pos) : rover.pos.nx.toFixed(3) + ", " + rover.pos.ny.toFixed(3));
    addRow(extra, "Elevation", isFinite(s.elevation) ? Math.round(s.elevation).toLocaleString() + " m" : "no data");
    map.addRow(extra, "Mapped sand", pct(s.dustRisk), "dustRisk", map.isOverHazardLimit("dustRisk", s.dustRisk));
    addRow(extra, "Night-time IR", isFinite(s.nightIR) ? s.nightIR.toFixed(2) + " (relative)" : "no data");
    var unit = data.getUnit ? data.getUnit(s.geology) : null;
    if (unit) addRow(extra, "Geologic unit", unit.name);
    more.appendChild(extra);
    telemetry.appendChild(more);
    if (rover.mode === "auto" && rover.path && (rover.playing || rover.arrived)) {
      progressInput.value = String(Math.round(rover.s / rover.total * 1000));
    }
  }

  playBtn.addEventListener("click", function () {
    if (!rover.path || rover.dead) return;
    if (rover.arrived) {
      restart();
      return;
    }
    rover.playing = !rover.playing;
    rover.blocked = null;
    syncControls();
    renderTelemetry();
  });

  // Back to the start of the current route, and drive it again.
  function restart() {
    if (!rover.path) return;
    teleport(rover.path[0]);
    rover.s = 0;
    rover.arrived = false;
    rover.playing = !rover.dead;
    syncControls();
    renderTelemetry();
  }
  restartBtn.addEventListener("click", restart);

  // "Start over": full battery, back at the start site.
  document.getElementById("rb-reset").addEventListener("click", function () {
    rover.battery = 100;
    rover.dead = false;
    rover.stuck = false;
    everMoved = false;
    var site = sites[fromSelect.value];
    if (site) teleport(site);
    rover.heading = 0;
    origin = null;
    setMode("auto");
    plan();
    rover.playing = false;
    syncControls();
    renderTelemetry();
  });

  // "Wait and recharge": stop where you are and let the panels work.
  document.getElementById("rb-recharge").addEventListener("click", function () {
    rover.playing = false;
    rover.speed = 0;
    input.up = input.down = input.left = input.right = false;
    syncControls();
    renderTelemetry();
  });

  progressInput.addEventListener("input", function () {
    if (!rover.path) return;
    rover.playing = false;
    rover.s = progressInput.value / 1000 * rover.total;
    rover.arrived = rover.s >= rover.total;
    rover.pos = pointOn(rover.path, rover.cum, rover.s);
    refreshSample();
    if (scene3d) scene3d.resetTrail(); // a jump breaks the tracks
    syncControls();
    renderTelemetry();
  });

  modeAutoBtn.addEventListener("click", function () { setMode("auto"); });
  modeManualBtn.addEventListener("click", function () { setMode("manual"); });

  // Keyboard: W A S D or the arrow keys. Pressing one takes manual control.
  var KEYS = {
    ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
    ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right"
  };
  function typingIn(target) {
    return target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  }
  window.addEventListener("keydown", function (e) {
    var dir = KEYS[e.code];
    if (!dir || typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!rover.pos) return;
    setMode("manual");
    input[dir] = true;
  });
  window.addEventListener("keyup", function (e) {
    var dir = KEYS[e.code];
    if (dir) input[dir] = false;
  });
  window.addEventListener("blur", function () {
    input.up = input.down = input.left = input.right = false;
  });

  // On-screen pad: hold a button to drive.
  [].forEach.call(document.querySelectorAll("[data-drive]"), function (btn) {
    var dir = btn.getAttribute("data-drive");
    function release() { input[dir] = false; }
    btn.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      if (!rover.pos) return;
      setMode("manual");
      input[dir] = true;
    });
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
  });

  // ---- route panel events -------------------------------------------------------

  fromSelect.addEventListener("change", function () {
    var site = sites[fromSelect.value];
    if (!site) return;
    teleport(site);
    origin = null;
    plan();
    rover.playing = false;
    syncControls();
    renderTelemetry();
  });

  toSelect.addEventListener("change", function () {
    var site = sites[toSelect.value];
    var custom = toSelect.querySelector('option[value="custom"]');
    if (custom && toSelect.value !== "custom") custom.remove();
    setDestination(site ? { nx: site.nx, ny: site.ny, name: site.name } : null);
  });

  // With the Plan or Drive tab open, a click on the ground or the minimap
  // makes that spot the destination and its three routes appear, without
  // changing tab. Nothing moves until the user presses Start drive.
  var planPanel = document.getElementById("route-panel");
  map.onSelect(function (p) {
    if (!p || !(planPanel.open || panel.open)) return;
    var siteIdx = -1;
    sites.forEach(function (site, i) {
      if (site.nx === p.nx && site.ny === p.ny) siteIdx = i;
    });
    var custom = toSelect.querySelector('option[value="custom"]');
    if (rover.mode !== "auto") {
      rover.mode = "auto";
      input.up = input.down = input.left = input.right = false;
    }
    if (siteIdx >= 0) {
      if (custom) custom.remove();
      toSelect.value = String(siteIdx);
      setDestination({ nx: p.nx, ny: p.ny, name: sites[siteIdx].name });
      return;
    }
    if (!custom) {
      custom = document.createElement("option");
      custom.value = "custom";
      toSelect.appendChild(custom);
    }
    custom.textContent = "Clicked point (" + (data.formatLatLon ? latLon(p) : p.nx.toFixed(2) + ", " + p.ny.toFixed(2)) + ")";
    toSelect.value = "custom";
    setDestination({ nx: p.nx, ny: p.ny, name: custom.textContent });
  });

  function replanKeepDriving() {
    var wasPlaying = rover.playing;
    plan();
    rover.playing = wasPlaying && !!routes && rover.mode === "auto" && !rover.arrived && !rover.dead;
    syncControls();
  }

  avoidBox.addEventListener("change", replanKeepDriving);

  // Hazard sliders change what counts as hazard ground, so routes are re-planned.
  map.onHazardChange(function () {
    clearTimeout(planTimer);
    planTimer = setTimeout(replanKeepDriving, 120);
    renderTelemetry();
  });

  // ---- minimap marker ---------------------------------------------------------

  function updateMarker2d() {
    marker2d.hidden = !rover.pos;
    if (!rover.pos) return;
    marker2d.style.left = (rover.pos.nx * 100) + "%";
    marker2d.style.top = (rover.pos.ny * 100) + "%";
    marker2d.style.transform = "translate(-50%, -50%) rotate(" + rover.heading + "rad)";
  }

  // ---- main loop ----------------------------------------------------------------

  var last = 0;
  var sinceTelemetry = 0;
  function loop(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    step(dt);
    sinceTelemetry += dt;
    if (sinceTelemetry >= TELEMETRY_EVERY) {
      sinceTelemetry = 0;
      renderTelemetry();
      syncControls();
    }
    updateMarker2d();
    requestAnimationFrame(loop);
  }

  // ===========================================================================
  // RIDGEBACK IN 3D
  // ===========================================================================

  // Ridgeback's dimensions in world units (from ridgeback-rover-3d.html).
  var R = {
    wheelRadius: 0.45,
    track: 2.3,        // distance between left and right wheels
    wheelbase: 2.4     // front to back wheel
  };

  function build3d(api) {
    var T = api.THREE;
    var scene = api.scene;

    // ---- the Ridgeback model (geometry from ridgeback-rover-3d.html) --------

    var rover3d = new T.Group();
    function mat(c) {
      return new T.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.7, metalness: 0.1 });
    }
    function add(geo, c, px, py, pz, parent) {
      var m = new T.Mesh(geo, mat(c));
      m.position.set(px, py, pz);
      m.castShadow = true;
      (parent || rover3d).add(m);
      return m;
    }
    function B(w, h, d) { return new T.BoxGeometry(w, h, d); }

    add(B(1.6, 0.6, 2.6), 0xe8e4dc, 0, 1.25, 0);
    add(B(1.1, 0.2, 1.4), 0xb9b3a6, 0, 1.62, 0.2);
    var panelMesh = add(B(2.7, 0.08, 1.9), 0x1f3a5f, 0, 1.95, -0.15);
    panelMesh.rotation.x = -0.1;
    add(B(2.7, 0.1, 0.06), 0xe8e4dc, 0, 1.97, -1.1).rotation.x = -0.1;
    add(B(0.06, 0.1, 1.9), 0xe8e4dc, -1.35, 1.95, -0.15);
    add(B(0.06, 0.1, 1.9), 0xe8e4dc, 1.35, 1.95, -0.15);
    add(new T.CylinderGeometry(0.05, 0.05, 0.9, 8), 0x4a4a4a, -0.55, 2.1, 0.95);
    // Camera head on a group so it can scan.
    var head = new T.Group();
    head.position.set(-0.55, 2.62, 0.95);
    rover3d.add(head);
    add(B(0.5, 0.26, 0.3), 0xe8e4dc, 0, 0, 0, head);
    var eye = new T.Mesh(new T.SphereGeometry(0.08, 8, 6),
      new T.MeshStandardMaterial({ color: 0x14202b, emissive: 0x6fd3ff, emissiveIntensity: 0.6 }));
    eye.position.set(0, 0, 0.17);
    head.add(eye);
    add(new T.CylinderGeometry(0.04, 0.04, 0.7, 6), 0x4a4a4a, 0.6, 2.2, -0.85);
    var dish = add(new T.CylinderGeometry(0.42, 0.05, 0.12, 16), 0xe8e4dc, 0.6, 2.6, -0.85);
    dish.rotation.x = -0.5;

    // Headlights, which light the ground ahead.
    [-0.45, 0.45].forEach(function (x) {
      var lamp = new T.Mesh(B(0.22, 0.1, 0.04),
        new T.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c8, emissiveIntensity: 1.4 }));
      lamp.position.set(x, 1.3, 1.31);
      rover3d.add(lamp);
    });
    var headlight = new T.SpotLight(0xfff2d8, 0.8, 22, 0.6, 0.6, 1.2);
    headlight.position.set(0, 1.4, 1.3);
    headlight.target.position.set(0, -1, 9);
    rover3d.add(headlight);
    rover3d.add(headlight.target);

    var wheels = [];
    var wg = new T.CylinderGeometry(0.45, 0.45, 0.36, 14);
    var hg = new T.CylinderGeometry(0.18, 0.18, 0.4, 10);
    var sg = B(0.42, 0.07, 0.7);
    wg.rotateZ(Math.PI / 2);
    hg.rotateZ(Math.PI / 2);
    for (var sx = -1; sx <= 1; sx += 2) {
      add(B(0.08, 0.08, 2.8), 0x4a4a4a, sx * 0.95, 0.98, 0);
      for (var wz = 1.2; wz >= -1.2; wz -= 1.2) {
        add(B(0.08, 0.55, 0.08), 0x4a4a4a, sx * 0.95, 0.72, wz);
        var pv = new T.Group();
        pv.position.set(sx * 1.15, 0.45, wz);
        rover3d.add(pv);
        add(wg, 0x2a2a2a, 0, 0, 0, pv);
        add(hg, 0x9a9a9a, 0, 0, 0, pv);
        add(sg, 0x6a6a6a, 0, 0, 0, pv);
        wheels.push(pv);
      }
    }
    rover3d.visible = false;
    scene.add(rover3d);

    // ---- scenery rocks ---------------------------------------------------------
    //
    // Purely visual: boulders gather on steep ground (where Ridgeback can't go
    // anyway) and small pebbles are scattered elsewhere. Placement follows the
    // terrain's slope from MarsData, using a fixed seed so it never changes.

    var seed = 7;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var rockGeo = new T.DodecahedronGeometry(1, 0);
    var rockMat = new T.MeshStandardMaterial({ color: 0x8a4528, flatShading: true, roughness: 1 });
    var ROCKS = 900;
    var rocks = new T.InstancedMesh(rockGeo, rockMat, ROCKS);
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    var m4 = new T.Matrix4(), q = new T.Quaternion(), e3 = new T.Euler(), v3 = new T.Vector3(), s3v = new T.Vector3();
    var placed = 0;
    for (var tries = 0; tries < ROCKS * 8 && placed < ROCKS; tries++) {
      var rx = rand(), ry = rand();
      var slope = data.sampleTerrainAt(rx, ry).slope;
      var boulder = slope > 0.4;
      if (!boulder && rand() > 0.25) continue;
      if (boulder && rand() > slope) continue;
      var r = boulder ? 0.5 + rand() * 1.6 : 0.12 + rand() * 0.25;
      var p = api.surfacePoint(rx, ry, r * 0.25);
      e3.set(rand() * 3, rand() * 3, rand() * 3);
      q.setFromEuler(e3);
      s3v.set(r, r * 0.6, r * (0.8 + rand() * 0.4));
      m4.compose(v3.copy(p), q, s3v);
      rocks.setMatrixAt(placed++, m4);
    }
    rocks.count = placed;
    scene.add(rocks);

    // ---- route ribbons and destination beacon -------------------------------

    var tubes = [];
    var beacon = new T.Group();
    var ring = new T.Mesh(
      new T.RingGeometry(2.6, 3.4, 48),
      new T.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    beacon.add(ring);
    var beam = new T.Mesh(
      new T.CylinderGeometry(0.8, 2.4, 60, 24, 1, true),
      new T.MeshBasicMaterial({
        color: 0xffd166, transparent: true, opacity: 0.2,
        side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending, fog: false
      })
    );
    beam.position.y = 30;
    beacon.add(beam);
    beacon.visible = false;
    scene.add(beacon);

    function setRoutes(list, selKey, destination) {
      tubes.forEach(function (tube) {
        scene.remove(tube);
        tube.geometry.dispose();
        tube.material.dispose();
      });
      tubes = [];
      (list || []).forEach(function (r) {
        if (r.path.length < 2) return;
        var isSel = r.profile.key === selKey;
        var pts = r.path.map(function (p) { return api.surfacePoint(p.nx, p.ny, isSel ? 0.2 : 0.15); });
        var tube = new T.Mesh(
          new T.TubeGeometry(new T.CatmullRomCurve3(pts), Math.min(2000, pts.length * 3), isSel ? 0.14 : 0.07, 6, false),
          new T.MeshBasicMaterial({ color: r.profile.color, transparent: true, opacity: isSel ? 0.75 : 0.4, depthWrite: false })
        );
        scene.add(tube);
        tubes.push(tube);
      });
      beacon.visible = !!destination;
      if (destination) beacon.position.copy(api.surfacePoint(destination.nx, destination.ny, 0.12));
    }

    // ---- wheel tracks -------------------------------------------------------

    var TRAIL_MAX = 8000;
    var trailMat = new T.LineBasicMaterial({ color: 0x5a2a14, transparent: true, opacity: 0.8 });
    var trails = [-1, 1].map(function (side) {
      var geo = new T.BufferGeometry();
      geo.setAttribute("position", new T.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
      geo.setDrawRange(0, 0);
      var line = new T.Line(geo, trailMat);
      line.frustumCulled = false;
      scene.add(line);
      return { side: side, geo: geo, count: 0 };
    });
    var lastTrail = null;

    function resetTrail() {
      trails.forEach(function (tr) { tr.count = 0; tr.geo.setDrawRange(0, 0); });
      lastTrail = null;
      rover3d.userData.placed = false;
    }

    function addTrailPoint(center, right) {
      if (lastTrail && lastTrail.distanceTo(center) < 0.3) return;
      lastTrail = center.clone();
      trails.forEach(function (tr) {
        if (tr.count >= TRAIL_MAX) return;
        var off = right.clone().multiplyScalar(tr.side * R.track / 2);
        var m = api.toMap(center.x + off.x, center.z + off.z);
        var p = api.surfacePoint(m.nx, m.ny, 0.05);
        tr.geo.attributes.position.setXYZ(tr.count, p.x, p.y, p.z);
        tr.count++;
        tr.geo.setDrawRange(0, tr.count);
        tr.geo.attributes.position.needsUpdate = true;
      });
    }

    // ---- dust: puffs from the wheels and dust hanging in the air -------------

    var puffCanvas = document.createElement("canvas");
    puffCanvas.width = puffCanvas.height = 64;
    var pc = puffCanvas.getContext("2d");
    var grad = pc.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.45)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    pc.fillStyle = grad;
    pc.fillRect(0, 0, 64, 64);
    var puffTex = new T.CanvasTexture(puffCanvas);

    var PUFF_MAX = 160;
    var puffs = [];
    for (var i = 0; i < PUFF_MAX; i++) {
      var sprite = new T.Sprite(new T.SpriteMaterial({
        map: puffTex, color: 0xc9946a, transparent: true, opacity: 0, depthWrite: false
      }));
      sprite.visible = false;
      scene.add(sprite);
      puffs.push({ sprite: sprite, vel: new T.Vector3(), age: 0, life: 0, size: 0 });
    }
    var puffCursor = 0;
    var puffDebt = 0;

    function emitPuff(at, back, right, strength) {
      var p = puffs[puffCursor];
      puffCursor = (puffCursor + 1) % PUFF_MAX;
      p.sprite.position.copy(at);
      p.vel.copy(back).multiplyScalar(0.6 + Math.random() * 1.0)
        .addScaledVector(right, (Math.random() - 0.5) * 1.2);
      p.vel.y = 0.5 + Math.random() * 1.0;
      p.age = 0;
      p.life = 1.0 + Math.random() * 1.0;
      p.size = (0.35 + Math.random() * 0.35) * strength;
      p.sprite.visible = true;
    }

    function updatePuffs(dt) {
      for (var i = 0; i < PUFF_MAX; i++) {
        var p = puffs[i];
        if (!p.sprite.visible) continue;
        p.age += dt;
        if (p.age >= p.life) {
          p.sprite.visible = false;
          continue;
        }
        var k = p.age / p.life;
        p.vel.multiplyScalar(1 - dt * 1.5); // air drag
        p.vel.y -= dt * 0.35;               // weak Mars gravity pulls it back down
        p.sprite.position.addScaledVector(p.vel, dt);
        var s = p.size * (1 + k * 3);
        p.sprite.scale.set(s, s, s);
        p.sprite.material.opacity = Math.sin(Math.PI * k) * 0.6;
      }
    }

    // Airborne dust around the rover; thicker where the dust risk is higher.
    var MOTES = 500, MOTE_R = 35;
    var motePos = new Float32Array(MOTES * 3);
    var moteGeo = new T.BufferGeometry();
    moteGeo.setAttribute("position", new T.BufferAttribute(motePos, 3));
    var moteMat = new T.PointsMaterial({
      map: puffTex, color: 0xe2b58c, size: 0.35, transparent: true, opacity: 0, depthWrite: false
    });
    var motes = new T.Points(moteGeo, moteMat);
    motes.frustumCulled = false;
    scene.add(motes);
    var motesInit = false;
    var WIND = new T.Vector3(1.6, 0.05, 0.6);

    function updateMotes(dt, center, dust) {
      if (!motesInit) {
        for (var i = 0; i < MOTES; i++) {
          motePos[i * 3] = center.x + (Math.random() - 0.5) * 2 * MOTE_R;
          motePos[i * 3 + 1] = center.y + Math.random() * 12;
          motePos[i * 3 + 2] = center.z + (Math.random() - 0.5) * 2 * MOTE_R;
        }
        motesInit = true;
      }
      for (var j = 0; j < MOTES; j++) {
        var ix = j * 3;
        motePos[ix] += (WIND.x + Math.sin(j + motePos[ix + 1]) * 0.3) * dt;
        motePos[ix + 1] += Math.sin(j * 1.7 + motePos[ix] * 0.1) * 0.15 * dt;
        motePos[ix + 2] += WIND.z * dt;
        // Keep the motes in a box around the rover, wrapping round.
        var dx = motePos[ix] - center.x, dz = motePos[ix + 2] - center.z, dy = motePos[ix + 1] - center.y;
        if (dx > MOTE_R) motePos[ix] -= 2 * MOTE_R; else if (dx < -MOTE_R) motePos[ix] += 2 * MOTE_R;
        if (dz > MOTE_R) motePos[ix + 2] -= 2 * MOTE_R; else if (dz < -MOTE_R) motePos[ix + 2] += 2 * MOTE_R;
        if (dy > 14 || dy < -1) motePos[ix + 1] = center.y + Math.random() * 12;
      }
      moteGeo.attributes.position.needsUpdate = true;
      var target = Math.max(0, dust - 0.3) * 1.1;
      moteMat.opacity += (target - moteMat.opacity) * Math.min(1, dt * 1.5);
    }

    // ---- chase camera (Ridgeback's) -------------------------------------------
    //
    // Follows behind the rover. Drag to look around, scroll to zoom; the view
    // eases back behind the rover when you let go.

    var cam = { off: 0, p: 0.38, d: 13, h: 0 };
    var drag = null;
    var CAM_MIN = 5, CAM_MAX = 140;
    api.dom.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY };
      api.dom.setPointerCapture(e.pointerId);
    });
    api.dom.addEventListener("pointermove", function (e) {
      if (!drag) return;
      cam.off -= (e.clientX - drag.x) * 0.008;
      cam.p = Math.min(1.45, Math.max(0.08, cam.p + (e.clientY - drag.y) * 0.006));
      drag = { x: e.clientX, y: e.clientY };
    });
    ["pointerup", "pointercancel"].forEach(function (n) {
      api.dom.addEventListener(n, function () { drag = null; });
    });
    api.dom.addEventListener("wheel", function (e) {
      cam.d = Math.min(CAM_MAX, Math.max(CAM_MIN, cam.d * Math.exp(e.deltaY * 0.0012)));
      e.preventDefault();
    }, { passive: false });
    document.getElementById("cam-reset").addEventListener("click", function () {
      cam.off = 0; cam.p = 0.38; cam.d = 13;
    });
    document.getElementById("cam-overview").addEventListener("click", function () {
      cam.off = 0; cam.p = 1.2; cam.d = CAM_MAX;
    });

    function angleDiff(a, b) {
      var d = (a - b) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    }

    // ---- per-frame pose -----------------------------------------------------

    var targetQuat = new T.Quaternion();
    var basis = new T.Matrix4();
    var clock = 0;

    function surfaceAt(x, z) {
      var m = api.toMap(x, z);
      return api.surfacePoint(m.nx, m.ny, 0);
    }

    api.onFrame(function (dt) {
      clock += dt;
      updatePuffs(dt);

      // Destination beacon pulses.
      var pulse = 1 + Math.sin(clock * 3) * 0.15;
      ring.scale.set(pulse, pulse, pulse);
      ring.material.opacity = 0.55 + Math.sin(clock * 3) * 0.3;
      beam.material.opacity = 0.16 + Math.sin(clock * 3) * 0.05;

      rover3d.visible = !!rover.pos;
      if (!rover.pos) return;

      // Facing direction on the ground. (Heading is in map-width units, which
      // are proportional to world x/z.)
      var fwd = new T.Vector3(Math.cos(rover.heading), 0, Math.sin(rover.heading));
      var right = new T.Vector3(fwd.z, 0, -fwd.x);

      // Settle on the terrain: tilt from the four wheel corners.
      var c = api.surfacePoint(rover.pos.nx, rover.pos.ny, 0);
      var F = surfaceAt(c.x + fwd.x * R.wheelbase / 2, c.z + fwd.z * R.wheelbase / 2);
      var Bk = surfaceAt(c.x - fwd.x * R.wheelbase / 2, c.z - fwd.z * R.wheelbase / 2);
      var Rt = surfaceAt(c.x + right.x * R.track / 2, c.z + right.z * R.track / 2);
      var Lt = surfaceAt(c.x - right.x * R.track / 2, c.z - right.z * R.track / 2);
      var f3 = F.clone().sub(Bk).normalize();
      var s3 = Rt.clone().sub(Lt).normalize();
      // Model axes: X = right, Y = up, Z = forward, with X = Y x Z.
      var up = new T.Vector3().crossVectors(f3, s3).normalize();
      if (up.y < 0) up.negate();
      var xAxis = new T.Vector3().crossVectors(up, f3).normalize();
      var zAxis = new T.Vector3().crossVectors(xAxis, up).normalize();
      basis.makeBasis(xAxis, up, zAxis);
      targetQuat.setFromRotationMatrix(basis);
      if (!rover3d.userData.placed) {
        rover3d.quaternion.copy(targetQuat);
        rover3d.userData.placed = true;
      } else {
        rover3d.quaternion.slerp(targetQuat, 1 - Math.exp(-dt * 8));
      }
      var groundY = (F.y + Bk.y + Rt.y + Lt.y) / 4;
      rover3d.position.set(c.x, Math.max(groundY, c.y - 0.1), c.z);

      // Wheels roll with the distance covered; they spin in place when dug in.
      var worldSpeed = rover.speed * api.planeWidth;
      var spinning = rover.blocked === "deepSand" && input.up && !rover.dead;
      var spin = spinning ? 4 : worldSpeed;
      wheels.forEach(function (w) { w.rotation.x += spin * dt / R.wheelRadius; });

      // Camera head scans, dish turns slowly.
      head.rotation.y = Math.sin(clock * 0.7) * 0.6;
      dish.rotation.y = clock * 0.25;
      headlight.intensity = rover.dead ? 0 : 0.8;

      if (worldSpeed || spinning) {
        if (worldSpeed) addTrailPoint(rover3d.position, xAxis);
        var dir = worldSpeed < 0 ? -1 : 1;
        var dustAmt = rover.sample ? rover.sample.dustRisk : 0.3;
        puffDebt += dt * (8 + 60 * dustAmt) * (spinning ? 2 : Math.min(2, speedMul()));
        var back = zAxis.clone().multiplyScalar(-dir);
        while (puffDebt >= 1) {
          puffDebt -= 1;
          var side = Math.random() < 0.5 ? -1 : 1;
          var at = rover3d.position.clone()
            .addScaledVector(zAxis, -dir * R.wheelbase / 2)
            .addScaledVector(xAxis, side * R.track / 2);
          at.y += 0.3;
          emitPuff(at, back, xAxis, spinning ? 1.6 : 1);
        }
      }
      updateMotes(dt, rover3d.position, rover.sample ? rover.sample.dustRisk : 0);

      // Sun follows the rover so its shadow stays crisp.
      api.sun.position.set(c.x + 40, c.y + 60, c.z + 25);
      api.sun.target.position.copy(rover3d.position);

      // Chase camera: ease behind the rover's heading, keep above the ground.
      var h = Math.atan2(fwd.x, fwd.z);
      cam.h += angleDiff(h, cam.h) * Math.min(1, dt * 3);
      if (!drag) cam.off *= 1 - Math.min(1, dt * 0.8);
      var a = cam.h + Math.PI + cam.off;
      var cx = c.x + Math.sin(a) * Math.cos(cam.p) * cam.d;
      var cz = c.z + Math.cos(a) * Math.cos(cam.p) * cam.d;
      var cy = Math.max(rover3d.position.y + 1.4 + Math.sin(cam.p) * cam.d, surfaceAt(cx, cz).y + 1);
      api.camera.position.set(cx, cy, cz);
      api.camera.lookAt(c.x, rover3d.position.y + 1.2, c.z);
    });

    return { setRoutes: setRoutes, resetTrail: resetTrail };
  }

  // ---- start ----------------------------------------------------------------

  // For walk.js: where Ridgeback is parked, and keeping it parked while
  // someone is outside on foot.
  window.Ridgeback = {
    position: function () { return rover.pos ? { nx: rover.pos.nx, ny: rover.pos.ny } : null; },
    isMoving: function () { return rover.playing || Math.abs(rover.speed) > 1e-6; },
    timeScale: function () { return TIME_SCALE * speedMul(); }, // mission seconds per real second
    setLocked: function (on) {
      locked = !!on;
      if (locked) {
        rover.playing = false;
        rover.speed = 0;
        input.up = input.down = input.left = input.right = false;
      }
      syncControls();
      renderTelemetry();
    }
  };

  fillSelect(fromSelect, firstOfType("landing", 0), "");
  fillSelect(toSelect, -1, "None");
  buildRouteLegend();
  map.addOverlay(drawRoutes);
  map.on3dReady(function (api) {
    scene3d = build3d(api);
    scene3d.setRoutes(routes, selectedKey, dest);
    syncControls();
  });

  var startSite = sites[fromSelect.value];
  if (startSite) teleport(startSite);
  // No destination yet: the map starts clean, with no routes drawn.
  setDestination(null);
  requestAnimationFrame(loop);

  import("./content.js").then(function (mod) {
    TEXT = mod.content;
    applyContent();
  }).catch(function () {
    rbStatus.textContent = "content.js could not be loaded (open the page through a local web server).";
  });
})();

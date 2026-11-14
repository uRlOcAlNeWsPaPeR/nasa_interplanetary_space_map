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
  var sendBtn = document.getElementById("send-rover");
  var legendRoutes = document.getElementById("map-legend-routes");

  // ---- planner tuning (behaviour, not data) ---------------------------------

  var GRID_W = 120;
  var GRID_H = 90;
  var ASPECT = canvas.height / canvas.width; // so lengths are in map widths

  // Three ways to weigh distance against hazards. Cost per unit distance is
  // 1 + hazard * (1 if on hazard ground) + risk * (0-1 terrain risk).
  // "Hazard ground" is the same measure the route comparison reports, so the
  // safest option really does minimise it. Shortest is straightened into
  // direct lines wherever nothing blocks them.
  var PROFILES = [
    { key: "safest", name: "Safest", goal: "Minimises overall hazard exposure", hazard: 30, risk: 6, color: "#7dffa0" },
    { key: "shortest", name: "Shortest", goal: "Minimises distance", hazard: 0, risk: 0, straight: true, color: "#ffffff" },
    { key: "balanced", name: "Balanced", goal: "Balances distance and safety", hazard: 4, risk: 2, color: "#ffd166" }
  ];
  var AVOID_PENALTY = 200; // extra cost for a cell inside a highlighted hazard zone
  // Used to judge "hazard ground" when a hazard's highlight slider is off.
  var CAUTION = { slope: 0.4, dustRisk: 0.65 };
  var HAZARD_WORDS = { slope: "steep slope", dustRisk: "loose dust" };
  var RISK_LEVELS = [
    { below: 0.3, name: "Low", color: "#5fd08a" },
    { below: 0.5, name: "Moderate", color: "#ffd166" },
    { below: 0.75, name: "High", color: "#ff9f43" },
    { below: Infinity, name: "Severe", color: "#ff5a4f" }
  ];

  // ---- driving tuning ---------------------------------------------------------

  var DRIVE_SPEED = 0.045;     // map widths per second on flat ground, at 1x
  var SLOPE_SLOWDOWN = 0.7;    // at 100% slope the rover runs at 30% speed
  var DUST_SLOWDOWN = 0.25;    // deep dust costs up to 25% more
  var REVERSE_FACTOR = 0.5;    // reverse is half speed
  var ACCEL = 3.5;             // how quickly manual speed follows the throttle
  var TURN_RATE = 1.5;         // radians per second at 1x
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
      var c = 1 + (onHazard ? profile.hazard : 0) + profile.risk * risk;
      if ((limS !== null && s > limS) || (limD !== null && d > limD)) c += AVOID_PENALTY;
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
    if (maxCost >= AVOID_PENALTY) maxCost = 1; // path had to cross a zone; keep elsewhere clear
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
      if (m.length <= minLen * 1.01) r.pros.push("Shortest distance");
      else r.cons.push("+" + pct(m.length / minLen - 1) + " distance vs the shortest");
      if (m.time <= minTime * 1.01) r.pros.push("Fastest drive");
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
    var S = by("safest").metrics, B = by("balanced").metrics, H = by("shortest").metrics;
    var pick, reason;
    if (H.hazShare <= S.hazShare + 0.02 && H.risk <= S.risk + 0.03) {
      pick = "shortest";
      reason = "The direct line is about as safe as any detour, so there is no reason to go further.";
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
    follow: false,
    sample: null,    // terrain under the rover
    blocked: null,   // why manual movement was stopped, if it was
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
      planMessage = "Pick a destination, or click the map and press “Send rover here”.";
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

  function setDestination(d, autoPlay) {
    dest = d;
    plan();
    if (routes && rover.mode === "auto" && autoPlay) rover.playing = true;
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
      : "Turn on a hazard highlight (left) to mark zones to avoid.";
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
        m.length.toFixed(2) + "× · " + formatTime(m.time) + " · " +
        pct(m.hazShare) + " hazard · risk " + Math.round(m.risk * 100)));

      var list = el("ul", "route-points");
      r.pros.forEach(function (t) { list.appendChild(el("li", "pro", t)); });
      r.cons.forEach(function (t) { list.appendChild(el("li", "con", t)); });
      card.appendChild(list);
      optionsEl.appendChild(card);
    });

    summary.appendChild(el("p", "recommend", "Recommended: " +
      routes.filter(function (r) { return r.profile.key === recommended.key; })[0].profile.name +
      ". " + recommended.reason));

    var sel = selectedRoute();
    var m = sel.metrics;
    summary.appendChild(el("h3", "", sel.profile.name + " route"));
    var dl = document.createElement("dl");
    addRow(dl, "Length", m.length.toFixed(2) + " × map width");
    addRow(dl, "Drive time (1×)", formatTime(m.time));
    addRow(dl, "Total climb", Math.round(m.climb) + " m");
    map.addRow(dl, "Slope exposure", pct(m.slopeShare) + " above " + pct(threshold("slope")), "slope", m.slopeShare > 0.005);
    map.addRow(dl, "Dust exposure", pct(m.dustShare) + " above " + pct(threshold("dustRisk")), "dustRisk", m.dustShare > 0.005);
    addRow(dl, "Hazard crossings", String(m.crossings));
    addRow(dl, "Risk score", Math.round(m.risk * 100) + " / 100 · " + riskLevel(m.risk).name);
    summary.appendChild(dl);

    summary.appendChild(el("h3", "", "Areas of concern"));
    if (!m.stretches.length) {
      summary.appendChild(el("p", "empty", "None on this route."));
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
      summary.appendChild(ul);
      if (m.stretches.length > worst.length) {
        summary.appendChild(el("p", "empty", "Plus " + (m.stretches.length - worst.length) + " shorter stretches."));
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
  // DRIVING
  // ===========================================================================

  var panel = document.getElementById("rover-panel");
  var modeAutoBtn = document.getElementById("mode-auto");
  var modeManualBtn = document.getElementById("mode-manual");
  var playBtn = document.getElementById("rover-play");
  var restartBtn = document.getElementById("rover-restart");
  var followBtn = document.getElementById("rover-follow");
  var speedSelect = document.getElementById("rover-speed");
  var progressInput = document.getElementById("rover-progress");
  var telemetry = document.getElementById("rover-telemetry");
  var marker2d = document.getElementById("rover-2d");
  var riskHud = document.getElementById("risk-hud");
  var riskLevelEl = document.getElementById("risk-level");
  var riskFill = document.getElementById("risk-fill");
  var riskCause = document.getElementById("risk-cause");

  var input = { up: false, down: false, left: false, right: false };
  var movedSincePlan = 0;
  var sincePlan = 0;

  function speedMul() { return Number(speedSelect.value) || 1; }

  function stepAuto(dt) {
    if (!rover.path || !rover.playing) {
      rover.speed = 0;
      return;
    }
    rover.speed = DRIVE_SPEED * speedMul() * speedFactor(rover.sample);
    rover.s += rover.speed * dt;
    if (rover.s >= rover.total) {
      rover.s = rover.total;
      rover.playing = false;
      rover.arrived = true;
      rover.speed = 0;
      syncControls();
    }
    rover.pos = pointOn(rover.path, rover.cum, rover.s);
    var a = pointOn(rover.path, rover.cum, rover.s - 0.006);
    var b = pointOn(rover.path, rover.cum, rover.s + 0.006);
    if (a.nx !== b.nx || a.ny !== b.ny) {
      rover.heading = Math.atan2((b.ny - a.ny) * ASPECT, b.nx - a.nx);
    }
  }

  function stepManual(dt) {
    var throttle = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    var steer = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var mul = speedMul();
    var target = throttle * DRIVE_SPEED * mul * speedFactor(rover.sample) * (throttle < 0 ? REVERSE_FACTOR : 1);
    rover.speed += (target - rover.speed) * (1 - Math.exp(-dt * ACCEL));
    if (!throttle && Math.abs(rover.speed) < DRIVE_SPEED * 0.02) rover.speed = 0;
    rover.heading += steer * TURN_RATE * Math.min(2, mul) * dt;
    if (throttle || steer) rover.blocked = null;
    if (!rover.speed) return;

    var nx = rover.pos.nx + Math.cos(rover.heading) * rover.speed * dt;
    var ny = rover.pos.ny + Math.sin(rover.heading) * rover.speed * dt / ASPECT;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      rover.blocked = "edge of the map";
      rover.speed = 0;
      return;
    }
    // With "avoid hazard zones" on, the rover refuses to enter a highlighted
    // zone. If it is already inside one it may keep moving, so it can get out.
    if (avoidBox.checked && !zoneOf(rover.sample)) {
      var zone = zoneOf(data.sampleTerrainAt(nx, ny));
      if (zone) {
        rover.blocked = HAZARD_WORDS[zone] + " zone ahead";
        rover.speed = 0;
        return;
      }
    }
    movedSincePlan += mapDist(rover.pos, { nx: nx, ny: ny });
    rover.pos = { nx: nx, ny: ny };
  }

  function step(dt) {
    if (!rover.pos) return;
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
    }
    refreshSample();
  }

  function setMode(mode) {
    if (rover.mode === mode) return;
    rover.mode = mode;
    rover.speed = 0;
    rover.blocked = null;
    if (mode === "manual") {
      rover.playing = false;
    } else {
      // Back to automatic: plan from wherever the rover was driven to, and go.
      input.up = input.down = input.left = input.right = false;
      plan();
      rover.playing = !!routes && !rover.arrived;
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
    playBtn.disabled = !has;
    restartBtn.disabled = !has;
    progressInput.disabled = !has || !auto;
    playBtn.textContent = rover.playing ? "Pause" : rover.arrived ? "Drive again" : "Drive";
    playBtn.setAttribute("aria-pressed", String(rover.playing));
    followBtn.setAttribute("aria-pressed", String(rover.follow));
    followBtn.disabled = !scene3d || map.viewMode() !== "3d";
    progressInput.value = has && rover.total ? String(Math.round(rover.s / rover.total * 1000)) : "0";
  }

  function compass(heading) {
    var deg = ((heading * 180 / Math.PI + 90) % 360 + 360) % 360; // 0 = map north (up)
    var names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return names[Math.round(deg / 45) % 8] + " " + Math.round(deg) + "°";
  }

  function statusText() {
    var s = rover.sample;
    if (rover.mode === "manual") {
      if (rover.blocked) return "Blocked · " + rover.blocked;
      if (dest && mapDist(rover.pos, dest) < ARRIVE_RADIUS) return "At destination";
      if (!rover.speed) return "Manual · stopped";
      return rover.speed < 0 ? "Manual · reversing" : "Manual · driving";
    }
    if (rover.arrived) return "Arrived";
    if (!rover.path) return "No route";
    if (!rover.playing) return rover.s > 0 ? "Paused" : "Ready";
    if (s.slope > threshold("slope")) return "Crawling · steep ground";
    if (s.dustRisk > threshold("dustRisk")) return "Slowed · loose dust";
    return "Driving route";
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

  function renderTelemetry() {
    telemetry.textContent = "";
    renderRisk();
    if (!rover.pos || !rover.sample) return;
    var s = rover.sample;
    var list = document.createElement("dl");
    addRow(list, "Status", statusText());
    addRow(list, "Heading", compass(rover.heading));
    addRow(list, "Speed", pct(Math.abs(rover.speed) / (DRIVE_SPEED * speedMul())) + " of top speed");
    if (dest) addRow(list, "To destination", mapDist(rover.pos, dest).toFixed(2) + " × map width");
    if (rover.mode === "auto" && rover.path) addRow(list, "Route progress", pct(rover.s / rover.total));
    addRow(list, "Elevation", Math.round(s.elevation) + " m");
    map.addRow(list, "Slope", pct(s.slope), "slope", map.isOverHazardLimit("slope", s.slope));
    map.addRow(list, "Dust risk", pct(s.dustRisk), "dustRisk", map.isOverHazardLimit("dustRisk", s.dustRisk));
    addRow(list, "Temperature", s.temperature.toFixed(1) + " °C");
    telemetry.appendChild(list);
    if (rover.mode === "auto" && rover.path && (rover.playing || rover.arrived)) {
      progressInput.value = String(Math.round(rover.s / rover.total * 1000));
    }
  }

  playBtn.addEventListener("click", function () {
    if (!rover.path) return;
    if (rover.arrived) {
      restart();
      return;
    }
    rover.playing = !rover.playing;
    syncControls();
    renderTelemetry();
  });

  // Back to the start of the current route, and drive it again.
  function restart() {
    if (!rover.path) return;
    teleport(rover.path[0]);
    rover.s = 0;
    rover.arrived = false;
    rover.playing = true;
    syncControls();
    renderTelemetry();
  }
  restartBtn.addEventListener("click", restart);

  followBtn.addEventListener("click", function () {
    rover.follow = !rover.follow;
    syncControls();
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
    rover.playing = !!routes && rover.mode === "auto" && !reduceMotion;
    syncControls();
    renderTelemetry();
  });

  toSelect.addEventListener("change", function () {
    var site = sites[toSelect.value];
    var custom = toSelect.querySelector('option[value="custom"]');
    if (custom && toSelect.value !== "custom") custom.remove();
    setDestination(site ? { nx: site.nx, ny: site.ny, name: site.name } : null, !reduceMotion);
  });

  // "Send rover here": the clicked map point becomes the destination.
  sendBtn.addEventListener("click", function () {
    var p = map.getSelected();
    if (!p) return;
    var siteIdx = -1;
    sites.forEach(function (site, i) {
      if (site.nx === p.nx && site.ny === p.ny) siteIdx = i;
    });
    var custom = toSelect.querySelector('option[value="custom"]');
    if (siteIdx >= 0) {
      if (custom) custom.remove();
      toSelect.value = String(siteIdx);
      setDestination({ nx: p.nx, ny: p.ny, name: sites[siteIdx].name }, true);
      return;
    }
    if (!custom) {
      custom = document.createElement("option");
      custom.value = "custom";
      toSelect.appendChild(custom);
    }
    custom.textContent = "Clicked point (" + p.nx.toFixed(2) + ", " + p.ny.toFixed(2) + ")";
    toSelect.value = "custom";
    setDestination({ nx: p.nx, ny: p.ny, name: custom.textContent }, true);
  });

  function replanKeepDriving() {
    var wasPlaying = rover.playing;
    plan();
    rover.playing = wasPlaying && !!routes && rover.mode === "auto" && !rover.arrived;
    syncControls();
  }

  avoidBox.addEventListener("change", replanKeepDriving);

  // Hazard sliders change what counts as hazard ground, so routes are re-planned.
  map.onHazardChange(function () {
    clearTimeout(planTimer);
    planTimer = setTimeout(replanKeepDriving, 120);
    renderTelemetry();
  });

  map.onViewChange(function () {
    if (map.viewMode() !== "3d") rover.follow = false;
    syncControls();
    updateMarker2d();
  });

  // ---- 2D marker ------------------------------------------------------------

  function updateMarker2d() {
    var show = !!rover.pos && map.viewMode() !== "3d";
    marker2d.hidden = !show;
    if (!show) return;
    marker2d.style.left = (rover.pos.nx * 100) + "%";
    marker2d.style.top = (rover.pos.ny * 100) + "%";
    marker2d.style.transform = "translate(-50%, -50%) rotate(" + rover.heading + "rad)";
  }

  // ---- main loop (runs in both views) ---------------------------------------

  var last = 0;
  var sinceTelemetry = 0;
  function loop(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    var before = rover.speed;
    step(dt);
    sinceTelemetry += dt;
    var active = rover.playing || rover.speed || before || input.left || input.right || rover.blocked;
    if (active && sinceTelemetry >= TELEMETRY_EVERY) {
      sinceTelemetry = 0;
      renderTelemetry();
    }
    updateMarker2d();
    requestAnimationFrame(loop);
  }

  // ===========================================================================
  // ROVER IN 3D
  // ===========================================================================

  // Rover model dimensions, in world units (the map is ~4 units wide).
  // The rover is drawn far larger than true scale so it reads on the map.
  var R = {
    wheelRadius: 0.017,
    wheelWidth: 0.013,
    track: 0.088,      // distance between left and right wheels
    wheelbase: 0.092,  // front to back wheel
    rideHeight: 0.03
  };

  function build3d(api) {
    var T = api.THREE;
    var scene = api.scene;

    function std(color, opts) {
      opts = opts || {};
      return new T.MeshStandardMaterial({
        color: color,
        roughness: opts.roughness !== undefined ? opts.roughness : 0.6,
        metalness: opts.metalness !== undefined ? opts.metalness : 0.1,
        emissive: opts.emissive || 0x000000,
        emissiveIntensity: opts.emissiveIntensity || 1
      });
    }

    var MAT = {
      body: std(0xece6da, { roughness: 0.45, metalness: 0.15 }),
      dark: std(0x2a2d33, { roughness: 0.5, metalness: 0.4 }),
      deck: std(0xc9c2b4, { roughness: 0.55, metalness: 0.2 }),
      metal: std(0x9aa0a8, { roughness: 0.35, metalness: 0.85 }),
      gold: std(0xd4a43a, { roughness: 0.3, metalness: 0.9 }),
      tire: std(0x3a3532, { roughness: 0.9, metalness: 0.05 }),
      lens: std(0x111111, { roughness: 0.1, metalness: 0.2, emissive: 0x6fd3ff, emissiveIntensity: 0.9 }),
      lamp: std(0xffffff, { emissive: 0xfff2c8, emissiveIntensity: 1.6 })
    };

    function box(w, h, d, mat) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    }
    function cyl(rTop, rBot, h, mat, seg) {
      var m = new T.Mesh(new T.CylinderGeometry(rTop, rBot, h, seg || 16), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    }

    // Local axes: +X right, +Y up, +Z forward.
    var rover3d = new T.Group();
    var body = new T.Group();
    body.position.y = R.rideHeight;
    rover3d.add(body);

    // Chassis: white warm-box with a gold-foil belly and a light deck.
    body.add(box(0.062, 0.022, 0.088, MAT.body));
    var belly = box(0.056, 0.006, 0.08, MAT.gold);
    belly.position.y = -0.014;
    body.add(belly);
    var deck = box(0.068, 0.004, 0.094, MAT.deck);
    deck.position.y = 0.013;
    body.add(deck);
    var inst1 = box(0.02, 0.01, 0.024, MAT.body);
    inst1.position.set(0.016, 0.02, -0.01);
    body.add(inst1);
    var inst2 = box(0.016, 0.008, 0.018, MAT.gold);
    inst2.position.set(-0.012, 0.019, 0.018);
    body.add(inst2);

    // RTG power unit, angled off the back, with cooling fins.
    var rtg = new T.Group();
    rtg.position.set(0, 0.01, -0.056);
    rtg.rotation.x = -0.55;
    var rtgCore = cyl(0.009, 0.009, 0.034, MAT.dark, 12);
    rtgCore.rotation.x = Math.PI / 2;
    rtg.add(rtgCore);
    for (var f = 0; f < 4; f++) {
      var fin = box(0.03, 0.002, 0.026, MAT.metal);
      fin.rotation.z = f * Math.PI / 4;
      rtg.add(fin);
    }
    body.add(rtg);

    // Mast with a camera head that scans side to side.
    var mast = cyl(0.0028, 0.0034, 0.07, MAT.metal, 10);
    mast.position.set(0.022, 0.05, 0.034);
    body.add(mast);
    var head = new T.Group();
    head.position.set(0.022, 0.088, 0.034);
    head.add(box(0.026, 0.011, 0.012, MAT.body));
    [-0.007, 0.007].forEach(function (x) {
      var eye = cyl(0.003, 0.003, 0.006, MAT.lens, 12);
      eye.rotation.x = Math.PI / 2;
      eye.position.set(x, 0, 0.008);
      head.add(eye);
    });
    body.add(head);

    // High-gain antenna dish.
    var dishPost = cyl(0.002, 0.002, 0.016, MAT.metal, 8);
    dishPost.position.set(-0.02, 0.022, -0.02);
    body.add(dishPost);
    var dish = new T.Group();
    dish.position.set(-0.02, 0.031, -0.02);
    dish.add(cyl(0.013, 0.006, 0.004, MAT.metal, 20));
    dish.rotation.x = 0.7;
    body.add(dish);

    // Robotic arm folded across the front, with a turret.
    var arm1 = box(0.044, 0.004, 0.004, MAT.metal);
    arm1.position.set(0, -0.002, 0.05);
    body.add(arm1);
    var turret = cyl(0.007, 0.007, 0.01, MAT.dark, 12);
    turret.position.set(-0.022, -0.002, 0.05);
    body.add(turret);

    // Headlights.
    [-0.02, 0.02].forEach(function (x) {
      var lamp = box(0.008, 0.004, 0.002, MAT.lamp);
      lamp.position.set(x, 0.004, 0.045);
      body.add(lamp);
    });
    var headlight = new T.SpotLight(0xfff2d8, 0.9, 0.7, 0.55, 0.6, 1.5);
    headlight.position.set(0, 0.02, 0.05);
    headlight.target.position.set(0, -0.08, 0.35);
    body.add(headlight);
    body.add(headlight.target);

    // Wheels on a rocker-bogie: 3 per side, each in a pivot that spins.
    var wheels = [];
    var zs = [R.wheelbase / 2, 0, -R.wheelbase / 2];
    [-1, 1].forEach(function (side) {
      var x = side * R.track / 2;
      zs.forEach(function (z) {
        var pivot = new T.Group();
        pivot.position.set(x, R.wheelRadius, z);
        var tire = cyl(R.wheelRadius, R.wheelRadius, R.wheelWidth, MAT.tire, 20);
        tire.rotation.z = Math.PI / 2;
        pivot.add(tire);
        // Grousers (treads) so the spin is visible.
        for (var g = 0; g < 6; g++) {
          var grouser = box(R.wheelWidth * 1.04, 0.0025, 0.004, MAT.dark);
          var a = g / 6 * Math.PI * 2;
          grouser.position.set(0, Math.cos(a) * R.wheelRadius, Math.sin(a) * R.wheelRadius);
          grouser.rotation.x = -a;
          pivot.add(grouser);
        }
        var hub = cyl(0.006, 0.006, R.wheelWidth * 1.1, MAT.metal, 12);
        hub.rotation.z = Math.PI / 2;
        pivot.add(hub);
        rover3d.add(pivot);
        wheels.push(pivot);
      });
      var rocker = box(0.004, 0.004, R.wheelbase * 0.62, MAT.metal);
      rocker.position.set(x * 0.92, R.rideHeight * 0.85, R.wheelbase * 0.18);
      rocker.rotation.x = 0.35;
      rover3d.add(rocker);
      var bogie = box(0.004, 0.004, R.wheelbase * 0.55, MAT.metal);
      bogie.position.set(x * 0.92, R.wheelRadius * 1.5, -R.wheelbase * 0.25);
      bogie.rotation.x = -0.25;
      rover3d.add(bogie);
    });

    rover3d.visible = false;
    scene.add(rover3d);

    // ---- route ribbons and destination beacon -------------------------------

    var tubes = [];
    var beacon = new T.Group();
    var ring = new T.Mesh(
      new T.RingGeometry(0.03, 0.04, 40),
      new T.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, side: T.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    beacon.add(ring);
    var beam = new T.Mesh(
      new T.CylinderGeometry(0.012, 0.03, 0.5, 24, 1, true),
      new T.MeshBasicMaterial({
        color: 0xffd166, transparent: true, opacity: 0.18,
        side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending
      })
    );
    beam.position.y = 0.25;
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
        var pts = r.path.map(function (p) { return api.surfacePoint(p.nx, p.ny, isSel ? 0.008 : 0.005); });
        var tube = new T.Mesh(
          new T.TubeGeometry(new T.CatmullRomCurve3(pts), Math.min(600, pts.length * 2), isSel ? 0.004 : 0.002, 6, false),
          new T.MeshBasicMaterial({ color: r.profile.color, transparent: true, opacity: isSel ? 0.95 : 0.5 })
        );
        scene.add(tube);
        tubes.push(tube);
      });
      beacon.visible = !!destination;
      if (destination) beacon.position.copy(api.surfacePoint(destination.nx, destination.ny, 0.004));
    }

    // ---- wheel tracks -------------------------------------------------------

    var TRAIL_MAX = 6000;
    var trailMat = new T.LineBasicMaterial({ color: 0x2a170d, transparent: true, opacity: 0.75 });
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
      trails.forEach(function (t) { t.count = 0; t.geo.setDrawRange(0, 0); });
      lastTrail = null;
      rover3d.userData.placed = false;
    }

    function addTrailPoint(center, right) {
      if (lastTrail && lastTrail.distanceTo(center) < 0.006) return;
      lastTrail = center.clone();
      trails.forEach(function (t) {
        if (t.count >= TRAIL_MAX) return;
        var off = right.clone().multiplyScalar(t.side * R.track / 2);
        var m = api.toMap(center.x + off.x, center.z + off.z);
        var p = api.surfacePoint(m.nx, m.ny, 0.0015);
        t.geo.attributes.position.setXYZ(t.count, p.x, p.y, p.z);
        t.count++;
        t.geo.setDrawRange(0, t.count);
        t.geo.attributes.position.needsUpdate = true;
      });
    }

    // ---- dust kicked up by the wheels --------------------------------------

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

    var PUFF_MAX = 140;
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

    function emitPuff(at, back, right) {
      var p = puffs[puffCursor];
      puffCursor = (puffCursor + 1) % PUFF_MAX;
      p.sprite.position.copy(at);
      p.vel.copy(back).multiplyScalar(0.02 + Math.random() * 0.03)
        .addScaledVector(right, (Math.random() - 0.5) * 0.04);
      p.vel.y = 0.015 + Math.random() * 0.03;
      p.age = 0;
      p.life = 0.9 + Math.random() * 0.9;
      p.size = 0.012 + Math.random() * 0.01;
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
        var t = p.age / p.life;
        p.vel.multiplyScalar(1 - dt * 1.5); // air drag
        p.vel.y -= dt * 0.012;              // weak Mars gravity pulls it back down
        p.sprite.position.addScaledVector(p.vel, dt);
        var s = p.size * (1 + t * 3);
        p.sprite.scale.set(s, s, s);
        p.sprite.material.opacity = Math.sin(Math.PI * t) * 0.55;
      }
    }

    // ---- per-frame pose -----------------------------------------------------

    var targetQuat = new T.Quaternion();
    var basis = new T.Matrix4();
    var wheelAngle = 0;
    var clock = 0;
    var camOffset = new T.Vector3();
    var followTarget = new T.Vector3();

    function surfaceAt(x, z) {
      var m = api.toMap(x, z);
      return api.surfacePoint(m.nx, m.ny, 0);
    }

    api.onFrame(function (dt) {
      clock += dt;
      updatePuffs(dt);

      // Destination beacon pulses.
      var pulse = 1 + Math.sin(clock * 3) * 0.18;
      ring.scale.set(pulse, pulse, pulse);
      ring.material.opacity = 0.55 + Math.sin(clock * 3) * 0.3;
      beam.material.opacity = 0.14 + Math.sin(clock * 3) * 0.05;

      rover3d.visible = !!rover.pos;
      if (!rover.pos) return;

      // Facing direction on the ground plane. (Heading is measured in
      // map-width units, which are proportional to world x/z.)
      var fwd = new T.Vector3(Math.cos(rover.heading), 0, Math.sin(rover.heading));
      var right = new T.Vector3(fwd.z, 0, -fwd.x);

      // Settle the rover on the terrain: tilt from the four wheel corners.
      var c = api.surfacePoint(rover.pos.nx, rover.pos.ny, 0);
      var F = surfaceAt(c.x + fwd.x * R.wheelbase / 2, c.z + fwd.z * R.wheelbase / 2);
      var B = surfaceAt(c.x - fwd.x * R.wheelbase / 2, c.z - fwd.z * R.wheelbase / 2);
      var Rt = surfaceAt(c.x + right.x * R.track / 2, c.z + right.z * R.track / 2);
      var Lt = surfaceAt(c.x - right.x * R.track / 2, c.z - right.z * R.track / 2);
      var f3 = F.clone().sub(B).normalize();
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
      var groundY = (F.y + B.y + Rt.y + Lt.y) / 4;
      rover3d.position.set(c.x, Math.max(groundY, c.y - 0.004), c.z);

      // Wheels roll with the distance actually covered (backwards in reverse).
      var worldSpeed = rover.speed * api.planeWidth;
      wheelAngle += worldSpeed * dt / R.wheelRadius;
      wheels.forEach(function (w) { w.rotation.x = wheelAngle; });

      // Mast camera scans, dish tracks slowly; small bob while driving.
      head.rotation.y = Math.sin(clock * 0.7) * 0.6;
      dish.rotation.y = clock * 0.25;
      body.position.y = R.rideHeight + (worldSpeed ? Math.sin(clock * 22) * 0.0006 : 0);

      if (worldSpeed) {
        // Tracks, and dust from the trailing wheels; dustier ground throws more.
        addTrailPoint(rover3d.position, xAxis);
        var dir = worldSpeed > 0 ? 1 : -1;
        var dust = rover.sample ? rover.sample.dustRisk : 0.3;
        puffDebt += dt * (10 + 70 * dust) * Math.min(2, speedMul());
        var back = zAxis.clone().multiplyScalar(-dir);
        while (puffDebt >= 1) {
          puffDebt -= 1;
          var side = Math.random() < 0.5 ? -1 : 1;
          var at = rover3d.position.clone()
            .addScaledVector(zAxis, -dir * R.wheelbase / 2)
            .addScaledVector(xAxis, side * R.track / 2);
          at.y += 0.006;
          emitPuff(at, back, xAxis);
        }
      }

      // Chase camera: behind and above the rover, looking slightly ahead.
      if (rover.follow) {
        camOffset.copy(zAxis).multiplyScalar(-0.3);
        camOffset.y = 0;
        camOffset.add(new T.Vector3(0, 0.15, 0));
        followTarget.copy(rover3d.position).addScaledVector(zAxis, 0.08);
        var k = 1 - Math.exp(-dt * 3);
        api.camera.position.lerp(rover3d.position.clone().add(camOffset), k);
        api.controls.target.lerp(followTarget, k);
      }
    });

    return { setRoutes: setRoutes, resetTrail: resetTrail };
  }

  // ---- start ----------------------------------------------------------------

  fillSelect(fromSelect, firstOfType("landing", 0), "");
  fillSelect(toSelect, firstOfType("science", 1), "None");
  buildRouteLegend();
  map.addOverlay(drawRoutes);
  map.on3dReady(function (api) {
    scene3d = build3d(api);
    scene3d.setRoutes(routes, selectedKey, dest);
    syncControls();
  });

  var startSite = sites[fromSelect.value];
  if (startSite) teleport(startSite);
  var destSite = sites[toSelect.value];
  setDestination(destSite ? { nx: destSite.nx, ny: destSite.ny, name: destSite.name } : null, !reduceMotion);
  requestAnimationFrame(loop);
})();

/*
 * rover.js -- route planning, route drawing, and the rover that drives it.
 *
 * Finds a low-risk path between two named sites, draws it on the map, and
 * drives a rover along it (3D model in the 3D view, a marker in 2D).
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
  var summary = document.getElementById("route-summary");

  // ---- planner tuning (behaviour, not data) ---------------------------------

  var GRID_W = 120;
  var GRID_H = 90;
  var SLOPE_WEIGHT = 14; // extra cost per unit of slope (0-1)
  var DUST_WEIGHT = 3;   // extra cost per unit of dust risk (0-1)
  var ASPECT = canvas.height / canvas.width; // so lengths are in map widths

  var sites = data.getNamedSites();
  var route = null; // { points: [{nx, ny}], stats }
  var costGrid = null;

  // ---- cost field -----------------------------------------------------------

  function getCostGrid() {
    if (costGrid) return costGrid;
    costGrid = new Float32Array(GRID_W * GRID_H);
    for (var y = 0; y < GRID_H; y++) {
      for (var x = 0; x < GRID_W; x++) {
        var s = data.sampleTerrainAt(x / (GRID_W - 1), y / (GRID_H - 1));
        costGrid[y * GRID_W + x] = 1 + SLOPE_WEIGHT * s.slope + DUST_WEIGHT * s.dustRisk;
      }
    }
    return costGrid;
  }

  function distance(ax, ay, bx, by) {
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

  function findPath(start, end) {
    var cost = getCostGrid();
    var sx = toCell(start.nx, GRID_W), sy = toCell(start.ny, GRID_H);
    var ex = toCell(end.nx, GRID_W), ey = toCell(end.ny, GRID_H);
    var startIdx = sy * GRID_W + sx;
    var endIdx = ey * GRID_W + ex;

    var best = new Float32Array(GRID_W * GRID_H).fill(Infinity);
    var cameFrom = new Int32Array(GRID_W * GRID_H).fill(-1);
    var heap = [];
    best[startIdx] = 0;
    heapPush(heap, { idx: startIdx, g: 0, f: distance(sx, sy, ex, ey) });

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
          var g = node.g + distance(x, y, nx, ny) * (cost[node.idx] + cost[nIdx]) / 2;
          if (g < best[nIdx]) {
            best[nIdx] = g;
            cameFrom[nIdx] = node.idx;
            heapPush(heap, { idx: nIdx, g: g, f: g + distance(nx, ny, ex, ey) });
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
    // Pin the ends to the exact site positions rather than the nearest cell.
    points[0] = { nx: start.nx, ny: start.ny };
    points[points.length - 1] = { nx: end.nx, ny: end.ny };
    return points;
  }

  function routeStats(points) {
    var length = 0, climb = 0, maxSlope = 0, maxDust = 0;
    var prev = null;
    points.forEach(function (p, i) {
      var s = data.sampleTerrainAt(p.nx, p.ny);
      if (s.slope > maxSlope) maxSlope = s.slope;
      if (s.dustRisk > maxDust) maxDust = s.dustRisk;
      if (i > 0) {
        var dx = p.nx - points[i - 1].nx;
        var dy = (p.ny - points[i - 1].ny) * ASPECT;
        length += Math.sqrt(dx * dx + dy * dy);
        if (s.elevation > prev.elevation) climb += s.elevation - prev.elevation;
      }
      prev = s;
    });
    return { length: length, climb: climb, maxSlope: maxSlope, maxDust: maxDust };
  }

  // ---- drawing the route on the 2D map --------------------------------------

  function drawRoute(ctx, W, H) {
    if (!route) return;
    var pts = route.points;
    function trace() {
      ctx.beginPath();
      pts.forEach(function (p, i) {
        var x = p.nx * (W - 1), y = p.ny * (H - 1);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(20,16,14,.85)";
    trace();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffd166";
    trace();
    [pts[0], pts[pts.length - 1]].forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.nx * (W - 1), p.ny * (H - 1), 9, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#ffd166";
      ctx.stroke();
    });
    ctx.restore();
  }

  // ---- route panel ----------------------------------------------------------

  function fillSelect(select, chosenIndex) {
    select.textContent = "";
    var none = document.createElement("option");
    none.value = "";
    none.textContent = "None";
    select.appendChild(none);
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

  function addRow(list, label, value) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  }

  function showSummary(message) {
    summary.textContent = "";
    if (!route) {
      var hint = document.createElement("p");
      hint.className = "empty";
      hint.textContent = message;
      summary.appendChild(hint);
      return;
    }
    var s = route.stats;
    var list = document.createElement("dl");
    addRow(list, "Length", s.length.toFixed(2) + " × map width");
    addRow(list, "Total climb", Math.round(s.climb) + " m");
    // Hazard rows use the map's hazard colors, and flag the route when it
    // passes through an active hazard zone.
    map.addRow(list, "Steepest slope", Math.round(s.maxSlope * 100) + "%", "slope",
      map.isOverHazardLimit("slope", s.maxSlope));
    map.addRow(list, "Highest dust risk", Math.round(s.maxDust * 100) + "%", "dustRisk",
      map.isOverHazardLimit("dustRisk", s.maxDust));
    summary.appendChild(list);
  }

  function update() {
    var from = sites[fromSelect.value];
    var to = sites[toSelect.value];
    route = null;
    if (!from || !to) {
      showSummary("Pick a start and an end site.");
    } else if (from === to) {
      showSummary("Start and end are the same site.");
    } else {
      var points = findPath(from, to);
      route = { points: points, stats: routeStats(points) };
      showSummary("");
    }
    map.redraw();
    rover.setRoute(route ? route.points : null);
  }

  // ===========================================================================
  // ROVER
  // ===========================================================================

  // ---- driving tuning (behaviour, not data) ---------------------------------

  var DRIVE_SPEED = 0.045;     // map widths per second on flat ground, at 1x
  var SLOPE_SLOWDOWN = 0.7;    // at 100% slope the rover runs at 30% speed
  var DUST_SLOWDOWN = 0.25;    // deep dust costs up to 25% more
  var SMOOTH_PASSES = 3;       // corner rounding of the planner's grid path
  var TELEMETRY_EVERY = 0.15;  // seconds between panel updates

  var playBtn = document.getElementById("rover-play");
  var restartBtn = document.getElementById("rover-restart");
  var followBtn = document.getElementById("rover-follow");
  var speedSelect = document.getElementById("rover-speed");
  var progressInput = document.getElementById("rover-progress");
  var telemetry = document.getElementById("rover-telemetry");
  var marker2d = document.getElementById("rover-2d");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var rover = {
    path: null,      // smoothed [{nx, ny}]
    cum: null,       // cumulative length in map widths
    total: 0,
    s: 0,            // distance driven along the path
    speed: 0,        // current map widths per second
    playing: false,
    arrived: false,
    follow: false,
    sample: null,    // terrain under the rover
    pos: null,       // {nx, ny}
    heading: 0,      // radians, map space (0 = +x)
    setRoute: null
  };

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

  function pointAt(s) {
    var path = rover.path, cum = rover.cum;
    s = Math.max(0, Math.min(rover.total, s));
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

  rover.setRoute = function (points) {
    if (!points || points.length < 2) {
      rover.path = null;
      rover.playing = false;
      syncControls();
      if (scene3d) scene3d.clearRoute();
      updateMarker2d();
      renderTelemetry();
      return;
    }
    rover.path = smoothPath(points);
    rover.cum = [0];
    for (var i = 1; i < rover.path.length; i++) {
      var dx = rover.path[i].nx - rover.path[i - 1].nx;
      var dy = (rover.path[i].ny - rover.path[i - 1].ny) * ASPECT;
      rover.cum.push(rover.cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    rover.total = rover.cum[rover.cum.length - 1];
    if (scene3d) scene3d.buildRoute(rover.path);
    restart(!reduceMotion);
  };

  function restart(play) {
    rover.s = 0;
    rover.arrived = false;
    rover.playing = !!play && !!rover.path;
    if (scene3d) scene3d.resetTrail();
    place();
    syncControls();
    renderTelemetry();
  }

  // Where the rover is, which way it faces, and what's under it.
  function place() {
    if (!rover.path) return;
    rover.pos = pointAt(rover.s);
    var a = pointAt(rover.s - 0.006);
    var b = pointAt(rover.s + 0.006);
    if (a.nx !== b.nx || a.ny !== b.ny) {
      rover.heading = Math.atan2((b.ny - a.ny) * ASPECT, b.nx - a.nx);
    }
    rover.sample = data.sampleTerrainAt(rover.pos.nx, rover.pos.ny);
  }

  function step(dt) {
    if (!rover.path || !rover.playing) {
      rover.speed = 0;
      return;
    }
    var s = rover.sample;
    var mul = Number(speedSelect.value) || 1;
    rover.speed = DRIVE_SPEED * mul * (1 - SLOPE_SLOWDOWN * s.slope) * (1 - DUST_SLOWDOWN * s.dustRisk);
    rover.s += rover.speed * dt;
    if (rover.s >= rover.total) {
      rover.s = rover.total;
      rover.playing = false;
      rover.arrived = true;
      syncControls();
    }
    place();
  }

  // ---- controls and telemetry ----------------------------------------------

  function syncControls() {
    var has = !!rover.path;
    playBtn.disabled = !has;
    restartBtn.disabled = !has;
    progressInput.disabled = !has;
    playBtn.textContent = rover.playing ? "Pause" : rover.arrived ? "Drive again" : "Drive";
    playBtn.setAttribute("aria-pressed", String(rover.playing));
    followBtn.setAttribute("aria-pressed", String(rover.follow));
    followBtn.disabled = !scene3d || map.viewMode() !== "3d";
    progressInput.value = has && rover.total ? String(Math.round(rover.s / rover.total * 1000)) : "0";
  }

  function renderTelemetry() {
    telemetry.textContent = "";
    if (!rover.path || !rover.sample) return;
    var s = rover.sample;
    var status;
    if (rover.arrived) status = "Arrived";
    else if (!rover.playing) status = rover.s > 0 ? "Paused" : "Ready";
    else if (s.slope > 0.35) status = "Crawling · steep ground";
    else if (s.dustRisk > 0.55) status = "Slowed · loose dust";
    else status = "Driving";

    var list = document.createElement("dl");
    addRow(list, "Status", status);
    addRow(list, "Progress", Math.round(rover.s / rover.total * 100) + "%");
    addRow(list, "Elevation", Math.round(s.elevation) + " m");
    map.addRow(list, "Slope", Math.round(s.slope * 100) + "%", "slope", map.isOverHazardLimit("slope", s.slope));
    map.addRow(list, "Dust risk", Math.round(s.dustRisk * 100) + "%", "dustRisk", map.isOverHazardLimit("dustRisk", s.dustRisk));
    addRow(list, "Temperature", s.temperature.toFixed(1) + " °C");
    telemetry.appendChild(list);
    if (rover.playing || rover.arrived) progressInput.value = String(Math.round(rover.s / rover.total * 1000));
  }

  playBtn.addEventListener("click", function () {
    if (!rover.path) return;
    if (rover.arrived) {
      restart(true);
      return;
    }
    rover.playing = !rover.playing;
    syncControls();
    renderTelemetry();
  });

  restartBtn.addEventListener("click", function () { restart(true); });

  followBtn.addEventListener("click", function () {
    rover.follow = !rover.follow;
    syncControls();
  });

  progressInput.addEventListener("input", function () {
    if (!rover.path) return;
    rover.playing = false;
    rover.s = progressInput.value / 1000 * rover.total;
    rover.arrived = rover.s >= rover.total;
    place();
    if (scene3d) scene3d.resetTrail(); // a jump breaks the tracks
    syncControls();
    renderTelemetry();
  });

  map.onHazardChange(function () {
    if (route) showSummary("");
    renderTelemetry();
  });

  map.onViewChange(function () {
    if (map.viewMode() !== "3d") rover.follow = false;
    syncControls();
    updateMarker2d();
  });

  // ---- 2D marker ------------------------------------------------------------

  function updateMarker2d() {
    var show = !!rover.path && map.viewMode() !== "3d";
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
    step(dt);
    sinceTelemetry += dt;
    if (rover.playing && sinceTelemetry >= TELEMETRY_EVERY) {
      sinceTelemetry = 0;
      renderTelemetry();
    }
    updateMarker2d();
    requestAnimationFrame(loop);
  }

  // ===========================================================================
  // ROVER IN 3D
  // ===========================================================================

  var scene3d = null;

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
      panel: std(0x1d2a4a, { roughness: 0.25, metalness: 0.6 }),
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

    // Chassis: white warm-box with a gold-foil belly and a dark deck.
    var chassis = box(0.062, 0.022, 0.088, MAT.body);
    body.add(chassis);
    var belly = box(0.056, 0.006, 0.08, MAT.gold);
    belly.position.y = -0.014;
    body.add(belly);
    var deck = box(0.068, 0.004, 0.094, MAT.deck);
    deck.position.y = 0.013;
    body.add(deck);
    // Instrument boxes on the deck.
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
    var headBox = box(0.026, 0.011, 0.012, MAT.body);
    head.add(headBox);
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
    var dishPlate = cyl(0.013, 0.006, 0.004, MAT.metal, 20);
    dish.add(dishPlate);
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
      // Rocker and bogie arms linking the wheels to the body.
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

    // ---- route ribbon and destination beacon --------------------------------

    var routeTube = null;
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

    function buildRoute(path) {
      clearRoute();
      var pts = path.map(function (p) { return api.surfacePoint(p.nx, p.ny, 0.006); });
      var curve = new T.CatmullRomCurve3(pts);
      routeTube = new T.Mesh(
        new T.TubeGeometry(curve, Math.min(800, pts.length * 3), 0.0035, 6, false),
        new T.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.85 })
      );
      scene.add(routeTube);
      var end = path[path.length - 1];
      beacon.position.copy(api.surfacePoint(end.nx, end.ny, 0.004));
      beacon.visible = true;
      rover3d.visible = true;
    }

    function clearRoute() {
      if (routeTube) {
        scene.remove(routeTube);
        routeTube.geometry.dispose();
        routeTube.material.dispose();
        routeTube = null;
      }
      beacon.visible = false;
      rover3d.visible = false;
      resetTrail();
    }

    // ---- wheel tracks -------------------------------------------------------

    var TRAIL_MAX = 3000;
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
    }

    function addTrailPoint(center, right) {
      if (lastTrail && lastTrail.distanceTo(center) < 0.006) return;
      lastTrail = center.clone();
      trails.forEach(function (t) {
        if (t.count >= TRAIL_MAX) return;
        var off = right.clone().multiplyScalar(t.side * R.track / 2);
        var x = center.x + off.x, z = center.z + off.z;
        var m = api.toMap(x, z);
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

      if (!rover.path || !rover.pos) return;

      // Facing direction on the ground plane.
      // (Heading is measured in map-width units, which are proportional to world x/z.)
      var fwd = new T.Vector3(Math.cos(rover.heading), 0, Math.sin(rover.heading));
      var right = new T.Vector3(fwd.z, 0, -fwd.x); // = up x forward

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

      // Wheels roll with the distance actually covered.
      var worldSpeed = rover.speed * api.planeWidth;
      wheelAngle += worldSpeed * dt / R.wheelRadius;
      wheels.forEach(function (w) { w.rotation.x = wheelAngle; });

      // Mast camera scans, dish tracks slowly; small idle bob while driving.
      head.rotation.y = Math.sin(clock * 0.7) * 0.6;
      dish.rotation.y = clock * 0.25;
      body.position.y = R.rideHeight + (worldSpeed > 0 ? Math.sin(clock * 22) * 0.0006 : 0);

      if (worldSpeed > 0) {
        // Tracks and dust from the rear wheels; dustier ground throws more.
        addTrailPoint(rover3d.position, xAxis);
        var dust = rover.sample ? rover.sample.dustRisk : 0.3;
        puffDebt += dt * (10 + 70 * dust) * Math.min(2, Number(speedSelect.value) || 1);
        var back = zAxis.clone().negate();
        while (puffDebt >= 1) {
          puffDebt -= 1;
          var side = Math.random() < 0.5 ? -1 : 1;
          var at = rover3d.position.clone()
            .addScaledVector(zAxis, -R.wheelbase / 2)
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

    return { buildRoute: buildRoute, clearRoute: clearRoute, resetTrail: resetTrail };
  }

  // ---- start ----------------------------------------------------------------

  fillSelect(fromSelect, firstOfType("landing", 0));
  fillSelect(toSelect, firstOfType("science", 1));
  fromSelect.addEventListener("change", update);
  toSelect.addEventListener("change", update);
  map.addOverlay(drawRoute);
  map.on3dReady(function (api) {
    scene3d = build3d(api);
    if (rover.path) scene3d.buildRoute(rover.path);
    syncControls();
  });
  update();
  requestAnimationFrame(loop);
})();

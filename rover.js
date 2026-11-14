/*
 * rover.js -- route planning and route drawing (no rover sprite).
 *
 * Finds a low-risk path between two named sites and draws it on the map.
 * RULE: no terrain data or site names are hardcoded here. Terrain comes from
 * MarsData.sampleTerrainAt(), sites from MarsData.getNamedSites(). The only
 * constants are planner tuning (grid size, how strongly to avoid slope/dust)
 * and drawing style.
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

  // ---- drawing --------------------------------------------------------------

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

  // ---- panel ----------------------------------------------------------------

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
  }

  fillSelect(fromSelect, firstOfType("landing", 0));
  fillSelect(toSelect, firstOfType("science", 1));
  fromSelect.addEventListener("change", update);
  toSelect.addEventListener("change", update);
  map.addOverlay(drawRoute);
  map.onHazardChange(function () { if (route) showSummary(""); });
  update();
})();

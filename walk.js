/*
 * walk.js -- the Walk tab: where an astronaut can safely walk from parked
 * Ridgeback, the safest walking route to a clicked spot, and the walk itself.
 *
 * Flow: open the Walk tab (the walking range shows) -> click a spot in it
 * (the safest route and its times appear) -> press Walk (only then does the
 * astronaut set off).
 *
 * The maths is in walk-core.js (NASA suit limits, risky-ground avoidance);
 * the wording is in content.js under content.walk. Ridgeback's position and
 * the lock that keeps it parked while someone is outside come from rover.js
 * (window.Ridgeback); clicks come from ui.js (MapUI.onSelect).
 */
(function () {
  "use strict";

  var core = window.WalkCore;
  var terrain = window.MarsTerrain;
  var data = window.MarsData;
  var map = window.MapUI;
  var rb = window.Ridgeback;

  var panel = document.getElementById("walk-panel");
  if (!panel || !core || !map || !rb) return;

  var introEl = document.getElementById("walk-intro");
  var legendEl = document.getElementById("walk-legend");
  var statusEl = document.getElementById("walk-status");
  var statsEl = document.getElementById("walk-stats");
  var avoidsEl = document.getElementById("walk-avoids");
  var startBtn = document.getElementById("walk-start");
  var clearBtn = document.getElementById("walk-clear");
  var moreTitle = document.getElementById("walk-more-title");
  var siteLabel = document.getElementById("walk-site-label");
  var siteSelect = document.getElementById("walk-site");
  var limitsEl = document.getElementById("walk-limits");
  var marker2d = document.getElementById("walker-2d");
  var confirmBox = document.getElementById("walk-confirm");
  var confirmTitle = document.getElementById("walk-confirm-title");
  var confirmBody = document.getElementById("walk-confirm-body");
  var confirmAdvice = document.getElementById("walk-confirm-advice");
  var confirmGo = document.getElementById("walk-confirm-go");
  var confirmCancel = document.getElementById("walk-confirm-cancel");

  // ---- drawing style (not data) ----------------------------------------------

  var EASY = [163, 255, 79];    // lime: the round trip fits easily
  var TIGHT = [255, 154, 60];   // orange: it fits, but only just
  var RANGE_ALPHA = 0.4;
  var DIRECT_COLOR = "rgba(255, 90, 80, .85)"; // the straight line the route avoids
  var SAFE_ROUTE = "#ffffff";   // the route keeps off all risky ground
  var RISKY_ROUTE = "#ffd23f";  // the best route there still crosses risky ground
  var STATUS_EVERY = 0.15;      // seconds between card updates while walking
  var DEFAULT_SITE_HOURS = 1;
  var BOULDER_CELLS = 2;        // keep ~150 m from each mapped megabreccia block

  // ---- text ---------------------------------------------------------------------

  var TEXT = null;
  function t(path) {
    var v = TEXT;
    path.split(".").forEach(function (k) { v = v == null ? v : v[k]; });
    return v == null ? "" : v;
  }
  function fill(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? vars[k] : m; });
  }
  function hoursText(h) {
    var mins = Math.max(0, Math.round(h * 60));
    if (mins < 60) return mins + " min";
    var hh = Math.floor(mins / 60), mm = mins % 60;
    return mm ? hh + " h " + mm + " min" : hh + " h";
  }
  function kmText(km) {
    return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 2 : 1) + " km";
  }
  function metresText(m) {
    return m < 1000 ? Math.max(50, Math.round(m / 50) * 50) + " m" : (m / 1000).toFixed(1) + " km";
  }
  function listText(items) {
    if (items.length < 2) return items.join("");
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }

  // ---- the walking grid ------------------------------------------------------------

  var grid = null;
  if (terrain && terrain.ok && data && data.getScale) {
    var size = terrain.gridSize, scale = data.getScale();
    grid = core.createGrid({
      w: size.w, h: size.h,
      cellWm: scale.widthKm * 1000 / (size.w - 1),
      cellHm: scale.heightKm * 1000 / (size.h - 1),
      elevation: terrain.grid("elevation"),
      slope: terrain.grid("slope"),
      sand: terrain.grid("sand"),
      boulders: boulderMask(size.w, size.h)
    });
  }

  // Cells near the megabreccia blocks mapped by USGS (SIM 3464).
  function boulderMask(w, h) {
    var mask = new Uint8Array(w * h);
    var feats = data.getGeologyFeatures ? data.getGeologyFeatures().megabreccia : [];
    (feats || []).forEach(function (p) {
      var cx = Math.round(p.nx * (w - 1)), cy = Math.round(p.ny * (h - 1));
      for (var dy = -BOULDER_CELLS; dy <= BOULDER_CELLS; dy++) {
        for (var dx = -BOULDER_CELLS; dx <= BOULDER_CELLS; dx++) {
          var x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h || dx * dx + dy * dy > BOULDER_CELLS * BOULDER_CELLS) continue;
          mask[y * w + x] = 1;
        }
      }
    });
    return mask;
  }

  // The hazard zones the user highlights under Map layers & hazards.
  function updateZones() {
    if (!grid) return;
    var slopeLimit = map.hazardLimit ? map.hazardLimit("slope") : null;
    var sandLimit = map.hazardLimit ? map.hazardLimit("dustRisk") : null;
    if (slopeLimit == null && sandLimit == null) { core.setZones(grid, null); return; }
    var mask = new Uint8Array(grid.w * grid.h);
    for (var i = 0; i < mask.length; i++) {
      if ((slopeLimit != null && grid.slope[i] > slopeLimit) || (sandLimit != null && grid.sand[i] > sandLimit)) mask[i] = 1;
    }
    core.setZones(grid, mask);
  }

  function cellOf(p) {
    var x = Math.max(0, Math.min(grid.w - 1, Math.round(p.nx * (grid.w - 1))));
    var y = Math.max(0, Math.min(grid.h - 1, Math.round(p.ny * (grid.h - 1))));
    return y * grid.w + x;
  }
  function posOf(cell) {
    var x = cell % grid.w;
    return { nx: x / (grid.w - 1), ny: (cell - x) / grid.w / (grid.h - 1) };
  }

  // ---- state ------------------------------------------------------------------------

  var siteHours = DEFAULT_SITE_HOURS;
  var res = null;        // safest walks from Ridgeback's spot (walk-core plan)
  var target = null;     // { nx, ny } the chosen spot
  var route = null;      // walk-core route to the target
  var walk = null;       // the walk in progress
  var message = "";      // one-off status (walk done, stopped, called off)
  var rangeCanvas = null;
  var wasStale = null;
  var wasMoving = null;
  var scene3d = null;

  // The plan no longer matches where Ridgeback is (it's driving, or it was moved).
  function stale() {
    var p = rb.position();
    return !res || !p || rb.isMoving() || cellOf(p) !== res.src;
  }

  // Walk things are drawn while the Walk tab is open, or while someone is out.
  function showing() { return panel.open || !!walk; }

  function computePlan() {
    var p = rb.position();
    if (!grid || !p) return;
    var c = cellOf(p);
    res = core.plan(grid, c % grid.w, Math.floor(c / grid.w));
    buildRange();
    updateRoute();
  }

  function updateRoute() {
    if (!res || !target) {
      route = null;
    } else {
      var c = cellOf(target);
      route = core.routeTo(grid, res, c % grid.w, Math.floor(c / grid.w), siteHours);
    }
    set3d();
  }

  function buildRange() {
    if (!rangeCanvas) {
      rangeCanvas = document.createElement("canvas");
      rangeCanvas.width = grid.w;
      rangeCanvas.height = grid.h;
    }
    var g = rangeCanvas.getContext("2d");
    var img = g.createImageData(grid.w, grid.h);
    var px = img.data, a = Math.round(RANGE_ALPHA * 255);
    for (var i = 0; i < res.walk.length; i++) {
      var level = core.classify(res.walk[i], siteHours);
      if (!level) continue;
      var c = level === 1 ? EASY : TIGHT;
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = a;
    }
    g.putImageData(img, 0, 0);
  }

  function directRisky() {
    if (!route || !route.path.length) return false;
    var d = route.direct;
    return d.tooSteep || d.steep || d.sand || d.boulders || d.zone;
  }

  // The best route there still crosses risky ground (no fully safe way fits).
  function routeRisky() {
    if (!route || !route.reachable) return false;
    var c = route.crosses;
    return c.steep > 0 || c.sand > 0 || c.boulders > 0 || c.zone > 0;
  }

  function routeColor() { return routeRisky() ? RISKY_ROUTE : SAFE_ROUTE; }

  // "200 m of steep slopes and 450 m of mapped sand"
  function crossedList() {
    var c = route.crosses, items = [];
    ["steep", "sand", "boulders", "zone"].forEach(function (k) {
      if (c[k] > 0) items.push(metresText(c[k]) + " of " + t("risks." + k));
    });
    return listText(items);
  }

  // ---- map drawing ---------------------------------------------------------------

  // The walking range: under the labels and also on the 3D ground.
  map.addGroundOverlay(function (ctx, W, H) {
    if (!panel.open || walk || !rangeCanvas || stale()) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(rangeCanvas, 0, 0, W, H);
    ctx.restore();
  });

  // The straight line (red), the safest route (dashed white) and the spot.
  map.addOverlay(function (ctx, W, H) {
    if (!target || !showing() || (stale() && !walk)) return;
    var tx = target.nx * W, ty = target.ny * H;
    ctx.save();
    ctx.lineJoin = ctx.lineCap = "round";
    if (directRisky()) {
      var s = posOf(res.src);
      ctx.beginPath();
      ctx.moveTo(s.nx * W, s.ny * H);
      ctx.lineTo(tx, ty);
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = DIRECT_COLOR;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (route && route.path.length > 1) {
      ctx.beginPath();
      route.path.forEach(function (cell, i) {
        var p = posOf(cell);
        if (i) ctx.lineTo(p.nx * W, p.ny * H); else ctx.moveTo(p.nx * W, p.ny * H);
      });
      ctx.strokeStyle = "rgba(10, 14, 18, .85)";
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = routeColor();
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(tx, ty, 6, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(10, 14, 18, .85)";
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = route && route.reachable ? "#ffffff" : "#ff6b5b";
    ctx.stroke();
    ctx.restore();
  });

  // ---- 3D: the route, the straight line and the astronaut ---------------------------------

  var MAX_DIRECT_DOTS = 600;
  var DIRECT_SPACING = 0.6;     // world units between the straight line's red dots
  var ROUTE_RADIUS = 0.13;      // the route is a solid tube, so it stands out from the red dots
  var ROUTE_LIFT = 0.3;

  function build3d(api) {
    var T = api.THREE;
    var tube = null;

    // The straight line as red dots, so it reads apart from the solid route.
    var direct = new T.InstancedMesh(
      new T.SphereGeometry(0.14, 8, 6),
      new T.MeshBasicMaterial({ color: 0xff3b30 }),
      MAX_DIRECT_DOTS
    );
    direct.count = 0;
    direct.frustumCulled = false;
    api.scene.add(direct);

    // Same visual scale as Ridgeback (about 2.6 units long), facing +z.
    var suit = new T.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8 });
    var pack = new T.MeshStandardMaterial({ color: 0x8d939a, roughness: 0.9 });
    var visor = new T.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.25, metalness: 0.7 });
    var figure = new T.Group();
    function part(geo, m, x, y, z) {
      var mesh = new T.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      figure.add(mesh);
      return mesh;
    }
    var legL = part(new T.BoxGeometry(0.24, 0.8, 0.28), suit, -0.15, 0.4, 0);
    var legR = part(new T.BoxGeometry(0.24, 0.8, 0.28), suit, 0.15, 0.4, 0);
    part(new T.BoxGeometry(0.62, 0.72, 0.4), suit, 0, 1.16, 0);
    part(new T.BoxGeometry(0.56, 0.66, 0.26), pack, 0, 1.2, -0.32);
    var armL = part(new T.BoxGeometry(0.17, 0.66, 0.2), suit, -0.41, 1.12, 0);
    var armR = part(new T.BoxGeometry(0.17, 0.66, 0.2), suit, 0.41, 1.12, 0);
    part(new T.SphereGeometry(0.27, 16, 12), suit, 0, 1.72, 0);
    part(new T.BoxGeometry(0.34, 0.17, 0.08), visor, 0, 1.74, 0.23);
    figure.visible = false;
    api.scene.add(figure);

    var m4 = new T.Matrix4();
    return {
      setRoute: function (path, color) {
        if (tube) {
          api.scene.remove(tube);
          tube.geometry.dispose();
          tube.material.dispose();
          tube = null;
        }
        if (!path || path.length < 2) return;
        var pts = path.map(function (cell) {
          var p = posOf(cell);
          return api.surfacePoint(p.nx, p.ny, ROUTE_LIFT);
        });
        tube = new T.Mesh(
          new T.TubeGeometry(new T.CatmullRomCurve3(pts), Math.min(2000, pts.length * 3), ROUTE_RADIUS, 6, false),
          new T.MeshBasicMaterial({ color: color })
        );
        api.scene.add(tube);
      },
      setDirect: function (a, b) {
        if (!a) { direct.count = 0; return; }
        var lenUnits = Math.hypot((b.nx - a.nx) * api.planeWidth, (b.ny - a.ny) * api.planeDepth);
        var n = Math.max(2, Math.min(MAX_DIRECT_DOTS, Math.round(lenUnits / DIRECT_SPACING)));
        for (var i = 0; i < n; i++) {
          var f = i / (n - 1);
          var v = api.surfacePoint(a.nx + (b.nx - a.nx) * f, a.ny + (b.ny - a.ny) * f, 0.22);
          m4.makeTranslation(v.x, v.y, v.z);
          direct.setMatrixAt(i, m4);
        }
        direct.count = n;
        direct.instanceMatrix.needsUpdate = true;
      },
      setFigure: function (p, dir, stride) {
        figure.visible = !!p;
        if (!p) return;
        figure.position.copy(api.surfacePoint(p.nx, p.ny, 0));
        if (dir && (dir.nx || dir.ny)) {
          figure.rotation.y = Math.atan2(dir.nx * api.planeWidth, dir.ny * api.planeDepth);
        }
        var swing = Math.sin(stride || 0) * 0.45;
        legL.rotation.x = swing; legR.rotation.x = -swing;
        armL.rotation.x = -swing; armR.rotation.x = swing;
      }
    };
  }

  function set3d() {
    if (!scene3d) return;
    var on = showing() && route && route.path.length > 1 && (!stale() || !!walk);
    scene3d.setRoute(on ? route.path : null, routeColor());
    scene3d.setDirect(on && directRisky() ? posOf(res.src) : null, target);
  }

  map.on3dReady(function (api) {
    scene3d = build3d(api);
    set3d();
  });

  // ---- the walk ------------------------------------------------------------------------

  function startWalk() {
    if (!route || !route.reachable || stale()) return;
    var back = route.path.slice().reverse();
    walk = {
      src: res.src,
      path: route.path,
      back: back,
      outCum: core.cumulativeHours(grid, route.path),
      backCum: core.cumulativeHours(grid, back),
      outH: route.outHours,
      siteH: route.siteHours,
      backH: route.backHours,
      total: route.totalHours,
      t: 0,
      stride: 0
    };
    message = "";
    rb.setLocked(true);
    map.redraw(); // the range steps aside while someone is out
    renderCard();
  }

  function endWalk(kind) {
    var w = walk;
    walk = null;
    rb.setLocked(false);
    if (scene3d) scene3d.setFigure(null);
    marker2d.hidden = true;
    message = kind === "done"
      ? fill(t("status.done"), { used: hoursText(w.total), reserve: hoursText(core.LIMITS.suitMaxHours - w.total) })
      : t("status." + kind);
    set3d();
    map.redraw();
    renderCard();
  }

  // Where along a path the walker is after `hours`, and which way it faces.
  function along(path, cum, hours) {
    var last = path.length - 1;
    if (last <= 0) return { p: posOf(path[0]), dir: null };
    var i = 0;
    while (i < last - 1 && cum[i + 1] < hours) i++;
    var span = cum[i + 1] - cum[i];
    var f = span > 0 ? Math.max(0, Math.min(1, (hours - cum[i]) / span)) : 1;
    var a = posOf(path[i]), b = posOf(path[i + 1]);
    return {
      p: { nx: a.nx + (b.nx - a.nx) * f, ny: a.ny + (b.ny - a.ny) * f },
      dir: { nx: b.nx - a.nx, ny: b.ny - a.ny }
    };
  }

  function phase() {
    if (walk.t < walk.outH) return "out";
    if (walk.t < walk.outH + walk.siteH) return "site";
    return "back";
  }

  function placeWalker(dt) {
    var ph = phase(), at;
    if (ph === "out") at = along(walk.path, walk.outCum, walk.t);
    else if (ph === "site") at = { p: posOf(walk.path[walk.path.length - 1]), dir: null };
    else at = along(walk.back, walk.backCum, walk.t - walk.outH - walk.siteH);
    if (ph !== "site") walk.stride += dt * 9;
    if (scene3d) scene3d.setFigure(at.p, at.dir, ph === "site" ? 0 : walk.stride);
    marker2d.hidden = false;
    marker2d.style.left = (at.p.nx * 100) + "%";
    marker2d.style.top = (at.p.ny * 100) + "%";
  }

  // ---- the card ------------------------------------------------------------------------

  function row(label, value) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    statsEl.appendChild(dt);
    statsEl.appendChild(dd);
  }

  // What the route steers around, and anything risky it still has to cross.
  function avoidsText() {
    var d = route.direct, c = route.crosses, lines = [];
    var avoided = [];
    if (d.tooSteep) avoided.push(t("risks.tooSteep"));
    ["steep", "sand", "boulders", "zone"].forEach(function (k) {
      if (d[k] && !c[k]) avoided.push(t("risks." + k));
    });
    if (avoided.length) lines.push(fill(t("avoids"), { list: listText(avoided) }));
    if (routeRisky()) lines.push(fill(t("crosses"), { list: crossedList() }));
    if (!lines.length) lines.push(t("clear"));
    return lines.join(" ");
  }

  function renderCard() {
    if (!TEXT) return;
    statsEl.textContent = "";
    avoidsEl.textContent = "";
    if (!grid) {
      statusEl.textContent = t("status.noData");
      startBtn.disabled = clearBtn.disabled = true;
      return;
    }
    var L = core.LIMITS;
    var isStale = stale();
    var status;
    if (walk) {
      status = fill(t("status." + phase()), { left: hoursText(L.planHours - walk.t) });
    } else if (message) {
      status = message;
    } else if (rb.isMoving()) {
      status = t("status.moving");
    } else if (route && !route.reachable) {
      status = fill(t("reasons." + route.reason), {
        deg: L.maxSlopeDeg, total: hoursText(route.totalHours), plan: hoursText(L.planHours)
      });
    } else if (route) {
      status = routeRisky() ? t("status.risky") : route.level === 2 ? t("status.tight") : t("status.safe");
    } else {
      status = t("status.pick");
    }
    statusEl.textContent = status;

    if (route && route.reachable && (walk || !isStale)) {
      row(t("stats.out"), hoursText(route.outHours));
      row(t("stats.back"), hoursText(route.backHours));
      row(t("stats.site"), hoursText(route.siteHours));
      row(t("stats.total"), fill(t("stats.totalValue"), { total: hoursText(route.totalHours), plan: hoursText(L.planHours) }));
      row(t("stats.reserve"), hoursText(L.suitMaxHours - route.totalHours));
      row(t("stats.distance"), kmText(route.distanceKm));
      avoidsEl.textContent = avoidsText();
    }

    startBtn.textContent = walk ? t("buttons.stop") : t("buttons.start");
    startBtn.disabled = !walk && !(route && route.reachable && !isStale);
    clearBtn.disabled = !target || !!walk;
  }

  function applyText() {
    introEl.textContent = t("intro");
    moreTitle.textContent = t("moreTitle");
    siteLabel.textContent = t("siteTime");
    siteSelect.textContent = "";
    (t("siteOptions") || []).forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = String(o.hours);
      opt.textContent = o.label;
      if (o.hours === siteHours) opt.selected = true;
      siteSelect.appendChild(opt);
    });
    legendEl.textContent = "";
    [
      ["easy", "rgb(" + EASY.join(",") + ")", false],
      ["tight", "rgb(" + TIGHT.join(",") + ")", false],
      ["safe", SAFE_ROUTE, true],
      ["risky", RISKY_ROUTE, true],
      ["direct", DIRECT_COLOR, true]
    ].forEach(function (item) {
      var s = document.createElement("span");
      if (item[2]) s.className = "line";
      s.style.setProperty("--swatch", item[1]);
      s.textContent = t("legend." + item[0]);
      legendEl.appendChild(s);
    });
    confirmTitle.textContent = t("confirm.title");
    confirmAdvice.textContent = t("confirm.advice");
    confirmGo.textContent = t("confirm.go");
    confirmCancel.textContent = t("confirm.cancel");
    clearBtn.textContent = t("buttons.clear");
    var L = core.LIMITS;
    limitsEl.textContent = fill(t("limits"), {
      plan: hoursText(L.planHours), max: hoursText(L.suitMaxHours), kmh: L.flatKmh + " km/h",
      deg: L.maxSlopeDeg, risky: L.riskySlopeDeg
    });
    renderCard();
  }

  // ---- controls --------------------------------------------------------------------------

  // "Walk here" from the point popup (right-click a spot, double-click it):
  // plan the safest walk there and open the Walk tab. It still only sets off
  // when Walk is pressed.
  map.onChoose(function (mode, p) {
    if (mode !== "walk" || !grid) return;
    if (!walk) {
      target = { nx: p.nx, ny: p.ny };
      message = "";
      if (stale()) { if (!rb.isMoving()) computePlan(); }
      else updateRoute();
    }
    panel.open = true;
    map.redraw();
    renderCard();
  });

  // Opening the Walk tab shows the range; leaving it hides the walk drawings.
  panel.addEventListener("toggle", function () {
    if (panel.open && grid && stale() && !rb.isMoving()) computePlan();
    set3d();
    map.redraw();
    renderCard();
  });

  if (map.onHazardChange) {
    map.onHazardChange(function () {
      updateZones();
      if (res && !walk) { computePlan(); map.redraw(); renderCard(); }
    });
  }

  siteSelect.addEventListener("change", function () {
    siteHours = Number(siteSelect.value) || DEFAULT_SITE_HOURS;
    if (res && !walk) {
      buildRange();
      updateRoute();
      map.redraw();
    }
    message = "";
    renderCard();
  });

  // A route that still crosses risky ground needs a second yes before walking.
  startBtn.addEventListener("click", function () {
    if (walk) { endWalk("stopped"); return; }
    if (routeRisky() && confirmBox && confirmBox.showModal) {
      confirmBody.textContent = fill(t("confirm.body"), { list: crossedList(), plan: hoursText(core.LIMITS.planHours) });
      confirmBox.showModal();
      confirmCancel.focus(); // the safe choice is the default
      return;
    }
    startWalk();
  });

  if (confirmBox) {
    confirmGo.addEventListener("click", function () {
      confirmBox.close();
      startWalk();
    });
    confirmCancel.addEventListener("click", function () { confirmBox.close(); });
    // Clicking the dimmed backdrop cancels too.
    confirmBox.addEventListener("click", function (e) { if (e.target === confirmBox) confirmBox.close(); });
  }

  clearBtn.addEventListener("click", function () {
    target = null;
    route = null;
    message = "";
    set3d();
    map.redraw();
    renderCard();
  });

  // ---- main loop -----------------------------------------------------------------------------

  var last = 0, sinceStatus = 0;
  function frame(now) {
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    tick(dt);
    requestAnimationFrame(frame);
  }

  function tick(dt) {
    if (!grid) return;
    var p = rb.position();

    if (walk) {
      if (!p || cellOf(p) !== walk.src) {
        endWalk("moved");
      } else {
        walk.t += dt * rb.timeScale() / 3600;
        if (walk.t >= walk.total) {
          endWalk("done");
        } else {
          placeWalker(dt);
          sinceStatus += dt;
          if (sinceStatus >= STATUS_EVERY) { sinceStatus = 0; renderCard(); }
        }
      }
      return;
    }

    // An old "walk done" note doesn't belong on the card once Ridgeback drives off.
    if (message && rb.isMoving()) message = "";

    // Ridgeback stopped (or was put down) somewhere new: plan the walks from there.
    var replanned = false;
    if (panel.open && p && !rb.isMoving() && (!res || cellOf(p) !== res.src)) {
      computePlan();
      replanned = true;
    }
    // The card also depends on whether Ridgeback is moving, which can change
    // while the plan stays out of date.
    var s = stale(), moving = rb.isMoving();
    if (s !== wasStale || moving !== wasMoving || replanned) {
      wasStale = s;
      wasMoving = moving;
      set3d();
      if (panel.open || target) map.redraw();
      renderCard();
    }
  }

  updateZones();
  import("./content.js").then(function (mod) {
    TEXT = mod.content.walk;
    applyText();
  }).catch(function () {
    statusEl.textContent = "content.js could not be loaded (open the page through a local web server).";
  });

  requestAnimationFrame(frame);
})();

/*
 * walk.js -- the astronaut walk planner: the Walk card, the walking range on
 * the minimap and the 3D ground, the walking route, and the walk itself.
 *
 * The maths is in walk-core.js (NASA suit planning limits); the wording is in
 * content.js under content.walk. Ridgeback's position and the lock that keeps
 * it parked while someone is outside come from rover.js (window.Ridgeback).
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
  var rangeBox = document.getElementById("walk-range");
  var rangeLabel = document.getElementById("walk-range-label");
  var siteLabel = document.getElementById("walk-site-label");
  var siteSelect = document.getElementById("walk-site");
  var legendEl = document.getElementById("walk-legend");
  var statusEl = document.getElementById("walk-status");
  var statsEl = document.getElementById("walk-stats");
  var startBtn = document.getElementById("walk-start");
  var clearBtn = document.getElementById("walk-clear");
  var limitsEl = document.getElementById("walk-limits");
  var hereBtn = document.getElementById("walk-here");
  var marker2d = document.getElementById("walker-2d");

  // ---- drawing style (not data) ----------------------------------------------

  var EASY = [163, 255, 79];    // lime: the round trip fits easily
  var TIGHT = [255, 154, 60];   // orange: it fits, but only just
  var RANGE_ALPHA = 0.4;
  var STATUS_EVERY = 0.15;      // seconds between card updates while walking
  var DEFAULT_SITE_HOURS = 1;

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
      sand: terrain.grid("sand")
    });
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
  var res = null;        // quickest walks from Ridgeback's spot (walk-core plan)
  var target = null;     // { nx, ny } the chosen spot
  var route = null;      // walk-core route to the target
  var walk = null;       // the walk in progress
  var message = "";      // one-off status (walk done, stopped, called off)
  var rangeCanvas = null;
  var wasStale = null;
  var scene3d = null;

  // The plan no longer matches where Ridgeback is (it's driving, or it was moved).
  function stale() {
    var p = rb.position();
    return !res || !p || rb.isMoving() || cellOf(p) !== res.src;
  }

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
    set3dRoute();
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
    for (var i = 0; i < res.total.length; i++) {
      var level = core.classify(res.total[i], siteHours);
      if (!level) continue;
      var c = level === 1 ? EASY : TIGHT;
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = a;
    }
    g.putImageData(img, 0, 0);
  }

  // ---- map drawing ---------------------------------------------------------------

  // Under the labels and also on the 3D ground.
  map.addGroundOverlay(function (ctx, W, H) {
    if (!rangeBox.checked || !rangeCanvas || stale()) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(rangeCanvas, 0, 0, W, H);
    ctx.restore();
  });

  // The walking route (dashed) and the chosen spot, on the minimap only.
  map.addOverlay(function (ctx, W, H) {
    if (!target || stale()) return;
    var tx = target.nx * W, ty = target.ny * H;
    if (route && route.path.length > 1) {
      ctx.save();
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      route.path.forEach(function (cell, i) {
        var p = posOf(cell);
        if (i) ctx.lineTo(p.nx * W, p.ny * H); else ctx.moveTo(p.nx * W, p.ny * H);
      });
      ctx.strokeStyle = "rgba(10, 14, 18, .85)";
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
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

  // ---- 3D: footstep dots and the astronaut ---------------------------------------------

  var MAX_DOTS = 3000;

  function build3d(api) {
    var T = api.THREE;
    var dots = new T.InstancedMesh(
      new T.SphereGeometry(0.14, 8, 6),
      new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
      MAX_DOTS
    );
    dots.count = 0;
    dots.frustumCulled = false;
    api.scene.add(dots);

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
      setRoute: function (path) {
        var n = path ? Math.min(MAX_DOTS, path.length) : 0;
        for (var i = 0; i < n; i++) {
          var p = posOf(path[i]);
          var v = api.surfacePoint(p.nx, p.ny, 0.16);
          m4.makeTranslation(v.x, v.y, v.z);
          dots.setMatrixAt(i, m4);
        }
        dots.count = n;
        dots.instanceMatrix.needsUpdate = true;
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

  function set3dRoute() {
    if (!scene3d) return;
    scene3d.setRoute(route && route.path.length > 1 && !stale() ? route.path : null);
  }

  map.on3dReady(function (api) {
    scene3d = build3d(api);
    set3dRoute();
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

  function renderCard() {
    if (!TEXT) return;
    statsEl.textContent = "";
    legendEl.hidden = !rangeBox.checked;
    if (!grid) {
      statusEl.textContent = t("status.noData");
      startBtn.disabled = clearBtn.disabled = rangeBox.disabled = true;
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
      status = t("status.planned");
    } else {
      status = t("status.pick");
    }
    statusEl.textContent = status;

    if (route && route.reachable && (walk || !isStale)) {
      row(t("stats.distance"), kmText(route.distanceKm));
      row(t("stats.out"), hoursText(route.outHours));
      row(t("stats.back"), hoursText(route.backHours));
      row(t("stats.site"), hoursText(route.siteHours));
      row(t("stats.total"), fill(t("stats.totalValue"), { total: hoursText(route.totalHours), plan: hoursText(L.planHours) }));
      row(t("stats.reserve"), hoursText(L.suitMaxHours - route.totalHours));
      row(t("stats.steepest"), route.steepestDeg.toFixed(1) + "°");
      row(t("stats.climb"), Math.round(route.climbM) + " m");
      row(t("stats.sand"), route.sandShare > 0 ? Math.round(route.sandShare * 100) + "%" : t("stats.none"));
    }

    startBtn.textContent = walk ? t("buttons.stop") : t("buttons.start");
    startBtn.disabled = !walk && !(route && route.reachable && !isStale);
    clearBtn.disabled = !target || !!walk;
  }

  function applyText() {
    introEl.textContent = t("intro");
    rangeLabel.textContent = t("showRange");
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
    [["easy", EASY], ["tight", TIGHT]].forEach(function (item) {
      var s = document.createElement("span");
      s.style.setProperty("--swatch", "rgb(" + item[1].join(",") + ")");
      s.textContent = t("legend." + item[0]);
      legendEl.appendChild(s);
    });
    hereBtn.textContent = t("buttons.here");
    clearBtn.textContent = t("buttons.clear");
    var L = core.LIMITS;
    limitsEl.textContent = fill(t("limits"), {
      plan: hoursText(L.planHours), max: hoursText(L.suitMaxHours), kmh: L.flatKmh + " km/h", deg: L.maxSlopeDeg
    });
    renderCard();
  }

  // ---- controls --------------------------------------------------------------------------

  rangeBox.addEventListener("change", function () {
    if (rangeBox.checked && stale() && !rb.isMoving()) computePlan();
    map.redraw();
    renderCard();
  });

  siteSelect.addEventListener("change", function () {
    siteHours = Number(siteSelect.value) || DEFAULT_SITE_HOURS;
    if (res) {
      buildRange();
      updateRoute();
      map.redraw();
    }
    message = "";
    renderCard();
  });

  hereBtn.addEventListener("click", function () {
    var p = map.getSelected();
    if (!p || walk) return;
    target = { nx: p.nx, ny: p.ny };
    message = "";
    panel.open = true;
    if (stale()) computePlan(); else updateRoute();
    map.redraw();
    renderCard();
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  startBtn.addEventListener("click", function () {
    if (walk) endWalk("stopped");
    else startWalk();
  });

  clearBtn.addEventListener("click", function () {
    target = null;
    route = null;
    message = "";
    set3dRoute();
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
    hereBtn.disabled = !grid || !!walk || rb.isMoving() || !map.getSelected();
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
    if ((rangeBox.checked || target) && p && !rb.isMoving() && (!res || cellOf(p) !== res.src)) {
      computePlan();
      replanned = true;
    }
    var s = stale();
    if (s !== wasStale || replanned) {
      wasStale = s;
      set3dRoute();
      if (rangeBox.checked || target) map.redraw();
      renderCard();
    }
  }

  import("./content.js").then(function (mod) {
    TEXT = mod.content.walk;
    applyText();
  }).catch(function () {
    statusEl.textContent = "content.js could not be loaded (open the page through a local web server).";
  });

  requestAnimationFrame(frame);
})();

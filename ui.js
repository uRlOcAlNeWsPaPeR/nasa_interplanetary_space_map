/*
 * ui.js -- layer toggle panel, map canvas, click-to-sample info panel,
 * hazard highlighting.
 *
 * RULE: no terrain data, site names or layer names are hardcoded here.
 * Everything comes from window.MarsData (see mock-data.js for the contract).
 * What lives here is presentation only: colors, labels for the sample
 * fields, units, number formatting and visual effects.
 */
(function () {
  "use strict";

  var data = window.MarsData;

  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
  var fxCanvas = document.getElementById("map-fx");
  var fx = fxCanvas.getContext("2d");
  var mapLegend = document.getElementById("map-legend-hazards");
  var sendRoverBtn = document.getElementById("send-rover");
  var layerList = document.getElementById("layer-list");
  var hazardList = document.getElementById("hazard-list");
  var siteLegend = document.getElementById("site-legend");
  var infoBody = document.getElementById("info-body");
  var hoverReadout = document.getElementById("hover-readout");

  // ---- presentation config (style, not data) --------------------------------

  // The five fields of sampleTerrainAt(), how to label and format them.
  var FIELDS = [
    { key: "elevation", label: "Elevation", format: function (v) { return Math.round(v) + " m"; } },
    { key: "slope", label: "Slope", format: percent },
    { key: "dustRisk", label: "Dust risk", format: percent },
    { key: "temperature", label: "Temperature", format: function (v) { return v.toFixed(1) + " °C"; } },
    { key: "mineralIndex", label: "Mineral index", format: function (v) { return v.toFixed(2); } }
  ];

  // Which sample field a layer draws, picked by keyword in the layer's name,
  // so a renamed or new layer from the data module still gets a sensible ramp.
  var LAYER_STYLES = [
    { match: /elev|topo|mola/i, key: "elevation", ramp: [[38, 22, 18], [150, 78, 46], [240, 214, 176]] },
    { match: /therm|temp|themis/i, key: "temperature", ramp: [[40, 70, 190], [235, 225, 215], [220, 50, 40]] },
    { match: /mineral|crism|spectral/i, key: "mineralIndex", ramp: [[30, 30, 40], [40, 150, 140], [190, 255, 190]] },
    { match: /dust/i, key: "dustRisk", ramp: [[60, 50, 45], [200, 150, 80], [255, 230, 150]] },
    { match: /slope/i, key: "slope", ramp: [[25, 25, 30], [150, 90, 170], [255, 220, 255]] }
  ];
  var FALLBACK_STYLE = { key: "elevation", ramp: [[30, 30, 30], [140, 140, 140], [240, 240, 240]] };

  var SITE_COLORS = { landing: "#5fd08a", science: "#5bb4f0", hazard: "#f06a5b" };
  var SITE_FALLBACK_COLOR = "#ffffff";
  var SITE_SNAP_RADIUS = 0.035; // normalized distance for "you clicked a site"

  // Sample fields (0-1) that get a "highlight above this limit" slider.
  // Each hazard has its own color AND its own texture, so they stay apart
  // even where they overlap or for viewers who can't tell the colors apart.
  // Colors are chosen to stand out from the red-brown terrain.
  var HAZARDS = [
    { key: "slope", color: [236, 72, 255], pattern: "hatch", patternName: "hatched" },          // magenta
    { key: "dustRisk", color: [40, 215, 255], pattern: "particles", patternName: "drifting dust" } // cyan
  ];
  var HAZARD_SMOOTH_RADIUS = 3;  // px; smooths zone edges so they don't speckle
  var HAZARD_EDGE = 2;           // px width of the colored zone border
  var HATCH_SPACING = 8;         // px between slope hatch lines
  var HATCH_WIDTH = 2;           // px width of each hatch line
  var BASE_GRAY = 46;            // map colour where no layer is showing

  // Dust particles: purely visual, drifting with a made-up display "wind".
  var DUST_WIND = { x: 0.45, y: 0.12 };  // px per frame
  var DUST_PER_PIXELS = 220;             // one particle per this many zone pixels
  var DUST_MAX_PARTICLES = 420;
  var DUST_LIFE = { min: 70, max: 160 }; // frames

  function percent(v) {
    return Math.round(v * 100) + "%";
  }

  function css(rgb, alpha) {
    return alpha === undefined
      ? "rgb(" + rgb.join(",") + ")"
      : "rgba(" + rgb.join(",") + "," + alpha + ")";
  }

  // ---- state ----------------------------------------------------------------

  var W = canvas.width;
  var H = canvas.height;
  var layers = data.getActiveLayers();
  var sites = data.getNamedSites();
  var enabled = {};
  var opacity = {};    // layer name -> 0..1
  var limits = {};     // hazard field key -> 0..1, 1 means "off"
  var coverage = {};   // hazard field key -> share of the map inside the zone
  var selected = null; // { nx, ny }
  var fieldCache = {}; // key -> { values: Float32Array, min, max }
  var smoothCache = {};
  var overlays = [];   // extra draw(ctx, W, H) callbacks, e.g. the route from rover.js
  var hazardListeners = [];
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function hazardFor(key) {
    for (var i = 0; i < HAZARDS.length; i++) {
      if (HAZARDS[i].key === key) return HAZARDS[i];
    }
    return null;
  }

  function fieldFor(key) {
    return FIELDS.filter(function (f) { return f.key === key; })[0];
  }

  function isOver(key, value) {
    return key in limits && limits[key] < 1 && value > limits[key];
  }

  // Hook for other modules (rover.js) to draw on the map and to match the
  // hazard colors and limits.
  window.MapUI = {
    addOverlay: function (draw) { overlays.push(draw); },
    redraw: function () { render(); },
    hazardColor: function (key) {
      var hz = hazardFor(key);
      return hz ? css(hz.color) : null;
    },
    isOverHazardLimit: isOver,
    // Active limit for a hazard (0-1), or null when its highlight is off.
    hazardLimit: function (key) {
      return key in limits && limits[key] < 1 ? limits[key] : null;
    },
    hazardKeys: function () { return HAZARDS.map(function (hz) { return hz.key; }); },
    onHazardChange: function (cb) { hazardListeners.push(cb); },
    // The point last clicked on the map, or null.
    getSelected: function () { return selected ? { nx: selected.nx, ny: selected.ny } : null; }
  };

  // ---- sampling the data module into per-pixel fields ------------------------

  function styleFor(layerName) {
    for (var i = 0; i < LAYER_STYLES.length; i++) {
      if (LAYER_STYLES[i].match.test(layerName)) return LAYER_STYLES[i];
    }
    return FALLBACK_STYLE;
  }

  function withRange(values) {
    var min = Infinity;
    var max = -Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
      if (values[i] > max) max = values[i];
    }
    return { values: values, min: min, max: max };
  }

  function getField(key) {
    if (fieldCache[key]) return fieldCache[key];
    var values;
    if (key === "elevation") {
      values = data.getElevationGrid(W, H);
    } else {
      values = new Float32Array(W * H);
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          values[y * W + x] = data.sampleTerrainAt(x / (W - 1), y / (H - 1))[key];
        }
      }
    }
    fieldCache[key] = withRange(values);
    return fieldCache[key];
  }

  // Box-blurred copy of a field, used only to decide hazard zone shapes,
  // so the zones are smooth regions instead of noisy speckle.
  function getSmoothField(key) {
    if (smoothCache[key]) return smoothCache[key];
    var src = getField(key).values;
    var tmp = new Float32Array(W * H);
    var out = new Float32Array(W * H);
    var r = HAZARD_SMOOTH_RADIUS;
    var x, y, k, sum, n;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        sum = 0; n = 0;
        for (k = -r; k <= r; k++) {
          var xx = x + k;
          if (xx >= 0 && xx < W) { sum += src[y * W + xx]; n++; }
        }
        tmp[y * W + x] = sum / n;
      }
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        sum = 0; n = 0;
        for (k = -r; k <= r; k++) {
          var yy = y + k;
          if (yy >= 0 && yy < H) { sum += tmp[yy * W + x]; n++; }
        }
        out[y * W + x] = sum / n;
      }
    }
    smoothCache[key] = out;
    return out;
  }

  // ---- drawing --------------------------------------------------------------

  function rampColor(ramp, t, out) {
    var scaled = t * (ramp.length - 1);
    var i = Math.min(Math.floor(scaled), ramp.length - 2);
    var f = scaled - i;
    out[0] = ramp[i][0] + (ramp[i + 1][0] - ramp[i][0]) * f;
    out[1] = ramp[i][1] + (ramp[i + 1][1] - ramp[i][1]) * f;
    out[2] = ramp[i][2] + (ramp[i + 1][2] - ramp[i][2]) * f;
  }

  // True if any pixel within d (4 directions) of (x, y) has mask value `want`.
  function neighbor(mask, x, y, d, want) {
    for (var s = 1; s <= d; s++) {
      if (x - s >= 0 && mask[y * W + x - s] === want) return true;
      if (x + s < W && mask[y * W + x + s] === want) return true;
      if (y - s >= 0 && mask[(y - s) * W + x] === want) return true;
      if (y + s < H && mask[(y + s) * W + x] === want) return true;
    }
    return false;
  }

  function buildHazardZones() {
    return HAZARDS.filter(function (hz) { return limits[hz.key] < 1; }).map(function (hz) {
      var values = getSmoothField(hz.key);
      var limit = limits[hz.key];
      var mask = new Uint8Array(W * H);
      var count = 0;
      for (var i = 0; i < mask.length; i++) {
        if (values[i] > limit) { mask[i] = 1; count++; }
      }
      coverage[hz.key] = count / mask.length;
      return { hz: hz, values: values, limit: limit, mask: mask, count: count };
    });
  }

  function render() {
    var image = ctx.createImageData(W, H);
    var px = image.data;
    var active = layers.filter(function (name) { return enabled[name]; });
    var rgb = [0, 0, 0];

    // Hillshade from elevation so terrain shape stays readable under any layer.
    var elev = getField("elevation");
    var span = elev.max - elev.min || 1;

    var drawn = active.filter(function (name) { return opacity[name] > 0; }).map(function (name) {
      var style = styleFor(name);
      return { style: style, field: getField(style.key), weight: opacity[name] };
    });
    var totalWeight = 0;
    var maxWeight = 0;
    drawn.forEach(function (d) {
      totalWeight += d.weight;
      if (d.weight > maxWeight) maxWeight = d.weight;
    });

    HAZARDS.forEach(function (hz) { coverage[hz.key] = 0; });
    var zones = buildHazardZones();

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        var r = 0, g = 0, b = 0;

        for (var k = 0; k < drawn.length; k++) {
          var f = drawn[k].field;
          var t = (f.values[i] - f.min) / (f.max - f.min || 1);
          rampColor(drawn[k].style.ramp, t, rgb);
          var w = drawn[k].weight;
          r += rgb[0] * w; g += rgb[1] * w; b += rgb[2] * w;
        }
        if (drawn.length) {
          // Weighted mix of the layers, faded toward gray by the strongest opacity.
          r = BASE_GRAY + (r / totalWeight - BASE_GRAY) * maxWeight;
          g = BASE_GRAY + (g / totalWeight - BASE_GRAY) * maxWeight;
          b = BASE_GRAY + (b / totalWeight - BASE_GRAY) * maxWeight;
        } else {
          r = g = b = BASE_GRAY;
        }

        var left = elev.values[y * W + Math.max(x - 1, 0)];
        var up = elev.values[Math.max(y - 1, 0) * W + x];
        var shade = 1 + ((elev.values[i] - left) + (elev.values[i] - up)) / span * 22;
        shade = shade < 0.55 ? 0.55 : shade > 1.35 ? 1.35 : shade;
        r *= shade; g *= shade; b *= shade;

        // Hazards, in order: translucent tint inside the zone (stronger the
        // further over the limit), slope hatching, a solid colored border,
        // and a dark halo just outside the border for contrast on any terrain.
        var inAny = false, edge = null, halo = false;
        for (var z = 0; z < zones.length; z++) {
          var zone = zones[z];
          var c = zone.hz.color;
          if (zone.mask[i]) {
            inAny = true;
            // Kept light so the terrain underneath stays readable.
            var a = 0.14 + 0.22 * Math.min(1, (zone.values[i] - zone.limit) / 0.25);
            r += (c[0] - r) * a; g += (c[1] - g) * a; b += (c[2] - b) * a;
            if (zone.hz.pattern === "hatch" && ((x - y) % HATCH_SPACING + HATCH_SPACING) % HATCH_SPACING < HATCH_WIDTH) {
              r += (c[0] - r) * 0.7; g += (c[1] - g) * 0.7; b += (c[2] - b) * 0.7;
            }
            if (neighbor(zone.mask, x, y, HAZARD_EDGE, 0)) edge = c;
          } else if (neighbor(zone.mask, x, y, HAZARD_EDGE, 1)) {
            halo = true;
          }
        }
        if (edge) {
          r = edge[0]; g = edge[1]; b = edge[2];
        } else if (halo && !inAny) {
          r *= 0.3; g *= 0.3; b *= 0.3;
        }

        px[i * 4] = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    // The 3D ground gets terrain + hazards only; labels and routes are 3D objects there.
    if (world) world.updateGround(canvas);
    overlays.forEach(function (draw) { draw(ctx, W, H); });
    drawSites();
    drawSelection();

    var dustZone = zones.filter(function (zone) { return zone.hz.pattern === "particles"; })[0];
    setDustZone(dustZone || null);
    updateMapLegend();
  }

  function drawSites() {
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    sites.forEach(function (site) {
      var x = site.nx * (W - 1);
      var y = site.ny * (H - 1);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = SITE_COLORS[site.type] || SITE_FALLBACK_COLOR;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#14100e";
      ctx.stroke();

      var labelLeft = x + 9 + ctx.measureText(site.name).width > W;
      ctx.textAlign = labelLeft ? "right" : "left";
      var lx = labelLeft ? x - 9 : x + 9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(20,16,14,.85)";
      ctx.strokeText(site.name, lx, y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(site.name, lx, y);
    });
  }

  function drawSelection() {
    if (!selected) return;
    var x = selected.nx * (W - 1);
    var y = selected.ny * (H - 1);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(20,16,14,.9)";
    cross(x, y);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    cross(x, y);
  }

  function cross(x, y) {
    ctx.beginPath();
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 4, y);
    ctx.moveTo(x + 4, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 4);
    ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 11);
    ctx.stroke();
  }

  // ---- drifting dust particles (separate canvas on top of the map) ----------

  var dust = { zone: null, particles: [], running: false, color: [0, 0, 0] };

  function setDustZone(zone) {
    dust.zone = zone;
    if (!zone) {
      dust.particles = [];
      fx.clearRect(0, 0, W, H);
      return;
    }
    // Particles are a lighter version of the dust hazard color.
    var c = zone.hz.color;
    dust.color = [c[0] + (255 - c[0]) * 0.6, c[1] + (255 - c[1]) * 0.6, c[2] + (255 - c[2]) * 0.6].map(Math.round);
    var target = Math.min(DUST_MAX_PARTICLES, Math.round(zone.count / DUST_PER_PIXELS));
    dust.particles = dust.particles.filter(function (p) {
      return zone.mask[Math.floor(p.y) * W + Math.floor(p.x)];
    }).slice(0, target);
    while (dust.particles.length < target) {
      var p = spawnParticle(true);
      if (!p) break;
      dust.particles.push(p);
    }
    if (reduceMotion) {
      drawParticles();
    } else if (!dust.running) {
      dust.running = true;
      requestAnimationFrame(stepDust);
    }
  }

  function spawnParticle(randomAge) {
    var zone = dust.zone;
    for (var tries = 0; tries < 40; tries++) {
      var x = Math.random() * W;
      var y = Math.random() * H;
      if (!zone.mask[Math.floor(y) * W + Math.floor(x)]) continue;
      var life = DUST_LIFE.min + Math.random() * (DUST_LIFE.max - DUST_LIFE.min);
      return {
        x: x,
        y: y,
        vx: DUST_WIND.x * (0.6 + Math.random() * 0.8),
        vy: DUST_WIND.y * (0.6 + Math.random() * 0.8),
        phase: Math.random() * Math.PI * 2,
        size: 1 + Math.random() * 1.6,
        life: life,
        age: randomAge ? Math.random() * life : 0
      };
    }
    return null;
  }

  function stepDust() {
    if (!dust.zone) {
      dust.running = false;
      return;
    }
    var mask = dust.zone.mask;
    for (var i = 0; i < dust.particles.length; i++) {
      var p = dust.particles[i];
      p.age++;
      p.x += p.vx + Math.sin(p.age * 0.07 + p.phase) * 0.18;
      p.y += p.vy + Math.cos(p.age * 0.05 + p.phase) * 0.12;
      var outside = p.x < 0 || p.y < 0 || p.x >= W || p.y >= H || !mask[Math.floor(p.y) * W + Math.floor(p.x)];
      // Particles leaving the zone fade out quickly instead of vanishing.
      if (outside && p.age < p.life - 12) p.age = p.life - 12;
      if (p.age >= p.life) {
        var fresh = spawnParticle(false);
        if (fresh) dust.particles[i] = fresh;
      }
    }
    drawParticles();
    requestAnimationFrame(stepDust);
  }

  function drawParticles() {
    fx.clearRect(0, 0, W, H);
    var c = dust.color;
    for (var i = 0; i < dust.particles.length; i++) {
      var p = dust.particles[i];
      var alpha = Math.sin(Math.PI * Math.min(1, p.age / p.life)) * 0.85;
      if (alpha <= 0.02) continue;
      fx.fillStyle = "rgba(10,20,26," + (alpha * 0.6).toFixed(3) + ")";
      fx.fillRect(p.x + 0.8, p.y + 0.8, p.size, p.size);
      fx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha.toFixed(3) + ")";
      fx.fillRect(p.x, p.y, p.size, p.size);
    }
  }

  // ---- legends and panels ---------------------------------------------------

  function makeSwatch(hz) {
    var swatch = document.createElement("span");
    swatch.className = "hazard-swatch hazard-swatch--" + hz.pattern;
    swatch.style.setProperty("--hz", css(hz.color));
    return swatch;
  }

  // Legend lists every hazard (dimmed when off); the route/rover keys below
  // it are static markup in index.html.
  function updateMapLegend() {
    mapLegend.textContent = "";
    HAZARDS.forEach(function (hz) {
      var field = fieldFor(hz.key);
      var on = limits[hz.key] < 1;
      var row = document.createElement("div");
      row.className = "map-legend-row" + (on ? "" : " is-off");
      row.appendChild(makeSwatch(hz));
      var text = document.createElement("span");
      var name = document.createElement("strong");
      name.textContent = on ? field.label + " > " + field.format(limits[hz.key]) : field.label + " hazard";
      text.appendChild(name);
      text.appendChild(document.createTextNode(on
        ? " · " + hz.patternName + " · " + Math.round(coverage[hz.key] * 100) + "% of map"
        : " · off"));
      row.appendChild(text);
      mapLegend.appendChild(row);
    });
  }

  function buildLayerPanel() {
    layerList.textContent = "";
    layers.forEach(function (name, index) {
      enabled[name] = index === 0; // first layer on by default
      opacity[name] = 1;
      var row = document.createElement("div");
      row.className = "layer-row";
      var label = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = enabled[name];
      box.addEventListener("change", function () {
        enabled[name] = box.checked;
        render();
      });
      label.appendChild(box);
      label.appendChild(document.createTextNode(name));
      var slider = makeSlider(name + " opacity");
      slider.addEventListener("input", function () {
        opacity[name] = slider.value / 100;
        render();
      });
      row.appendChild(label);
      row.appendChild(slider);
      layerList.appendChild(row);
    });
  }

  function makeSlider(ariaLabel) {
    var slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = "100";
    slider.setAttribute("aria-label", ariaLabel);
    return slider;
  }

  function hazardsChanged() {
    render();
    showInfo();
    hazardListeners.forEach(function (cb) { cb(); });
  }

  function buildHazardPanel() {
    hazardList.textContent = "";
    HAZARDS.forEach(function (hz) {
      var key = hz.key;
      limits[key] = 1;
      var field = fieldFor(key);
      var row = document.createElement("div");
      row.className = "hazard-row";
      row.style.setProperty("--hz", css(hz.color));
      var head = document.createElement("div");
      head.className = "hazard-head";
      var name = document.createElement("span");
      name.className = "hazard-name";
      name.appendChild(makeSwatch(hz));
      name.appendChild(document.createTextNode(field.label));
      var value = document.createElement("span");
      head.appendChild(name);
      head.appendChild(value);
      var slider = makeSlider(field.label + " limit");
      slider.style.accentColor = css(hz.color);
      function sync() {
        limits[key] = slider.value / 100;
        var on = limits[key] < 1;
        row.classList.toggle("is-on", on);
        value.textContent = on ? "above " + field.format(limits[key]) : "off";
      }
      slider.addEventListener("input", function () {
        sync();
        hazardsChanged();
      });
      sync();
      row.appendChild(head);
      row.appendChild(slider);
      hazardList.appendChild(row);
    });
  }

  function buildSiteLegend() {
    siteLegend.textContent = "";
    var seen = {};
    sites.forEach(function (site) {
      if (seen[site.type]) return;
      seen[site.type] = true;
      var row = document.createElement("div");
      row.className = "legend-row";
      var dot = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = SITE_COLORS[site.type] || SITE_FALLBACK_COLOR;
      row.appendChild(dot);
      row.appendChild(document.createTextNode(site.type + " site"));
      siteLegend.appendChild(row);
    });
  }

  function nearestSite(nx, ny) {
    var best = null;
    var bestDist = SITE_SNAP_RADIUS;
    sites.forEach(function (site) {
      var d = Math.sqrt(Math.pow(site.nx - nx, 2) + Math.pow(site.ny - ny, 2));
      if (d <= bestDist) { best = site; bestDist = d; }
    });
    return best;
  }

  function showInfo() {
    infoBody.textContent = "";
    sendRoverBtn.disabled = !selected;
    if (!selected) {
      var hint = document.createElement("p");
      hint.className = "empty";
      hint.textContent = "Click the map to sample a location.";
      infoBody.appendChild(hint);
      return;
    }
    var sample = data.sampleTerrainAt(selected.nx, selected.ny);
    var site = nearestSite(selected.nx, selected.ny);
    if (site) {
      var title = document.createElement("p");
      title.className = "site";
      title.textContent = site.name + " · " + site.type;
      infoBody.appendChild(title);
    }
    var list = document.createElement("dl");
    addRow(list, "Position", selected.nx.toFixed(3) + ", " + selected.ny.toFixed(3));
    FIELDS.forEach(function (field) {
      var value = sample[field.key];
      addRow(list, field.label, field.format(value), hazardFor(field.key), isOver(field.key, value));
    });
    infoBody.appendChild(list);
  }

  // Shared with rover.js through the same markup: a hazard row gets the
  // hazard's swatch, and a value over the active limit is shown in its color.
  function addRow(list, label, value, hz, over) {
    var dt = document.createElement("dt");
    if (hz) dt.appendChild(makeSwatch(hz));
    dt.appendChild(document.createTextNode(label));
    var dd = document.createElement("dd");
    dd.textContent = value;
    if (hz && over) {
      dd.className = "over";
      dd.style.setProperty("--hz", css(hz.color));
      dd.textContent = value + " ▲";
      dd.title = "Above the " + label.toLowerCase() + " limit";
    }
    list.appendChild(dt);
    list.appendChild(dd);
  }

  window.MapUI.addRow = function (list, label, value, key, over) {
    addRow(list, label, value, hazardFor(key), over);
  };

  // ---- interaction ----------------------------------------------------------

  function eventToNormalized(event) {
    var rect = canvas.getBoundingClientRect();
    var nx = (event.clientX - rect.left) / rect.width;
    var ny = (event.clientY - rect.top) / rect.height;
    return {
      nx: Math.min(Math.max(nx, 0), 1),
      ny: Math.min(Math.max(ny, 0), 1)
    };
  }

  // Shared by the 2D canvas and the 3D view.
  function selectAt(p) {
    selected = p;
    var site = nearestSite(p.nx, p.ny);
    if (site) selected = { nx: site.nx, ny: site.ny }; // snap to the site
    render();
    showInfo();
  }

  function showHover(p) {
    if (!p) {
      hoverReadout.textContent = "";
      return;
    }
    var sample = data.sampleTerrainAt(p.nx, p.ny);
    hoverReadout.textContent = FIELDS.map(function (field) {
      var over = isOver(field.key, sample[field.key]) ? " ▲" : "";
      return field.label + " " + field.format(sample[field.key]) + over;
    }).join("  ·  ");
  }

  canvas.addEventListener("click", function (event) {
    if (zoomDrag.wasDrag) {
      zoomDrag.wasDrag = false; // that was a pan, not a click
      return;
    }
    selectAt(eventToNormalized(event));
  });

  // ---- 2D zoom and pan --------------------------------------------------------

  var ZOOM_MAX = 6;
  var ZOOM_STEP = 1.4;
  var stageEl = document.getElementById("map-stage");
  var zoomEl = document.getElementById("map-zoom");
  var zoom2d = { s: 1, x: 0, y: 0 };
  var zoomDrag = { active: false, moved: false, wasDrag: false, x0: 0, y0: 0, ox: 0, oy: 0 };

  function applyZoom() {
    var w = zoomEl.offsetWidth;
    var h = zoomEl.offsetHeight;
    zoom2d.x = Math.min(0, Math.max(w - w * zoom2d.s, zoom2d.x));
    zoom2d.y = Math.min(0, Math.max(h - h * zoom2d.s, zoom2d.y));
    zoomEl.style.transform = "translate(" + zoom2d.x + "px," + zoom2d.y + "px) scale(" + zoom2d.s + ")";
    canvas.classList.toggle("is-zoomed", zoom2d.s > 1);
  }

  // Zoom by `factor`, keeping the stage point (cx, cy) fixed under the cursor.
  function zoomAt(factor, cx, cy) {
    var ns = Math.min(ZOOM_MAX, Math.max(1, zoom2d.s * factor));
    zoom2d.x = cx - (cx - zoom2d.x) * (ns / zoom2d.s);
    zoom2d.y = cy - (cy - zoom2d.y) * (ns / zoom2d.s);
    zoom2d.s = ns;
    applyZoom();
  }

  stageEl.addEventListener("wheel", function (e) {
    e.preventDefault();
    var rect = stageEl.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  canvas.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    zoomDrag.active = true;
    zoomDrag.moved = false;
    zoomDrag.x0 = e.clientX; zoomDrag.y0 = e.clientY;
    zoomDrag.ox = zoom2d.x; zoomDrag.oy = zoom2d.y;
  });
  window.addEventListener("pointermove", function (e) {
    if (!zoomDrag.active) return;
    var dx = e.clientX - zoomDrag.x0, dy = e.clientY - zoomDrag.y0;
    if (Math.abs(dx) + Math.abs(dy) > 5) zoomDrag.moved = true;
    if (zoomDrag.moved && zoom2d.s > 1) {
      zoom2d.x = zoomDrag.ox + dx;
      zoom2d.y = zoomDrag.oy + dy;
      applyZoom();
    }
  });
  window.addEventListener("pointerup", function () {
    if (!zoomDrag.active) return;
    zoomDrag.active = false;
    zoomDrag.wasDrag = zoomDrag.moved && zoom2d.s > 1;
  });

  function stageCenter() {
    return { x: stageEl.clientWidth / 2, y: stageEl.clientHeight / 2 };
  }

  canvas.addEventListener("mousemove", function (event) {
    showHover(eventToNormalized(event));
  });

  canvas.addEventListener("mouseleave", function () {
    showHover(null);
  });

  // ---- 3D world (the main view) ---------------------------------------------
  //
  // The full-screen world Ridgeback drives in. The terrain is built from
  // MarsData.getElevationGrid(), so swapping in real data reshapes it, and the
  // map's terrain + hazard colouring is draped over it as a texture, so the
  // layer toggles and hazard highlights show up on the ground you drive on.
  // Labels, routes and markers are real 3D objects (see rover.js), not paint.

  var WORLD_W = 400;           // world units across the map (rover is ~2.6 long)
  var WORLD_D = WORLD_W * H / W;
  var MESH_SEG_X = 320;        // mesh resolution
  var MESH_SEG_Y = Math.round(MESH_SEG_X * H / W);
  var HEIGHT_SCALE = 60;       // world units for the full elevation range (exaggerated)
  var SKY = 0xd9a47c;          // Ridgeback's dusty sky
  var CLICK_SLOP = 5;          // px a press may move and still count as a click

  var worldEl = document.getElementById("world");
  var world = null;
  var ready3d = [];

  // Run cb(api) once the 3D world exists (immediately if it already does).
  window.MapUI.on3dReady = function (cb) {
    if (world) cb(world.api);
    else ready3d.push(cb);
  };
  // Kept for modules written against the old 2D/3D toggle: the world is always 3D.
  window.MapUI.viewMode = function () { return world ? "3d" : "2d"; };
  window.MapUI.onViewChange = function () {};

  function createWorld() {
    var T = window.THREE;
    var renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    worldEl.appendChild(renderer.domElement);

    var scene = new T.Scene();
    scene.background = new T.Color(SKY);
    scene.fog = new T.Fog(SKY, 60, 330);
    var camera = new T.PerspectiveCamera(55, 1, 0.1, 900);
    camera.position.set(0, 120, 160);
    camera.lookAt(0, 0, 0);

    // Ground texture: the map's terrain and hazard colouring (no labels/routes).
    var comp = document.createElement("canvas");
    comp.width = W;
    comp.height = H;
    var compCtx = comp.getContext("2d");
    var texture = new T.CanvasTexture(comp);
    texture.encoding = T.sRGBEncoding;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // Terrain mesh from the contract's elevation grid. PlaneGeometry vertices
    // run row by row from the top edge, the same order as the grid.
    var geom = new T.PlaneGeometry(WORLD_W, WORLD_D, MESH_SEG_X, MESH_SEG_Y);
    var grid = data.getElevationGrid(MESH_SEG_X + 1, MESH_SEG_Y + 1);
    var range = withRange(grid);
    function heightOf(e) {
      return (e - range.min) / (range.max - range.min || 1) * HEIGHT_SCALE;
    }
    var pos = geom.attributes.position;
    // Small per-vertex brightness changes give close-up grain the 720px
    // texture can't (purely visual, the same trick Ridgeback uses).
    var tint = new Float32Array(pos.count * 3);
    for (var i = 0; i < pos.count; i++) {
      pos.setZ(i, heightOf(grid[i]));
      var vx = pos.getX(i), vy = pos.getY(i);
      var k = 0.93 + 0.07 * Math.sin(vx * 0.7 + vy * 0.5) * Math.cos(vy * 0.9 - vx * 0.3);
      tint[i * 3] = tint[i * 3 + 1] = tint[i * 3 + 2] = k;
    }
    geom.setAttribute("color", new T.BufferAttribute(tint, 3));
    geom.computeVertexNormals();

    var ground = new T.Mesh(geom, new T.MeshStandardMaterial({
      map: texture, vertexColors: true, flatShading: true, roughness: 1, metalness: 0
    }));
    ground.rotation.x = -Math.PI / 2; // lie flat; top of the map is the far side
    ground.receiveShadow = true;
    scene.add(ground);

    // Ridgeback's lighting: warm sky/ground fill plus a sun that follows the
    // rover (rover.js moves it) so shadows stay sharp near the camera.
    scene.add(new T.HemisphereLight(0xffe0c0, 0x7a3a20, 0.75));
    var sun = new T.DirectionalLight(0xfff0dd, 1.0);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    var sc = sun.shadow.camera;
    sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 260;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.position.set(40, 90, 25);
    scene.add(sun);
    scene.add(sun.target);

    // Height of the rendered terrain surface at a map position, interpolated
    // from the same grid the mesh is built from, so things sit exactly on it.
    function surfaceY(nx, ny) {
      var gx = Math.min(Math.max(nx, 0), 1) * MESH_SEG_X;
      var gy = Math.min(Math.max(ny, 0), 1) * MESH_SEG_Y;
      var x0 = Math.min(Math.floor(gx), MESH_SEG_X - 1);
      var y0 = Math.min(Math.floor(gy), MESH_SEG_Y - 1);
      var fx0 = gx - x0, fy0 = gy - y0;
      var row = MESH_SEG_X + 1;
      var a = grid[y0 * row + x0], b = grid[y0 * row + x0 + 1];
      var c = grid[(y0 + 1) * row + x0], d = grid[(y0 + 1) * row + x0 + 1];
      var e = a + (b - a) * fx0 + (c - a) * fy0 + (a - b - c + d) * fx0 * fy0;
      return heightOf(e);
    }
    function surfacePoint(nx, ny, lift) {
      return new T.Vector3((nx - 0.5) * WORLD_W, surfaceY(nx, ny) + (lift || 0), (ny - 0.5) * WORLD_D);
    }

    // Site markers: a pole, a coloured beacon and a name label that always
    // faces the camera, so sites can be found while driving.
    function labelSprite(text, color) {
      var c = document.createElement("canvas");
      var g = c.getContext("2d");
      var font = "600 44px system-ui, sans-serif";
      g.font = font;
      c.width = Math.ceil(g.measureText(text).width) + 48;
      c.height = 72;
      g.font = font;
      g.fillStyle = "rgba(18,26,34,.78)";
      g.beginPath();
      if (g.roundRect) g.roundRect(0, 0, c.width, c.height, 16); else g.rect(0, 0, c.width, c.height);
      g.fill();
      g.fillStyle = color;
      g.fillRect(16, 26, 20, 20);
      g.fillStyle = "#ffffff";
      g.textBaseline = "middle";
      g.fillText(text, 44, c.height / 2 + 2);
      var tex = new T.CanvasTexture(c);
      tex.encoding = T.sRGBEncoding;
      var sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, depthWrite: false, fog: false }));
      var h = 2.6;
      sprite.scale.set(h * c.width / c.height, h, 1);
      return sprite;
    }
    // A ring on the ground and a soft light column (no solid pole), so the
    // rover can drive right onto a site without clipping through anything.
    sites.forEach(function (site) {
      var color = SITE_COLORS[site.type] || SITE_FALLBACK_COLOR;
      var base = surfacePoint(site.nx, site.ny, 0);
      var ring = new T.Mesh(new T.RingGeometry(3.2, 3.8, 48), new T.MeshBasicMaterial({
        color: color, side: T.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false
      }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(base.x, base.y + 0.12, base.z);
      var column = new T.Mesh(new T.CylinderGeometry(0.35, 0.35, 12, 16, 1, true), new T.MeshBasicMaterial({
        color: color, transparent: true, opacity: 0.25, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending
      }));
      column.position.set(base.x, base.y + 6, base.z);
      var beacon = new T.Mesh(new T.SphereGeometry(0.7, 16, 12),
        new T.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 0.6 }));
      beacon.position.set(base.x, base.y + 12.4, base.z);
      var label = labelSprite(site.name, color);
      label.position.set(base.x, base.y + 14.6, base.z);
      scene.add(ring);
      scene.add(column);
      scene.add(beacon);
      scene.add(label);
    });

    // Inspect marker: where the user last clicked.
    var marker = new T.Group();
    var markRing = new T.Mesh(new T.RingGeometry(1.6, 2.1, 40),
      new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
    markRing.rotation.x = -Math.PI / 2;
    marker.add(markRing);
    var markPole = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 5, 6), new T.MeshBasicMaterial({ color: 0xffffff }));
    markPole.position.y = 2.5;
    marker.add(markPole);
    marker.visible = false;
    scene.add(marker);

    // Picking: ray from the pointer to the terrain, read the texture coords.
    var raycaster = new T.Raycaster();
    var ndc = new T.Vector2();
    function pick(event) {
      var rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      var hit = raycaster.intersectObject(ground)[0];
      return hit && hit.uv ? { nx: hit.uv.x, ny: 1 - hit.uv.y } : null;
    }

    var downAt = null;
    var el = renderer.domElement;
    el.addEventListener("pointerdown", function (e) { downAt = { x: e.clientX, y: e.clientY }; });
    el.addEventListener("pointerup", function (e) {
      if (!downAt || e.button !== 0) return;
      var moved = Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y);
      downAt = null;
      if (moved > CLICK_SLOP) return; // that was a drag to look around
      var p = pick(e);
      if (p) selectAt(p);
    });
    // Hover readout, at most once per frame (picking the big mesh isn't free).
    var hoverEvent = null;
    el.addEventListener("pointermove", function (e) { hoverEvent = e; });
    el.addEventListener("pointerleave", function () { hoverEvent = null; showHover(null); });

    function resize() {
      var w = worldEl.clientWidth || 1, h = worldEl.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    if (window.ResizeObserver) new ResizeObserver(resize).observe(worldEl);
    else window.addEventListener("resize", resize);
    resize();

    var dirty = true;
    var frameCallbacks = [];
    var lastFrame = 0;
    var clock = 0;

    function frame(now) {
      var dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
      lastFrame = now;
      clock += dt;
      if (hoverEvent && !downAt) {
        showHover(pick(hoverEvent));
        hoverEvent = null;
      }
      if (selected) {
        marker.visible = true;
        marker.position.copy(surfacePoint(selected.nx, selected.ny, 0.15));
        var s = 1 + Math.sin(clock * 4) * 0.12;
        markRing.scale.set(s, s, s);
      } else {
        marker.visible = false;
      }
      frameCallbacks.forEach(function (cb) { cb(dt); });
      if (dirty) {
        texture.needsUpdate = true;
        dirty = false;
      }
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // What other modules (rover.js) get to build on the world.
    var api = {
      THREE: T,
      scene: scene,
      camera: camera,
      sun: sun,
      dom: renderer.domElement,
      planeWidth: WORLD_W,
      planeDepth: WORLD_D,
      surfacePoint: surfacePoint,
      // Map position (nx, ny) for a world-space x/z.
      toMap: function (x, z) {
        return { nx: x / WORLD_W + 0.5, ny: z / WORLD_D + 0.5 };
      },
      onFrame: function (cb) { frameCallbacks.push(cb); }
    };
    ready3d.forEach(function (cb) { cb(api); });
    ready3d = [];

    return {
      api: api,
      // Called by render() with the freshly drawn terrain + hazards, before
      // labels and routes are painted on the minimap.
      updateGround: function (source) {
        compCtx.drawImage(source, 0, 0);
        dirty = true;
      }
    };
  }

  function has3d() {
    if (!window.THREE) return false;
    try {
      var test = document.createElement("canvas");
      return !!(test.getContext("webgl") || test.getContext("experimental-webgl"));
    } catch (e) {
      return false;
    }
  }

  // ---- minimap controls --------------------------------------------------------

  var minimapEl = document.getElementById("minimap");
  document.getElementById("map-expand").addEventListener("click", function () {
    var big = minimapEl.classList.toggle("is-expanded");
    this.setAttribute("aria-pressed", String(big));
    this.textContent = big ? "Shrink map" : "Expand map";
    requestAnimationFrame(applyZoom);
  });
  document.getElementById("reset-view").addEventListener("click", function () {
    zoom2d = { s: 1, x: 0, y: 0 };
    applyZoom();
  });
  [["zoom-in", ZOOM_STEP], ["zoom-out", 1 / ZOOM_STEP]].forEach(function (pair) {
    document.getElementById(pair[0]).addEventListener("click", function () {
      var c = stageCenter();
      zoomAt(pair[1], c.x, c.y);
    });
  });
  window.addEventListener("resize", applyZoom);

  document.getElementById("clear-sample").addEventListener("click", function () {
    selected = null;
    render();
    showInfo();
  });

  document.getElementById("reset-layers").addEventListener("click", function () {
    buildLayerPanel();
    buildHazardPanel();
    hazardsChanged();
  });

  buildLayerPanel();
  buildHazardPanel();
  buildSiteLegend();
  if (has3d()) {
    world = createWorld();
  } else {
    worldEl.classList.add("no-3d");
    worldEl.textContent = "The 3D view needs WebGL and the three.js script (an internet connection). The map still works.";
  }
  render();
  showInfo();
  // Prepare the hazard fields after first paint, so the first slider drag
  // doesn't stall while they are sampled.
  setTimeout(function () {
    HAZARDS.forEach(function (hz) { getSmoothField(hz.key); });
  }, 0);
})();

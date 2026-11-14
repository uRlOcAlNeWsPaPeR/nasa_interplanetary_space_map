/*
 * ui.js -- layer toggle panel, map canvas, click-to-sample info panel.
 *
 * RULE: no terrain data, site names or layer names are hardcoded here.
 * Everything comes from window.MarsData (see mock-data.js for the contract).
 * What lives here is presentation only: colors, labels for the sample
 * fields, units and number formatting.
 */
(function () {
  "use strict";

  var data = window.MarsData;

  var canvas = document.getElementById("map");
  var ctx = canvas.getContext("2d");
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
  var HAZARD_KEYS = ["slope", "dustRisk"];
  var HAZARD_TINT = [235, 60, 50];
  var BASE_GRAY = 46; // map colour where no layer is showing

  function percent(v) {
    return Math.round(v * 100) + "%";
  }

  // ---- state ----------------------------------------------------------------

  var W = canvas.width;
  var H = canvas.height;
  var layers = data.getActiveLayers();
  var sites = data.getNamedSites();
  var enabled = {};
  var opacity = {};    // layer name -> 0..1
  var limits = {};     // hazard field key -> 0..1, 1 means "off"
  var selected = null; // { nx, ny }
  var fieldCache = {}; // key -> { values: Float32Array, min, max }
  var overlays = []; // extra draw(ctx, W, H) callbacks, e.g. the route from rover.js

  // Hook for other modules to draw on the map (drawn under the site markers).
  window.MapUI = {
    addOverlay: function (draw) { overlays.push(draw); },
    redraw: function () { render(); }
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

  // ---- drawing --------------------------------------------------------------

  function rampColor(ramp, t, out) {
    var scaled = t * (ramp.length - 1);
    var i = Math.min(Math.floor(scaled), ramp.length - 2);
    var f = scaled - i;
    out[0] = ramp[i][0] + (ramp[i + 1][0] - ramp[i][0]) * f;
    out[1] = ramp[i][1] + (ramp[i + 1][1] - ramp[i][1]) * f;
    out[2] = ramp[i][2] + (ramp[i + 1][2] - ramp[i][2]) * f;
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

    var hazards = HAZARD_KEYS.filter(function (key) { return limits[key] < 1; }).map(function (key) {
      return { values: getField(key).values, limit: limits[key] };
    });

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

        for (var h = 0; h < hazards.length; h++) {
          if (hazards[h].values[i] > hazards[h].limit) {
            r = (r + HAZARD_TINT[0]) / 2;
            g = (g + HAZARD_TINT[1]) / 2;
            b = (b + HAZARD_TINT[2]) / 2;
            break;
          }
        }

        px[i * 4] = r;
        px[i * 4 + 1] = g;
        px[i * 4 + 2] = b;
        px[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    overlays.forEach(function (draw) { draw(ctx, W, H); });
    drawSites();
    drawSelection();
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

  // ---- panels ---------------------------------------------------------------

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

  function buildHazardPanel() {
    hazardList.textContent = "";
    HAZARD_KEYS.forEach(function (key) {
      limits[key] = 1;
      var field = FIELDS.filter(function (f) { return f.key === key; })[0];
      var row = document.createElement("div");
      row.className = "hazard-row";
      var head = document.createElement("div");
      head.className = "hazard-head";
      var name = document.createElement("span");
      name.textContent = field.label;
      var value = document.createElement("span");
      head.appendChild(name);
      head.appendChild(value);
      var slider = makeSlider(field.label + " limit");
      function sync() {
        limits[key] = slider.value / 100;
        value.textContent = limits[key] < 1 ? "above " + field.format(limits[key]) : "off";
      }
      slider.addEventListener("input", function () {
        sync();
        render();
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
      addRow(list, field.label, field.format(sample[field.key]));
    });
    infoBody.appendChild(list);
  }

  function addRow(list, label, value) {
    var dt = document.createElement("dt");
    dt.textContent = label;
    var dd = document.createElement("dd");
    dd.textContent = value;
    list.appendChild(dt);
    list.appendChild(dd);
  }

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

  canvas.addEventListener("click", function (event) {
    selected = eventToNormalized(event);
    var site = nearestSite(selected.nx, selected.ny);
    if (site) selected = { nx: site.nx, ny: site.ny }; // snap to the site
    render();
    showInfo();
  });

  canvas.addEventListener("mousemove", function (event) {
    var p = eventToNormalized(event);
    var sample = data.sampleTerrainAt(p.nx, p.ny);
    hoverReadout.textContent = FIELDS.map(function (field) {
      return field.label + " " + field.format(sample[field.key]);
    }).join("  ·  ");
  });

  canvas.addEventListener("mouseleave", function () {
    hoverReadout.textContent = "";
  });

  document.getElementById("clear-sample").addEventListener("click", function () {
    selected = null;
    render();
    showInfo();
  });

  document.getElementById("reset-layers").addEventListener("click", function () {
    buildLayerPanel();
    buildHazardPanel();
    render();
  });

  buildLayerPanel();
  buildHazardPanel();
  buildSiteLegend();
  render();
  showInfo();
})();

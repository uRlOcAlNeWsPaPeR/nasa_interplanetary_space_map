/*
 * mock-data.js  --  ALL VALUES IN THIS FILE ARE FAKE.
 *
 * Placeholder for the real data module (Mars Trek: MOLA elevation, THEMIS
 * thermal, CRISM mineral data for Jezero Crater). Nothing here is measured.
 *
 * The UI only ever talks to window.MarsData, through these four functions:
 *
 *   sampleTerrainAt(nx, ny) -> { elevation, slope, dustRisk, temperature, mineralIndex }
 *   getActiveLayers()       -> string[]
 *   getNamedSites()         -> [{ name, nx, ny, type: "landing"|"science"|"hazard" }]
 *   getElevationGrid(w, h)  -> Float32Array (row-major, length w*h)
 *
 * To swap in real data: keep the same four names and return shapes, and point
 * window.MarsData at the real module. No changes to ui.js / rover.js needed.
 */
(function () {
  "use strict";

  // ---- deterministic noise (no Math.random, so the map is stable) ----------

  function hash(ix, iy, seed) {
    var h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967295;
  }

  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  function valueNoise(x, y, seed) {
    var ix = Math.floor(x);
    var iy = Math.floor(y);
    var fx = smooth(x - ix);
    var fy = smooth(y - iy);
    var a = hash(ix, iy, seed);
    var b = hash(ix + 1, iy, seed);
    var c = hash(ix, iy + 1, seed);
    var d = hash(ix + 1, iy + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  // Fractal noise, returns 0..1
  function fbm(x, y, seed) {
    var sum = 0;
    var amp = 0.5;
    var freq = 1;
    var norm = 0;
    for (var i = 0; i < 5; i++) {
      sum += amp * valueNoise(x * freq, y * freq, seed + i * 17);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // ---- fake terrain model ---------------------------------------------------

  // A made-up crater: bowl in the middle, raised rim, rough plains outside.
  var CRATER = { cx: 0.52, cy: 0.5, radius: 0.34 };
  // A made-up fan-shaped "delta" lobe on the west side of the crater floor.
  var DELTA = { cx: 0.3, cy: 0.42, radius: 0.13 };

  var ELEV_MIN = -2600; // meters, relative (fake)
  var ELEV_MAX = 600;

  function elevationAt(nx, ny) {
    var dx = nx - CRATER.cx;
    var dy = ny - CRATER.cy;
    var r = Math.sqrt(dx * dx + dy * dy) / CRATER.radius; // 1 = rim

    var bowl = r < 1 ? -2100 * (1 - r * r) : 0;
    var rim = 520 * Math.exp(-Math.pow((r - 1) / 0.12, 2));
    var rough = (fbm(nx * 6, ny * 6, 11) - 0.5) * 700;
    var fine = (fbm(nx * 24, ny * 24, 29) - 0.5) * 160;

    var ddx = nx - DELTA.cx;
    var ddy = ny - DELTA.cy;
    var dr = Math.sqrt(ddx * ddx + ddy * ddy) / DELTA.radius;
    var delta = dr < 1 ? 380 * (1 - dr) : 0;

    return bowl + rim + rough + fine + delta;
  }

  function sampleTerrainAt(nx, ny) {
    nx = clamp01(nx);
    ny = clamp01(ny);

    var elevation = elevationAt(nx, ny);

    // Slope from a finite-difference gradient of the fake elevation.
    var e = 0.004;
    var gx = (elevationAt(nx + e, ny) - elevationAt(nx - e, ny)) / (2 * e);
    var gy = (elevationAt(nx, ny + e) - elevationAt(nx, ny - e)) / (2 * e);
    var slope = clamp01(Math.sqrt(gx * gx + gy * gy) / 26000);

    var low = 1 - clamp01((elevation - ELEV_MIN) / (ELEV_MAX - ELEV_MIN));

    // Dust settles in low, flat ground; plus broad patches.
    var dustRisk = clamp01(
      0.45 * low + 0.25 * (1 - slope) * low + 0.55 * fbm(nx * 4 + 9, ny * 4 + 3, 53) - 0.12
    );

    // Colder to the "north" (top), slightly warmer low down, patchy.
    var temperature =
      -78 + 34 * ny + 14 * low + (fbm(nx * 5 + 2, ny * 5 + 7, 71) - 0.5) * 30;

    // Mineral signal strongest on the delta lobe and along the rim.
    var ddx = nx - DELTA.cx;
    var ddy = ny - DELTA.cy;
    var dr = Math.sqrt(ddx * ddx + ddy * ddy) / DELTA.radius;
    var onDelta = Math.exp(-dr * dr * 1.4);
    var cdx = nx - CRATER.cx;
    var cdy = ny - CRATER.cy;
    var cr = Math.sqrt(cdx * cdx + cdy * cdy) / CRATER.radius;
    var onRim = Math.exp(-Math.pow((cr - 1) / 0.1, 2));
    var mineralIndex = clamp01(
      0.6 * onDelta + 0.3 * onRim + 0.45 * fbm(nx * 9 + 4, ny * 9 + 1, 97) - 0.1
    );

    return {
      elevation: elevation,
      slope: slope,
      dustRisk: dustRisk,
      temperature: temperature,
      mineralIndex: mineralIndex
    };
  }

  function getActiveLayers() {
    return ["Elevation", "Thermal", "Mineral", "Dust Risk"];
  }

  function getNamedSites() {
    return [
      { name: "Site A (mock)", nx: 0.46, ny: 0.56, type: "landing" },
      { name: "Site B (mock)", nx: 0.62, ny: 0.44, type: "landing" },
      { name: "Mineral Outcrop (mock)", nx: 0.31, ny: 0.41, type: "science" },
      { name: "Rim Traverse (mock)", nx: 0.76, ny: 0.27, type: "science" },
      { name: "Dust Basin (mock)", nx: 0.55, ny: 0.68, type: "hazard" },
      { name: "Steep Scarp (mock)", nx: 0.21, ny: 0.63, type: "hazard" }
    ];
  }

  function getElevationGrid(width, height) {
    var grid = new Float32Array(width * height);
    for (var y = 0; y < height; y++) {
      var ny = height > 1 ? y / (height - 1) : 0;
      for (var x = 0; x < width; x++) {
        var nx = width > 1 ? x / (width - 1) : 0;
        grid[y * width + x] = elevationAt(nx, ny);
      }
    }
    return grid;
  }

  window.MarsData = {
    sampleTerrainAt: sampleTerrainAt,
    getActiveLayers: getActiveLayers,
    getNamedSites: getNamedSites,
    getElevationGrid: getElevationGrid
  };
})();

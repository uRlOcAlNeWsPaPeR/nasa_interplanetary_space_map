/*
 * data-layers.js -- the data-access layer. Builds window.MarsData from the
 * real Jezero dataset (via terrain.js) and the live NASA raw-image service.
 *
 * The UI talks only to window.MarsData. The original four functions keep
 * their names and return shapes:
 *
 *   sampleTerrainAt(nx, ny) -> { elevation, slope, dustRisk, nightIR, geology }
 *   getActiveLayers()       -> string[]
 *   getNamedSites()         -> [{ name, nx, ny, type, lat, lon, sol, note }]
 *   getElevationGrid(w, h)  -> Float32Array (row-major, north row first)
 *
 * What each sample field is (all from real data; see getFieldInfo()):
 *   elevation  m above the Mars geoid       CTX DTM, USGS (observed)
 *   slope      rise/run, 0-1 (1 = 45 deg)   computed from the 20 m CTX DTM
 *   dustRisk   share of the surrounding ground mapped as eolian bedforms
 *              (sand ripples and dunes), 0-1, USGS SIM 3464 (observed
 *              mapping). The key keeps its old name so rover.js and ui.js
 *              did not have to change their hazard plumbing.
 *   nightIR    THEMIS night-time IR brightness, 0-1 relative within this map
 *              (NaN where THEMIS has no data). Not a temperature.
 *   geology    USGS geologic unit index (0 = unmapped); see getUnit()
 *
 * Extras: coordinates (toLatLon, fromLatLon, distanceKm), the CTX image,
 * Perseverance's real traverse and waypoints, mapped geologic features,
 * sources and checks, and fetchRoverImages(sol) for NASA raw images.
 */
(function () {
  "use strict";

  var T = window.MarsTerrain;
  var ds = window.MARS_DATASET;
  var ok = !!(T && T.ok);

  var RAW_API = "https://mars.nasa.gov/rss/api/";
  var RAW_CAMERAS = ["NAVCAM_LEFT", "MCZ_LEFT", "MCZ_RIGHT", "FRONT_HAZCAM_LEFT_A", "REAR_HAZCAM_LEFT"];
  var RAW_PER_SOL = 8;
  var RAW_TIMEOUT_MS = 12000;

  // ---- layers and fields ----------------------------------------------------

  var LAYERS = [
    { name: "CTX image", field: "image", kind: "observed", source: "ctx-ortho",
      description: "Visible-light image from the CTX camera on Mars Reconnaissance Orbiter (grayscale)." },
    { name: "Elevation", field: "elevation", kind: "observed", source: "ctx-dtm",
      description: "Height above the Mars geoid from the 20 m CTX elevation model." },
    { name: "Geologic units", field: "geology", kind: "observed", source: "sim3464", categorical: true,
      description: "Rock and surface units mapped by the USGS (SIM 3464, 1:75,000)." },
    { name: "Night-time IR", field: "nightIR", kind: "observed", source: "themis-night",
      description: "THEMIS night-time infrared brightness. Brighter usually means rockier ground that stays warm at night; it is relative, not a temperature." },
    { name: "Slope", field: "slope", kind: "computed", source: "ctx-dtm",
      description: "Steepness computed from the 20 m elevation model (steepest 10% around each point)." },
    { name: "Mapped sand", field: "dustRisk", kind: "observed", source: "sim3464",
      description: "Share of the ground the USGS mapped as sand ripples and dunes (Eolian bedform unit)." }
  ];

  var FIELD_INFO = {
    elevation: { label: "Elevation", kind: "observed", source: "ctx-dtm",
      method: "CTX stereo elevation model, tied to MOLA; metres above the Mars geoid." },
    slope: { label: "Slope", kind: "computed", source: "ctx-dtm",
      method: ds && ds.fields.slope ? ds.fields.slope.method : "" },
    dustRisk: { label: "Mapped sand", kind: "observed", source: "sim3464",
      method: ds && ds.fields.sand ? ds.fields.sand.method : "" },
    nightIR: { label: "Night-time IR", kind: "observed", source: "themis-night",
      method: ds && ds.fields.nightIR ? ds.fields.nightIR.method : "" },
    geology: { label: "Geologic unit", kind: "observed", source: "sim3464",
      method: "USGS SIM 3464 unit polygons, rasterized to the map grid." }
  };

  // Where the walk planner's limits come from (walk-core.js).
  var WALK_SOURCES = [
    { id: "nasa-xeva-lunar-conops",
      title: "NASA Exploration EVA System: lunar surface concept of operations (2020)",
      url: "https://www.nasa.gov/wp-content/uploads/2020/01/topic_1-_eva_lunar_surface_concept_of_operations.pdf",
      what: "Walk planner limits: EVAs of up to 8 hours (6 ± 2), walking on slopes of up to 20°, and about 5 hours to walk back 10 km (2 km/h)",
      credit: "NASA" },
    { id: "apollo-slopes",
      title: "Astronaut experiences on the slopes along Apollo EVAs (EPSC 2024)",
      url: "https://ui.adsabs.harvard.edu/abs/2024EPSC...17..196I/abstract",
      what: "Why the walk steers around slopes over 15°: Apollo crews walked on slopes under 15°",
      credit: "Europlanet Science Congress 2024 abstract" },
    { id: "nasa-dra5",
      title: "Human Exploration of Mars Design Reference Architecture 5.0 (NASA SP-2009-566)",
      url: "https://www.nasa.gov/wp-content/uploads/2015/09/373665main_nasa-sp-2009-566.pdf",
      what: "Mars context: plans assume an EVA walk-back distance of about 15 km",
      credit: "NASA" },
    { id: "tobler-1993",
      title: "Three presentations on geographical analysis and modeling (Tobler's hiking function)",
      url: "https://escholarship.org/uc/item/05r820mz",
      what: "How slopes slow the walk: an Earth hiking model, scaled to NASA's 2 km/h on flat ground",
      credit: "W. Tobler, NCGIA Technical Report 93-1, 1993" }
  ];

  function sourceById(id) {
    var list = (ds && ds.sources) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // ---- derived grids --------------------------------------------------------

  // THEMIS night IR: stored 1-255 (0 = no data) -> 0-1, NaN where missing.
  var nightGrid = null;
  function nightValues() {
    if (nightGrid) return nightGrid;
    var raw = T.grid("nightIR");
    nightGrid = new Float32Array(raw.length);
    for (var i = 0; i < raw.length; i++) nightGrid[i] = raw[i] ? (raw[i] - 1) / 254 : NaN;
    return nightGrid;
  }

  // ---- the contract -----------------------------------------------------------

  function sampleTerrainAt(nx, ny) {
    if (!ok) return { elevation: NaN, slope: 0, dustRisk: 0, nightIR: NaN, geology: 0 };
    return {
      elevation: T.sampleField("elevation", nx, ny),
      slope: T.sampleField("slope", nx, ny),
      dustRisk: T.sampleField("sand", nx, ny),
      nightIR: T.interpolate(nightValues(), nx, ny),
      geology: T.sampleNearest("geology", nx, ny)
    };
  }

  function getActiveLayers() {
    return ok ? LAYERS.map(function (l) { return l.name; }) : [];
  }

  var sitesCache = null;
  function getNamedSites() {
    if (!ok) return [];
    if (!sitesCache) {
      sitesCache = ds.sites.map(function (s) {
        var p = T.fromLatLon(s.lat, s.lon);
        return { name: s.name, nx: p.nx, ny: p.ny, type: s.type, lat: s.lat, lon: s.lon, sol: s.sol,
                 note: s.note, source: "m20-waypoints" };
      }).filter(function (s) { return T.inside(s); });
    }
    return sitesCache;
  }

  function getElevationGrid(w, h) {
    return ok ? T.elevationGrid(w, h) : new Float32Array(w * h);
  }

  // ---- coordinates --------------------------------------------------------------

  function formatLatLon(lat, lon) {
    return Math.abs(lat).toFixed(4) + "°" + (lat >= 0 ? "N" : "S") + ", " +
      Math.abs(lon).toFixed(4) + "°" + (lon >= 0 ? "E" : "W");
  }

  // ---- CTX image as a field ----------------------------------------------------

  var imagePromises = {};
  // Gray level (0-255) of the CTX image resampled to w x h. Needs the page
  // served over http(s): browsers block reading pixels from file:// images.
  function loadImageField(w, h) {
    var key = w + "x" + h;
    if (imagePromises[key]) return imagePromises[key];
    imagePromises[key] = new Promise(function (resolve, reject) {
      if (!ok || !ds.image) { reject(new Error("No image in this dataset.")); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement("canvas");
          c.width = w; c.height = h;
          var g = c.getContext("2d");
          g.drawImage(img, 0, 0, w, h);
          var px = g.getImageData(0, 0, w, h).data;
          var out = new Float32Array(w * h);
          for (var i = 0; i < out.length; i++) out[i] = px[i * 4];
          resolve(out);
        } catch (e) {
          reject(new Error("The browser blocked reading the image (open the page through a web server, not file://)."));
        }
      };
      img.onerror = function () { reject(new Error("The CTX image (" + ds.image.url + ") did not load.")); };
      img.src = ds.image.url;
    });
    // Let a later call try again after a failure.
    imagePromises[key].catch(function () { delete imagePromises[key]; });
    return imagePromises[key];
  }

  // ---- Perseverance ---------------------------------------------------------------

  var traverseCache = null;
  function getTraverse() {
    if (!ok) return [];
    if (!traverseCache) {
      traverseCache = ds.traverse.map(function (p) { return T.fromLatLon(p[1], p[0]); });
    }
    return traverseCache;
  }

  var waypointCache = null;
  function getWaypoints() {
    if (!ok) return [];
    if (!waypointCache) {
      waypointCache = ds.waypoints.map(function (w) {
        var p = T.fromLatLon(w.lat, w.lon);
        return { sol: w.sol, lat: w.lat, lon: w.lon, elev: w.elev, km: w.km, nx: p.nx, ny: p.ny };
      });
    }
    return waypointCache;
  }

  // The Perseverance stop closest to a map position, with its distance (km).
  function nearestWaypoint(nx, ny) {
    var best = null, bestD = Infinity;
    getWaypoints().forEach(function (w) {
      var d = T.distanceKm(w, { nx: nx, ny: ny });
      if (d < bestD) { bestD = d; best = w; }
    });
    return best ? { sol: best.sol, lat: best.lat, lon: best.lon, km: best.km, nx: best.nx, ny: best.ny, distanceKm: bestD } : null;
  }

  var featureCache = null;
  function getGeologyFeatures() {
    if (!ok) return { megabreccia: [], rimCrests: [], deltaFronts: [], labels: [] };
    if (!featureCache) {
      var f = ds.geologyFeatures || {};
      var pt = function (p) { return T.fromLatLon(p[1], p[0]); };
      featureCache = {
        megabreccia: (f.megabreccia || []).map(pt),
        rimCrests: (f.rimCrests || []).map(function (line) { return line.map(pt); }),
        deltaFronts: (f.deltaFronts || []).map(function (line) { return line.map(pt); }),
        labels: (f.labels || []).map(function (l) {
          var p = T.fromLatLon(l.lat, l.lon);
          return { name: l.name, nx: p.nx, ny: p.ny };
        })
      };
    }
    return featureCache;
  }

  // ---- NASA raw images (live) ------------------------------------------------------

  var rawCache = {};
  // Full-frame Perseverance images taken on a sol. Resolves to
  // { sol, images: [{ id, camera, thumb, full, link, date, credit }], total }.
  // Rejects with a readable message on network or service errors.
  function fetchRoverImages(sol) {
    if (rawCache[sol]) return rawCache[sol];
    var params = new URLSearchParams({
      feed: "raw_images", category: "mars2020", feedtype: "json", ver: "1.2",
      num: String(RAW_PER_SOL), page: "0", order: "sol desc",
      search: "|" + RAW_CAMERAS.join("|"),
      condition_2: sol + ":sol:gte", condition_3: sol + ":sol:lte",
      extended: "sample_type::full,"
    });
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, RAW_TIMEOUT_MS) : null;
    rawCache[sol] = fetch(RAW_API + "?" + params.toString(), controller ? { signal: controller.signal } : {})
      .then(function (res) {
        if (!res.ok) throw new Error("NASA's raw-image service answered " + res.status + ".");
        return res.json();
      })
      .then(function (json) {
        var images = (json.images || []).map(function (im) {
          var files = im.image_files || {};
          return {
            id: im.imageid,
            camera: (im.camera && im.camera.instrument) || "",
            thumb: files.small || files.medium,
            full: files.large || files.full_res || files.medium,
            link: im.link || ("https://mars.nasa.gov/mars2020/multimedia/raw-images/" + im.imageid),
            date: im.date_taken_utc || "",
            credit: im.credit || "NASA/JPL-Caltech"
          };
        }).filter(function (im) { return im.thumb; });
        return { sol: sol, images: images, total: Number(json.total_results) || images.length };
      })
      .catch(function (err) {
        delete rawCache[sol];
        throw new Error(err && err.name === "AbortError"
          ? "NASA's raw-image service did not answer in time."
          : (err && err.message) || "Could not reach NASA's raw-image service.");
      })
      .finally(function () { if (timer) clearTimeout(timer); });
    return rawCache[sol];
  }

  // ---- export -----------------------------------------------------------------------

  window.MarsData = {
    // the contract
    sampleTerrainAt: sampleTerrainAt,
    getActiveLayers: getActiveLayers,
    getNamedSites: getNamedSites,
    getElevationGrid: getElevationGrid,

    // status
    ok: ok,
    error: ok ? null : (T && T.error) || "The map data module did not load.",
    datasetName: ok ? ds.name : "",

    // layers, fields, units
    getLayerInfo: function (name) {
      for (var i = 0; i < LAYERS.length; i++) if (LAYERS[i].name === name) return LAYERS[i];
      return null;
    },
    getFieldInfo: function (key) {
      var info = FIELD_INFO[key];
      if (!info) return null;
      var src = sourceById(info.source);
      return { key: key, label: info.label, kind: info.kind, method: info.method,
               sourceTitle: src ? src.title : "", sourceUrl: src ? src.url : "" };
    },
    getUnits: function () { return ok ? ds.units : []; },
    getUnit: function (index) { return ok && index > 0 ? ds.units[index - 1] || null : null; },

    // coordinates
    toLatLon: function (nx, ny) { return ok ? T.toLatLon(nx, ny) : { lat: NaN, lon: NaN }; },
    fromLatLon: function (lat, lon) { return ok ? T.fromLatLon(lat, lon) : { nx: NaN, ny: NaN }; },
    distanceKm: function (a, b) { return ok ? T.distanceKm(a, b) : NaN; },
    formatLatLon: formatLatLon,
    getBounds: function () { return ok ? T.bounds : null; },
    getScale: function () { return ok ? { widthKm: T.widthKm, heightKm: T.heightKm } : null; },

    // imagery
    getBaseImage: function () {
      if (!ok || !ds.image) return null;
      var src = sourceById(ds.image.source);
      return { url: ds.image.url, credit: src ? src.credit : "", title: src ? src.title : "" };
    },
    loadImageField: loadImageField,

    // Perseverance (real NASA positions)
    getTraverse: getTraverse,
    getWaypoints: getWaypoints,
    nearestWaypoint: nearestWaypoint,
    fetchRoverImages: fetchRoverImages,

    // mapped geology features (USGS SIM 3464)
    getGeologyFeatures: getGeologyFeatures,

    // provenance
    getSources: function () { return ok ? ds.sources.concat(WALK_SOURCES) : []; },
    getChecks: function () { return ok ? ds.checks : null; }
  };
})();

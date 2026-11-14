#!/usr/bin/env python3
"""
build_jezero_data.py -- build the app's real Mars data files for Jezero crater.

Every value the app shows comes from the public NASA/USGS products below.
This script downloads them, cuts them to one map window, resamples them onto
one shared grid, and writes:

  data/jezero/jezero-data.js   window.MARS_DATASET (grids + metadata + sources)
  data/jezero/ctx-ortho.jpg    CTX visible image, same window, north up

Sources (all downloaded by this script):
  * USGS Astrogeology, Mars 2020 Terrain Relative Navigation CTX DTM (20 m)
    and CTX orthomosaic (6 m), Fergason et al. 2020
  * USGS SIM 3464, Geologic map of Jezero crater and the Nili Planum region
    (Sun & Stack 2020), GIS database
  * NASA Mars Trek, THEMIS night-time IR controlled mosaic (100 m)
  * NASA/JPL Mars 2020 MMGIS waypoints and traverse (Perseverance positions)

Usage:
  pip install numpy rasterio pyogrio pillow
  python3 tools/build_jezero_data.py --cache /some/download/dir

The downloads are ~400 MB (the geologic map database is most of it) and are
kept in --cache so re-runs are fast. Nothing in this file invents values:
grids are resampled from the sources, slope is computed from the DTM, and the
sand field is the area share of the mapped eolian bedform unit.
"""
import argparse
import base64
import io
import json
import math
import os
import re
import sys
import urllib.request
import zipfile

import numpy as np

R_MARS = 3396190.0  # Mars 2000 sphere radius used by all the products, metres

# ---- map window -------------------------------------------------------------
# The full width of the USGS CTX DTM; the north/south span is set so the
# window is 4:3 on the ground (the app's map is 720 x 540).
LON_W, LON_E = 77.1610, 77.6985
LAT_N = 18.6650
_LAT_C = 18.47
LAT_S = LAT_N - 0.75 * (LON_E - LON_W) * math.cos(math.radians(_LAT_C))
GRID_W, GRID_H = 400, 300          # nodes; node (0,0) is the NW corner
IMAGE_W, IMAGE_H = 1440, 1080      # CTX image size written for the app

URLS = {
    "dtm": "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif",
    "ortho": "https://planetarymaps.usgs.gov/mosaic/mars2020_trn/CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif",
    "geomap": "https://pubs.usgs.gov/sim/3464/sim3464_database.zip",
    "waypoints": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json",
    "traverse": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json",
    "themis_caps": "https://trek.nasa.gov/tiles/Mars/EQ/THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018/1.0.0/WMTSCapabilities.xml",
}

SOURCES = [
    {"id": "ctx-dtm", "kind": "observed", "what": "Elevation (20 m grid, CTX stereo, tied to MOLA)",
     "title": "Mars 2020 TRN CTX DTM, Jezero crater", "credit": "USGS Astrogeology / NASA / JPL-Caltech / MSSS (Fergason et al. 2020)",
     "url": URLS["dtm"]},
    {"id": "ctx-ortho", "kind": "observed", "what": "Visible-light image (6 m, grayscale)",
     "title": "Mars 2020 TRN CTX orthomosaic, Jezero crater", "credit": "USGS Astrogeology / NASA / JPL-Caltech / MSSS",
     "url": URLS["ortho"]},
    {"id": "themis-night", "kind": "observed", "what": "Night-time thermal infrared brightness (100 m, relative)",
     "title": "THEMIS night IR controlled mosaic", "credit": "NASA / JPL-Caltech / Arizona State University, via NASA Mars Trek",
     "url": "https://trek.nasa.gov/mars/"},
    {"id": "sim3464", "kind": "observed", "what": "Geologic units, mapped eolian sand, megabreccia, rim crests",
     "title": "USGS SIM 3464: Geologic map of Jezero crater and the Nili Planum region (1:75,000)",
     "credit": "Sun, V.Z., and Stack, K.M., 2020, U.S. Geological Survey", "url": "https://doi.org/10.3133/sim3464"},
    {"id": "m20-waypoints", "kind": "observed", "what": "Perseverance positions and traverse (sols 13 onward)",
     "title": "Mars 2020 rover waypoints and traverse (MMGIS)", "credit": "NASA / JPL-Caltech",
     "url": "https://mars.nasa.gov/mars2020/mission/where-is-the-rover/"},
    {"id": "m20-raw", "kind": "observed", "what": "Rover camera images near a point (loaded live when you inspect)",
     "title": "Mars 2020 raw images", "credit": "NASA / JPL-Caltech", "url": "https://mars.nasa.gov/mars2020/multimedia/raw-images/"},
]

# Geologic unit display colours (ours; the USGS layer files are ArcMap-only).
UNIT_COLORS = {
    "NHjf1": [110, 150, 210], "NHjf2": [70, 110, 190], "Njf": [205, 150, 120], "Nle": [170, 120, 160],
    "Nue": [200, 165, 200], "Nnp1": [150, 120, 95], "Nnp2": [125, 100, 80], "Hnpf": [120, 170, 200],
    "Aeb": [235, 205, 120], "su": [190, 185, 160], "cr": [150, 70, 60], "ce": [215, 120, 80],
    "Nrb": [230, 230, 230], "ci": [120, 90, 70],
}


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    log("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "jezero-data-build"})
    with urllib.request.urlopen(req, timeout=600) as r, open(path + ".part", "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(path + ".part", path)
    return path


def node_lonlat():
    lons = LON_W + (LON_E - LON_W) * np.arange(GRID_W) / (GRID_W - 1)
    lats = LAT_N - (LAT_N - LAT_S) * np.arange(GRID_H) / (GRID_H - 1)
    return np.meshgrid(lons, lats)  # (H, W) arrays


def eqc_pixel(src, lon, lat):
    """Fractional (col, row) in an Equirectangular (latTs 0) Mars raster."""
    x = R_MARS * np.radians(lon)
    y = R_MARS * np.radians(lat)
    b = src.bounds
    rx, ry = src.res
    return (x - b.left) / rx - 0.5, (b.top - y) / ry - 0.5


def bilinear(arr, col, row):
    h, w = arr.shape
    c0 = np.clip(np.floor(col).astype(int), 0, w - 2)
    r0 = np.clip(np.floor(row).astype(int), 0, h - 2)
    fc = np.clip(col - c0, 0, 1)
    fr = np.clip(row - r0, 0, 1)
    a = arr[r0, c0]; b = arr[r0, c0 + 1]; c = arr[r0 + 1, c0]; d = arr[r0 + 1, c0 + 1]
    return a * (1 - fc) * (1 - fr) + b * fc * (1 - fr) + c * (1 - fc) * fr + d * fc * fr


def b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


# ---- elevation and slope ----------------------------------------------------

def build_terrain(dtm_path):
    import rasterio
    with rasterio.open(dtm_path) as src:
        z = src.read(1).astype(np.float64)
        nod = src.nodata
        valid = z > -1e30 if nod is None else (z != nod) & (z > -1e30)
        if not valid.all():
            raise SystemExit("DTM has nodata inside the file; pick a window inside valid data")
        lon, lat = node_lonlat()
        col, row = eqc_pixel(src, lon, lat)
        elev = bilinear(z, col, row)

        # Slope (grade = rise/run) on the native 20 m grid. Eqc latTs0 pixels
        # are 20 m north-south but 20*cos(lat) m east-west on the ground.
        rows = np.arange(z.shape[0])
        lat_rows = np.degrees((src.bounds.top - (rows + 0.5) * src.res[1]) / R_MARS)
        dx = src.res[0] * np.cos(np.radians(lat_rows))[:, None]
        dy = src.res[1]
        gz_y, gz_x = np.gradient(z)
        grade = np.hypot(gz_x / dx, gz_y / dy)

        # Each 75 m node takes the 90th percentile of the 20 m slopes around it,
        # so short steep scarps are not averaged away.
        cc = np.rint(col).astype(int)
        rr = np.rint(row).astype(int)
        offs = range(-2, 3)
        stack = np.stack([grade[np.clip(rr + j, 0, z.shape[0] - 1), np.clip(cc + i, 0, z.shape[1] - 1)]
                          for j in offs for i in offs], axis=0)
        slope = np.percentile(stack, 90, axis=0)
    return elev, slope


# ---- CTX image --------------------------------------------------------------

def build_image(ortho_path, out_path):
    import rasterio
    from PIL import Image
    with rasterio.open(ortho_path) as src:
        img = src.read(1)
        lons = LON_W + (LON_E - LON_W) * (np.arange(IMAGE_W) + 0.5) / IMAGE_W
        lats = LAT_N - (LAT_N - LAT_S) * (np.arange(IMAGE_H) + 0.5) / IMAGE_H
        lon, lat = np.meshgrid(lons, lats)
        col, row = eqc_pixel(src, lon, lat)
        # Box-average the 6 m pixels under each ~21 m output pixel.
        acc = np.zeros(lon.shape); n = 0
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                acc += bilinear(img.astype(np.float64), col + di, row + dj); n += 1
        out = acc / n
    lo, hi = np.percentile(out[out > 0], [1, 99.5])
    out = np.clip((out - lo) / (hi - lo), 0, 1) * 255
    Image.fromarray(out.astype(np.uint8), "L").save(out_path, quality=84, optimize=True, progressive=True)
    return {"lo": float(lo), "hi": float(hi)}


# ---- THEMIS night IR --------------------------------------------------------

def build_themis(cache):
    from PIL import Image
    caps = open(fetch(URLS["themis_caps"], os.path.join(cache, "themis_caps.xml")), encoding="utf-8").read()
    template = re.search(r'template="([^"]+)"', caps).group(1).replace("1.0.0//", "1.0.0/")
    template = template.replace("{Style}", "default").replace("{TileMatrixSet}", "default028mm")
    z = 9                      # 2^(z+1) x 2^z tiles of 256 px: ~81 m per pixel
    n = 2 ** z
    ppd = 256 * 2 * n / 360.0  # pixels per degree
    c0 = int((LON_W + 180) * ppd // 256); c1 = int((LON_E + 180) * ppd // 256)
    r0 = int((90 - LAT_N) * ppd // 256); r1 = int((90 - LAT_S) * ppd // 256)
    mosaic = np.zeros(((r1 - r0 + 1) * 256, (c1 - c0 + 1) * 256), np.float64)
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            url = template.replace("{TileMatrix}", str(z)).replace("{TileRow}", str(r)).replace("{TileCol}", str(c))
            p = fetch(url, os.path.join(cache, f"themis_{z}_{r}_{c}.img"))
            tile = np.asarray(Image.open(p).convert("L"), np.float64)
            mosaic[(r - r0) * 256:(r - r0 + 1) * 256, (c - c0) * 256:(c - c0 + 1) * 256] = tile
    lon, lat = node_lonlat()
    col = (lon + 180) * ppd - c0 * 256 - 0.5
    row = (90 - lat) * ppd - r0 * 256 - 0.5
    raw = bilinear(mosaic, col, row)
    valid = raw > 2  # black = no THEMIS coverage
    lo, hi = np.percentile(raw[valid], [2, 98])
    rel = np.clip((raw - lo) / (hi - lo), 0, 1)
    return rel, valid, {"zoom": z, "tiles": (r1 - r0 + 1) * (c1 - c0 + 1), "stretch": [float(lo), float(hi)],
                        "coverage": float(valid.mean())}


# ---- geologic map -----------------------------------------------------------

def build_geology(zip_path, cache):
    import pyogrio
    from rasterio import features, transform as rtransform
    from rasterio.crs import CRS
    from rasterio.warp import transform_geom
    gdb_dir = os.path.join(cache, "sim3464")
    gdb = None
    if os.path.isdir(gdb_dir):
        for root, dirs, _ in os.walk(gdb_dir):
            for d in dirs:
                if d.endswith(".gdb"):
                    gdb = os.path.join(root, d)
    if gdb is None:
        with zipfile.ZipFile(zip_path) as zf:
            members = [m for m in zf.namelist() if "/Geodatabase/" in m and not m.startswith("__MACOSX")]
            zf.extractall(gdb_dir, members)
        return build_geology(zip_path, cache)

    def read(layer):
        meta, _, geoms, fields = pyogrio.raw.read(gdb, layer=layer)
        return meta, geoms, {name: fields[i] for i, name in enumerate(meta["fields"])}

    meta, geoms, f = read("GeoUnits_v1")
    src_crs = CRS.from_wkt(meta["crs"])
    m = re.search(r'GEOGCS\[.*?\]\]\]', meta["crs"]) or re.search(r'GEOGCS\[.*\]\]', meta["crs"])
    dst_crs = CRS.from_wkt(m.group(0) if m else 'GEOGCS["Mars 2000",DATUM["D_Mars_2000",SPHEROID["Mars_2000_IAU_IAG",3396190.0,0.0]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]')

    from shapely import wkb as _wkb  # noqa: F401  (only to fail early with a clear message if missing)

    def to_geojson(g):
        from shapely import wkb
        return wkb.loads(bytes(g)).__geo_interface__

    symbols = sorted(set(f["symbol"]), key=lambda s: s)
    unit_info = {}
    for i, s in enumerate(f["symbol"]):
        unit_info.setdefault(s, f["name"][i])
    units = [{"symbol": s, "name": unit_info[s], "color": UNIT_COLORS.get(s, [160, 160, 160])} for s in symbols]
    index = {u["symbol"]: k + 1 for k, u in enumerate(units)}  # 0 = unmapped

    fine_w, fine_h = GRID_W * 4, GRID_H * 4
    tr = rtransform.from_bounds(LON_W, LAT_S, LON_E, LAT_N, fine_w, fine_h)
    shapes = []
    for g, s in zip(geoms, f["symbol"]):
        if g is None:
            continue
        shapes.append((transform_geom(src_crs, dst_crs, to_geojson(g)), index[s]))
    fine = features.rasterize(shapes, out_shape=(fine_h, fine_w), transform=tr, fill=0, dtype="uint8")

    # Per node: the unit at the node, and the share of the node's cell that is
    # mapped as eolian bedforms (sand).
    lon, lat = node_lonlat()
    fc = np.clip(((lon - LON_W) / (LON_E - LON_W) * fine_w).astype(int), 0, fine_w - 1)
    fr = np.clip(((LAT_N - lat) / (LAT_N - LAT_S) * fine_h).astype(int), 0, fine_h - 1)
    unit_grid = fine[fr, fc]
    sand_fine = (fine == index.get("Aeb", -1)).astype(np.float64)
    acc = np.zeros(lon.shape); cnt = 0
    for dj in range(-3, 4):
        for di in range(-3, 4):
            acc += sand_fine[np.clip(fr + dj, 0, fine_h - 1), np.clip(fc + di, 0, fine_w - 1)]; cnt += 1
    sand = acc / cnt

    def project_points(layer, type_filter=None):
        meta2, geoms2, f2 = read(layer)
        out = []
        for g, t in zip(geoms2, f2.get("TYPE", [None] * len(geoms2))):
            if g is None or (type_filter and t != type_filter):
                continue
            gj = transform_geom(CRS.from_wkt(meta2["crs"]), dst_crs, to_geojson(g))
            if gj["type"] == "Point":
                lo_, la_ = gj["coordinates"][:2]
                if LON_W <= lo_ <= LON_E and LAT_S <= la_ <= LAT_N:
                    out.append([round(lo_, 5), round(la_, 5)])
        return out

    def project_lines(layer, type_filter):
        meta2, geoms2, f2 = read(layer)
        out = []
        for g, t in zip(geoms2, f2["TYPE"]):
            if g is None or t != type_filter:
                continue
            gj = transform_geom(CRS.from_wkt(meta2["crs"]), dst_crs, to_geojson(g))
            parts = gj["coordinates"] if gj["type"] == "MultiLineString" else [gj["coordinates"]]
            for part in parts:
                pts = [[round(p[0], 5), round(p[1], 5)] for p in part]
                if any(LON_W <= p[0] <= LON_E and LAT_S <= p[1] <= LAT_N for p in pts):
                    out.append(pts)
        return out

    # Map labels: the centroid of each annotation's text box (where USGS put the label).
    meta3, geoms3, f3 = read("Nomenclature")
    labels = []
    from shapely import wkb
    for g, text in zip(geoms3, f3["TextString"]):
        if g is None:
            continue
        gj = transform_geom(CRS.from_wkt(meta3["crs"]), dst_crs, wkb.loads(bytes(g)).centroid.__geo_interface__)
        lo_, la_ = gj["coordinates"][:2]
        name = re.sub(r"\s{2,}", " ", re.sub(r"(?<=\S) (?=\S)", "", text)).strip() if re.match(r"^(\S\s)+\S$", text.strip()) else text.strip()
        if LON_W <= lo_ <= LON_E and LAT_S <= la_ <= LAT_N:
            labels.append({"name": name.title() if name.isupper() else name, "lon": round(lo_, 5), "lat": round(la_, 5)})

    extra = {
        "megabreccia": project_points("megabreccia_fig2"),
        "rimCrests": project_lines("LinearFeatures", "crest of crater rim"),
        "deltaFronts": project_lines("LinearFeatures", "delta lobe front"),
        "labels": labels,
    }
    return unit_grid, sand, units, extra


# ---- Perseverance -----------------------------------------------------------

def build_rover(wp_path, tr_path):
    wp = json.load(open(wp_path))["features"]
    pts = []
    for feat in wp:
        p = feat["properties"]
        pts.append({"sol": int(p["sol"]), "site": int(p["site"]), "drive": int(p["drive"]),
                    "lon": round(float(p["lon"]), 6), "lat": round(float(p["lat"]), 6),
                    "elev": round(float(p["elev_geoid"]), 2), "km": round(float(p["dist_total_m"]) / 1000.0, 3)})
    tr = json.load(open(tr_path))["features"]
    tr.sort(key=lambda f: (f["properties"].get("sol", 0), f["properties"].get("SCLK_START", 0)))
    line = []
    for feat in tr:
        coords = feat["geometry"]["coordinates"]
        if feat["geometry"]["type"] == "MultiLineString":
            coords = [c for part in coords for c in part]
        for c in coords:
            pt = [round(c[0], 6), round(c[1], 6)]
            if not line or pt != line[-1]:
                line.append(pt)
    return pts, simplify(line, 3.0)


def simplify(line, tol_m):
    """Douglas-Peucker in metres (local flat approximation)."""
    if len(line) < 3:
        return line
    k = R_MARS * math.pi / 180
    cosl = math.cos(math.radians(_LAT_C))
    xy = np.array([[p[0] * k * cosl, p[1] * k] for p in line])
    keep = np.zeros(len(line), bool); keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = xy[b] - xy[a]
        L = np.hypot(*seg) or 1e-9
        d = np.abs(np.cross(seg, xy[a + 1:b] - xy[a])) / L
        i = int(np.argmax(d))
        if d[i] > tol_m:
            m = a + 1 + i
            keep[m] = True
            stack += [(a, m), (m, b)]
    return [line[i] for i in range(len(line)) if keep[i]]


def pick_sites(points):
    """Landing site plus Perseverance stops spread evenly by distance driven."""
    sites = [{"name": "Octavia E. Butler Landing", "type": "landing", "lon": points[0]["lon"], "lat": points[0]["lat"],
              "note": "Perseverance's first recorded position (sol %d)" % points[0]["sol"], "sol": points[0]["sol"]}]
    total = points[-1]["km"]
    k = R_MARS * math.pi / 180 / 1000
    cosl = math.cos(math.radians(_LAT_C))

    def km_apart(a, b):
        return math.hypot((a["lon"] - b["lon"]) * k * cosl, (a["lat"] - b["lat"]) * k)

    for frac in (0.12, 0.3, 0.5, 0.7, 0.88, 1.0):
        target = total * frac
        best = min(points, key=lambda p: abs(p["km"] - target))
        # Keep stops at least 1.5 km from each other so their labels stay readable.
        if any(km_apart(best, s) < 1.5 for s in sites):
            continue
        sites.append({"name": "Perseverance, sol %d" % best["sol"], "type": "science", "lon": best["lon"],
                      "lat": best["lat"], "sol": best["sol"],
                      "note": "Where Perseverance stopped on sol %d, %.1f km into its drive" % (best["sol"], best["km"])})
    return sites


# ---- main -------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", required=True, help="directory for downloads")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "jezero"))
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    paths = {k: fetch(u, os.path.join(args.cache, os.path.basename(u.split("?")[0])))
             for k, u in URLS.items() if k != "themis_caps"}

    log("terrain"); elev, slope = build_terrain(paths["dtm"])
    log("image"); img_stats = build_image(paths["ortho"], os.path.join(args.out, "ctx-ortho.jpg"))
    log("themis"); night, night_valid, themis_stats = build_themis(args.cache)
    log("geology"); unit_grid, sand, units, geo_extra = build_geology(paths["geomap"], args.cache)
    log("rover"); waypoints, traverse = build_rover(paths["waypoints"], paths["traverse"])

    # Check: the DTM under each Perseverance waypoint vs the rover's own
    # localized elevation (both relative to the Mars geoid).
    import rasterio
    with rasterio.open(paths["dtm"]) as src:
        z = src.read(1).astype(np.float64)
        col, row = eqc_pixel(src, np.array([p["lon"] for p in waypoints]), np.array([p["lat"] for p in waypoints]))
        dtm_at = bilinear(z, col, row)
    diffs = dtm_at - np.array([p["elev"] for p in waypoints])
    check = {"waypoints": len(waypoints), "medianAbsDiffM": round(float(np.median(np.abs(diffs))), 2),
             "p90AbsDiffM": round(float(np.percentile(np.abs(diffs), 90)), 2), "meanDiffM": round(float(diffs.mean()), 2)}
    log("waypoint elevation check", check)

    elev_dm = np.rint(elev * 10).astype("<i2")              # decimetres
    slope_u8 = np.rint(np.clip(slope, 0, 1) * 255).astype(np.uint8)
    sand_u8 = np.rint(np.clip(sand, 0, 1) * 255).astype(np.uint8)
    night_u8 = np.where(night_valid, 1 + np.rint(night * 254), 0).astype(np.uint8)  # 0 = no data
    geo_u8 = unit_grid.astype(np.uint8)

    width_km = (LON_E - LON_W) * R_MARS * math.pi / 180 * math.cos(math.radians((LAT_N + LAT_S) / 2)) / 1000
    height_km = (LAT_N - LAT_S) * R_MARS * math.pi / 180 / 1000
    dataset = {
        "id": "jezero-ctx-v1",
        "name": "Jezero crater, western floor and delta",
        "bounds": {"west": LON_W, "east": LON_E, "south": round(LAT_S, 6), "north": LAT_N},
        "widthKm": round(width_km, 3), "heightKm": round(height_km, 3),
        "grid": {"w": GRID_W, "h": GRID_H, "note": "node (0,0) is the north-west corner; nodes are evenly spaced in longitude and latitude"},
        "fields": {
            "elevation": {"type": "int16", "scale": 0.1, "b64": b64(elev_dm), "units": "m",
                          "datum": "Mars geoid (CTX DTM tied to MOLA)", "source": "ctx-dtm"},
            "slope": {"type": "uint8", "scale": 1 / 255, "b64": b64(slope_u8), "units": "rise/run",
                      "method": "90th percentile of 20 m slopes in a 100 m window around each node", "source": "ctx-dtm"},
            "sand": {"type": "uint8", "scale": 1 / 255, "b64": b64(sand_u8), "units": "share of area",
                     "method": "share of ~525 m around each node mapped as Eolian bedform unit (Aeb)", "source": "sim3464"},
            "nightIR": {"type": "uint8", "b64": b64(night_u8), "units": "relative 0-1 (0 = no data)",
                        "method": "THEMIS night IR brightness, stretched 2nd-98th percentile within this window", "source": "themis-night"},
            "geology": {"type": "uint8", "b64": b64(geo_u8), "units": "unit index (0 = unmapped)", "source": "sim3464"},
        },
        "units": units,
        "image": {"url": "data/jezero/ctx-ortho.jpg", "width": IMAGE_W, "height": IMAGE_H, "source": "ctx-ortho",
                  "note": "grayscale, contrast-stretched for display"},
        "sites": pick_sites(waypoints),
        "waypoints": waypoints,
        "traverse": traverse,
        "geologyFeatures": geo_extra,
        "checks": {"waypointElevation": check, "themis": themis_stats, "image": img_stats},
        "sources": SOURCES,
    }
    out_js = os.path.join(args.out, "jezero-data.js")
    with open(out_js, "w") as f:
        f.write("/* Generated by tools/build_jezero_data.py from NASA/USGS data. Do not edit by hand. */\n")
        f.write("window.MARS_DATASET = ")
        json.dump(dataset, f, separators=(",", ":"))
        f.write(";\n")
    log("wrote", out_js, os.path.getsize(out_js) // 1024, "KB")
    summary = {k: v for k, v in dataset.items() if k not in ("fields", "waypoints", "traverse", "geologyFeatures")}
    summary["counts"] = {"waypoints": len(waypoints), "traversePoints": len(traverse),
                         "megabreccia": len(geo_extra["megabreccia"]), "rimCrests": len(geo_extra["rimCrests"]),
                         "deltaFronts": len(geo_extra["deltaFronts"]), "labels": len(geo_extra["labels"])}
    summary["ranges"] = {"elevation_m": [float(elev.min()), float(elev.max())],
                         "slope_p50_p99": [float(np.percentile(slope, 50)), float(np.percentile(slope, 99))],
                         "sand_share_nonzero": float((sand > 0.05).mean()),
                         "units_present": sorted({units[i - 1]["symbol"] for i in np.unique(geo_u8) if i})}
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()

// Shared watershed geometry: used by the 3D scene, the land-use classifier and the hydrology model.
export const BASE = 2.0;
export const LAKE = { cx: 0, cz: 6, rx: 8, rz: 5.5 };
// main stem rises at a spring just below the summit on the reservoir-facing slope
export const MAIN = [[-4, -29], [-3.5, -22], [-2, -14], [0, -6], [0, 2]];
export const TRIB_E = [[25, -27], [17, -19], [9, -12], [0.5, -7]];
export const TRIB_W = [[-33, -17], [-22, -18], [-12, -19], [-2.5, -17]];
export const RIVER_OUT = [[1, 10.5], [3, 22], [1, 34], [7, 45], [12, 52]];
export const STREAMS = [MAIN, TRIB_E, TRIB_W];

// flattened sites: towns, commercial zone, treatment plant, pump stations, intake
export const Z = {
  sanIsidro: { x: -26, z: 24, r: 11 },
  poblacion: { x: 32, z: 16, r: 10 },
  commercial: { x: 16, z: 28, r: 9 },
  divisoria: { x: 30, z: 38, r: 7 },
  mabini: { x: 38, z: -2, r: 6 },
  rizal: { x: -38, z: 6, r: 6 },
  wtp: { x: -6, z: 18, r: 5.5 },
  pumpA: { x: -15, z: 15, r: 3.5 },
  pumpB: { x: 9, z: 16, r: 3.5 },
  pump3: { x: 9, z: -1, r: 4 },
  intake: { x: -6, z: -11, r: 3.5, auto: true },
};
export const ZONES = Object.values(Z);
export const TOWNS = ['sanIsidro', 'poblacion', 'divisoria', 'mabini', 'rizal'];
export const FACILITIES = ['wtp', 'pumpA', 'pumpB', 'pump3', 'intake'];
// entity id -> land-use zone
export const AREA_ZONE = { residential: 'sanIsidro', poblacion: 'poblacion', commercial: 'commercial', divisoria: 'divisoria', mabini: 'mabini', rizal: 'rizal' };
export const PADDY_FIELDS = [[-11, 40], [-34, 40], [16, 42]];

export const ROADS = [
  { w: 1.0, pts: [[-47, 27], [-37, 26], [-26, 25], [-17, 25], [-8, 27], [2, 27.5], [9, 27], [16, 28], [23, 33], [30, 38], [38, 42], [47, 43]] },
  { w: 0.8, pts: [[9, 27], [14, 22], [20, 18], [26, 15], [32, 16], [38, 10], [38, -2], [42, -10]] },
  { w: 0.8, pts: [[-26, 25], [-31, 17], [-38, 6], [-44, -4]] },
  { w: 0.7, pts: [[-8, 27], [-6, 22], [-6, 18]] },
  { w: 0.6, pts: [[-6, 18], [-12, 10], [-11, 0], [-8, -6], [-6, -11]] },
];

export const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return { d: Math.hypot(px - (ax + t * dx), pz - (az + t * dz)), x: ax + t * dx, z: az + t * dz };
}
export function nearestOnPoly(x, z, pts) {
  let best = { d: 1e9 };
  for (let i = 0; i < pts.length - 1; i++) {
    const r = distSeg(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (r.d < best.d) best = r;
  }
  return best;
}
export const distPoly = (x, z, pts) => nearestOnPoly(x, z, pts).d;
export const distRoads = (x, z) => Math.min(...ROADS.map(r => distPoly(x, z, r.pts)));
export function lakeE(x, z) {
  const dx = (x - LAKE.cx) / LAKE.rx, dz = (z - LAKE.cz) / LAKE.rz;
  const a = Math.atan2(dz, dx);
  return Math.hypot(dx, dz) * (1 + 0.07 * Math.sin(a * 3 + 1) + 0.05 * Math.sin(a * 5 + 2));
}

export function rawHeight(x, z) {
  const g = (cx, cz, s, a) => a * Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / s);
  const m = g(-4, -34, 380, 15) + g(26, -24, 220, 10) + g(-34, -14, 260, 9) + g(8, -44, 200, 9) + g(42, 2, 120, 3.5) + g(-42, 34, 160, 3);
  const n = 0.5 * Math.sin(x * 0.21) * Math.cos(z * 0.19) + 0.25 * Math.sin(x * 0.43 + z * 0.37);
  const edge = 1 - sstep(38, 50, Math.max(Math.abs(x), Math.abs(z)));
  return BASE + Math.max(m + n * (1 + Math.min(m, 6) / 3) * 0.7, 0) * edge;
}
ZONES.forEach(z => { z.h = z.auto ? rawHeight(z.x, z.z) : BASE; });

export function groundHeight(x, z) {
  let h = rawHeight(x, z);
  for (const zn of ZONES) {
    const f = sstep(zn.r, zn.r * 0.6, Math.hypot(x - zn.x, z - zn.z));
    if (f > 0) h = h * (1 - f) + zn.h * f;
  }
  h -= 5.5 * sstep(1.2, 0.55, lakeE(x, z));
  const dm = Math.min(distPoly(x, z, MAIN), distPoly(x, z, RIVER_OUT));
  h -= 1.3 * Math.exp(-dm * dm / 2.2);
  const dt = Math.min(distPoly(x, z, TRIB_E), distPoly(x, z, TRIB_W));
  h -= 0.7 * Math.exp(-dt * dt / 1.2);
  return h;
}

// ---------- watershed boundary & operational catchment (see js/studyarea.js) ----------
// Two separate concepts:
//   isInsideWatershed(x, z) – the displayed watershed / study-area boundary: a loaded GIS polygon, else the
//                             Phase 1 procedural outline (labelled "Fallback: Simulated Watershed Boundary").
//   inCatchment(x, z)       – the OPERATIONAL contributing catchment used by the runoff model. It stays the
//                             simulated Phase 1 mask unless the GIS polygon is a VERIFIED contributing catchment.
// Nothing here knows the study-area name or any real location.

// Phase 1 procedural outline (fallback; not GIS)
const legacyR = a => 1 + 0.06 * Math.sin(3 * a) + 0.04 * Math.cos(5 * a + 1);
export function insideLegacyBoundary(x, z) {
  const dx = (x + 1) / 43, dz = (z + 6) / 40;
  return Math.hypot(dx, dz) < legacyR(Math.atan2(dz, dx));
}
export function legacyBoundaryRing(n = 128) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, r = legacyR(a);
    ring.push([Math.max(-47.5, Math.min(47.5, -1 + Math.cos(a) * 43 * r)), Math.max(-47.5, Math.min(47.5, -6 + Math.sin(a) * 40 * r))]);
  }
  return ring;
}
// Phase 1 calibration of the simulated operational catchment (km²)
export const SIMULATED_CONTRIBUTING_KM2 = 0.3;

let STUDY_AREA = null;               // set by studyarea.js; null => full Phase 1 fallback
export function setStudyArea(sa) { STUDY_AREA = sa; }
export const getStudyArea = () => STUDY_AREA;

// 'gis'  (Phase 2A): a verified contributing-catchment study-area polygon sets both the area and the land-cover mask.
// 'dem'  (Phase 2B): a validated DEM-derived catchment sets the AREA only. Land cover is still simulated (Phase 2C),
//                    so the CN mix keeps sampling the simulated mask; draping simulated land cover under a real
//                    polygon would not make it more real.
const gisOperational = () => STUDY_AREA?.operational?.source === 'gis';
export const isInsideWatershed = (x, z) => (STUDY_AREA?.gis ? STUDY_AREA.gis.contains(x, z) : insideLegacyBoundary(x, z));
export const insideBoundary = isInsideWatershed;     // backwards-compatible name
export const watershedRingScene = () => (STUDY_AREA?.gis ? STUDY_AREA.gis.ringScene : legacyBoundaryRing());
export const inCatchment = (x, z) => lakeE(x, z) >= 1.15 &&
  (gisOperational() ? STUDY_AREA.gis.contains(x, z) : insideLegacyBoundary(x, z) && z < 2);
export const operationalCatchmentKm2 = () => (STUDY_AREA?.operational && STUDY_AREA.operational.source !== 'simulated' ? STUDY_AREA.operational.km2 : SIMULATED_CONTRIBUTING_KM2);
// 1 x 1 scene-unit sample cells of the operational catchment (land-use fractions)
export function catchmentCells() {
  const cells = [];
  for (let x = -47; x <= 47; x += 1) for (let z = -47; z <= 47; z += 1) if (inCatchment(x, z)) cells.push([x, z]);
  return cells;
}

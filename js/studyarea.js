// Study area = display config + (optional) GIS watershed boundary + operational catchment.
// Kept separate on purpose:
//   • name / display status ........ data/study-area.json (display only; never used in geographic logic)
//   • GIS watershed boundary ........ GeoJSON + metadata (data/gis/), shown on the 3D twin. A
//                                     'watershed-management-context' boundary (e.g. a proclaimed watershed reserve)
//                                     is study-area context only and can never drive the runoff model
//   • operational catchment ......... drives the runoff model; stays SIMULATED unless the GIS polygon is a
//                                     VERIFIED contributing catchment for the modelled reservoir/intake
//   • DEM-derived hydrology (2B) .... data/gis/catchments + data/gis/hydro: contributing catchment of a documented
//                                     outlet, derived streams, outlet, DEM preview. The catchment area replaces the
//                                     simulated value ONLY when its metadata says "validated" and every check passed
//   • administrative boundaries ..... reserved config keys; never accepted as a watershed
// If anything is missing or invalid the app falls back to the Phase 1 procedural boundary and says so.
import { setStudyArea, SIMULATED_CONTRIBUTING_KM2 } from './terrain.js';

const R_EARTH = 6371008.8;                 // IUGG mean Earth radius (m)
const WGS84_A = 6378137, WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
const SCENE_HALF = 43;                     // auto-fit: GIS outline fits inside ±43 scene units
const MAX_SCENE_VERTICES = 600;            // decimation for rendering / point tests only (area uses full rings)
export const WATERSHED_TYPES = ['watershed', 'watershed-management-context', 'contributing-catchment'];
const TYPE_LABEL = { watershed: 'watershed boundary', 'watershed-management-context': 'watershed study area', 'contributing-catchment': 'contributing catchment' };
export const ADMIN_TYPES = ['administrative', 'municipality', 'barangay', 'province', 'service-area'];

// ---------- CRS ----------
const norm = crs => String(crs ?? '').toUpperCase().replace('URN:OGC:DEF:CRS:', '').replace('::', ':');
export const isGeographic = crs => ['EPSG:4326', 'OGC:CRS84', 'CRS84', 'OGC:1.3:CRS84'].includes(norm(crs));
// projected metric CRSs: WGS 84 / UTM (EPSG:326xx, 327xx), PRS92 / Philippines zones I–V (EPSG:3121–3125), LOCAL:<name> metres
export const isProjected = crs => /^EPSG:32[67]\d\d$/.test(norm(crs)) || /^EPSG:312[1-5]$/.test(norm(crs)) || /^LOCAL:/.test(norm(crs));

// Ellipsoidal area of a lon/lat ring on WGS 84, m²: shoelace in the Lambert cylindrical equal-area projection
// (x = a·λ, y = a·q(φ)/2, q = authalic function). Exact for the ellipsoid up to the straight-edge approximation,
// which is negligible for watershed-sized edges. A mean-radius sphere would overstate tropical areas by ~0.4%.
const e = Math.sqrt(WGS84_E2);
const authalicQ = sinP => (1 - WGS84_E2) * (sinP / (1 - WGS84_E2 * sinP * sinP) - Math.log((1 - e * sinP) / (1 + e * sinP)) / (2 * e));
function ellipsoidalRingArea(ring) {
  const k = Math.PI / 180;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [l1, p1] = ring[i], [l2, p2] = ring[(i + 1) % ring.length];
    s += l1 * k * authalicQ(Math.sin(p2 * k)) - l2 * k * authalicQ(Math.sin(p1 * k));
  }
  return Math.abs((s * WGS84_A * WGS84_A) / 4);
}
const planarRingArea = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a) / 2; };

// GIS -> local metres. Geographic: local equirectangular projection about the polygon centroid (lon0, lat0);
// x = R·Δλ·cos(lat0), y = R·Δφ (error < 0.5% for watershed-sized extents). Projected: coordinates are metres already.
function localMetresProjector(crs, pts) {
  if (isProjected(crs)) return { project: p => p, unproject: p => p, method: `${crs} (projected metres, used as-is)`, origin: null };
  const lon0 = pts.reduce((s, p) => s + p[0], 0) / pts.length, lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const k = Math.PI / 180, c = Math.cos(lat0 * k);
  return {
    project: ([lon, lat]) => [R_EARTH * (lon - lon0) * k * c, R_EARTH * (lat - lat0) * k],
    unproject: ([x, y]) => [lon0 + x / (R_EARTH * k * c), lat0 + y / (R_EARTH * k)],
    method: `local equirectangular about centroid (${lon0.toFixed(5)}, ${lat0.toFixed(5)})`, origin: [lon0, lat0],
  };
}

function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const decimate = r => (r.length <= MAX_SCENE_VERTICES ? r : r.filter((_, i) => i % Math.ceil(r.length / MAX_SCENE_VERTICES) === 0));
const openRing = r => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);

// ---------- validation ----------
export function extractPolygons(geojson) {
  if (!geojson || typeof geojson !== 'object') throw new Error('Boundary is not a GeoJSON object');
  const geom = geojson.type === 'FeatureCollection' ? geojson.features?.[0]?.geometry : geojson.type === 'Feature' ? geojson.geometry : geojson;
  if (!geom) throw new Error('Boundary GeoJSON has no geometry');
  if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') throw new Error(`Unsupported geometry "${geom.type}" (need Polygon or MultiPolygon)`);
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  if (!Array.isArray(polys) || !polys.length) throw new Error('Empty geometry');
  polys.forEach((p, i) => p.forEach((ring, j) => {
    if (!Array.isArray(ring) || ring.length < 4) throw new Error(`Polygon ${i} ring ${j}: needs ≥ 4 positions`);
    if (ring.some(c => !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) throw new Error(`Polygon ${i} ring ${j}: invalid coordinate`);
  }));
  return { type: geom.type, polys: polys.map(p => p.map(openRing)) };
}

// Build the GIS part from a GeoJSON boundary + its metadata. Pure and deterministic.
// `frame` (optional): reuse another boundary's projection + scene transform so layers overlay exactly.
export function buildGisBoundary(geojson, metadata = {}, sceneTransform = null, frame = null) {
  const crs = metadata.originalCrs || geojson?.crs?.properties?.name || 'EPSG:4326';
  if (!isGeographic(crs) && !isProjected(crs)) throw new Error(`Unsupported CRS "${crs}" (use EPSG:4326/CRS84, UTM EPSG:326xx/327xx, PRS92 EPSG:3121–3125, or LOCAL:<name>)`);
  const type = metadata.boundaryType ?? 'watershed';
  if (ADMIN_TYPES.includes(type)) throw new Error(`Boundary type "${type}" is administrative and cannot be used as a watershed`);
  if (!WATERSHED_TYPES.includes(type)) throw new Error(`Unknown boundary type "${type}"`);
  const { type: geometryType, polys } = extractPolygons(geojson);
  if (isGeographic(crs) && polys.flat(2).some(([lon, lat]) => Math.abs(lon) > 180 || Math.abs(lat) > 90)) throw new Error('Coordinates out of range for a geographic CRS');
  // area: ellipsoidal (geographic) or planar (projected); outer rings minus holes
  const ringArea = isGeographic(crs) ? ellipsoidalRingArea : planarRingArea;
  const areaM2 = polys.reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);
  if (!(areaM2 > 0)) throw new Error('Polygon has zero area');
  // GIS -> local metres -> scene units (north = scene -z)
  if (frame && frame.crs !== crs) throw new Error(`CRS "${crs}" differs from the study-area frame "${frame.crs}"`);
  const proj = frame?.proj ?? localMetresProjector(crs, polys.flat(2));
  const metric = polys.map(p => p.map(r => r.map(proj.project)));
  const pts = metric.flat(2), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const t = frame?.t ?? sceneTransform ?? { originX: (bbox[0] + bbox[2]) / 2, originY: (bbox[1] + bbox[3]) / 2, metresPerUnit: Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / (2 * SCENE_HALF) };
  const toScene = ([x, y]) => [(x - t.originX) / t.metresPerUnit, -(y - t.originY) / t.metresPerUnit];
  const scenePolys = metric.map(p => p.map(r => decimate(r).map(toScene)));
  const mainIdx = metric.reduce((bi, p, i, all) => (planarRingArea(p[0]) > planarRingArea(all[bi][0]) ? i : bi), 0);
  return {
    crs, geometryType, boundaryType: type, areaKm2: areaM2 / 1e6,
    areaMethod: isGeographic(crs) ? 'ellipsoidal, WGS 84 (equal-area)' : 'planar (projected CRS)',
    vertices: polys.reduce((s, p) => s + p.reduce((q, r) => q + r.length, 0), 0),
    transform: { ...t, method: proj.method, origin: proj.origin, fit: frame ? 'study-area frame' : sceneTransform ? 'configured' : `auto-fit to ±${SCENE_HALF} scene units` },
    frame: frame ?? { crs, proj, t }, bboxMetres: bbox,
    toScene: c => toScene(proj.project(c)),
    fromScene: ([x, z]) => proj.unproject([x * t.metresPerUnit + t.originX, -z * t.metresPerUnit + t.originY]),
    // exact (undecimated) containment test in source coordinates
    containsCoord: c => { const [x, y] = proj.project(c); return metric.some(p => pointInRing(x, y, p[0]) && !p.slice(1).some(h => pointInRing(x, y, h))); },
    ringScene: scenePolys[mainIdx][0],
    contains: (x, z) => scenePolys.some(p => pointInRing(x, z, p[0]) && !p.slice(1).some(h => pointInRing(x, z, h))),
  };
}

const STATUS = { verified: 'VERIFIED', pending: 'PENDING', placeholder: 'SIMULATED', simulated: 'SIMULATED' };
const SIM_LABEL = 'Simulated contributing catchment';
const toSceneVia = (frame, c) => { const [x, y] = frame.proj.project(c); return [(x - frame.t.originX) / frame.t.metresPerUnit, -(y - frame.t.originY) / frame.t.metresPerUnit]; };

// Phase 2B: DEM-derived catchment, streams, outlet and DEM preview, in the study-area scene frame. Never throws.
// The catchment is "validated" only if its metadata says so, every recorded check passed, the polygon parses as a
// contributing catchment, its computed area agrees with the metadata (±1%) and it contains the snapped outlet.
export function buildHydrology(frame, inputs = {}) {
  const { catchment, catchmentMeta, streams, outlet, demPreview, files = {}, errors = [] } = inputs;
  const h = { catchment: null, streams: [], outlet: null, demPreview: null, errors: [...errors] };
  if (catchment) {
    const meta = catchmentMeta ?? {};
    try {
      const gis = buildGisBoundary(catchment, { originalCrs: 'EPSG:4326', ...meta, boundaryType: meta.boundaryType ?? 'contributing-catchment' }, null, frame);
      const failed = [];
      if (gis.boundaryType !== 'contributing-catchment') failed.push('boundaryType');
      if (meta.status !== 'validated') failed.push(`status:${meta.status ?? 'missing'}`);
      const checks = meta.validation?.checks;
      if (!Array.isArray(checks) || !checks.length) failed.push('validation-checks-missing');
      else checks.filter(c => !c.pass).forEach(c => failed.push(c.id));
      if (!(Number.isFinite(meta.areaKm2) && Math.abs(gis.areaKm2 - meta.areaKm2) / meta.areaKm2 < 0.01)) failed.push('area-mismatch');
      const o = meta.outlet?.snapped;
      if (!o || !gis.containsCoord([o.lon, o.lat])) failed.push('outlet-not-in-catchment');
      h.catchment = { gis, meta, validated: failed.length === 0, failed, status: failed.length ? 'not-validated' : 'validated' };
    } catch (e) { h.errors.push(`Catchment unusable (${e.message})`); }
  }
  if (frame && streams?.features) {
    h.streams = streams.features.filter(f => f.geometry?.type === 'LineString')
      .map(f => ({ order: f.properties?.strahler ?? 1, inCatchment: !!f.properties?.inCatchment, pts: f.geometry.coordinates.map(c => toSceneVia(frame, c)) }));
  }
  if (frame && outlet?.features) {
    const by = r => outlet.features.find(f => f.properties?.role === r);
    const pp = by('pour-point'), pub = by('published');
    if (pp) h.outlet = { name: pp.properties.name, snapped: toSceneVia(frame, pp.geometry.coordinates), published: pub ? toSceneVia(frame, pub.geometry.coordinates) : null, lonlat: pp.geometry.coordinates, props: pp.properties };
  }
  if (demPreview?.bounds) h.demPreview = { ...demPreview, image: files.demPreviewImage ?? null, slopeImage: files.slopePreviewImage ?? null };
  return h;
}

// Assemble the study-area object from config, metadata and (optional) GIS boundary; never throws.
export function assembleStudyArea(config = {}, metadata = null, geojson = null, error = null, hydroInputs = null) {
  const sa = {
    name: config.name ?? 'Study area', nameStatus: config.nameStatus ?? '',
    displayLabel: config.displayLabel ?? 'Simulation study area',
    studyAreaType: config.studyAreaType ?? null, twin: config.digitalTwin ?? null,
    metadata, gis: null, mode: 'fallback', warnings: [],
    fallbackReason: null,
  };
  if (geojson && !error) {
    try {
      sa.gis = buildGisBoundary(geojson, metadata ?? {}, config.sceneTransform ?? null);
      sa.mode = 'gis';
      const declared = Number.isFinite(metadata?.areaKm2) ? metadata.areaKm2 : null;
      if (declared !== null && Math.abs(declared - sa.gis.areaKm2) / declared > 0.05) sa.warnings.push(`Declared area ${declared} km² differs from computed ${sa.gis.areaKm2.toFixed(3)} km² by > 5%`);
    } catch (e) { error = e; }
  }
  if (!sa.gis) sa.fallbackReason = error ? String(error.message ?? error) : 'No GIS watershed boundary supplied (pending data)';
  const metaStatus = String(metadata?.status ?? 'pending').toLowerCase();
  sa.gisStatus = sa.gis ? (STATUS[metaStatus] ?? 'PENDING') : 'PENDING';
  // Phase 2B hydrology (optional): drawn in the study-area frame (or its own frame if no study-area GIS).
  // When a catchment extends beyond the study area, the auto-fit covers both (same projection, smaller scale).
  sa.hydro = null;
  if (sa.gis && hydroInputs?.catchment && !config.sceneTransform) {
    try {
      const pts = extractPolygons(hydroInputs.catchment).polys.flat(2).map(sa.gis.frame.proj.project);
      const [a0, b0, a1, b1] = sa.gis.bboxMetres;
      const bb = [Math.min(a0, ...pts.map(p => p[0])), Math.min(b0, ...pts.map(p => p[1])), Math.max(a1, ...pts.map(p => p[0])), Math.max(b1, ...pts.map(p => p[1]))];
      const t = { originX: (bb[0] + bb[2]) / 2, originY: (bb[1] + bb[3]) / 2, metresPerUnit: Math.max(bb[2] - bb[0], bb[3] - bb[1]) / (2 * SCENE_HALF) };
      sa.gis = buildGisBoundary(geojson, metadata ?? {}, t);
      sa.gis.transform.fit = `auto-fit (study area + DEM catchment) to ±${SCENE_HALF} scene units`;
    } catch (e) { sa.warnings.push(`Catchment not used for scene fit (${e.message})`); }
  }
  if (hydroInputs) {
    let frame = sa.gis?.frame ?? null;
    if (!frame && hydroInputs.catchment) { try { frame = buildGisBoundary(hydroInputs.catchment, { originalCrs: 'EPSG:4326', boundaryType: 'contributing-catchment' }).frame; } catch { /* reported by buildHydrology */ } }
    sa.hydro = buildHydrology(frame, hydroInputs);
  }
  const dem = sa.hydro?.catchment;
  // operational catchment, in order of preference:
  //   1. a VALIDATED DEM-derived contributing catchment (Phase 2B)
  //   2. a VERIFIED contributing-catchment study-area polygon (Phase 2A rule)
  //   3. the simulated Phase 1 value
  // The reserve / watershed-context boundary never contributes area, and areas are never added together.
  const verifiedCatchment = sa.gis && sa.gisStatus === 'VERIFIED' && sa.gis.boundaryType === 'contributing-catchment';
  if (dem?.validated) sa.operational = { source: 'dem', km2: dem.gis.areaKm2, label: 'DEM-derived contributing catchment (validated)' };
  else if (verifiedCatchment) sa.operational = { source: 'gis', km2: sa.gis.areaKm2, label: 'GIS contributing catchment (verified)' };
  else {
    const why = !hydroInputs ? 'pending DEM delineation' : dem ? 'DEM-derived catchment not validated' : 'DEM-derived catchment unavailable';
    sa.operational = { source: 'simulated', km2: SIMULATED_CONTRIBUTING_KM2, label: `${SIM_LABEL} — ${why}`, reason: why };
  }
  sa.boundaryLabel = sa.gis
    ? (sa.gisStatus === 'VERIFIED' ? `GIS ${TYPE_LABEL[sa.gis.boundaryType]} · verified source` : 'GIS watershed context · pending verification')
    : 'Fallback: Simulated Watershed Boundary';
  // studyArea summary in the shape the rest of the app expects
  Object.assign(sa, {
    status: sa.gisStatus, boundaryFile: config.gis?.watershed?.boundaryFile ?? null,
    boundarySource: sa.gis ? (metadata?.source ?? 'not stated') : 'Phase 1 procedural outline (not GIS)',
    boundarySourceUrl: sa.gis ? (metadata?.sourceUrl ?? null) : null,
    crs: sa.gis ? sa.gis.crs : 'scene units (procedural)', geometryType: sa.gis?.geometryType ?? null,
    areaKm2: sa.gis?.areaKm2 ?? null, retrieved: sa.gis ? (metadata?.retrieved ?? null) : null,
  });
  return sa;
}

export function activateStudyArea(config, metadata, geojson, error, hydroInputs = null) {
  const sa = assembleStudyArea(config, metadata, geojson, error, hydroInputs);
  setStudyArea(sa);
  if (sa.fallbackReason && sa.boundaryFile) console.warn('[study area] GIS boundary not used:', sa.fallbackReason);
  sa.warnings.forEach(w => console.warn('[study area]', w));
  sa.hydro?.errors.forEach(w => console.warn('[hydrology]', w));
  return sa;
}

// Loader. `fetchText` is injectable (fetch in the browser, fs in Node). Never throws: any failure => fallback.
export async function loadStudyArea(configPath = 'data/study-area.json', fetchText = defaultFetch) {
  let config = {}, metadata = null, geojson = null, error = null;
  try { config = JSON.parse(await fetchText(configPath)); } catch (e) { error = new Error(`Study-area config unavailable (${e.message})`); }
  const w = config.gis?.watershed ?? {};
  if (!error && w.metadataFile) { try { metadata = JSON.parse(await fetchText(w.metadataFile)); } catch (e) { error = new Error(`GIS metadata unreadable (${e.message})`); } }
  if (!error && w.boundaryFile) { try { geojson = JSON.parse(await fetchText(w.boundaryFile)); } catch (e) { error = new Error(`GIS boundary unreadable (${e.message})`); } }
  // Phase 2B hydrology: each file is optional; a missing or broken file is reported, never fatal
  const oc = config.gis?.operationalCatchment, hy = config.gis?.hydrology;
  let hydro = null;
  if (oc || hy) {
    hydro = { errors: [], files: { demPreviewImage: hy?.demPreviewImage ?? null, slopePreviewImage: hy?.slopePreviewImage ?? null } };
    const get = async (key, path) => { if (!path) return; try { hydro[key] = JSON.parse(await fetchText(path)); } catch (e) { hydro.errors.push(`${path} unreadable (${e.message})`); } };
    await get('catchment', oc?.boundaryFile); await get('catchmentMeta', oc?.metadataFile);
    await get('streams', hy?.streamsFile); await get('outlet', hy?.outletFile); await get('demPreview', hy?.demPreview);
  }
  return activateStudyArea(config, metadata, geojson, error, hydro);
}
function defaultFetch(p) { return fetch(p).then(r => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.text(); }); }

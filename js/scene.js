import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mulberry32 } from './sim.js';

import { BASE, LAKE, MAIN, TRIB_E, TRIB_W, RIVER_OUT, STREAMS, Z, ZONES, TOWNS, AREA_ZONE, ROADS, PADDY_FIELDS, sstep, nearestOnPoly, distPoly, distRoads, lakeE, rawHeight, groundHeight, inCatchment, getStudyArea, watershedRingScene } from './terrain.js';
import { classify, cnColor, UNITS } from './landuse.js';
// pipeline network (x,z control points; valves and junctions sit on control points)
// raw water:     intake -> raw reservoir -> raw main -> WTP
// treated water: WTP -> treated storage (TWS) -> distribution header -> Pump A / B / C -> service areas
const JA = [-18, 20], JB = [11, 22];
const VALVE_POS = { IVA: [-16.5, 17.5], IVB: [10, 19], XV1: [-15, 22], XV2: [8, 24] };
const TWS = [0.6, 21.6];                    // treated-water storage tank (simulated), beside the WTP
const PIPES = {
  raw: [[-2.4, 10.6], [-4.5, 14.5], [-6, 18]],
  treat: [[-3.8, 19.6], [-1.6, 20.6], TWS],
  clearA: [TWS, [-5, 22.7], [-11, 21.6], [-14, 18], [-15, 15]],
  clearB: [TWS, [4.5, 19], [9, 16]],
  clearC: [TWS, [6, 20.6], [12.8, 16.5], [13.6, 8], [12, 2], [9, -1]],
  'A-up': [[-15, 15], VALVE_POS.IVA, JA],
  'A-down': [JA, [-22, 22], [-26, 24]],
  'A-ext': [[-26, 24], [-32, 15], [-38, 6]],
  'B-up': [[9, 16], VALVE_POS.IVB, JB],
  'B-down': [JB, [16, 28], [23, 34], [30, 38]],
  cross: [JA, VALVE_POS.XV1, [-8, 25.2], [2, 25.4], VALVE_POS.XV2, JB],
  'C-down': [[9, -1], [20, -2], [28, 6], [32, 16]],
  'P3-ext': [[22, 0], [30, -2.5], [38, -2]],
};

export const ENTITIES = [
  { id: 'forest', name: 'Upper Watershed', sub: 'Schematic forest', kind: 'forest', layer: 'vegetation', x: -2, y: 15, z: -30 },
  { id: 'reservoir', name: 'Raw-Water Reservoir', sub: '', kind: 'reservoir', layer: 'reservoir', x: 0, y: 3.2, z: 5 },
  { id: 'wtp', name: 'Water Treatment Plant', sub: '', kind: 'wtp', layer: 'pumps', minor: true, x: -6, y: 5.2, z: 18 },
  { id: 'tws', name: 'Treated Water Storage', sub: '', kind: 'tws', layer: 'pumps', minor: true, x: TWS[0], y: 6.4, z: TWS[1] },
  { id: 'PUMP-01', name: 'Dist. Pump A', sub: '', kind: 'pump', layer: 'pumps', x: -15, y: 6.6, z: 15 },
  { id: 'PUMP-02', name: 'Dist. Pump B', sub: '', kind: 'pump', layer: 'pumps', x: 9, y: 6.6, z: 16 },
  { id: 'PUMP-03', name: 'Dist. Pump C', sub: '', kind: 'pump', layer: 'pumps', x: 9, y: 7, z: -1 },
  { id: 'IVA', name: 'IV-A', sub: '', kind: 'valve', layer: 'pipes', minor: true, x: VALVE_POS.IVA[0], y: 4.2, z: VALVE_POS.IVA[1] },
  { id: 'IVB', name: 'IV-B', sub: '', kind: 'valve', layer: 'pipes', minor: true, x: VALVE_POS.IVB[0], y: 4.2, z: VALVE_POS.IVB[1] },
  { id: 'XV1', name: 'XV-1', sub: '', kind: 'valve', layer: 'pipes', minor: true, x: VALVE_POS.XV1[0], y: 4.2, z: VALVE_POS.XV1[1] },
  { id: 'XV2', name: 'XV-2', sub: '', kind: 'valve', layer: 'pipes', minor: true, x: VALVE_POS.XV2[0], y: 4.2, z: VALVE_POS.XV2[1] },
  { id: 'commercial', name: 'Commercial Zone', sub: 'Service Area B', kind: 'comm', layer: 'commercial', x: 16, y: 7, z: 28 },
  { id: 'residential', name: 'Area A-1', sub: 'Service Area A', kind: 'resi', layer: 'households', x: -26, y: 4.5, z: 24 },
  { id: 'rizal', name: 'Area A-2', sub: 'Service Area A', kind: 'resi', layer: 'households', x: -38, y: 4.5, z: 6 },
  { id: 'divisoria', name: 'Area B-1', sub: 'Service Area B', kind: 'resi', layer: 'households', x: 30, y: 4.5, z: 38 },
  { id: 'poblacion', name: 'Area C-1', sub: 'Service Area C', kind: 'resi', layer: 'households', x: 32, y: 4.5, z: 16 },
  { id: 'mabini', name: 'Area C-2', sub: 'Service Area C', kind: 'resi', layer: 'households', x: 38, y: 4.5, z: -2 },
  { id: 'intake', name: 'River Intake', sub: 'Simulated', kind: 'intake', layer: 'pumps', minor: true, x: -6, y: Z.intake.h + 4.5, z: -11 },
];

const C = hex => new THREE.Color(hex);
const UP = new THREE.Vector3(0, 1, 0);
const CYAN = 0xbff3ff, AMBER = 0xffb347, RAW = 0x3fb7c4;   // treated flow = bright CYAN; raw flow = muted teal

export function createScene(container, labelHost, handlers) {
  const rng = mulberry32(11);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, 1, 1, 900);
  camera.position.set(102, 84, 128);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2, 8);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = 320;
  controls.maxPolarAngle = 1.42;

  scene.add(new THREE.HemisphereLight(0xdcecff, 0x34402f, 1.15));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.25);
  sun.position.set(-40, 80, 50);
  scene.add(sun);

  const world = new THREE.Group();
  scene.add(world);
  // layer groups mirror the Layers panel: BASE / WATER / WATERSHED / INFRASTRUCTURE / COMMUNITIES
  const LAYER_KEYS = ['terrain', 'boundary', 'roads', 'streams', 'reservoir', 'flows', 'vegetation', 'landcover', 'pumps', 'pipes', 'households', 'commercial', 'service',
    'demtint', 'slope', 'catchment', 'dstreams', 'outlet'];       // Phase 2B: DEM-derived (real) layers
  const layers = Object.fromEntries(LAYER_KEYS.map(k => [k, new THREE.Group()]));
  Object.values(layers).forEach(g => world.add(g));
  const tmp = new THREE.Color();
  const dummy = new THREE.Object3D();
  const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

  // ---------- terrain (low-poly, hypsometric tint) ----------
  const SEG = 72, SIZE = 100;
  const tgeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2);
  const tpos = tgeo.attributes.position;
  const hts = new Float32Array(tpos.count);
  for (let i = 0; i < tpos.count; i++) { hts[i] = groundHeight(tpos.getX(i), tpos.getZ(i)); tpos.setY(i, hts[i]); }
  tgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tpos.count * 3), 3));
  layers.terrain.add(new THREE.Mesh(tgeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));

  const TOPO = [0xd2dca4, 0xb4d68f, 0x8fc777, 0x6db463, 0x55a055, 0x9fa85e, 0xc0a25e, 0xa57f4f, 0x8a6a45, 0x75583b];
  let season = '', terrainMode = '3d', luTau = -1, permOn = false;
  // per-vertex land-use class (same classifier the SCS-CN model uses)
  const vCatch = Array.from({ length: tpos.count }, (_, i) => inCatchment(tpos.getX(i), tpos.getZ(i)));
  let vClass = [];
  const classifyVerts = () => { vClass = Array.from({ length: tpos.count }, (_, i) => classify(tpos.getX(i), tpos.getZ(i), luTau)); };
  classifyVerts();
  function colorTerrain(mode) {
    const col = tgeo.attributes.color;
    const dry = season === 'dry';
    for (let i = 0; i < tpos.count; i++) {
      const h = hts[i], cls = vClass[i];
      if (permOn) {
        if (cls === 'water' || h < 0.95) tmp.set(0x2c8aa0);
        else tmp.set(cnColor(UNITS[cls].cn));
        if (!vCatch[i]) tmp.lerp(C(0x1a2433), 0.55);
      } else if (cls.startsWith('cleared') && mode !== 'topo') {
        tmp.set(dry ? 0xb08a5a : 0x9a7b52);
        if (mode === 'natural') tmp.offsetHSL(0, -0.18, -0.1);
      } else if (mode === 'topo') {
        if (h < 0.95) tmp.set(0x2c8aa0);
        else {
          const u = (h - 0.95) / 1.5;
          tmp.set(TOPO[Math.min(TOPO.length - 1, Math.floor(u))]);
          if (u % 1 < 0.1 && u > 1) tmp.multiplyScalar(0.72);
        }
      } else {
        if (h < 0.95) tmp.set(0x6f6250).lerp(C(0x3a3026), sstep(0.95, -2.5, h));
        else if (h < 1.5) tmp.set(0xbfb48c);
        else if (h < 2.6) tmp.set(0x86ad6a).lerp(C(0xc2ad62), dry ? 0.65 : 0);
        else if (h < 4) tmp.set(0x6c9a58).lerp(C(0xa69a58), dry ? 0.55 : 0);
        else if (h < 10) tmp.set(0x3f7a45).lerp(C(0x7d7642), dry ? 0.3 : 0);
        else if (h < 13.5) tmp.set(0x55704a).lerp(C(0x7d7642), dry ? 0.3 : 0);
        else tmp.set(0x8a876f);
        if (mode === 'natural') tmp.offsetHSL(0, -0.18, -0.1);
      }
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;
  }
  colorTerrain('3d');

  // diorama skirt + survey grid
  {
    const pts = [], N = 72;
    const edgePt = (s, k) => { const u = -50 + (100 * k) / N; return s === 0 ? [u, -50] : s === 1 ? [50, u] : s === 2 ? [-u, 50] : [-50, -u]; };
    for (let s = 0; s < 4; s++) for (let k = 0; k < N; k++) {
      const [x1, z1] = edgePt(s, k), [x2, z2] = edgePt(s, k + 1);
      const y1 = groundHeight(x1, z1), y2 = groundHeight(x2, z2);
      pts.push(x1, y1, z1, x1, -5, z1, x2, y2, z2, x2, y2, z2, x1, -5, z1, x2, -5, z2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    g.computeVertexNormals();
    layers.terrain.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x33291f, side: THREE.DoubleSide })));
    const grid = new THREE.GridHelper(170, 34, 0x1f5a85, 0x143a57);
    grid.position.y = -5;
    scene.add(grid);
  }

  const drape = (pts, lift, n = 80, minY = -99) => {
    const base = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1])));
    return new THREE.CatmullRomCurve3(base.getSpacedPoints(n).map(p => new THREE.Vector3(p.x, Math.max(groundHeight(p.x, p.z), minY) + lift, p.z)));
  };
  const pipeY = (x, z) => Math.max(groundHeight(x, z), 1.4) + 0.5;

  // ---------- watershed boundary ----------
  {
    // outline comes from the active study-area GIS boundary (already transformed to scene units)
    const loop = watershedRingScene().map(([x, z]) => new THREE.Vector3(Math.max(-49.5, Math.min(49.5, x)), 0, Math.max(-49.5, Math.min(49.5, z))));
    const pts = new THREE.CatmullRomCurve3(loop, true, 'centripetal').getSpacedPoints(Math.max(260, loop.length * 2)).map(p => new THREE.Vector3(p.x, groundHeight(p.x, p.z) + 0.35, p.z));
    const gis = !!getStudyArea()?.gis;   // GIS outline: teal & thicker; simulated fallback: original green
    layers.boundary.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 400, gis ? 0.26 : 0.2, 5, true), new THREE.MeshBasicMaterial({ color: gis ? 0x2ee6d6 : 0x2ee66f, transparent: true, opacity: 0.9 })));
  }

  // ---------- Phase 2B: DEM-derived hydrology (real data, drawn in the study-area frame) ----------
  // Everything here comes from data/gis (Copernicus GLO-30 DEM processing). It is draped on the schematic terrain for
  // display only: the procedural relief is NOT the DEM relief, so these layers show where things are, not their height.
  const hydro = getStudyArea()?.hydro, saGis = getStudyArea()?.gis;
  const inScene = ([x, z]) => Math.abs(x) <= 49.5 && Math.abs(z) <= 49.5;
  if (hydro?.demPreview && saGis) {
    const b = hydro.demPreview.bounds;
    const drapeImage = (url, key, opacity) => {
      if (!url) return;
      const g = tgeo.clone(), pos = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const [lon, lat] = saGis.fromScene([pos.getX(i), pos.getZ(i)]);
        uv.setXY(i, (lon - b.west) / (b.east - b.west), (lat - b.south) / (b.north - b.south));
        pos.setY(i, pos.getY(i) + 0.05);
      }
      const tex = new THREE.TextureLoader().load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      layers[key].add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false })));
    };
    drapeImage(hydro.demPreview.image, 'demtint', 0.96);
    drapeImage(hydro.demPreview.slopeImage, 'slope', 0.9);
  }
  if (hydro?.catchment) {
    const ok = hydro.catchment.validated;
    const loop = hydro.catchment.gis.ringScene.map(([x, z]) => new THREE.Vector3(Math.max(-49.5, Math.min(49.5, x)), 0, Math.max(-49.5, Math.min(49.5, z))));
    const pts = new THREE.CatmullRomCurve3(loop, true, 'centripetal').getSpacedPoints(Math.max(300, loop.length * 2)).map(p => new THREE.Vector3(p.x, groundHeight(p.x, p.z) + 0.45, p.z));
    const mat = new THREE.MeshBasicMaterial({ color: ok ? 0xffc23d : 0xff9a3d, transparent: true, opacity: ok ? 0.95 : 0.85 });
    if (ok) layers.catchment.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 500, 0.24, 5, true), mat));
    else for (let i = 0; i + 4 < pts.length; i += 8) {     // dashed outline: derived, not validated
      layers.catchment.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.slice(i, i + 5)), 6, 0.2, 4, false), mat));
    }
  }
  if (hydro?.streams?.length) {
    const seg = [], col = [], cin = new THREE.Color(0xa6ecff), cout = new THREE.Color(0x5b93b3);
    for (const st of hydro.streams) {
      for (let i = 0; i + 1 < st.pts.length; i++) {
        const a = st.pts[i], c = st.pts[i + 1];
        if (!inScene(a) || !inScene(c)) continue;
        seg.push(a[0], groundHeight(a[0], a[1]) + 0.18, a[1], c[0], groundHeight(c[0], c[1]) + 0.18, c[1]);
        const k = st.inCatchment ? cin : cout;
        col.push(k.r, k.g, k.b, k.r, k.g, k.b);
      }
      if (st.order >= 3) {                                 // main stems drawn thicker
        const v = st.pts.filter(inScene).map(([x, z]) => new THREE.Vector3(x, groundHeight(x, z) + 0.2, z));
        if (v.length >= 2) layers.dstreams.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(v), Math.max(4, v.length * 2), 0.11, 4, false), new THREE.MeshBasicMaterial({ color: st.inCatchment ? 0xa6ecff : 0x5b93b3 })));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    layers.dstreams.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })));
  }
  if (hydro?.outlet && inScene(hydro.outlet.snapped)) {
    const [x, z] = hydro.outlet.snapped, y = groundHeight(x, z);
    const pin = new THREE.Group();
    pin.add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.2, 6), new THREE.MeshBasicMaterial({ color: 0xff4fd8 })).translateY(y + 1.6));
    pin.add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff4fd8 })).translateY(y + 3.3));
    pin.add(new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.12, 6, 28).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff4fd8 })).translateY(y + 0.3));
    pin.position.set(x, 0, z);
    layers.outlet.add(pin);
  }

  // ---------- water ----------
  const lakeGeo = new THREE.PlaneGeometry(24, 18, 24, 18).rotateX(-Math.PI / 2);
  const lakeBase = Float32Array.from(lakeGeo.attributes.position.array);
  const lake = new THREE.Mesh(lakeGeo, new THREE.MeshPhongMaterial({ color: 0x2a9de0, transparent: true, opacity: 0.88, shininess: 90, specular: 0xaadfff, flatShading: true }));
  lake.position.set(0, 0.9, 6);
  layers.reservoir.add(lake);

  function ribbon(pts, width, yOf, mat, taper = true) {
    const P = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1]))).getSpacedPoints(Math.max(20, Math.round(pts.length * 18)));
    const pos = [], idx = [];
    P.forEach((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const w = width * (taper ? 0.6 + 0.4 * (i / P.length) : 1);
      for (const s of [-1, 1]) { const x = p.x - dz * w * s, z = p.z + dx * w * s; pos.push(x, yOf(x, z), z); }
      if (i < P.length - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }
  const riverMat = new THREE.MeshPhongMaterial({ color: 0x35b0f0, emissive: 0x0a4a7a, side: THREE.DoubleSide, shininess: 60 });
  [[MAIN, 1.1, 0.18], [TRIB_E, 0.55, 0.12], [TRIB_W, 0.55, 0.12], [RIVER_OUT, 1.3, 0.2]].forEach(([p, w, lift]) => layers.streams.add(ribbon(p, w, (x, z) => groundHeight(x, z) + lift, riverMat)));

  // ---------- roads (with bridges over the river) ----------
  const roadMat = new THREE.MeshLambertMaterial({ color: 0x4a4f57, side: THREE.DoubleSide });
  const roadY = (x, z) => Math.max(groundHeight(x, z), BASE - 0.05) + 0.12;
  ROADS.forEach(r => layers.roads.add(ribbon(r.pts, r.w / 2, roadY, roadMat, false)));
  // town street grids
  {
    const segs = [];
    TOWNS.forEach(k => {
      const zn = Z[k], sp = 2.2, rr = zn.r * 0.85;
      for (let g = -6; g <= 6; g += 3) {
        const off = g * sp;
        if (Math.abs(off) >= rr) continue;
        const half = Math.sqrt(rr * rr - off * off);
        segs.push([zn.x + off, zn.z, 0.5, half * 2], [zn.x, zn.z + off, half * 2, 0.5]);
      }
    });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.05, 1), roadMat, segs.length);
    segs.forEach(([x, z, sx, sz], i) => { dummy.position.set(x, BASE + 0.06, z); dummy.scale.set(sx, 1, sz); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
    layers.roads.add(mesh);
  }

  // ---------- tropical land cover ----------
  const nearWater = (x, z, d) => lakeE(x, z) < 1.4 || Math.min(...STREAMS.map(s => distPoly(x, z, s)), distPoly(x, z, RIVER_OUT)) < d;
  const inZone = (x, z, k = 1.05) => ZONES.some(zn => Math.hypot(x - zn.x, z - zn.z) < zn.r * k);
  const forest = { items: [] };
  {
    const N = 340;
    const crown = forest.crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0).scale(1, 0.75, 1).translate(0, 1.75, 0), new THREE.MeshLambertMaterial({ flatShading: true }), N);
    const trunk = forest.trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.17, 1.2, 5).translate(0, 0.6, 0), new THREE.MeshLambertMaterial({ color: 0x6b4f35 }), N);
    const greens = [0x2f7a3a, 0x3f8f45, 0x2a6b35, 0x4a9a48];
    let placed = 0, tries = 0;
    while (placed < N && tries++ < 20000) {
      const x = (rng() - 0.5) * 92, z = (rng() - 0.5) * 92;
      const h = groundHeight(x, z);
      if (h < 3.4 || h > 15 || rng() > 0.6) continue;
      if (inZone(x, z, 1.1) || nearWater(x, z, 2.4) || distRoads(x, z) < 1.6) continue;
      const k = 0.85 + rng() * 0.45;
      dummy.position.set(x, h - 0.1, z); dummy.scale.set(k, k * (0.9 + rng() * 0.3), k); dummy.rotation.set(0, rng() * 6, 0); dummy.updateMatrix();
      crown.setMatrixAt(placed, dummy.matrix); trunk.setMatrixAt(placed, dummy.matrix);
      crown.setColorAt(placed, tmp.set(greens[Math.floor(rng() * greens.length)]));
      forest.items.push({ x, z, m: dummy.matrix.clone() });
      placed++;
    }
    crown.count = trunk.count = placed;
    layers.vegetation.add(trunk, crown);
  }
  // trees standing on cleared (kaingin / logged) cells are removed, stumps only
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const stump = new THREE.Matrix4();
  function updateTrees() {
    forest.items.forEach((t, i) => {
      const gone = classify(t.x, t.z, luTau).startsWith('cleared');
      forest.crown.setMatrixAt(i, gone ? hidden : t.m);
      forest.trunk.setMatrixAt(i, gone ? stump.copy(t.m).multiply(new THREE.Matrix4().makeScale(1, 0.25, 1)) : t.m);
    });
    forest.crown.instanceMatrix.needsUpdate = forest.trunk.instanceMatrix.needsUpdate = true;
  }
  {
    const spots = [];
    const settled = [...TOWNS, 'commercial'].map(k => Z[k]);
    for (let tries = 0; spots.length < 50 && tries < 8000; tries++) {
      const x = (rng() - 0.5) * 90, z = -6 + rng() * 54;
      const h = groundHeight(x, z);
      if (h < 1.6 || h > 2.8 || lakeE(x, z) < 1.3 || nearWater(x, z, 1.6) || distRoads(x, z) < 1.2) continue;
      const nearTown = settled.some(zn => { const d = Math.hypot(x - zn.x, z - zn.z); return d > zn.r * 0.95 && d < zn.r * 1.6; });
      if (!nearTown && !(distPoly(x, z, RIVER_OUT) < 5) && lakeE(x, z) > 2.2) continue;
      if (inZone(x, z, 0.95)) continue;
      spots.push([x, h, z]);
    }
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 3.2, 5).translate(0, 1.6, 0), new THREE.MeshLambertMaterial({ color: 0x8a6a45 }), spots.length);
    const frond = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.05, 1.7).translate(0, 0, 0.85), lambert(0x4f9a3a), spots.length * 6);
    spots.forEach(([x, h, z], i) => {
      const lean = (rng() - 0.5) * 0.25;
      dummy.position.set(x, h - 0.05, z); dummy.rotation.set(0, 0, lean); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      trunk.setMatrixAt(i, dummy.matrix);
      const tx = x - Math.sin(lean) * 3.2, ty = h + Math.cos(lean) * 3.2 - 0.05, yaw0 = rng() * Math.PI;
      for (let f = 0; f < 6; f++) {
        dummy.position.set(tx, ty, z);
        dummy.rotation.set(0.45, yaw0 + (f * Math.PI) / 3, 0, 'YXZ');
        dummy.updateMatrix();
        frond.setMatrixAt(i * 6 + f, dummy.matrix);
      }
      dummy.rotation.set(0, 0, 0, 'XYZ');
    });
    layers.vegetation.add(trunk, frond);
  }
  const paddies = [];
  {
    const plots = [];
    [[-11, 40], [-34, 40], [16, 42]].forEach(([cx, cz]) => {
      for (let i = -2; i < 2; i++) for (let j = -1; j < 2; j++) {
        const x = cx + i * 2.9 + 1.45, z = cz + j * 2.2;
        if (nearWater(x, z, 1.8) || distRoads(x, z) < 1.4) continue;
        plots.push([x, groundHeight(x, z), z]);
      }
    });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.3, 1.9), new THREE.MeshLambertMaterial(), plots.length);
    plots.forEach(([x, h, z], i) => { dummy.position.set(x, h - 0.08, z); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
    paddies.push({ mesh, n: plots.length, seed: plots.map(() => rng()) });
    layers.landcover.add(mesh);
  }
  function colorPaddies(dry) {
    paddies.forEach(p => {
      for (let i = 0; i < p.n; i++) {
        const r = p.seed[i];
        p.mesh.setColorAt(i, tmp.set(dry ? (r < 0.5 ? 0xc9b46a : 0xb59a58) : r < 0.25 ? 0x6fb0a8 : r < 0.6 ? 0x9fcf5a : 0x86bf4e));
      }
      p.mesh.instanceColor.needsUpdate = true;
    });
  }
  colorPaddies(false);

  // ---------- land-use zones, houses, commercial blocks ----------
  const areaFx = {};
  function landUse(entityId, fill, line, layer) {
    const zn = Z[AREA_ZONE[entityId]];
    const disc = new THREE.Mesh(new THREE.CircleGeometry(zn.r * 0.95, 40).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: fill }));
    disc.position.set(zn.x, BASE + 0.03, zn.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(zn.r * 0.95, zn.r * 0.95 + 0.3, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: line, transparent: true, opacity: 0.85 }));
    ring.position.set(zn.x, BASE + 0.07, zn.z);
    const halo = new THREE.Mesh(new THREE.RingGeometry(zn.r * 0.98, zn.r * 1.18, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0, depthWrite: false }));
    halo.position.set(zn.x, BASE + 0.1, zn.z);
    layer.add(disc);
    layers.service.add(ring, halo);
    areaFx[entityId] = { ring, halo, line, state: 'normal' };
  }
  ['residential', 'rizal', 'divisoria', 'poblacion', 'mabini'].forEach(id => landUse(id, 0x6f6a58, 0xff9f43, layers.households));
  landUse('commercial', 0x5a6070, 0xff4d57, layers.commercial);

  {
    const spots = [];
    TOWNS.forEach(k => {
      const zn = Z[k], sp = 2.2;
      for (let gi = -6; gi <= 6; gi++) for (let gj = -6; gj <= 6; gj++) {
        if (gi % 3 === 0 || gj % 3 === 0) continue;
        const ix = gi * sp, iz = gj * sp;
        if (Math.hypot(ix, iz) > zn.r * 0.84 || rng() < 0.12) continue;
        spots.push([zn.x + ix, zn.z + iz, rng() * 0.3]);
      }
    });
    // roadside homes (barrio pattern along provincial and barangay roads)
    ROADS.slice(0, 3).forEach(r => {
      const curve = new THREE.CatmullRomCurve3(r.pts.map(p => new THREE.Vector3(p[0], 0, p[1])));
      const len = curve.getLength();
      for (let s = 0; s < len; s += 2.6) {
        const p = curve.getPointAt(s / len), t = curve.getTangentAt(s / len);
        for (const side of [-1, 1]) {
          if (rng() > 0.42) continue;
          const x = p.x - t.z * 1.7 * side, z = p.z + t.x * 1.7 * side;
          const h = groundHeight(x, z);
          if (Math.abs(x) > 46 || Math.abs(z) > 46 || inZone(x, z, 1.0) || nearWater(x, z, 2) || h > 4.5 || h < 1.6) continue;
          spots.push([x, z, Math.atan2(t.x, t.z)]);
        }
      }
    });
    const wall = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, 0.75, 1.1), new THREE.MeshLambertMaterial({ color: 0xece0c8 }), spots.length);
    const roof = new THREE.InstancedMesh(new THREE.ConeGeometry(0.92, 0.6, 4).rotateY(Math.PI / 4), lambert(0xffffff), spots.length);
    const roofs = [0xe07a3a, 0xe07a3a, 0xc8553d, 0x8fa3b5, 0xd9893f];
    spots.forEach(([x, z, yaw], i) => {
      const y = groundHeight(x, z);
      dummy.scale.set(1, 1, 1); dummy.rotation.set(0, yaw, 0);
      dummy.position.set(x, y + 0.36, z); dummy.updateMatrix(); wall.setMatrixAt(i, dummy.matrix);
      dummy.position.set(x, y + 1.04, z); dummy.updateMatrix(); roof.setMatrixAt(i, dummy.matrix);
      roof.setColorAt(i, tmp.set(roofs[Math.floor(rng() * roofs.length)]));
    });
    layers.households.add(wall, roof);
  }
  {
    const zn = Z.commercial, items = [];
    for (let ix = -zn.r; ix <= zn.r; ix += 3) for (let iz = -zn.r; iz <= zn.r; iz += 3) {
      const d = Math.hypot(ix, iz);
      if (d > zn.r * 0.72 || rng() < 0.15) continue;
      items.push({ x: zn.x + ix, z: zn.z + iz, h: (1.6 + rng() * 3) * (1.2 - (d / zn.r) * 0.6) });
    }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ emissive: 0x16222e }), items.length);
    items.forEach((b, i) => {
      dummy.position.set(b.x, BASE + b.h / 2, b.z); dummy.scale.set(1.9, b.h, 1.9); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix); mesh.setColorAt(i, tmp.set(0x9db4cc).offsetHSL(0, 0, (rng() - 0.5) * 0.08));
    });
    layers.commercial.add(mesh);
  }

  // ---------- water treatment plant ----------
  {
    const g = new THREE.Group();
    g.position.set(Z.wtp.x, BASE, Z.wtp.z);
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); };
    add(new THREE.BoxGeometry(8.6, 0.2, 6.4), lambert(0x7d8794), 0, 0.1, 0);
    const water = new THREE.MeshPhongMaterial({ color: 0x3fb4e6, emissive: 0x0b4a6a, flatShading: true });
    for (const z of [-1.6, 1.6]) {
      add(new THREE.CylinderGeometry(1.35, 1.35, 0.8, 16), lambert(0xc9d2dc), -2.4, 0.6, z);
      add(new THREE.CylinderGeometry(1.15, 1.15, 0.05, 16), water, -2.4, 1.02, z);
    }
    for (let i = 0; i < 3; i++) {
      add(new THREE.BoxGeometry(1.1, 0.6, 2.2), lambert(0xaab4bf), 0.4 + i * 1.3, 0.5, -1.4);
      add(new THREE.BoxGeometry(0.9, 0.05, 2.0), water, 0.4 + i * 1.3, 0.81, -1.4);
    }
    add(new THREE.BoxGeometry(2.6, 1.7, 1.8), lambert(0xe9eef2), 2.2, 1.05, 1.6);
    add(new THREE.BoxGeometry(2.8, 0.15, 2.0), lambert(0x2f8cff), 2.2, 1.95, 1.6);
    add(new THREE.BoxGeometry(2.2, 0.55, 1.4), lambert(0x6f8fa8), -0.2, 0.45, 1.8);
    layers.pumps.add(g);
  }

  // ---------- treated-water storage (ground tank, simulated) ----------
  {
    const g = new THREE.Group(), y0 = groundHeight(TWS[0], TWS[1]) - 0.15;
    g.position.set(TWS[0], y0, TWS[1]);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.85, 2.3, 20), lambert(0xd9e2ea));
    shell.position.y = 1.15; g.add(shell);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 0.6, 20), lambert(0x2f8cff));
    roof.position.y = 2.6; g.add(roof);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.78, 1.78, 0.18, 20), new THREE.MeshBasicMaterial({ color: 0x5fd0ff }));
    band.position.y = 1.6; g.add(band);
    layers.pumps.add(g);
  }

  // ---------- pump stations & intake ----------
  const pumpObjs = {};
  const STATUS_COL = { running: 0x2ee66f, standby: 0xffa43a, failed: 0xff3b3b };
  function station(e, kind) {
    const g = new THREE.Group();
    g.position.set(e.x, groundHeight(e.x, e.z), e.z);
    const body = new THREE.Group();
    g.add(body);
    const mats = [];
    const mk = (geo, color, x, y, z) => { const mat = lambert(color); mats.push({ mat, color }); const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); body.add(m); };
    if (kind === 'pump') {
      mk(new THREE.CylinderGeometry(1.5, 1.7, 0.5, 8), 0x25496b, 0, 0.25, 0);
      mk(new THREE.BoxGeometry(1.8, 1.3, 1.6), 0xdbe7f2, -0.3, 1.15, 0);
      mk(new THREE.CylinderGeometry(0.55, 0.55, 1.8, 8), 0x7aa9d6, 0.85, 1.4, 0.2);
    } else {
      mk(new THREE.BoxGeometry(2.2, 1, 1.6), 0x8895a3, 0, 0.5, 0);
      mk(new THREE.BoxGeometry(0.5, 1.6, 1.8), 0x3d4b59, 1.2, 0.8, 0);
    }
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 4.2, 6), new THREE.MeshBasicMaterial({ color: 0x2ee66f, transparent: true, opacity: 0.8 }));
    beam.position.y = 4;
    const bulb = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshBasicMaterial({ color: 0x2ee66f }));
    bulb.position.y = 6.2;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.3, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2ee66f, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    ring.position.y = 0.12;
    const smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial({ color: 0x5a5a5a, transparent: true, opacity: 0.55, depthWrite: false }), 10);
    smoke.visible = false;
    smoke.frustumCulled = false;
    g.add(beam, bulb, ring, smoke);
    layers.pumps.add(g);
    return { g, body, mats, beam, bulb, ring, smoke, status: 'running' };
  }
  ENTITIES.filter(e => e.kind === 'pump').forEach(e => { pumpObjs[e.id] = station(e, 'pump'); });
  const intake = station(ENTITIES.find(e => e.id === 'intake'), 'intake');
  [intake.beam, intake.bulb, intake.ring].forEach(m => m.material.color.set(0x35b0f0));

  // ---------- directional flows ----------
  const flows = [];
  const arrowGeo = (r, h) => new THREE.ConeGeometry(r, h, 6);
  function addFlow(curve, { geo, color, opacity = 1, spacing = 3, speed = 4, layer = layers.flows, key }) {
    const len = curve.getLength();
    const N = Math.max(3, Math.round(len / spacing));
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity }), N);
    mesh.frustumCulled = false;
    layer.add(mesh);
    const f = { curve, mesh, N, len, speed, phase: Math.random(), intensity: 1, reverse: false, key, baseColor: color };
    flows.push(f);
    return f;
  }
  const lakeEdge = (tx, tz, k = 0.8) => {
    const dx = tx - LAKE.cx, dz = tz - LAKE.cz;
    const s = k / Math.hypot(dx / LAKE.rx, dz / LAKE.rz);
    return [LAKE.cx + dx * s, LAKE.cz + dz * s];
  };

  const streamArrow = arrowGeo(0.24, 0.75);
  [MAIN, TRIB_E, TRIB_W].forEach(p => addFlow(drape(p, 0.45, 90), { geo: streamArrow, color: 0xdaf6ff, opacity: 0.9, spacing: 3.2, key: 'riverIn' }));
  addFlow(drape(RIVER_OUT, 0.5, 90), { geo: streamArrow, color: 0xdaf6ff, opacity: 0.9, spacing: 3.2, key: 'riverOut' });

  const runoffDot = new THREE.SphereGeometry(0.2, 6, 4);
  for (let i = 0, tries = 0; i < 16 && tries < 2000; tries++) {
    const x = (rng() - 0.5) * 84, z = -30 + rng() * 30;
    if (rawHeight(x, z) < 7) continue;
    const target = STREAMS.map(s => nearestOnPoly(x, z, s)).sort((a, b) => a.d - b.d)[0];
    if (target.d < 5 || target.d > 18) continue;
    const mid = [(x + target.x) / 2 + (rng() - 0.5) * 3, (z + target.z) / 2 + (rng() - 0.5) * 3];
    const h0 = groundHeight(x, z), h1 = groundHeight(mid[0], mid[1]), h2 = groundHeight(target.x, target.z);
    if (!(h0 > h1 + 0.5 && h1 > h2 + 0.5)) continue;
    addFlow(drape([[x, z], mid, [target.x, target.z]], 0.35, 30), { geo: runoffDot, color: 0x8fe3ff, opacity: 0.95, spacing: 2.2, speed: 3, key: 'runoff' });
    i++;
  }

  // pipelines
  const PIPE_STYLE = {
    normal: [0x3da5ff, 0x124a80], backup: [0xffa53a, 0x7a3d00], idle: [0x5b6b7c, 0x000000], dead: [0x3a3f47, 0x000000], raw: [0x6d8fa8, 0x10283d],
  };
  const tubes = {};
  const pipeArrow = arrowGeo(0.32, 0.85);
  const RAW_PIPES = ['raw', 'pumpIn'];       // untreated water never reaches a distribution pipe
  function pipeline(key, pts, radius = 0.17) {
    const curve = new THREE.CatmullRomCurve3(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1]))).getSpacedPoints(90).map(p => new THREE.Vector3(p.x, pipeY(p.x, p.z), p.z)));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 120, radius, 6), new THREE.MeshLambertMaterial({ color: PIPE_STYLE.normal[0], emissive: PIPE_STYLE.normal[1] }));
    layers.pipes.add(tube);
    tubes[key] = tube;
    addFlow(curve, { geo: pipeArrow, color: RAW_PIPES.includes(key) ? RAW : CYAN, spacing: 2.6, speed: 5, layer: layers.pipes, key });
  }
  Object.entries(PIPES).forEach(([k, pts]) => pipeline(k, pts, k === 'cross' ? 0.2 : k === 'treat' ? 0.22 : 0.17));
  const it = ENTITIES.find(e => e.id === 'intake');
  pipeline('pumpIn', [[it.x, it.z], [-4, -4], lakeEdge(-1, -2, 0.7)]);
  const setPipeStyle = (key, style) => { const t = tubes[key], s = PIPE_STYLE[style]; if (t && s) { t.material.color.set(s[0]); t.material.emissive.set(s[1]); } };
  RAW_PIPES.forEach(k => setPipeStyle(k, 'raw'));
  setPipeStyle('cross', 'idle');

  // junction tees
  [JA, JB].forEach(([x, z]) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 8), lambert(0x9fd3ff));
    m.position.set(x, pipeY(x, z), z);
    layers.pipes.add(m);
  });

  // valves: body + handwheel + state light (green open, red closed)
  const valveObjs = {};
  Object.entries(VALVE_POS).forEach(([id, [x, z]]) => {
    const g = new THREE.Group();
    g.position.set(x, pipeY(x, z), z);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.95, 10), lambert(0x6b7682));
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 6), lambert(0x6b7682));
    stem.position.y = 0.75;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.08, 6, 14).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2ee66f }));
    wheel.position.y = 1.12;
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0x2ee66f }));
    light.position.y = 1.5;
    g.add(body, stem, wheel, light);
    g.scale.setScalar(1.25);
    layers.pipes.add(g);
    valveObjs[id] = { g, wheel, light, open: true, target: 0 };
  });

  // ---------- rain ----------
  const RAIN_MAX = 2600;
  const rainPos = new Float32Array(RAIN_MAX * 6);
  const rainSeed = Array.from({ length: RAIN_MAX }, () => [(rng() - 0.5) * 92, rng() * 50, -48 + rng() * 80, 22 + rng() * 12]);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaed6ff, transparent: true, opacity: 0.4 }));
  rain.frustumCulled = false;
  scene.add(rain);
  let rainCount = 350;

  // ---------- labels ----------
  const labelEls = {};
  const outletEnt = hydro?.outlet && inScene(hydro.outlet.snapped)
    ? [{ id: 'outlet', name: hydro.outlet.props.label ?? 'Outlet', sub: 'Candidate · not a verified intake', kind: 'gisoutlet', layer: 'outlet', x: hydro.outlet.snapped[0], y: groundHeight(...hydro.outlet.snapped) + 4.2, z: hydro.outlet.snapped[1] }]
    : [];
  const labels = [...ENTITIES, ...outletEnt].map(e => {
    const el = document.createElement('div');
    el.className = `ml ml-${e.kind}`;
    el.innerHTML = `<span class="ml-dot"></span><span class="ml-txt"><b>${e.name}</b><i>${e.sub}</i></span>`;
    el.addEventListener('click', () => handlers.onSelect?.(e.id));
    labelHost.appendChild(el);
    labelEls[e.id] = el;
    return { e, el, pos: new THREE.Vector3(e.x, e.y, e.z), force: false };
  });
  const labelById = Object.fromEntries(labels.map(l => [l.e.id, l]));
  const PRIO = ['outlet', 'reservoir', 'PUMP-01', 'PUMP-02', 'wtp', 'tws', 'XV1', 'XV2', 'IVA', 'IVB', 'PUMP-03', 'intake', 'forest', 'residential', 'commercial', 'rizal', 'divisoria', 'poblacion', 'mabini'];
  const labelOrder = [...labels].sort((a, b) => PRIO.indexOf(a.e.id) - PRIO.indexOf(b.e.id));
  let frame = 0, selectedId = null;

  // ---------- state & loop ----------
  const layerOn = Object.fromEntries(LAYER_KEYS.map(k => [k, true]));
  let waterPct = 0.684, view = '3d', scaleTarget = 1, tween = null;
  const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const VIEWS = {
    '3d': { p: [102, 84, 128], t: [0, 2, 8], sy: 1, mode: '3d' },
    natural: { p: [102, 84, 128], t: [0, 2, 8], sy: 1, mode: 'natural' },
    topo: { p: [60, 125, 100], t: [0, 2, 8], sy: 1, mode: 'topo' },
    '2d': { p: [0, 190, 28], t: [0, 0, 6], sy: 0.18, mode: '3d' },
  };
  const flyCam = (p, t, dur = 1.1) => { tween = { t0: performance.now(), dur: dur * 1000, fp: camera.position.clone(), ft: controls.target.clone(), tp: new THREE.Vector3(...p), tt: new THREE.Vector3(...t) }; };

  const clock = new THREE.Clock();
  const v3 = new THREE.Vector3(), tan = new THREE.Vector3();
  let W = 1, H = 1;
  let mobileMode = false, prCap = 2;     // mobile layout: pixel ratio capped at 1.5, labels reduced, touch mapping changed
  function resize() {
    W = container.clientWidth || 1; H = container.clientHeight || 1;
    const scale = container.getBoundingClientRect().width / W || 1;
    renderer.setPixelRatio(Math.min(prCap, devicePixelRatio * scale));
    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.dur), e = ease(k);
      camera.position.lerpVectors(tween.fp, tween.tp, e);
      controls.target.lerpVectors(tween.ft, tween.tt, e);
      if (k >= 1) tween = null;
    }
    world.scale.y += (scaleTarget - world.scale.y) * Math.min(1, dt * 5);
    controls.update();

    lake.position.y = 0.2 + waterPct * 1.0;
    const lp = lakeGeo.attributes.position;
    for (let i = 0; i < lp.count; i++) lp.setY(i, Math.sin(lakeBase[i * 3] * 0.5 + time * 1.4) * 0.05 + Math.cos(lakeBase[i * 3 + 2] * 0.6 + time * 1.1) * 0.05);
    lp.needsUpdate = true;

    for (const o of [...Object.values(pumpObjs), intake]) {
      const k = (time * (o.status === 'failed' ? 1.6 : 0.8)) % 1;
      o.ring.scale.setScalar(0.7 + k * 0.9);
      o.ring.material.opacity = 0.65 * (1 - k);
      o.bulb.rotation.y = time;
      if (o.smoke.visible) {
        for (let i = 0; i < 10; i++) {
          const s = ((i / 10) + time * 0.25) % 1;
          dummy.position.set(Math.sin(i * 2.3 + time) * 0.4 * s, 1.6 + s * 6, Math.cos(i * 1.7) * 0.4 * s);
          dummy.scale.setScalar(0.5 + s * 1.6);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          o.smoke.setMatrixAt(i, dummy.matrix);
        }
        o.smoke.instanceMatrix.needsUpdate = true;
      }
    }

    // valve handwheels turn while changing state
    for (const v of Object.values(valveObjs)) {
      v.wheel.rotation.y += (v.target - v.wheel.rotation.y) * Math.min(1, dt * 3);
    }

    // affected service areas pulse
    for (const a of Object.values(areaFx)) {
      if (a.state === 'normal') continue;
      const p = 0.5 + 0.5 * Math.sin(time * (a.state === 'out' ? 7 : a.state === 'shortage' ? 5 : 3.5));
      a.halo.material.opacity = 0.25 + 0.5 * p;
      a.ring.material.opacity = 0.6 + 0.4 * p;
    }

    for (const f of flows) {
      const n = f.intensity <= 0.01 ? 0 : Math.max(2, Math.round(f.N * Math.min(1, 0.35 + f.intensity * 0.65)));
      f.mesh.count = n;
      if (!n) continue;
      f.phase = (f.phase + dt * f.speed * (0.4 + f.intensity) / f.len) % 1;
      for (let i = 0; i < n; i++) {
        const t0 = (i / n + f.phase) % 1, t = f.reverse ? 1 - t0 : t0;
        f.curve.getPointAt(t, v3);
        f.curve.getTangentAt(t, tan);
        if (f.reverse) tan.negate();
        dummy.position.copy(v3);
        dummy.quaternion.setFromUnitVectors(UP, tan.normalize());
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        f.mesh.setMatrixAt(i, dummy.matrix);
      }
      f.mesh.instanceMatrix.needsUpdate = true;
    }

    rain.visible = rainCount > 0 && layerOn.flows;
    if (rainCount > 0) {
      for (let i = 0; i < rainCount; i++) {
        const r = rainSeed[i];
        r[1] -= r[3] * dt;
        if (r[1] < 0) r[1] += 50;
        rainPos.set([r[0], r[1], r[2], r[0] - 0.15, r[1] + 1.3, r[2]], i * 6);
      }
      rainGeo.attributes.position.needsUpdate = true;
      rainGeo.setDrawRange(0, rainCount * 2);
    }

    renderer.render(scene, camera);

    // labels: project, then lift overlapping ones (priority order) and stretch their leader line
    if (frame++ % 20 === 0) labels.forEach(l => { if (l.el.offsetWidth) { l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; } });
    const camDist = camera.position.distanceTo(controls.target);
    const placed = [];
    for (const l of labelOrder) {
      v3.copy(l.pos); world.localToWorld(v3); v3.project(camera);
      const minorHidden = l.e.minor && !(camDist < 110 || l.force || selectedId === l.e.id);
      const mobileHidden = mobileMode && l.e.kind !== 'pump' && selectedId !== l.e.id;   // mobile: pumps + selection only
      if (!layerOn[l.e.layer] || v3.z > 1 || minorHidden || mobileHidden) { l.el.style.display = 'none'; continue; }
      const x = (v3.x * 0.5 + 0.5) * W, y0 = (-v3.y * 0.5 + 0.5) * H;
      let y = y0;
      const w = l.w || 120, h = l.h || 30;
      for (let k = 0; k < 6; k++) {
        const hit = placed.find(p => Math.abs(p.x - x) < (p.w + w) / 2 + 2 && y > p.y - p.h - 2 && y - h < p.y + 2);
        if (!hit) break;
        y = hit.y - hit.h - 3;
      }
      placed.push({ x, y, w, h });
      l.el.style.display = '';
      l.el.style.setProperty('--stem', `${10 + y0 - y}px`);
      l.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
    }
  });

  return {
    setLayer(name, on) { layerOn[name] = on; layers[name].visible = on; },
    setView(v) {
      view = v;
      const c = VIEWS[v];
      terrainMode = c.mode;
      colorTerrain(c.mode);
      scaleTarget = c.sy;
      flyCam(c.p, c.t);
    },
    setWater(pct) { waterPct = Math.max(0, Math.min(1, pct)); },
    setPermeability(on) { permOn = on; colorTerrain(terrainMode); },
    setLandUse(tau) {
      if (tau === luTau) return;
      luTau = tau;
      classifyVerts();
      colorTerrain(terrainMode);
      updateTrees();
    },
    setSeason(s) { if (s !== season) { season = s; colorTerrain(terrainMode); colorPaddies(s === 'dry'); } },
    setPump(id, status) {
      const o = pumpObjs[id];
      if (!o || o.status === status) return;
      o.status = status;
      const c = STATUS_COL[status] ?? STATUS_COL.failed;
      [o.beam, o.bulb, o.ring].forEach(m => m.material.color.set(c));
      const failed = status === 'failed';
      o.body.rotation.set(failed ? 0.12 : 0, 0, failed ? 0.22 : 0);
      o.body.position.y = failed ? -0.25 : 0;
      o.mats.forEach(({ mat, color }) => mat.color.set(failed ? tmp.set(color).multiplyScalar(0.35) : color));
      o.smoke.visible = failed;
      o.beam.visible = !failed;
      if (labelEls[id]) labelEls[id].dataset.status = status;
    },
    setValve(id, open, normal) {
      const v = valveObjs[id];
      if (!v) return;
      if (v.open !== open) v.target += Math.PI * 2;
      v.open = open;
      const c = open ? 0x2ee66f : 0xff4d57;
      v.light.material.color.set(c);
      v.wheel.material.color.set(c);
      const l = labelById[id];
      l.force = open !== normal;
      l.el.dataset.level = open ? 'open' : 'closed';
      l.el.querySelector('i').textContent = open ? 'OPEN' : 'CLOSED';
    },
    setPipeStyle,
    setAreaState(id, state) {
      const a = areaFx[id];
      if (!a || a.state === state) return;
      a.state = state;
      // normal | backup (fed via cross-connection) | shortage (supply < demand) | out (no supply)
      const c = { normal: a.line, backup: AMBER, shortage: 0xff6b3d, out: 0xff3b3b }[state] ?? AMBER;
      a.ring.material.color.set(c);
      a.halo.material.color.set(c);
      if (state === 'normal') { a.halo.material.opacity = 0; a.ring.material.opacity = 0.85; }
    },
    setRain(level) { rainCount = [0, 350, 1100, 2600][level] ?? 0; },
    // value: intensity 0..1, or { i, color, reverse }
    setFlows(map) {
      flows.forEach(f => {
        if (!(f.key in map)) return;
        const v = map[f.key];
        if (typeof v === 'number') { f.intensity = v; f.reverse = false; f.mesh.material.color.set(f.baseColor); }
        else { f.intensity = v.i; f.reverse = !!v.reverse; f.mesh.material.color.set(v.color ?? f.baseColor); }
      });
    },
    setLabel(id, sub, cls) {
      const el = labelEls[id];
      if (!el) return;
      el.querySelector('i').textContent = sub;
      if (cls !== undefined) el.dataset.level = cls;
    },
    // Mobile layout: one finger scrolls the page (touch-action pan-y); two fingers rotate + zoom the map.
    // Stock OrbitControls offers DOLLY_PAN or DOLLY_ROTATE for two fingers, not both, so two-finger pan is not available.
    setMobile(on) {
      mobileMode = on; prCap = on ? 1.5 : 2;
      controls.touches = on ? { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      renderer.domElement.style.touchAction = on ? 'pan-y' : 'none';
      resize();
    },
    selectLabel(id) { selectedId = id; Object.entries(labelEls).forEach(([k, el]) => el.classList.toggle('sel', k === id)); },
    flyTo(id) {
      const e = labelById[id]?.e;
      if (!e) return;
      const sy = world.scale.y, close = e.kind === 'valve' ? 0.55 : 1;
      flyCam([e.x + 34 * close, (38 * sy + 10) * close, e.z + 44 * close], [e.x, e.id === 'forest' ? 8 : 2, e.z]);
    },
    focusNetwork() { flyCam([20, 46, 78], [-3, 2, 20]); },
    reset() { flyCam(VIEWS[view].p, VIEWS[view].t); },
    zoom(f) {
      tween = null;
      const off = camera.position.clone().sub(controls.target).multiplyScalar(f);
      camera.position.copy(controls.target).add(off);
    },
    CYAN, AMBER,
  };
}

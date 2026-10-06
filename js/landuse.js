// Land-use / soil permeability classification. Drives the 3D permeability layer AND the SCS-CN runoff,
// so what the map shows is exactly what the model uses. Soil groups would come from BSWM soil maps;
// the demo values are simulated.
import { Z, TOWNS, FACILITIES, PADDY_FIELDS, groundHeight, lakeE, distRoads, catchmentCells } from './terrain.js';

// CN for AMC II (USDA TR-55 style values)
export const UNITS = {
  forestB: { name: 'Upland forest', hsg: 'B', cover: 'Tropical forest, good', cn: 55 },
  forestC: { name: 'Montane forest slopes', hsg: 'C', cover: 'Forest, fair', cn: 70 },
  grass: { name: 'Grassland / shrub', hsg: 'C', cover: 'Brush, fair', cn: 74 },
  clearedB: { name: 'Cleared upland (kaingin)', hsg: 'B', cover: 'Bare / poor pasture', cn: 79 },
  clearedC: { name: 'Cleared slopes (logging)', hsg: 'C', cover: 'Bare / poor pasture', cn: 86 },
  agri: { name: 'Lowland farms', hsg: 'D', cover: 'Row crops / pasture', cn: 84 },
  paddy: { name: 'Rice paddies', hsg: 'D', cover: 'Paddy on clay', cn: 88 },
  urban: { name: 'Settlements', hsg: 'C', cover: '~65% impervious', cn: 90 },
  impervious: { name: 'Roads & facilities', hsg: '–', cover: 'Paved / roofs', cn: 98 },
};
export const UNIT_ORDER = ['forestB', 'forestC', 'grass', 'clearedB', 'clearedC', 'agri', 'paddy', 'urban', 'impervious'];

// antecedent moisture adjustment (Chow, Maidment & Mays 1988)
export function cnForAMC(cn2, amc) {
  if (amc === 'I') return (4.2 * cn2) / (10 - 0.058 * cn2);
  if (amc === 'III') return (23 * cn2) / (10 + 0.13 * cn2);
  return cn2;
}

// runoff-potential colour ramp: permeable (green) -> impervious (red)
const STOPS = [[50, [0x1a, 0x9e, 0x5a]], [65, [0x6c, 0xc0, 0x4a]], [75, [0xe8, 0xd2, 0x4a]], [85, [0xf0, 0x8a, 0x3a]], [98, [0xd9, 0x30, 0x4a]]];
export function cnColor(cn) {
  for (let i = 1; i < STOPS.length; i++) {
    if (cn <= STOPS[i][0] || i === STOPS.length - 1) {
      const [c0, a] = STOPS[i - 1], [c1, b] = STOPS[i];
      const t = Math.max(0, Math.min(1, (cn - c0) / (c1 - c0)));
      return (Math.round(a[0] + (b[0] - a[0]) * t) << 16) | (Math.round(a[1] + (b[1] - a[1]) * t) << 8) | Math.round(a[2] + (b[2] - a[2]) * t);
    }
  }
  return 0xd9304a;
}

const noise01 = (x, z) => 0.5 + 0.5 * (0.6 * Math.sin(x * 0.23 + 1.3) * Math.cos(z * 0.19 - 0.7) + 0.4 * Math.sin(x * 0.11 - z * 0.17 + 2.1));
// clearing order: patchy, lower forest edges first (typical kaingin / logging pattern)
const clearScore = (x, z, h) => 0.55 * noise01(x, z) + 0.45 * Math.min(1, Math.max(0, (h - 4) / 12));

export function classify(x, z, tau = -1) {
  if (lakeE(x, z) < 1.15) return 'water';
  for (const k of FACILITIES) if (Math.hypot(x - Z[k].x, z - Z[k].z) < Z[k].r * 0.8) return 'impervious';
  if (Math.hypot(x - Z.commercial.x, z - Z.commercial.z) < Z.commercial.r * 0.95) return 'impervious';
  for (const k of TOWNS) if (Math.hypot(x - Z[k].x, z - Z[k].z) < Z[k].r * 0.95) return 'urban';
  if (distRoads(x, z) < 0.6) return 'impervious';
  if (PADDY_FIELDS.some(([cx, cz]) => Math.abs(x - cx) < 6 && Math.abs(z - cz) < 3.5)) return 'paddy';
  const h = groundHeight(x, z);
  if (h >= 4) {
    const up = h > 9;
    if (clearScore(x, z, h) < tau) return up ? 'clearedB' : 'clearedC';
    return up ? 'forestB' : 'forestC';
  }
  return h >= 2.6 ? 'grass' : 'agri';
}

// sample the contributing catchment; `cleared` = fraction of its forest converted (0..1)
export function landUse(cleared = 0) {
  const cells = catchmentCells();
  let tau = -1;
  if (cleared > 0) {
    const scores = cells.map(([x, z]) => { const h = groundHeight(x, z); return h >= 4 ? clearScore(x, z, h) : null; }).filter(s => s !== null).sort((a, b) => a - b);
    tau = scores[Math.min(scores.length - 1, Math.floor(scores.length * cleared))];
  }
  const counts = {};
  let n = 0;
  for (const [x, z] of cells) {
    const u = classify(x, z, tau);
    if (u === 'water') continue;
    counts[u] = (counts[u] || 0) + 1;
    n++;
  }
  const fractions = Object.fromEntries(UNIT_ORDER.map(u => [u, (counts[u] || 0) / n]));
  const cn2 = UNIT_ORDER.reduce((s, u) => s + fractions[u] * UNITS[u].cn, 0);
  const forest = fractions.forestB + fractions.forestC, lost = fractions.clearedB + fractions.clearedC;
  return { cleared, tau, fractions, cn2, forestCover: forest, clearedArea: lost, forestLossPct: lost / Math.max(1e-6, forest + lost) * 100 };
}

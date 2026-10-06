// Watershed water-availability simulation (scenario-driven demo; no live data).
//   1. SCS Curve Number: rainfall P -> direct runoff Q, per land unit (permeability / infiltration class)
//   2. Raw-water reservoir balance: dV/dt = baseflow + runoff + intake inflow - treatment withdrawal - evaporation - spill
//   3. Treatment -> treated-water storage: dT/dt = treated production - distribution pumping
//   4. Distribution: treated storage -> Pump A / B / C -> valves -> service areas; supply vs demand per area
// Topology (simulated digital-twin infrastructure; it does not depict any real water utility's system):
//   sources -> intake / raw reservoir -> WTP -> treated storage -> Pump A/B/C -> Service Area A/B/C
// A data-driven (ML) correction is PLANNED, not implemented: forecasts are physics-only.

import { landUse, UNITS, UNIT_ORDER, cnForAMC } from './landuse.js';
import { operationalCatchmentKm2 } from './terrain.js';

export const CAP = 100000;          // overflow threshold (m³)
export const CRIT = 90000;          // flood buffer (m³)
export const LOW = 15000;           // critical level (m³)
export const DEAD = 5000;           // raw-reservoir dead storage: treatment cannot draw below this (m³)
export const ROT_FACTOR = 0.45;     // share of demand delivered while pump rotation (rationing) is active
export const BLOCK_H = 4;
// operational contributing area (km²): simulated Phase 1 value unless a VALIDATED DEM-derived (or VERIFIED GIS) contributing
// catchment is loaded. Only this area generates runoff; the study-area reserve never adds to it.
export const catchmentKm2 = () => operationalCatchmentKm2();
export const SURFACE_M2 = 60000;    // reservoir surface area at full supply
export const COM_BASE = 90;         // commercial demand (m³/h, daily mean)
export const SUPPLY_HORIZON_H = 168; // usable storage spread over 7 days when estimating available supply
export const INTERLOCK_S = 8;       // seconds a pump may run against its closed discharge valve
// Scripted Pump A runtime-limit shutdown (an old demo of failover). Off: failover is shown with "Fail Pump A (simulate)".
export const DEMO_AUTO_SHUTDOWN = false;
// treatment & treated-water storage (simulated sizing)
export const WTP_CAP = 720;         // treatment capacity (m³/h), above total distribution pump rating (700) so treatment never bottlenecks pumping
export const TWS_CAP = 3000;        // treated-water storage (clear well + ground tank), m³ (~10 h of mean demand)
export const TWS_DEAD = 300;        // distribution pumps cannot draw below this (m³)
export const TWS_SET = 2700;        // WTP level control refills treated storage toward this level (90%)
const HOUR = 3.6e6;
const BASEFLOW_REF = 365;
const PEAK = 1.18;                  // diurnal peak-hour demand factor

// Residential sub-areas (household demand), simulated and neutrally named. Zone = the service area / pump that normally supplies it.
export const AREAS = [
  { name: 'Area C-1', ent: 'poblacion', zone: 'C', base: 1500, households: 3600 },
  { name: 'Area A-1', ent: 'residential', zone: 'A', base: 1200, households: 2900 },
  { name: 'Area B-1', ent: 'divisoria', zone: 'B', base: 900, households: 2200 },
  { name: 'Area C-2', ent: 'mabini', zone: 'C', base: 800, households: 1900 },
  { name: 'Area A-2', ent: 'rizal', zone: 'A', base: 600, households: 1400 },
];
const HH_DAY = AREAS.reduce((s, a) => s + a.base, 0);
export const HH_BASE = HH_DAY / 24;                      // household demand (m³/h, daily mean)
export const HOUSEHOLDS = AREAS.reduce((s, a) => s + a.households, 0);
export const ZONE_SHARE = Object.fromEntries(['A', 'B', 'C'].map(z => [z, AREAS.filter(a => a.zone === z).reduce((s, a) => s + a.base, 0) / HH_DAY]));
export const ZONES = {
  A: { name: 'Service Area A', label: 'Residential A-1 · A-2', pump: 'PUMP-01', backup: 'PUMP-02' },
  B: { name: 'Service Area B', label: 'Residential B-1 · Commercial', pump: 'PUMP-02', backup: 'PUMP-01' },
  C: { name: 'Service Area C', label: 'Residential C-1 · C-2', pump: 'PUMP-03', backup: null },
};

// Conceptual network (single source of truth for the topology). Water state on every link: raw or treated.
// Intake / collection = river intake + raw-water reservoir. Every distribution pump draws from the SAME treated storage.
export const NETWORK = {
  sources: [
    { id: 'SRC-WATERSHED', name: 'Watershed runoff + baseflow', water: 'raw' },
    { id: 'SRC-RIVER', name: 'River (intake)', water: 'raw' },
  ],
  intake: { id: 'INTAKE-01', name: 'River intake', water: 'raw' },
  rawStorage: { id: 'RES-01', name: 'Raw-water reservoir', water: 'raw', capacity: CAP, dead: DEAD },
  treatmentPlant: { id: 'WTP-01', name: 'Water treatment plant', capacity: WTP_CAP },
  treatedStorage: { id: 'TWS-01', name: 'Treated water storage', water: 'treated', capacity: TWS_CAP, dead: TWS_DEAD },
  pumps: {
    'PUMP-01': { label: 'A', source: 'TWS-01', serviceAreas: ['A'], backupFor: ['B'], valve: 'IVA' },
    'PUMP-02': { label: 'B', source: 'TWS-01', serviceAreas: ['B'], backupFor: ['A'], valve: 'IVB' },
    'PUMP-03': { label: 'C', source: 'TWS-01', serviceAreas: ['C'], backupFor: [], valve: null },
  },
  serviceAreas: { A: { pump: 'PUMP-01', backup: 'PUMP-02' }, B: { pump: 'PUMP-02', backup: 'PUMP-01' }, C: { pump: 'PUMP-03', backup: null } },
  // [from, to, water, note]
  connections: [
    ['SRC-WATERSHED', 'RES-01', 'raw', 'streams / runoff'], ['SRC-RIVER', 'INTAKE-01', 'raw'], ['INTAKE-01', 'RES-01', 'raw'],
    ['RES-01', 'WTP-01', 'raw', 'raw-water main'], ['WTP-01', 'TWS-01', 'treated'],
    ['TWS-01', 'PUMP-01', 'treated', 'distribution header'], ['TWS-01', 'PUMP-02', 'treated', 'distribution header'], ['TWS-01', 'PUMP-03', 'treated', 'distribution header'],
    ['PUMP-01', 'AREA-A', 'treated', 'via IV-A'], ['PUMP-02', 'AREA-B', 'treated', 'via IV-B'], ['PUMP-03', 'AREA-C', 'treated'],
    ['PUMP-01', 'AREA-B', 'treated', 'backup via XV-1/XV-2'], ['PUMP-02', 'AREA-A', 'treated', 'backup via XV-1/XV-2'],
  ],
};

// Philippine (Eastern Samar, Type II climate) scenarios. Evaporation in mm/day, rainfall P in mm/day.
// amc = antecedent moisture condition applied to every land unit's curve number
export const SCEN = {
  dry: { label: 'Dry Season (El Niño)', rain: 0, P: 0.3, amc: 'I', base: 40, pumpIn: 40, evap: 6.5, dmd: 1.15, storm: false, temp: 34, wx: 'Hot & Dry · El Niño', unc: 1.2 },
  light: { label: 'Light Rain', rain: 1, P: 12, amc: 'II', base: 365, pumpIn: 60, evap: 4.5, dmd: 1.0, storm: false, temp: 29, wx: 'Light Rain · Easterlies', unc: 1 },
  moderate: { label: 'Monsoon Rain (Amihan)', rain: 2, P: 80, amc: 'III', base: 520, pumpIn: 40, evap: 3, dmd: 0.97, storm: true, temp: 27, wx: 'Amihan Monsoon Rain', unc: 1.3 },
  heavy: { label: 'Typhoon', rain: 3, P: 220, amc: 'III', base: 650, pumpIn: 0, evap: 2, dmd: 0.9, storm: true, temp: 25, wx: 'Typhoon · TCWS No. 3', unc: 1.7 },
};

// PAGASA-style rainfall warning level from 24 h accumulation (heuristic for the demo)
export function rainWarning(P) {
  if (P >= 200) return { level: 'Red', color: '#ff4d57' };
  if (P >= 100) return { level: 'Orange', color: '#ff9f43' };
  if (P >= 50) return { level: 'Yellow', color: '#f5c542' };
  return null;
}

// Planned, not implemented: needs historical gauge + SCADA data to train and validate.
export const PLANNED_ML = {
  name: 'XGBoost residual correction',
  features: ['rainfall_72h', 'antecedent_runoff', 'reservoir_level', 'demand_lag24', 'evaporation', 'day_of_year', 'pump_status'],
};

export const ROT_GROUPS = [
  { name: 'Group A', areas: ['Area C-1', 'Area C-2'], ents: ['poblacion', 'mabini'], pump: 'PUMP-03' },
  { name: 'Group B', areas: ['Area A-1', 'Area A-2'], ents: ['residential', 'rizal'], pump: 'PUMP-01' },
  { name: 'Group C', areas: ['Area B-1', 'Commercial Zone'], ents: ['commercial', 'divisoria'], pump: 'PUMP-02' },
];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const localH = t => (t - new Date(t).getTimezoneOffset() * 60000) / HOUR;
export const rotGroupAt = t => Math.floor(localH(t) / BLOCK_H) % ROT_GROUPS.length;
export const rotBlockEnd = t => t + (BLOCK_H - (localH(t) % BLOCK_H)) * HOUR;
export function rotNextStart(t, g) {
  let s = rotBlockEnd(t);
  while (rotGroupAt(s + 1000) !== g) s += BLOCK_H * HOUR;
  return s;
}

// auto mode latches on below the threshold and releases 5,000 m³ above it
export function rotUpdate(mode, v, latched, thr) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  if (v < thr) return true;
  if (v > thr + 5000) return false;
  return latched;
}

export function scsRunoff(P, cn) {
  const S = 25400 / cn - 254, Ia = 0.2 * S;
  return { S, Ia, Q: P > Ia ? (P - Ia) ** 2 / (P - Ia + S) : 0 };
}

// distributed SCS-CN: runoff per land unit, then area-weighted (avoids composite-CN bias from impervious areas)
export function catchmentRunoff(P, amc, lu) {
  let Q = 0, cnEff = 0;
  const units = [];
  for (const u of UNIT_ORDER) {
    const f = lu.fractions[u];
    if (f <= 0) continue;
    const cn = cnForAMC(UNITS[u].cn, amc);
    const q = scsRunoff(P, cn).Q;
    Q += f * q; cnEff += f * cn;
    units.push({ u, f, cn2: UNITS[u].cn, cn, Q: q });
  }
  const { S: Smax, Ia } = scsRunoff(P, cnEff);
  return { Q, cnEff, Smax, Ia, units };
}

export function setForestClearing(S, frac) {
  S.lu = landUse(frac);
  refresh(S);
}

function rainfall(S, t) {
  const sc = SCEN[S.scenario];
  const h = (t - S.scenarioT0) / HOUR;
  if (h < 0) return SCEN.light.P;
  if (!sc.storm) return sc.P;
  const pulse = h < 3 ? h / 3 : h < 30 ? 1 : h < 80 ? 1 - (h - 30) / 50 : 0;
  return SCEN.light.P * (1 - pulse) + sc.P * pulse;
}

const scenRamp = (S, t) => Math.min(1, Math.max(0, (t - S.scenarioT0) / HOUR) / 6);
function demandFactor(S, t, diurnal = true) {
  const sc = SCEN[S.scenario];
  const di = diurnal ? 1 + 0.18 * Math.sin(((localH(t) % 24) - 7) / 24 * 2 * Math.PI) : 1;
  return di * (1 + (sc.dmd - 1) * scenRamp(S, t));
}
function zoneDemand(S, t, diurnal = true, peak = 1) {
  const f = demandFactor(S, t, diurnal) * peak;
  const hh = HH_BASE * f, com = COM_BASE * f * (S.scenario === 'heavy' ? 0.85 : 1);
  return { hh, com, d: { A: hh * ZONE_SHARE.A, B: hh * ZONE_SHARE.B + com, C: hh * ZONE_SHARE.C } };
}

// ---------- distribution network: treated storage -> Pump A / Pump B (+ A/B cross-connection), Pump C ----------
export const VALVES = {
  IVA: { name: 'IV-A', type: 'Isolation valve · Pipe A', normal: true, pump: 'PUMP-01' },
  IVB: { name: 'IV-B', type: 'Isolation valve · Pipe B', normal: true, pump: 'PUMP-02' },
  XV1: { name: 'XV-1', type: 'Cross-connection valve (Pipe A side)', normal: false },
  XV2: { name: 'XV-2', type: 'Cross-connection valve (Pipe B side)', normal: false },
};

export function networkState(S) {
  const [pa, pb] = S.pumps, v = S.valves;
  const A = pa.status === 'running', B = pb.status === 'running';
  const aOut = A && v.IVA, bOut = B && v.IVB, cross = v.XV1 && v.XV2;
  const areaA = aOut ? 'A' : cross && bOut ? 'B' : null;
  const areaB = bOut ? 'B' : cross && aOut ? 'A' : null;
  return { A, B, aOut, bOut, cross, areaA, areaB, flow: areaA === 'B' ? 'BtoA' : areaB === 'A' ? 'AtoB' : null };
}

// valve positions the automatic controller drives towards
export function autoValveTarget(S) {
  const A = S.pumps[0].status === 'running', B = S.pumps[1].status === 'running';
  if (A && B) return { IVA: true, IVB: true, XV1: false, XV2: false };
  if (!A && B) return { IVA: false, IVB: true, XV1: true, XV2: true };
  if (A && !B) return { IVA: true, IVB: false, XV1: true, XV2: true };
  return { IVA: false, IVB: false, XV1: false, XV2: false };
}

// Water that may be withdrawn per hour over a step of dtH hours: what flows in, plus storage above dead storage.
// Raw reservoir -> treatment uses DEAD; treated storage -> distribution pumps uses TWS_DEAD.
export const withdrawable = (v, freeIn, dtH = 1, dead = DEAD) => Math.max(0, freeIn) + Math.max(0, v - dead) / dtH;

// WTP level control: treat what the pumps want plus a refill toward TWS_SET, within treatment capacity and the raw
// water available above raw dead storage. Treated storage therefore never overflows (tv' <= TWS_SET when pumps get all).
export function treatment(v, tv, rawFreeIn, want, dtH = 1) {
  const wanted = Math.min(WTP_CAP, Math.max(0, want + (TWS_SET - tv) / dtH));
  const rawAvail = withdrawable(v, rawFreeIn, dtH);
  return { treat: Math.min(wanted, rawAvail), wanted, rawAvail, rawLimited: rawAvail < wanted };
}

// Route zone demands (m³/h) through the pumps. Each pump shares its rated flow across the zones it can reach,
// and total pumping is capped by the water withdrawable from TREATED storage (never below TWS_DEAD).
// v / freeIn here are the treated-storage volume and the treated production flowing into it.
function allocate(S, d, rf, v, freeIn, dtH = 1) {
  const nw = networkState(S), [, , p3] = S.pumps;
  const reach = { 'PUMP-01': [], 'PUMP-02': [], 'PUMP-03': [] };
  if (nw.areaA) reach[nw.areaA === 'A' ? 'PUMP-01' : 'PUMP-02'].push('A');
  if (nw.areaB) reach[nw.areaB === 'A' ? 'PUMP-01' : 'PUMP-02'].push('B');
  if (p3.status === 'running') reach['PUMP-03'].push('C');
  const target = { A: d.A * rf, B: d.B * rf, C: d.C * rf };
  const del = { A: 0, B: 0, C: 0 }, cap = { A: 0, B: 0, C: 0 }, loads = {};
  for (const p of S.pumps) {
    const zs = reach[p.id];
    const tot = zs.reduce((s, z) => s + target[z], 0), dtot = zs.reduce((s, z) => s + d[z], 0);
    loads[p.id] = Math.min(p.flow, tot);
    zs.forEach(z => { del[z] = tot > 0 ? loads[p.id] * target[z] / tot : 0; cap[z] = dtot > 0 ? p.flow * d[z] / dtot : 0; });
  }
  let pumpOut = loads['PUMP-01'] + loads['PUMP-02'] + loads['PUMP-03'];
  const want = pumpOut;
  const limit = typeof freeIn === 'function' ? freeIn(want) : withdrawable(v, freeIn, dtH, TWS_DEAD);
  const storageLimited = pumpOut > limit;
  if (storageLimited) {
    const f = limit / pumpOut;
    Object.keys(loads).forEach(k => (loads[k] *= f));
    Object.keys(del).forEach(z => (del[z] *= f));
    pumpOut = limit;
  }
  return { nw, target, del, cap, loads, pumpOut, storageLimited, want };
}

export function model(S, t, v, rot, dtH = 1, tv = S.treated) {
  const sc = SCEN[S.scenario];
  const P = rainfall(S, t);
  const { Q, cnEff, Smax, Ia, units } = catchmentRunoff(P, sc.amc, S.lu);
  const runoff = Q * catchmentKm2() * 1000 / 24;
  // cleared forest infiltrates less, so groundwater recharge and baseflow drop
  const base = (BASEFLOW_REF + (sc.base - BASEFLOW_REF) * scenRamp(S, t)) * (1 - 0.6 * S.lu.clearedArea);
  const { hh, com, d } = zoneDemand(S, t);
  const rf = rot ? ROT_FACTOR : 1;
  const pumpIn = S.intakeOn ? sc.pumpIn : 0;
  const evap = sc.evap / 1000 * SURFACE_M2 * Math.pow(Math.max(v, 0) / CAP, 2 / 3) / 24;
  const inflow = base + runoff;
  const freeIn = Math.max(0, inflow + pumpIn - evap);
  // raw reservoir -> WTP -> treated storage -> pumps: treatment follows pump demand, pumps are capped by treated water
  let tr = null;
  const al = allocate(S, d, rf, tv, want => { tr = treatment(v, tv, freeIn, want, dtH); return withdrawable(tv, tr.treat, dtH, TWS_DEAD); }, dtH);
  const demand = hh + com, target = demand * rf;
  const net = inflow + pumpIn - tr.treat - evap;              // raw-reservoir balance (treatment is its only withdrawal)
  const netT = tr.treat - al.pumpOut;                          // treated-storage balance
  return {
    P, cn: cnEff, amc: sc.amc, units, Smax, Ia, Q, runoff, base, inflow, pumpIn, hh, com, demand, target,
    treat: tr.treat, treatLimited: tr.rawLimited, netT,
    pumpOut: al.pumpOut, unserved: Math.max(0, target - al.pumpOut), rationed: demand - target, evap, net, rot,
    d, del: al.del, nw: al.nw, loads: al.loads, storageLimited: al.storageLimited,
  };
}

// Advance the raw reservoir: overflow leaves through the spillway, and treatment stops at dead storage
// (both tracked, nothing created or deleted). curtail = raw withdrawal that could not be taken (m³).
export function integrate(v, m, dtH) {
  let nv = v + m.net * dtH, spill = 0, curtail = 0;
  if (nv > CAP) { spill = nv - CAP; nv = CAP; }
  const floor = Math.min(v, DEAD);
  if (nv < floor) { curtail = Math.min(floor - nv, m.treat * dtH); nv += curtail; }
  return { v: Math.max(0, nv), spill, curtail };
}

// Advance treated storage with the treatment actually delivered (rawCurtail m³ less than planned); pumps stop at
// TWS_DEAD. curtail = distribution pumping that could not be delivered (m³).
export function integrateTreated(tv, m, dtH, rawCurtail = 0) {
  let nt = tv + (m.treat - m.pumpOut) * dtH - rawCurtail, curtail = 0;
  const floor = Math.min(tv, TWS_DEAD);
  if (nt < floor) { curtail = Math.min(floor - nt, m.pumpOut * dtH); nt += curtail; }
  return { tv: Math.min(TWS_CAP, Math.max(0, nt)), curtail };
}

// water the system can release per hour: what flows in, plus usable raw storage spread over the supply horizon,
// limited by treatment capacity (only treated water is distributed)
export const releaseRate = (v, m) => Math.min(WTP_CAP, Math.max(0, m.inflow + m.pumpIn - m.evap) + Math.max(0, v - DEAD) / SUPPLY_HORIZON_H);

// policy=false: no pump rotation (counterfactual)
export function forecast(S, hours = 168, { policy = true } = {}) {
  const u = SCEN[S.scenario].unc;
  let v = S.volume, tv = S.treated, rot = policy && S.rotActive;
  const m0 = model(S, S.t, v, rot, 1, tv);
  const out = [{ h: 0, t: S.t, v, tv, lo: v, hi: v, rot, m: m0, spill: 0, curtail: 0, sup: releaseRate(v, m0) / m0.demand }];
  for (let h = 1; h <= hours; h++) {
    const t = S.t + h * HOUR;
    rot = policy ? rotUpdate(S.rotMode, v, rot, S.rotThr) : false;
    const m = model(S, t, v, rot, 1, tv);
    const r = integrate(v, m, 1), rt = integrateTreated(tv, m, 1, r.curtail);
    v = r.v; tv = rt.tv;
    const band = 0.006 * u * Math.sqrt(h);
    out.push({ h, t, v, tv, lo: Math.max(0, v * (1 - band)), hi: Math.min(CAP * 1.02, v * (1 + band)), rot, m, spill: r.spill, curtail: rt.curtail, sup: releaseRate(v, m) / m.demand });
  }
  out.firstAbove = lvl => { const f = out.find(p => p.v >= lvl); return f ? f.h : null; };
  out.firstBelow = lvl => { const f = out.find(p => p.v < lvl); return f ? f.h : null; };
  out.peak = () => Math.max(...out.map(p => p.v));
  out.min = () => Math.min(...out.map(p => p.v));
  // totals over the first H hours (m³): rainfall on the catchment, runoff, total inflow, spill, unserved
  out.totals = (H = 72) => out.slice(1, H + 1).reduce((a, p) => {
    a.rain += p.m.P / 24 * catchmentKm2() * 1000; a.runoff += p.m.runoff; a.inflow += p.m.inflow + p.m.pumpIn;
    a.spill += p.spill; a.unserved += p.m.unserved + p.curtail; return a;
  }, { rain: 0, runoff: 0, inflow: 0, spill: 0, unserved: 0 });
  return out;
}

// Supply vs demand per service area (daily means, current state). "Supply" = what the system can deliver to the
// area per day: the smaller of its pump capacity share and its share of releasable water.
export function serviceAreas(S) {
  const m = S.m, rf = S.rotActive ? ROT_FACTOR : 1;
  const { d, com } = zoneDemand(S, S.t, false);
  const freeIn = Math.max(0, m.inflow + m.pumpIn - m.evap);
  // same chain as the model: pumps draw treated water; treatment follows demand within raw availability
  const fromTreated = want => withdrawable(S.treated, treatment(S.volume, S.treated, freeIn, want).treat, 1, TWS_DEAD);
  const al = allocate(S, d, rf, S.treated, fromTreated);
  const peak = allocate(S, zoneDemand(S, S.t, false, PEAK).d, rf, S.treated, fromTreated);
  const R = releaseRate(S.volume, m), D = d.A + d.B + d.C;
  const p3 = S.pumps[2].status === 'running';
  const zones = {};
  for (const z of ['A', 'B', 'C']) {
    const water = R * d[z] / D, supply = Math.min(al.cap[z], water);
    const supplier = z === 'C' ? (p3 ? 'C' : null) : z === 'A' ? al.nw.areaA : al.nw.areaB;
    const ratio = supplier ? supply / d[z] : 0;
    zones[z] = {
      ...ZONES[z], z, demand: d[z] * 24, supply: supplier ? supply * 24 : 0, delivered: al.del[z] * 24, unserved: (d[z] - al.del[z]) * 24, ratio,
      status: !supplier ? 'none' : ratio >= 1.1 ? 'surplus' : ratio >= 0.95 ? 'balanced' : 'shortage',
      limit: al.cap[z] <= water ? 'pump capacity' : 'available water', supplier, viaBackup: !!supplier && z !== 'C' && supplier !== z,
      peakDeficit: Math.max(0, peak.target[z] - peak.del[z]),
    };
  }
  const dm = demandFactor(S, S.t, false);
  const rows = AREAS.map(a => ({ ...a, demand: a.base * dm })).concat([{ name: 'Commercial Zone', ent: 'commercial', zone: 'B', households: 0, establishments: 126, demand: com * 24 }])
    .map(r => {
      const zn = zones[r.zone], share = r.demand / zn.demand;
      return { ...r, supply: zn.supply * share, delivered: zn.delivered * share, unserved: r.demand - zn.delivered * share, ratio: zn.ratio, status: zn.status, pump: ZONES[r.zone].pump, backup: ZONES[r.zone].backup, supplier: zn.supplier, viaBackup: zn.viaBackup };
    });
  const tot = ['demand', 'supply', 'delivered'].reduce((o, k) => ({ ...o, [k]: Object.values(zones).reduce((s, zn) => s + zn[k], 0) }), {});
  return { zones, rows, ...tot, ratio: tot.supply / tot.demand, peakDeficit: Object.values(zones).reduce((s, zn) => s + zn.peakDeficit, 0) };
}

// How much of Area A + B peak demand one pump can carry alone. N+1 is only claimed when cover >= 100%.
export function backupCoverage(S) {
  const sc = SCEN[S.scenario];
  const hh = HH_BASE * sc.dmd * PEAK, com = COM_BASE * sc.dmd * PEAK * (S.scenario === 'heavy' ? 0.85 : 1);
  const need = hh * (ZONE_SHARE.A + ZONE_SHARE.B) + com;
  const rated = S.pumps[1].flow;
  return { need, rated, covered: Math.min(rated, need), unserved: Math.max(0, need - rated), cover: Math.min(1, rated / need), nPlus1: rated >= need };
}

function makeHistory(t, volume, rng) {
  const arr = [];
  let v = volume;
  for (let i = 0; i <= 72; i++) {
    arr.unshift({ t: t - i * 30 * 60000, v });
    v -= (125 + (rng() - 0.5) * 140) * 0.5;
  }
  return arr;
}

function makeDemandHistory(rng, t) {
  const days = [];
  for (let d = 29; d >= 0; d--) {
    const dt = new Date(t - d * 86400000);
    const wk = dt.getDay() === 0 || dt.getDay() === 6;
    days.push({
      t: dt.getTime(),
      hh: Math.round(HH_DAY * (1 + 0.08 * Math.sin(d * 2 * Math.PI / 7) + (wk ? 0.06 : 0) + (rng() - 0.5) * 0.12)),
      com: Math.round(COM_BASE * 24 * (1 + (wk ? -0.18 : 0.07) + (rng() - 0.5) * 0.16)),
    });
  }
  return days;
}

export function initialState(rng) {
  const t = Date.now();
  const S = {
    t, volume: 68420, treated: TWS_SET, scenario: 'light', scenarioT0: t,
    rotMode: 'auto', rotThr: 35000, rotActive: false, intakeOn: true,
    pumps: [
      { id: 'PUMP-01', name: 'Distribution Pump A', short: 'Pump A', zone: 'A', iv: 'IVA', status: 'running', flow: 240, q: 0, runtime: 3 * 3600 + 42 * 60 + 18, shutdownMin: DEMO_AUTO_SHUTDOWN ? 18 : null, deadhead: 0, flowHist: [], serves: 'Service Area A: A-1, A-2' },
      { id: 'PUMP-02', name: 'Distribution Pump B', short: 'Pump B', zone: 'B', iv: 'IVB', status: 'running', flow: 240, q: 0, runtime: 1 * 3600 + 24 * 60 + 12, shutdownMin: null, deadhead: 0, flowHist: [], serves: 'Service Area B: B-1, Commercial' },
      { id: 'PUMP-03', name: 'Distribution Pump C', short: 'Pump C', zone: 'C', iv: null, status: 'running', flow: 220, q: 0, runtime: 6 * 3600 + 5 * 60, shutdownMin: null, deadhead: 0, flowHist: [], serves: 'Service Area C: C-1, C-2' },
    ],
    valves: { IVA: true, IVB: true, XV1: false, XV2: false },
    valveMode: 'auto',
    areas: AREAS.map(a => ({ ...a, v: a.base })),
    p1ShutdownAt: null, spilling: false, spillRate: 0, spillTotal: 0, curtailed: 0, curtailedT: 0, lastTrip: null,
    lu: landUse(0),
  };
  S.hist = makeHistory(t, S.volume, rng);
  S.cons = makeDemandHistory(rng, t);
  refresh(S);
  S.pumps.forEach(p => { for (let i = 0; i < 24; i++) p.flowHist.push(p.q * (1 + (rng() - 0.5) * 0.06)); });
  return S;
}

function syncDerived(S, rng) {
  S.pumps.forEach(p => { p.q = p.status === 'running' ? S.m.loads[p.id] : 0; });
  S.svc = serviceAreas(S);
  // barangay water use = what is actually delivered (respects outages and rotation)
  S.areas.forEach(a => {
    const row = S.svc.rows.find(r => r.name === a.name);
    a.v = row.delivered * (1 + (rng ? (rng() - 0.5) * 0.006 : 0));
  });
}

export function step(S, dtH, rng) {
  S.rotActive = rotUpdate(S.rotMode, S.volume, S.rotActive, S.rotThr);
  const m = model(S, S.t + dtH * HOUR / 2, S.volume, S.rotActive, dtH);
  S.mStep = m;
  const r = integrate(S.volume, { ...m, net: m.net + (rng() - 0.5) * 20 }, dtH);
  const rt = integrateTreated(S.treated, m, dtH, r.curtail);
  S.volume = r.v;
  S.treated = rt.tv;
  S.curtailedT = rt.curtail / dtH;
  S.spillRate = r.spill / dtH;
  S.spillTotal += r.spill;
  S.spilling = r.spill > 0;
  S.curtailed = r.curtail / dtH;
  S.t += dtH * HOUR;
  S.rotActive = rotUpdate(S.rotMode, S.volume, S.rotActive, S.rotThr);
  S.m = model(S, S.t, S.volume, S.rotActive);
  syncDerived(S, rng);
  S.hist.push({ t: S.t, v: S.volume });
  if (S.hist.length > 600) S.hist.shift();
  S.pumps.forEach(p => {
    p.flowHist.push(p.q * (1 + (rng() - 0.5) * 0.07));
    if (p.flowHist.length > 24) p.flowHist.shift();
  });
}

export function refresh(S) {
  S.rotActive = rotUpdate(S.rotMode, S.volume, S.rotActive, S.rotThr);
  S.m = model(S, S.t, S.volume, S.rotActive);
  syncDerived(S);
}

export function setRotation(S, mode) { S.rotMode = mode; refresh(S); }
export function setScenario(S, key) { S.scenario = key; S.scenarioT0 = S.t; refresh(S); }

export function pumpStart(S, id) {
  const p = S.pumps.find(x => x.id === id);
  if (p.status === 'failed') return false;
  p.status = 'running'; p.runtime = 0; p.deadhead = 0;
  if (id === 'PUMP-01') p.shutdownMin = null;
  if (S.lastTrip?.id === id) S.lastTrip = null;
  refresh(S);
  return true;
}
export function pumpStop(S, id) {
  const p = S.pumps.find(x => x.id === id);
  if (p.status === 'failed') return;
  p.status = 'standby'; p.shutdownMin = null;
  refresh(S);
}
export function failPump(S, id) {
  const p = S.pumps.find(x => x.id === id);
  p.status = 'failed'; p.shutdownMin = null; p.runtime = 0; p.failedAt = S.t;
  refresh(S);
}
export function repairPump(S, id) {
  const p = S.pumps.find(x => x.id === id);
  p.status = 'running'; p.runtime = 0; p.failedAt = null; p.deadhead = 0;
  refresh(S);
}
export function setValve(S, id, open) { S.valves[id] = open; refresh(S); }

// 1 Hz clock: runtimes, dead-head interlock, and (only if DEMO_AUTO_SHUTDOWN) the PUMP-01 scripted shutdown
export function clockTick(S, n) {
  const events = [];
  S.pumps.forEach(p => {
    if (p.status === 'running') p.runtime += 1;
    // interlock: a pump running against its own closed discharge valve trips after INTERLOCK_S seconds
    if (p.iv && p.status === 'running' && !S.valves[p.iv]) {
      p.deadhead += 1;
      if (p.deadhead >= INTERLOCK_S) {
        p.status = 'standby'; p.deadhead = 0; p.shutdownMin = null;
        S.lastTrip = { id: p.id, valve: p.iv, t: S.t };
        events.push('trip-' + p.id);
      }
    } else p.deadhead = 0;
  });
  const p1 = S.pumps[0];
  if (DEMO_AUTO_SHUTDOWN && p1.status === 'running' && p1.shutdownMin !== null && n % 6 === 0) {
    p1.shutdownMin -= 1;
    if (p1.shutdownMin <= 0) {
      p1.status = 'standby'; p1.shutdownMin = null; p1.runtime = 0;
      S.p1ShutdownAt = S.t;
      events.push('PUMP-01');
    }
  }
  if (events.length) refresh(S);
  return events;
}

import { createScene } from './scene.js';
import * as sim from './sim.js';
import { forecastChart, consumptionChart, levelGauge, spark, THRESHOLDS, lineSample } from './charts.js';
import { UNITS, cnColor } from './landuse.js';
import { loadStudyArea } from './studyarea.js';

// study area (name + GIS boundary + hydrological area) must be active before the simulation starts
const SA = await loadStudyArea();

const { CAP, CRIT, LOW, DEAD, SCEN, ROT_GROUPS, ZONES, PLANNED_ML } = sim;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => Math.round(n).toLocaleString('en-US');
const sgn = n => (n >= 0 ? '+' : '−') + fmt(Math.abs(n));
const pctf = r => `${Math.round(r * 100)}%`;
const clamp01 = x => Math.max(0, Math.min(1, x));

// Top-bar question chips ("1 · Do we have enough water?" …). Hidden, not deleted: renderQuestions() keeps
// updating them, so setting this to true brings them back unchanged.
const SHOW_QUESTIONS = false;
$('#questions').hidden = !SHOW_QUESTIONS;
$('.topbar').classList.toggle('noq', !SHOW_QUESTIONS);
const short = n => n.replace('Brgy. ', '');
const rng = sim.mulberry32(42);
const S = sim.initialState(rng);

// ---------- mobile layout ----------
// Kill switch: false = the app behaves exactly as before (scaled 1600x900 canvas, no mobile styles).
// Mobile mode = portrait phones, small tablets and landscape phones; it switches live on resize / rotation.
const ENABLE_MOBILE_LAYOUT = true;
// Desktop only: collapse the sidebar to an icon rail that expands on hover / keyboard focus (overlay, no layout shift).
// Set to false for the classic always-open sidebar. Mobile mode never uses it.
const SIDEBAR_HOVER = true;
const MOBILE_MQ = matchMedia('(max-width: 820px), (max-height: 500px)');
let isMobile = ENABLE_MOBILE_LAYOUT && MOBILE_MQ.matches;
document.documentElement.classList.toggle('mobile', isMobile);

// render on a 1600x900 design canvas and scale it to fill any window (desktop); mobile is a normal vertical flow
function fitToWindow() {
  if (isMobile) { const a = $('.app'); a.style.width = a.style.height = a.style.transform = ''; return; }
  const s = Math.max(0.55, Math.min(1.2, innerWidth / 1600, innerHeight / 900));
  const app = $('.app');
  app.style.width = innerWidth / s + 'px';
  app.style.height = innerHeight / s + 'px';
  app.style.transform = `scale(${s})`;
}
fitToWindow();
addEventListener('resize', fitToWindow);

const gl = createScene($('#gl'), $('#labels'), { onSelect: id => select(id) });
// layers whose checkbox starts unchecked start hidden; DEM rows are hidden when no hydrology data is loaded
$$('.layers .hy').forEach(el => { el.hidden = !SA.hydro; });
$$('[data-layer]').forEach(i => { if (i.dataset.layer !== 'perm' && !i.checked) gl.setLayer(i.dataset.layer, false); });

// ---------- collapsible panels ----------
// In memory only (no storage): every reload starts from PANEL_DEFAULTS, so the demo always opens the same way.
// true = open. Collapsed panels in a side-by-side row shrink to a 40 px strip; in the right-hand stack they shrink to
// their header bar. Either way the neighbours take the space. At least one panel per row always stays open.
const PANEL_DEFAULTS = {
  'p-map': true, 'p-predictive': true, 'p-status': true,                          // top row
  'p-consumption': false, 'p-areas': true, 'p-pumps': true, 'p-alerts': true,     // bottom row
  layers: false,      // Layers list over the map (collapsed = one "Layers" button)
  details: false,     // scenario panel: 5-step chain + model inputs strip
};
const PANEL_ROWS = [['p-map', 'p-predictive', 'p-status'], ['p-consumption', 'p-areas', 'p-pumps', 'p-alerts']];
const PANEL_NAMES = { 'p-map': 'map', 'p-predictive': 'scenario panel', 'p-status': 'Water Availability', 'p-consumption': 'Water Demand', 'p-areas': 'Supply vs Demand by Area', 'p-pumps': 'Water Distribution', 'p-alerts': 'Decision Support' };
const panelOpen = { ...PANEL_DEFAULTS };
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
PANEL_ROWS.flat().forEach(id => {
  const p = document.getElementById(id), head = p.querySelector(id === 'p-map' ? '.map-title' : '.ph');
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'ptoggle'; b.setAttribute('aria-controls', id); b.innerHTML = CHEVRON;
  b.addEventListener('click', e => { e.stopPropagation(); togglePanel(id); });
  head.appendChild(b);
});
function togglePanel(id, open = !panelOpen[id]) {
  if (open === panelOpen[id]) return;
  if (!open && !isMobile && PANEL_ROWS.find(r => r.includes(id)).filter(x => panelOpen[x]).length === 1) { toast('At least one panel in each row stays open'); return; }
  panelOpen[id] = open;
  applyPanels();
  update();                          // reopened panels show current data at once (charts redraw at their new size)
}
function applyPanels() {
  const rightClosed = !panelOpen['p-predictive'] && !panelOpen['p-status'];
  for (const row of PANEL_ROWS) for (const id of row) {
    const p = document.getElementById(id), open = panelOpen[id], b = p.querySelector('.ptoggle');
    const last = !isMobile && open && row.filter(x => panelOpen[x]).length === 1;
    p.classList.toggle('collapsed', !open);
    p.classList.toggle('strip', !isMobile && !open && (row === PANEL_ROWS[1] || id === 'p-map' || rightClosed));   // mobile: header bars only
    b.setAttribute('aria-expanded', String(open));
    b.setAttribute('aria-disabled', String(last));
    b.title = last ? `The ${PANEL_NAMES[id]} stays open (at least one panel per row)` : `${open ? 'Collapse' : 'Expand'} ${PANEL_NAMES[id]}`;
    b.setAttribute('aria-label', b.title);
  }
  $('.top').classList.toggle('map-collapsed', !panelOpen['p-map']);
  $('.top').classList.toggle('right-collapsed', rightClosed);
  $('.right').classList.toggle('one-collapsed', !rightClosed && (!panelOpen['p-predictive'] || !panelOpen['p-status']));
  $('#layers').classList.toggle('collapsed', !panelOpen.layers);
  $('#layersBtn').setAttribute('aria-expanded', String(panelOpen.layers));
  $('#layersBtn').title = panelOpen.layers ? 'Hide map layers' : 'Show map layers';
  $('#p-predictive').classList.toggle('details-open', panelOpen.details);
  $('#detailsBtn').setAttribute('aria-expanded', String(panelOpen.details));
  $('#detailsBtn').title = panelOpen.details ? 'Hide the 5-step chain and model inputs' : 'Show the 5-step chain and model inputs';
}
applyPanels();
$('#layersBtn').addEventListener('click', () => { panelOpen.layers = !panelOpen.layers; applyPanels(); });
$('#detailsBtn').addEventListener('click', () => { panelOpen.details = !panelOpen.details; applyPanels(); renderPredictive(); });

// ---------- mobile mode: accordion defaults, drawer, bottom bar, 12 px text floor ----------
const PANEL_DEFAULTS_MOBILE = {
  'p-map': true, 'p-predictive': true, 'p-alerts': true,
  'p-status': false, 'p-areas': false, 'p-pumps': false, 'p-consumption': false,
  layers: false, details: false,
};
// Raise any HTML text under 12 px to 12 px while in mobile mode (SVG diagram text scales with its viewBox and is
// left alone). Runs on new nodes only, so it keeps up with re-rendered panels; undone when leaving mobile mode.
function fixSmallText(root) {
  if (!isMobile || root.nodeType !== 1 || root.closest('svg, #gl')) return;
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.closest('svg') || el.hasAttribute('data-mfs')) continue;
    if (parseFloat(getComputedStyle(el).fontSize) < 12) { el.style.fontSize = '12px'; el.setAttribute('data-mfs', ''); }
  }
}
new MutationObserver(ms => { if (isMobile) ms.forEach(m => m.addedNodes.forEach(fixSmallText)); }).observe(document.body, { childList: true, subtree: true });
function openDrawer(open) {
  document.documentElement.classList.toggle('drawer-open', open);
  $('#mBack').hidden = !open;
  $$('.mmenu').forEach(b => { b.setAttribute('aria-expanded', String(open)); b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); });
  if (open) $('#nav a')?.focus();
}
$$('.mmenu').forEach(b => b.addEventListener('click', () => openDrawer(!document.documentElement.classList.contains('drawer-open'))));
$('#mBack').addEventListener('click', () => openDrawer(false));
$('#nav').addEventListener('click', () => { if (isMobile) openDrawer(false); });
addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !isMobile) return;
  if (document.documentElement.classList.contains('drawer-open')) openDrawer(false);
  else if (selected) { selected = null; gl.selectLabel(null); renderInfo(); }
  else if (panelOpen.layers) { panelOpen.layers = false; applyPanels(); }
});
const syncSpeedBar = () => { $$('[data-mx]').forEach(b => b.classList.toggle('active', +b.dataset.mx === speed)); $('#sbSpeed').textContent = speed + '×'; };
$$('[data-mx]').forEach(b => b.addEventListener('click', () => $(`#speed [data-x="${b.dataset.mx}"]`).click()));
$$('#speed button').forEach(b => b.addEventListener('click', () => setTimeout(syncSpeedBar)));
let hintShown = false;
function showMapHint() {
  if (hintShown) return;
  hintShown = true;
  const h = $('#mHint'), off = () => h.classList.remove('on');
  h.classList.add('on');
  setTimeout(off, 6000);
  $('#gl').addEventListener('touchstart', off, { once: true, passive: true });
}
function setMobileMode(on) {
  isMobile = on;
  document.documentElement.classList.toggle('mobile', on);
  fitToWindow();
  Object.assign(panelOpen, on ? PANEL_DEFAULTS_MOBILE : PANEL_DEFAULTS);
  openDrawer(false);
  applyPanels();
  gl.setMobile(on);
  if (on) { fixSmallText($('.app')); fixSmallText($('.mbar')); showMapHint(); }
  else $$('[data-mfs]').forEach(el => { el.style.fontSize = ''; el.removeAttribute('data-mfs'); });
}
if (isMobile) setMobileMode(true);
// switch live on resize / rotation; the 1 Hz clock re-checks too, for environments that do not fire these events
function checkMobile() { if (ENABLE_MOBILE_LAYOUT && MOBILE_MQ.matches !== isMobile) { setMobileMode(MOBILE_MQ.matches); update(); } }
if (ENABLE_MOBILE_LAYOUT) { MOBILE_MQ.addEventListener('change', checkMobile); addEventListener('resize', checkMobile); addEventListener('orientationchange', checkMobile); }

const clock = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const hms = s => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
const fmtH = h => (h < 48 ? `${h} h` : `${(h / 24).toFixed(1)} d`);
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2800);
}

let fc, fcNo, fcLong, fcLongNo;
function runForecasts() {
  fc = sim.forecast(S);
  fcNo = sim.forecast(S, 168, { policy: false });
  fcLong = sim.forecast(S, 720);
  fcLongNo = sim.forecast(S, 720, { policy: false });
}
runForecasts();
const daysToLow = f => { const h = f.firstBelow(LOW); return h === null ? null : h / 24; };
const daysTxt = d => (d === null ? '30+ days' : `${d.toFixed(1)} days`);
const rotNow = () => { const g = sim.rotGroupAt(S.t); return { g, grp: ROT_GROUPS[g], until: clock(sim.rotBlockEnd(S.t)) }; };
const zoneHH = z => S.areas.filter(a => a.zone === z).reduce((s, a) => s + a.households, 0);
const zoneNames = z => S.svc.rows.filter(r => r.zone === z).map(r => short(r.name)).join(', ');
const LV_COL = { green: '#2ee66f', yellow: '#f5c542', orange: '#ff9f43', red: '#ff4d57' };
const levelColor = v => (v >= CRIT || v < LOW ? '#ff4d57' : v >= 80000 || v < S.rotThr ? '#ff9f43' : '#2f8cff');

let selected = null, range = 30, sortBy = 'gap', speed = 1, modelOpen = false;
const dismissed = new Set();
const firstSeen = new Map();

// ---------- the three questions ----------
// Q1: do we have enough water?  (green adequate · yellow watch · orange supply pressure · red critical)
function supplyStatus() {
  const zs = Object.values(S.svc.zones), dl = daysToLow(fcLong), hOver = fc.firstAbove(CAP), hFlood = fc.firstAbove(CRIT);
  const none = zs.filter(z => z.status === 'none'), shortz = zs.filter(z => z.status === 'shortage');
  if (S.volume < LOW) return { lv: 'red', label: 'CRITICAL SHORTAGE', reason: 'Storage below the 15% critical level' };
  if (none.length) return { lv: 'red', label: 'CRITICAL · NO SUPPLY', reason: `${none.map(z => z.label).join(', ')} not supplied` };
  if (S.spilling || (hOver !== null && hOver <= 24)) return { lv: 'red', label: 'OVERFLOW RISK', reason: S.spilling ? `Spilling ${fmt(S.spillRate)} m³/h` : `Overflow in ~${hOver} h` };
  if (S.rotActive) return { lv: 'orange', label: 'SUPPLY PRESSURE', reason: `Rationing active: ${pctf(sim.ROT_FACTOR)} of demand delivered` };
  if (shortz.length) return { lv: 'orange', label: 'SUPPLY PRESSURE', reason: `Supply < demand: ${shortz.map(z => z.label).join(', ')}` };
  if (dl !== null && dl < 14) return { lv: 'orange', label: 'SUPPLY PRESSURE', reason: `Critical level in ~${dl.toFixed(1)} days` };
  if (S.volume >= CRIT || (hFlood !== null && hFlood <= 72)) return { lv: 'orange', label: 'FLOOD BUFFER', reason: S.volume >= CRIT ? 'Above the 90% flood buffer' : `Flood buffer in ~${fmtH(hFlood)}` };
  const hRot = fcNo.firstBelow(S.rotThr);
  if (hRot !== null) return { lv: 'yellow', label: 'WATCH', reason: `Rationing threshold in ~${fmtH(hRot)}` };
  if (S.svc.peakDeficit > 1) return { lv: 'yellow', label: 'WATCH', reason: `Peak-hour deficit ~${fmt(S.svc.peakDeficit)} m³/h` };
  if (zs.some(z => z.status === 'balanced')) return { lv: 'yellow', label: 'WATCH', reason: 'Supply ≈ demand in some areas' };
  if (dl !== null && dl < 30) return { lv: 'yellow', label: 'WATCH', reason: `${dl.toFixed(0)} days of supply` };
  if (hFlood !== null) return { lv: 'yellow', label: 'WATCH', reason: `Flood buffer in ~${fmtH(hFlood)}` };
  return { lv: 'green', label: 'ADEQUATE', reason: 'Supply exceeds demand in every service area' };
}
// Q2: what happens to the rainwater over the next 72 h?
function rainfate() {
  const T = fc.totals(72);
  if (T.rain < 1800) return { lv: S.scenario === 'dry' ? 'yellow' : 'green', T, txt: S.scenario === 'dry' ? 'No significant rain · baseflow only' : 'Little rain · baseflow sustains inflow' };
  const ro = T.runoff / T.rain, lost = T.spill / Math.max(1, T.inflow);
  if (T.spill > 1) return { lv: lost > 0.25 ? 'red' : 'orange', T, ro, lost, txt: `${pctf(ro)} runs off · ${fmt(T.spill)} m³ overflows` };
  return { lv: 'green', T, ro, lost, txt: `${pctf(1 - ro)} soaks in · ${pctf(ro)} runoff · all stored` };
}
// Q3: is water reaching where it is needed?
function reach() {
  const rows = S.svc.rows, by = st => rows.filter(r => r.status === st).map(r => short(r.name));
  const none = by('none'), sh = by('shortage'), bal = by('balanced');
  if (none.length) return { lv: 'red', txt: `No supply: ${none.join(', ')}` };
  if (sh.length) return { lv: 'orange', txt: sh.length === rows.length ? `All areas short: supply ${pctf(S.svc.ratio)} of demand` : `Supply < demand: ${sh.slice(0, 3).join(', ')}${sh.length > 3 ? ` +${sh.length - 3}` : ''}` };
  if (bal.length) return { lv: 'yellow', txt: `Supply ≈ demand: ${bal.join(', ')}` };
  return { lv: 'green', txt: `All ${rows.length} areas: supply > demand` };
}
function renderQuestions() {
  const st = supplyStatus(), rf = rainfate(), rc = reach();
  const set = (n, lv, txt) => { const q = $(`.q[data-q="${n}"]`); q.style.setProperty('--qc', LV_COL[lv]); $(`#q${n}`).textContent = txt; };
  set(1, st.lv, `${st.label} · ${pctf(S.volume / CAP)} stored · ${daysTxt(daysToLow(fcLong)).replace(' days', ' d')} supply`);
  set(2, rf.lv, `Next 72 h: ${rf.txt}`);
  set(3, rc.lv, rc.txt);
  const m = S.m, ok = Object.values(S.svc.zones).filter(z => z.status === 'surplus' || z.status === 'balanced').length;
  $('#flowchain').innerHTML = `<span>Rain <b>${m.P < 10 ? m.P.toFixed(1) : fmt(m.P)} mm/d</b></span><em>→</em><span>Runoff <b>${fmt(m.runoff)} m³/h</b></span><em>→</em><span class="${S.spilling ? 'bad' : ''}">Stored <b>${pctf(S.volume / CAP)}</b>${S.spilling ? ' · overflowing' : ''}</span><em>→</em><span>Pumped <b>${fmt(m.pumpOut)} m³/h</b></span><em>→</em><span class="${ok < 3 ? 'bad' : ''}">Service zones OK <b>${ok}/3</b></span>`;
}

// ---------- decision-support alerts (grouped by the three problems) ----------
const RANK = { critical: 0, warning: 1, advisory: 2, normal: 3 };
const ICON = { critical: 'i-crit', warning: 'i-warn', advisory: 'i-info', normal: 'i-check' };
function computeAlerts() {
  const L = [], m = S.m, svc = S.svc, nw = m.nw;
  const add = (id, lv, cat, text, rec, target) => L.push({ id, lv, cat, text, rec, target });
  const pct = S.volume / CAP * 100, thrPct = Math.round(S.rotThr / CAP * 100);

  // 1 · water availability / shortage
  if (S.volume < LOW) add('crit-now', 'critical', 'SHORTAGE', `Storage below the critical level (${pct.toFixed(1)}%).`, 'Restrict supply to essential household use and deploy water tankers.', 'reservoir');
  else { const d = daysToLow(fc); if (d !== null) add('crit-fc', 'critical', 'SHORTAGE', `Storage projected to reach the critical level in ~${d.toFixed(1)} days.`, 'Lengthen rationing intervals, run a conservation campaign, prepare tankers.', 'reservoir'); }
  if (S.rotActive) { const r = rotNow(); add('rot-on', 'warning', 'SHORTAGE', `Water rationing active: ${r.grp.name} (${r.grp.areas.map(short).join(', ')}) supplied until ${r.until}.`, 'Notify barangay captains of the schedule via SMS.', r.grp.ents[0]); }
  else if (S.rotMode === 'off' && S.volume < S.rotThr) add('rot-off', 'critical', 'SHORTAGE', `Below the ${thrPct}% rationing threshold, but rotation is disabled.`, 'Set rotation to Auto or On to protect remaining storage.', 'reservoir');
  else {
    const h = fcNo.firstBelow(S.rotThr);
    if (h !== null && h <= 72) add('rot-72', 'warning', 'SHORTAGE', `Rationing threshold (${thrPct}%) projected in ~${fmtH(h)}.`, 'Publish the rotation schedule to barangays in advance.', 'reservoir');
  }
  const proj = fc.find(p => p.h > 0 && p.h <= 72 && p.sup < 0.95);
  if (proj && !S.rotActive) add('proj-deficit', 'warning', 'SHORTAGE', `Projected supply deficit in ~${fmtH(proj.h)}: available water covers ${pctf(proj.sup)} of demand.`, 'Prioritize household demand; prepare rotation and commercial curtailment.', 'reservoir');
  Object.values(svc.zones).forEach(zn => {
    if (zn.status === 'shortage') add(`short-${zn.z}`, 'warning', 'DEMAND', `Demand exceeds available supply in ${zn.name} (${zn.label}): ${pctf(zn.ratio)} of demand.`,
      zn.limit === 'pump capacity' ? 'Activate the backup distribution route or start a standby pump.' : 'Prioritize household demand and curtail commercial use.', zn.z === 'A' ? 'residential' : zn.z === 'B' ? 'divisoria' : 'poblacion');
  });
  if (S.scenario === 'dry' && m.net < 0) add('dry', 'advisory', 'SHORTAGE', `Dry season: inflow ${fmt(m.inflow + m.pumpIn)} m³/h is below demand ${fmt(m.demand)} m³/h, so storage is declining.`, 'Run a conservation campaign; prioritize households over commercial use.', 'reservoir');

  if (m.storageLimited) add('storage-limit', 'critical', 'SHORTAGE', `Pumping limited by available storage: ~${fmt(m.unserved)} m³/h of demand unserved (pumps cannot draw below ${fmt(DEAD)} m³ dead storage).`, 'Enforce rationing and deploy water tankers to affected barangays.', 'reservoir');

  // 2 · rainfall, runoff and capture
  const T = fc.totals(72);
  if (S.spilling) add('overflow', 'critical', 'CAPTURE', `Reservoir full: ${fmt(S.spillRate)} m³/h leaving through the spillway (not captured).`, 'Warn downstream barangays; route surplus to secondary storage if available.', 'reservoir');
  else if (T.spill > 1) add('capture72', 'warning', 'CAPTURE', `High runoff with limited storage: ~${fmt(T.spill)} m³ will overflow in the next 72 h (${pctf(T.spill / Math.max(1, T.inflow))} of inflow not captured).`, 'Draw down to the flood buffer before the peak; plan off-stream storage / rainwater harvesting.', 'reservoir');
  const hFlood = fc.firstAbove(CRIT);
  if (!S.spilling && S.volume >= CRIT) add('flood-now', 'critical', 'STORAGE', `Reservoir at ${pct.toFixed(1)}%, above the flood buffer.`, 'Start a controlled release ahead of the overflow threshold.', 'reservoir');
  else if (!S.spilling && hFlood !== null && hFlood <= 72) add('flood72', 'warning', 'STORAGE', `Flood buffer (90%) projected in ~${fmtH(hFlood)}.`, 'Prepare a controlled release before the level exceeds 90%.', 'reservoir');
  const warn = sim.rainWarning(SCEN[S.scenario].P);
  if (S.scenario === 'heavy' || S.scenario === 'moderate') {
    add(`rain-${S.scenario}`, S.scenario === 'heavy' ? 'warning' : 'advisory', 'RUNOFF', `${S.scenario === 'heavy' ? 'Typhoon' : 'Monsoon'} rainfall${warn ? ` (PAGASA-style ${warn.level})` : ''} expected to raise watershed runoff to ~${fmt(peakRunoff(S.lu))} m³/h (est.).`,
      S.scenario === 'heavy' ? 'Activate the MDRRMO flood protocol; intake paused for turbidity.' : 'Monitor storage and landslide-prone slopes.', 'forest');
  }
  if (S.lu.forestLossPct > 1) {
    const r0 = peakRunoff(LU_INTACT), r1 = peakRunoff(S.lu);
    add('forest-loss', S.lu.forestLossPct >= 30 ? 'warning' : 'advisory', 'RUNOFF', `Upland forest loss ${S.lu.forestLossPct.toFixed(0)}%: less infiltration${r0 > 0 ? `, peak runoff +${((r1 / r0 - 1) * 100).toFixed(0)}%` : ''}, baseflow −${(60 * S.lu.clearedArea).toFixed(0)}%.`, 'Prioritize reforestation (NGP) and enforce anti-kaingin ordinances in the catchment.', 'forest');
  }

  // 3 · distribution (is water reaching where it is needed?)
  S.pumps.forEach(p => {
    if (p.status === 'failed') add(`fail-${p.id}`, 'critical', 'DISTRIBUTION', `${p.short} failure: ${p.flow} m³/h of pumping capacity lost.`, 'Dispatch the maintenance crew; keep the backup route open until repaired.', p.id);
    if (p.iv && p.status === 'running' && !S.valves[p.iv]) add(`dead-${p.id}`, 'critical', 'DISTRIBUTION', `Interlock armed: ${p.short} running against closed ${sim.VALVES[p.iv].name}. Trip in ${sim.INTERLOCK_S - p.deadhead} s.`, `Open ${sim.VALVES[p.iv].name} or stop ${p.short}.`, p.iv);
  });
  if (S.lastTrip) { const p = S.pumps.find(x => x.id === S.lastTrip.id); add('trip', 'warning', 'DISTRIBUTION', `Interlock tripped ${p.short}: it ran against closed ${sim.VALVES[S.lastTrip.valve].name} (dead-head).`, `Open ${sim.VALVES[S.lastTrip.valve].name}, then restart ${p.short}.`, p.id); }
  Object.values(svc.zones).forEach(zn => {
    if (zn.status === 'none') add(`out-${zn.z}`, 'critical', 'DISTRIBUTION', `No supply: ${zn.name} (${zn.label}), ${fmt(zoneHH(zn.z))} households${zn.z === 'B' ? ' + commercial zone' : ''}.`,
      zn.z === 'C' ? 'Restart or repair Pump C (no backup route).' : S.valveMode === 'manual' ? 'Open XV-1 and XV-2 so the other pump can back-feed this pipeline.' : 'Automatic reroute in progress.', zn.z === 'A' ? 'residential' : zn.z === 'B' ? 'divisoria' : 'PUMP-03');
  });
  if (nw.flow) {
    const from = nw.flow === 'BtoA' ? S.pumps[1] : S.pumps[0], zn = svc.zones[nw.flow === 'BtoA' ? 'A' : 'B'];
    add(`reroute-${nw.flow}`, 'warning', 'DISTRIBUTION', `Backup route active: ${from.short} supplying ${zn.name} (${zn.label}) through cross-connection XV-1/XV-2 at ${pctf(from.q / from.flow)} load.`, 'Monitor pressure at the network ends; repair the failed pump.', nw.flow === 'BtoA' ? 'XV1' : 'XV2');
  }
  if (svc.peakDeficit > 1) {
    const down = S.pumps.find(p => p.status !== 'running');
    add('peak-def', 'warning', 'DISTRIBUTION', down ? `Backup capacity insufficient: ${down.short} outage leaves ~${fmt(svc.peakDeficit)} m³/h of peak demand unserved.` : `Network has a ~${fmt(svc.peakDeficit)} m³/h peak-hour service deficit.`, 'Shift commercial use off-peak or start a standby pump.', down ? down.id : 'PUMP-02');
  }

  if (!L.some(a => a.lv !== 'normal')) add('ok', 'normal', 'STATUS', 'All service areas supplied; storage adequate; rainfall captured.', 'Continue routine monitoring.', 'reservoir');
  L.forEach(a => { if (!firstSeen.has(a.id)) firstSeen.set(a.id, S.t); });
  return L.sort((a, b) => RANK[a.lv] - RANK[b.lv]);
}
// Decision Support presentation: severity chip + headline + numbered actions (top 3, "+N more").
// All content comes from computeAlerts(); nothing here adds logic or numbers.
const DS_CHIP = { critical: 'CRITICAL', warning: 'WARNING', advisory: 'ADVISORY', normal: 'OK' };
const DS_HEAD = { critical: 'Action needed now', warning: 'Action recommended', advisory: 'Advisory: monitor conditions' };
const DS_TOP = 3;
let alertsExpanded = false, seenAlertIds = null;
function renderAlerts() {
  const all = computeAlerts();
  const shown = all.filter(a => !dismissed.has(a.id));
  const act = shown.filter(a => a.lv !== 'normal');
  const active = act.length;
  $('#bellDot').style.display = active ? '' : 'none';
  const top = active ? act[0].lv : 'normal';
  const chip = $('#dsChip');
  chip.className = 'ds-chip ' + top;
  chip.textContent = DS_CHIP[top];
  $('#dsHead').textContent = active ? `${DS_HEAD[top]} · ${active} active alert${active > 1 ? 's' : ''}`
    : shown.length ? 'All service areas supplied; continue routine monitoring' : 'No active alerts (dismissed items hidden)';
  // pulse the chip once when a new alert appears (not on first load)
  const ids = new Set(all.filter(a => a.lv !== 'normal').map(a => a.id));
  if (seenAlertIds && [...ids].some(id => !seenAlertIds.has(id))) { chip.classList.remove('pulse'); void chip.offsetWidth; chip.classList.add('pulse'); }
  seenAlertIds = ids;
  const rows = active ? act : [];
  const vis = alertsExpanded ? rows : rows.slice(0, DS_TOP);
  const list = vis.map((a, i) => `<div class="dsr ${a.lv}" data-target="${a.target}">
    <span class="ds-n">${i + 1}.</span>
    <div class="ds-b"><b>${a.rec}</b><p>${a.text}</p><small><span class="cat">${a.cat}</span><span class="tm">${clock(firstSeen.get(a.id))}</span></small></div>
    <span class="x" data-dismiss="${a.id}" title="Dismiss" role="button" aria-label="Dismiss">×</span></div>`).join('');
  const more = rows.length - DS_TOP;
  const calm = !active ? shown.filter(a => a.lv === 'normal').map(a => `<p class="ds-calm">${a.text} ${a.rec}</p>`).join('') : '';
  $('#alerts').innerHTML = calm + list + (more > 0 ? `<button type="button" class="ds-more" data-ds-more>${alertsExpanded ? 'Show fewer' : `+${more} more`}</button>` : '');
}

// ---------- predictive water availability ----------
function renderChain() {
  const m = S.m, st = supplyStatus();
  const node = (n, label, val, sub, color, tip) => `<div class="node" style="--nc:${color}" title="${tip}"><small>${n} · ${label}</small><b>${val}</b><i>${sub}</i></div>`;
  const warn = sim.rainWarning(m.P);
  const ro = m.P > 0.5 ? m.Q / m.P : 0;
  $('#chain').innerHTML = [
    node(1, 'Rainfall', `${m.P < 10 ? m.P.toFixed(1) : fmt(m.P)} mm/d`, warn ? `PAGASA-style ${warn.level} level` : m.P < 1 ? 'No significant rain' : 'Scenario rainfall (24 h)', warn ? warn.color : m.P >= 5 ? '#5fd0ff' : '#f5c542', 'Scenario rainfall over the watershed (simulated, not a live forecast)'),
    node(2, 'Runoff', `${fmt(m.runoff)} m³/h`, m.P < 1 ? 'No rain to run off' : `now: ${pctf(ro)} of rain runs off (est.)`, m.runoff > 1500 ? '#ff9f43' : '#5fd0ff', 'Estimated with the SCS Curve Number method from the permeability / land-cover classes'),
    node(3, 'Water balance', `${sgn(m.net)} m³/h`, S.spilling ? `overflowing ${fmt(S.spillRate)} m³/h` : m.net >= 0 ? 'storage rising' : 'storage falling', S.spilling ? '#5fd0ff' : m.net >= 0 ? '#2ee6a0' : '#ff9f43', 'Inflow + intake − pumped supply − evaporation (− spill when full)'),
    node(4, 'Demand', `${fmt(m.demand)} m³/h`, S.rotActive ? `rationed · ${fmt(m.target)} delivered` : `homes ${fmt(m.hh)} · business ${fmt(m.com)}`, S.rotActive ? '#b48cff' : '#ffb36b', 'Household + commercial demand across all service areas'),
    node(5, 'Water availability', st.label, `${daysTxt(daysToLow(fcLong))} of supply`, LV_COL[st.lv], st.reason),
  ].join('<span class="carr"></span>');
}
function renderInputs() {
  const m = S.m;
  const c = (cls, label, val) => `<div class="inp ${cls}"><span>${label}</span><b>${val}</b></div>`;
  $('#inputs').innerHTML = `<div class="ttl"><span>MODEL INPUTS · CURRENT HOUR</span><em>m³/h unless noted · estimated · simulation</em></div>` +
    c('in', 'Rainfall (scenario)', `${m.P.toFixed(1)} mm/d`) + c('in', 'Runoff (estimated)', fmt(m.runoff)) + c('in', 'Reservoir inflow', fmt(m.inflow)) + c('in', 'Intake inflow', fmt(m.pumpIn)) +
    c('out', 'Household demand', fmt(m.hh)) + c('out', 'Commercial demand', fmt(m.com)) + c('out', 'Evaporation', m.evap.toFixed(1)) + c('out', 'Pumped supply', fmt(m.pumpOut));
}
const RISK = [['Low', 'r-low'], ['Moderate', 'r-mod'], ['High', 'r-high'], ['Severe', 'r-sev']];
function risks() {
  const peak = fc.peak(), min = fc.min();
  return { flood: S.spilling || peak >= CAP ? 3 : peak >= CRIT ? 2 : peak >= 80000 ? 1 : 0, shortage: min < LOW ? 3 : min < S.rotThr ? 2 : min < S.rotThr + 10000 ? 1 : 0 };
}
function renderPredictive() {
  forecastChart($('#fchart'), S, fc, fcNo);
  renderLuQuick();
  renderChain();
  renderInputs();
  const v24 = fc[24].v, v72 = fc[72].v, cur = S.volume;
  const pc = v => ((v - cur) / Math.max(cur, 1) * 100);
  const em = v => `<em class="${pc(v) < 0 ? 'neg' : ''}">(${pc(v) >= 0 ? '+' : ''}${pc(v).toFixed(1)}%)</em>`;
  const dl = daysToLow(fcLong), dlNo = daysToLow(fcLongNo);
  const R = risks();
  $('#fkpis').innerHTML = `
    <div class="kpi"><small>Storage in 24 h</small><b>${fmt(v24)} m³</b>${em(v24)}</div>
    <div class="kpi"><small>Storage in 72 h</small><b>${fmt(v72)} m³</b>${em(v72)}</div>
    <div class="kpi" title="Days until storage reaches the 15% critical level"><small>Days of supply</small><b style="color:${dl !== null && dl < 7 ? '#ff6b3d' : dl !== null && dl < 14 ? '#f5c542' : 'inherit'}">${daysTxt(dl)}</b></div>
    <div class="kpi"><small>Risk (7-day)</small><div class="risk"><span class="${RISK[R.flood][1]}">Flood ${RISK[R.flood][0]}</span><span class="${RISK[R.shortage][1]}">Shortage ${RISK[R.shortage][0]}</span></div></div>`;

  const hFlood = fc.firstAbove(CRIT), m = S.m, T = fc.totals(72);
  const b = $('#banner');
  const set = (cls, icon, title, text) => { b.className = 'banner ' + cls; b.innerHTML = `<svg><use href="#${icon}"/></svg><div><b>${title}</b><small>${text}</small></div>`; };
  if (S.spilling || T.spill > 1) set('crit', 'i-warn', 'RAINWATER NOT CAPTURED', `${S.spilling ? `Spilling ${fmt(S.spillRate)} m³/h now. ` : ''}~${fmt(T.spill)} m³ projected to overflow in 72 h. Draw down to the flood buffer before the peak.`);
  else if (S.volume >= CRIT || (hFlood !== null && hFlood <= 48)) set('crit', 'i-warn', 'FLOOD BUFFER BREACH EXPECTED', S.volume >= CRIT ? 'Above the 90% flood buffer: start a controlled release.' : `Runoff of ${fmt(m.runoff)} m³/h projected to pass 90% in ~${hFlood} h.`);
  else if (S.volume < LOW) set('crit', 'i-warn', 'CRITICAL SHORTAGE', 'Storage below 15%. Supply restricted to essential household use.');
  else if (S.rotActive) {
    const r = rotNow(), gain = (dl ?? 30) - (dlNo ?? 30);
    set('rot', 'i-info', 'WATER RATIONING ACTIVE', `${r.grp.name} supplied until ${r.until}. ${gain > 0.2 ? `Rationing extends supply by ~${gain.toFixed(1)} days.` : 'Storage protected.'}`);
  } else if (S.scenario === 'dry') {
    const h = fcNo.firstBelow(S.rotThr);
    set('', 'i-warn', 'DRY SEASON: STORAGE DECLINING', h !== null ? `Rationing threshold (${Math.round(S.rotThr / 1000)}K m³) projected in ~${fmtH(h)}. Rotation ${S.rotMode === 'off' ? 'is DISABLED.' : 'will start automatically.'}` : 'Net balance negative, but storage stays above the rationing threshold for 7 days.');
  } else if (S.scenario !== 'light') set('', 'i-warn', 'HIGH INFLOW EXPECTED', `Estimated runoff ${fmt(m.runoff)} m³/h may raise storage ~${Math.max(0, pc(v24)).toFixed(0)}% within 24 h.`);
  else set('ok', 'i-info', 'SUPPLY ADEQUATE', `Net balance ${sgn(m.net)} m³/h; storage ${pc(v24) >= 0 ? '+' : ''}${pc(v24).toFixed(1)}% over 24 h; all thresholds clear.`);

  if (modelOpen) renderModelCard();
}

// ---------- permeability / infiltration class (land use × soil group -> curve numbers) ----------
const LU_INTACT = S.lu;
const peakRunoff = lu => { const sc = SCEN[S.scenario]; return sim.catchmentRunoff(sc.P, sc.amc, lu).Q * sim.catchmentKm2() * 1000 / 24; };
function clearSlider() {
  const v = Math.round(S.lu.cleared * 100);
  return `<div class="luctl"><span>What-if: upland forest cleared<br><small>kaingin / logging</small></span><input type="range" min="0" max="60" step="5" value="${v}" data-clear><b id="luVal">${v}%</b></div>`;
}
function luTableHtml() {
  const m = S.m, lu = S.lu;
  const rows = m.units.filter(r => r.f >= 0.004).map(r => {
    const U = UNITS[r.u];
    return `<tr><td><span class="sw" style="background:#${cnColor(U.cn).toString(16).padStart(6, '0')}"></span>${U.name}</td><td>${U.hsg}</td><td>${U.cover}</td><td>${(r.f * 100).toFixed(1)}%</td><td>${U.cn}</td><td>${r.cn.toFixed(0)}</td><td>${r.Q.toFixed(1)}</td></tr>`;
  }).join('');
  return `<table class="lutbl"><thead><tr><th>Permeability / infiltration class</th><th>HSG</th><th>Cover</th><th>Area</th><th>CN II</th><th>CN ${m.amc}</th><th>Q mm</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">Catchment draining to the reservoir (area-weighted)</td><td>100%</td><td>${lu.cn2.toFixed(1)}</td><td>${m.cn.toFixed(1)}</td><td>${m.Q.toFixed(1)}</td></tr></tfoot></table>`;
}
function luImpactHtml() {
  const r0 = peakRunoff(LU_INTACT), r1 = peakRunoff(S.lu);
  const dR = r0 > 0 ? (r1 / r0 - 1) * 100 : 0, dB = -60 * S.lu.clearedArea;
  return `<span>Peak ${SCEN[S.scenario].label.toLowerCase()} runoff <b>${fmt(r1)} m³/h</b> <span class="${dR > 0.5 ? 'up' : ''}">(${dR >= 0 ? '+' : ''}${dR.toFixed(0)}% vs intact forest)</span></span>
    <span>Baseflow <b class="${dB < -0.5 ? 'dn' : ''}">${dB.toFixed(0)}%</b> (less infiltration)</span>
    <span>Composite CN(II) <b>${LU_INTACT.cn2.toFixed(1)} → ${S.lu.cn2.toFixed(1)}</b></span>`;
}
// main-panel forest what-if: the same data-clear slider as "How it works" and the Upper Watershed card.
// Storm runoff is compared on a typhoon day (scenario P, AMC III) so the effect reads the same in every scenario.
const stormRunoffPct = () => {
  const sc = SCEN.heavy, q = lu => sim.catchmentRunoff(sc.P, sc.amc, lu).Q, r0 = q(LU_INTACT);
  return r0 > 0 ? (q(S.lu) / r0 - 1) * 100 : 0;
};
function luQuickHtml() {
  const dR = stormRunoffPct(), dB = 60 * S.lu.clearedArea, on = S.lu.cleared > 0;
  return `<span>Storm runoff <b class="${on ? 'up' : ''}">${on ? '↑ +' : ''}${dR.toFixed(0)}%</b> <small>(typhoon day)</small></span>
    <span>Dry-season baseflow <b class="${on ? 'dn' : ''}">${on ? '↓ −' : ''}${dB.toFixed(0)}%</b></span>
    <span>CN(II) <b>${LU_INTACT.cn2.toFixed(1)} → ${S.lu.cn2.toFixed(1)}</b></span>`;
}
function renderLuQuick() {
  const el = $('#luQuick');
  if (!el) return;
  if (el.contains(document.activeElement) && document.activeElement.matches('input')) { $('#luQuickImpact').innerHTML = luQuickHtml(); return; }
  el.innerHTML = `${clearSlider()}<div class="luimpact" id="luQuickImpact">${luQuickHtml()}</div>`;
}
function refreshLandUseUI() {
  $('#luTable') && ($('#luTable').innerHTML = luTableHtml());
  $('#luImpact') && ($('#luImpact').innerHTML = luImpactHtml());
  $('#luQuickImpact') && ($('#luQuickImpact').innerHTML = luQuickHtml());
  const v = Math.round(S.lu.cleared * 100);
  $$('#luVal').forEach(e => (e.textContent = v + '%'));
  $$('[data-clear]').forEach(i => { if (i !== document.activeElement) i.value = v; });   // keep every copy of the slider in step
}
function renderModelCard() {
  const m = S.m;
  const card = $('#modelcard');
  if (card.contains(document.activeElement) && document.activeElement.matches('input')) { refreshLandUseUI(); return; }
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  card.innerHTML = `<h4>HOW THE WATER-AVAILABILITY ESTIMATE WORKS <small class="muted">· ${SCEN[S.scenario].label} scenario · simulation</small><span class="x" data-mclose>×</span></h4>
  <div class="lusec"><div class="hd">⓪ RAINFALL → SOIL &amp; LAND COVER <small class="muted">classified permeability / infiltration (same classes as the map layer) · soil groups would come from BSWM maps; values here are simulated</small></div>
    <div id="luTable">${luTableHtml()}</div>${clearSlider()}<div class="luimpact" id="luImpact">${luImpactHtml()}</div></div>
  <div class="mstages">
    <div class="mstage" style="--nc:#5fd0ff"><b>① Runoff (SCS Curve Number)</b><small>Per class, then area-weighted · estimated</small>
      <code>Q = (P − Iₐ)² / (P − Iₐ + S)<br>S = 25400/CN − 254 · Iₐ = 0.2S<br>Q<sub>catch</sub> = Σ aᵢ·Q(P, CNᵢ)</code>
      ${row('Rainfall P', m.P.toFixed(1) + ' mm/d')}${row('Composite CN (AMC ' + m.amc + ')', m.cn.toFixed(1))}${row('S / Iₐ', `${m.Smax.toFixed(1)} / ${m.Ia.toFixed(1)} mm`)}${row('Runoff depth Q', m.Q.toFixed(2) + ' mm/d')}${row(`× ${sim.catchmentKm2().toFixed(2)} km² catchment`, fmt(m.runoff) + ' m³/h')}</div>
    <div class="mstage" style="--nc:#2ee6a0"><b>② Storage water balance</b><small>Mass-conserving · hourly</small>
      <code>ΔS = Q<sub>base</sub> + Q<sub>runoff</sub> + P<sub>in</sub> − D<sub>pumped</sub> − E − Spill<br>pumps stop at dead storage (${fmt(DEAD)} m³)</code>
      ${row('Baseflow', fmt(m.base) + ' m³/h')}${row('Runoff', fmt(m.runoff) + ' m³/h')}${row('Intake inflow', fmt(m.pumpIn) + ' m³/h')}${row('Pumped supply', '−' + fmt(m.pumpOut) + ' m³/h')}${row('Evaporation', '−' + m.evap.toFixed(1) + ' m³/h')}${row('Spill (overflow)', S.spilling ? '−' + fmt(S.spillRate) + ' m³/h' : '0')}${row('<b>Net ΔS</b>', `<b>${sgn(m.net)} m³/h</b>`)}</div>
    <div class="mstage planned" style="--nc:#7f97b2"><b>③ PLANNED · ML correction</b><small>Not active in this simulation</small>
      <code>${PLANNED_ML.name}<br>on residuals of ② once ≥ 2 years of gauge + SCADA data exist</code>
      ${row('Status', '<b style="color:#f5d96a">Planned: not trained</b>')}${row('Validation', 'None yet (no historical data)')}
      <small>Candidate features:</small><div class="feats">${PLANNED_ML.features.map(f => `<span>${f}</span>`).join('')}</div></div>
  </div>
  <div class="mnote">All forecasts shown are physics-only (① + ②) driven by scenario rainfall. The shaded band is a heuristic uncertainty envelope (±0.6%·√h, widened per scenario), not a statistical or ML prediction interval. Permeability enters only through the curve numbers, so infiltration is never counted twice.</div>`;
}

// ---------- water availability ----------
function renderStatus() {
  const pct = S.volume / CAP, T = THRESHOLDS(S), st = supplyStatus(), svc = S.svc;
  levelGauge($('#donut'), pct, levelColor(S.volume), T.map(t => ({ p: t.v / CAP, color: t.color, dash: t.key === 'critical' })));
  $('#dPct').textContent = (pct * 100).toFixed(1) + '%';
  $('#dPct').style.color = levelColor(S.volume);
  const ss = $('#supState'); ss.className = `supstate lv-${st.lv}`; ss.textContent = st.label; ss.title = st.reason;
  const v72 = fc[72].v;
  const k = (label, val, extra = '', tip = '') => `<div title="${tip}"><small>${label}</small><b>${val}${extra ? `<em>${extra}</em>` : ''}</b></div>`;
  $('#avail').innerHTML =
    k('Current volume', `${fmt(S.volume)} m³`, `/ ${fmt(CAP)}`) +
    k('Usable water', `${fmt(Math.max(0, S.volume - DEAD))} m³`, '', `Above dead storage: ${fmt(DEAD)} m³ cannot be pumped`) +
    k('Days of supply', daysTxt(daysToLow(fcLong)), '', 'Until the 15% critical level at the current scenario') +
    k('Demand today', `${fmt(svc.demand)} m³`, '/day') +
    k('Deliverable supply', `${fmt(svc.supply)} m³`, `/day · ${pctf(svc.ratio)}`, 'Smaller of pump capacity and releasable water, per service area') +
    k('Storage in 72 h', `${fmt(v72)} m³`, `${pctf(v72 / CAP)}`);
  const state = {
    overflow: () => S.spilling ? ['Spilling', 'crit'] : (h => h !== null ? [`in ~${fmtH(h)}`, 'hot'] : ['Clear', ''])(fc.firstAbove(CAP)),
    flood: () => S.volume >= CRIT ? ['Exceeded', 'crit'] : (h => h !== null ? [`in ~${fmtH(h)}`, 'hot'] : ['Clear', ''])(fc.firstAbove(CRIT)),
    rotation: () => S.rotActive ? ['Active', 'rot'] : S.rotMode === 'off' ? ['Disabled', S.volume < S.rotThr ? 'crit' : ''] : (h => h !== null ? [`in ~${fmtH(h)}`, 'hot'] : ['Standby', ''])(fcNo.firstBelow(S.rotThr)),
    critical: () => S.volume < LOW ? ['Breached', 'crit'] : (h => h !== null ? [`in ~${fmtH(h)}`, 'hot'] : ['Clear', ''])(fc.firstBelow(LOW)),
  };
  $('#thrstrip').innerHTML = T.map(t => { const [txt, cls] = state[t.key](); return `<span class="${cls}" title="${t.name} · ${fmt(t.v)} m³">${lineSample(t, 16)}${t.short} ${Math.round(t.v / CAP * 100)}% · ${txt}</span>`; }).join('');
}

// ---------- demand ----------
function renderConsumption() {
  const svc = S.svc, hhDay = svc.rows.filter(r => r.households).reduce((s, r) => s + r.demand, 0), comDay = svc.rows.find(r => r.ent === 'commercial').demand;
  const lv = svc.ratio >= 1.1 ? 'green' : svc.ratio >= 0.95 ? 'yellow' : 'orange';
  $('#ckpis').innerHTML = `
    <div title="${fmt(hhDay * 1000 / sim.HOUSEHOLDS)} L per household per day"><b style="color:#5fb0ff">${fmt(hhDay)}</b><small>Homes m³/day</small></div>
    <div title="126 establishments"><b style="color:#ff9f43">${fmt(comDay)}</b><small>Business m³/day</small></div>
    <div><b>${fmt(svc.demand)}</b><small>Total m³/day</small></div>
    <div class="sdbar" style="grid-column:1/-1"><span>Supply vs demand</span><span class="gauge"><i style="width:${Math.min(100, svc.ratio * 50)}%;background:${LV_COL[lv]}"></i><u style="left:50%"></u></span><b style="color:${LV_COL[lv]}">${pctf(svc.ratio)}</b><small>${svc.ratio >= 1.1 ? 'supply > demand' : svc.ratio >= 0.95 ? 'supply ≈ demand' : 'supply < demand'}${S.rotActive ? ' · rationed' : ''}${svc.demand - svc.delivered > 1 ? ` · unserved ${fmt(svc.demand - svc.delivered)} m³/d` : ''}</small></div>`;
  consumptionChart($('#cchart'), S.cons.slice(-range));
}

// ---------- service-area supply vs demand ----------
const ST_TXT = { surplus: '▲ SURPLUS', balanced: '● BALANCED', shortage: '▼ SHORTAGE', none: '✕ NO SUPPLY' };
const ST_COL = { surplus: '#2ee66f', balanced: '#f5c542', shortage: '#ff9f43', none: '#ff4d57' };
function renderAreas() {
  const el = $('#areas');
  if (el.contains(document.activeElement)) return;
  const r = rotNow();
  const opts = ['auto', 'on', 'off'].map(m => `<option value="${m}" ${S.rotMode === m ? 'selected' : ''}>${{ auto: `Auto (< ${Math.round(S.rotThr / CAP * 100)}%)`, on: 'On', off: 'Off' }[m]}</option>`).join('');
  const bar = S.rotActive
    ? `<div class="rotbar on"><b>RATIONING</b><span>${r.grp.name} on until ${r.until}</span><select data-rotmode>${opts}</select></div>`
    : `<div class="rotbar"><span class="muted">Rationing: standby</span><select data-rotmode>${opts}</select></div>`;
  const rows = [...S.svc.rows].sort((a, b) => (sortBy === 'gap' ? a.ratio - b.ratio || b.demand - a.demand : b.demand - a.demand));
  const pumpTxt = rr => { const p = S.pumps.find(x => x.id === rr.pump).short, bk = rr.backup && S.pumps.find(x => x.id === rr.backup).short; return rr.viaBackup ? `via backup ${bk}` : bk ? `${p} · backup ${bk}` : p; };
  el.innerHTML = (S.rotActive || S.rotMode !== 'auto' ? bar : '') + `<div class="ahead"><span>Service area</span><span class="num" title="m³ per day">Demand</span><span class="num" title="Deliverable m³ per day">Supply</span><span>Supply ÷ demand</span></div>` +
    rows.map(rr => {
      const sub = rr.households ? `${fmt(rr.households)} hh · ${fmt(rr.delivered * 1000 / rr.households)} L/hh delivered · ${pumpTxt(rr)}` : `${rr.establishments} establishments · ${pumpTxt(rr)}`;
      return `<div class="arow" data-area="${rr.ent}" title="${ZONES[rr.zone].name}: limited by ${S.svc.zones[rr.zone].limit}"><span><b>${rr.name}</b><small class="hhn">${sub}</small></span>
        <span class="num">${fmt(rr.demand)}</span><span class="num">${fmt(rr.supply)}</span>
        <span class="sd"><span class="sdst st-${rr.status}">${ST_TXT[rr.status]} ${rr.status === 'none' ? '' : pctf(rr.ratio)}</span><span class="rbar"><i style="width:${Math.min(100, rr.ratio * 50)}%;background:${ST_COL[rr.status]}"></i><u></u></span></span></div>`;
    }).join('');
}

// ---------- distribution ----------
function renderPumps() {
  const col = { running: '#2ee66f', standby: '#ff9f43', failed: '#ff3b3b' };
  const btn = p => p.status === 'failed'
    ? `<button class="btn pbtn" data-act="repair" data-id="${p.id}">Repair</button>`
    : `<button class="btn pbtn ${p.status === 'running' ? 'red' : ''}" data-act="toggle" data-id="${p.id}">${p.status === 'running' ? 'Stop' : 'Start'}</button><button class="btn pbtn red" data-act="fail" data-id="${p.id}" title="Simulate a failure of ${p.short}">Fail</button>`;
  let h = S.pumps.map(p => `<div class="prow" data-pump="${p.id}">
    <div class="pimg" style="color:${col[p.status]}"><svg><use href="#i-pump"/></svg></div>
    <div class="pinfo">
      <div class="pline"><b>${p.short}</b><span class="st ${p.status}">${p.status[0].toUpperCase() + p.status.slice(1)}</span>${btn(p)}</div>
      <div class="pgrid"><span>Flow <b>${fmt(p.q)}/${p.flow} m³/h</b></span>${spark(p.flowHist, col[p.status])}<span>Runtime <b>${p.status === 'running' ? hms(p.runtime) : '--:--:--'}</b></span></div>
    </div></div>`).join('');
  const p1 = S.pumps[0];
  if (sim.DEMO_AUTO_SHUTDOWN && p1.status === 'running' && p1.shutdownMin !== null)
    h += `<div class="alarm" data-pump="PUMP-01"><svg><use href="#i-warn"/></svg><div><b>PUMP A RUNTIME LIMIT (demo)</b><small>Scripted auto-shutdown to show<br>failover to Pump B</small></div><div class="cd">SHUTDOWN IN<br><b>${p1.shutdownMin} MIN</b></div></div>`;
  $('#pumps').innerHTML = h;
}

const STATE_COL = { normal: '#2ee66f', backup: '#ffb347', out: '#ff3b3b', shortage: '#ff6b3d' };
let netSig = '';
function renderNetwork() {
  const el = $('#pumpNet');
  if (el.hidden) return;
  const nw = S.m.nw, [pa, pb, pc] = S.pumps, v = S.valves, auto = S.valveMode === 'auto', zs = S.svc.zones;
  const ln = {
    raw: S.m.treat > 0 ? 'raw' : 'dead', treat: S.m.treat > 0 ? 'normal' : 'dead',
    clearA: pa.status === 'running' ? 'normal' : 'dead', clearB: pb.status === 'running' ? 'normal' : 'dead', clearC: pc.status === 'running' ? 'normal' : 'dead',
    cDown: pc.status === 'running' ? 'normal' : 'dead',
    aUp: nw.aOut ? (nw.flow === 'AtoB' ? 'backup' : 'normal') : 'dead', bUp: nw.bOut ? (nw.flow === 'BtoA' ? 'backup' : 'normal') : 'dead',
    aDown: nw.areaA === 'A' ? 'normal' : nw.areaA === 'B' ? 'backup' : 'dead',
    bDown: nw.areaB === 'B' ? 'normal' : nw.areaB === 'A' ? 'backup' : 'dead',
    cross: nw.flow ? 'backup' : 'idle',
  };
  const twsPct = Math.round(S.treated / sim.TWS_CAP * 100);
  const sig = JSON.stringify([ln, v, pa.status, pb.status, pc.status, auto, zs.A.status, zs.B.status, zs.C.status, Math.round(zs.A.ratio * 20), Math.round(zs.B.ratio * 20), Math.round(zs.C.ratio * 20), twsPct, Math.round(S.m.treat / 10), Math.round(S.volume / CAP * 100)]);
  if (sig !== netSig) {
    netSig = sig;
    const pump = (p, x, y, ly) => {
      const c = { running: '#2ee66f', standby: '#ffa43a', failed: '#ff3b3b' }[p.status];
      return `<g class="pmp" data-pump="${p.id}"><circle cx="${x}" cy="${y}" r="10" fill="#0b2240" stroke="${c}" stroke-width="2.2"/>
        <path d="M${x - 4},${y - 5} L${x + 6},${y} L${x - 4},${y + 5} Z" fill="${c}"/>
        ${p.status === 'failed' ? `<path d="M${x - 9},${y - 9} L${x + 9},${y + 9} M${x + 9},${y - 9} L${x - 9},${y + 9}" stroke="#ff3b3b" stroke-width="2.6"/>` : ''}
        <text x="${x}" y="${ly}" text-anchor="middle" class="lbl">${p.short.toUpperCase()} ${p.status === 'failed' ? '· FAILED' : p.status === 'running' ? `· ${pctf(p.q / p.flow)}` : '· STANDBY'}</text></g>`;
    };
    const valve = (id, x, y, vert, lx, ly, anchor = 'middle', stack = false) => {
      const open = v[id], s = 7;
      const pts = vert
        ? [`${x - 5},${y - s} ${x + 5},${y - s} ${x},${y}`, `${x - 5},${y + s} ${x + 5},${y + s} ${x},${y}`]
        : [`${x - s},${y - 5} ${x - s},${y + 5} ${x},${y}`, `${x + s},${y - 5} ${x + s},${y + 5} ${x},${y}`];
      return `<g class="vlv ${open ? 'open' : 'closed'}" data-valve="${id}"><polygon points="${pts[0]}"/><polygon points="${pts[1]}"/><rect x="${x - 9}" y="${y - 9}" width="18" height="18" fill="transparent"/>
        <text x="${lx}" y="${ly}" text-anchor="${anchor}" class="sm"><tspan class="lbl" style="font-size:7.5px">${sim.VALVES[id].name}</tspan> <tspan ${stack ? `x="${lx}" dy="8"` : ''} fill="${open ? '#2ee66f' : '#ff7b84'}">${open ? 'OPEN' : 'CLOSED'}</tspan></text></g>`;
    };
    const area = (zn, sel, y) => {
      const st = zn.status === 'none' ? 'out' : zn.status === 'shortage' ? 'shortage' : zn.viaBackup ? 'backup' : 'normal';
      const txt = zn.status === 'none' ? 'NO SUPPLY' : zn.viaBackup ? `BACKUP · Pump ${zn.supplier} · ${pctf(zn.ratio)}` : `${pctf(zn.ratio)} of demand`;
      return `<g class="areabox" data-sel="${sel}"><rect x="226" y="${y}" width="101" height="36" rx="5" fill="${st === 'normal' ? '#0b2240' : st === 'out' ? '#2a1017' : '#2c1d0e'}" stroke="${STATE_COL[st]}" stroke-width="${st === 'normal' ? 1 : 1.8}"/>
        <text x="232" y="${y + 11}" class="lbl">${zn.name.toUpperCase()}</text><text x="232" y="${y + 20}" class="sm">${zn.label}</text>
        <text x="232" y="${y + 30}" class="sm" style="font-weight:700" fill="${STATE_COL[st]}">${txt}</text></g>`;
    };
    const node = (sel, x, w, stroke, l1, l2, l3) => `<g data-sel="${sel}" style="cursor:pointer"><rect x="${x}" y="54" width="${w}" height="40" rx="5" fill="#0b2240" stroke="${stroke}"/>
      <text x="${x + w / 2}" y="66" text-anchor="middle" class="lbl">${l1}</text><text x="${x + w / 2}" y="76" text-anchor="middle" class="sm">${l2}</text><text x="${x + w / 2}" y="87" text-anchor="middle" class="sm">${l3}</text></g>`;
    const path = (d, st, rev) => `<path class="ln ln-${st}${rev ? ' rev' : ''}" d="${d}"/>`;
    // raw reservoir -> WTP -> treated storage -> common header -> Pump A / B / C -> Service Area A / B / C (A/B cross-connection)
    const svg = `<svg class="netsvg" viewBox="0 0 330 152" preserveAspectRatio="xMidYMid meet">
      ${path('M32,74 H38', ln.raw)}${path('M64,74 H70', ln.treat)}
      ${path('M110,74 H118 M118,20 V133', 'normal')}
      ${path('M118,20 H130', ln.clearA)}${path('M118,78 H130', ln.clearB)}${path('M118,133 H130', ln.clearC)}
      ${path('M150,20 H158 M172,20 H186', ln.aUp)}${path('M191,20 H226', ln.aDown)}
      ${path('M150,78 H158 M172,78 H186', ln.bUp)}${path('M191,78 H226', ln.bDown)}
      ${path('M150,133 H226', ln.cDown)}
      ${path('M188,23 V34 M188,48 V52 M188,66 V75', ln.cross, nw.flow === 'BtoA')}
      <circle cx="188" cy="20" r="3" fill="#9fd3ff"/><circle cx="188" cy="78" r="3" fill="#9fd3ff"/>
      ${node('reservoir', 2, 30, '#3fb7c4', 'RAW', 'RES.', `${Math.round(S.volume / CAP * 100)}%`)}
      ${node('wtp', 38, 26, '#2ee6d6', 'WTP', 'treat', `${fmt(S.m.treat)}`)}
      ${node('tws', 70, 40, '#5fd0ff', 'TREATED', 'STORAGE', `${twsPct}%`)}
      <text x="3" y="112" class="sm">raw water ┄ treated water ━</text><text x="3" y="122" class="sm">XV-1 / XV-2: A↔B backup</text>
      <text x="190" y="128" class="sm">no backup</text><text x="118" y="149" class="sm">common header · treated water</text>
      ${pump(pa, 140, 20, 7)}${pump(pb, 140, 78, 65)}${pump(pc, 140, 133, 120)}
      ${valve('IVA', 165, 20, false, 165, 33)}${valve('IVB', 165, 78, false, 165, 92)}
      ${valve('XV1', 188, 41, true, 195, 40, 'start', true)}${valve('XV2', 188, 59, true, 195, 58, 'start', true)}
      ${area(zs.A, 'residential', 2)}${area(zs.B, 'divisoria', 60)}${area(zs.C, 'poblacion', 115)}
    </svg>`;
    const failBtn = pa.status === 'failed'
      ? `<button class="btn" data-act="repair" data-id="PUMP-01"><svg><use href="#i-check"/></svg>Repair Pump A</button>`
      : `<button class="btn red" data-act="fail" data-id="PUMP-01"><svg><use href="#i-warn"/></svg>Fail Pump A (simulate)</button>`;
    el.innerHTML = svg + `<div class="netctl">${failBtn}<button class="btn" data-act="focusnet" title="Show the network on the 3D map"><svg><use href="#i-pin"/></svg>Map</button>
      <div class="seg" title="Valve control mode"><button data-vm="auto" class="${auto ? 'active' : ''}">Auto valves</button><button data-vm="manual" class="${auto ? '' : 'active'}">Manual</button></div></div>
      <div class="impact" id="impact"></div>`;
  }
  renderImpact();
}
// supply impact of the current pump state: affected areas, lost and backup capacity, unserved demand, reroute, action
function renderImpact() {
  const el = $('#impact');
  if (!el) return;
  const zs = S.svc.zones, nw = S.m.nw, cov = sim.backupCoverage(S);
  const down = S.pumps.slice(0, 2).filter(p => p.status !== 'running');
  const pc = S.pumps[2];
  if (!down.length && pc.status !== 'running') {
    const zc = zs.C;
    el.className = 'impact crit';
    el.innerHTML = `<span><b>Pump C ${pc.status === 'failed' ? 'failed' : 'offline'}</b> → affects <b>${zc.name}</b> (${zc.label}, ${fmt(zoneHH('C'))} hh) · lost <b>${pc.flow} m³/h</b></span>
      <span>Pump C has <b>no backup route</b> (independent branch from treated storage) · unserved <b>${fmt(zc.unserved / 24)} m³/h</b></span>
      <span class="rec">Recommended: restart or repair Pump C; prioritise households in Service Area C.</span>`;
    return;
  }
  if (!down.length) {
    el.className = 'impact';
    el.innerHTML = `<span><b>Normal distribution</b> from treated storage (${pctf(S.treated / sim.TWS_CAP)}). Pump A ${pctf(S.pumps[0].q / S.pumps[0].flow)} · Pump B ${pctf(S.pumps[1].q / S.pumps[1].flow)} · Pump C ${pctf(S.pumps[2].q / S.pumps[2].flow)} load</span>
      <span>If one pump fails, the other covers <b>${pctf(cov.cover)}</b> of Area A+B peak demand (${fmt(cov.need)} vs ${fmt(cov.rated)} m³/h) · ${cov.nPlus1 ? 'N+1 verified' : `<span class="rec">BACKUP CAPACITY INSUFFICIENT: ${fmt(cov.unserved)} m³/h short at peak</span>`}</span>`;
    return;
  }
  const p = down[0], other = S.pumps.find(x => x.id !== p.id && x.id !== 'PUMP-03');
  const zn = zs[p.zone];
  const backup = other.status === 'running' ? other.flow : 0, covered = Math.min(backup, cov.need), short = cov.need - covered;
  const unservedNow = zn.status === 'none' ? zn.demand / 24 : S.svc.peakDeficit;
  const route = valveTimer ? 'valve sequence in progress…' : nw.flow ? `reroute complete via XV-1/XV-2 (${S.valveMode === 'auto' ? 'automatic' : 'manual'})` : S.valveMode === 'manual' ? 'MANUAL: open XV-1 and XV-2' : other.status !== 'running' ? 'no backup pump available' : 'pending';
  el.className = `impact ${zn.status === 'none' ? 'crit' : 'bad'}`;
  el.innerHTML = `<span><b>${p.short} ${p.status === 'failed' ? 'failed' : 'offline'}</b> → affects <b>${zn.name}</b> (${zn.label}, ${fmt(zoneHH(p.zone))} hh) · lost <b>${p.flow} m³/h</b></span>
    <span>Affected peak demand <b>${fmt(cov.need)}</b> · backup ${other.short} <b>${fmt(backup)}</b> · covered <b>${fmt(covered)}</b> · unserved <b>${fmt(short)} m³/h</b> · coverage <b>${pctf(covered / cov.need)}</b>${short > 0.5 ? ' · <span class="rec">BACKUP CAPACITY INSUFFICIENT</span>' : ''}</span>
    <span>Now: ${zn.status === 'none' ? `<b>${zn.name} unsupplied (${fmt(unservedNow)} m³/h)</b>` : `unserved ${fmt(unservedNow)} m³/h at peak`} · ${route}</span>
    <span class="rec">Recommended: ${zn.status === 'none' ? 'open the cross-connection (XV-1/XV-2) to back-feed the area' : unservedNow > 1 ? 'prioritize households; shift commercial use off-peak; repair ' + p.short : 'repair ' + p.short + '; monitor pressure at network ends'}</span>`;
}

// automatic valve controller, one operation at a time:
// 1) isolate pumps that are not running, 2) open (make-before-break, healthy side first), 3) close the rest
let valveTimer = null;
function nextValveOp() {
  const target = sim.autoValveTarget(S);
  const ops = Object.keys(target).filter(k => S.valves[k] !== target[k]);
  if (!ops.length) return null;
  const isolate = ops.find(k => !target[k] && sim.VALVES[k].pump && S.pumps.find(p => p.id === sim.VALVES[k].pump).status !== 'running');
  if (isolate) return [isolate, false];
  const bHealthy = S.pumps[1].status === 'running';
  const open = (bHealthy ? ['IVA', 'IVB', 'XV2', 'XV1'] : ['IVA', 'IVB', 'XV1', 'XV2']).find(k => ops.includes(k) && target[k]);
  if (open) return [open, true];
  return [ops[0], false];
}
function syncValves() {
  if (S.valveMode !== 'auto' || valveTimer || !nextValveOp()) return;
  valveTimer = setTimeout(function stepValve() {
    const op = S.valveMode === 'auto' ? nextValveOp() : null;
    if (!op) { valveTimer = null; netSig = ''; update(); return; }
    sim.setValve(S, op[0], op[1]);
    toast(`Automatic control: ${sim.VALVES[op[0]].name} ${op[1] ? 'OPENED' : 'CLOSED'}`);
    update();
    valveTimer = setTimeout(stepValve, 1500);
  }, 1300);
}
function failPump(id) {
  const p = S.pumps.find(x => x.id === id);
  sim.failPump(S, id);
  toast(`${p.short.toUpperCase()} FAILURE (simulated): ${!p.iv ? `${S.svc.zones[p.zone].name} has no backup route` : S.valveMode === 'auto' ? 'automatic reroute starting' : 'valves in MANUAL, reroute required'}`);
  gl.focusNetwork();
  dismissed.clear();
  update();
  syncValves();
}

// ---------- 3D twin sync ----------
function areaState(zn) { return zn.status === 'none' ? 'out' : zn.status === 'shortage' ? 'shortage' : zn.viaBackup ? 'backup' : 'normal'; }
function renderMap() {
  const m = S.m, pct = S.volume / CAP, zs = S.svc.zones;
  gl.setWater(pct);
  gl.setSeason(S.scenario === 'dry' ? 'dry' : '');
  gl.setRain(SCEN[S.scenario].rain);
  gl.setLabel('reservoir', S.spilling ? `FULL · spilling ${fmt(S.spillRate)} m³/h` : `${fmt(S.volume)} m³ · ${pctf(pct)} stored`, S.spilling || S.volume >= CRIT || S.volume < LOW ? 'crit' : S.volume >= 80000 || S.volume < S.rotThr ? 'warn' : '');
  gl.setLabel('forest', m.P < 1 ? 'No rain · baseflow only' : `Runoff ${fmt(m.runoff)} m³/h (est.) · ${pctf(m.Q / m.P)} of rain`);
  gl.setLandUse(S.lu.tau);
  $('#permStat').textContent = `composite CN(II) ${S.lu.cn2.toFixed(1)} · forest ${(S.lu.forestCover * 100).toFixed(0)}% · cleared ${(S.lu.clearedArea * 100).toFixed(0)}%`;
  gl.setLabel('intake', m.pumpIn > 0 ? `Intake ${fmt(m.pumpIn)} m³/h` : S.scenario === 'heavy' ? 'Paused · turbidity' : 'Off');
  const r = rotNow(), nw = m.nw, [pa, pb, p3] = S.pumps;
  const rotOff = ent => S.rotActive && ROT_GROUPS.findIndex(g => g.ents.includes(ent)) !== r.g;
  const lvl = p => Math.max(0.25, clamp01(p.q / p.flow));
  const supply = (supplier, own, ent) => !supplier || rotOff(ent) ? 0 : { i: 0.6, color: supplier === own ? gl.CYAN : gl.AMBER };
  const tr = m.treat > 0 ? Math.max(0.3, clamp01(m.treat / 400)) : 0;
  gl.setFlows({
    runoff: clamp01(m.runoff / 1500), riverIn: Math.max(0.08, clamp01(m.inflow / 1500)), riverOut: S.spilling ? 1 : 0.2, pumpIn: m.pumpIn > 0 ? 0.5 : 0,
    raw: tr, treat: tr,                                                  // raw main -> WTP -> treated storage
    clearA: nw.aOut ? lvl(pa) : 0, clearB: nw.bOut ? lvl(pb) : 0, clearC: p3.status === 'running' ? lvl(p3) : 0,
    'A-up': nw.aOut ? { i: lvl(pa), color: nw.flow === 'AtoB' ? gl.AMBER : gl.CYAN } : 0,
    'B-up': nw.bOut ? { i: lvl(pb), color: nw.flow === 'BtoA' ? gl.AMBER : gl.CYAN } : 0,
    'A-down': supply(nw.areaA, 'A', 'residential'), 'A-ext': supply(nw.areaA, 'A', 'rizal'),
    'B-down': supply(nw.areaB, 'B', 'divisoria'),
    cross: nw.flow ? { i: 0.85, color: gl.AMBER, reverse: nw.flow === 'BtoA' } : 0,
    'C-down': p3.status === 'running' && !rotOff('poblacion') ? lvl(p3) : 0, 'P3-ext': p3.status === 'running' && !rotOff('mabini') ? lvl(p3) : 0,
  });
  const pipeSt = (supplier, own) => !supplier ? 'dead' : supplier === own ? 'normal' : 'backup';
  [['clearA', nw.aOut ? 'normal' : 'dead'], ['A-up', nw.aOut ? 'normal' : 'dead'], ['clearB', nw.bOut ? 'normal' : 'dead'], ['B-up', nw.bOut ? 'normal' : 'dead'],
    ['A-down', pipeSt(nw.areaA, 'A')], ['A-ext', pipeSt(nw.areaA, 'A')], ['B-down', pipeSt(nw.areaB, 'B')],
    ['cross', nw.flow ? 'backup' : 'idle'], ['clearC', p3.status === 'running' ? 'normal' : 'dead'], ['C-down', p3.status === 'running' ? 'normal' : 'dead'], ['P3-ext', p3.status === 'running' ? 'normal' : 'dead'],
    ['treat', m.treat > 0 ? 'normal' : 'dead']]
    .forEach(([k, s]) => gl.setPipeStyle(k, s));
  Object.keys(S.valves).forEach(k => gl.setValve(k, S.valves[k], sim.VALVES[k].normal));
  S.pumps.forEach(p => {
    gl.setPump(p.id, p.status);
    gl.setLabel(p.id, p.status === 'failed' ? 'FAILED · offline' : p.status === 'running' ? `${pctf(p.q / p.flow)} load` : 'Standby');
  });
  gl.setLabel('wtp', m.treat > 0 ? `Treating ${fmt(m.treat)} m³/h${m.treatLimited ? ' · raw water short' : ''}` : 'Idle · no raw water', m.treatLimited ? 'warn' : '');
  gl.setLabel('tws', `${fmt(S.treated)} m³ · ${pctf(S.treated / sim.TWS_CAP)}`, S.treated <= sim.TWS_DEAD + 1 ? 'crit' : S.treated < 0.3 * sim.TWS_CAP ? 'warn' : '');
  S.svc.rows.forEach(rr => {
    const zn = zs[rr.zone], st = areaState(zn);
    gl.setAreaState(rr.ent, st);
    if (st === 'out') return gl.setLabel(rr.ent, 'NO SUPPLY', 'out');
    if (st === 'shortage') return gl.setLabel(rr.ent, `Shortage · ${pctf(zn.ratio)} of demand`, 'short');
    if (st === 'backup') return gl.setLabel(rr.ent, `Backup via Pump ${zn.supplier}`, 'backup');
    const g = ROT_GROUPS.findIndex(x => x.ents.includes(rr.ent));
    if (S.rotActive) return gl.setLabel(rr.ent, g === r.g ? `Supplied until ${r.until}` : `Off · next ${clock(sim.rotNextStart(S.t, g))}`, g === r.g ? 'on' : 'off');
    gl.setLabel(rr.ent, zn.status === 'balanced' ? `Supply ≈ demand (${pctf(zn.ratio)})` : '', zn.status === 'balanced' ? 'bal' : 'ok');
  });
  $('.panel.map').classList.toggle('storm', S.scenario === 'heavy');
  $('.panel.map').classList.toggle('dry', S.scenario === 'dry');
}

const VN = { natural: 'Natural palette · simulated terrain', '3d': 'Schematic digital twin · simulated terrain', topo: 'Topographic view · simulated terrain', '2d': 'Plan view · simulated terrain' };
// map subtitle: a real GIS study area is always paired with the simulated-twin caveat; the fallback names itself
const viewLine = view => (SA.mode === 'gis' ? `${SA.displayLabel} · ${VN[view]}` : `${VN[view]} · ${SA.boundaryLabel}`);
function renderStudyArea() {
  $('#saName').textContent = SA.name.toUpperCase();
  $('#saLoc').textContent = SA.name;
  const st = $('#saStatus'); st.textContent = SA.mode === 'gis' ? (SA.gisStatus === 'VERIFIED' ? 'GIS BOUNDARY · APPROX. POSITION' : `GIS ${SA.gisStatus}`) : 'GIS PENDING'; st.dataset.s = SA.mode === 'gis' ? SA.gisStatus : 'PENDING';
  st.title = SA.mode === 'gis' ? 'Boundary shape and area follow Proclamation No. 413 (verified against the legal text). Absolute position is approximate, about ±100–200 m, because the Proclamation does not state the datum of its tie point.' : 'No GIS boundary loaded';
  $('#viewName').textContent = viewLine('3d');
  $('#bndLabel').textContent = SA.mode === 'gis' ? 'Study-area boundary (GIS)' : 'Watershed boundary (simulated)';
  const cat = SA.hydro?.catchment;
  if (cat) {
    $('#catLabel').textContent = cat.validated ? 'Op. catchment' : 'DEM catchment ⚠';
    $('#catSwatch').classList.toggle('dashed', !cat.validated);
    $('#catRow').title = cat.validated ? 'Validated DEM-derived contributing catchment. Its area drives the runoff model.'
      : `Candidate DEM-derived catchment of an unverified DEM outlet — NOT validated (${cat.failed.filter(f => !f.startsWith('status')).join(', ')}). Shown for review only; the model uses ${SA.operational.km2.toFixed(2)} km² (${SA.operational.source}).`;
  }
  $('#bndSwatch').style.background = SA.mode === 'gis' ? '#2ee6d6' : '#2ee66f';
  $('.map-title').title = `${SA.nameStatus}\n${SA.boundaryLabel}\nOperational catchment: ${SA.operational.label}\nClick for GIS details`;
  document.title = `Watershed Command Center · ${SA.name} (simulation)`;
}
renderStudyArea();

function renderWeather() {
  const sc = SCEN[S.scenario];
  $('#wxTemp').textContent = sc.temp + ' °C';
  $('#wxDesc').textContent = sc.wx;
  const drops = Array.from({ length: sc.rain * 2 }, (_, i) => `<path d="M${10 + i * 5} 25l-2 5" stroke="#6fb8ff" stroke-width="1.5" stroke-linecap="round"/>`).join('');
  const rays = Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return `<path d="M${20 + Math.cos(a) * 10} ${16 + Math.sin(a) * 10}L${20 + Math.cos(a) * 14} ${16 + Math.sin(a) * 14}" stroke="#f5c542" stroke-width="2" stroke-linecap="round"/>`; }).join('');
  $('#wxIcon').innerHTML = sc.rain === 0
    ? `<svg viewBox="0 0 40 32" width="40" height="32"><circle cx="20" cy="16" r="7" fill="#f5c542"/>${rays}</svg>`
    : `<svg viewBox="0 0 40 32" width="40" height="32"><path d="M10 21a6 6 0 0 1 1-12 8 8 0 0 1 15-1 7 7 0 0 1 2 13z" fill="#cfd8e3"/>${drops}</svg>`;
  $('#wxTime').textContent = 'Sim time · ' + new Date(S.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + new Date(S.t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Phase 2B rows for the GIS panel (empty when no hydrology data is configured)
function hydroRows() {
  const h = SA.hydro;
  if (!h) return [];
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  const cat = h.catchment;
  return [
    row('DEM', '<small>Copernicus GLO-30 DSM · 30 m · EPSG:4326 / EGM2008</small>'),
    row('DEM catchment', cat ? `${cat.gis.areaKm2.toFixed(2)} km² · <b style="color:${cat.validated ? '#2ee66f' : '#ffb36b'}">${cat.validated ? 'validated' : 'not validated'}</b>` : '<span class="muted">unavailable</span>'),
    row('Outlet', h.outlet ? (h.outlet.props.label ?? h.outlet.name) : '<span class="muted">unavailable</span>'),
    ...(h.errors.length ? [`<small style="color:#ffb36b">⚠ ${h.errors.join('; ')}</small>`] : []),
  ];
}

// ---------- selection card ----------
function infoHtml(id) {
  const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
  const m = S.m, svc = S.svc;
  if (id === 'studyarea') {
    const g = SA.gis, md = SA.metadata ?? {}, na = '<span class="muted">not supplied</span>';
    const stated = g && Number.isFinite(md.areaStatedHa) ? ` <small class="muted">· stated ${md.areaStatedHa.toFixed(1)} ha</small>` : '';
    return [SA.name, `<small class="muted">${SA.nameStatus}</small>`,
      row('Study area', `<b>${SA.name}</b>`),
      row('Boundary type', g ? (SA.studyAreaType ?? g.boundaryType) : 'procedural outline (fallback)'),
      row('Displayed boundary', `<b>${SA.boundaryLabel}</b>`),
      row('GIS status', `<b style="color:${{"VERIFIED":"#2ee66f","PENDING":"#f5c542","SIMULATED":"#ffb36b"}[SA.gisStatus]}">${SA.mode === 'gis' ? SA.gisStatus : 'PENDING DATA'}</b>`),
      ...(g && md.legalBasis ? [row('Legal basis', md.legalBasis)] : []),
      row('Source', SA.mode === 'gis' ? (SA.boundarySource ?? na) : na), row('Source URL', SA.boundarySourceUrl ? `<a href="${SA.boundarySourceUrl}" target="_blank" rel="noopener">${SA.boundarySourceUrl}</a>` : na),
      row('CRS', g ? g.crs : na), row('Area', g ? `${(g.areaKm2 * 100).toFixed(1)} ha · ${g.areaKm2.toFixed(3)} km²${stated} <small class="muted">(${g.areaMethod})</small>` : na),
      ...(g && md.positionalAccuracy ? [row('Geometry', `<small>${md.geometryDerivation ? 'Plotted from the legal technical description. ' : ''}Position approximate (tie-point datum not stated).</small>`)] : []),
      row('Retrieved', SA.retrieved ?? na),
      row('Operational catchment', `${SA.operational.km2.toFixed(2)} km² · <small>${SA.operational.label}</small>`),
      ...hydroRows(),
      row('Terrain', SA.twin?.terrain ?? 'Procedural simulation'),
      row('Infrastructure', SA.twin?.infrastructure ?? 'Schematic / simulated'),
      ...(g ? [row('Scene transform', `<small>${g.transform.method}; ${g.transform.metresPerUnit.toFixed(1)} m/unit, ${g.transform.fit}</small>`)] : []),
      ...(SA.fallbackReason ? [`<small style="color:#f5d96a">Fallback reason: ${SA.fallbackReason}</small>`] : []),
      ...SA.warnings.map(w => `<small style="color:#ffb36b">⚠ ${w}</small>`)];
  }
  if (id === 'outlet') {
    const o = SA.hydro.outlet, cat = SA.hydro.catchment, m = cat?.meta?.outlet ?? {};
    return [o.props.label ?? o.name, '<small class="muted">Candidate only: the DEM channel cell nearest the published Kulador Treatment Plant coordinate. The actual intake / spillway location is not verified, so this is not a confirmed outlet. The simulated reservoir, pumps and intake are not at this location.</small>',
      row('Plant coordinate source', m.sourceUrl ? `<a href="${m.sourceUrl}" target="_blank" rel="noopener">Catbalogan Water District</a>` : 'Catbalogan Water District'),
      row('Kulador Treatment Plant (published)', m.published ? `${m.published.lat.toFixed(5)}, ${m.published.lon.toFixed(5)}` : '—'),
      row('Candidate pour point (DEM)', `${o.lonlat[1].toFixed(5)}, ${o.lonlat[0].toFixed(5)} · ${o.props.snapDistanceM} m`),
      row('Upstream area (DEM)', `${o.props.accumulationKm2.toFixed(2)} km²`),
      row('Catchment status', cat ? `<b style="color:${cat.validated ? '#2ee66f' : '#ffb36b'}">${cat.validated ? 'VALIDATED' : 'NOT VALIDATED'}</b>` : 'unavailable'),
      ...(cat && !cat.validated ? [`<small style="color:#ffb36b">Failed: ${cat.failed.filter(f => !f.startsWith('status')).map(f => (cat.meta.validation?.checks ?? []).find(c => c.id === f)?.detail ?? f).join('; ')}</small>`] : []),
      row('Model catchment area', `${SA.operational.km2.toFixed(2)} km² <small class="muted">(${SA.operational.source})</small>`)];
  }
  if (id === 'reservoir') {
    const thr = Math.round(S.rotThr / CAP * 100);
    return ['Raw-Water Reservoir', '<small class="muted">Raw (untreated) water: runoff, baseflow and river intake in; feeds only the WTP.</small>', row('Stored', `${fmt(S.volume)} m³ (${(S.volume / CAP * 100).toFixed(1)}%)`), row('Usable (above dead storage)', `${fmt(Math.max(0, S.volume - DEAD))} m³`), row('Inflow (base + runoff)', fmt(m.inflow) + ' m³/h'), row('Pumped supply', fmt(m.pumpOut) + ' m³/h'), row('Spill (not captured)', S.spilling ? `${fmt(S.spillRate)} m³/h` : 'none'), row('Net balance', sgn(m.net) + ' m³/h'),
      `<div class="thr"><b style="font-size:10px;color:#8fb2d6;letter-spacing:.6px">OPERATIONAL THRESHOLDS</b>
      ${THRESHOLDS(S).filter(t => t.key !== 'rotation').map(t => row(`${lineSample(t, 18)} ${t.name}`, `${Math.round(t.v / CAP * 100)}%`)).join('')}
      ${row(`${lineSample(THRESHOLDS(S)[2], 18)} Rationing (pump rotation)`, `<b id="thrv">${thr}% · ${fmt(S.rotThr)} m³</b>`)}<input type="range" min="20" max="60" step="5" value="${thr}" data-thr>
      ${row('Rotation mode', `<select data-rotmode>${['auto', 'on', 'off'].map(x => `<option value="${x}" ${S.rotMode === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select>`)}</div>`];
  }
  if (id.startsWith('PUMP')) {
    const p = S.pumps.find(x => x.id === id), zn = svc.zones[p.zone], cov = sim.backupCoverage(S);
    const actions = p.status === 'failed'
      ? `<button class="btn" data-act="repair" data-id="${p.id}">Repair &amp; restart</button>`
      : `<div style="display:flex;gap:6px"><button class="btn ${p.status === 'running' ? 'red' : ''}" data-act="toggle" data-id="${p.id}">${p.status === 'running' ? 'Stop pump' : 'Start pump'}</button><button class="btn red" data-act="fail" data-id="${p.id}">Simulate failure</button></div>`;
    return [p.name, row('Status', `<span class="st ${p.status}">${p.status}</span>`), row('Flow / capacity', `${fmt(p.q)} / ${p.flow} m³/h (${pctf(p.q / p.flow)} load)`), row('Serves', `${zn.name} · ${zn.label}`),
      row('Area supply / demand', `<b style="color:${ST_COL[zn.status]}">${zn.status === 'none' ? 'NO SUPPLY' : pctf(zn.ratio)}</b>`),
      row('Draws from', 'Treated Water Storage (common header)'),
      row('If unavailable', id === 'PUMP-03' ? `<b style="color:#ff7b84">${fmt(zoneHH('C'))} hh lose supply (no backup)</b>` : `backup covers ${pctf(cov.cover)} of A+B peak`), actions];
  }
  if (sim.VALVES[id]) {
    const V = sim.VALVES[id], open = S.valves[id];
    return [`Valve ${V.name}`, row('Type', V.type), row('Normal position', V.normal ? 'Open' : 'Closed'), row('Current', `<b style="color:${open ? '#2ee66f' : '#ff7b84'}">${open ? 'OPEN' : 'CLOSED'}</b>`), row('Control', S.valveMode === 'auto' ? 'Automatic' : 'Manual'),
      ...(V.pump ? [row('Interlock', `${S.pumps.find(p => p.id === V.pump).short} trips if run ${sim.INTERLOCK_S}s against this valve closed`)] : []),
      `<button class="btn" data-valve="${id}">${open ? 'Close' : 'Open'} valve${S.valveMode === 'auto' ? ' (switches to manual)' : ''}</button>`];
  }
  if (id === 'wtp') return ['Water Treatment Plant', '<small class="muted">Simulated plant: raw water in, treated water out. Processes and water quality are not modelled.</small>',
    row('Draws from', 'Raw-water reservoir (raw water)'), row('Process (schematic)', 'Coagulation → Settling → Filtration → Cl₂'),
    row('Treating now', `${fmt(m.treat)} / ${sim.WTP_CAP} m³/h`), row('Limited by', m.treatLimited ? '<b style="color:#ff9f43">raw water above dead storage</b>' : 'level control (follows pump demand)'),
    row('Feeds', 'Treated Water Storage → Pump A · B · C')];
  if (id === 'tws') return ['Treated Water Storage', '<small class="muted">Simulated clear well / ground tank. The single source for all three distribution pumps.</small>',
    row('Stored', `${fmt(S.treated)} m³ (${pctf(S.treated / sim.TWS_CAP)})`), row('Usable (above dead storage)', `${fmt(Math.max(0, S.treated - sim.TWS_DEAD))} m³`),
    row('Capacity · dead storage', `${fmt(sim.TWS_CAP)} · ${fmt(sim.TWS_DEAD)} m³`), row('Treated inflow (WTP)', `${fmt(m.treat)} m³/h`),
    row('Pumped to network', `${fmt(m.pumpOut)} m³/h`), row('Net', `${sgn(m.netT)} m³/h`), row('Supplies', 'Pump A → Area A · Pump B → Area B · Pump C → Area C'),
    ...(m.storageLimited ? ['<small style="color:#ff9f43">Pumping limited by available treated water</small>'] : [])];
  if (id === 'forest') {
    const fate = rainfate();
    return ['Upper Watershed (catchment)', row('Rainfall (scenario)', m.P.toFixed(1) + ' mm/day'), row('Runs off now (est.)', m.P < 1 ? '–' : pctf(m.Q / m.P)), row('Runoff to reservoir', fmt(m.runoff) + ' m³/h'), row('Next 72 h', fate.txt), row('Composite CN', `${m.cn.toFixed(1)} (AMC ${m.amc})`), row('Forest cover', `${(S.lu.forestCover * 100).toFixed(0)}% of catchment`), clearSlider()];
  }
  if (id === 'intake') return ['River Intake', row('Intake inflow', fmt(m.pumpIn) + ' m³/h'), row('Status', m.pumpIn > 0 ? 'Running' : S.scenario === 'heavy' ? 'Paused (turbidity, scenario rule)' : 'Off'), `<button class="btn ${S.intakeOn ? 'red' : ''}" data-act="intake">${S.intakeOn ? 'Stop intake pump' : 'Start intake pump'}</button>`];
  const rr = svc.rows.find(x => x.ent === id);
  if (!rr) return [id];
  const zn = svc.zones[rr.zone];
  return [rr.name, row('Service area', `${zn.name}${rr.households ? ` · ${fmt(rr.households)} households` : ` · ${rr.establishments} establishments`}`), row('Demand', `${fmt(rr.demand)} m³/day`), row('Deliverable supply', `${fmt(rr.supply)} m³/day`), row('Delivered now', `${fmt(rr.delivered)} m³/day`), row('Unserved', rr.unserved > 1 ? `<b style="color:#ff9f43">${fmt(rr.unserved)} m³/day</b>` : 'none'),
    row('Supply / demand', `<b style="color:${ST_COL[rr.status]}">${ST_TXT[rr.status]} ${rr.status === 'none' ? '' : pctf(rr.ratio)}</b>`), row('Limited by', zn.status === 'none' ? 'no supply path' : zn.limit),
    ...(rr.households ? [row('Delivered per household', `${fmt(rr.delivered * 1000 / rr.households)} L/day`)] : []),
    row('Primary pump', S.pumps.find(p => p.id === rr.pump).short + (rr.viaBackup ? ' (down: on backup)' : '')), row('Backup pump', rr.backup ? S.pumps.find(p => p.id === rr.backup).short + ' via cross-connection' : '<span style="color:#ff7b84">none</span>')];
}
function renderInfo() {
  const c = $('#infocard');
  if (!selected) { c.hidden = true; return; }
  if (!c.hidden && c.contains(document.activeElement) && document.activeElement.matches('input,select')) return;
  const [title, ...rows] = infoHtml(selected);
  c.hidden = false;
  c.innerHTML = `<h4>${title}<span class="x" data-close>×</span></h4>${rows.join('')}`;
}
function select(id) {
  if (!panelOpen['p-map']) togglePanel('p-map', true);               // selections are shown on the map
  selected = id;
  gl.selectLabel(id);
  gl.flyTo(id);
  renderInfo();
}

// ---------- update loop ----------
function update() {
  runForecasts();
  renderMap();
  renderQuestions();
  renderPumps();
  renderNetwork();
  renderAlerts();
  renderPredictive();
  renderStatus();
  renderWeather();
  renderAreas();
  renderConsumption();
  renderInfo();
}

setInterval(() => {
  const was = S.rotActive;
  sim.step(S, speed / 3, rng);
  update();
  if (was !== S.rotActive) toast(S.rotActive ? 'Water rationing activated: storage below threshold' : 'Storage recovered: rationing lifted');
}, 2000);
let sec = 0;
setInterval(() => {
  checkMobile();
  const ev = sim.clockTick(S, ++sec);
  if (ev.some(e => e.startsWith('trip-'))) { const p = S.pumps.find(x => 'trip-' + x.id === ev.find(e => e.startsWith('trip-'))); toast(`INTERLOCK: ${p.short} tripped (ran against closed discharge valve)`); }
  if (ev.includes('PUMP-01')) toast('Pump A reached its runtime limit (demo): rerouting Area A through Pump B');
  if (ev.length) { update(); syncValves(); }
  else {
    renderPumps(); renderImpact();
    if (S.pumps.some(p => p.deadhead > 0)) renderAlerts();
    if (selected?.startsWith('PUMP')) renderInfo();
  }
}, 1000);

// ---------- interactions ----------
document.addEventListener('click', e => {
  const t = e.target;
  const tog = t.closest('[data-act=toggle]');
  if (tog) {
    e.stopPropagation();
    const p = S.pumps.find(x => x.id === tog.dataset.id);
    if (p.status === 'running') { sim.pumpStop(S, p.id); toast(`${p.short} stopped`); } else { sim.pumpStart(S, p.id); toast(`${p.short} started`); }
    update();
    syncValves();
    return;
  }
  const act = t.closest('[data-act=fail],[data-act=repair],[data-act=focusnet]');
  if (act) {
    e.stopPropagation();
    if (act.dataset.act === 'fail') failPump(act.dataset.id);
    else if (act.dataset.act === 'repair') { sim.repairPump(S, act.dataset.id); toast(`${S.pumps.find(p => p.id === act.dataset.id).short} repaired and restarted: restoring normal valve line-up`); update(); syncValves(); }
    else gl.focusNetwork();
    return;
  }
  const vb = t.closest('[data-valve]');
  if (vb) {
    const id = vb.dataset.valve;
    if (S.valveMode === 'auto') { S.valveMode = 'manual'; clearTimeout(valveTimer); valveTimer = null; toast('Valves switched to MANUAL control'); }
    sim.setValve(S, id, !S.valves[id]);
    toast(`${sim.VALVES[id].name} ${S.valves[id] ? 'OPENED' : 'CLOSED'} (manual)`);
    update();
    return;
  }
  const vm = t.closest('[data-vm]');
  if (vm) {
    S.valveMode = vm.dataset.vm;
    if (S.valveMode === 'manual') { clearTimeout(valveTimer); valveTimer = null; }
    toast(`Valve control: ${S.valveMode.toUpperCase()}`);
    netSig = '';
    update();
    syncValves();
    return;
  }
  const q = t.closest('.q');
  if (q) {
    const n = q.dataset.q;
    if (n === '1') { flash('p-status'); select('reservoir'); }
    if (n === '2') { flash('p-predictive'); select('forest'); }
    if (n === '3') { flash('p-areas'); const worst = [...S.svc.rows].sort((a, b) => a.ratio - b.ratio)[0]; select(worst.ent); }
    return;
  }
  const sel = t.closest('[data-sel]');
  if (sel) { select(sel.dataset.sel); return; }
  const tab = t.closest('#pumpTabs button');
  if (tab) {
    $$('#pumpTabs button').forEach(b => b.classList.toggle('active', b === tab));
    $('#pumpNet').hidden = tab.dataset.tab !== 'net';
    $('#pumps').hidden = tab.dataset.tab !== 'list';
    netSig = '';
    renderNetwork();
    return;
  }
  if (t.closest('[data-act=intake]')) { S.intakeOn = !S.intakeOn; sim.refresh(S); toast(`River intake ${S.intakeOn ? 'started' : 'stopped'}`); update(); return; }
  if (t.closest('[data-close]')) { selected = null; gl.selectLabel(null); renderInfo(); return; }
  if (t.closest('[data-mclose]') || t.closest('#modelBtn')) {
    modelOpen = t.closest('#modelBtn') ? !modelOpen : false;
    $('#modelcard').hidden = !modelOpen;
    $('#modelBtn').classList.toggle('on', modelOpen);
    if (modelOpen) renderModelCard();
    return;
  }
  const dis = t.closest('[data-dismiss]');
  if (dis) { dismissed.add(dis.dataset.dismiss); renderAlerts(); return; }
  if (t.closest('[data-ds-more]')) { alertsExpanded = !alertsExpanded; renderAlerts(); return; }
  const al = t.closest('.dsr');
  if (al) { select(al.dataset.target); return; }
  const pr = t.closest('[data-pump]');
  if (pr) { select(pr.dataset.pump); return; }
  const ar = t.closest('[data-area]');
  if (ar) { select(ar.dataset.area); return; }
  if (t.closest('#banner')) select('reservoir');
});

$$('[data-layer]').forEach(i => i.addEventListener('change', () => {
  if (i.dataset.layer === 'perm') {
    gl.setPermeability(i.checked);
    $('#permLegend').hidden = !i.checked;
    return;
  }
  gl.setLayer(i.dataset.layer, i.checked);
}));
$$('#viewbtns button').forEach(b => b.addEventListener('click', () => {
  $$('#viewbtns button').forEach(x => x.classList.toggle('active', x === b));
  gl.setView(b.dataset.view);
  $('#viewName').textContent = viewLine(b.dataset.view);
}));
$('#zin').onclick = () => gl.zoom(0.75);
$('#zout').onclick = () => gl.zoom(1.33);
$('#zreset').onclick = () => { selected = null; gl.selectLabel(null); renderInfo(); gl.reset(); };

$$('#scen button').forEach(b => b.addEventListener('click', () => {
  $$('#scen button').forEach(x => x.classList.toggle('active', x === b));
  sim.setScenario(S, b.dataset.s);
  dismissed.clear();
  update();
  const sc = SCEN[S.scenario];
  toast(`Scenario: ${sc.label} · peak rain ${sc.P} mm/d → estimated runoff ${fmt(peakRunoff(S.lu))} m³/h`);
  // demo hint only (no default or timing change): at 1× the overflow takes ~1.5 min of wall-clock time
  if (S.scenario === 'heavy' && speed === 1) setTimeout(() => { if (S.scenario === 'heavy' && speed === 1) toast('Tip: press 24× to see the reservoir overflow in a few seconds.'); }, 3000);
}));
$$('#speed button').forEach(b => b.addEventListener('click', () => {
  $$('#speed button').forEach(x => x.classList.toggle('active', x === b));
  speed = +b.dataset.x;
  toast(`Simulation speed ${speed}× (${Math.round(speed * 20 / 60 * 10) / 10} simulated h per tick)`);
}));
let clearRaf = 0;
document.addEventListener('input', e => {
  if (e.target.matches('[data-clear]')) {
    const v = +e.target.value / 100;
    cancelAnimationFrame(clearRaf);
    clearRaf = requestAnimationFrame(() => {
      sim.setForestClearing(S, v);
      runForecasts(); renderMap(); renderQuestions(); renderPredictive(); renderStatus(); renderAlerts(); refreshLandUseUI();
    });
    return;
  }
  if (!e.target.matches('[data-thr]')) return;
  S.rotThr = +e.target.value * 1000;
  sim.setRotation(S, S.rotMode);
  $('#thrv').textContent = `${e.target.value}% · ${fmt(S.rotThr)} m³`;
  runForecasts(); renderQuestions(); renderPredictive(); renderStatus(); renderAlerts(); renderMap();
});
document.addEventListener('change', e => {
  if (e.target.matches('[data-thr]')) { e.target.blur(); update(); }
  if (e.target.matches('[data-clear]')) {
    cancelAnimationFrame(clearRaf);
    sim.setForestClearing(S, +e.target.value / 100);
    e.target.blur();
    update();
    toast(`What-if: upland forest cleared ${e.target.value}% → composite CN(II) ${S.lu.cn2.toFixed(1)}`);
  }
  if (!e.target.matches('[data-rotmode]')) return;
  sim.setRotation(S, e.target.value);
  e.target.blur();
  toast(`Water rationing: ${e.target.value}${S.rotActive ? ' (active)' : ''}`);
  update();
});
$('#range').onchange = e => { range = +e.target.value; renderConsumption(); };
$('#period').onchange = e => { sortBy = e.target.value; renderAreas(); };
$('#alertsAll').onclick = () => { dismissed.clear(); renderAlerts(); };
$('#bell').onclick = () => flash('p-alerts');

for (const id of ['fchart', 'cchart']) {
  const el = $('#' + id);
  const redraw = () => (id === 'fchart' ? forecastChart(el, S, fc, fcNo) : consumptionChart(el, S.cons.slice(-range)));
  el.addEventListener('mousemove', e => {
    const r = el.getBoundingClientRect();
    el.__hx = (e.clientX - r.left) * (el.clientWidth / r.width);
    redraw();
  });
  el.addEventListener('mouseleave', () => { el.__hx = null; redraw(); });
}
new ResizeObserver(() => { forecastChart($('#fchart'), S, fc, fcNo); renderConsumption(); }).observe($('#fchart'));
new ResizeObserver(() => consumptionChart($('#cchart'), S.cons.slice(-range))).observe($('#cchart'));

function flash(id) {
  if (id in panelOpen && !panelOpen[id]) togglePanel(id, true);      // navigating to a collapsed panel opens it
  const p = document.getElementById(id);
  if (isMobile) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  p.classList.remove('flash'); void p.offsetWidth; p.classList.add('flash');
}
function downloadReport() {
  const m = S.m, svc = S.svc, T = fc.totals(72), st = supplyStatus();
  const lines = ['Watershed Command Center - Status Report (SIMULATION - not live data)', `Study area,${SA.name} (${SA.mode === 'gis' ? 'GIS study-area boundary; terrain and infrastructure simulated' : 'display name only'})`, `Watershed boundary,${SA.boundaryLabel}`, `GIS status,${SA.mode === 'gis' ? SA.gisStatus : 'PENDING DATA'}`, `Operational catchment km2,${SA.operational.km2.toFixed(3)} (${SA.operational.label})`, `Generated (sim time),${new Date(S.t).toISOString()}`, `Scenario,${SCEN[S.scenario].label}`, `Supply status,${st.label} (${st.reason})`, '',
    'Q1 Do we have enough water?', `Stored (m3),${Math.round(S.volume)}`, `Usable above dead storage (m3),${Math.round(Math.max(0, S.volume - DEAD))}`, `Days of supply,${daysTxt(daysToLow(fcLong))}`, `Demand (m3/day),${Math.round(svc.demand)}`, `Deliverable supply (m3/day),${Math.round(svc.supply)}`, '',
    'Q2 What happens to the rainwater? (next 72 h)', `Rain on catchment (m3),${Math.round(T.rain)}`, `Runoff (m3 est.),${Math.round(T.runoff)}`, `Overflow not captured (m3),${Math.round(T.spill)}`, `Composite curve number,${m.cn.toFixed(1)}`, `Forest cleared (% of forest),${S.lu.forestLossPct.toFixed(0)}`, '',
    'Q3 Is water reaching where it is needed?', 'Area,Demand m3/day,Supply m3/day,Supply/Demand,Status,Primary pump,Backup pump',
    ...svc.rows.map(r => `${r.name},${Math.round(r.demand)},${Math.round(r.supply)},${(r.ratio * 100).toFixed(0)}%,${r.status},${r.pump},${r.backup ?? 'none'}`), '',
    'Pump,Status,Flow m3/h,Capacity m3/h', ...S.pumps.map(p => `${p.id},${p.status},${Math.round(p.q)},${p.flow}`), '',
    'Hour,Forecast storage m3 (physics-only),Spill m3', ...fc.filter(p => p.h % 6 === 0).map(p => `+${p.h}h,${Math.round(p.v)},${Math.round(p.spill)}`)];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = 'watershed-report.csv';
  a.click();
  toast('Report exported (watershed-report.csv)');
}
const NAV = {
  dashboard: () => { selected = null; gl.selectLabel(null); renderInfo(); gl.reset(); },
  map: () => { flash('p-map'); select('forest'); },
  water: () => { flash('p-status'); select('reservoir'); },
  reports: downloadReport,
  settings: () => toast('Settings are not part of this demo'),
};
$$('#nav a').forEach(a => a.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } }));
$$('#nav a').forEach(a => a.addEventListener('click', () => {
  $$('#nav a').forEach(x => x.classList.toggle('active', x === a));
  NAV[a.dataset.nav]?.();
}));

// ---------- desktop sidebar: icon rail that expands on hover / keyboard focus (CSS keys off .sb-x; overlay, so the map never resizes) ----------
if (SIDEBAR_HOVER) {
  const sb = $('#sidebar'); let sbT = 0;
  document.documentElement.classList.add('sbhover');
  const sbOpen = () => { clearTimeout(sbT); sb.classList.add('sb-x'); };
  const sbClose = () => { clearTimeout(sbT); sbT = setTimeout(() => sb.classList.remove('sb-x'), 150); };
  const kbFocus = () => sb.contains(document.activeElement) && document.activeElement.matches(':focus-visible');
  sb.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') sbOpen(); });
  sb.addEventListener('pointerleave', () => { if (!kbFocus()) sbClose(); });
  sb.addEventListener('focusin', e => { if (e.target.matches(':focus-visible')) sbOpen(); });
  sb.addEventListener('focusout', e => { if (!sb.contains(e.relatedTarget) && !sb.matches(':hover')) sbClose(); });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !sb.classList.contains('sb-x')) return;
    clearTimeout(sbT); sb.classList.remove('sb-x');
    if (sb.contains(document.activeElement)) document.activeElement.blur();
  });
}

// search
const searchItems = [
  { n: 'Raw-Water Reservoir', id: 'reservoir' }, { n: 'Treated Water Storage', id: 'tws' },
  { n: 'Distribution Pump A', id: 'PUMP-01' }, { n: 'Distribution Pump B', id: 'PUMP-02' }, { n: 'Distribution Pump C', id: 'PUMP-03' },
  { n: 'Water Treatment Plant', id: 'wtp' }, { n: 'Isolation valve IV-A', id: 'IVA' }, { n: 'Isolation valve IV-B', id: 'IVB' }, { n: 'Cross-connection valve XV-1', id: 'XV1' }, { n: 'Cross-connection valve XV-2', id: 'XV2' },
  { n: 'Upper Watershed (catchment)', id: 'forest' }, { n: 'Commercial Zone', id: 'commercial' }, { n: 'River Intake', id: 'intake' },
  ...sim.AREAS.map(a => ({ n: a.name, id: a.ent })),
];
const sInp = $('#search'), sRes = $('#searchRes');
let sMatches = [], sIdx = 0;
function showSearch() {
  const q = sInp.value.trim().toLowerCase();
  sMatches = q ? searchItems.filter(i => i.n.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)) : [];
  sIdx = 0;
  sRes.style.display = sMatches.length ? 'block' : 'none';
  sRes.innerHTML = sMatches.map((m, i) => `<div class="${i === 0 ? 'on' : ''}" data-i="${i}">${m.n}<small>${m.id}</small></div>`).join('');
}
function pick(i) { const m = sMatches[i]; if (!m) return; select(m.id); sInp.value = ''; sRes.style.display = 'none'; sInp.blur(); }
sInp.addEventListener('input', showSearch);
sInp.addEventListener('keydown', e => {
  if (e.key === 'Enter') pick(sIdx);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : -1) + sMatches.length) % Math.max(1, sMatches.length);
    [...sRes.children].forEach((c, i) => c.classList.toggle('on', i === sIdx));
  }
  if (e.key === 'Escape') { sInp.value = ''; showSearch(); sInp.blur(); }
});
sRes.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) pick(+d.dataset.i); });
sInp.addEventListener('blur', () => setTimeout(() => (sRes.style.display = 'none'), 150));
addEventListener('keydown', e => { if (e.ctrlKey && e.key.toLowerCase() === 'k') { e.preventDefault(); sInp.focus(); } });

update();

import { CAP, CRIT, LOW } from './sim.js';

const fmt = n => Math.round(n).toLocaleString('en-US');
const dShort = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const tShort = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const pathOf = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');

// Operational thresholds: one visual style each, shared by chart, gauge and tables
export const THRESHOLDS = S => [
  { key: 'overflow', name: 'Overflow Threshold', short: 'Overflow', v: CAP, color: '#ff4d57', dash: '', width: 1.8 },
  { key: 'flood', name: 'Flood Buffer', short: 'Flood Buffer', v: CRIT, color: '#ff9f43', dash: '6 4', width: 1.4 },
  { key: 'rotation', name: 'Pump Rotation Threshold', short: 'Pump Rotation', v: S.rotThr, color: '#b48cff', dash: '9 3 2 3', width: 1.4 },
  { key: 'critical', name: 'Critical Level', short: 'Critical Level', v: LOW, color: '#ff4d57', dash: '2 3', width: 2.2 },
];

export function lineSample(t, w = 26) {
  return `<svg width="${w}" height="8" style="vertical-align:middle"><line x1="1" x2="${w - 1}" y1="4" y2="4" stroke="${t.color}" stroke-width="${t.width + 0.4}" stroke-dasharray="${t.dash}"/></svg>`;
}

export function forecastChart(el, S, fc, fcNoRot) {
  const w = el.clientWidth, h = el.clientHeight;
  if (w < 50 || h < 40) return;
  const m = { l: 36, r: 8, t: 6, b: 18 };
  const t0 = S.t - 36 * 3.6e6, t1 = S.t + 168 * 3.6e6, VMAX = 110000;
  const X = t => m.l + ((t - t0) / (t1 - t0)) * (w - m.l - m.r);
  const Y = v => m.t + (1 - v / VMAX) * (h - m.t - m.b);
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="fb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ee6a0" stop-opacity=".5"/><stop offset="1" stop-color="#2ee6a0" stop-opacity=".1"/></linearGradient></defs>`;
  for (let v = 0; v <= 100000; v += 25000) s += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${m.l - 5}" y="${Y(v) + 3}" class="ax" text-anchor="end">${v ? v / 1000 + 'K' : '0'}</text>`;
  const d0 = new Date(t0); d0.setHours(24, 0, 0, 0);
  // narrow (mobile) charts label every 2nd day so labels never collide; desktop widths keep one label per day
  const dayStep = Math.max(1, Math.ceil(46 / (X(t0 + 86400000) - X(t0))));
  for (let t = d0.getTime(), k = 0; t < t1; t += 86400000, k++) if (k % dayStep === 0) s += `<text x="${X(t)}" y="${h - 5}" class="ax" text-anchor="middle">${dShort(t)}</text>`;
  // rotation periods
  let start = null;
  for (let i = 1; i <= fc.length; i++) {
    const on = i < fc.length && fc[i].rot;
    if (on && start === null) start = fc[i - 1].t;
    if (!on && start !== null) { s += `<rect x="${X(start)}" y="${m.t}" width="${X(fc[i - 1].t) - X(start)}" height="${h - m.t - m.b}" fill="#b48cff" fill-opacity=".09"/>`; start = null; }
  }
  // overflow hours: runoff leaving through the spillway instead of being stored
  for (let i = 1; i < fc.length; i++) if (fc[i].spill > 0) s += `<rect x="${X(fc[i - 1].t)}" y="${m.t}" width="${X(fc[i].t) - X(fc[i - 1].t) + 0.5}" height="${Y(100000) - m.t}" fill="#35b0f0" fill-opacity=".22"/>`;
  THRESHOLDS(S).forEach(t => {
    s += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(t.v)}" y2="${Y(t.v)}" stroke="${t.color}" stroke-dasharray="${t.dash}" stroke-width="${t.width}" opacity=".9"/>`;
    s += `<text x="${w - m.r - 3}" y="${t.key === 'flood' ? Y(t.v) + 9 : Y(t.v) - 3}" text-anchor="end" class="thl" fill="${t.color}">${t.short} ${Math.round(t.v / 1000)}K</text>`;
  });
  const up = fc.map(p => [X(p.t), Y(p.hi)]), lo = fc.map(p => [X(p.t), Y(p.lo)]).reverse();
  s += `<path d="${pathOf(up)}L${lo.map(p => p.join(',')).join('L')}Z" fill="url(#fb)"/>`;
  if (fcNoRot && fcNoRot.some((p, i) => Math.abs(p.v - fc[i].v) > 300))
    s += `<path d="${pathOf(fcNoRot.map(p => [X(p.t), Y(p.v)]))}" fill="none" stroke="#ff7b84" stroke-opacity=".7" stroke-width="1.4" stroke-dasharray="2 3"/>`;
  s += `<path d="${pathOf(fc.map(p => [X(p.t), Y(p.v)]))}" fill="none" stroke="#2ee6a0" stroke-width="2" stroke-dasharray="6 4"/>`;
  const hist = S.hist.filter(p => p.t >= t0);
  s += `<path d="${pathOf(hist.map(p => [X(p.t), Y(p.v)]))}" fill="none" stroke="#2f8cff" stroke-width="2.2"/>`;
  const nx = X(S.t);
  s += `<line x1="${nx}" x2="${nx}" y1="${m.t}" y2="${h - m.b}" stroke="#cfe3ff" stroke-opacity=".5"/><text x="${nx + 4}" y="${Y(105000) + 3}" class="ax" fill="#cfe3ff">Now</text>`;
  s += `<circle cx="${nx}" cy="${Y(S.volume)}" r="4.5" fill="#2f8cff" stroke="#fff" stroke-width="1.5"/>`;
  if (w >= 440) s += `<g class="ax" transform="translate(${m.l + 6},${Y(6500) + 3})"><line x2="14" stroke="#2f8cff" stroke-width="2"/><text x="18" y="3">Simulated history</text><line x1="92" x2="106" stroke="#2ee6a0" stroke-width="2" stroke-dasharray="4 3"/><text x="110" y="3">Forecast</text><rect x="158" y="-4" width="12" height="8" fill="#2ee6a0" fill-opacity=".3"/><text x="174" y="3">Uncertainty (heuristic)</text>${fcNoRot ? '<line x1="290" x2="304" stroke="#ff7b84" stroke-dasharray="2 3" stroke-width="1.6"/><text x="308" y="3">No rotation</text>' : ''}</g>`;
  else s += `<g class="ax" transform="translate(${m.l + 6},${Y(6500) - 13})"><line x2="14" stroke="#2f8cff" stroke-width="2"/><text x="18" y="4">Simulated history</text><line x1="128" x2="142" stroke="#2ee6a0" stroke-width="2" stroke-dasharray="4 3"/><text x="146" y="4">Forecast</text></g>
    <g class="ax" transform="translate(${m.l + 6},${Y(6500) + 3})"><rect x="0" y="-4" width="12" height="8" fill="#2ee6a0" fill-opacity=".3"/><text x="16" y="4">Uncertainty (heuristic)</text>${fcNoRot ? '<line x1="160" x2="174" stroke="#ff7b84" stroke-dasharray="2 3" stroke-width="1.6"/><text x="178" y="4">No rotation</text>' : ''}</g>`;
  let tip = '';
  if (el.__hx != null) {
    const t = t0 + ((el.__hx - m.l) / (w - m.l - m.r)) * (t1 - t0);
    if (t >= t0 && t <= t1) {
      const isF = t >= S.t;
      const arr = isF ? fc : hist;
      let best = arr[0];
      for (const p of arr) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const x = X(best.t);
      s += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${h - m.b}" stroke="#fff" stroke-opacity=".35"/><circle cx="${x}" cy="${Y(best.v)}" r="4" fill="${isF ? '#2ee6a0' : '#2f8cff'}"/>`;
      const nr = isF && fcNoRot ? fcNoRot[best.h] : null;
      const mm = best.m;
      const detail = isF && mm ? `<br>Rain ${mm.P.toFixed(0)} mm/d · Runoff ${fmt(mm.runoff)} m³/h<br>Net balance ${mm.net >= 0 ? '+' : ''}${fmt(mm.net)} m³/h${best.spill > 0 ? `<br><span style="color:#5fd0ff">Overflow ${fmt(best.spill)} m³/h (not captured)</span>` : ''}${best.rot ? '<br><span style="color:#c9adff">Pump rotation active</span>' : ''}${nr && Math.abs(nr.v - best.v) > 300 ? `<br><span style="color:#ff9aa1">Without rotation: ${fmt(nr.v)} m³</span>` : ''}` : '';
      tip = `<div class="ctip" style="left:${Math.min(Math.max(x - 70, 0), w - 190)}px;top:2px"><b>${fmt(best.v)} m³</b> · ${(best.v / CAP * 100).toFixed(1)}%<br>${isF ? `Forecast (est.) ±${fmt((best.hi - best.lo) / 2)}` : 'Simulated history'} · ${dShort(best.t)} ${tShort(best.t)}${detail}</div>`;
    }
  }
  el.innerHTML = s + '</svg>' + tip;
}

export function consumptionChart(el, days) {
  const w = el.clientWidth, h = el.clientHeight;
  if (w < 50 || h < 40) return;
  const m = { l: 34, r: 8, t: 6, b: 18 };
  const max = Math.max(2000, Math.ceil(Math.max(...days.map(d => d.hh + d.com)) / 2000) * 2000);
  const X = i => m.l + (i / (days.length - 1)) * (w - m.l - m.r);
  const Y = v => m.t + (1 - v / max) * (h - m.t - m.b);
  let s = `<svg width="${w}" height="${h}"><defs>
    <linearGradient id="gh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f8cff" stop-opacity=".7"/><stop offset="1" stop-color="#2f8cff" stop-opacity=".08"/></linearGradient>
    <linearGradient id="gc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9f43" stop-opacity=".7"/><stop offset="1" stop-color="#ff9f43" stop-opacity=".08"/></linearGradient></defs>`;
  for (let v = 0; v <= max; v += max / 4) s += `<line x1="${m.l}" x2="${w - m.r}" y1="${Y(v)}" y2="${Y(v)}" class="gl"/><text x="${m.l - 5}" y="${Y(v) + 3}" class="ax" text-anchor="end">${v ? (v / 1000) + 'K' : 0}</text>`;
  const stack = days.map((d, i) => [X(i), Y(d.hh + d.com)]);
  const hh = days.map((d, i) => [X(i), Y(d.hh)]);
  s += `<path d="${pathOf(stack)}L${X(days.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z" fill="url(#gc)"/><path d="${pathOf(stack)}" fill="none" stroke="#ff9f43" stroke-width="1.6"/>`;
  s += `<path d="${pathOf(hh)}L${X(days.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z" fill="url(#gh)"/><path d="${pathOf(hh)}" fill="none" stroke="#2f8cff" stroke-width="1.8"/>`;
  const every = Math.ceil(days.length / 6);
  days.forEach((d, i) => { if (i % every === 0) s += `<text x="${X(i)}" y="${h - 4}" class="ax" text-anchor="middle">${dShort(d.t)}</text>`; });
  let tip = '';
  if (el.__hx != null) {
    const i = Math.max(0, Math.min(days.length - 1, Math.round(((el.__hx - m.l) / (w - m.l - m.r)) * (days.length - 1))));
    const d = days[i], x = X(i);
    s += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${h - m.b}" stroke="#fff" stroke-opacity=".35"/><circle cx="${x}" cy="${Y(d.hh)}" r="3.5" fill="#2f8cff"/><circle cx="${x}" cy="${Y(d.hh + d.com)}" r="3.5" fill="#ff9f43"/>`;
    tip = `<div class="ctip" style="left:${Math.min(Math.max(x - 55, 0), w - 135)}px;top:0"><b>${dShort(d.t)}</b><br><span class="dot b"></span>Household ${fmt(d.hh)} m³<br><span class="dot o"></span>Commercial ${fmt(d.com)} m³</div>`;
  }
  el.innerHTML = s + '</svg>' + tip;
}

// reservoir level gauge with operational-threshold ticks (0% at top, clockwise)
export function levelGauge(el, pct, color, ticks) {
  const R = 60, Cc = 2 * Math.PI * R, cx = 80, cy = 80;
  let s = `<svg viewBox="0 0 160 160" width="100%" height="100%"><circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#0e2440" stroke-width="15"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${color}" stroke-width="15" stroke-dasharray="${Math.max(0, pct) * Cc} ${Cc}" transform="rotate(-90 ${cx} ${cy})" style="transition:stroke-dasharray .6s"/>`;
  ticks.forEach(t => {
    const a = (t.p * 360 - 90) * Math.PI / 180;
    const p = r => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    const [x1, y1] = p(R - 11), [x2, y2] = p(R + 12);
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${t.color}" stroke-width="3" stroke-dasharray="${t.dash ? '2 1.5' : ''}"/>`;
  });
  el.innerHTML = s + '</svg>';
}

export function spark(vals, color) {
  const w = 74, h = 18, max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 2 - (v / max) * (h - 5)]);
  return `<svg width="${w}" height="${h}" class="spark"><path d="${pathOf(pts)}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

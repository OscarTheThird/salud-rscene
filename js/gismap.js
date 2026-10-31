// Flat (2D) GIS map of administrative units (barangays) with census statistics, drawn as SVG. No libraries.
// Real data only: polygons and statistics come from the study area's administrative files; the watershed reserve,
// the DEM catchment and points are drawn for orientation. Pan by dragging, zoom with the wheel or zoom().
// Projection: Web Mercator (EPSG:3857), the projection of web map tiles, so an optional satellite or street basemap
// lines up with the polygons. Coordinates are offset to the map centre to keep SVG numbers small.

const NS = 'http://www.w3.org/2000/svg';
export const METRICS = {
  pop2024: { label: 'Population 2024', unit: '', fmt: v => Math.round(v).toLocaleString('en-US') },
  hh2024: { label: 'Households 2024', unit: '', fmt: v => Math.round(v).toLocaleString('en-US') },
  growth: { label: 'Growth 2020–24', unit: '%/yr', fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`, diverging: true },
  density: { label: 'Density (approx.)', unit: 'per km²', fmt: v => Math.round(v).toLocaleString('en-US') },
};
const SEQ = ['#1d4466', '#24679a', '#2f8cc8', '#5db3ea', '#a8ddff'];
const NEG = ['#b4561a', '#e08a3c'], POS = ['#24679a', '#2f8cc8', '#a8ddff'];

// Web Mercator metres relative to an origin (lon0, lat0); y grows downward for SVG
const R = 6378137, D2R = Math.PI / 180;
const merc = ([lon, lat]) => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))];
export function projector(lon0, lat0) {
  const [ox, oy] = merc([lon0, lat0]);
  return {
    origin: [ox, oy],
    fwd: c => { const [x, y] = merc(c); return [x - ox, oy - y]; },
    inv: ([x, y]) => [(x + ox) / R / D2R, (2 * Math.atan(Math.exp((oy - y) / R)) - Math.PI / 2) / D2R],
  };
}
// basemap tile sources (standard XYZ tiles in Web Mercator); attribution is required and shown on the map
export const BASEMAPS = {
  satellite: { label: 'Satellite', url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, maxZ: 18, attr: 'Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community' },
  street: { label: 'Map', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, maxZ: 19, attr: '© OpenStreetMap contributors' },
  none: { label: 'None' },
};
// quantile class breaks (n classes) over the finite values
export function quantiles(values, n = 5) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return Array.from({ length: n - 1 }, (_, i) => v[Math.min(v.length - 1, Math.floor((i + 1) * v.length / n))]);
}
const ringArea = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; };
function centroid(polys) {      // area-weighted centroid of the largest outer ring
  const r = polys.map(p => p[0]).sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))[0];
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]; A += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f; }
  return A ? [cx / (3 * A), cy / (3 * A)] : r[0];
}
const pathOf = polys => polys.map(p => p.map(r => 'M' + r.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z').join('')).join('');
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

export function createGisMap(container, { onSelect, onHover } = {}) {
  const svg = el('svg', { class: 'gis-svg', role: 'img', 'aria-label': 'Barangay map' });
  const gTiles = el('g', { class: 'gis-tiles' }), gUnits = el('g', { class: 'gis-units' }), gOver = el('g', { class: 'gis-over' }), gLab = el('g', { class: 'gis-labels' });
  svg.append(gTiles, gUnits, gOver, gLab);
  let basemap = 'none';
  const tiles = new Map();                         // "z/x/y" -> <image>
  function drawTiles() {
    const B = BASEMAPS[basemap];
    if (!B?.url || !proj) { tiles.forEach(t => t.remove()); tiles.clear(); return; }
    const [ox, oy] = proj.origin, W = 2 * Math.PI * R;
    const z = Math.max(3, Math.min(B.maxZ, Math.round(Math.log2(pxPerM() * W / 256) + 0.4))), T = W / 2 ** z, n = 2 ** z;
    const mx0 = vb[0] + ox, mx1 = vb[0] + vb[2] + ox, myTop = oy - vb[1], myBot = oy - vb[1] - vb[3];
    const i0 = Math.max(0, Math.floor((mx0 + W / 2) / T)), i1 = Math.min(n - 1, Math.floor((mx1 + W / 2) / T));
    const j0 = Math.max(0, Math.floor((W / 2 - myTop) / T)), j1 = Math.min(n - 1, Math.floor((W / 2 - myBot) / T));
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 120) return;      // safety cap
    const want = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = `${z}/${i}/${j}`;
      want.add(k);
      if (tiles.has(k)) continue;
      const im = el('image', { x: (i * T - W / 2 - ox).toFixed(1), y: (oy - (W / 2 - j * T)).toFixed(1), width: (T * 1.003).toFixed(1), height: (T * 1.003).toFixed(1), preserveAspectRatio: 'none' });
      im.setAttribute('href', B.url(z, i, j));
      gTiles.append(im); tiles.set(k, im);
    }
    for (const [k, im] of tiles) if (!want.has(k)) { im.remove(); tiles.delete(k); }
  }
  const tip = document.createElement('div'); tip.className = 'gis-tip'; tip.hidden = true;
  container.append(svg, tip);
  let units = [], proj = null, home = null, vb = null, metric = 'pop2024', breaks = [], selected = null, hovered = null, overlapSet = new Set();

  const fitBox = () => {
    const w = container.clientWidth || 800, h = container.clientHeight || 500, aspect = w / h;
    let [x0, y0, x1, y1] = home, bw = x1 - x0, bh = y1 - y0;
    // margins; extra room at the bottom where the summary and legend cards sit
    const cardsOver = !document.documentElement.classList.contains('mobile') && container.clientHeight > 420;
    x0 -= bw * 0.05; bw *= 1.1; y0 -= bh * 0.06; bh *= 1.06 + (cardsOver ? 0.34 : 0.04);
    if (bw / bh > aspect) { const nh = bw / aspect; y0 -= (nh - bh) / 2; bh = nh; } else { const nw = bh * aspect; x0 -= (nw - bw) / 2; bw = nw; }
    return [x0, y0, bw, bh];
  };
  const pxPerM = () => (container.clientWidth || 800) / vb[2];
  const apply = () => {
    svg.setAttribute('viewBox', vb.map(v => v.toFixed(1)).join(' '));
    drawLabels();
    drawTiles();
    const r = 5 / pxPerM();                       // point markers keep a constant on-screen size
    gOver.querySelectorAll('circle').forEach(c => c.setAttribute('r', r.toFixed(1)));
  };

  function colorOf(u) {
    const v = u[metric];
    if (!Number.isFinite(v)) return '#1a2638';
    if (METRICS[metric].diverging) {
      if (v < 0) return v < -1 ? NEG[0] : NEG[1];
      const b = quantiles(units.map(x => x[metric]).filter(x => x >= 0), 3);
      return POS[b.filter(t => v >= t).length];
    }
    return SEQ[breaks.filter(t => v >= t).length];
  }
  function paint() {
    breaks = quantiles(units.map(u => u[metric]));
    for (const u of units) {
      u.path.setAttribute('fill', colorOf(u));
      u.path.classList.toggle('sel', u.code === selected);
      u.path.classList.toggle('hov', u.code === hovered);
    }
  }
  function drawLabels() {
    gLab.replaceChildren();
    const k = pxPerM(), fs = 11 / k;   // 11 px on screen
    for (const u of units) {
      const show = u.areaM2 * k * k > 2200 || u.code === selected || u.code === hovered;
      if (!show) continue;
      const t = el('text', { x: u.c[0].toFixed(1), y: u.c[1].toFixed(1), 'font-size': fs.toFixed(2), 'text-anchor': 'middle', class: u.code === selected ? 'sel' : '' });
      t.textContent = u.name;
      gLab.append(t);
    }
  }
  function legend() {
    const m = METRICS[metric], b = breaks;
    if (m.diverging) {
      const p = quantiles(units.map(x => x[metric]).filter(x => x >= 0), 3), f = v => v.toFixed(1);
      return [{ c: NEG[0], t: '< −1' }, { c: NEG[1], t: '−1 to 0' }, { c: POS[0], t: `0 to ${f(p[0])}` }, { c: POS[1], t: `${f(p[0])} to ${f(p[1])}` }, { c: POS[2], t: `≥ ${f(p[1])}` }];
    }
    const f = v => m.fmt(v);
    return SEQ.map((c, i) => ({ c, t: i === 0 ? `< ${f(b[0])}` : i === SEQ.length - 1 ? `≥ ${f(b[i - 1])}` : `${f(b[i - 1])}–${f(b[i])}` }));
  }
  function showTip(u, ev) {
    if (!u) { tip.hidden = true; return; }
    const g = Number.isFinite(u.growth) ? `${u.growth >= 0 ? '+' : ''}${u.growth.toFixed(2)}%/yr` : '–';
    tip.innerHTML = `<b>${u.name}</b><small>${u.urban ?? ''}${overlapSet.has(u.code) ? ' · overlaps the reserve' : ''}</small>
      <div><span>Population 2024</span><b>${u.pop2024?.toLocaleString('en-US') ?? '–'}</b></div>
      <div><span>Households 2024</span><b>${u.hh2024?.toLocaleString('en-US') ?? '–'}</b></div>
      <div><span>Growth 2020–24</span><b>${g}</b></div>`;
    tip.hidden = false;
    const r = container.getBoundingClientRect(), sx = r.width / container.offsetWidth || 1;   // works under CSS scaling
    let x = (ev.clientX - r.left) / sx + 14, y = (ev.clientY - r.top) / sx + 14;
    if (x + tip.offsetWidth > container.offsetWidth - 6) x -= tip.offsetWidth + 28;
    if (y + tip.offsetHeight > container.offsetHeight - 6) y -= tip.offsetHeight + 28;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }

  // ---- interaction: hover, click, drag-pan, wheel-zoom ----
  let drag = null, moved = false;
  const unitAt = t => units.find(u => u.path === t);
  svg.addEventListener('pointermove', ev => {
    if (drag) {
      const k = vb[2] / (container.getBoundingClientRect().width || 1), dx = (ev.clientX - drag.x) * k, dy = (ev.clientY - drag.y) * k;
      if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) moved = true;
      vb = [drag.vb[0] - dx, drag.vb[1] - dy, vb[2], vb[3]]; apply(); return;
    }
    if (ev.pointerType !== 'mouse') return;
    const u = unitAt(ev.target);
    if ((u?.code ?? null) !== hovered) { hovered = u?.code ?? null; paint(); drawLabels(); onHover?.(u ?? null); }
    showTip(u, ev);
  });
  svg.addEventListener('pointerleave', () => { if (!drag) { hovered = null; tip.hidden = true; paint(); drawLabels(); } });
  svg.addEventListener('pointerdown', ev => { drag = { x: ev.clientX, y: ev.clientY, vb: [...vb] }; moved = false; try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic or ended pointer */ } });
  svg.addEventListener('pointerup', ev => {
    const wasDrag = moved; drag = null;
    if (wasDrag) return;
    const u = units.find(x => x.path === document.elementFromPoint(ev.clientX, ev.clientY));
    selected = u ? u.code : null; paint(); drawLabels(); onSelect?.(u ?? null);
  });
  svg.addEventListener('wheel', ev => {
    ev.preventDefault();
    const r = container.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
    // gentle, proportional zoom: one mouse-wheel notch (deltaY ≈ 100) ≈ 7%; capped for fast trackpad flicks
    zoomAt(Math.exp(Math.max(-0.15, Math.min(0.15, ev.deltaY * 0.0007))), fx, fy);
  }, { passive: false });
  function zoomAt(f, fx = 0.5, fy = 0.5) {
    const [x, y, w, h] = vb, nw = Math.min((home[2] - home[0]) * 3, Math.max(300, w * f)), nh = nw * h / w;
    vb = [x + (w - nw) * fx, y + (h - nh) * fy, nw, nh]; apply();
  }

  return {
    // data: { units: [{ code, name, polys (lon/lat), ... }] }; extras: { reserve, catchment, points: [{ lonlat, label, cls }] }
    setData(data, extras = {}, overlaps = new Set()) {
      overlapSet = overlaps;
      const all = data.units.flatMap(u => u.polys.flat(2));
      const lons = all.map(p => p[0]), lats = all.map(p => p[1]);
      const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2, lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
      proj = projector(lon0, lat0);
      gUnits.replaceChildren(); gOver.replaceChildren();
      units = data.units.map(u => {
        const polys = u.polys.map(p => p.map(r => r.map(proj.fwd)));
        const path = el('path', { d: pathOf(polys), class: `gis-unit${overlaps.has(u.code) ? ' ovl' : ''}` });
        gUnits.append(path);
        return { ...u, path, c: centroid(polys), areaM2: polys.reduce((s, p) => s + Math.abs(ringArea(p[0])), 0) };
      });
      const xy = units.flatMap(u => u.polys.flat(2).map(proj.fwd));
      const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
      home = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const over = (polys, cls) => { if (polys?.length) gOver.append(el('path', { d: pathOf(polys.map(p => p.map(r => r.map(proj.fwd)))), class: cls })); };
      over(extras.catchment, 'gis-catch');
      over(extras.reserve, 'gis-reserve');
      for (const pt of extras.points ?? []) {
        const [x, y] = proj.fwd(pt.lonlat), g = el('g', { class: `gis-pt ${pt.cls ?? ''}` });
        g.append(el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 1 }));
        const t = el('title'); t.textContent = pt.label; g.append(t);
        gOver.append(g);
      }
      this.reset();
    },
    setMetric(m) { metric = m; paint(); return legend(); },
    setBasemap(b) { basemap = BASEMAPS[b] ? b : 'none'; svg.classList.toggle('with-base', basemap !== 'none'); tiles.forEach(t => t.remove()); tiles.clear(); if (vb) drawTiles(); return BASEMAPS[basemap]; },
    legend,
    select(code) { selected = code; paint(); drawLabels(); const u = units.find(x => x.code === code); if (u) { const k = 6000; vb = [u.c[0] - k * 0.9, u.c[1] - k * 0.6, k * 1.8, k * 1.2]; this.fit(vb); } return u ?? null; },
    fit(box) { const w = container.clientWidth || 800, h = container.clientHeight || 500; const [x, y, bw, bh] = box; const nh = bw * h / w; vb = [x, y + (bh - nh) / 2, bw, nh]; apply(); },
    reset() { vb = fitBox(); paint(); apply(); },
    zoom(f) { zoomAt(f); },
    resize() { if (home) { const c = [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2], w = vb[2], h = w * (container.clientHeight || 500) / (container.clientWidth || 800); vb = [c[0] - w / 2, c[1] - h / 2, w, h]; apply(); } },
  };
}

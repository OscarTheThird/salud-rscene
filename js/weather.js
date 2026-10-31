// Real weather forecast for the study area (Open-Meteo, https://open-meteo.com, data CC BY 4.0).
// Model forecast, not a rain gauge: hourly precipitation (mm), FAO-56 reference evapotranspiration ET0 (mm) and
// 2 m temperature (°C), plus up to 7 past days so antecedent moisture can be computed from real rain.
// Pure functions except fetchForecast(); everything else runs the same in Node tests and the browser.
// Open-Meteo's free API is for non-commercial use (< 10,000 calls/day); commercial use needs its paid plan.

const HOUR = 3.6e6;
export const WX_SOURCE = { name: 'Open-Meteo', url: 'https://open-meteo.com/', license: 'CC BY 4.0' };
export const PAST_DAYS = 7, FORECAST_DAYS = 16;

export function forecastUrl(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4),
    hourly: 'precipitation,et0_fao_evapotranspiration,temperature_2m',
    past_days: PAST_DAYS, forecast_days: FORECAST_DAYS, timezone: 'UTC', timeformat: 'unixtime',
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

// Open-Meteo hourly values are stamped at the END of their hour (precipitation = sum over the preceding hour).
// Missing values (null) are kept as null and skipped by the sums.
export function parseForecast(json, fetchedAt = Date.now()) {
  const h = json?.hourly;
  if (!h || !Array.isArray(h.time) || !h.time.length) throw new Error('forecast has no hourly data');
  const t = h.time.map(s => s * 1000), n = t.length;
  for (const k of ['precipitation', 'et0_fao_evapotranspiration', 'temperature_2m']) {
    if (!Array.isArray(h[k]) || h[k].length !== n) throw new Error(`forecast field ${k} missing or wrong length`);
  }
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    t, p: h.precipitation.map(num), et0: h.et0_fao_evapotranspiration.map(num), temp: h.temperature_2m.map(num),
    t0: t[0], t1: t[n - 1], lat: json.latitude, lon: json.longitude, elevation: json.elevation ?? null, fetchedAt,
  };
}

export async function fetchForecast(lat, lon, fetchFn = fetch) {
  const r = await fetchFn(forecastUrl(lat, lon));
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  return parseForecast(await r.json());
}

// sum of an hourly field over (a, b]: hours stamped in that interval. Returns the sum and how many hours had data.
export function sumWindow(wx, key, a, b) {
  let sum = 0, n = 0;
  const arr = wx[key];
  for (let i = 0; i < wx.t.length; i++) {
    if (wx.t[i] <= a) continue;
    if (wx.t[i] > b) break;
    if (arr[i] !== null) { sum += arr[i]; n++; }
  }
  return { sum, n };
}
// a 24 h window centred on t is fully covered by the data
export const covers = (wx, t) => !!wx && t - 12 * HOUR >= wx.t0 - HOUR && t + 12 * HOUR <= wx.t1;
// 24 h total centred on t (mm/day): the daily rate the SCS-CN model expects; partial windows scale up
const daily = (wx, key, t) => { const { sum, n } = sumWindow(wx, key, t - 12 * HOUR, t + 12 * HOUR); return n ? sum * 24 / n : null; };
export const dailyRain = (wx, t) => daily(wx, 'p', t);
export const dailyEt0 = (wx, t) => daily(wx, 'et0', t);
// rain over the 5 days before t (mm), for the antecedent moisture condition
export const antecedent5d = (wx, t) => sumWindow(wx, 'p', t - 120 * HOUR, t).sum;
export const has5dHistory = (wx, t) => !!wx && t - 120 * HOUR >= wx.t0 - HOUR;

// SCS antecedent moisture class from 5-day antecedent rainfall, growing-season limits
// (USDA NEH-4: < 1.4 in = AMC I, 1.4-2.1 in = AMC II, > 2.1 in = AMC III)
export function amcClass(p5) { return p5 < 35.6 ? 'I' : p5 <= 53.3 ? 'II' : 'III'; }

export function tempAt(wx, t) {
  let best = null, bd = Infinity;
  for (let i = 0; i < wx.t.length; i++) { const d = Math.abs(wx.t[i] - t); if (d < bd && wx.temp[i] !== null) { bd = d; best = wx.temp[i]; } }
  return bd <= 2 * HOUR ? best : null;
}
// wettest single hour in (a, b]
export function maxHourly(wx, a, b) {
  let best = { mm: 0, t: null };
  for (let i = 0; i < wx.t.length; i++) if (wx.t[i] > a && wx.t[i] <= b && wx.p[i] !== null && wx.p[i] > best.mm) best = { mm: wx.p[i], t: wx.t[i] };
  return best;
}
// wettest 24 h total starting within the next `hours` (sliding, hourly steps): what a 24 h advisory would look at
export function max24h(wx, t, hours = 72) {
  let best = { mm: 0, t: null };
  for (let h = 0; h <= hours; h++) {
    const a = t + h * HOUR;
    if (a + 24 * HOUR > wx.t1) break;
    const { sum } = sumWindow(wx, 'p', a, a + 24 * HOUR);
    if (sum > best.mm) best = { mm: sum, t: a };
  }
  return best;
}

// PAGASA colour bands, applied to FORECAST values (an estimate; only PAGASA issues official warnings).
// 24 h total: the weather-advisory bands (50 / 100 / 200 mm). One hour: heavy-rainfall-warning bands (7.5 / 15 / 30 mm).
export function band24h(mm) { return mm > 200 ? 'Red' : mm >= 100 ? 'Orange' : mm >= 50 ? 'Yellow' : null; }
export function bandHourly(mm) { return mm > 30 ? 'Red' : mm >= 15 ? 'Orange' : mm >= 7.5 ? 'Yellow' : null; }
export const BAND_LEVEL = { Yellow: 'advisory', Orange: 'warning', Red: 'critical' };

// rain in the hour containing t (the first value stamped at or after t; stamps mark the end of their hour)
export function rainNow(wx, t) {
  for (let i = 0; i < wx.t.length; i++) if (wx.t[i] >= t) return wx.t[i] - t <= 3600000 ? wx.p[i] : null;
  return null;
}
// rain intensity classes by hourly rate (light < 2.5, moderate 2.5-7.5, heavy >= 7.5 mm/h); level 0-3 drives the 3D rain
export function intensity(mmh) {
  if (mmh === null || mmh < 0.1) return { level: 0, word: 'Not raining' };
  if (mmh < 2.5) return { level: 1, word: 'Light rain' };
  if (mmh < 7.5) return { level: 2, word: 'Moderate rain' };
  return { level: 3, word: 'Heavy rain' };
}

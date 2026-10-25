'use strict';
/* CFTC Positioning Monitor - client.
   Data: data/meta.json (dates, markets, prices, themes), data/fut.json and
   data/combo.json (long/short by trader group), data/detail/{KEY}.json
   (trader counts and concentration history). All analytics run here so every
   table follows the report / trader group / window selectors. */

/* ======================================================================= constants */
const TABS = [
  ['overview', 'Overview'], ['fx', 'FX'], ['rates', 'Rates'], ['equities', 'Equities'],
  ['commodities', 'Commodities'], ['crypto', 'Crypto'], ['themes', 'Themes'], ['washout', 'Washout map'],
  ['charts', 'Charts'], ['notes', 'Notes'],
];
const LBS = [52, 156, 260, 520, 0];
const LB_LABEL = { 52: '1Y', 156: '3Y', 260: '5Y', 520: '10Y', 0: 'All' };
const LB_LONG = { 52: '1-year', 156: '3-year', 260: '5-year', 520: '10-year', 0: 'full-history' };
const ROLES = {
  spec: { label: 'Leveraged funds · managed money', short: 'Lev funds / MM', tff: ['lev'], disagg: ['mm'] },
  am: { label: 'Asset managers', short: 'Asset managers', tff: ['am'], disagg: null },
  specam: { label: 'Lev funds + asset managers · MM + other', short: 'LF+AM / MM+Other', tff: ['lev', 'am'], disagg: ['mm', 'oth'] },
  dealer: { label: 'Dealers · swap dealers', short: 'Dealers', tff: ['dealer'], disagg: ['sd'] },
  pm: { label: 'Producers & merchants', short: 'Producers', tff: null, disagg: ['pm'] },
  oth: { label: 'Other reportables', short: 'Other reportables', tff: ['oth'], disagg: ['oth'] },
  nr: { label: 'Non-reportables (small traders)', short: 'Non-reportables', tff: ['nr'], disagg: ['nr'] },
  nc: { label: 'Legacy non-commercials', short: 'Non-commercials', tff: ['nc'], disagg: ['nc'] },
  cm: { label: 'Legacy commercials', short: 'Commercials', tff: ['cm'], disagg: ['cm'] },
};
const CAT_LABEL = {
  lev: 'Leveraged funds', am: 'Asset managers', dealer: 'Dealers', oth: 'Other reportables', nr: 'Non-reportables',
  mm: 'Managed money', pm: 'Producers / merchants', sd: 'Swap dealers', nc: 'Non-commercial (legacy)', cm: 'Commercial (legacy)',
};
const CAT_SHORT = { lev: 'Lev funds', am: 'Asset mgrs', dealer: 'Dealers', oth: 'Other', nr: 'Non-rept', mm: 'Managed money', pm: 'Producers', sd: 'Swap dealers', nc: 'Non-comm', cm: 'Comm' };
const CAT_SLOT = { lev: 1, mm: 1, am: 2, dealer: 3, sd: 3, oth: 4, nr: 5, pm: 6, nc: 7, cm: 8 };
const REPORT_CATS = { tff: ['lev', 'am', 'dealer', 'oth', 'nr'], disagg: ['mm', 'pm', 'sd', 'oth', 'nr'] };
const G10 = ['EUR', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD'];
const EMFX = ['MXN', 'BRL', 'ZAR'];
const USEQ = ['SPX', 'NDX', 'DJIA', 'RTY', 'MID'];
const UST = ['UST2', 'UST5', 'UST10', 'ULTRA10', 'BOND', 'ULTRA'];
const STIR = ['SOFR3', 'SOFR1', 'FF'];
const SECTORS = ['Energy', 'Metals', 'Grains', 'Softs', 'Livestock'];
const RANGES = [[52, '1Y'], [156, '3Y'], [260, '5Y'], [520, '10Y'], [0, 'All']];

/* ======================================================================= state */
const store = {
  get(k, d) { try { const v = localStorage.getItem('cftc.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('cftc.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};
const S = Object.assign({
  kind: 'fut', role: 'spec', lb: 156, tab: 'overview', market: 'EUR', units: 'usd', range: 260,
  theme: 'riskon', legMode: 'theme', corrSrc: 'returns', corrOrient: true, corrLb: 156, corrCrowded: false,
  cols: 'core', comGroup: 'All', sort: {}, legacy: false,
}, store.get('state', {}));
const save = () => store.set('state', S);
let customThemes = store.get('custom', []);
let draftLegs = store.get('draft', []);

let META = null;
let TS = [];
const MK = {}, CP = {}, NPC = {};
const DATA = { fut: null, combo: null };
const DETAIL = {};
const cache = new Map();
const charts = [];
const TABLES = {};

/* ======================================================================= formatting */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = (v) => typeof v === 'number' && isFinite(v);
const MINUS = '−';
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function signed(s, v, plus) { return v < 0 ? MINUS + s : plus && v > 0 ? '+' + s : s; }
function fmtK(v, plus = false) {
  if (!fin(v)) return '–';
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(2) + 'm' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'k' : nf0.format(a);
  return a < 0.5 ? '0' : signed(s, v, plus);
}
function fmtUSD(v, plus = false) {
  if (!fin(v)) return '–';
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = '$' + (a / 1e9).toFixed(a >= 1e11 ? 0 : a >= 1e10 ? 1 : 2) + 'bn';
  else if (a >= 1e6) s = '$' + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm';
  else if (a >= 1e3) s = '$' + (a / 1e3).toFixed(0) + 'k';
  else s = '$' + a.toFixed(0);
  return a < 0.5 ? '$0' : signed(s, v, plus);
}
function fmtN(v, d = 1, plus = false, suffix = '') {
  if (!fin(v)) return '–';
  const a = Math.abs(v).toFixed(d);
  return +a === 0 ? a + suffix : signed(a + suffix, v, plus);
}
const fmtChg = (v) => fmtN(v * 100, 1, true, '%');
const fmtP = (p) => (fin(p) ? String(Math.round(p)) : '–');
function fmt32(v) {
  const w = Math.floor(v), f = (v - w) * 32, whole = Math.floor(f + 1e-9), rem = f - whole;
  const tail = rem >= 0.75 ? '¾' : rem >= 0.5 ? '+' : rem >= 0.25 ? '¼' : '';
  return `${w}-${String(whole).padStart(2, '0')}${tail}`;
}
function dispVal(m, v) {
  if (!fin(v)) return NaN;
  if (m.disp === 'inv') return 1 / v;
  if (m.disp === 'cents') return v * 100;
  return v;
}
function dispPx(m, v) {
  const x = dispVal(m, v);
  if (!fin(x)) return '–';
  if (m.group === 'UST futures') return fmt32(x);
  const a = Math.abs(x);
  const d = a >= 1000 ? 0 : a >= 20 ? 2 : a >= 2 ? 3 : a >= 0.2 ? 4 : 5;
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pxUnit(m) {
  if (m.disp === 'inv') return `USD/${m.key}`;
  if (m.asset === 'FX' && m.key !== 'DXY') return `${m.key}/USD`;
  if (m.disp === 'cents') return 'cents';
  if (m.group === 'UST futures') return 'points-32nds';
  return '';
}
function fmtDate(s, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', Object.assign({ timeZone: 'UTC' }, opts));
}
const isoOf = (ts) => new Date(ts).toISOString().slice(0, 10);
function addDays(s, n) { return isoOf(Date.parse(s + 'T00:00:00Z') + n * 864e5); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function heatClass(p) {
  if (!fin(p)) return 'na';
  if (p >= 95) return 'h-l3';
  if (p >= 85) return 'h-l2';
  if (p >= 70) return 'h-l1';
  if (p <= 5) return 'h-s3';
  if (p <= 15) return 'h-s2';
  if (p <= 30) return 'h-s1';
  return 'h-m';
}
const HEAT_KEY = '<div class="key"><span>Percentile</span><i class="h-s3">≤5</i><i class="h-s2">≤15</i><i class="h-s1">≤30</i><i class="h-m">30–70</i><i class="h-l1">≥70</i><i class="h-l2">≥85</i><i class="h-l3">≥95</i></div>';
const roleLabel = () => ROLES[S.role].label;
const kindLabel = () => (S.kind === 'fut' ? 'futures only' : 'futures + delta-adjusted options');
const lbLabel = () => LB_LONG[S.lb] + ' window';
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ======================================================================= data */
function lastIdx(a) { for (let i = a.length - 1; i >= 0; i--) if (a[i] === a[i]) return i; return -1; }
function firstIdx(a) { for (let i = 0; i < a.length; i++) if (a[i] === a[i]) return i; return -1; }
function full(o, arr, n) {
  const a = new Float64Array(n).fill(NaN);
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v !== null) a[o + i] = v; }
  return a;
}
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
  return r.json();
}
async function ensureKind(kind) {
  if (DATA[kind]) return;
  const raw = await getJSON(`data/${kind}.json`);
  const n = TS.length, out = {};
  for (const [k, rec] of Object.entries(raw)) {
    const L = {}, Sh = {};
    for (const c in rec.L) L[c] = full(rec.o, rec.L[c], n);
    for (const c in rec.S) Sh[c] = full(rec.o, rec.S[c], n);
    out[k] = { o: rec.o, oi: full(rec.o, rec.oi, n), L, S: Sh, T: rec.T, C: rec.C };
  }
  DATA[kind] = out;
}
async function ensureDetail(key) {
  if (!DETAIL[key]) {
    try { DETAIL[key] = await getJSON(`data/detail/${key}.json`); } catch (e) { DETAIL[key] = {}; }
  }
  return DETAIL[key];
}

/* ======================================================================= analytics */
function catsFor(m, role = S.role) { return ROLES[role][m.report]; }
function ser(key, kind, cl) {
  const ck = `s|${kind}|${key}|${cl.join('+')}`;
  if (cache.has(ck)) return cache.get(ck);
  const rec = DATA[kind][key], n = rec.oi.length;
  const L = new Float64Array(n), Sh = new Float64Array(n), net = new Float64Array(n), pct = new Float64Array(n), dp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let l = 0, s = 0, ok = true;
    for (const c of cl) {
      const a = rec.L[c], b = rec.S[c];
      if (!a || !b || a[i] !== a[i] || b[i] !== b[i]) { ok = false; break; }
      l += a[i]; s += b[i];
    }
    const oi = rec.oi[i];
    if (ok && oi > 0) { L[i] = l; Sh[i] = s; net[i] = l - s; pct[i] = (l - s) / oi * 100; } else { L[i] = Sh[i] = net[i] = pct[i] = NaN; }
    dp[i] = i > 0 ? pct[i] - pct[i - 1] : NaN;
  }
  const r = { L, S: Sh, net, pct, dp, oi: rec.oi };
  cache.set(ck, r);
  return r;
}
function minObs(win) { return win ? Math.max(26, Math.round(win * 0.6)) : 52; }
/* mid-rank percentile of a[t] within the trailing window (current week included) */
function prank(a, t, win) {
  if (t < 0) return NaN;
  const x = a[t];
  if (x !== x) return NaN;
  const lo = win ? Math.max(0, t - win + 1) : 0;
  let below = 0, eq = 0, cnt = 0;
  for (let i = lo; i <= t; i++) {
    const v = a[i];
    if (v !== v) continue;
    cnt++;
    if (v < x) below++; else if (v === x) eq++;
  }
  return cnt >= minObs(win) ? (below + 0.5 * eq) / cnt * 100 : NaN;
}
function rollRank(key, kind, cl, win) {
  const ck = `r|${kind}|${key}|${cl.join('+')}|${win}`;
  if (cache.has(ck)) return cache.get(ck);
  const a = ser(key, kind, cl).pct, n = a.length, out = new Float64Array(n);
  for (let t = 0; t < n; t++) out[t] = prank(a, t, win);
  cache.set(ck, out);
  return out;
}
function rollRankArr(a, win) {
  const out = new Float64Array(a.length);
  for (let t = 0; t < a.length; t++) out[t] = prank(a, t, win);
  return out;
}
function wstats(a, t, win) {
  const lo = win ? Math.max(0, t - win + 1) : 0;
  let n = 0, s = 0, s2 = 0;
  for (let i = lo; i <= t; i++) { const v = a[i]; if (v !== v) continue; n++; s += v; s2 += v * v; }
  if (n < minObs(win)) return null;
  const m = s / n;
  return { m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)), n };
}
function classify(dL, dS, oi) {
  if (!fin(dL) || !fin(dS)) return null;
  if (Math.max(Math.abs(dL), Math.abs(dS)) < 0.003 * oi) return { k: 'quiet', label: 'Little change' };
  if (Math.abs(dL) >= Math.abs(dS)) return dL > 0 ? { k: 'nl', label: 'New longs' } : { k: 'll', label: 'Long liquidation' };
  return dS > 0 ? { k: 'ns', label: 'New shorts' } : { k: 'sc', label: 'Short covering' };
}
function naReason(m) {
  return m.report === 'disagg' ? 'The Disaggregated report has no asset-manager group' : 'The TFF report has no producer group';
}
/* everything a table row needs, for one market and one set of trader categories */
function metrics(key, opt = {}) {
  const kind = opt.kind || S.kind, m = MK[key], rec = DATA[kind] && DATA[kind][key];
  const base = { key, m };
  if (!rec) return Object.assign(base, { na: 'Not in this report' });
  const cl = opt.cl || catsFor(m, opt.role || S.role);
  if (!cl) return Object.assign(base, { na: naReason(m) });
  const s = ser(key, kind, cl), t = lastIdx(rec.oi);
  if (t < 4) return Object.assign(base, { na: 'Not enough history' });
  if (t < TS.length - 5) return Object.assign(base, { na: `No report since ${fmtDate(META.dates[t])}: the contract fell below the CFTC reporting threshold or was delisted` });
  const g = (a, k) => (t - k >= 0 ? a[t - k] : NaN);
  const net = s.net[t], pct = s.pct[t];
  const P = {};
  for (const w of LBS) P[w] = prank(s.pct, t, w);
  const st = wstats(s.pct, t, 156), fs = wstats(s.dp, t, 156);
  const npc = NPC[key] ? NPC[key][t] : NaN;
  const cp = CP[key], px = cp ? cp[t] : NaN, last = m.px_last;
  const dL = s.L[t] - g(s.L, 1), dS = s.S[t] - g(s.S, 1);
  let tL = NaN, tS = NaN;
  if (rec.T) {
    tL = 0; tS = 0;
    for (const c of cl) {
      const T = rec.T[c];
      if (!T || !T[0] || T[0][1] == null || T[1][1] == null) { tL = tS = NaN; break; }
      tL += T[0][1]; tS += T[1][1];
    }
  }
  return Object.assign(base, {
    cl, t, date: META.dates[t], stale: META.dates[t] !== META.latest,
    net, d1: net - g(s.net, 1), d4: net - g(s.net, 4), pct, dp1: pct - g(s.pct, 1), dp4: pct - g(s.pct, 4),
    P, p: P[S.lb], dP4: P[S.lb] - prank(s.pct, t - 4, S.lb),
    z: st && st.sd > 0 ? (pct - st.m) / st.sd : NaN,
    fz: fs && fs.sd > 0 ? (s.dp[t] - fs.m) / fs.sd : NaN,
    npc, usd: net * npc, flow: (net - g(s.net, 1)) * npc, flow4: (net - g(s.net, 4)) * npc,
    L: s.L[t], S: s.S[t], dL, dS, driver: classify(dL, dS, rec.oi[t]), tL, tS, conc: rec.C || {},
    oi: rec.oi[t], doi: rec.oi[t] / g(rec.oi, 1) - 1,
    px, r1: cp ? px / g(cp, 1) - 1 : NaN, r4: cp ? px / g(cp, 4) - 1 : NaN, r13: cp ? px / g(cp, 13) - 1 : NaN,
    rsr: last && fin(px) && last[0] > META.dates[t] ? last[1] / px - 1 : NaN,
    dv01: m.dv01 ? net * m.dv01 : NaN, eq10: m.dv01 ? net * m.dv01 / MK.UST10.dv01 : NaN,
    spark: Array.from(s.pct.subarray(Math.max(0, t - 51), t + 1)),
  });
}
function allMetrics() {
  const ck = `m|${S.kind}|${S.role}|${S.lb}`;
  if (!cache.has(ck)) cache.set(ck, META.markets.map((m) => metrics(m.key)));
  return cache.get(ck);
}
/* weekly sum across markets: mode usd | dv01 | contracts */
function aggSeries(keys, { sign = 1, mode = 'usd', role = S.role, kind = S.kind } = {}) {
  const ck = `a|${keys.join(',')}|${sign}|${mode}|${role}|${kind}`;
  if (cache.has(ck)) return cache.get(ck);
  const n = TS.length, out = new Float64Array(n), have = new Uint16Array(n);
  for (const k of keys) {
    const m = MK[k];
    if (!m || !DATA[kind][k]) continue;
    const cl = catsFor(m, role);
    if (!cl) continue;
    const s = ser(k, kind, cl), npc = NPC[k];
    for (let i = 0; i < n; i++) {
      const v = mode === 'dv01' ? s.net[i] * m.dv01 : mode === 'contracts' ? s.net[i] : s.net[i] * (npc ? npc[i] : NaN);
      if (v === v) { out[i] += sign * v; have[i]++; }
    }
  }
  for (let i = 0; i < n; i++) if (!have[i]) out[i] = NaN;
  cache.set(ck, out);
  return out;
}
function aggStats(a) {
  const t = lastIdx(a);
  return { t, v: a[t], d1: a[t] - a[t - 1], d4: a[t] - a[t - 4], p: prank(a, t, S.lb), spark: Array.from(a.subarray(Math.max(0, t - 51), t + 1)) };
}

/* ------------------------------------------------------------------ themes */
function allThemes() { return META.themes.concat(customThemes.map((t) => Object.assign({ custom: true }, t))); }
function legCats(leg, m) {
  if (S.legMode === 'theme' && leg.c) {
    const ok = (m.report === 'tff' ? ['dealer', 'am', 'lev', 'oth', 'nr', 'nc', 'cm'] : ['pm', 'sd', 'mm', 'oth', 'nr', 'nc', 'cm']).includes(leg.c);
    if (ok) return [leg.c];
  }
  return catsFor(m);
}
function themeData(th) {
  const ck = `t|${S.kind}|${S.role}|${S.lb}|${S.legMode}|${th.key}|${JSON.stringify(th.legs)}`;
  if (cache.has(ck)) return cache.get(ck);
  const n = TS.length, sum = new Float64Array(n), cnt = new Uint16Array(n), legs = [];
  for (const leg of th.legs) {
    const m = MK[leg.m];
    if (!m || !DATA[S.kind][leg.m]) continue;
    const cl = legCats(leg, m);
    if (!cl) { legs.push({ leg, m, na: naReason(m) }); continue; }
    const rr = rollRank(leg.m, S.kind, cl, S.lb), score = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = rr[i];
      score[i] = p !== p ? NaN : leg.s > 0 ? p : 100 - p;
      if (p === p) { sum[i] += score[i]; cnt[i]++; }
    }
    legs.push(Object.assign(metrics(leg.m, { cl }), { leg, score }));
  }
  const active = legs.filter((l) => !l.na).length;
  const need = Math.max(1, Math.ceil(active * 0.5));
  const comp = new Float64Array(n);
  for (let i = 0; i < n; i++) comp[i] = cnt[i] >= need ? sum[i] / cnt[i] : NaN;
  const t = lastIdx(comp);
  let usd = 0, flow = 0, mom = 0, momN = 0, hot = 0, live = 0;
  for (const r of legs) {
    if (r.na || !fin(r.score[t])) continue;
    live++;
    if (r.score[t] >= 70) hot++;
    if (fin(r.usd)) usd += r.leg.s * r.usd;
    if (fin(r.flow)) flow += r.leg.s * r.flow;
    if (fin(r.r4)) { mom += r.leg.s * r.r4; momN++; }
  }
  const w52 = Array.from(comp.subarray(Math.max(0, t - 51), t + 1)).filter(fin);
  const res = {
    th, comp, legs, t, now: comp[t], d4: comp[t] - comp[t - 4], d13: comp[t] - comp[t - 13],
    hi: w52.length ? Math.max(...w52) : NaN, lo: w52.length ? Math.min(...w52) : NaN,
    breadth: live ? hot / live : NaN, live, total: th.legs.length, usd, flow, mom: momN ? mom / momN : NaN,
  };
  res.status = themeStatus(res);
  cache.set(ck, res);
  return res;
}
function themeStatus(r) {
  if (!fin(r.now)) return { k: 'neutral', label: 'No data' };
  if (r.now >= 75 && r.d4 <= -10) return { k: 'serious', label: 'Unwinding' };
  if (r.now >= 75 && fin(r.mom) && r.mom < 0) return { k: 'critical', label: 'Crowded, offside' };
  if (r.now >= 75) return { k: 'warning', label: 'Crowded, working' };
  if (r.now <= 25) return { k: 'info', label: 'Washed out' };
  if (r.d4 >= 10) return { k: 'neutral', label: 'Building' };
  return { k: 'neutral', label: 'Neutral' };
}

/* ------------------------------------------------------------------ washout map */
function corr(a, b, minN) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== x || y !== y) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < minN) return NaN;
  const ma = sa / n, mb = sb / n, va = saa / n - ma * ma, vb = sbb / n - mb * mb;
  return va > 1e-12 && vb > 1e-12 ? (sab / n - ma * mb) / Math.sqrt(va * vb) : NaN;
}
/* average-linkage agglomerative clustering on a distance matrix */
function hcluster(D) {
  let nodes = D.map((_, i) => ({ items: [i], h: 0 }));
  while (nodes.length > 1) {
    let best = Infinity, bi = 0, bj = 1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let s = 0, c = 0;
        for (const a of nodes[i].items) for (const b of nodes[j].items) { const d = D[a][b]; if (d === d) { s += d; c++; } }
        const avg = c ? s / c : 2;
        if (avg < best) { best = avg; bi = i; bj = j; }
      }
    }
    const node = { items: nodes[bi].items.concat(nodes[bj].items), h: best, kids: [nodes[bi], nodes[bj]] };
    nodes = nodes.filter((_, k) => k !== bi && k !== bj);
    nodes.push(node);
  }
  return nodes[0];
}
function leaves(node, out = []) {
  if (!node.kids) out.push(node.items[0]); else { leaves(node.kids[0], out); leaves(node.kids[1], out); }
  return out;
}
function clustersAt(node, maxH, out = []) {
  if (node.items.length >= 2 && node.h <= maxH) out.push(node.items);
  else if (node.kids) { clustersAt(node.kids[0], maxH, out); clustersAt(node.kids[1], maxH, out); }
  return out;
}
function washout() {
  const ck = `w|${S.kind}|${S.role}|${S.lb}|${S.corrSrc}|${S.corrOrient}|${S.corrLb}|${S.corrCrowded}`;
  if (cache.has(ck)) return cache.get(ck);
  const n = TS.length, win = S.corrLb, t0 = n - win;
  const rows = allMetrics().filter((r) => !r.na && fin(r.p) && r.t === n - 1 && (!S.corrCrowded || Math.abs(r.p - 50) >= 25));
  const vecs = rows.map((r) => {
    const sign = S.corrOrient ? (r.p >= 50 ? 1 : -1) : 1;
    const v = new Float64Array(win).fill(NaN);
    if (S.corrSrc === 'flows') {
      const s = ser(r.key, S.kind, r.cl);
      for (let i = 0; i < win; i++) v[i] = sign * s.dp[t0 + i];
    } else if (CP[r.key]) {
      const cp = CP[r.key];
      for (let i = 0; i < win; i++) v[i] = sign * (cp[t0 + i] / cp[t0 + i - 1] - 1);
    }
    return { r, sign, v };
  }).filter((x) => x.v.some(fin));
  const k = vecs.length, C = vecs.map(() => new Array(k).fill(NaN)), D = vecs.map(() => new Array(k).fill(NaN));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const c = i === j ? 1 : corr(vecs[i].v, vecs[j].v, Math.round(win * 0.6));
      C[i][j] = C[j][i] = c;
      D[i][j] = D[j][i] = fin(c) ? 1 - c : NaN;
    }
  }
  const root = k > 1 ? hcluster(D) : null;
  const order = root ? leaves(root) : vecs.map((_, i) => i);
  const clusters = (root ? clustersAt(root, 0.65) : []).map((items) => {
    let s = 0, c = 0, crowd = 0, gross = 0, net = 0;
    for (const a of items) {
      crowd += Math.abs(vecs[a].r.p - 50) * 2;
      if (fin(vecs[a].r.usd)) { gross += Math.abs(vecs[a].r.usd); net += vecs[a].sign * vecs[a].r.usd; }
      for (const b of items) if (a < b && fin(C[a][b])) { s += C[a][b]; c++; }
    }
    const avgC = c ? s / c : NaN, avgCrowd = crowd / items.length;
    return { items, avgC, avgCrowd, gross, score: avgCrowd * Math.max(0, avgC) * Math.sqrt(items.length) };
  }).sort((a, b) => b.score - a.score);
  const res = { vecs, C, order, clusters, win };
  cache.set(ck, res);
  return res;
}

/* ======================================================================= UI primitives */
function sparkSVG(vals, w = 72, h = 22) {
  const v = vals.filter(fin);
  if (v.length < 2) return '';
  let lo = Math.min(...v, 0), hi = Math.max(...v, 0);
  if (hi === lo) hi = lo + 1;
  const x = (i) => 2 + (i / (vals.length - 1)) * (w - 6), y = (val) => h - 3 - ((val - lo) / (hi - lo)) * (h - 6);
  let d = '';
  vals.forEach((val, i) => { if (fin(val)) d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(val).toFixed(1); });
  const end = vals[vals.length - 1], z = y(0).toFixed(1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<line x1="0" x2="${w}" y1="${z}" y2="${z}" style="stroke:var(--line-2)" stroke-width="1"/>` +
    `<path d="${d}" fill="none" style="stroke:var(--ink-2)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    (fin(end) ? `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="2.6" style="fill:${end >= 0 ? 'var(--pos-line)' : 'var(--neg-line)'}"/>` : '') + '</svg>';
}
function rangeBar(lo, hi, now, w = 90, h = 14) {
  if (!fin(lo) || !fin(hi) || !fin(now)) return '–';
  const x = (v) => 2 + (v / 100) * (w - 4);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><rect x="2" y="6" width="${w - 4}" height="2" rx="1" style="fill:var(--line)"/>` +
    `<rect x="${x(lo).toFixed(1)}" y="5" width="${Math.max(2, x(hi) - x(lo)).toFixed(1)}" height="4" rx="2" style="fill:var(--line-2)"/>` +
    `<circle cx="${x(now).toFixed(1)}" cy="7" r="4" style="fill:var(--ink);stroke:var(--surface)" stroke-width="2"/></svg>`;
}
function tileHTML({ label, value, sub = '', spark = null, title = '' }) {
  return `<div class="tile"${title ? ` title="${esc(title)}"` : ''}><div class="lbl">${esc(label)}</div><div class="val">${value}</div>` +
    `<div class="sub">${sub}</div>${spark ? tileSpark(spark) : ''}</div>`;
}
function tileSpark(vals) {
  const v = vals.filter(fin);
  if (v.length < 2) return '';
  const w = 240, h = 34;
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi === lo) hi = lo + 1;
  const x = (i) => (i / (vals.length - 1)) * (w - 6) + 1, y = (val) => h - 4 - ((val - lo) / (hi - lo)) * (h - 8);
  let d = '';
  vals.forEach((val, i) => { if (fin(val)) d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(val).toFixed(1); });
  const area = d + `L${x(vals.length - 1).toFixed(1)} ${h}L${x(0).toFixed(1)} ${h}Z`;
  const z = lo < 0 && hi > 0 ? `<line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" style="stroke:var(--line-2)" stroke-width="1"/>` : '';
  const end = vals[vals.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${z}<path d="${area}" style="fill:var(--accent);opacity:.1"/>` +
    `<path d="${d}" fill="none" style="stroke:var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` +
    (fin(end) ? `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="3" style="fill:var(--accent)"/>` : '') + '</svg>';
}
function pctSub(p) { return fin(p) ? `${LB_LABEL[S.lb]} pctl <b>${Math.round(p)}</b>` : ''; }

/* sortable table: cols [{k, h, g, t, v(row), f(row), c(row) classes, l: left}] */
function table(id, el, cols, rows, opt = {}) {
  TABLES[id] = { el, cols, rows, opt };
  const st = S.sort[id] || { k: opt.sort || null, d: opt.dir || -1 };
  const col = cols.find((c) => c.k === st.k);
  let list = rows.slice();
  if (col) {
    list.sort((a, b) => {
      const va = a.na ? undefined : col.v(a), vb = b.na ? undefined : col.v(b);
      const ea = va === undefined || va === null || (typeof va === 'number' && !isFinite(va));
      const eb = vb === undefined || vb === null || (typeof vb === 'number' && !isFinite(vb));
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      return typeof va === 'string' ? st.d * va.localeCompare(vb) : st.d * (va - vb);
    });
  }
  TABLES[id].sorted = list;
  let groups = '';
  if (cols.some((c) => c.g)) {
    let cur = null, span = 0;
    const cells = [];
    const flush = () => { if (span) cells.push(`<th class="grp${cur ? ' sep' : ''}" colspan="${span}">${esc(cur || '')}</th>`); };
    for (const c of cols) { if (c.g !== cur) { flush(); cur = c.g; span = 0; } span++; }
    flush();
    groups = `<tr>${cells.join('')}</tr>`;
  }
  let prevG;
  const head = cols.map((c) => {
    const sep = c.g && c.g !== prevG ? ' sep' : '';
    prevG = c.g;
    const arr = st.k === c.k ? (st.d > 0 ? '▲' : '▼') : '';
    return `<th class="${c.l ? 'l' : ''}${c.k === 'mk' ? ' mk' : ''}${sep}" data-k="${c.k}"${c.t ? ` title="${esc(c.t)}"` : ''} scope="col">${esc(c.h)}<span class="arr">${arr}</span></th>`;
  }).join('');
  const body = list.map((r) => {
    if (r.na) {
      return `<tr data-key="${esc(r.key)}"><td class="mk">${cols[0].f(r)}</td><td class="l na" colspan="${cols.length - 1}">${esc(r.na)}</td></tr>`;
    }
    let pg;
    const tds = cols.map((c) => {
      const sep = c.g && c.g !== pg ? ' sep' : '';
      pg = c.g;
      const cls = (c.c ? c.c(r) : '') + (c.l ? ' l' : '') + (c.k === 'mk' ? ' mk' : '') + sep;
      return `<td class="${cls.trim()}">${c.f(r)}</td>`;
    }).join('');
    return `<tr data-key="${esc(r.key || '')}"${r._attr || ''}>${tds}</tr>`;
  }).join('');
  const foot = opt.foot ? `<tfoot>${opt.foot}</tfoot>` : '';
  el.innerHTML = `<table class="t"><thead>${groups}<tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
  el.querySelector('thead').onclick = (e) => {
    const th = e.target.closest('th[data-k]');
    if (!th) return;
    const k = th.dataset.k;
    const cur = S.sort[id] || { k: opt.sort, d: opt.dir || -1 };
    S.sort[id] = cur.k === k ? { k, d: -cur.d } : { k, d: cols.find((c) => c.k === k).l ? 1 : -1 };
    save();
    table(id, el, cols, rows, opt);
  };
  if (opt.onRow) {
    el.querySelector('tbody').onclick = (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (tr && tr.dataset.key) opt.onRow(tr.dataset.key, e);
    };
  }
}
function copyTable(id, btn) {
  const t = TABLES[id];
  if (!t) return;
  const strip = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.trim(); };
  const lines = [t.cols.map((c) => c.h).join('\t')];
  for (const r of t.sorted) lines.push(r.na ? strip(t.cols[0].f(r)) + '\t' + r.na : t.cols.map((c) => strip(c.f(r))).join('\t'));
  const text = lines.join('\n');
  const done = () => { const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = o; }, 1400); };
  try {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } catch (e) { fallbackCopy(text, done); }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* the selection stays for manual copy */ }
  ta.remove();
}

/* ---------------------------------------------------------- column library */
const COL = {
  mk: { k: 'mk', h: 'Market', l: true, v: (r) => r.m.name, f: (r) => `<span class="nm">${esc(r.m.name)}</span><span class="gp">${esc(r.m.group)}</span>${r.stale ? `<span class="badge" title="Latest report for this contract: ${esc(r.date || '')}">STALE</span>` : ''}` },
  asset: { k: 'asset', h: 'Asset', l: true, v: (r) => r.m.asset, f: (r) => esc(r.m.asset) },
  net: { k: 'net', h: 'Net', g: 'Contracts', t: 'Net position (longs minus shorts), contracts', v: (r) => r.net, f: (r) => fmtK(r.net) },
  d1: { k: 'd1', h: 'Δ 1w', g: 'Contracts', t: 'Change in net position on the week, contracts', v: (r) => r.d1, f: (r) => fmtK(r.d1, true) },
  d4: { k: 'd4', h: 'Δ 4w', g: 'Contracts', v: (r) => r.d4, f: (r) => fmtK(r.d4, true) },
  usd: { k: 'usd', h: 'Net $', g: 'USD notional', t: 'Net position x contract size x futures price on the report date (rates: 10Y-note-equivalent notional)', v: (r) => r.usd, f: (r) => fmtUSD(r.usd) },
  flow: { k: 'flow', h: 'Flow 1w', g: 'USD notional', t: 'Weekly change in net contracts, valued at the report-date price', v: (r) => r.flow, f: (r) => fmtUSD(r.flow, true) },
  flow4: { k: 'flow4', h: 'Flow 4w', g: 'USD notional', v: (r) => r.flow4, f: (r) => fmtUSD(r.flow4, true) },
  pct: { k: 'pct', h: '% OI', g: 'Net as % of open interest', t: 'Net position as a share of open interest', v: (r) => r.pct, f: (r) => fmtN(r.pct, 1, true) },
  dp1: { k: 'dp1', h: 'Δ pp', g: 'Net as % of open interest', t: 'Weekly change in net % of OI, percentage points', v: (r) => r.dp1, f: (r) => fmtN(r.dp1, 1, true) },
  spark: { k: 'spark', h: '52w', g: 'Net as % of open interest', t: 'Net % of OI, last 52 weeks', v: (r) => r.pct, f: (r) => sparkSVG(r.spark) },
  z: { k: 'z', h: 'Z 3Y', g: 'Signals', t: 'Z-score of net % OI over 3 years', v: (r) => r.z, f: (r) => fmtN(r.z, 1, true) },
  fz: { k: 'fz', h: 'Flow z', g: 'Signals', t: 'This week\'s change in net % OI against the 3-year distribution of weekly changes', v: (r) => r.fz, f: (r) => fmtN(r.fz, 1, true) },
  dP4: { k: 'dP4', h: 'Δ pctl 4w', g: 'Signals', t: 'Change in the selected-window percentile over 4 weeks', v: (r) => r.dP4, f: (r) => fmtN(r.dP4, 0, true) },
  drv: { k: 'drv', h: 'Driver 1w', g: 'Signals', l: true, t: 'Largest weekly change in gross longs or shorts', v: (r) => (r.driver ? r.driver.label : ''), f: (r) => (r.driver ? `<span class="drv ${r.driver.k}">${r.driver.label}</span>` : '–') },
  L: { k: 'L', h: 'Longs', g: 'Gross', v: (r) => r.L, f: (r) => fmtK(r.L) },
  S: { k: 'S', h: 'Shorts', g: 'Gross', v: (r) => r.S, f: (r) => fmtK(r.S) },
  tr: { k: 'tr', h: 'Traders L/S', g: 'Gross', t: 'Number of reportable traders long / short', v: (r) => r.tL - r.tS, f: (r) => (fin(r.tL) ? `${r.tL} / ${r.tS}` : '–') },
  c4: { k: 'c4', h: 'Top-4 L/S', g: 'Gross', t: 'Share of open interest held by the 4 largest longs / shorts (all traders)', v: (r) => r.conc.g4L - r.conc.g4S, f: (r) => (fin(r.conc.g4L) ? `${r.conc.g4L.toFixed(0)} / ${r.conc.g4S.toFixed(0)}%` : '–') },
  oi: { k: 'oi', h: 'OI', g: 'Market', t: 'Open interest, contracts', v: (r) => r.oi, f: (r) => fmtK(r.oi) },
  doi: { k: 'doi', h: 'Δ OI', g: 'Market', v: (r) => r.doi, f: (r) => fmtChg(r.doi) },
  px: { k: 'px', h: 'Price', g: 'Market', t: 'Futures price on the report date (FX in market convention)', v: (r) => r.px, f: (r) => dispPx(r.m, r.px) },
  r1: { k: 'r1', h: 'Δ 1w', g: 'Market', t: 'Futures price change over the week (long-contract P&L)', v: (r) => r.r1, f: (r) => fmtChg(r.r1) },
  r4: { k: 'r4', h: 'Δ 4w', g: 'Market', t: 'Futures price change over 4 weeks (long-contract P&L)', v: (r) => r.r4, f: (r) => fmtChg(r.r4) },
  rsr: { k: 'rsr', h: 'Since Tue', g: 'Market', t: 'Price change from the report date to the latest close: how the positions have fared since', v: (r) => r.rsr, f: (r) => fmtChg(r.rsr) },
  dv01: { k: 'dv01', h: 'DV01 /bp', g: 'Risk', t: 'Net DV01 in $ per basis point (approximate contract DV01s)', v: (r) => r.dv01, f: (r) => fmtUSD(r.dv01) },
  eq10: { k: 'eq10', h: '10Y eq.', g: 'Risk', t: 'Net position in 10Y-note equivalents (DV01-weighted)', v: (r) => r.eq10, f: (r) => fmtK(r.eq10) },
};
for (const w of LBS) {
  COL['p' + w] = {
    k: 'p' + w, h: LB_LABEL[w], g: 'Percentile of net % OI', t: `Percentile of net % OI within the trailing ${LB_LONG[w]} window`,
    v: (r) => r.P[w], f: (r) => fmtP(r.P[w]), c: (r) => 'heat ' + heatClass(r.P[w]),
  };
}
const PCOLS = LBS.map((w) => COL['p' + w]);
function assetCols(asset) {
  const core = [COL.mk, COL.net, COL.d1, COL.usd, COL.flow, COL.pct, COL.spark, ...PCOLS, COL.z, COL.fz, COL.drv, COL.oi, COL.px, COL.r4, COL.rsr];
  const all = [COL.mk, COL.net, COL.d1, COL.d4, COL.usd, COL.flow, COL.flow4, COL.pct, COL.dp1, COL.spark, ...PCOLS, COL.z, COL.fz, COL.dP4, COL.drv,
    COL.L, COL.S, COL.tr, COL.c4, COL.oi, COL.doi, COL.px, COL.r1, COL.r4, COL.rsr];
  const cols = S.cols === 'all' ? all : core;
  if (asset === 'Rates') {
    const i = cols.indexOf(COL.flow) + 1;
    return [...cols.slice(0, i), COL.dv01, COL.eq10, ...cols.slice(i)];
  }
  return cols;
}

/* ---------------------------------------------------------- charts */
function chartColors() {
  return {
    ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'), grid: cssVar('--grid'), axis: cssVar('--axis'),
    surface: cssVar('--surface'), line2: cssVar('--line-2'), accent: cssVar('--accent'),
    pos: cssVar('--pos-line'), neg: cssVar('--neg-line'), slot: (i) => cssVar('--c' + i),
    l1: cssVar('--l1'), l2: cssVar('--l2'), l3: cssVar('--l3'), s1: cssVar('--s1'), s2: cssVar('--s2'), s3: cssVar('--s3'),
    corrPos: cssVar('--corr-pos'), corrNeg: cssVar('--corr-neg'), corrMid: cssVar('--corr-mid'),
  };
}
function mkChart(el, option, group) {
  if (!window.echarts || !el) return null;
  const c = echarts.init(el, null, { renderer: 'canvas' });
  const col = chartColors();
  option.animation = false;
  option.textStyle = { fontFamily: 'Archivo, system-ui, sans-serif', color: col.ink2 };
  option.tooltip = Object.assign({
    backgroundColor: col.surface, borderColor: col.line2, borderWidth: 1, padding: [6, 9],
    textStyle: { color: col.ink, fontSize: 12 }, confine: true,
  }, option.tooltip || {});
  c.setOption(option);
  if (group) { c.group = group; }
  charts.push(c);
  return c;
}
function axisX(col) {
  return {
    type: 'time', axisLine: { lineStyle: { color: col.axis } }, axisTick: { show: false },
    axisLabel: { color: col.muted, fontSize: 11, hideOverlap: true }, splitLine: { show: false },
  };
}
function axisY(col, extra = {}) {
  return Object.assign({
    type: 'value', scale: true, axisLine: { show: false }, axisTick: { show: false },
    axisLabel: { color: col.muted, fontSize: 11 }, splitLine: { lineStyle: { color: col.grid } },
  }, extra);
}
function zoomFor(range, startIdx = 0) {
  const n = TS.length;
  const s = range ? Math.max(startIdx, n - range) : startIdx;
  return [{ type: 'inside', startValue: TS[s], endValue: TS[n - 1], zoomOnMouseWheel: 'shift', moveOnMouseWheel: false, moveOnMouseMove: false }];
}
function lineData(a, f = (v) => v, from = 0) {
  const out = [];
  for (let i = Math.max(0, from); i < a.length; i++) { const v = a[i]; out.push([TS[i], v === v ? f(v) : null]); }
  return out;
}
function tipAxis(fmt) {
  return (ps) => {
    if (!ps || !ps.length) return '';
    const head = `<div style="font-weight:650;margin-bottom:3px">${fmtDate(isoOf(ps[0].axisValue))}</div>`;
    return head + ps.filter((p) => p.value && p.value[1] != null && !p.seriesName.startsWith('_')).map((p) =>
      `<div style="display:flex;justify-content:space-between;gap:14px;align-items:center"><span><span style="display:inline-block;width:12px;height:2px;background:${p.color};vertical-align:middle;margin-right:6px"></span>${esc(p.seriesName)}</span><b>${fmt(p.value[1], p)}</b></div>`).join('');
  };
}
function lineSeries(name, data, color, extra = {}) {
  return Object.assign({ name, type: 'line', data, showSymbol: false, symbol: 'none', connectNulls: false, lineStyle: { width: 2, color }, itemStyle: { color }, emphasis: { disabled: true } }, extra);
}
function legendCfg(col) { return { top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: col.ink2, fontSize: 11.5 } }; }
/* horizontal bars, values centred on a baseline (e.g. percentile - 50) */
function barChart(el, rows, { value, label, fmt, color, axisFmt, height, min, max }) {
  const col = chartColors();
  const data = rows.filter((r) => fin(value(r)));
  el.style.height = (height || Math.max(180, data.length * 22 + 40)) + 'px';
  const names = data.map(label);
  return mkChart(el, {
    grid: { left: 8, right: 54, top: 8, bottom: 22, containLabel: true },
    xAxis: { type: 'value', min, max, interval: min === -50 ? 25 : undefined, axisLabel: { color: col.muted, fontSize: 11, formatter: axisFmt }, splitLine: { lineStyle: { color: col.grid } }, axisLine: { show: false } },
    yAxis: { type: 'category', data: names, inverse: true, axisTick: { show: false }, axisLine: { lineStyle: { color: col.axis } }, axisLabel: { color: col.ink2, fontSize: 11.5 } },
    tooltip: { trigger: 'item', formatter: (p) => `<b>${fmt(data[p.dataIndex])}</b><br>${esc(names[p.dataIndex])}` },
    series: [{
      type: 'bar', barMaxWidth: 14, data: data.map((r) => {
        const v = value(r);
        return { value: v, itemStyle: { color: color(r, v, col), borderRadius: v >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] } };
      }),
      label: { show: true, position: 'right', color: col.ink2, fontSize: 11, formatter: (p) => fmt(data[p.dataIndex]) },
    }],
  });
}
function pctColor(p, col) {
  if (!fin(p)) return col.line2;
  if (p >= 95) return col.l3; if (p >= 85) return col.l2; if (p >= 70) return col.l2;
  if (p <= 5) return col.s3; if (p <= 15) return col.s2; if (p <= 30) return col.s2;
  return col.line2;
}
function disposeCharts() { while (charts.length) { try { charts.pop().dispose(); } catch (e) { /* already gone */ } } }

/* ======================================================================= shell */
function renderAsOf() {
  const lt = META.latest;
  const gen = new Date(META.generated);
  const next = addDays(lt, 10);
  $('#asof').innerHTML = `Positions as of <b>${fmtDate(lt)}</b> · published ${fmtDate(addDays(lt, 3), { weekday: 'short', day: 'numeric', month: 'short' })} · next report usually ${fmtDate(next, { weekday: 'short', day: 'numeric', month: 'short' })} · data refreshed ${gen.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
function initControls() {
  const role = $('#ctl-role');
  role.innerHTML = Object.entries(ROLES).map(([k, r]) => `<option value="${k}">${esc(r.label)}</option>`).join('');
  role.value = S.role;
  $('#ctl-kind').value = S.kind;
  $('#ctl-lb').value = String(S.lb);
  role.onchange = () => { S.role = role.value; save(); render(); };
  $('#ctl-kind').onchange = async (e) => { S.kind = e.target.value; save(); await ensureKind(S.kind); render(); };
  $('#ctl-lb').onchange = (e) => { S.lb = +e.target.value; save(); render(); };
  const tabs = $('#tabs');
  tabs.innerHTML = TABS.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="false">${l}</button>`).join('');
  tabs.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); };
  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) copyTable(c.dataset.copy, c);
    const g = e.target.closest('[data-go]');
    if (g) go(g.dataset.go);
  });
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => render());
  new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', debounce(() => charts.forEach((c) => c.resize()), 150));
}
function go(tab) {
  S.tab = tab;
  save();
  if (location.hash.slice(1) !== tab) { try { history.replaceState(null, '', '#' + tab); } catch (e) { /* ignore */ } }
  render();
  window.scrollTo({ top: 0 });
}
function openMarket(key) { S.market = key; go('charts'); }
function route() {
  const h = location.hash.slice(1);
  if (TABS.some(([k]) => k === h)) S.tab = h;
  render();
}
function render() {
  disposeCharts();
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  const main = $('#main');
  main.innerHTML = '';
  const sec = document.createElement('section');
  sec.className = 'sheet';
  main.appendChild(sec);
  try {
    (RENDER[S.tab] || RENDER.overview)(sec);
  } catch (e) {
    console.error(e);
    sec.innerHTML = `<div class="banner">This view failed to render: ${esc(e.message)}</div>`;
  }
}
function panel(title, { note = '', tools = '', body = '', id = '', bodyClass = 'panel-body' } = {}) {
  return `<div class="panel"${id ? ` id="${id}"` : ''}><div class="panel-head"><h3>${title}</h3>${note ? `<span class="note">${note}</span>` : ''}${tools ? `<div class="tools">${tools}</div>` : ''}</div><div class="${bodyClass}">${body}</div></div>`;
}
function seg(id, options, current) {
  return `<div class="seg" role="group" id="${id}">${options.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join('')}</div>`;
}
function onSeg(id, fn) {
  const el = document.getElementById(id);
  if (el) el.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (b) fn(b.dataset.v); };
}
const RENDER = {};

/* ======================================================================= overview */
RENDER.overview = (sec) => {
  const rows = allMetrics();
  const usdG10 = aggStats(aggSeries(G10, { sign: -1 }));
  const eq = aggStats(aggSeries(USEQ));
  const amDv = aggStats(aggSeries(UST, { mode: 'dv01', role: 'am' }));
  const lfDv = aggStats(aggSeries(UST, { mode: 'dv01', role: 'spec' }));
  const cmd = aggStats(aggSeries(META.markets.filter((m) => m.asset === 'Commodities').map((m) => m.key)));
  const themes = allThemes().map(themeData).filter((t) => fin(t.now)).sort((a, b) => b.now - a.now);
  const top = themes[0];
  const usdWord = (v) => (v >= 0 ? 'long' : 'short');
  sec.innerHTML = `
    <div class="sheet-head"><h2>Cross-asset positioning</h2><p>${esc(roleLabel())}, ${kindLabel()}. Percentiles rank net position as a share of open interest within a ${lbLabel()}.</p></div>
    <div class="tiles">
      ${tileHTML({ label: 'USD vs G10 IMM currencies', value: `${fmtUSD(Math.abs(usdG10.v))} ${usdWord(usdG10.v)}`, sub: `Δ1w ${fmtUSD(usdG10.d1, true)} · ${pctSub(usdG10.p)}`, spark: usdG10.spark, title: 'Minus the sum of net USD notional in EUR, JPY, GBP, CHF, CAD, AUD and NZD futures' })}
      ${tileHTML({ label: 'US equity index futures', value: fmtUSD(eq.v), sub: `Δ1w ${fmtUSD(eq.d1, true)} · ${pctSub(eq.p)}`, spark: eq.spark, title: 'S&P 500, Nasdaq-100, Dow, Russell 2000 and MidCap futures' })}
      ${tileHTML({ label: 'UST futures DV01 · asset managers', value: fmtUSD(amDv.v) + '/bp', sub: `Δ1w ${fmtUSD(amDv.d1, true)} · ${pctSub(amDv.p)}`, spark: amDv.spark })}
      ${tileHTML({ label: 'UST futures DV01 · leveraged funds', value: fmtUSD(lfDv.v) + '/bp', sub: `Δ1w ${fmtUSD(lfDv.d1, true)} · ${pctSub(lfDv.p)}`, spark: lfDv.spark, title: 'Dominated by the cash-futures basis trade; read changes, not the level' })}
      ${tileHTML({ label: 'Commodities, net', value: fmtUSD(cmd.v), sub: `Δ1w ${fmtUSD(cmd.d1, true)} · ${pctSub(cmd.p)}`, spark: cmd.spark })}
      ${top ? tileHTML({ label: 'Most crowded theme', value: esc(top.th.name), sub: `score <b>${Math.round(top.now)}</b> · Δ4w ${fmtN(top.d4, 0, true)} · <span class="pill ${top.status.k}">${top.status.label}</span>` }) : ''}
    </div>
    ${panel('Crowding map', { note: `Every market, ${esc(ROLES[S.role].short)}. Click a row for its charts.`, tools: `${HEAT_KEY}<button class="btn" data-copy="ov-map">Copy</button>`, body: '<div class="tablewrap" id="ov-map"></div>', bodyClass: '' })}
    <div class="grid3">
      ${panel('Most crowded longs', { body: '<div class="tablewrap" id="ov-long"></div>', bodyClass: '' })}
      ${panel('Most crowded shorts', { body: '<div class="tablewrap" id="ov-short"></div>', bodyClass: '' })}
      ${panel('Biggest flows this week', { note: 'z of the weekly change in % OI', body: '<div class="tablewrap" id="ov-flow"></div>', bodyClass: '' })}
    </div>
    ${panel('Theme crowding', { note: 'Average signed percentile of each theme\'s legs. 100 = every leg at its most crowded in the theme\'s direction.', tools: '<button class="btn" data-go="themes">All themes</button>', body: '<div class="tablewrap" id="ov-themes"></div>', bodyClass: '' })}`;
  const live = rows.filter((r) => !r.na);
  table('ov-map', $('#ov-map'), [COL.mk, COL.asset, COL.usd, COL.flow, COL.pct, COL.spark, ...PCOLS, COL.z, COL.fz, COL.drv, COL.r4, COL.rsr],
    rows, { sort: 'p' + S.lb, dir: -1, onRow: openMarket });
  const small = [COL.mk, Object.assign({}, COL['p' + S.lb], { g: null }), Object.assign({}, COL.usd, { g: null }), Object.assign({}, COL.r4, { g: null, h: 'Px 4w' })];
  table('ov-long', $('#ov-long'), small, live.filter((r) => fin(r.p)).sort((a, b) => b.p - a.p).slice(0, 10), { onRow: openMarket });
  table('ov-short', $('#ov-short'), small, live.filter((r) => fin(r.p)).sort((a, b) => a.p - b.p).slice(0, 10), { onRow: openMarket });
  table('ov-flow', $('#ov-flow'), [COL.mk, Object.assign({}, COL.fz, { g: null }), Object.assign({}, COL.flow, { g: null }), Object.assign({}, COL.drv, { g: null })],
    live.filter((r) => fin(r.fz)).sort((a, b) => Math.abs(b.fz) - Math.abs(a.fz)).slice(0, 10), { onRow: openMarket });
  themeTable('ov-themes', $('#ov-themes'), themes.slice(0, 10), true);
};

/* ======================================================================= asset tabs */
function assetTiles(asset, rows) {
  const t = [];
  const statTile = (label, a, opt = {}) => {
    const s = aggStats(a);
    const v = opt.fmt ? opt.fmt(s.v) : fmtUSD(s.v);
    return tileHTML({ label, value: v, sub: `Δ1w ${opt.fmt ? opt.fmt(s.d1, true) : fmtUSD(s.d1, true)} · ${pctSub(s.p)}`, spark: s.spark, title: opt.title || '' });
  };
  const dvf = (v, plus) => fmtUSD(v, plus) + '/bp';
  if (asset === 'FX') {
    const a = aggStats(aggSeries(G10, { sign: -1 }));
    t.push(tileHTML({ label: 'USD vs G10 IMM currencies', value: `${fmtUSD(Math.abs(a.v))} ${a.v >= 0 ? 'long' : 'short'}`, sub: `Δ1w ${fmtUSD(a.d1, true)} · ${pctSub(a.p)}`, spark: a.spark }));
    const b = aggStats(aggSeries(G10.concat(EMFX), { sign: -1 }));
    t.push(tileHTML({ label: 'USD vs G10 + MXN, BRL, ZAR', value: `${fmtUSD(Math.abs(b.v))} ${b.v >= 0 ? 'long' : 'short'}`, sub: `Δ1w ${fmtUSD(b.d1, true)} · ${pctSub(b.p)}`, spark: b.spark }));
    t.push(statTile('USD vs G10 · asset managers', aggSeries(G10, { sign: -1, role: 'am' })));
    t.push(statTile('USD vs G10 · legacy non-commercials', aggSeries(G10, { sign: -1, role: 'nc' })));
  } else if (asset === 'Rates') {
    t.push(statTile('UST futures DV01 · asset managers', aggSeries(UST, { mode: 'dv01', role: 'am' }), { fmt: dvf }));
    t.push(statTile('UST futures DV01 · leveraged funds', aggSeries(UST, { mode: 'dv01', role: 'spec' }), { fmt: dvf, title: 'Dominated by the cash-futures basis trade' }));
    t.push(statTile('UST futures DV01 · dealers', aggSeries(UST, { mode: 'dv01', role: 'dealer' }), { fmt: dvf }));
    t.push(statTile('SOFR + fed funds DV01 · leveraged funds', aggSeries(STIR, { mode: 'dv01', role: 'spec' }), { fmt: dvf }));
  } else if (asset === 'Equities') {
    t.push(statTile(`US index futures · ${ROLES[S.role].short}`, aggSeries(USEQ)));
    t.push(statTile('US index futures · asset managers', aggSeries(USEQ, { role: 'am' })));
    t.push(statTile('US index futures · leveraged funds', aggSeries(USEQ, { role: 'spec' })));
    const v = rows.find((r) => r.key === 'VIX');
    if (v && !v.na) {
      t.push(tileHTML({ label: `VIX futures · ${ROLES[S.role].short}`, value: `${fmtUSD(v.net * 1000)}/vol pt`, sub: `${fmtK(v.net)} contracts · Δ1w ${fmtK(v.d1, true)} · ${pctSub(v.p)}`, spark: v.spark }));
    }
  } else if (asset === 'Commodities') {
    for (const sct of SECTORS) {
      t.push(statTile(`${sct} · ${ROLES[S.role].short}`, aggSeries(META.markets.filter((m) => m.group === sct).map((m) => m.key))));
    }
  } else if (asset === 'Crypto') {
    t.push(statTile(`Bitcoin futures · ${ROLES[S.role].short}`, aggSeries(['BTC', 'MBT'])));
    t.push(statTile(`Ether futures · ${ROLES[S.role].short}`, aggSeries(['ETH', 'MET'])));
    t.push(statTile(`Solana + XRP · ${ROLES[S.role].short}`, aggSeries(['SOL', 'XRP'])));
    t.push(statTile('Bitcoin futures · asset managers', aggSeries(['BTC', 'MBT'], { role: 'am' })));
  }
  return t.join('');
}
const ASSET_INFO = {
  fx: { asset: 'FX', title: 'FX', desc: 'CME currency futures and the ICE dollar index. Long means long the currency against USD; for the dollar index, long USD. Asian FX coverage in the CFTC data is limited to JPY, AUD and NZD.' },
  rates: { asset: 'Rates', title: 'Rates', desc: 'Treasury, SOFR and fed funds futures. Leveraged-fund shorts in Treasury futures are mostly the cash-futures basis trade and asset-manager longs its other side, so read changes and percentiles rather than levels.' },
  equities: { asset: 'Equities', title: 'Equities', desc: 'US index futures (consolidated big, E-mini and micro contracts, in E-mini equivalents), Nikkei, MSCI EM/EAFE and VIX.' },
  commodities: { asset: 'Commodities', title: 'Commodities', desc: 'Disaggregated report: managed money is the speculative group, producers/merchants and swap dealers the hedgers and their banks.' },
  crypto: { asset: 'Crypto', title: 'Crypto', desc: 'CME bitcoin, ether, solana and XRP futures. History is short for the newer contracts, so long-window percentiles stay blank until there is enough of it.' },
};
function renderAsset(sec, tab) {
  const info = ASSET_INFO[tab];
  let rows = allMetrics().filter((r) => r.m.asset === info.asset);
  const groups = tab === 'commodities' ? ['All'].concat(SECTORS) : null;
  if (groups && S.comGroup !== 'All') rows = rows.filter((r) => r.m.group === S.comGroup);
  const live = rows.filter((r) => !r.na);
  const isRates = info.asset === 'Rates';
  sec.innerHTML = `
    <div class="sheet-head"><h2>${info.title}</h2><p>${esc(info.desc)}</p></div>
    ${groups ? `<div>${seg('com-grp', groups.map((g) => [g, g]), S.comGroup)}</div>` : ''}
    <div class="tiles">${assetTiles(info.asset, rows)}</div>
    ${live.length ? '' : `<div class="banner">${esc(rows[0] ? rows[0].na : 'No data')}. Pick another trader group above.</div>`}
    ${panel(`Positioning · ${esc(ROLES[S.role].short)}`, { note: kindLabel(), tools: `${HEAT_KEY}${seg('cols', [['core', 'Core columns'], ['all', 'All columns']], S.cols)}<button class="btn" data-copy="as-main">Copy</button>`, body: '<div class="tablewrap" id="as-main"></div>', bodyClass: '' })}
    <div class="grid2">
      ${panel(`Percentile, ${LB_LABEL[S.lb]} window`, { note: 'Net % of OI ranked against its own history', body: '<div class="chart" id="as-bars"></div>' })}
      ${panel(isRates ? 'Net DV01 by contract' : 'Net USD notional by market', { note: isRates ? '$ per basis point' : 'Net position x contract size x price', body: '<div class="chart" id="as-usd"></div>' })}
    </div>
    ${panel(historyTitle(info.asset), { tools: seg('as-range', RANGES, S.range), body: '<div class="chart" id="as-hist"></div>' })}
    ${panel('All trader groups', { note: `Net contracts and ${LB_LABEL[S.lb]} percentile for every group in the report`, tools: '<button class="btn" data-copy="as-matrix">Copy</button>', body: '<div class="tablewrap" id="as-matrix"></div>', bodyClass: '' })}`;
  onSeg('com-grp', (v) => { S.comGroup = v; save(); render(); });
  onSeg('cols', (v) => { S.cols = v; save(); render(); });
  onSeg('as-range', (v) => { S.range = +v; save(); render(); });
  let foot = '';
  if (info.asset === 'FX' || info.asset === 'Rates' || info.asset === 'Equities') foot = assetFoot(info.asset, rows);
  table('as-main', $('#as-main'), assetCols(info.asset), rows, { sort: 'p' + S.lb, dir: -1, onRow: openMarket, foot });
  const byP = live.filter((r) => fin(r.p)).sort((a, b) => b.p - a.p);
  barChart($('#as-bars'), byP, {
    value: (r) => r.p - 50, label: (r) => r.m.name, fmt: (r) => fmtP(r.p), axisFmt: (v) => String(Math.round(v + 50)), min: -50, max: 50,
    color: (r, v, col) => pctColor(r.p, col),
  });
  const valueOf = isRates ? (r) => r.dv01 : (r) => r.usd;
  const byUsd = live.filter((r) => fin(valueOf(r))).sort((a, b) => valueOf(b) - valueOf(a));
  barChart($('#as-usd'), byUsd, {
    value: valueOf, label: (r) => r.m.name, fmt: (r) => (isRates ? fmtUSD(r.dv01) + '/bp' : fmtUSD(r.usd)),
    axisFmt: (v) => fmtUSD(v), color: (r, v, col) => (v >= 0 ? col.pos : col.neg),
  });
  historyChart($('#as-hist'), info.asset);
  matrixTable($('#as-matrix'), rows, info.asset === 'Commodities' ? 'disagg' : 'tff');
}
function assetFoot(asset, rows) {
  const live = rows.filter((r) => !r.na);
  const sum = (f) => live.reduce((s, r) => s + (fin(f(r)) ? f(r) : 0), 0);
  const cols = assetCols(asset);
  const cells = cols.map((c) => {
    if (c.k === 'mk') return `<td class="mk">${asset === 'FX' ? 'USD vs these futures' : 'Total'}</td>`;
    if (asset === 'FX') {
      const fx = live.filter((r) => r.key !== 'DXY');
      if (c.k === 'usd') return `<td title="Minus the sum of currency futures notional: positive = long USD">${fmtUSD(-fx.reduce((s, r) => s + (fin(r.usd) ? r.usd : 0), 0))}</td>`;
      if (c.k === 'flow') return `<td>${fmtUSD(-fx.reduce((s, r) => s + (fin(r.flow) ? r.flow : 0), 0), true)}</td>`;
      return '<td></td>';
    }
    if (c.k === 'usd') return `<td>${fmtUSD(sum((r) => r.usd))}</td>`;
    if (c.k === 'flow') return `<td>${fmtUSD(sum((r) => r.flow), true)}</td>`;
    if (c.k === 'dv01') return `<td>${fmtUSD(sum((r) => r.dv01))}</td>`;
    if (c.k === 'eq10') return `<td>${fmtK(sum((r) => r.eq10))}</td>`;
    return '<td></td>';
  });
  return `<tr>${cells.join('')}</tr>`;
}
function historyTitle(asset) {
  return {
    FX: 'USD vs G10 IMM currencies by trader group', Rates: 'UST futures DV01 by trader group', Equities: 'US index futures notional by trader group',
    Commodities: `Net notional by sector · ${ROLES[S.role].short}`, Crypto: 'Bitcoin futures notional by trader group',
  }[asset];
}
function historyChart(el, asset) {
  const col = chartColors();
  let series = [], fmt = (v) => fmtUSD(v);
  const grp = (keys, opt) => [['spec', 'lev'], ['am', 'am'], ['dealer', 'dealer'], ['oth', 'oth']].map(([role, cat]) =>
    lineSeries(CAT_LABEL[cat], lineData(aggSeries(keys, Object.assign({ role }, opt))), col.slot(CAT_SLOT[cat])));
  if (asset === 'FX') series = grp(G10, { sign: -1 }).concat([lineSeries(CAT_LABEL.nc, lineData(aggSeries(G10, { sign: -1, role: 'nc' })), col.slot(7))]);
  else if (asset === 'Rates') { series = grp(UST, { mode: 'dv01' }); fmt = (v) => fmtUSD(v) + '/bp'; }
  else if (asset === 'Equities') series = grp(USEQ, {});
  else if (asset === 'Crypto') series = grp(['BTC', 'MBT'], {});
  else if (asset === 'Commodities') {
    series = SECTORS.map((sct, i) => lineSeries(sct, lineData(aggSeries(META.markets.filter((m) => m.group === sct).map((m) => m.key))), col.slot(i + 1)));
  }
  mkChart(el, {
    grid: { left: 8, right: 16, top: 34, bottom: 24, containLabel: true },
    legend: legendCfg(col), xAxis: axisX(col), yAxis: axisY(col, { axisLabel: { color: col.muted, fontSize: 11, formatter: (v) => fmtUSD(v) } }),
    tooltip: { trigger: 'axis', formatter: tipAxis(fmt) }, dataZoom: zoomFor(S.range), series,
  });
}
function matrixTable(el, rows, report) {
  const cats = REPORT_CATS[report].concat(['nc']);
  const per = {};
  for (const r of rows) {
    per[r.key] = {};
    for (const c of cats) per[r.key][c] = metrics(r.key, { cl: [c] });
  }
  const cols = [COL.mk];
  for (const c of cats) {
    cols.push({ k: 'n_' + c, h: 'Net', g: CAT_SHORT[c], v: (r) => per[r.key][c].net, f: (r) => fmtK(per[r.key][c].net) });
    cols.push({ k: 'p_' + c, h: LB_LABEL[S.lb], g: CAT_SHORT[c], v: (r) => per[r.key][c].p, f: (r) => fmtP(per[r.key][c].p), c: (r) => 'heat ' + heatClass(per[r.key][c].p) });
  }
  const mrows = rows.map((r) => Object.assign({}, r, { na: per[r.key][cats[0]].na }));
  table('as-matrix', el, cols, mrows, { sort: 'p_' + cats[0], dir: -1, onRow: openMarket });
}
for (const tab of Object.keys(ASSET_INFO)) RENDER[tab] = (sec) => renderAsset(sec, tab);

/* ======================================================================= themes */
function themeTable(id, el, list, compact = false) {
  const rows = list.map((d) => Object.assign({ key: d.th.key }, d));
  const cols = [
    { k: 'mk', h: 'Theme', l: true, v: (r) => r.th.name, f: (r) => `<span class="nm">${esc(r.th.name)}</span>${r.th.custom ? '<span class="badge">CUSTOM</span>' : ''}${compact ? '' : `<div class="gp" style="margin-left:0;white-space:normal;max-width:42ch">${esc(r.th.desc || '')}</div>`}` },
    { k: 'now', h: 'Score', t: 'Average signed percentile of the legs (0-100)', v: (r) => r.now, f: (r) => fmtP(r.now), c: (r) => 'heat ' + heatClass(r.now) },
    { k: 'd4', h: 'Δ 4w', v: (r) => r.d4, f: (r) => fmtN(r.d4, 0, true) },
    { k: 'd13', h: 'Δ 13w', v: (r) => r.d13, f: (r) => fmtN(r.d13, 0, true) },
    { k: 'rng', h: '52w range', t: 'Score range over the last 52 weeks; dot = now', v: (r) => r.now - r.lo, f: (r) => rangeBar(r.lo, r.hi, r.now) },
    { k: 'br', h: 'Breadth', t: 'Share of legs scoring 70 or more', v: (r) => r.breadth, f: (r) => (fin(r.breadth) ? Math.round(r.breadth * 100) + '%' : '–') },
    { k: 'usd', h: 'Exposure', t: 'Signed USD notional of the legs, in the theme\'s direction', v: (r) => r.usd, f: (r) => fmtUSD(r.usd) },
    { k: 'flow', h: 'Flow 1w', t: 'Signed weekly USD flow into the theme', v: (r) => r.flow, f: (r) => fmtUSD(r.flow, true) },
    { k: 'mom', h: 'Px 4w', t: 'Average 4-week price move of the legs in the theme\'s direction', v: (r) => r.mom, f: (r) => fmtChg(r.mom) },
    { k: 'st', h: 'Status', l: true, v: (r) => ({ critical: 5, serious: 4, warning: 3, info: 1, neutral: 0 }[r.status.k] * 100 + (r.now || 0)), f: (r) => `<span class="pill ${r.status.k}">${r.status.label}</span>` },
  ];
  if (!compact) cols.splice(6, 0, { k: 'legs', h: 'Legs', t: 'Legs with data / total', v: (r) => r.live, f: (r) => `${r.live}/${r.total}` });
  table(id, el, cols, rows, { sort: 'now', dir: -1, onRow: (k) => { S.theme = k; save(); go('themes'); } });
}
RENDER.themes = (sec) => {
  const list = allThemes().map(themeData);
  if (!list.some((d) => d.th.key === S.theme)) S.theme = list[0].th.key;
  sec.innerHTML = `
    <div class="sheet-head"><h2>Themes</h2><p>Each theme is a signed basket. A leg scores its own percentile when long is the theme's direction and 100 minus it when short; the theme score is the average. High = the crowd is all-in on the theme, so it is the one most exposed to a washout.</p></div>
    <div class="chips">${seg('leg-mode', [['theme', 'Theme leg groups'], ['global', 'Use the trader-group selector for every leg']], S.legMode)}</div>
    ${panel('Theme crowding', { note: `${esc(roleLabel())} · ${LB_LABEL[S.lb]} window. Status: crowded = score ≥ 75; offside = legs lost money over 4 weeks; unwinding = score down 10+ in 4 weeks.`, tools: '<button class="btn" data-copy="th-table">Copy</button>', body: '<div class="tablewrap" id="th-table"></div>', bodyClass: '' })}
    ${panel('Score history', { note: 'Last 5 years. Shaded bands mark ≥ 75 and ≤ 25. Click a theme for its legs.', body: '<div class="mini-grid" id="th-minis"></div>' })}
    <div id="th-detail"></div>
    ${panel('Build a custom theme', { note: 'Saved in this browser only.', body: customBuilderHTML() })}`;
  onSeg('leg-mode', (v) => { S.legMode = v; save(); render(); });
  themeTable('th-table', $('#th-table'), list);
  const minis = $('#th-minis');
  minis.innerHTML = list.map((d) => miniHTML(d)).join('');
  minis.onclick = (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    S.theme = b.dataset.theme;
    save();
    $$('.mini', minis).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.theme === S.theme)));
    themeDetail(list.find((d) => d.th.key === S.theme));
  };
  bindMiniTips(minis, list);
  themeDetail(list.find((d) => d.th.key === S.theme));
  bindCustomBuilder();
};
function miniHTML(d) {
  const n = TS.length, from = Math.max(0, n - 260), vals = Array.from(d.comp.subarray(from));
  const w = 240, h = 54, x = (i) => (i / (vals.length - 1)) * (w - 8) + 2, y = (v) => h - 3 - (v / 100) * (h - 6);
  let path = '';
  vals.forEach((v, i) => { if (fin(v)) path += (path ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); else if (path && !path.endsWith('|')) path += ''; });
  const end = vals[vals.length - 1];
  const svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<rect x="0" y="${y(100)}" width="${w}" height="${y(75) - y(100)}" style="fill:var(--l1);opacity:.55"/>` +
    `<rect x="0" y="${y(25)}" width="${w}" height="${y(0) - y(25)}" style="fill:var(--s1);opacity:.55"/>` +
    `<line x1="0" x2="${w}" y1="${y(50)}" y2="${y(50)}" style="stroke:var(--line-2)" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `<path d="${path}" fill="none" style="stroke:var(--ink)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
    (fin(end) ? `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="3.2" style="fill:var(--accent);stroke:var(--surface)" stroke-width="1.5"/>` : '') + '</svg>';
  return `<button type="button" class="mini" data-theme="${esc(d.th.key)}" aria-pressed="${d.th.key === S.theme}"><div class="top"><span class="nm">${esc(d.th.name)}</span><span class="v">${fmtP(d.now)}</span></div>${svg}<div class="top"><span class="pill ${d.status.k}">${d.status.label}</span><span class="gp" style="color:var(--muted);font-size:11px">Δ4w ${fmtN(d.d4, 0, true)}</span></div></button>`;
}
function bindMiniTips(root, list) {
  const tip = $('#tip');
  root.onpointermove = (e) => {
    const b = e.target.closest('.mini');
    const svg = b && b.querySelector('svg');
    if (!svg) { tip.hidden = true; return; }
    const rect = svg.getBoundingClientRect();
    if (e.clientY < rect.top || e.clientY > rect.bottom) { tip.hidden = true; return; }
    const d = list.find((x) => x.th.key === b.dataset.theme);
    const n = TS.length, from = Math.max(0, n - 260), len = n - from;
    const i = Math.min(len - 1, Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * (len - 1))));
    const v = d.comp[from + i];
    tip.innerHTML = `<b>${fmtP(v)}</b> ${esc(d.th.name)}<br><span style="color:var(--muted)">${fmtDate(META.dates[from + i])}</span>`;
    tip.hidden = false;
    tip.style.left = Math.min(window.innerWidth - 200, e.clientX + 12) + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  };
  root.onpointerleave = () => { tip.hidden = true; };
}
function themeDetail(d) {
  const el = $('#th-detail');
  if (!d) { el.innerHTML = ''; return; }
  el.innerHTML = panel(`${esc(d.th.name)}`, {
    note: esc(d.th.desc || ''), tools: seg('th-range', RANGES, S.range),
    body: `<div class="chart short" id="th-chart"></div><div class="tablewrap" id="th-legs" style="margin-top:8px"></div><div class="chart" id="th-heat" style="margin-top:8px"></div>`,
  });
  onSeg('th-range', (v) => { S.range = +v; save(); themeDetail(d); });
  const col = chartColors();
  const zone = (a, b, c) => [{ yAxis: a, itemStyle: { color: c, opacity: 0.35 } }, { yAxis: b }];
  mkChart($('#th-chart'), {
    grid: { left: 8, right: 16, top: 12, bottom: 24, containLabel: true },
    xAxis: axisX(col), yAxis: axisY(col, { min: 0, max: 100, scale: false, interval: 25 }),
    tooltip: { trigger: 'axis', formatter: tipAxis((v) => fmtP(v)) }, dataZoom: zoomFor(S.range),
    series: [lineSeries('Theme score', lineData(d.comp), col.ink, { markArea: { silent: true, data: [zone(75, 100, col.l1), zone(0, 25, col.s1)] } })],
  });
  const legs = d.legs.map((l) => Object.assign({}, l, { key: l.leg.m }));
  const cols = [
    COL.mk,
    { k: 'side', h: 'Side', l: true, v: (r) => r.leg.s, f: (r) => (r.leg.s > 0 ? 'Long' : 'Short') },
    { k: 'grp', h: 'Group', l: true, v: (r) => (r.cl ? r.cl.join('+') : ''), f: (r) => (r.cl ? r.cl.map((c) => CAT_SHORT[c]).join(' + ') : '–') },
    { k: 'score', h: 'Score', t: 'Leg score in the theme direction', v: (r) => (r.score ? r.score[d.t] : NaN), f: (r) => fmtP(r.score ? r.score[d.t] : NaN), c: (r) => 'heat ' + heatClass(r.score ? r.score[d.t] : NaN) },
    Object.assign({}, COL['p' + S.lb], { g: null, h: `Pctl ${LB_LABEL[S.lb]}` }),
    Object.assign({}, COL.usd, { g: null }), Object.assign({}, COL.flow, { g: null }), Object.assign({}, COL.fz, { g: null }),
    Object.assign({}, COL.drv, { g: null }), Object.assign({}, COL.r4, { g: null, h: 'Px 4w' }),
  ];
  table('th-legs', $('#th-legs'), cols, legs, { sort: 'score', dir: -1, onRow: openMarket });
  const live = legs.filter((l) => !l.na && l.score);
  const n = TS.length, from = Math.max(0, n - 156);
  const xs = META.dates.slice(from);
  const ys = live.map((l) => `${l.leg.s > 0 ? 'Long' : 'Short'} ${l.m.name}`);
  const data = [];
  live.forEach((l, yi) => { for (let i = from; i < n; i++) { const v = l.score[i]; if (fin(v)) data.push([i - from, yi, Math.round(v)]); } });
  const heat = $('#th-heat');
  heat.style.height = Math.max(160, ys.length * 22 + 70) + 'px';
  mkChart(heat, {
    grid: { left: 8, right: 16, top: 8, bottom: 48, containLabel: true },
    xAxis: { type: 'category', data: xs, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: col.muted, fontSize: 10.5, interval: 25, formatter: (v) => fmtDate(v, { month: 'short', year: '2-digit' }) } },
    yAxis: { type: 'category', data: ys, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: col.ink2, fontSize: 11, width: 190, overflow: 'truncate' } },
    visualMap: { min: 0, max: 100, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 10, itemHeight: 120, text: ['100 crowded with theme', 'crowded against 0'], textStyle: { color: col.muted, fontSize: 10.5 }, inRange: { color: [col.s3, col.s2, col.s1, col.corrMid, col.l1, col.l2, col.l3] } },
    tooltip: { trigger: 'item', formatter: (p) => `<b>${p.value[2]}</b> ${esc(ys[p.value[1]])}<br><span style="color:${col.muted}">${fmtDate(xs[p.value[0]])}</span>` },
    series: [{ type: 'heatmap', data, progressive: 0, itemStyle: { borderColor: col.surface, borderWidth: 0.5 } }],
  });
}
function customBuilderHTML() {
  const opts = ['FX', 'Rates', 'Equities', 'Commodities', 'Crypto'].map((a) => `<optgroup label="${a}">${META.markets.filter((m) => m.asset === a).map((m) => `<option value="${m.key}">${esc(m.name)}</option>`).join('')}</optgroup>`).join('');
  const saved = customThemes.length ? customThemes.map((t) => `<div class="leg-chip"><span><b>${esc(t.name)}</b> · ${t.legs.map((l) => `${l.s > 0 ? '+' : MINUS}${esc(l.m)}`).join(' ')}</span><button type="button" data-del="${esc(t.key)}" aria-label="Delete ${esc(t.name)}">×</button></div>`).join('') : '<span class="na">No custom themes yet.</span>';
  return `<div class="legs-edit">
      <label class="ctl"><span>Name</span><input class="inp" id="cb-name" maxlength="40" placeholder="e.g. Short duration, long yen"></label>
      <label class="ctl"><span>Market</span><select id="cb-mkt">${opts}</select></label>
      <label class="ctl"><span>Side</span><select id="cb-side"><option value="1">Long</option><option value="-1">Short</option></select></label>
      <button type="button" class="btn" id="cb-add">Add leg</button>
      <button type="button" class="btn primary" id="cb-save">Save theme</button>
    </div>
    <div class="chips" id="cb-legs" style="margin-top:10px"></div>
    <div id="cb-msg" class="note" style="margin-top:6px;color:var(--ink-2)"></div>
    <h4 style="margin:14px 0 6px;font-size:13px">Saved</h4><div class="chips" id="cb-saved">${saved}</div>`;
}
function bindCustomBuilder() {
  const drawDraft = () => {
    $('#cb-legs').innerHTML = draftLegs.length ? draftLegs.map((l, i) => `<span class="leg-chip">${l.s > 0 ? 'Long' : 'Short'} ${esc(MK[l.m] ? MK[l.m].name : l.m)}<button type="button" data-rm="${i}" aria-label="Remove leg">×</button></span>`).join('') : '<span class="na">Add two or more legs.</span>';
  };
  drawDraft();
  $('#cb-add').onclick = () => {
    const m = $('#cb-mkt').value, s = +$('#cb-side').value;
    if (!draftLegs.some((l) => l.m === m)) draftLegs.push({ m, s });
    store.set('draft', draftLegs);
    drawDraft();
  };
  $('#cb-legs').onclick = (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    draftLegs.splice(+b.dataset.rm, 1);
    store.set('draft', draftLegs);
    drawDraft();
  };
  $('#cb-save').onclick = () => {
    const name = $('#cb-name').value.trim();
    if (!name || draftLegs.length < 2) { $('#cb-msg').textContent = 'Give the theme a name and at least two legs.'; return; }
    customThemes.push({ key: 'c' + Date.now().toString(36), name, desc: 'Custom theme', legs: draftLegs.slice() });
    store.set('custom', customThemes);
    draftLegs = [];
    store.set('draft', draftLegs);
    S.theme = customThemes[customThemes.length - 1].key;
    save();
    render();
  };
  $('#cb-saved').onclick = (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    customThemes = customThemes.filter((t) => t.key !== b.dataset.del);
    store.set('custom', customThemes);
    render();
  };
}

/* ======================================================================= washout map */
RENDER.washout = (sec) => {
  const w = washout();
  sec.innerHTML = `
    <div class="sheet-head"><h2>Washout map</h2><p>Which crowded positions have historically moved together. Each market is oriented to the side the crowd is on today (long if its percentile is above 50, short below), so a positive correlation means the two crowded positions build and unwind together, or make and lose money together.</p></div>
    <div class="chips">
      ${seg('w-src', [['returns', 'Position P&L'], ['flows', 'Positioning flows']], S.corrSrc)}
      ${seg('w-or', [['1', 'Oriented to the crowd'], ['0', 'Raw']], S.corrOrient ? '1' : '0')}
      ${seg('w-lb', [[52, '1Y'], [156, '3Y'], [260, '5Y']], S.corrLb)}
      ${seg('w-cr', [['0', 'All markets'], ['1', 'Crowded only (≤25 or ≥75)']], S.corrCrowded ? '1' : '0')}
    </div>
    ${panel('Clusters most exposed to a joint washout', { note: 'Average-linkage clusters with average correlation ≥ 0.35, ranked by crowding × correlation × √size.', body: '<div class="tablewrap" id="w-clusters"></div>', bodyClass: '' })}
    ${panel('Correlation matrix', { note: `${S.corrSrc === 'flows' ? 'Weekly changes in net % OI' : 'Weekly futures returns'} over ${LB_LABEL[S.corrLb]}, ${S.corrOrient ? 'oriented to today\'s crowded side' : 'unoriented'}, ordered by cluster. ${esc(ROLES[S.role].short)}.`, body: '<div class="tablewrap"><div class="chart" id="w-heat"></div></div>' })}
    ${panel('Most correlated crowded pairs', { note: 'Both legs at or beyond the 25th/75th percentile', body: '<div class="tablewrap" id="w-pairs"></div>', bodyClass: '' })}`;
  onSeg('w-src', (v) => { S.corrSrc = v; save(); render(); });
  onSeg('w-or', (v) => { S.corrOrient = v === '1'; save(); render(); });
  onSeg('w-lb', (v) => { S.corrLb = +v; save(); render(); });
  onSeg('w-cr', (v) => { S.corrCrowded = v === '1'; save(); render(); });
  const side = (x) => `${x.sign > 0 ? 'Long' : 'Short'} ${x.r.m.key} <span style="color:var(--muted)">${fmtP(x.r.p)}</span>`;
  const crows = w.clusters.map((c, i) => ({ key: '', c, i }));
  table('w-clusters', $('#w-clusters'), [
    { k: 'mk', h: '#', v: (r) => r.i, f: (r) => String(r.i + 1) },
    { k: 'mem', h: 'Members (crowded side, percentile)', l: true, v: (r) => r.c.items.length, f: (r) => `<span style="white-space:normal;display:inline-block;max-width:70ch">${r.c.items.map((a) => side(w.vecs[a])).join(' · ')}</span>` },
    { k: 'n', h: 'Size', v: (r) => r.c.items.length, f: (r) => String(r.c.items.length) },
    { k: 'avgC', h: 'Avg corr', v: (r) => r.c.avgC, f: (r) => fmtN(r.c.avgC, 2) },
    { k: 'crowd', h: 'Crowding', t: 'Average distance from the 50th percentile, scaled 0-100', v: (r) => r.c.avgCrowd, f: (r) => fmtP(r.c.avgCrowd) },
    { k: 'gross', h: 'Gross $', t: 'Sum of absolute USD notional', v: (r) => r.c.gross, f: (r) => fmtUSD(r.c.gross) },
    { k: 'score', h: 'Score', v: (r) => r.c.score, f: (r) => fmtN(r.c.score, 0) },
  ], crows, { sort: 'score', dir: -1 });
  if (!w.clusters.length) $('#w-clusters').innerHTML = '<div class="panel-body na">No cluster reaches an average correlation of 0.35 with these settings.</div>';
  const col = chartColors();
  const ord = w.order, labels = ord.map((i) => (w.vecs[i].sign > 0 ? '+' : MINUS) + w.vecs[i].r.m.key);
  const data = [];
  ord.forEach((a, x) => ord.forEach((b, y) => { const c = w.C[a][b]; if (fin(c)) data.push([x, y, +c.toFixed(2)]); }));
  const el = $('#w-heat');
  const size = Math.max(360, Math.min(1100, labels.length * 15 + 110));
  el.style.height = size + 'px';
  el.style.minWidth = size + 'px';
  mkChart(el, {
    grid: { left: 8, right: 70, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: labels, position: 'top', axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: col.ink2, fontSize: 10, rotate: 90, interval: 0 } },
    yAxis: { type: 'category', data: labels, inverse: true, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: col.ink2, fontSize: 10, interval: 0 } },
    visualMap: { min: -1, max: 1, calculable: false, orient: 'vertical', right: 0, top: 'middle', itemWidth: 10, itemHeight: 160, text: ['+1', '−1'], textStyle: { color: col.muted, fontSize: 10.5 }, inRange: { color: [col.corrNeg, col.corrMid, col.corrPos] } },
    tooltip: { trigger: 'item', formatter: (p) => { const a = w.vecs[ord[p.value[0]]], b = w.vecs[ord[p.value[1]]]; return `<b>${fmtN(p.value[2], 2)}</b> correlation<br>${side(a)}<br>${side(b)}`; } },
    series: [{ type: 'heatmap', data, progressive: 0, itemStyle: { borderColor: col.surface, borderWidth: 0.5 } }],
  });
  const pairs = [];
  for (let i = 0; i < w.vecs.length; i++) {
    for (let j = i + 1; j < w.vecs.length; j++) {
      const a = w.vecs[i], b = w.vecs[j];
      if (Math.abs(a.r.p - 50) >= 25 && Math.abs(b.r.p - 50) >= 25 && fin(w.C[i][j])) pairs.push({ key: '', a, b, c: w.C[i][j] });
    }
  }
  pairs.sort((x, y) => y.c - x.c);
  table('w-pairs', $('#w-pairs'), [
    { k: 'mk', h: 'Pair', l: true, v: (r) => r.c, f: (r) => `${side(r.a)} &nbsp;+&nbsp; ${side(r.b)}` },
    { k: 'c', h: 'Corr', v: (r) => r.c, f: (r) => fmtN(r.c, 2) },
    { k: 'usd', h: 'Gross $', v: (r) => Math.abs(r.a.r.usd || 0) + Math.abs(r.b.r.usd || 0), f: (r) => fmtUSD(Math.abs(r.a.r.usd || 0) + Math.abs(r.b.r.usd || 0)) },
  ], pairs.slice(0, 15), { sort: 'c', dir: -1 });
};

/* ======================================================================= charts (market detail) */
RENDER.charts = (sec) => {
  if (!MK[S.market]) S.market = 'EUR';
  const m = MK[S.market];
  const opts = ['FX', 'Rates', 'Equities', 'Commodities', 'Crypto'].map((a) => `<optgroup label="${a}">${META.markets.filter((x) => x.asset === a).map((x) => `<option value="${x.key}"${x.key === m.key ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
  const r = metrics(m.key);
  const roleShort = ROLES[S.role].short;
  sec.innerHTML = `
    <div class="sheet-head"><h2>${esc(m.name)}</h2><p><span class="mono">${esc(m.code)}</span> · ${esc(m.unit)} · ${m.report === 'tff' ? 'Traders in Financial Futures' : 'Disaggregated'} report${m.note ? ' · ' + esc(m.note) : ''}</p></div>
    <div class="chips" style="align-items:end">
      <label class="ctl"><span>Market</span><select id="ch-mkt">${opts}</select></label>
      ${seg('ch-range', RANGES, S.range)}
      ${seg('ch-units', [['contracts', 'Contracts'], ['usd', 'USD'], ['pct', '% of OI']], S.units)}
      ${seg('ch-leg', [['0', 'Report groups'], ['1', '+ legacy']], S.legacy ? '1' : '0')}
    </div>
    ${panel(`${esc(roleShort)} · latest`, { body: statsHTML(m, r) })}
    <div class="grid2">
      ${panel('Net position by trader group', { note: { contracts: 'contracts', usd: 'USD notional', pct: '% of open interest' }[S.units], body: '<div class="chart" id="ch-net"></div>' })}
      ${panel('Futures price', { note: pxUnit(m) || (m.price_source ? esc(m.price_source.ticker) : ''), body: '<div class="chart" id="ch-px"></div>' })}
      ${panel(`${esc(roleShort)}: net % of OI`, { note: `with the ${LB_LABEL[S.lb]} 10th–90th percentile band`, body: '<div class="chart" id="ch-band"></div>' })}
      ${panel(`${esc(roleShort)}: percentile`, { note: `${LB_LABEL[S.lb]} window, shaded ≥ 80 and ≤ 20`, body: '<div class="chart" id="ch-rank"></div>' })}
      ${panel(`${esc(roleShort)}: gross longs and shorts`, { note: 'contracts', body: '<div class="chart" id="ch-gross"></div>' })}
      ${panel(`${esc(roleShort)}: number of traders`, { note: 'reportable traders long and short', body: '<div class="chart" id="ch-traders"></div>' })}
      ${panel('Open interest', { note: 'contracts', body: '<div class="chart" id="ch-oi"></div>' })}
      ${panel('Concentration', { note: 'share of OI held by the 4 and 8 largest traders, gross', body: '<div class="chart" id="ch-conc"></div>' })}
    </div>`;
  $('#ch-mkt').onchange = (e) => { S.market = e.target.value; save(); render(); };
  onSeg('ch-range', (v) => { S.range = +v; save(); render(); });
  onSeg('ch-units', (v) => { S.units = v; save(); render(); });
  onSeg('ch-leg', (v) => { S.legacy = v === '1'; save(); render(); });
  drawMarketCharts(m);
};
function statsHTML(m, r) {
  if (r.na) return `<div class="na">${esc(r.na)}</div>`;
  const st = (k, v, s = '') => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const pcts = LBS.map((w) => `<span class="${heatClass(r.P[w])}" style="padding:0 4px;border-radius:3px">${LB_LABEL[w]} ${fmtP(r.P[w])}</span>`).join(' ');
  return `<div class="stats">
    ${st('Net', fmtK(r.net), `Δ1w ${fmtK(r.d1, true)} · Δ4w ${fmtK(r.d4, true)}`)}
    ${st('Net $', fmtUSD(r.usd), `flow 1w ${fmtUSD(r.flow, true)}`)}
    ${m.dv01 ? st('DV01', fmtUSD(r.dv01) + '/bp', `${fmtK(r.eq10)} 10Y equivalents`) : ''}
    ${st('% of OI', fmtN(r.pct, 1, true), `Δ1w ${fmtN(r.dp1, 1, true)} pp`)}
    ${st('Z 3Y · flow z', `${fmtN(r.z, 1, true)} · ${fmtN(r.fz, 1, true)}`, r.driver ? r.driver.label : '')}
    ${st('Longs / shorts', `${fmtK(r.L)} / ${fmtK(r.S)}`, `traders ${fin(r.tL) ? r.tL + ' / ' + r.tS : '–'}`)}
    ${st('Open interest', fmtK(r.oi), `Δ1w ${fmtChg(r.doi)}`)}
    ${st('Price', dispPx(m, r.px), `4w ${fmtChg(r.r4)} · since Tue ${fmtChg(r.rsr)}`)}
    ${st('Top-4 long / short', fin(r.conc.g4L) ? `${r.conc.g4L.toFixed(0)}% / ${r.conc.g4S.toFixed(0)}%` : '–', fin(r.conc.g8L) ? `top-8 ${r.conc.g8L.toFixed(0)}% / ${r.conc.g8S.toFixed(0)}%` : '')}
  </div><div class="key" style="margin-top:10px">Percentiles: ${pcts}${r.stale ? ` · <b>last report ${fmtDate(r.date)}</b>` : ''}</div>`;
}
async function drawMarketCharts(m) {
  const col = chartColors(), key = m.key, rec = DATA[S.kind][key];
  if (!rec) return;
  const group = 'mkt';
  const o = firstIdx(rec.oi);
  const z = zoomFor(S.range, o);
  const base = (yFmt, extra = {}) => Object.assign({
    grid: { left: 8, right: 16, top: 34, bottom: 24, containLabel: true }, xAxis: axisX(col),
    yAxis: axisY(col, { axisLabel: { color: col.muted, fontSize: 11, formatter: yFmt } }), dataZoom: z,
  }, extra);
  const npc = NPC[key];
  const unitF = S.units === 'usd' ? (v) => fmtUSD(v) : S.units === 'pct' ? (v) => fmtN(v, 1, true) : (v) => fmtK(v);
  const conv = (cat) => {
    const s = ser(key, S.kind, [cat]);
    if (S.units === 'pct') return s.pct;
    if (S.units === 'usd') return s.net.map((v, i) => v * (npc ? npc[i] : NaN));
    return s.net;
  };
  const cats = REPORT_CATS[m.report].concat(S.legacy ? ['nc', 'cm'] : []).filter((c) => rec.L[c]);
  mkChart($('#ch-net'), base(unitF, {
    legend: legendCfg(col), tooltip: { trigger: 'axis', formatter: tipAxis(unitF) },
    series: cats.map((c) => lineSeries(CAT_LABEL[c], lineData(conv(c), (v) => v, o), col.slot(CAT_SLOT[c]))),
  }), group);
  const cp = CP[key];
  if (cp) {
    const pf = (v) => dispPx(m, m.disp === 'inv' ? 1 / v : m.disp === 'cents' ? v / 100 : v);
    mkChart($('#ch-px'), base(pf, {
      grid: { left: 8, right: 16, top: 14, bottom: 24, containLabel: true }, tooltip: { trigger: 'axis', formatter: tipAxis(pf) },
      series: [lineSeries('Price', lineData(cp, (v) => dispVal(m, v), o), col.ink2)],
    }), group);
  } else {
    $('#ch-px').innerHTML = '<div class="na" style="padding:20px 0">No price source for this contract.</div>';
  }
  const cl = catsFor(m);
  if (!cl) {
    for (const id of ['ch-band', 'ch-rank', 'ch-gross', 'ch-traders']) $('#' + id).innerHTML = `<div class="na" style="padding:20px 0">${esc(naReason(m))}.</div>`;
  } else {
    const s = ser(key, S.kind, cl), n = TS.length, win = S.lb;
    const lo = new Float64Array(n).fill(NaN), hi = new Float64Array(n).fill(NaN), med = new Float64Array(n).fill(NaN);
    for (let t = o; t < n; t++) {
      const from = win ? Math.max(0, t - win + 1) : 0, vals = [];
      for (let i = from; i <= t; i++) if (s.pct[i] === s.pct[i]) vals.push(s.pct[i]);
      if (vals.length < minObs(win)) continue;
      vals.sort((a, b) => a - b);
      const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
      lo[t] = q(0.1); hi[t] = q(0.9); med[t] = q(0.5);
    }
    const pctF = (v) => fmtN(v, 1, true);
    mkChart($('#ch-band'), base(pctF, {
      legend: Object.assign(legendCfg(col), { data: ['Median', 'Net % OI'] }),
      tooltip: { trigger: 'axis', formatter: (ps) => tipAxis(pctF)(ps) + (fin(lo[ps[0].dataIndex + o]) ? `<div style="color:${col.muted};margin-top:2px">10th–90th: ${pctF(lo[ps[0].dataIndex + o])} to ${pctF(hi[ps[0].dataIndex + o])}</div>` : '') },
      series: [
        lineSeries('_lo', lineData(lo, (v) => v, o), 'transparent', { stack: 'band', stackStrategy: 'all', lineStyle: { width: 0 } }),
        lineSeries('_band', lineData(hi.map((v, i) => v - lo[i]), (v) => v, o), 'transparent', { stack: 'band', stackStrategy: 'all', lineStyle: { width: 0 }, areaStyle: { color: col.accent, opacity: 0.14 } }),
        lineSeries('Median', lineData(med, (v) => v, o), col.muted, { lineStyle: { width: 1, color: col.muted } }),
        lineSeries('Net % OI', lineData(s.pct, (v) => v, o), col.slot(CAT_SLOT[cl[0]])),
      ],
    }), group);
    const rr = rollRank(key, S.kind, cl, S.lb);
    const zone = (a, b, c) => [{ yAxis: a, itemStyle: { color: c, opacity: 0.35 } }, { yAxis: b }];
    mkChart($('#ch-rank'), base((v) => v, {
      grid: { left: 8, right: 16, top: 14, bottom: 24, containLabel: true },
      yAxis: axisY(col, { min: 0, max: 100, scale: false, interval: 20 }), tooltip: { trigger: 'axis', formatter: tipAxis(fmtP) },
      series: [lineSeries('Percentile', lineData(rr, (v) => v, o), col.slot(CAT_SLOT[cl[0]]), { markArea: { silent: true, data: [zone(80, 100, col.l1), zone(0, 20, col.s1)] } })],
    }), group);
    mkChart($('#ch-gross'), base((v) => fmtK(v), {
      legend: legendCfg(col), tooltip: { trigger: 'axis', formatter: tipAxis((v) => fmtK(v)) },
      series: [lineSeries('Longs', lineData(s.L, (v) => v, o), col.pos), lineSeries('Shorts', lineData(s.S, (v) => v, o), col.neg)],
    }), group);
  }
  mkChart($('#ch-oi'), base((v) => fmtK(v), {
    grid: { left: 8, right: 16, top: 14, bottom: 24, containLabel: true }, tooltip: { trigger: 'axis', formatter: tipAxis((v) => fmtK(v)) },
    series: [lineSeries('Open interest', lineData(rec.oi, (v) => v, o), col.ink2, { areaStyle: { color: col.ink2, opacity: 0.08 } })],
  }), group);
  const det = await ensureDetail(key);
  if (S.tab !== 'charts' || S.market !== key) return;
  const dk = det[S.kind];
  const n = TS.length;
  if (dk && cl) {
    const tl = new Float64Array(n).fill(NaN), ts = new Float64Array(n).fill(NaN);
    let ok = cl.every((c) => dk.T && dk.T[c]);
    if (ok) {
      for (const c of cl) {
        const a = full(dk.o, dk.T[c][0], n), b = full(dk.o, dk.T[c][1], n);
        for (let i = 0; i < n; i++) { tl[i] = (tl[i] === tl[i] ? tl[i] : 0) + a[i]; ts[i] = (ts[i] === ts[i] ? ts[i] : 0) + b[i]; }
      }
      mkChart($('#ch-traders'), base((v) => String(v), {
        legend: legendCfg(col), tooltip: { trigger: 'axis', formatter: tipAxis((v) => String(Math.round(v))) },
        series: [lineSeries('Traders long', lineData(tl, (v) => v, o), col.pos), lineSeries('Traders short', lineData(ts, (v) => v, o), col.neg)],
      }), group);
    } else {
      $('#ch-traders').innerHTML = '<div class="na" style="padding:20px 0">Trader counts are not published for this group.</div>';
    }
  } else if (!cl) {
    /* message already shown */
  } else {
    $('#ch-traders').innerHTML = '<div class="na" style="padding:20px 0">No trader-count history.</div>';
  }
  if (dk && dk.C && dk.C.g4L) {
    const c4l = full(dk.o, dk.C.g4L, n), c4s = full(dk.o, dk.C.g4S, n);
    const thin = { lineStyle: { width: 1.5, opacity: 0.55 } };
    const ser8 = dk.C.g8L ? [lineSeries('Top 8 long', lineData(full(dk.o, dk.C.g8L, n), (v) => v, o), col.pos, thin), lineSeries('Top 8 short', lineData(full(dk.o, dk.C.g8S, n), (v) => v, o), col.neg, thin)] : [];
    mkChart($('#ch-conc'), base((v) => v + '%', {
      legend: legendCfg(col), tooltip: { trigger: 'axis', formatter: tipAxis((v) => fmtN(v, 1) + '%') },
      series: [lineSeries('Top 4 long', lineData(c4l, (v) => v, o), col.pos), lineSeries('Top 4 short', lineData(c4s, (v) => v, o), col.neg)].concat(ser8),
    }), group);
  } else {
    $('#ch-conc').innerHTML = '<div class="na" style="padding:20px 0">No concentration history.</div>';
  }
  if (window.echarts) echarts.connect(group);
}

/* ======================================================================= notes */
RENDER.notes = (sec) => {
  const ds = META.datasets || {};
  const dsRows = Object.entries(ds).map(([k, v]) => `<tr><td class="l">${esc(k.replace('_', ' · '))}</td><td class="l mono">${esc(v.dataset)}</td><td>${esc(v.latest)}</td><td class="l">${v.missing_codes && v.missing_codes.length ? esc(v.missing_codes.join(', ')) : 'none'}</td></tr>`).join('');
  const pxRows = META.markets.map((m) => `<tr><td class="l">${esc(m.name)}</td><td class="l mono">${esc(m.code)}</td><td class="l">${esc(m.unit)}</td><td class="l">${m.price_source ? esc(m.price_source.source + ' ' + m.price_source.ticker) : '<span class="na">none</span>'}</td><td>${m.px_last ? esc(m.px_last[0]) : '–'}</td><td>${m.last_report ? esc(m.last_report) : '–'}</td><td class="l">${esc(m.note || '')}</td></tr>`).join('');
  sec.innerHTML = `
    <div class="sheet-head"><h2>Notes</h2><p>How every number on this page is built, and where it can mislead.</p></div>
    <div class="grid2">
      <div class="panel"><div class="panel-body prose">
        <h4>Source and timing</h4>
        <p>CFTC Commitments of Traders, pulled from the CFTC Public Reporting API (Socrata). Positions are as of Tuesday's close and published the following Friday at 15:30 ET (Saturday morning in Singapore); US holidays push publication back a day or so. A GitHub Action refreshes the data every Friday evening ET, with retries on Saturday and Monday.</p>
        <p><b>Futures only</b> counts futures contracts. <b>Futures + options</b> adds options converted to futures-equivalents using each option's delta, which matters for STIR, Treasuries, FX majors, gold and crude where options open interest is large.</p>
        <h4>Trader groups</h4>
        <ul>
          <li><b>TFF report</b> (FX, rates, equity indices, VIX, crypto): dealers/intermediaries, asset managers/institutional, leveraged funds (hedge funds and CTAs), other reportables, non-reportables.</li>
          <li><b>Disaggregated report</b> (commodities): producers/merchants, swap dealers, managed money, other reportables, non-reportables.</li>
          <li><b>Legacy report</b> (all markets): non-commercials and commercials, the long-standing "IMM speculators" series most street notes quote.</li>
          <li>"Leveraged funds · managed money" picks the fast-money group in each report. Non-reportables are identical across the three reports.</li>
        </ul>
        <h4>Measures</h4>
        <ul>
          <li><b>Net</b> = longs minus shorts (spread positions cancel). <b>% OI</b> = net divided by total open interest, which removes growth in the market over time.</li>
          <li><b>Percentile</b>: mid-rank of this week's net % OI among all weekly readings in the trailing window, this week included. Needs at least 60% of the window (26 weeks minimum, 52 for full history), otherwise blank.</li>
          <li><b>Z 3Y</b>: (net % OI − 3-year mean) / 3-year standard deviation. <b>Flow z</b>: this week's change in net % OI divided by the 3-year standard deviation of weekly changes; above 2 is a big week.</li>
          <li><b>Net $</b>: net contracts × contract size × futures price on the report date. Rates are shown as 10Y-note-equivalent notional (DV01-weighted), so SOFR and 2Y contracts are comparable with the long end, equities and FX. <b>Flow</b>: change in net contracts × the same price, so price moves do not show up as flows.</li>
          <li><b>DV01</b> uses approximate contract DV01s (2Y $39, 5Y $46, 10Y $64, Ultra 10Y $91, Bond $128, Ultra $205, SOFR 3M $25, SOFR 1M and fed funds $41.67 per bp). <b>10Y eq.</b> scales by the 10Y DV01.</li>
          <li><b>Driver</b>: whichever of gross longs or shorts moved more this week (new longs, long liquidation, new shorts, short covering).</li>
          <li><b>Since Tue</b>: futures price change from the report date to the latest close. The report is three days old when it comes out; this shows whether the crowd has been paid or hurt since.</li>
        </ul>
        <h4>Themes</h4>
        <p>Each leg scores its percentile when long is the theme's direction and 100 minus it when short. The theme score averages the legs that have data (at least half are required). Treasury legs default to asset managers, because leveraged-fund Treasury positions mostly reflect the basis trade; switch to "Use the trader-group selector for every leg" to override. Status rules: crowded ≥ 75; offside if the legs' average 4-week price move in the theme direction is negative; unwinding if the score fell 10+ points in 4 weeks; washed out ≤ 25.</p>
        <h4>Washout map</h4>
        <p>For each market, the weekly change in net % OI (or the weekly futures return) over the chosen window, multiplied by +1 if the crowd is long today and −1 if short. Positive correlation then means two crowded positions have historically been built and cut, or paid and hurt, in the same weeks. Markets are clustered with average linkage on 1 − correlation.</p>
      </div></div>
      <div class="panel"><div class="panel-body prose">
        <h4>Where this can mislead</h4>
        <ul>
          <li><b>Treasury futures</b>: leveraged-fund shorts are mostly the cash-futures basis trade (long cash bonds, short futures, repo-financed) and asset-manager longs its mirror. Record levels say more about basis-trade size and funding-stress risk than about duration views.</li>
          <li><b>Equity index futures</b>: asset-manager longs and leveraged-fund shorts are partly financing and relative-value trades (including total-return futures, not shown).</li>
          <li><b>FX</b>: CME futures are a small slice of FX turnover. Direction and extremes are informative; levels are not the whole market. Only JPY, AUD and NZD cover Asia; CNH, KRW, TWD, INR and SGD are not in the CFTC data.</li>
          <li><b>Coverage</b>: ICE Brent, gasoil and European contracts report to their own regulators and are not in this data. Brent here is the NYMEX financial contract.</li>
          <li><b>Prices</b> are continuous front-month futures from Yahoo Finance, so roll gaps can distort single-week returns. MSCI EM/EAFE use ETF-scaled proxies, VIX notional uses spot VIX, SOFR price moves use 100 minus the 13-week bill yield.</li>
          <li><b>Revisions</b>: the CFTC occasionally revises recent weeks; each refresh re-pulls the last five weeks.</li>
        </ul>
        <h4>Data status</h4>
        <dl class="kv">
          <dt>Latest positions</dt><dd>${esc(META.latest)}</dd>
          <dt>Built</dt><dd>${esc(META.generated)}</dd>
          <dt>Stale contracts</dt><dd>${META.stale_markets.length ? esc(META.stale_markets.join(', ')) : 'none'}</dd>
          <dt>Missing prices</dt><dd>${META.missing_prices.length ? esc(META.missing_prices.join(', ')) : 'none'}</dd>
        </dl>
        <div class="tablewrap" style="margin-top:10px"><table class="t"><thead><tr><th class="l">Report</th><th class="l">Dataset</th><th>Latest</th><th class="l">Missing codes</th></tr></thead><tbody>${dsRows}</tbody></table></div>
      </div></div>
    </div>
    ${panel('Contracts and price sources', { body: `<div class="tablewrap"><table class="t"><thead><tr><th class="l">Market</th><th class="l">CFTC code</th><th class="l">Contract</th><th class="l">Price source</th><th>Last price</th><th>Last report</th><th class="l">Note</th></tr></thead><tbody>${pxRows}</tbody></table></div>`, bodyClass: '' })}`;
};

/* ======================================================================= boot */
async function boot() {
  try {
    META = await getJSON('data/meta.json');
    TS = META.dates.map((d) => Date.parse(d + 'T00:00:00Z'));
    const n = TS.length;
    for (const m of META.markets) MK[m.key] = m;
    for (const [k, v] of Object.entries(META.cp)) CP[k] = full(v.o, v.v, n);
    for (const [k, v] of Object.entries(META.npc)) NPC[k] = full(v.o, v.v, n);
    await ensureKind(S.kind);
  } catch (e) {
    console.error(e);
    $('#main').innerHTML = `<div class="banner">The data files did not load (${esc(e.message)}). Open this page from its published address, or serve the site folder over HTTP rather than as a local file.</div>`;
    return;
  }
  initControls();
  renderAsOf();
  if (!window.echarts) console.warn('ECharts did not load; tables still work.');
  route();
}
boot();

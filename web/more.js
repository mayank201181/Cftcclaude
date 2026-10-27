'use strict';
/* CFTC Positioning Monitor, part 2: conclusions, nowcast and CTA trend model,
   options layer, Europe & Asia sources, backtest. Loaded after app.js and
   shares its globals; boot runs once both scripts have executed. */

TABS.unshift(['conclusions', 'Conclusions']);
TABS.splice(TABS.findIndex(([k]) => k === 'charts'), 0,
  ['nowcast', 'Nowcast & CTA'], ['options', 'Options'], ['sources', 'Europe & Asia'], ['backtest', 'Backtest']);

/* micro contracts, second venues and stale contracts stay out of averages */
const AGG_SKIP = new Set(['MBT', 'MET', 'WTIICE', 'NGICE', 'NKY', 'DUBAI', 'BRENT']);
const CTA_LB = [20, 60, 125, 250];
const CTA_LB_LABEL = ['1M', '3M', '6M', '12M'];
const SEV_ORDER = { critical: 0, serious: 1, warning: 2, info: 3 };
const SEV_LABEL = { critical: 'Alert', serious: 'Watch closely', warning: 'Watch', info: 'Note' };
function ord(x) {
  if (!fin(x)) return '–';
  const k = Math.round(x), t = k % 100;
  return k + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th'));
}

let DAILY = null, FXO = null, FLOWS = null, CONCL = null;

/* ======================================================================= loading */
async function ensureDaily() {
  if (DAILY) return DAILY;
  try {
    const raw = await getJSON('data/daily.json');
    const n = raw.dates.length, px = {};
    for (const [k, v] of Object.entries(raw.px)) px[k] = full(v.o, v.v, n);
    DAILY = { dates: raw.dates, ts: raw.dates.map((d) => Date.parse(d + 'T00:00:00Z')), px };
  } catch (e) {
    DAILY = { dates: [], ts: [], px: {}, error: e.message };
  }
  return DAILY;
}
async function optionalJSON(name) {
  try { return await getJSON('data/' + name); } catch (e) { return null; }
}
async function ensureExtras() {
  if (FXO === null) FXO = (await optionalJSON('fxopts.json')) || {};
  if (FLOWS === null) FLOWS = (await optionalJSON('flows.json')) || {};
  if (CONCL === null) CONCL = (await optionalJSON('conclusions.json')) || {};
}
async function ensureAll() {
  await Promise.all([ensureDaily(), ensureKind('fut'), ensureKind('combo'), ensureExtras()]);
}
function stillOn(tab, sec) { return S.tab === tab && sec.isConnected; }

/* ======================================================================= CTA trend model */
/* Time-series momentum over 1, 3, 6 and 12 months. Each lookback's signal is
   tanh(log return / (daily vol x sqrt(lookback))); the position is their
   average, from -100% (max short) to +100% (max long). */
function ctaModel(key) {
  const ck = 'cta|' + key;
  if (cache.has(ck)) return cache.get(ck);
  const p = DAILY.px[key];
  if (!p) return null;
  const n = p.length, lp = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN);
  let last = NaN;
  for (let i = 0; i < n; i++) { if (p[i] > 0) last = Math.log(p[i]); lp[i] = last; }
  let v2 = NaN;
  const seed = [];
  for (let i = 1; i < n; i++) {
    const r = lp[i] - lp[i - 1];
    if (r === r && p[i] > 0) {
      if (v2 !== v2) {
        seed.push(r * r);
        if (seed.length >= 20) v2 = seed.reduce((a, b) => a + b, 0) / seed.length;
      } else v2 = 0.94 * v2 + 0.06 * r * r;
    }
    vol[i] = Math.sqrt(v2);
  }
  const sig = CTA_LB.map((L) => {
    const s = new Float64Array(n).fill(NaN);
    for (let i = L; i < n; i++) {
      const d = lp[i] - lp[i - L], sd = vol[i] * Math.sqrt(L);
      if (d === d && sd > 0) s[i] = Math.tanh(d / sd);
    }
    return s;
  });
  const pos = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let s = 0, ok = true;
    for (const a of sig) { if (a[i] !== a[i]) { ok = false; break; } s += a[i]; }
    if (ok) pos[i] = s / sig.length;
  }
  const res = { lp, vol, sig, pos };
  cache.set(ck, res);
  return res;
}
/* position on day t+h at price x (look-back references are all known when L > h) */
function ctaPosAt(m, t, h, x) {
  const lx = Math.log(x);
  let s = 0;
  for (const L of CTA_LB) s += Math.tanh((lx - m.lp[t + h - L]) / (m.vol[t] * Math.sqrt(L)));
  return s / CTA_LB.length;
}
function ctaRoot(m, t, h, target = 0) {
  const refs = CTA_LB.map((L) => m.lp[t + h - L]);
  if (!refs.every(fin) || !(m.vol[t] > 0)) return NaN;
  let lo = Math.min(...refs) - 2, hi = Math.max(...refs) + 2;
  for (let k = 0; k < 70; k++) {
    const mid = (lo + hi) / 2;
    if (ctaPosAt(m, t, h, Math.exp(mid)) > target) hi = mid; else lo = mid;
  }
  return Math.exp((lo + hi) / 2);
}
function ctaNow(key) {
  const ck = 'ctanow|' + key;
  if (cache.has(ck)) return cache.get(ck);
  const m = ctaModel(key);
  let res = null;
  if (m) {
    const t = lastIdx(m.pos);
    if (t > 260) {
      const P = Math.exp(m.lp[t]), wk = m.vol[t] * Math.sqrt(5);
      const flip = ctaRoot(m, t, 1);
      res = {
        key, t, date: DAILY.dates[t], P, pos: m.pos[t], d5: m.pos[t] - m.pos[t - 5], d20: m.pos[t] - m.pos[t - 20],
        sig: m.sig.map((a) => a[t]), flips: CTA_LB.map((L) => Math.exp(m.lp[t + 1 - L])), flip,
        distPct: flip / P - 1, distSd: Math.log(flip / P) / wk, wk,
        scen: [-2, -1, 0, 1, 2].map((k) => ctaPosAt(m, t, 5, P * Math.exp(k * wk)) - m.pos[t]),
      };
    }
  }
  cache.set(ck, res);
  return res;
}
function ctaAvg(keys, sign = 1) {
  const v = keys.map((k) => ctaNow(k)).filter((c) => c && fin(c.pos));
  if (!v.length) return null;
  return { pos: sign * v.reduce((s, c) => s + c.pos, 0) / v.length, d5: sign * v.reduce((s, c) => s + c.d5, 0) / v.length, n: v.length };
}

/* ======================================================================= nowcast */
function reportToDaily() {
  const ck = 'rep2daily';
  if (cache.has(ck)) return cache.get(ck);
  const out = new Int32Array(META.dates.length).fill(-1);
  let j = 0;
  for (let i = 0; i < META.dates.length; i++) {
    const d = META.dates[i];
    if (!DAILY.dates.length || d < DAILY.dates[0]) continue;
    while (j + 1 < DAILY.dates.length && DAILY.dates[j + 1] <= d) j++;
    out[i] = j;
  }
  cache.set(ck, out);
  return out;
}
/* weekly change in net % OI regressed (no intercept) on the week's log return and
   the change in the CTA model position, over the last 156 reports; the fit is
   then applied to the moves since the last report date. */
function nowcastFor(key, cl) {
  const ck = `nc|${S.kind}|${key}|${cl.join('+')}|${S.lb}`;
  if (cache.has(ck)) return cache.get(ck);
  let res = null;
  const m = ctaModel(key), rec = DATA[S.kind][key];
  if (m && rec) {
    const s = ser(key, S.kind, cl), T = lastIdx(rec.oi), di = reportToDaily();
    let srr = 0, src = 0, scc = 0, sry = 0, scy = 0, syy = 0, sy = 0, n = 0;
    for (let t = Math.max(1, T - 155); t <= T; t++) {
      const a = di[t], b = di[t - 1];
      if (a < 0 || b < 0) continue;
      const y = s.dp[t], r = m.lp[a] - m.lp[b], c = m.pos[a] - m.pos[b];
      if (!fin(y) || !fin(r) || !fin(c)) continue;
      srr += r * r; src += r * c; scc += c * c; sry += r * y; scy += c * y; syy += y * y; sy += y; n++;
    }
    const det = srr * scc - src * src;
    if (n >= 52 && Math.abs(det) > 1e-12 && T === TS.length - 1) {
      const b1 = (sry * scc - scy * src) / det, b2 = (scy * srr - sry * src) / det;
      const sse = Math.max(0, syy - 2 * (b1 * sry + b2 * scy) + b1 * b1 * srr + 2 * b1 * b2 * src + b2 * b2 * scc);
      const sst = syy - (sy * sy) / n;
      const a = di[T], d = lastIdx(m.lp);
      const rNow = d > a ? m.lp[d] - m.lp[a] : 0, cNow = d > a ? m.pos[d] - m.pos[a] : 0;
      const est = s.pct[T] + b1 * rNow + b2 * cNow;
      const frac = Math.min(1, Math.max(0, d - a) / 5);
      res = {
        key, r2: sst > 0 ? 1 - sse / sst : NaN, b1, b2, se: Math.sqrt(sse / (n - 2)) * Math.sqrt(frac),
        rNow, cNow, est, pct: s.pct[T], pRep: prank(s.pct, T, S.lb), pNow: rankWith(s.pct, T, S.lb, est),
        days: d - a, asof: DAILY.dates[d],
      };
      res.dP = res.pNow - res.pRep;
    }
  }
  cache.set(ck, res);
  return res;
}
/* percentile of x as the newest point of the trailing window ending at T */
function rankWith(a, T, win, x) {
  if (!fin(x)) return NaN;
  const lo = win ? Math.max(0, T - win + 2) : 0;
  let below = 0, eq = 1, cnt = 1;
  for (let i = lo; i <= T; i++) {
    const v = a[i];
    if (v !== v) continue;
    cnt++;
    if (v < x) below++; else if (v === x) eq++;
  }
  return cnt >= minObs(win) ? (below + 0.5 * eq) / cnt * 100 : NaN;
}

/* ======================================================================= options layer */
function optFor(key, cl) {
  const ck = `opt|${key}|${cl.join('+')}|${S.lb}`;
  if (cache.has(ck)) return cache.get(ck);
  const f = DATA.fut && DATA.fut[key], c = DATA.combo && DATA.combo[key];
  let res = null;
  if (f && c) {
    const sf = ser(key, 'fut', cl), sc = ser(key, 'combo', cl), n = TS.length;
    const od = new Float64Array(n), odp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      od[i] = sc.net[i] - sf.net[i];
      odp[i] = c.oi[i] > 0 ? od[i] / c.oi[i] * 100 : NaN;
    }
    const t = lastIdx(c.oi);
    if (t > 4) {
      const share = c.oi[t] > 0 ? (c.oi[t] - f.oi[t]) / c.oi[t] * 100 : NaN;
      res = {
        key, t, od: od[t], d1: od[t] - od[t - 1], d4: od[t] - od[t - 4], odp: odp[t], P: prank(odp, t, S.lb), share,
        usd: od[t] * (NPC[key] ? NPC[key][t] : NaN), Pf: prank(sf.pct, t, S.lb), Pc: prank(sc.pct, t, S.lb),
      };
    }
  }
  cache.set(ck, res);
  return res;
}

/* ======================================================================= backtest */
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function stdev(a) { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)) : NaN; }
const BT_H = [4, 8, 13];
function btMarket(key, cl, hi, lo) {
  const ck = `bt|${S.kind}|${key}|${cl.join('+')}|${S.lb}|${hi}|${lo}`;
  if (cache.has(ck)) return cache.get(ck);
  const cp = CP[key];
  let res = null;
  if (cp && DATA[S.kind][key]) {
    const rr = rollRank(key, S.kind, cl, S.lb), n = TS.length;
    const lr = [];
    for (let t = 1; t < n; t++) if (cp[t] > 0 && cp[t - 1] > 0) lr.push(Math.log(cp[t] / cp[t - 1]));
    const wv = stdev(lr);
    const acc = { L: BT_H.map(() => []), S: BT_H.map(() => []), A: BT_H.map(() => []) };
    let epL = 0, epS = 0, prev = null;
    for (let t = 0; t < n; t++) {
      const p = rr[t];
      const z = !fin(p) ? null : p >= hi ? 'L' : p <= lo ? 'S' : null;
      if (z && z !== prev) { if (z === 'L') epL++; else epS++; }
      prev = z;
      if (!fin(p) || !(cp[t] > 0)) continue;
      BT_H.forEach((h, j) => {
        if (t + h < n && cp[t + h] > 0) {
          const f = cp[t + h] / cp[t] - 1;
          acc.A[j].push(f);
          if (z) acc[z][j].push(f);
        }
      });
    }
    const stat = (arr, base, eps, sign, h) => {
      if (arr.length < 6 || eps < 2) return null;
      const mu = mean(arr), sd = stdev(arr), b = mean(base), ex = mu - b;
      return {
        n: arr.length, eps, mean: mu, ex, hit: arr.filter((f) => sign * f > 0).length / arr.length,
        t: sd > 0 ? ex / (sd / Math.sqrt(eps)) : NaN, exSd: wv > 0 ? ex / (wv * Math.sqrt(h)) : NaN,
      };
    };
    res = {
      key, wv, nowP: rr[lastIdx(rr)],
      L: BT_H.map((h, j) => stat(acc.L[j], acc.A[j], epL, -1, h)),
      S: BT_H.map((h, j) => stat(acc.S[j], acc.A[j], epS, 1, h)),
    };
  }
  cache.set(ck, res);
  return res;
}
function btVerdict(b, j) {
  if (!b) return { k: 'neutral', label: 'Too few episodes' };
  const L = b.L[j], Sx = b.S[j];
  const parts = [];
  if (L && fin(L.t) && Math.abs(L.t) >= 1.5) parts.push(L.ex < 0 ? 'crowded longs underperform' : 'crowded longs keep winning');
  if (Sx && fin(Sx.t) && Math.abs(Sx.t) >= 1.5) parts.push(Sx.ex > 0 ? 'crowded shorts get squeezed' : 'crowded shorts keep winning');
  if (!parts.length) return { k: 'neutral', label: 'No reliable edge' };
  const contra = (L && L.ex < 0 && Math.abs(L.t) >= 1.5) || (Sx && Sx.ex > 0 && Math.abs(Sx.t) >= 1.5);
  return { k: contra ? 'info' : 'warning', label: parts.join('; ') };
}
function btTheme(d, hi, lo, h) {
  const n = TS.length, rets = [], z = [];
  const legs = d.legs.filter((l) => !l.na && CP[l.leg.m]);
  if (!legs.length) return null;
  const fwd = new Float64Array(n).fill(NaN);
  for (let t = 0; t + h < n; t++) {
    let s = 0, c = 0;
    for (const l of legs) { const cp = CP[l.leg.m]; if (cp[t] > 0 && cp[t + h] > 0) { s += l.leg.s * (cp[t + h] / cp[t] - 1); c++; } }
    if (c) fwd[t] = s / c;
  }
  const A = [], H = [], Lo = [];
  let epH = 0, epL = 0, prev = null;
  for (let t = 0; t < n; t++) {
    const v = d.comp[t];
    const zone = !fin(v) ? null : v >= hi ? 'H' : v <= lo ? 'L' : null;
    if (zone && zone !== prev) { if (zone === 'H') epH++; else epL++; }
    prev = zone;
    if (!fin(fwd[t]) || !fin(v)) continue;
    A.push(fwd[t]);
    if (zone === 'H') H.push(fwd[t]); else if (zone === 'L') Lo.push(fwd[t]);
  }
  const st = (arr, eps, sign) => (arr.length < 6 || eps < 2 ? null : { n: arr.length, eps, mean: mean(arr), ex: mean(arr) - mean(A), hit: arr.filter((f) => sign * f > 0).length / arr.length, t: (mean(arr) - mean(A)) / (stdev(arr) / Math.sqrt(eps)) });
  return { H: st(H, epH, -1), L: st(Lo, epL, 1) };
}

/* ======================================================================= don't-miss signals */
function dontMiss() {
  const ck = `dm|${S.kind}|${S.role}|${S.lb}`;
  if (cache.has(ck)) return cache.get(ck);
  const out = [];
  const add = (sev, kind, key, text, score) => out.push({ sev, kind, key, text, score });
  const rows = allMetrics().filter((r) => !r.na && !r.stale && fin(r.p));
  for (const r of rows) {
    const name = r.m.name, p = r.p, rr = rollRank(r.key, S.kind, r.cl, S.lb), p0 = rr[r.t - 1];
    const at = `at the ${ord(p)} percentile (net ${fmtN(r.pct, 1, true)}% of OI)`;
    // a high percentile on a net short (basis trades, hedgers) is "least short", not a crowded long
    const longX = p >= 90 && r.pct > 0, shortX = p <= 10 && r.pct < 0;
    const odd = (p >= 95 && r.pct < 0) ? `, still net short, so the least short in ${LB_LABEL[S.lb]}` : (p <= 5 && r.pct > 0) ? `, still net long, so the least long in ${LB_LABEL[S.lb]}` : '';
    if (longX && r.r4 <= -0.02) add('critical', 'Crowded and offside', r.key, `${name}: ${ROLES[S.role].short} ${at}, the long side of their range, while the contract is ${fmtChg(r.r4)} over 4 weeks.`, (p - 50) * -r.r4 * 100);
    if (shortX && r.r4 >= 0.02) add('critical', 'Crowded and offside', r.key, `${name}: ${ROLES[S.role].short} ${at}, the short side of their range, while the contract is ${fmtChg(r.r4)} over 4 weeks.`, (50 - p) * r.r4 * 100);
    if ((p >= 95 && !(p0 >= 95)) || (p <= 5 && !(p0 <= 5))) add('serious', 'New extreme', r.key, `${name}: ${ROLES[S.role].short} moved to the ${ord(p)} percentile (${LB_LABEL[S.lb]}) from the ${ord(p0)} a week earlier; net ${fmtN(r.pct, 1, true)}% of OI${odd}.`, Math.abs(p - 50) - (odd ? 25 : 0));
    if (fin(r.fz) && Math.abs(r.fz) >= 2.5) add('serious', 'Big weekly flow', r.key, `${name}: ${fmtUSD(r.flow, true)} (${r.driver ? r.driver.label.toLowerCase() : 'flow'}), ${fmtN(r.fz, 1, true)} standard deviations.`, Math.abs(r.fz) * 10);
    if (fin(r.rsr) && Math.abs(r.rsr) >= 0.03 && (p >= 85 || p <= 15)) {
      const against = (p >= 85 && r.pct > 0 && r.rsr < 0) || (p <= 15 && r.pct < 0 && r.rsr > 0);
      if (against) add('serious', 'Hit since Tuesday', r.key, `${name} has moved ${fmtChg(r.rsr)} since the report date against positioning at the ${ord(p)} percentile.`, Math.abs(r.rsr) * 300);
    }
  }
  // everyone on the same side: fast money and real money both extreme
  for (const m of META.markets.filter((x) => x.report === 'tff')) {
    const a = metrics(m.key, { cl: ['lev'] }), b = metrics(m.key, { cl: ['am'] });
    if (a.na || b.na || a.stale) continue;
    if ((a.p >= 90 && b.p >= 90) || (a.p <= 10 && b.p <= 10)) add('warning', 'One-sided market', m.key, `${m.name}: leveraged funds (${fmtP(a.p)}) and asset managers (${fmtP(b.p)}) are both at ${a.p >= 90 ? 'long' : 'short'} extremes.`, Math.abs(a.p - 50) + Math.abs(b.p - 50));
  }
  for (const d of allThemes().map(themeData)) {
    if (d.status.k === 'critical' || d.status.k === 'serious') add(d.status.k, 'Theme', null, `${d.th.name}: score ${fmtP(d.now)} (${fmtN(d.d4, 0, true)} in 4 weeks), ${d.status.label.toLowerCase()}.`, d.now);
    else if (fin(d.d4) && Math.abs(d.d4) >= 15) add('warning', 'Theme', null, `${d.th.name}: score ${fmtN(d.d4, 0, true)} in 4 weeks to ${fmtP(d.now)}.`, Math.abs(d.d4));
  }
  if (DAILY && DAILY.dates.length) {
    for (const r of rows) {
      const nc = nowcastFor(r.key, r.cl);
      if (nc && nc.r2 >= 0.15 && fin(nc.dP) && Math.abs(nc.dP) >= 15) add('warning', 'Nowcast', r.key, `${r.m.name}: estimated percentile ${fmtP(nc.pRep)} → ${fmtP(nc.pNow)} since Tuesday (R² ${fmtN(nc.r2, 2)}).`, Math.abs(nc.dP));
      const c = ctaNow(r.key);
      if (c && fin(c.distSd) && Math.abs(c.distSd) <= 1 && Math.abs(c.pos) >= 0.25 && !AGG_SKIP.has(r.key)) add('warning', 'CTA flip near', r.key, `${r.m.name}: trend model ${fmtN(c.pos * 100, 0, true)}% flips at ${dispPx(r.m, c.flip)}, ${fmtN(c.distPct * 100, 1, true)}% (${fmtN(c.distSd, 1, true)}σ weekly) away.`, 30 - Math.abs(c.distSd) * 10);
    }
  }
  if (DATA.combo) {
    for (const r of rows) {
      const o = optFor(r.key, r.cl);
      if (o && o.share >= 10 && fin(o.P) && (o.P >= 97 || o.P <= 3) && !AGG_SKIP.has(r.key)) add('info', 'Options', r.key, `${r.m.name}: ${ROLES[S.role].short} options delta at the ${ord(o.P)} percentile (${fmtK(o.od, true)} futures-equivalents).`, Math.abs(o.P - 50) / 2);
    }
  }
  out.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.score - a.score);
  cache.set(ck, out);
  return out;
}

/* ======================================================================= tab: conclusions */
RENDER.conclusions = async (sec) => {
  sec.innerHTML = '<div class="loading">Loading…</div>';
  await ensureAll();
  if (!stillOn('conclusions', sec)) return;
  const sig = dontMiss();
  const c = CONCL && CONCL.report_date === META.latest ? CONCL : null;
  const asofDaily = DAILY.dates.length ? DAILY.dates[DAILY.dates.length - 1] : null;
  sec.innerHTML = `
    <div class="sheet-head"><h2>Conclusions</h2><p>What matters in positions as of ${fmtDate(META.latest)}, with prices to ${asofDaily ? fmtDate(asofDaily) : 'the latest close'}. ${esc(roleLabel())}, ${kindLabel()}, ${lbLabel()}.</p></div>
    ${c ? conclusionsHTML(c) : `<div class="banner">The written read for the ${fmtDate(META.latest, { day: 'numeric', month: 'short' })} report is produced after each CFTC release (Saturday morning SGT). The signals below update on their own.</div>`}
    ${panel("Don't-miss signals", { note: `${sig.length} flagged. Act = crowded and losing money; Watch closely = new extremes, big flows, theme unwinds.`, body: '<div class="tablewrap" id="cc-sig"></div>', bodyClass: '' })}
    <div class="grid2">
      ${panel('Moves since Tuesday', { note: 'Largest estimated changes in positioning percentile (nowcast)', body: '<div class="tablewrap" id="cc-nc"></div>', bodyClass: '' })}
      ${panel('Trend-follower flip watch', { note: 'Closest CTA flip levels, in weekly standard deviations', body: '<div class="tablewrap" id="cc-cta"></div>', bodyClass: '' })}
    </div>
    <div class="grid2">
      ${panel('Themes', { note: 'Ranked by crowding', body: '<div class="tablewrap" id="cc-th"></div>', bodyClass: '' })}
      ${panel('What history says about today\'s extremes', { note: `Markets now beyond the 90th/10th percentile: 13-week forward excess return after past episodes`, body: '<div class="tablewrap" id="cc-bt"></div>', bodyClass: '' })}
    </div>`;
  const sevCell = (s) => `<span class="pill ${s.sev === 'critical' ? 'critical' : s.sev === 'serious' ? 'serious' : s.sev === 'warning' ? 'warning' : 'info'}">${SEV_LABEL[s.sev]}</span>`;
  table('cc-sig', $('#cc-sig'), [
    { k: 'mk', h: 'Level', l: true, v: (r) => SEV_ORDER[r.sev] * 1000 - r.score, f: sevCell },
    { k: 'kind', h: 'Signal', l: true, v: (r) => r.kind, f: (r) => esc(r.kind) },
    { k: 'text', h: 'Detail', l: true, v: (r) => r.text, f: (r) => `<span style="white-space:normal;display:inline-block;min-width:32ch;max-width:90ch">${esc(r.text)}</span>` },
  ], sig.map((s, i) => Object.assign({ _i: i }, s)), { sort: 'mk', dir: 1, onRow: (k) => { if (MK[k]) openMarket(k); } });
  const rows = allMetrics().filter((r) => !r.na && !r.stale);
  const ncs = rows.map((r) => Object.assign({ key: r.key, m: r.m }, nowcastFor(r.key, r.cl) || {})).filter((x) => fin(x.dP) && x.r2 >= 0.1);
  ncs.sort((a, b) => Math.abs(b.dP) - Math.abs(a.dP));
  table('cc-nc', $('#cc-nc'), [COL.mk,
    { k: 'pRep', h: 'Tue', v: (r) => r.pRep, f: (r) => fmtP(r.pRep), c: (r) => 'heat ' + heatClass(r.pRep) },
    { k: 'pNow', h: 'Now (est.)', v: (r) => r.pNow, f: (r) => fmtP(r.pNow), c: (r) => 'heat ' + heatClass(r.pNow) },
    { k: 'rNow', h: 'Px since Tue', v: (r) => r.rNow, f: (r) => fmtChg(Math.expm1(r.rNow)) },
    { k: 'r2', h: 'R²', v: (r) => r.r2, f: (r) => fmtN(r.r2, 2) },
  ], ncs.slice(0, 10), { sort: null, onRow: openMarket });
  const ctas = rows.filter((r) => !AGG_SKIP.has(r.key)).map((r) => Object.assign({ key: r.key, m: r.m }, ctaNow(r.key) || {})).filter((c) => fin(c.distSd) && Math.abs(c.pos) >= 0.2);
  ctas.sort((a, b) => Math.abs(a.distSd) - Math.abs(b.distSd));
  table('cc-cta', $('#cc-cta'), [COL.mk,
    { k: 'pos', h: 'Model', v: (r) => r.pos, f: (r) => fmtN(r.pos * 100, 0, true) + '%', c: (r) => 'heat ' + heatClass(50 + r.pos * 50) },
    { k: 'flip', h: 'Flips at', v: (r) => r.flip, f: (r) => dispPx(r.m, r.flip) },
    { k: 'dist', h: 'Away', v: (r) => Math.abs(r.distSd), f: (r) => `${fmtN(r.distPct * 100, 1, true)}% · ${fmtN(r.distSd, 1, true)}σ` },
  ], ctas.slice(0, 10), { sort: null, onRow: openMarket });
  themeTable('cc-th', $('#cc-th'), allThemes().map(themeData).filter((t) => fin(t.now)).sort((a, b) => b.now - a.now).slice(0, 10), true);
  const ext = rows.filter((r) => r.p >= 90 || r.p <= 10).map((r) => {
    const b = btMarket(r.key, r.cl, 90, 10);
    const s = b ? (r.p >= 90 ? b.L[2] : b.S[2]) : null;
    return Object.assign({ key: r.key, m: r.m, p: r.p, side: r.p >= 90 ? 'L' : 'S' }, s ? { ex: s.ex, hit: s.hit, t: s.t, eps: s.eps } : {});
  }).filter((x) => fin(x.ex));
  ext.sort((a, b) => Math.abs(b.t || 0) - Math.abs(a.t || 0));
  table('cc-bt', $('#cc-bt'), [COL.mk,
    { k: 'p', h: 'Pctl', v: (r) => r.p, f: (r) => fmtP(r.p), c: (r) => 'heat ' + heatClass(r.p) },
    { k: 'ex', h: '13w excess', t: 'Average 13-week futures return after past episodes minus the unconditional average', v: (r) => r.ex, f: (r) => fmtChg(r.ex) },
    { k: 'hit', h: 'Reversal rate', t: 'Share of past episodes where price moved against the crowd over 13 weeks', v: (r) => r.hit, f: (r) => Math.round(r.hit * 100) + '%' },
    { k: 't', h: 't', v: (r) => r.t, f: (r) => fmtN(r.t, 1, true) },
    { k: 'eps', h: 'Episodes', v: (r) => r.eps, f: (r) => String(r.eps) },
  ], ext.slice(0, 12), { sort: null, onRow: openMarket });
};
function conclusionsHTML(c) {
  const chips = (keys) => (keys || []).filter((k) => MK[k]).map((k) => `<button type="button" class="btn" data-mk="${esc(k)}">${esc(MK[k].name)}</button>`).join(' ');
  const pts = (c.points || []).map((p, i) => `
    <article class="concl-pt">
      <div class="concl-n">${i + 1}</div>
      <div class="concl-body">
        <h4>${esc(p.title || '')}</h4>
        <p>${esc(p.body || '')}</p>
        ${p.trade ? `<dl class="kv concl-trade"><dt>Expression</dt><dd>${esc(p.trade.expression || '')}</dd><dt>Risk/reward</dt><dd>${esc(p.trade.risk_reward || '')}</dd><dt>Invalidation</dt><dd>${esc(p.trade.invalidation || '')}</dd></dl>` : ''}
        ${p.markets && p.markets.length ? `<div class="chips" style="margin-top:6px">${chips(p.markets)}</div>` : ''}
      </div>
    </article>`).join('');
  const watch = (c.watch || []).length ? `<h4 class="concl-sub">Also watch</h4><ul class="concl-watch">${c.watch.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
  const verify = c.verify ? `<p class="concl-verify"><b>Check before trading:</b> ${esc(c.verify)}</p>` : '';
  return `<div class="panel concl"><div class="panel-head"><h3>The read</h3><span class="note">Written ${esc(c.written || '')} for positions as of ${fmtDate(c.report_date)}</span></div>
    <div class="panel-body"><p class="concl-head">${esc(c.headline || '')}</p>${pts}${watch}${verify}</div></div>`;
}

/* ======================================================================= tab: nowcast & CTA */
RENDER.nowcast = async (sec) => {
  sec.innerHTML = '<div class="loading">Loading…</div>';
  await ensureAll();
  if (!stillOn('nowcast', sec)) return;
  if (!DAILY.dates.length) { sec.innerHTML = '<div class="banner">Daily prices are not available in this build.</div>'; return; }
  const asof = DAILY.dates[DAILY.dates.length - 1];
  const rows = allMetrics().filter((r) => !r.na && !r.stale);
  const usd = ctaAvg(G10, -1), eq = ctaAvg(['SPX', 'NDX', 'RTY', 'DJIA', 'MID', 'NKYJ', 'MSEM', 'MSEAFE']);
  const dur = ctaAvg(['UST2', 'UST5', 'UST10', 'ULTRA10', 'BOND', 'ULTRA', 'SOFR3']);
  const en = ctaAvg(['WTI', 'BRENTICE', 'RBOB', 'ULSD', 'GASOIL', 'NATGAS']), mt = ctaAvg(['GOLD', 'SILVER', 'COPPER', 'PLAT', 'PALL']);
  const ag = ctaAvg(['CORN', 'SOY', 'WHEAT', 'KCWHEAT', 'SOYMEAL', 'SOYOIL', 'SUGAR', 'COFFEE', 'COCOA', 'COTTON']);
  const tile = (label, a) => (a ? tileHTML({ label, value: `${fmtN(a.pos * 100, 0, true)}%`, sub: `1w ${fmtN(a.d5 * 100, 0, true)} pts · ${a.n} markets` }) : '');
  sec.innerHTML = `
    <div class="sheet-head"><h2>Nowcast &amp; CTA</h2><p>The CFTC reports Tuesday positions on Friday. The nowcast estimates where ${esc(ROLES[S.role].short)} stand at the ${fmtDate(asof)} close from each market's own past response to price moves and to the trend model below (3 years of weekly data; R² shows how much to trust it). The trend model is a standard trend follower: 1, 3, 6 and 12-month momentum scaled by volatility, from −100% (max short) to +100% (max long).</p></div>
    <div class="tiles">${tile('Trend model · USD vs G10', usd)}${tile('Trend model · equity indices', eq)}${tile('Trend model · duration', dur)}${tile('Trend model · energy', en)}${tile('Trend model · metals', mt)}${tile('Trend model · ags & softs', ag)}</div>
    ${panel('Nowcast: positioning since Tuesday', { note: `${esc(roleLabel())}, ${LB_LABEL[S.lb]} percentiles. Fit: weekly change in % OI on the week's return and trend-model change, no intercept.`, tools: '<button class="btn" data-copy="nc-main">Copy</button>', body: '<div class="tablewrap" id="nc-main"></div>', bodyClass: '' })}
    ${panel('Trend-follower model and flip levels', { note: 'Flip = price at which the aggregate model turns from long to short (or back) at the next close. Flows: change in model position over the next week if price moves −2σ to +2σ.', tools: '<button class="btn" data-copy="cta-main">Copy</button>', body: '<div class="tablewrap" id="cta-main"></div>', bodyClass: '' })}
    <div class="grid2">
      ${panel('Price and flip level', { note: '<span id="cta-name"></span>', tools: seg('cta-range', [[260, '1Y'], [520, '2Y'], [1100, 'All']], S.ctaRange || 260), body: '<div class="chart" id="cta-px"></div>' })}
      ${panel('Trend-model position', { note: 'by lookback and in aggregate', body: '<div class="chart" id="cta-pos"></div>' })}
    </div>`;
  onSeg('cta-range', (v) => { S.ctaRange = +v; save(); render(); });
  const ncRows = rows.map((r) => Object.assign({ key: r.key, m: r.m, r }, nowcastFor(r.key, r.cl) || {}));
  table('nc-main', $('#nc-main'), [COL.mk,
    { k: 'pct', h: '% OI Tue', g: 'Net % of OI', v: (x) => x.pct, f: (x) => fmtN(x.pct, 1, true) },
    { k: 'est', h: 'Now (est.)', g: 'Net % of OI', v: (x) => x.est, f: (x) => fmtN(x.est, 1, true) },
    { k: 'se', h: '±1 s.e.', g: 'Net % of OI', v: (x) => x.se, f: (x) => fmtN(x.se, 1) },
    { k: 'pRep', h: 'Tue', g: 'Percentile', v: (x) => x.pRep, f: (x) => fmtP(x.pRep), c: (x) => 'heat ' + heatClass(x.pRep) },
    { k: 'pNow', h: 'Now (est.)', g: 'Percentile', v: (x) => x.pNow, f: (x) => fmtP(x.pNow), c: (x) => 'heat ' + heatClass(x.pNow) },
    { k: 'dP', h: 'Change', g: 'Percentile', v: (x) => x.dP, f: (x) => fmtN(x.dP, 0, true) },
    { k: 'rNow', h: 'Price', g: 'Since Tuesday', v: (x) => x.rNow, f: (x) => fmtChg(Math.expm1(x.rNow)) },
    { k: 'cNow', h: 'Trend model', g: 'Since Tuesday', v: (x) => x.cNow, f: (x) => fmtN(x.cNow * 100, 0, true) + ' pts' },
    { k: 'r2', h: 'R²', g: 'Fit', v: (x) => x.r2, f: (x) => fmtN(x.r2, 2) },
    { k: 'b1', h: 'pp per 1%', g: 'Fit', t: 'Change in net % OI for a 1% price move in the same week', v: (x) => x.b1, f: (x) => fmtN(x.b1 / 100, 2, true) },
  ], ncRows.filter((x) => fin(x.est)), { sort: 'dP', dir: -1, onRow: (k) => { S.ctaKey = k; save(); drawCta(k); } });
  const ctaRows = rows.filter((r) => DAILY.px[r.key]).map((r) => Object.assign({ key: r.key, m: r.m, p: r.p }, ctaNow(r.key) || {})).filter((x) => fin(x.pos));
  table('cta-main', $('#cta-main'), [COL.mk,
    { k: 'pos', h: 'Now', g: 'Model position', v: (x) => x.pos, f: (x) => fmtN(x.pos * 100, 0, true) + '%', c: (x) => 'heat ' + heatClass(50 + x.pos * 50) },
    { k: 'd5', h: 'Δ 1w', g: 'Model position', v: (x) => x.d5, f: (x) => fmtN(x.d5 * 100, 0, true) },
    ...CTA_LB.map((L, j) => ({ k: 's' + j, h: CTA_LB_LABEL[j], g: 'Signal by lookback', v: (x) => x.sig[j], f: (x) => fmtN(x.sig[j] * 100, 0, true), c: (x) => 'heat ' + heatClass(50 + x.sig[j] * 50) })),
    { k: 'px', h: 'Last', g: 'Flip', v: (x) => x.P, f: (x) => dispPx(x.m, x.P) },
    { k: 'flip', h: 'Level', g: 'Flip', v: (x) => x.flip, f: (x) => dispPx(x.m, x.flip) },
    { k: 'dist', h: 'Away', g: 'Flip', t: 'Distance to the flip level in % and in weekly standard deviations; sorted by absolute distance', v: (x) => Math.abs(x.distSd), f: (x) => `${fmtN(x.distPct * 100, 1, true)}% · ${fmtN(x.distSd, 1, true)}σ` },
    ...[-2, -1, 0, 1, 2].map((k, j) => ({ k: 'sc' + j, h: k === 0 ? 'Flat' : `${k > 0 ? '+' : MINUS}${Math.abs(k)}σ`, g: 'Next-week flow, % of max', v: (x) => x.scen[j], f: (x) => fmtN(x.scen[j] * 100, 0, true) })),
    { k: 'p', h: 'CFTC pctl', t: `${ROLES[S.role].short} percentile (${LB_LABEL[S.lb]}) for comparison`, v: (x) => x.p, f: (x) => fmtP(x.p), c: (x) => 'heat ' + heatClass(x.p) },
  ], ctaRows, { sort: 'dist', dir: 1, onRow: (k) => { S.ctaKey = k; save(); drawCta(k); } });
  drawCta(S.ctaKey && DAILY.px[S.ctaKey] ? S.ctaKey : 'SPX');
};
function drawCta(key) {
  const m = ctaModel(key), c = ctaNow(key), mk = MK[key];
  if (!m || !c) return;
  $('#cta-name').textContent = `${mk.name} · flip ${dispPx(mk, c.flip)} (${fmtN(c.distPct * 100, 1, true)}%)`;
  for (const id of ['cta-px', 'cta-pos']) {
    const el = $('#' + id);
    const old = charts.findIndex((x) => x.getDom && x.getDom() === el);
    if (old >= 0) { charts[old].dispose(); charts.splice(old, 1); }
  }
  const col = chartColors(), n = DAILY.dates.length, from = Math.max(260, n - (S.ctaRange || 260));
  const ld = (a, f = (v) => v) => { const out = []; for (let i = from; i < n; i++) out.push([DAILY.ts[i], a[i] === a[i] ? f(a[i]) : null]); return out; };
  const zoom = [{ type: 'inside', zoomOnMouseWheel: 'shift', moveOnMouseWheel: false, moveOnMouseMove: false }];
  const pf = (v) => dispPx(mk, mk.disp === 'inv' ? 1 / v : mk.disp === 'cents' ? v / 100 : v);
  mkChart($('#cta-px'), {
    grid: { left: 8, right: 16, top: 14, bottom: 24, containLabel: true }, xAxis: axisX(col),
    yAxis: axisY(col, { axisLabel: { color: col.muted, fontSize: 11, formatter: pf } }), dataZoom: zoom,
    tooltip: { trigger: 'axis', formatter: tipAxis(pf) },
    series: [lineSeries('Price', ld(DAILY.px[key], (v) => dispVal(mk, v)), col.ink2, {
      markLine: { silent: true, symbol: 'none', lineStyle: { color: col.accent, type: 'solid', width: 1.5 }, label: { formatter: 'flip ' + pf(dispVal(mk, c.flip)), color: col.ink2, fontSize: 11 }, data: [{ yAxis: dispVal(mk, c.flip) }] },
    })],
  }, 'cta');
  mkChart($('#cta-pos'), {
    grid: { left: 8, right: 16, top: 34, bottom: 24, containLabel: true }, xAxis: axisX(col), legend: legendCfg(col),
    yAxis: axisY(col, { min: -100, max: 100, scale: false, interval: 50 }), dataZoom: zoom,
    tooltip: { trigger: 'axis', formatter: tipAxis((v) => fmtN(v, 0, true) + '%') },
    series: [lineSeries('Aggregate', ld(m.pos, (v) => v * 100), col.ink, { lineStyle: { width: 2.5, color: col.ink } })]
      .concat(CTA_LB.map((L, j) => lineSeries(CTA_LB_LABEL[j], ld(m.sig[j], (v) => v * 100), col.slot(j + 1), { lineStyle: { width: 1.2, opacity: 0.8 } }))),
  }, 'cta');
  if (window.echarts) echarts.connect('cta');
}

/* ======================================================================= tab: options */
RENDER.options = async (sec) => {
  sec.innerHTML = '<div class="loading">Loading…</div>';
  await ensureAll();
  if (!stillOn('options', sec)) return;
  const pairs = Object.entries(FXO.pairs || {}).sort((a, b) => b[1].total - a[1].total).map(([k]) => k);
  if (!pairs.includes(S.fxPair)) S.fxPair = pairs.includes('EURUSD') ? 'EURUSD' : pairs[0];
  sec.innerHTML = `
    <div class="sheet-head"><h2>Options</h2><p>The futures-and-options reports add each group's options as futures-equivalents (delta-adjusted); subtracting the futures-only report leaves the net options delta. Positive means the group is net long calls and/or short puts. Below that, upcoming OTC FX option expiries by strike from DTCC's public trade reports.</p></div>
    ${panel('Net options delta by trader group', { note: `${LB_LABEL[S.lb]} percentiles of options delta as % of open interest. "F vs F&O" compares ${esc(ROLES[S.role].short)} percentiles with and without options.`, tools: '<button class="btn" data-copy="op-main">Copy</button>', body: '<div class="tablewrap" id="op-main"></div>', bodyClass: '' })}
    ${pairs.length ? panel('FX option expiries (DTCC)', {
      note: `Vanilla OTC options reported to DTCC up to ${esc(FXO.asof || '')}. Public data covers trades with a US counterparty and caps large notionals, so treat sizes as a floor.`,
      tools: `<label class="ctl"><span>Pair</span><select id="fx-pair">${pairs.map((p) => `<option${p === S.fxPair ? ' selected' : ''}>${p}</option>`).join('')}</select></label>${seg('fx-win', [[7, '1w'], [14, '2w'], [31, '1m']], S.fxWin || 14)}`,
      body: '<div class="chart tall" id="fx-chart"></div><div class="tablewrap" id="fx-top" style="margin-top:8px"></div>',
    }) : '<div class="banner">FX option expiries are not available in this build.</div>'}`;
  const rows = allMetrics().filter((r) => !r.na && !r.stale);
  const grp = (r, role) => { const cl = catsFor(r.m, role); return cl ? optFor(r.key, cl) : null; };
  const orows = rows.map((r) => ({ key: r.key, m: r.m, s: optFor(r.key, r.cl), a: grp(r, 'am'), d: grp(r, 'dealer') })).filter((x) => x.s && x.s.share >= 2);
  table('op-main', $('#op-main'), [COL.mk,
    { k: 'share', h: 'Options % OI', g: 'Market', v: (x) => x.s.share, f: (x) => fmtN(x.s.share, 0) + '%' },
    { k: 'sod', h: 'Delta', g: ROLES[S.role].short, v: (x) => x.s.od, f: (x) => fmtK(x.s.od, true) },
    { k: 'susd', h: 'Delta $', g: ROLES[S.role].short, v: (x) => x.s.usd, f: (x) => fmtUSD(x.s.usd, true) },
    { k: 'sd1', h: 'Δ 1w', g: ROLES[S.role].short, v: (x) => x.s.d1, f: (x) => fmtK(x.s.d1, true) },
    { k: 'sP', h: 'Pctl', g: ROLES[S.role].short, v: (x) => x.s.P, f: (x) => fmtP(x.s.P), c: (x) => 'heat ' + heatClass(x.s.P) },
    { k: 'gap', h: 'F vs F&O', g: ROLES[S.role].short, t: 'Percentile with options minus futures-only percentile: positive = options make the group look longer', v: (x) => x.s.Pc - x.s.Pf, f: (x) => `${fmtP(x.s.Pf)} → ${fmtP(x.s.Pc)}` },
    { k: 'aod', h: 'Delta', g: 'Asset managers', v: (x) => (x.a ? x.a.od : NaN), f: (x) => (x.a ? fmtK(x.a.od, true) : '–') },
    { k: 'aP', h: 'Pctl', g: 'Asset managers', v: (x) => (x.a ? x.a.P : NaN), f: (x) => (x.a ? fmtP(x.a.P) : '–'), c: (x) => 'heat ' + heatClass(x.a ? x.a.P : NaN) },
    { k: 'dod', h: 'Delta', g: 'Dealers', v: (x) => (x.d ? x.d.od : NaN), f: (x) => (x.d ? fmtK(x.d.od, true) : '–') },
    { k: 'dP', h: 'Pctl', g: 'Dealers', v: (x) => (x.d ? x.d.P : NaN), f: (x) => (x.d ? fmtP(x.d.P) : '–'), c: (x) => 'heat ' + heatClass(x.d ? x.d.P : NaN) },
  ], orows, { sort: 'share', dir: -1, onRow: openMarket });
  if (!pairs.length) return;
  $('#fx-pair').onchange = (e) => { S.fxPair = e.target.value; save(); drawFx(); };
  onSeg('fx-win', (v) => { S.fxWin = +v; save(); drawFx(); });
  drawFx();
};
function fxDigits(pair) { return /JPY|KRW|INR|TWD|IDR|PHP|THB|HUF|CLP|COP/.test(pair) ? 2 : 4; }
function fxExpiries(pair, days) {
  const p = FXO.pairs[pair];
  if (!p) return null;
  const today = new Date().toISOString().slice(0, 10), end = addDays(today, days);
  const rows = p.rows.filter((r) => r[0] >= today && r[0] <= end);
  return { spot: p.spot, rows };
}
function drawFx() {
  const pair = S.fxPair, days = S.fxWin || 14, d = fxExpiries(pair, days);
  for (const id of ['fx-chart']) {
    const el = $('#' + id);
    const old = charts.findIndex((x) => x.getDom && x.getDom() === el);
    if (old >= 0) { charts[old].dispose(); charts.splice(old, 1); }
  }
  if (!d) return;
  const dg = fxDigits(pair), spot = d.spot;
  // bucket strikes to about a quarter of a percent of spot (25 pips in EURUSD, 50 sen in USDJPY)
  const nice = (x) => { const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e; return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * e; };
  const step = spot ? nice(spot * 0.0025) : 0;
  const bucket = (k) => (step ? Math.round(k / step) * step : k);
  const agg = new Map();
  for (const [exp, k, cp, usd] of d.rows) {
    if (spot && Math.abs(k / spot - 1) > 0.08) continue;
    const b = bucket(k), cur = agg.get(b) || { C: 0, P: 0 };
    cur[cp] += usd;
    agg.set(b, cur);
  }
  const strikes = [...agg.keys()].sort((a, b) => a - b);
  const col = chartColors();
  mkChart($('#fx-chart'), {
    grid: { left: 8, right: 16, top: 34, bottom: 24, containLabel: true }, legend: legendCfg(col),
    xAxis: { type: 'value', axisLabel: { color: col.muted, fontSize: 11, formatter: (v) => fmtUSD(v * 1e6) }, splitLine: { lineStyle: { color: col.grid } } },
    yAxis: { type: 'category', data: strikes.map((k) => k.toFixed(dg)), axisTick: { show: false }, axisLabel: { color: col.ink2, fontSize: 11 }, axisLine: { lineStyle: { color: col.axis } } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => `<b>${esc(ps[0].axisValue)}</b>${spot ? ` (${fmtN((ps[0].axisValue / spot - 1) * 100, 2, true)}% vs spot)` : ''}<br>` + ps.map((p) => `${esc(p.seriesName)}: <b>${fmtUSD(p.value * 1e6)}</b>`).join('<br>') },
    series: [
      { name: 'Calls', type: 'bar', stack: 'k', barMaxWidth: 14, itemStyle: { color: col.pos }, data: strikes.map((k) => +agg.get(k).C.toFixed(1)) },
      { name: 'Puts', type: 'bar', stack: 'k', barMaxWidth: 14, itemStyle: { color: col.neg, borderRadius: [0, 4, 4, 0] }, data: strikes.map((k) => +agg.get(k).P.toFixed(1)),
        markLine: spot ? { silent: true, symbol: 'none', lineStyle: { color: col.ink, width: 1.5, type: 'solid' }, label: { formatter: `spot ${spot.toFixed(dg)}`, color: col.ink2 }, data: [{ yAxis: strikes.reduce((best, k, i) => (Math.abs(k - spot) < Math.abs(strikes[best] - spot) ? i : best), 0) }] } : undefined },
    ],
  });
  const top = d.rows.map((r) => ({ key: '', exp: r[0], k: r[1], cp: r[2], usd: r[3], n: r[4], cap: r[5] })).sort((a, b) => b.usd - a.usd).slice(0, 15);
  table('fx-top', $('#fx-top'), [
    { k: 'mk', h: 'Expiry', l: true, v: (r) => r.exp, f: (r) => fmtDate(r.exp, { weekday: 'short', day: 'numeric', month: 'short' }) },
    { k: 'k', h: 'Strike', v: (r) => r.k, f: (r) => r.k.toFixed(dg) },
    { k: 'cp', h: 'Type', l: true, v: (r) => r.cp, f: (r) => (r.cp === 'C' ? 'Call' : 'Put') },
    { k: 'usd', h: 'Notional', v: (r) => r.usd, f: (r) => fmtUSD(r.usd * 1e6) + (r.cap ? '+' : '') },
    { k: 'n', h: 'Trades', v: (r) => r.n, f: (r) => String(r.n) },
    { k: 'dist', h: 'vs spot', v: (r) => (spot ? Math.abs(r.k / spot - 1) : NaN), f: (r) => (spot ? fmtN((r.k / spot - 1) * 100, 2, true) + '%' : '–') },
  ], top, { sort: 'usd', dir: -1 });
}

/* ======================================================================= tab: Europe & Asia */
RENDER.sources = async (sec) => {
  sec.innerHTML = '<div class="loading">Loading…</div>';
  await ensureAll();
  if (!stillOn('sources', sec)) return;
  const ice = allMetrics().filter((r) => r.m.source === 'ice');
  const f = FLOWS || {};
  const sum = (a, n) => { const v = (a || []).slice(-n).filter(fin); return v.length ? v.reduce((s, x) => s + x, 0) : NaN; };
  const flowTile = (label, arr, unit = 1) => {
    if (!arr || !arr.length) return '';
    const w4 = sum(arr, 4) * unit, w13 = sum(arr, 13) * unit;
    const roll = []; for (let i = 3; i < arr.length; i++) { const v = arr.slice(i - 3, i + 1); if (v.every(fin)) roll.push(v.reduce((s, x) => s + x, 0)); }
    const pr = roll.length > 20 ? prank(Float64Array.from(roll), roll.length - 1, 0) : NaN;
    return tileHTML({ label, value: fmtUSD(arr[arr.length - 1] * unit, true), sub: `4w ${fmtUSD(w4, true)} · 13w ${fmtUSD(w13, true)}${fin(pr) ? ` · 4w pctl <b>${Math.round(pr)}</b>` : ''}`, spark: arr.slice(-52) });
  };
  const im = f.india_monthly, idd = f.india_daily;
  sec.innerHTML = `
    <div class="sheet-head"><h2>Europe &amp; Asia</h2><p>ICE Futures Europe publishes its own Commitments of Traders for Brent, gasoil and London softs. For Asia, the CFTC data stops at JPY, AUD and NZD, so this tab adds the foreign portfolio flows that drive Asian FX: Japan (JPX investor types), Taiwan (TWSE) and India (NSDL, NSE). Korea's KRX data needs a login and Reuters' Asian FX positioning poll has no data feed, so neither is included.</p></div>
    ${ice.length ? panel('ICE Futures Europe COT', { note: `${esc(roleLabel())}. These markets also appear in the Commodities tab.`, tools: '<button class="btn" data-copy="ice-main">Copy</button>', body: '<div class="tablewrap" id="ice-main"></div>', bodyClass: '' }) : ''}
    <div class="tiles">
      ${f.jpx_eq ? flowTile('Japan · foreigners in TSE Prime stocks, last week', f.jpx_eq.foreign_usd) : ''}
      ${f.twse ? flowTile('Taiwan · foreign investors in TWSE stocks, last week', f.twse.foreign_usd) : ''}
      ${im ? tileHTML({ label: 'India · FPI equity, latest month', value: fmtUSD(im.equity_usd_mn[im.equity_usd_mn.length - 1] * 1e6, true), sub: `${esc(im.months[im.months.length - 1])} · debt ${fmtUSD(im.debt_usd_mn[im.debt_usd_mn.length - 1] * 1e6, true)}${idd ? ` · last day ${fmtUSD(idd.fii_usd_mn[idd.fii_usd_mn.length - 1] * 1e6, true)} (${esc(idd.dates[idd.dates.length - 1])})` : ''}` }) : ''}
    </div>
    <div class="grid2">
      ${f.jpx_eq ? panel('Japan: weekly net buying of TSE Prime stocks', { note: 'USD at the week\'s USDJPY. Foreigners, domestic individuals and trust banks (pension proxy).', body: '<div class="chart" id="src-jpx"></div>' }) : panel('Japan', { body: '<div class="na">JPX data not available in this build.</div>' })}
      ${f.twse ? panel('Taiwan: weekly foreign net buying of TWSE stocks', { note: 'USD at the week\'s USDTWD', body: '<div class="chart" id="src-tw"></div>' }) : panel('Taiwan', { body: '<div class="na">TWSE data not available in this build.</div>' })}
    </div>
    ${im ? panel('India: monthly FPI net investment', { note: 'USD at the month\'s USDINR (NSDL, calendar year to date)', body: '<div class="chart short" id="src-in"></div>' }) : ''}`;
  if (ice.length) table('ice-main', $('#ice-main'), assetCols('Commodities'), ice, { sort: 'p52', dir: -1, onRow: openMarket });
  const col = chartColors();
  const bars = (el, labels, series) => mkChart(el, {
    grid: { left: 8, right: 16, top: series.length > 1 ? 34 : 14, bottom: 24, containLabel: true }, legend: series.length > 1 ? legendCfg(col) : undefined,
    xAxis: { type: 'category', data: labels, axisTick: { show: false }, axisLabel: { color: col.muted, fontSize: 10.5, hideOverlap: true }, axisLine: { lineStyle: { color: col.axis } } },
    yAxis: { type: 'value', axisLabel: { color: col.muted, fontSize: 11, formatter: (v) => fmtUSD(v) }, splitLine: { lineStyle: { color: col.grid } } },
    tooltip: { trigger: 'axis', formatter: (ps) => `<b>${esc(ps[0].axisValue)}</b><br>` + ps.map((p) => `${esc(p.seriesName)}: <b>${fmtUSD(p.value, true)}</b>`).join('<br>') },
    series: series.map((s) => Object.assign({ type: s.line ? 'line' : 'bar', barMaxWidth: 10, showSymbol: false }, s)),
  });
  if (f.jpx_eq && $('#src-jpx')) {
    const j = f.jpx_eq, n = Math.min(52, j.weeks.length), sl = (a) => (a || []).slice(-n);
    bars($('#src-jpx'), sl(j.weeks), [
      { name: 'Foreigners', data: sl(j.foreign_usd), itemStyle: { color: col.slot(1) } },
      { name: 'Individuals', data: sl(j.individuals_usd), itemStyle: { color: col.slot(2) } },
      { name: 'Trust banks', data: sl(j.trust_banks_usd), itemStyle: { color: col.slot(3) } },
    ]);
  }
  if (f.twse && $('#src-tw')) {
    const t = f.twse, n = Math.min(104, t.weeks.length);
    bars($('#src-tw'), t.weeks.slice(-n), [{ name: 'Foreign investors', data: t.foreign_usd.slice(-n), itemStyle: { color: col.slot(1) } }]);
  }
  if (im && $('#src-in')) {
    bars($('#src-in'), im.months, [
      { name: 'Equity', data: im.equity_usd_mn.map((v) => (fin(v) ? v * 1e6 : null)), itemStyle: { color: col.slot(1) } },
      { name: 'Debt', data: im.debt_usd_mn.map((v) => (fin(v) ? v * 1e6 : null)), itemStyle: { color: col.slot(2) } },
    ]);
  }
};

/* ======================================================================= tab: backtest */
RENDER.backtest = async (sec) => {
  sec.innerHTML = '<div class="loading">Loading…</div>';
  await ensureAll();
  if (!stillOn('backtest', sec)) return;
  const th = S.btTh || 90, lo = 100 - th, hj = S.btH === undefined ? 2 : S.btH, h = BT_H[hj];
  const rows = allMetrics().filter((r) => !r.na);
  const bt = rows.map((r) => ({ key: r.key, m: r.m, b: btMarket(r.key, r.cl, th, lo) })).filter((x) => x.b);
  // pooled contrarian edge by asset class, in weekly-vol units, weighted by episodes
  const pooled = {};
  for (const x of bt) {
    if (AGG_SKIP.has(x.key)) continue;
    const a = pooled[x.m.asset] || (pooled[x.m.asset] = { s: 0, w: 0, hits: 0, n: 0 });
    for (const [side, sign] of [['L', -1], ['S', 1]]) {
      const st = x.b[side][hj];
      if (!st || !fin(st.exSd)) continue;
      a.s += sign * st.exSd * st.eps; a.w += st.eps; a.hits += st.hit * st.n; a.n += st.n;
    }
  }
  const tiles = Object.entries(pooled).filter(([, a]) => a.w).map(([asset, a]) => tileHTML({
    label: `${asset} · contrarian edge, ${h}w`, value: `${fmtN(a.s / a.w, 2, true)}σ`,
    sub: `reversal rate ${Math.round((a.hits / a.n) * 100)}% · weighted by episodes`,
  })).join('');
  sec.innerHTML = `
    <div class="sheet-head"><h2>Backtest</h2><p>How futures prices behaved after past positioning extremes: ${esc(roleLabel())}, ${LB_LABEL[S.lb]} percentile window, crowded = at or beyond the ${th}th/${lo}th percentile. Excess = average forward return in the zone minus the market's average over all weeks. Positive "contrarian edge" means extremes tended to reverse. Prices are continuous front-month futures (not roll-adjusted), and overlapping weeks make t-stats generous even though they are scaled by the number of separate episodes.</p></div>
    <div class="chips">${seg('bt-thr', [[95, '95 / 5'], [90, '90 / 10'], [80, '80 / 20']], th)}${seg('bt-hz', [[0, '4 weeks'], [1, '8 weeks'], [2, '13 weeks']], hj)}</div>
    <div class="tiles">${tiles}</div>
    ${panel('By market', { note: `Forward ${h}-week returns. Reversal rate = share of cases where price moved against the crowd.`, tools: '<button class="btn" data-copy="bt-main">Copy</button>', body: '<div class="tablewrap" id="bt-main"></div>', bodyClass: '' })}
    ${panel('By theme', { note: `Theme basket return (legs in the theme's direction) after scores ≥ 75 or ≤ 25.`, body: '<div class="tablewrap" id="bt-th"></div>', bodyClass: '' })}`;
  onSeg('bt-thr', (v) => { S.btTh = +v; save(); render(); });
  onSeg('bt-hz', (v) => { S.btH = +v; save(); render(); });
  const side = (s, g) => [
    { k: g + 'eps', h: 'Episodes', g: s === 'L' ? 'Crowded long' : 'Crowded short', v: (x) => (x.b[s][hj] ? x.b[s][hj].eps : NaN), f: (x) => (x.b[s][hj] ? String(x.b[s][hj].eps) : '–') },
    { k: g + 'ex', h: 'Excess', g: s === 'L' ? 'Crowded long' : 'Crowded short', v: (x) => (x.b[s][hj] ? x.b[s][hj].ex : NaN), f: (x) => (x.b[s][hj] ? fmtChg(x.b[s][hj].ex) : '–') },
    { k: g + 'hit', h: 'Reversal', g: s === 'L' ? 'Crowded long' : 'Crowded short', v: (x) => (x.b[s][hj] ? x.b[s][hj].hit : NaN), f: (x) => (x.b[s][hj] ? Math.round(x.b[s][hj].hit * 100) + '%' : '–') },
    { k: g + 't', h: 't', g: s === 'L' ? 'Crowded long' : 'Crowded short', v: (x) => (x.b[s][hj] ? x.b[s][hj].t : NaN), f: (x) => (x.b[s][hj] ? fmtN(x.b[s][hj].t, 1, true) : '–') },
  ];
  table('bt-main', $('#bt-main'), [COL.mk,
    { k: 'now', h: 'Now', t: 'Current percentile', v: (x) => x.b.nowP, f: (x) => fmtP(x.b.nowP), c: (x) => 'heat ' + heatClass(x.b.nowP) },
    ...side('L', 'l'), ...side('S', 's'),
    { k: 'verdict', h: 'Verdict', l: true, v: (x) => btVerdict(x.b, hj).label, f: (x) => { const v = btVerdict(x.b, hj); return `<span class="pill ${v.k}">${esc(v.label)}</span>`; } },
  ], bt, { sort: 'now', dir: -1, onRow: openMarket });
  const trows = allThemes().map(themeData).map((d) => ({ key: d.th.key, d, r: btTheme(d, 75, 25, h) })).filter((x) => x.r);
  const tcol = (s, label) => [
    { k: s + 'eps', h: 'Episodes', g: label, v: (x) => (x.r[s] ? x.r[s].eps : NaN), f: (x) => (x.r[s] ? String(x.r[s].eps) : '–') },
    { k: s + 'ex', h: 'Excess', g: label, v: (x) => (x.r[s] ? x.r[s].ex : NaN), f: (x) => (x.r[s] ? fmtChg(x.r[s].ex) : '–') },
    { k: s + 'hit', h: 'Reversal', g: label, v: (x) => (x.r[s] ? x.r[s].hit : NaN), f: (x) => (x.r[s] ? Math.round(x.r[s].hit * 100) + '%' : '–') },
    { k: s + 't', h: 't', g: label, v: (x) => (x.r[s] ? x.r[s].t : NaN), f: (x) => (x.r[s] ? fmtN(x.r[s].t, 1, true) : '–') },
  ];
  table('bt-th', $('#bt-th'), [
    { k: 'mk', h: 'Theme', l: true, v: (x) => x.d.th.name, f: (x) => `<span class="nm">${esc(x.d.th.name)}</span>` },
    { k: 'now', h: 'Now', v: (x) => x.d.now, f: (x) => fmtP(x.d.now), c: (x) => 'heat ' + heatClass(x.d.now) },
    ...tcol('H', 'Score ≥ 75'), ...tcol('L', 'Score ≤ 25'),
  ], trows, { sort: 'now', dir: -1, onRow: (k) => { S.theme = k; save(); go('themes'); } });
};

/* ======================================================================= digest for the weekly written read */
/* Everything the weekly conclusions need, as plain JSON: the scheduled task
   loads the built site headlessly, calls buildDigest() and writes
   data/conclusions.json from it. */
async function buildDigest() {
  S.kind = 'fut'; S.role = 'spec'; S.lb = 156;
  await ensureAll();
  const r2 = (v, d = 1) => (fin(v) ? +v.toFixed(d) : null);
  const row = (r) => ({ key: r.key, name: r.m.name, asset: r.m.asset, net: r2(r.net, 0), d1: r2(r.d1, 0), usd_bn: r2(r.usd / 1e9, 2), flow_bn: r2(r.flow / 1e9, 2), pct_oi: r2(r.pct), P: Object.fromEntries(LBS.map((w) => [LB_LABEL[w], r2(r.P[w], 0)])), z: r2(r.z), flow_z: r2(r.fz), driver: r.driver && r.driver.label, px_1w: r2(r.r1 * 100), px_4w: r2(r.r4 * 100), px_since_tue: r2(r.rsr * 100) });
  const live = (role) => { S.role = role; return allMetrics().filter((r) => !r.na && !r.stale); };
  const spec = live('spec'), am = live('am'), nc = live('nc');
  S.role = 'spec';
  const agg = (keys, o) => { const a = aggStats(aggSeries(keys, o)); return { v: r2(a.v / 1e9, 2), d1: r2(a.d1 / 1e9, 2), d4: r2(a.d4 / 1e9, 2), pctl: r2(a.p, 0) }; };
  const themes = allThemes().map(themeData).map((d) => ({ key: d.th.key, name: d.th.name, score: r2(d.now, 0), d4: r2(d.d4, 0), d13: r2(d.d13, 0), status: d.status.label, mom_4w: r2(d.mom * 100), legs: d.legs.filter((l) => !l.na && l.score).map((l) => `${l.leg.s > 0 ? '+' : '-'}${l.leg.m}:${r2(l.score[d.t], 0)}`).join(' ') }));
  const S0 = Object.assign({}, S); S.corrSrc = 'returns'; S.corrOrient = true; S.corrLb = 156; S.corrCrowded = false;
  const w = washout();
  Object.assign(S, { corrSrc: S0.corrSrc, corrOrient: S0.corrOrient, corrLb: S0.corrLb, corrCrowded: S0.corrCrowded });
  return {
    report_date: META.latest, prices_to: DAILY.dates[DAILY.dates.length - 1],
    aggregates: {
      usd_vs_g10_lf_bn: agg(G10, { sign: -1, role: 'spec' }), usd_vs_g10_nc_bn: agg(G10, { sign: -1, role: 'nc' }),
      us_equity_lf_bn: agg(USEQ, { role: 'spec' }), us_equity_am_bn: agg(USEQ, { role: 'am' }),
      ust_dv01_am: agg(UST, { mode: 'dv01', role: 'am' }), ust_dv01_lf: agg(UST, { mode: 'dv01', role: 'spec' }),
      ...Object.fromEntries(SECTORS.map((s) => [`mm_${s.toLowerCase()}_bn`, agg(META.markets.filter((m) => m.group === s).map((m) => m.key), { role: 'spec' })])),
    },
    spec: spec.map(row), asset_managers: am.map(row), legacy_noncomm_fx: nc.filter((r) => r.m.asset === 'FX').map(row),
    themes, signals: dontMiss().slice(0, 40),
    nowcast: spec.map((r) => Object.assign({ key: r.key }, nowcastFor(r.key, r.cl) || {})).filter((x) => fin(x.dP)).map((x) => ({ key: x.key, pctl_tue: r2(x.pRep, 0), pctl_now: r2(x.pNow, 0), r2: r2(x.r2, 2), px_since_tue: r2(Math.expm1(x.rNow) * 100) })),
    cta: spec.map((r) => ctaNow(r.key)).filter(Boolean).map((c) => ({ key: c.key, pos: r2(c.pos * 100, 0), d1w: r2(c.d5 * 100, 0), flip: r2(c.flip, 6), dist_pct: r2(c.distPct * 100), dist_sd: r2(c.distSd) })),
    options: spec.map((r) => Object.assign({ key: r.key }, optFor(r.key, r.cl) || {})).filter((o) => fin(o.P) && o.share >= 10).map((o) => ({ key: o.key, delta: r2(o.od, 0), pctl: r2(o.P, 0), share: r2(o.share, 0) })),
    backtest_now: spec.filter((r) => r.p >= 90 || r.p <= 10).map((r) => { const b = btMarket(r.key, r.cl, 90, 10); const s = b && (r.p >= 90 ? b.L[2] : b.S[2]); return s ? { key: r.key, pctl: r2(r.p, 0), excess_13w_pct: r2(s.ex * 100), reversal_rate: r2(s.hit * 100, 0), t: r2(s.t), episodes: s.eps } : null; }).filter(Boolean),
    clusters: w.clusters.slice(0, 8).map((c) => ({ members: c.items.map((a) => `${w.vecs[a].sign > 0 ? 'L' : 'S'} ${w.vecs[a].r.key} ${r2(w.vecs[a].r.p, 0)}`).join(', '), avg_corr: r2(c.avgC, 2), crowding: r2(c.avgCrowd, 0) })),
    fx_expiries: Object.fromEntries(Object.keys(FXO.pairs || {}).slice(0, 8).map((p) => { const d = fxExpiries(p, 14); return [p, { spot: d.spot, top: d.rows.sort((a, b) => b[3] - a[3]).slice(0, 6) }]; })),
    flows: { japan_foreign_usd_last8w: ((FLOWS.jpx_eq || {}).foreign_usd || []).slice(-8), taiwan_foreign_usd_last8w: ((FLOWS.twse || {}).foreign_usd || []).slice(-8), india_monthly_equity_usd_mn: ((FLOWS.india_monthly || {}).equity_usd_mn || []).slice(-6) },
  };
}
window.buildDigest = buildDigest;

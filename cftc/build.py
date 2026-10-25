"""Fetch raw CFTC + price data into a store, and build the dashboard's JSON.

Store layout (kept on the ``data`` branch so weekly runs fetch incrementally):

    raw/{report}_{kind}.csv.gz     positions, trader counts, concentration
    raw/catalog_{report}_{kind}.csv  every market in the latest report
    raw/prices.csv.gz              contract price in USD per unit, by market
    raw/status.json                fetch diagnostics
    site/                          the built dashboard (index.html + data/)
"""
import datetime as dt
import json
import logging
import re
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

from . import config, prices, socrata

log = logging.getLogger(__name__)

DATE, CODE = socrata.DATE, socrata.CODE
KINDS = ("fut", "combo")

# category -> field stem; long/short fields are "{stem}_long" / "{stem}_short"
# with an optional "_all" suffix (the API is not consistent about it).
POS = {
    "tff": {"dealer": "dealer_positions", "am": "asset_mgr_positions", "lev": "lev_money_positions",
            "oth": "other_rept_positions", "nr": "nonrept_positions"},
    "disagg": {"pm": "prod_merc_positions", "sd": "swap_+positions", "mm": "m_money_positions",
               "oth": "other_rept_positions", "nr": "nonrept_positions"},
    "legacy": {"nc": "noncomm_positions", "cm": "comm_positions"},
}
TRADERS = {
    "tff": {"dealer": "traders_dealer", "am": "traders_asset_mgr", "lev": "traders_lev_money",
            "oth": "traders_other_rept"},
    "disagg": {"pm": "traders_prod_merc", "sd": "traders_swap", "mm": "traders_m_money",
               "oth": "traders_other_rept"},
    "legacy": {"nc": "traders_noncomm", "cm": "traders_comm"},
}
CONC = {"g4L": "conc_gross_le_4_tdr_long", "g4S": "conc_gross_le_4_tdr_short",
        "g8L": "conc_gross_le_8_tdr_long", "g8S": "conc_gross_le_8_tdr_short"}


# --------------------------------------------------------------------------- fetch

def _codes(report):
    if report == "legacy":
        return sorted({m.code for m in config.MARKETS})
    return sorted({m.code for m in config.MARKETS if m.report == report})


def fetch(store, full=False):
    raw = Path(store) / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    status_path = raw / "status.json"
    prev = json.loads(status_path.read_text()) if status_path.exists() else {}
    status = {"fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "cftc": {}}

    for (report, kind), ds in socrata.DATASETS.items():
        name = f"{report}_{kind}"
        codes = _codes(report)
        cols = [c for c in socrata.columns(ds) if socrata.wanted(c)]
        path = raw / f"{name}.csv.gz"
        old, since = None, socrata.START
        was = prev.get("cftc", {}).get(name, {})
        if path.exists() and not full and was.get("codes") == codes and was.get("columns") == cols:
            old = pd.read_csv(path, dtype={CODE: str}, parse_dates=[DATE], low_memory=False)
            since = (old[DATE].max() - pd.Timedelta(days=35)).strftime("%Y-%m-%d")
        log.info("%s (%s): %d codes, %d columns, since %s", name, ds, len(codes), len(cols), since)
        new = socrata.fetch(ds, codes, cols, since)
        if old is not None:
            new = pd.concat([old[old[DATE] < pd.Timestamp(since)], new], ignore_index=True)
        new = new.drop_duplicates([DATE, CODE], keep="last").sort_values([DATE, CODE])
        new.to_csv(path, index=False, compression="gzip")

        latest = socrata.latest_date(ds)
        socrata.catalog(ds, latest).sort_values("open_interest_all", ascending=False).to_csv(
            raw / f"catalog_{name}.csv", index=False)
        status["cftc"][name] = {
            "dataset": ds, "rows": int(len(new)), "latest": latest[:10],
            "missing_codes": sorted(set(codes) - set(new[CODE])), "codes": codes, "columns": cols,
        }
        log.info("  -> %d rows, latest %s, missing %s", len(new), latest[:10],
                 status["cftc"][name]["missing_codes"])

    px, sources = prices.market_prices(config.MARKETS)
    px.to_csv(raw / "prices.csv.gz", compression="gzip", float_format="%.8g")
    status["prices"] = sources
    status["missing_prices"] = [m.key for m in config.MARKETS if m.key not in sources]
    status_path.write_text(json.dumps(status, indent=1))
    return status


# --------------------------------------------------------------------------- build

def _find(cols, pattern):
    rx = re.compile(rf"^{pattern}(_all)?$")
    hits = [c for c in cols if rx.match(c)]
    return hits[0] if len(hits) == 1 else None


def _ints(values):
    return [None if v != v else int(round(v)) for v in values]


def _sig(values, digits=6):
    return [float(f"{v:.{digits}g}") if np.isfinite(v) else None for v in values]


def _first_valid(a):
    ok = np.flatnonzero(~np.isnan(a))
    return int(ok[0]) if len(ok) else None


def asof(series, idx, tol_days=6):
    """Value of ``series`` on or before each date in ``idx`` (NaN if stale)."""
    s = series.dropna().sort_index()
    out = np.full(len(idx), np.nan)
    if s.empty:
        return out
    pos = s.index.searchsorted(idx, side="right") - 1
    ok = pos >= 0
    p = np.clip(pos, 0, None)
    age = (idx - s.index[p]).days
    ok &= age <= tol_days
    out[ok] = s.values[p][ok]
    return out


def _frame(df, code, idx):
    sub = df[df[CODE] == code]
    if sub.empty:
        return None
    return sub.drop_duplicates(DATE, keep="last").set_index(DATE).reindex(idx)


def _side_arrays(frame, report, stems):
    L, S = {}, {}
    for cat, stem in stems.items():
        lc, sc = _find(frame.columns, f"{stem}_long"), _find(frame.columns, f"{stem}_short")
        if lc and sc:
            L[cat] = frame[lc].to_numpy(dtype="float64")
            S[cat] = frame[sc].to_numpy(dtype="float64")
        else:
            log.warning("%s: no long/short columns for %s (%s)", report, cat, stem)
    return L, S


def build(store, out):
    store, out = Path(store), Path(out)
    raw = store / "raw"
    status = json.loads((raw / "status.json").read_text())
    data = {}
    for (report, kind) in socrata.DATASETS:
        p = raw / f"{report}_{kind}.csv.gz"
        data[(report, kind)] = pd.read_csv(p, dtype={CODE: str}, parse_dates=[DATE], low_memory=False)

    dates = sorted(set().union(*(set(data[(r, "fut")][DATE]) for r in ("tff", "disagg", "legacy"))))
    idx = pd.DatetimeIndex([d for d in dates if d >= pd.Timestamp(socrata.START)])
    n = len(idx)
    px = pd.read_csv(raw / "prices.csv.gz", index_col=0, parse_dates=True)

    # contract price (USD per unit) on each report date, and USD value per contract
    cp = {k: asof(px[k], idx) for k in px.columns}
    npc = {}
    for m in config.MARKETS:
        if m.fixed:
            npc[m.key] = np.full(n, float(m.fixed))
        elif m.key in cp:
            v = cp[m.key] * m.mult
            if m.ccy:
                v = v * cp.get(m.ccy, np.full(n, np.nan))
            npc[m.key] = v

    files = {}
    snap_dates = {}
    detail = {m.key: {} for m in config.MARKETS}
    for kind in KINDS:
        recs = {}
        for m in config.MARKETS:
            fp = _frame(data[(m.report, kind)], m.code, idx)
            fl = _frame(data[("legacy", kind)], m.code, idx)
            if fp is None:
                log.warning("%s %s: not in %s report", m.key, kind, m.report)
                continue
            oi = fp["open_interest_all"].to_numpy(dtype="float64")
            o = _first_valid(oi)
            if o is None:
                continue
            last = int(np.flatnonzero(~np.isnan(oi))[-1])
            L, S = _side_arrays(fp, m.report, POS[m.report])
            if fl is not None:
                l2, s2 = _side_arrays(fl, "legacy", POS["legacy"])
                L.update(l2)
                S.update(s2)
            rec = {"o": o, "oi": _ints(oi[o:]),
                   "L": {c: _ints(v[o:]) for c, v in L.items()},
                   "S": {c: _ints(v[o:]) for c, v in S.items()}}

            # trader counts and concentration: latest two reports in the main
            # file (tables), full history in the per-market detail file
            tr, trh = {}, {}
            for rep, frame in ((m.report, fp), ("legacy", fl)):
                if frame is None:
                    continue
                for cat, stem in TRADERS[rep].items():
                    lc, sc = _find(frame.columns, f"{stem}_long"), _find(frame.columns, f"{stem}_short")
                    if lc and sc:
                        a, b = frame[lc].to_numpy(dtype="float64"), frame[sc].to_numpy(dtype="float64")
                        trh[cat] = [_ints(a[o:]), _ints(b[o:])]
                        tr[cat] = [_ints(a[max(last - 1, 0):last + 1]), _ints(b[max(last - 1, 0):last + 1])]
            conc = {}
            for k, stem in CONC.items():
                c = _find(fp.columns, stem)
                if c:
                    conc[k] = _sig(fp[c].to_numpy(dtype="float64")[o:], 4)
            rec["T"] = tr
            rec["C"] = {k: v[last - o] for k, v in conc.items()}
            recs[m.key] = rec
            detail[m.key][kind] = {"o": o, "T": trh, "C": conc}
            snap_dates[(m.key, kind)] = str(idx[last].date())
        files[kind] = recs

    latest = max(snap_dates.values()) if snap_dates else None
    stale = sorted({k for (k, kind), d in snap_dates.items() if kind == "fut" and d != latest})

    markets = []
    for m in config.MARKETS:
        d = m.to_dict()
        d["price_source"] = status.get("prices", {}).get(m.key)
        d["has"] = [k for k in KINDS if m.key in files[k]]
        d["last_report"] = snap_dates.get((m.key, "fut"))
        if m.key in px.columns:
            s = px[m.key].dropna()
            d["px_last"] = [str(s.index[-1].date()), float(f"{s.iloc[-1]:.6g}")] if len(s) else None
        markets.append(d)

    def packed(series_by_key, digits=6):
        res = {}
        for k, v in series_by_key.items():
            o = _first_valid(v)
            if o is not None:
                res[k] = {"o": o, "v": _sig(v[o:], digits)}
        return res

    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "fetched": status.get("fetched"),
        "latest": latest,
        "stale_markets": stale,
        "dates": [str(d.date()) for d in idx],
        "categories": config.CATEGORIES,
        "markets": markets,
        "themes": config.themes_json(),
        "cp": packed(cp),
        "npc": packed(npc),
        "datasets": {k: {"dataset": v["dataset"], "latest": v["latest"], "missing_codes": v["missing_codes"]}
                     for k, v in status.get("cftc", {}).items()},
        "missing_prices": status.get("missing_prices", []),
    }

    site = out
    (site / "data" / "detail").mkdir(parents=True, exist_ok=True)
    dump = lambda obj, p: p.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False))
    dump(meta, site / "data" / "meta.json")
    for kind in KINDS:
        dump(files[kind], site / "data" / f"{kind}.json")
    for key, d in detail.items():
        if d:
            dump(d, site / "data" / "detail" / f"{key}.json")
    web = Path(__file__).resolve().parent.parent / "web"
    for f in web.iterdir():
        if f.is_file():
            shutil.copy2(f, site / f.name)
    sizes = {p.name: p.stat().st_size for p in (site / "data").glob("*.json")}
    log.info("built %s: latest %s, %d markets, sizes %s", site, latest, len(files["fut"]), sizes)
    return meta

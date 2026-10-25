"""Non-CFTC sources: ICE Futures Europe COT, DTCC FX options, JPX investor
flows, Taiwan and India foreign portfolio flows.

Each fetcher caches into the store's raw/ directory and fails soft: a source
that is down leaves the rest of the pipeline untouched and is reported in
raw/extra_status.json.
"""
import datetime as dt
import io
import json
import logging
import re
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import socrata

log = logging.getLogger(__name__)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
_s = requests.Session()
_s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})


def _get(url, tries=3, timeout=90, **kw):
    for i in range(tries):
        try:
            r = _s.get(url, timeout=timeout, **kw)
            if r.status_code in (200, 404):
                return r
            log.warning("GET %s -> %s", url, r.status_code)
        except requests.RequestException as e:
            log.warning("GET %s failed: %s", url, e)
        time.sleep(2 * (i + 1))
    return None


def _num(s):
    return pd.to_numeric(s.astype(str).str.replace(",", "").str.replace("+", "").str.strip(), errors="coerce")


# --------------------------------------------------------------------------- ICE Futures Europe COT
ICE_URL = "https://www.ice.com/publicdocs/futures/COTHist{}.csv"


def fetch_ice(raw):
    d = raw / "ice"
    d.mkdir(exist_ok=True)
    this = dt.date.today().year
    frames = []
    for y in range(2011, this + 1):
        p = d / f"COTHist{y}.csv"
        if not p.exists() or y >= this - 1:
            r = _get(ICE_URL.format(y))
            if r is not None and r.status_code == 200 and len(r.content) > 1000:
                p.write_bytes(r.content)
        if p.exists():
            frames.append(pd.read_csv(p, dtype=str, encoding="utf-8-sig"))
    df = pd.concat(frames, ignore_index=True)
    df.columns = [c.strip().lower() for c in df.columns]
    name = df["market_and_exchange_names"].str.strip()
    out = pd.DataFrame({
        socrata.DATE: pd.to_datetime(df["as_of_date_form_mm/dd/yyyy"], format="%m/%d/%Y", errors="coerce"),
        socrata.CODE: name.str.replace(r"\s*-\s*ICE Futures Europe\s*$", "", regex=True)
                          .str.replace(r"\s+and Options\s*$", "", regex=True).str.strip(),
        "kind": np.where(name.str.contains("Futures and Options", case=False), "combo", "fut"),
        "market_and_exchange_names": name,
    })
    for c in df.columns:
        if c == "open_interest_all" or (socrata.wanted(c) and c not in out.columns and c != "market_and_exchange_names"):
            out[c] = _num(df[c])
    out = out.dropna(subset=[socrata.DATE]).drop_duplicates([socrata.DATE, socrata.CODE, "kind"], keep="last")
    out.to_csv(raw / "ice_cot.csv.gz", index=False, compression="gzip")
    return {"rows": int(len(out)), "latest": str(out[socrata.DATE].max().date()),
            "markets": sorted(out[socrata.CODE].unique().tolist())}


def load_ice(raw, kind):
    p = raw / "ice_cot.csv.gz"
    if not p.exists():
        return None
    df = pd.read_csv(p, parse_dates=[socrata.DATE], low_memory=False)
    return df[df["kind"] == kind].drop(columns=["kind"])


# --------------------------------------------------------------------------- DTCC FX options
DTCC_URL = "https://pddata.dtcc.com/ppd/api/report/cumulative/cftc/CFTC_CUMULATIVE_FOREX_{:%Y_%m_%d}.zip"
DTCC_COLS = {
    "Dissemination Identifier": "id", "Action type": "action", "Event timestamp": "event",
    "Expiration Date": "expiry", "Call amount": "call_amt", "Call currency": "call_ccy",
    "Put amount": "put_amt", "Put currency": "put_ccy", "Option Premium Amount": "prem",
    "Option Premium Currency": "prem_ccy", "Strike Price": "strike",
    "Strike price currency/currency pair": "pair", "UPI FISN": "fisn",
}


def _parse_dtcc(content, day):
    z = zipfile.ZipFile(io.BytesIO(content))
    with z.open(z.infolist()[0]) as f:
        df = pd.read_csv(f, dtype=str, usecols=lambda c: c in DTCC_COLS, low_memory=False)
    df = df.rename(columns=DTCC_COLS)
    df = df[df["fisn"].fillna("").str.startswith("NA/O Van") & (df["action"] == "NEWT")].copy()
    if df.empty:
        return df
    pair = df["pair"].fillna("").str.upper().str.replace(" ", "")
    df["base"], df["quote"] = pair.str[:3], pair.str[4:7]
    tok = df["fisn"].str.split()
    df["opt"] = tok.str[2].str.upper()     # CALL / PUT on the currency that follows
    df["on"] = tok.str[3].str.upper()
    # express each option as a call or put on the quoted pair
    same = df["on"] == df["base"]
    flip = df["on"] == df["quote"]
    df["cp"] = np.where(same, df["opt"].str[0], np.where(flip, np.where(df["opt"] == "CALL", "P", "C"), ""))
    for c in ("call_amt", "put_amt", "prem", "strike"):
        df[c + "_capped"] = df[c].fillna("").str.contains(r"\+") if c != "strike" else False
        df[c] = _num(df[c].fillna(""))
    base_amt = np.where(df["call_ccy"] == df["base"], df["call_amt"], np.where(df["put_ccy"] == df["base"], df["put_amt"], np.nan))
    usd = np.where(df["call_ccy"] == "USD", df["call_amt"], np.where(df["put_ccy"] == "USD", df["put_amt"], np.nan))
    out = pd.DataFrame({
        "id": df["id"], "day": day.isoformat(), "expiry": df["expiry"], "pair": df["base"] + df["quote"],
        "strike": df["strike"], "cp": df["cp"], "base_amt": base_amt, "usd": usd,
        "capped": df["call_amt_capped"] | df["put_amt_capped"],
        "prem_usd": np.where(df["prem_ccy"] == "USD", df["prem"], np.nan),
    })
    return out[(out["cp"] != "") & out["strike"].notna() & out["expiry"].notna()]


def fetch_fxopts(raw, backfill=70):
    p, st = raw / "fxopts.csv.gz", raw / "fxopts_days.json"
    done = set(json.loads(st.read_text())) if st.exists() else set()
    old = pd.read_csv(p, dtype={"id": str}) if p.exists() else None
    today = dt.date.today()
    days = [today - dt.timedelta(days=i) for i in range(1, backfill + 1)]
    frames, fetched = [], 0
    for d in sorted(x for x in days if x.weekday() < 5):
        if d.isoformat() in done:
            continue
        r = _get(DTCC_URL.format(d), timeout=120)
        if r is None:
            continue
        if r.status_code == 200 and r.content[:2] == b"PK":
            try:
                frames.append(_parse_dtcc(r.content, d))
                fetched += 1
            except Exception as e:  # noqa: BLE001
                log.warning("DTCC %s parse failed: %s", d, e)
                continue
        if r.status_code == 200 or d < today - dt.timedelta(days=4):
            done.add(d.isoformat())
    parts = [x for x in [old] + frames if x is not None and len(x)]
    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    if len(df):
        df = df.drop_duplicates("id", keep="last")
        df = df[pd.to_datetime(df["expiry"], errors="coerce") >= pd.Timestamp(today - dt.timedelta(days=7))]
        df.to_csv(p, index=False, compression="gzip")
    st.write_text(json.dumps(sorted(done)[-200:]))
    return {"rows": int(len(df)), "days_fetched": fetched, "days_known": len(done)}


# --------------------------------------------------------------------------- JPX investor-type flows
JPX = "https://www.jpx.co.jp"
JPX_EQ_PAGES = ["/english/markets/statistics-equities/investor-type/index.html"] + [
    f"/english/markets/statistics-equities/investor-type/00-00-archives-{i:02d}.html" for i in range(0, 3)]
JPX_DV_PAGES = ["/english/markets/statistics-derivatives/sector/index.html"]
# weekly xlsx (2026-) layout: TSE Prime value row, balance columns by investor group
JPX_EQ_COLS = {"foreign_inst": 21, "foreign_indiv": 25, "indiv_cash": 13, "indiv_margin": 17,
               "prop_cash": 5, "prop_margin": 9, "inv_trusts": 33, "business_cos": 37, "trust_banks": 53}


def _jpx_week_end(name):
    m = re.search(r"_(\d{8})_(\d{8})\.", name)
    return dt.datetime.strptime(m.group(2), "%Y%m%d").date() if m else None


def _parse_jpx_eq_xlsx(content):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
    for i, r in enumerate(rows):
        if r and len(r) > 2 and isinstance(r[1], str) and "Prime" in r[1]:
            val = rows[i + 1]
            return {k: float(val[c]) * 1000 for k, c in JPX_EQ_COLS.items() if c < len(val) and isinstance(val[c], (int, float))}
    return None


def fetch_jpx(raw):
    d = raw / "jpx"
    d.mkdir(exist_ok=True)
    links = set()
    for page in JPX_EQ_PAGES + JPX_DV_PAGES:
        r = _get(JPX + page)
        if r is not None and r.status_code == 200:
            links |= set(re.findall(r'href="([^"]+\.(?:xlsx|xls|csv|pdf))"', r.text))
    eq_path = d / "eq_weekly.csv"
    eq = pd.read_csv(eq_path) if eq_path.exists() else pd.DataFrame(columns=["week_end"])
    have = set(eq["week_end"].astype(str))
    rows, diag = [], {}
    for link in sorted(x for x in links if re.search(r"stock_1_w_\d{8}_\d{8}\.xlsx$", x)):
        we = _jpx_week_end(link)
        if we is None or str(we) in have:
            continue
        r = _get(JPX + link)
        if r is not None and r.status_code == 200:
            rec = _parse_jpx_eq_xlsx(r.content)
            if rec:
                rows.append({"week_end": str(we), **rec})
    if rows:
        eq = pd.concat([eq, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("week_end", keep="last")
        eq.sort_values("week_end").to_csv(eq_path, index=False)
    # derivatives investor type: keep the raw weekly CSVs (codes are mapped in the build)
    dv_path = d / "dv_weekly.csv"
    dv = pd.read_csv(dv_path, dtype=str) if dv_path.exists() else pd.DataFrame()
    dv_have = set(dv["file"]) if len(dv) else set()
    new = []
    for link in sorted(x for x in links if re.search(r"Tousi_DV_W_\d{8}_\d{8}\.csv$", x)):
        name = link.rsplit("/", 1)[-1]
        if name in dv_have:
            continue
        r = _get(JPX + link)
        if r is not None and r.status_code == 200:
            t = pd.read_csv(io.BytesIO(r.content), dtype=str, encoding="utf-8-sig")
            t.columns = ["product", "cycle", "ymw", "from", "to", "investor", "vv", "sales", "sales_bal", "purch", "purch_bal", "total"][:len(t.columns)]
            t["file"] = name
            new.append(t)
    if new:
        dv = pd.concat([dv] + new, ignore_index=True)
        dv.to_csv(dv_path, index=False)
    # product names: the PDF version has one page per product, in the CSV's product order
    pdfs = sorted(x for x in links if re.search(r"Tousi_DV_pdf_W_\d{8}_\d{8}\.pdf$", x))
    if pdfs and not (d / "dv_titles.json").exists():
        r = _get(JPX + pdfs[-1])
        if r is not None and r.status_code == 200:
            try:
                from pypdf import PdfReader
                titles = []
                for pg in PdfReader(io.BytesIO(r.content)).pages:
                    t = pg.extract_text() or ""
                    m = re.search(r"/\s*([A-Za-z][^\n]*?(?:Futures|Options)[^\n]*)", t)
                    titles.append(m.group(1).strip() if m else "")
                (d / "dv_titles.json").write_text(json.dumps(titles))
            except Exception as e:  # noqa: BLE001
                diag["pdf"] = repr(e)
    # older weekly workbooks (pre-2026 layout): backfill the equity flow history
    olds = sorted(x for x in links if re.search(r"stock_val_1_\d{6}\.xls$", x))
    old_rows, old_err = [], 0
    for link in olds:
        key = link.rsplit("/", 1)[-1]
        if key in set(eq.get("src", pd.Series(dtype=str)).astype(str)):
            continue
        r = _get(JPX + link)
        if r is None or r.status_code != 200:
            continue
        try:
            rec = _parse_jpx_eq_old(r.content)
        except Exception:  # noqa: BLE001
            rec = None
        if rec:
            rec["src"] = key
            old_rows.append(rec)
        else:
            old_err += 1
            if not (d / "sample_old.xls").exists():
                (d / "sample_old.xls").write_bytes(r.content)
    if old_rows:
        eq = pd.concat([eq, pd.DataFrame(old_rows)], ignore_index=True)
        eq = eq.sort_values("week_end", kind="stable").drop_duplicates("week_end", keep="first")
        eq.to_csv(eq_path, index=False)
    return {"eq_weeks": int(len(eq)), "dv_rows": int(len(dv)), "links": len(links),
            "old_xls_links": len(olds), "old_parsed": len(old_rows), "old_failed": old_err, **diag}


def _parse_jpx_eq_old(content):
    """Pre-2026 weekly TSE Prime value workbook: two week blocks side by side."""
    x = pd.read_excel(io.BytesIO(content), header=None, sheet_name=0)
    cell = lambda i, j: str(x.iat[i, j]) if i < x.shape[0] and j < x.shape[1] else ""
    # the "Balance" header row; its right-most column is the latest week
    hdr = [i for i in range(min(30, x.shape[0])) if any("Balance" in cell(i, j) for j in range(x.shape[1]))]
    if not hdr:
        return None
    bcol = max(j for j in range(x.shape[1]) if "Balance" in cell(hdr[0], j))
    title = " ".join(cell(i, 0) for i in range(min(8, x.shape[0])))
    m = re.search(r"(\d{4})/(\d{1,2})\s*week\s*\d+\s*\(\s*(\d{1,2})/(\d{1,2})\s*-\s*(\d{1,2})/(\d{1,2})", title)
    if not m:
        return None
    year, mon, m_end, d_end = int(m.group(1)), int(m.group(2)), int(m.group(5)), int(m.group(6))
    if mon == 12 and m_end == 1:
        year += 1
    week_end = dt.date(year, m_end, d_end)

    def balance(*labels):
        # the balance sits on the sales row when negative and the purchases row (the English label) when positive
        for i in range(x.shape[0]):
            if any(lab in cell(i, j) for lab in labels for j in range(3)):
                for k in (i, i - 1, i + 1):
                    v = pd.to_numeric(cell(k, bcol).replace(",", ""), errors="coerce")
                    if v == v:
                        return float(v) * 1000
        return np.nan
    return {"week_end": str(week_end), "foreign_inst": balance("Foreigners"), "foreign_indiv": 0.0,
            "indiv_cash": balance("Individuals"), "indiv_margin": 0.0, "inv_trusts": balance("Investment"),
            "trust_banks": balance("Trust Banks", "Trust BK"), "business_cos": balance("Business Cos")}


# --------------------------------------------------------------------------- Taiwan foreign flows
TWSE = "https://www.twse.com.tw/rwd/en/fund/BFI82U?type=week&weekDate={:%Y%m%d}&response=json"


def fetch_twse(raw, weeks=104):
    p = raw / "twse_weekly.csv"
    df = pd.read_csv(p, dtype={"week": str}) if p.exists() else pd.DataFrame(columns=["week", "foreign_twd"])
    have = set(df["week"])
    today = dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    rows, calls = [], 0
    for i in range(weeks, -1, -1):
        wk = monday - dt.timedelta(weeks=i)
        if str(wk) in have and i > 1:
            continue
        r = _get(TWSE.format(wk), timeout=30)
        calls += 1
        time.sleep(2.2)
        if r is None or r.status_code != 200:
            continue
        j = r.json()
        if j.get("stat") != "OK":
            continue
        for item in j.get("data", []):
            if "Foreign Investors" in item[0] and "Dealers" not in item[0].split("(")[0]:
                rows.append({"week": str(wk), "foreign_twd": float(item[3].replace(",", ""))})
                break
    if rows:
        df = pd.concat([df, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("week", keep="last")
        df.sort_values("week").to_csv(p, index=False)
    return {"weeks": int(len(df)), "calls": calls}


# --------------------------------------------------------------------------- India FPI flows
NSDL_YEAR = "https://www.fpi.nsdl.co.in/web/Reports/Yearwise.aspx?RptType=6"
NSE_FII = "https://www.nseindia.com/api/fiidiiTradeReact"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December"]


def fetch_india(raw):
    out = {}
    p = raw / "india_monthly.csv"
    r = _get(NSDL_YEAR)
    if r is not None and r.status_code == 200:
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "|", r.text))
        year = re.search(r"Calendar Year - (\d{4})", text)
        rows = []
        for mname in MONTHS:
            m = re.search(rf"\|\s*{mname}\s*\|([^A-Za-z]+)", text)
            if not m or not year:
                continue
            nums = [float(x.replace(",", "")) for x in re.findall(r"-?[\d,]+(?:\.\d+)?", m.group(1))]
            if len(nums) >= 4:
                rows.append({"month": f"{year.group(1)}-{MONTHS.index(mname) + 1:02d}", "equity_inr_cr": nums[0],
                             "debt_inr_cr": nums[1] + nums[2] + nums[3], "total_inr_cr": nums[-1]})
        if rows:
            old = pd.read_csv(p) if p.exists() else pd.DataFrame()
            df = pd.concat([old, pd.DataFrame(rows)], ignore_index=True).drop_duplicates("month", keep="last")
            df.sort_values("month").to_csv(p, index=False)
            out["months"] = int(len(df))
    # NSE provisional FII/FPI cash flows, latest day: accumulate
    pd_path = raw / "india_daily.csv"
    try:
        _s.get("https://www.nseindia.com/", timeout=30)
        r = _s.get(NSE_FII, timeout=30, headers={"Referer": "https://www.nseindia.com/"})
        if r.status_code == 200:
            for item in r.json():
                if "FII" in item.get("category", ""):
                    day = dt.datetime.strptime(item["date"], "%d-%b-%Y").date()
                    old = pd.read_csv(pd_path) if pd_path.exists() else pd.DataFrame()
                    new = pd.DataFrame([{"date": str(day), "fii_net_inr_cr": float(item["netValue"])}])
                    pd.concat([old, new], ignore_index=True).drop_duplicates("date", keep="last").to_csv(pd_path, index=False)
                    out["latest_day"] = str(day)
    except Exception as e:  # noqa: BLE001
        out["nse_error"] = repr(e)[:200]
    return out


# --------------------------------------------------------------------------- driver
def fetch_all(raw):
    raw = Path(raw)
    status = {"fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    for name, fn in (("ice", fetch_ice), ("fxopts", fetch_fxopts), ("jpx", fetch_jpx),
                     ("twse", fetch_twse), ("india", fetch_india)):
        t0 = time.time()
        try:
            status[name] = fn(raw)
        except Exception as e:  # noqa: BLE001 - one bad source must not stop the rest
            log.exception("%s failed", name)
            status[name] = {"error": repr(e)[:300]}
        status[name]["seconds"] = round(time.time() - t0, 1)
        log.info("extra %s: %s", name, status[name])
    (raw / "extra_status.json").write_text(json.dumps(status, indent=1))
    return status


# --------------------------------------------------------------------------- outputs for the dashboard
QUOTE_ORDER = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "NOK", "SEK", "CNH", "CNY", "JPY"]


def _std_pair(base, quote):
    """Market-convention pair name and whether the strike must be inverted."""
    if base in QUOTE_ORDER and quote in QUOTE_ORDER:
        return (base + quote, False) if QUOTE_ORDER.index(base) <= QUOTE_ORDER.index(quote) else (quote + base, True)
    if base not in QUOTE_ORDER and quote == "USD":
        return "USD" + base, True
    return base + quote, False


def _usd_per(ccy, spot_last):
    if ccy == "USD":
        return 1.0
    if f"{ccy}USD" in spot_last:
        return spot_last[f"{ccy}USD"]
    if f"USD{ccy}" in spot_last and spot_last[f"USD{ccy}"]:
        return 1.0 / spot_last[f"USD{ccy}"]
    return np.nan


def _cross(pair, spot_last):
    v = _usd_per(pair[:3], spot_last) / _usd_per(pair[3:], spot_last)
    return float(f"{v:.6g}") if v == v else None


def _asof_rate(spots, pair, dates):
    if pair not in spots:
        return np.full(len(dates), np.nan)
    s = spots[pair].dropna()
    idx = s.index.searchsorted(pd.to_datetime(dates), side="right") - 1
    return np.where(idx >= 0, s.values[np.clip(idx, 0, None)], np.nan)


def build_outputs(raw, data_dir):
    raw, data_dir = Path(raw), Path(data_dir)
    spots = pd.read_csv(raw / "spots.csv.gz", index_col=0, parse_dates=True) if (raw / "spots.csv.gz").exists() else pd.DataFrame()
    spot_last = {c: float(spots[c].dropna().iloc[-1]) for c in spots.columns if spots[c].notna().any()}
    today = pd.Timestamp(dt.date.today())
    status = json.loads((raw / "extra_status.json").read_text()) if (raw / "extra_status.json").exists() else {}

    # FX option expiries by strike (DTCC public dissemination, vanilla options)
    fx = {"asof": None, "pairs": {}}
    p = raw / "fxopts.csv.gz"
    if p.exists():
        df = pd.read_csv(p, dtype={"id": str})
        df["expiry"] = pd.to_datetime(df["expiry"], errors="coerce")
        df = df[(df["expiry"] >= today - pd.Timedelta(days=1)) & (df["expiry"] <= today + pd.Timedelta(days=45))].copy()
        std = [_std_pair(b, q) for b, q in zip(df["pair"].str[:3], df["pair"].str[3:6])]
        df["spair"] = [x[0] for x in std]
        inv = np.array([x[1] for x in std], dtype=bool)
        df.loc[inv, "strike"] = 1.0 / df.loc[inv, "strike"]
        df.loc[inv, "cp"] = df.loc[inv, "cp"].map({"C": "P", "P": "C"})
        # some trades quote the strike in market convention whatever the reported currency order:
        # keep whichever of K and 1/K sits nearer spot (crosses priced off the USD legs)
        ref = df["spair"].map(lambda sp: spot_last.get(sp) or _usd_per(sp[:3], spot_last) / _usd_per(sp[3:], spot_last))
        k = df["strike"].astype(float)
        ref = ref.fillna(np.exp(np.log(k).groupby(df["spair"]).transform("median")))  # no spot: the typical strike
        swap = (np.log(1.0 / k / ref).abs() < np.log(k / ref).abs()).fillna(False)
        df.loc[swap, "strike"] = 1.0 / k[swap]
        # base_amt is in the reported base currency, which inversion moved to the quote side
        per = df["pair"].str[:3].map(lambda c: _usd_per(c, spot_last))
        df["usd_n"] = df["usd"].fillna(df["base_amt"] * per)
        fx["asof"] = df["day"].max() if len(df) else None
        totals = df.groupby("spair")["usd_n"].sum().sort_values(ascending=False)
        for pair in [x for x in totals.index if totals[x] >= 5e8][:24]:
            g = df[df["spair"] == pair].groupby([df["expiry"].dt.strftime("%Y-%m-%d"), "strike", "cp"]).agg(
                usd=("usd_n", "sum"), n=("id", "count"), capped=("capped", "sum")).reset_index()
            g = g[g["usd"] > 0]
            fx["pairs"][pair] = {
                "spot": spot_last.get(pair, spot_last.get(pair.replace("CNY", "CNH"))) or _cross(pair, spot_last),
                "total": float(totals[pair]),
                "rows": [[r.expiry, float(f"{r.strike:.6g}"), r.cp, round(r.usd / 1e6, 1), int(r.n), int(r.capped)]
                         for r in g.itertuples()],
            }
    (data_dir / "fxopts.json").write_text(json.dumps(fx, separators=(",", ":")))

    # Foreign flows: Japan (JPX weekly), Taiwan (TWSE weekly), India (NSDL monthly, NSE daily)
    flows = {"status": {k: v for k, v in status.items() if k in ("jpx", "twse", "india")}}
    p = raw / "jpx" / "eq_weekly.csv"
    if p.exists():
        j = pd.read_csv(p).sort_values("week_end")
        usdjpy = _asof_rate(spots, "USDJPY", j["week_end"])
        fgn = j.get("foreign_inst", 0) + j.get("foreign_indiv", 0)
        flows["jpx_eq"] = {
            "weeks": j["week_end"].astype(str).tolist(),
            "foreign_usd": [None if v != v else round(v, 0) for v in (fgn / usdjpy).tolist()],
            "individuals_usd": [None if v != v else round(v, 0) for v in ((j.get("indiv_cash", 0) + j.get("indiv_margin", 0)) / usdjpy).tolist()],
            "trust_banks_usd": [None if v != v else round(v, 0) for v in (j.get("trust_banks", 0) / usdjpy).tolist()],
            "inv_trusts_usd": [None if v != v else round(v, 0) for v in (j.get("inv_trusts", 0) / usdjpy).tolist()],
        }
    p, tp = raw / "jpx" / "dv_weekly.csv", raw / "jpx" / "dv_titles.json"
    if p.exists() and tp.exists():
        d = pd.read_csv(p, dtype=str)
        titles = json.loads(tp.read_text())
        latest = sorted(d["file"].unique())[-1]
        order = list(dict.fromkeys(d.loc[d["file"] == latest, "product"]))
        names = {code: titles[i] for i, code in enumerate(order) if i < len(titles)}
        groups = {"Nikkei 225 futures": r"^Nikkei 225 (mini |Micro )?Futures", "TOPIX futures": r"^(mini-)?TOPIX (Micro )?Futures",
                  "JGB futures": r"JGB Futures"}
        who = {"60": "foreigners", "51": "individuals", "23": "trust_banks", "11": "proprietary"}
        d = d[d["vv"] == "2"].copy()      # 2 = value in yen
        for c in ("sales", "purch"):
            d[c] = pd.to_numeric(d[c], errors="coerce")
        d["net"] = d["purch"] - d["sales"]
        d["week_end"] = pd.to_datetime(d["to"], format="%Y%m%d", errors="coerce").dt.strftime("%Y-%m-%d")
        weeks = sorted(d["week_end"].dropna().unique())
        usdjpy = dict(zip(weeks, _asof_rate(spots, "USDJPY", weeks)))
        out = {"weeks": weeks, "products": {}, "titles": names}
        for g, rx in groups.items():
            codes = [c for c, t in names.items() if re.search(rx, t, re.I)]
            if not codes:
                continue
            sub = d[d["product"].isin(codes) & d["investor"].isin(who)]
            piv = sub.groupby(["investor", "week_end"])["net"].sum()
            out["products"][g] = {"codes": codes, **{who[i]: [None if (i, w) not in piv.index else round(float(piv[(i, w)]) / usdjpy[w], 0)
                                                            for w in weeks] for i in who}}
        flows["jpx_dv"] = out
    p = raw / "twse_weekly.csv"
    if p.exists():
        t = pd.read_csv(p).sort_values("week")
        usdtwd = _asof_rate(spots, "USDTWD", pd.to_datetime(t["week"]) + pd.Timedelta(days=4))
        flows["twse"] = {"weeks": t["week"].astype(str).tolist(),
                         "foreign_usd": [None if v != v else round(v, 0) for v in (t["foreign_twd"] / usdtwd).tolist()]}
    p = raw / "india_monthly.csv"
    if p.exists():
        m = pd.read_csv(p).sort_values("month")
        usdinr = _asof_rate(spots, "USDINR", pd.to_datetime(m["month"] + "-15"))
        conv = lambda col: [None if v != v else round(v, 1) for v in (m[col] * 10 / usdinr).tolist()]  # crore -> USD mn
        flows["india_monthly"] = {"months": m["month"].tolist(), "equity_usd_mn": conv("equity_inr_cr"),
                                  "debt_usd_mn": conv("debt_inr_cr"), "total_usd_mn": conv("total_inr_cr")}
    p = raw / "india_daily.csv"
    if p.exists():
        dd = pd.read_csv(p).sort_values("date")
        usdinr = _asof_rate(spots, "USDINR", dd["date"])
        flows["india_daily"] = {"dates": dd["date"].tolist(),
                                "fii_usd_mn": [None if v != v else round(v, 1) for v in (dd["fii_net_inr_cr"] * 10 / usdinr).tolist()]}
    (data_dir / "flows.json").write_text(json.dumps(flows, separators=(",", ":")))
    return {"fx_pairs": len(fx["pairs"]), "flows": [k for k in flows if k != "status"]}

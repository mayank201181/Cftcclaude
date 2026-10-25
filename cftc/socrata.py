"""Client for the CFTC Public Reporting Environment (Socrata SODA API)."""
import io
import logging
import time

import pandas as pd
import requests

BASE = "https://publicreporting.cftc.gov"

# (report, kind) -> dataset id. kind: "fut" = futures only, "combo" = futures
# plus delta-adjusted options.
DATASETS = {
    ("legacy", "fut"): "6dca-aqww",
    ("legacy", "combo"): "jun7-fc8e",
    ("disagg", "fut"): "72hh-3qpy",
    ("disagg", "combo"): "kh3c-gbw2",
    ("tff", "fut"): "gpe5-46if",
    ("tff", "combo"): "yw9f-hn96",
}

START = "2006-01-01"
PAGE = 50_000
DATE = "report_date_as_yyyy_mm_dd"
CODE = "cftc_contract_market_code"

log = logging.getLogger(__name__)

_session = requests.Session()
_session.headers["User-Agent"] = "cftc-positioning-dashboard/1.0 (+https://github.com/mayank201181/Cftcclaude)"

_ALWAYS = {DATE, CODE, "market_and_exchange_names", "contract_units", "open_interest_all"}


def _get(path, params=None, tries=6):
    url = BASE + path
    for i in range(tries):
        try:
            r = _session.get(url, params=params, timeout=180)
            if r.status_code == 200:
                return r
            log.warning("GET %s -> %s %s", r.url[:300], r.status_code, r.text[:300])
            if r.status_code in (400, 404):
                break
        except requests.RequestException as e:
            log.warning("GET %s failed: %s", url, e)
        time.sleep(min(60, 2 ** i))
    raise RuntimeError(f"CFTC API request failed: {url} {params}")


def columns(ds):
    """Field names of a dataset: view metadata first, sample rows as fallback."""
    try:
        meta = _get(f"/api/views/{ds}.json", tries=3).json()
        cols = [c["fieldName"] for c in meta.get("columns", []) if not c["fieldName"].startswith(":")]
        if cols:
            return cols
    except Exception as e:  # noqa: BLE001 - metadata is optional
        log.warning("metadata for %s unavailable (%s); sampling rows", ds, e)
    rows = _get(f"/resource/{ds}.json", {"$limit": 200, "$order": f"{DATE} DESC"}).json()
    return sorted({k for r in rows for k in r})


def wanted(col):
    """Position, trader-count and concentration fields for all crops/years."""
    if col in _ALWAYS:
        return True
    if col.startswith(("change_in_", "pct_of_")) or col.endswith(("_old", "_other")):
        return False
    return "positions" in col or "postions" in col or col.startswith(("traders_", "conc_"))


def latest_date(ds):
    r = _get(f"/resource/{ds}.json", {"$select": f"max({DATE}) AS d"})
    return r.json()[0]["d"]


def _csv(ds, params):
    text = _get(f"/resource/{ds}.csv", params).text
    return pd.read_csv(io.StringIO(text), dtype={CODE: str, "market_and_exchange_names": str,
                                                  "contract_units": str}, low_memory=False)


def catalog(ds, date):
    """Every market in the report on ``date`` with its open interest."""
    return _csv(ds, {"$select": f"market_and_exchange_names,{CODE},open_interest_all,contract_units",
                     "$where": f"{DATE} = '{date}'", "$limit": 10_000})


def fetch(ds, codes, cols, since=START):
    """Full history since ``since`` for the given contract codes."""
    quoted = ",".join(f"'{c}'" for c in sorted(codes))
    where = f"{CODE} in({quoted}) AND {DATE} >= '{since}T00:00:00.000'"
    frames, offset = [], 0
    while True:
        df = _csv(ds, {"$select": ",".join(cols), "$where": where,
                       "$order": f"{DATE},{CODE}", "$limit": PAGE, "$offset": offset})
        frames.append(df)
        log.info("  %s offset %d -> %d rows", ds, offset, len(df))
        if len(df) < PAGE:
            break
        offset += PAGE
    out = pd.concat(frames, ignore_index=True)
    out[DATE] = pd.to_datetime(out[DATE]).dt.normalize()
    return out

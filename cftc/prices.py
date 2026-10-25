"""Daily prices used to turn contracts into USD notional.

Yahoo Finance's chart endpoint is tried first, then yfinance (same data, its own
cookie handling), then FRED. Each market keeps the first source that is still
current; the source used is recorded so the dashboard can show it.
"""
import io
import logging
import time
from urllib.parse import quote

import pandas as pd
import requests

log = logging.getLogger(__name__)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
START = "2005-12-01"

_s = requests.Session()
_s.headers["User-Agent"] = UA


def _yahoo_chart(ticker):
    p1 = int(pd.Timestamp(START).timestamp())
    p2 = int(time.time()) + 86_400
    for host in ("query2", "query1"):
        for i in range(3):
            try:
                r = _s.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{quote(ticker, safe='')}",
                           params={"period1": p1, "period2": p2, "interval": "1d", "events": "history"},
                           timeout=30)
            except requests.RequestException as e:
                log.warning("yahoo %s: %s", ticker, e)
                time.sleep(2 ** i)
                continue
            if r.status_code == 200:
                res = (r.json().get("chart") or {}).get("result") or []
                if not res or not res[0].get("timestamp"):
                    return None
                res = res[0]
                off = res.get("meta", {}).get("gmtoffset", 0) or 0
                idx = pd.to_datetime([t + off for t in res["timestamp"]], unit="s").normalize()
                close = res["indicators"]["quote"][0].get("close")
                s = pd.Series(close, index=idx, dtype="float64").dropna()
                return s.groupby(level=0).last()
            if r.status_code == 404:
                return None
            log.warning("yahoo %s -> %s", ticker, r.status_code)
            time.sleep(3 * 2 ** i)
    return None


def _yfinance(ticker):
    try:
        import yfinance as yf
    except ImportError:
        return None
    try:
        df = yf.download(ticker, start=START, progress=False, auto_adjust=False, threads=False)
    except Exception as e:  # noqa: BLE001
        log.warning("yfinance %s: %s", ticker, e)
        return None
    if df is None or df.empty:
        return None
    close = df["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.iloc[:, 0]
    close.index = pd.to_datetime(close.index).tz_localize(None).normalize()
    return close.dropna().astype("float64")


def _fred(series):
    for i in range(3):
        try:
            r = _s.get("https://fred.stlouisfed.org/graph/fredgraph.csv", params={"id": series}, timeout=60)
            if r.status_code == 200 and "," in r.text[:200]:
                df = pd.read_csv(io.StringIO(r.text))
                s = pd.Series(pd.to_numeric(df.iloc[:, 1], errors="coerce").values,
                              index=pd.to_datetime(df.iloc[:, 0]))
                return s.dropna()
            log.warning("fred %s -> %s", series, r.status_code)
        except requests.RequestException as e:
            log.warning("fred %s: %s", series, e)
        time.sleep(2 ** i)
    return None


def _apply(s, transform):
    if transform == "inv":
        return 1.0 / s
    if transform == "c":
        return s / 100.0
    if transform == "100-":
        return 100.0 - s
    if transform.startswith("m"):
        return s * float(transform[1:])
    return s


def _fresh(s, max_age_days=10):
    return s is not None and len(s) > 20 and (pd.Timestamp.now().normalize() - s.index.max()).days <= max_age_days


def market_prices(markets):
    """Return (DataFrame date x market key of contract price in USD/unit, sources)."""
    cache, out, sources = {}, {}, {}
    for m in markets:
        candidates = [("yahoo", t) for t in m.px] + ([("fred", m.fred)] if m.fred else [])
        best, tried = None, []
        for src, spec in candidates:
            ticker, _, transform = spec.partition(":")
            ck = (src, ticker)
            if ck not in cache:
                s = _yahoo_chart(ticker) if src == "yahoo" else _fred(ticker)
                if src == "yahoo" and not _fresh(s):
                    alt = _yfinance(ticker)
                    if _fresh(alt):
                        s = alt
                cache[ck] = s
            s = cache[ck]
            tried.append(f"{src}:{ticker}=" + ("none" if s is None else f"{len(s)} obs to {s.index.max().date()}"))
            if _fresh(s):
                best = (src, ticker, _apply(s, transform or "x"))
                break
            if s is not None and len(s) > 20 and best is None:
                best = (src, ticker, _apply(s, transform or "x"))  # stale, keep looking
        if best is None:
            log.warning("no price for %s (%s)", m.key, "; ".join(tried))
            sources[m.key] = {"source": None, "tried": tried}
            continue
        out[m.key] = best[2]
        sources[m.key] = {"source": best[0], "ticker": best[1], "last": str(best[2].index.max().date())}
        if len(tried) > 1:
            sources[m.key]["tried"] = tried
        log.info("price %-8s %-6s %-10s last %s %.6g", m.key, best[0], best[1], sources[m.key]["last"],
                 best[2].iloc[-1])
    return pd.DataFrame(out).sort_index(), sources


def spot_prices(spots):
    """Daily spot FX closes for a {pair: yahoo_ticker} map."""
    out = {}
    for pair, ticker in spots.items():
        s = _yahoo_chart(ticker)
        if s is not None and len(s):
            out[pair] = s
        else:
            log.warning("no spot for %s (%s)", pair, ticker)
    return pd.DataFrame(out).sort_index()

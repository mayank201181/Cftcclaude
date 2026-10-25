"""Reachability probe for candidate data sources (run on GitHub Actions).

Writes a summary (status, type, size) and a truncated copy of each response to
OUT/, so new fetchers can be written against what the hosts really return.
Usage: python -m cftc.probe OUTDIR
"""
import datetime as dt
import io
import json
import re
import sys
import zipfile
from pathlib import Path

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9"}


def _days_back(n):
    d = dt.date.today()
    out = []
    while len(out) < n:
        d -= dt.timedelta(days=1)
        if d.weekday() < 5:
            out.append(d)
    return out


def candidates():
    days = _days_back(3)
    d0 = days[0]
    yr = dt.date.today().year
    jx = "https://www.jpx.co.jp/english/markets/statistics-"
    c = {
        "ice_cot_links": "https://www.ice.com/cot-report-links",
        "ice_hist_2019": "https://www.ice.com/publicdocs/futures/COTHist2019.csv",
        "jpx_eq_xlsx": jx + "equities/investor-type/vk0khi000002qxwh-att/stock_1_w_20261013_20261016.xlsx",
        "jpx_dv_csv": jx + "derivatives/sector/vk0khi000002qvt9-att/Tousi_DV_W_20261013_20261016.csv",
        "jpx_dv_tate": jx + "derivatives/sector/tvdivq00000020o8-att/Tategyoku_W_20260413_20260417.xlsx",
        "jpx_eq_archive": jx + "equities/investor-type/00-00-archives-01.html",
        "jpx_dv_archive": jx + "derivatives/sector/01-archives-02.html",
        "twse_day_1022": "https://www.twse.com.tw/rwd/en/fund/BFI82U?type=day&dayDate=20261022&response=json",
        "twse_week": "https://www.twse.com.tw/rwd/en/fund/BFI82U?type=week&weekDate=20261019&response=json",
        "twse_month": "https://www.twse.com.tw/rwd/en/fund/BFI82U?type=month&monthDate=20260901&response=json",
        "twse_zh_day": "https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=20261022&response=json",
        "nsdl_archive": "https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx",
        "nsdl_yearwise": "https://www.fpi.nsdl.co.in/web/Reports/Yearwise.aspx?RptType=6",
    }
    for t in ["BZ=F", "QS=F", "LGO=F", "C=F", "RC=F", "SW=F", "LCC=F", "KC=F", "CNH=X", "KRW=X", "TWD=X",
              "INR=X", "SGD=X", "EURUSD=X", "JPY=X", "^TWII", "^KS11", "^NSEI", "^TPX"]:
        c["yh_" + t] = f"https://query2.finance.yahoo.com/v8/finance/chart/{t}?range=5d&interval=1d"
    return c


def _summarize_zip(body):
    try:
        z = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile:
        return None
    info = {"members": [(i.filename, i.file_size) for i in z.infolist()][:20]}
    first = z.infolist()[0]
    with z.open(first) as f:
        head = f.read(200_000).decode("utf-8", "replace").splitlines()[:60]
    info["head"] = head
    return info


def main(out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers.update(HEADERS)
    summary = {"when": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "results": {}}
    for name, url in candidates().items():
        rec = {"url": url}
        try:
            r = s.get(url, timeout=60, allow_redirects=True)
            body = r.content
            rec.update(status=r.status_code, final_url=r.url, ctype=r.headers.get("content-type"), size=len(body))
            if url.endswith(".zip") and r.status_code == 200:
                rec["zip"] = _summarize_zip(body)
            elif url.endswith(".xlsx") and r.status_code == 200:
                (out / f"{name}.xlsx").write_bytes(body)
            else:
                text = body[:300_000].decode("utf-8", "replace")
                (out / f"{name}.txt").write_text(text)
                links = sorted(set(re.findall(r'href="([^"]+\.(?:csv|xls|xlsx|zip|pdf)[^"]*)"', text, re.I)))
                rec["links"] = links[:200]
                rec["head"] = text[:600]
        except Exception as e:  # noqa: BLE001
            rec["error"] = repr(e)[:300]
        summary["results"][name] = rec
        print(name, rec.get("status"), rec.get("size"), rec.get("error", ""))
    (out / "probe.json").write_text(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "probe")

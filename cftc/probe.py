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
    c = {
        # ICE Futures Europe COT (CFTC-style CSV) and ICE Endex MiFID report pages
        "ice_hist_cur": f"https://www.ice.com/publicdocs/futures/COTHist{yr}.csv",
        "ice_hist_prev": f"https://www.ice.com/publicdocs/futures/COTHist{yr - 1}.csv",
        "ice_hist_2011": "https://www.ice.com/publicdocs/futures/COTHist2011.csv",
        "ice_report_center": "https://www.ice.com/report-center/category/commitment-of-trader",
        "ice_report_122": "https://www.ice.com/marketdata/reports/122",
        "ice_report_234": "https://www.ice.com/marketdata/reports/234",
        # DTCC public dissemination (OTC FX options with strikes)
        **{f"dtcc_fx_{d:%Y%m%d}": f"https://pddata.dtcc.com/ppd/api/report/cumulative/cftc/CFTC_CUMULATIVE_FOREX_{d:%Y_%m_%d}.zip" for d in days[:2]},
        "dtcc_dashboard": "https://pddata.dtcc.com/ppd/cftcdashboard",
        "dtcc_s3_legacy": f"https://kgc0418-tdw-data-0.s3.amazonaws.com/cftc/eod/CFTC_CUMULATIVE_FOREX_{d0:%Y_%m_%d}.zip",
        # JPX investor-type statistics
        "jpx_eq_investor": "https://www.jpx.co.jp/english/markets/statistics-equities/investor-type/index.html",
        "jpx_deriv_investor": "https://www.jpx.co.jp/english/markets/statistics-derivatives/sector/index.html",
        # Asian foreign-flow proxies
        "twse_bfi82u": f"https://www.twse.com.tw/rwd/en/fund/BFI82U?type=day&dayDate={d0:%Y%m%d}&response=json",
        "twse_bfi82u_old": f"https://www.twse.com.tw/fund/BFI82U?response=json&dayDate={d0:%Y%m%d}&type=day",
        "nsdl_fpi_latest": "https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx",
        "nse_fiidii": "https://www.nseindia.com/api/fiidiiTradeReact",
        "krx_page": "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020302",
        # CME daily settlements / volume and open interest (JSON behind the website)
        "cme_settle_cl": f"https://www.cmegroup.com/CmeWS/mvc/Settlements/Futures/Settlements/425/FUT?strategy=DEFAULT&tradeDate={d0:%m/%d/%Y}&pageSize=500",
        "cme_vol_cl": f"https://www.cmegroup.com/CmeWS/mvc/Volume/Details/F/425/{d0:%Y%m%d}/P?tradeDate={d0:%Y%m%d}&pageSize=500",
        "cme_opt_eur": f"https://www.cmegroup.com/CmeWS/mvc/Settlements/Options/Settlements/58/OOF?strategy=DEFAULT&tradeDate={d0:%m/%d/%Y}&pageSize=500",
        "cme_bulletin_dir": "https://www.cmegroup.com/ftp/bulletin/",
    }
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

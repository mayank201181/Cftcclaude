# CFTC Positioning Monitor

A weekly cross-asset positioning dashboard built from the CFTC Commitments of
Traders reports: FX, rates, equity indices, commodities and crypto, with
percentiles, USD and DV01 sizing, theme baskets and a washout correlation map.

## What it shows

- **Tabs by asset class** (FX, Rates, Equities, Commodities, Crypto) with sortable
  tables: net contracts and weekly change, USD notional and weekly flow, net as % of
  open interest, percentiles over 1Y / 3Y / 5Y / 10Y / full history, 3Y z-score,
  flow z-score, which side moved (new longs, short covering, ...), gross longs and
  shorts, trader counts, top-4 concentration, price moves including since the
  Tuesday report date. Rates add DV01 and 10Y-note equivalents.
- **Global selectors**: futures only vs futures + delta-adjusted options; trader group
  (leveraged funds / managed money, asset managers, dealers, producers, other
  reportables, non-reportables, legacy non-commercials and commercials); percentile window.
- **Themes**: signed baskets (risk-on, havens, USD bull, FX carry, US exceptionalism,
  reflation, stagflation, goldilocks, duration, Fed cuts, steepener, debasement,
  China growth, Japan reflation, energy, metals, grains, softs, crypto, ...) scored
  0-100 by the average signed percentile of their legs, with status flags
  (crowded and working, crowded and offside, unwinding, washed out). Custom
  themes can be built in the page.
- **Washout map**: correlations of weekly positioning flows or position P&L,
  oriented to the side the crowd is on today and clustered, to show which
  crowded trades tend to be built and unwound together.
- **Charts**: per market, net position by trader group, price, net % OI with its
  percentile band, rolling percentile, gross longs and shorts, trader counts,
  open interest and concentration.

## How it works

```
GitHub Actions (weekly) ──> CFTC Socrata API  (TFF, Disaggregated, Legacy; futures and F+O)
                        └─> Yahoo Finance / FRED (prices for USD notional)
        │
        ├─ raw/   cached on the `data` branch, fetched incrementally
        └─ site/  index.html + app.js + data/*.json  ──> GitHub Pages / claude.ai artifact
```

- `cftc/config.py` - market universe (CFTC contract codes, contract sizes, price
  tickers, DV01s) and theme definitions. Add a market or theme here.
- `cftc/socrata.py` - CFTC Public Reporting API client.
- `cftc/prices.py` - price fetchers with fallbacks.
- `cftc/build.py` - fetch into the store, then build the dashboard JSON.
- `web/` - the page (`index.html` is the fragment published to claude.ai; the
  build wraps it into a standalone document) and `app.js` (all analytics).
- `.github/workflows/update.yml` - runs Fridays after the 15:30 ET release, with
  retries Saturday and Monday, and on every push to the pipeline or page.

## Run locally

```bash
pip install -r requirements.txt
python -m cftc all --store datastore          # fetch + build into datastore/site
python -m http.server -d datastore/site 8000  # open http://localhost:8000
```

The page loads its data with `fetch`, so serve it over HTTP rather than opening
the file directly.

## Caveats

- Positions are as of Tuesday and published Friday.
- Leveraged-fund shorts in Treasury futures mostly reflect the cash-futures basis
  trade; themes use asset managers for Treasury legs by default.
- CME FX futures are a small share of FX turnover, and Asian FX coverage is limited
  to JPY, AUD and NZD.
- ICE Brent and other non-US contracts are not in the CFTC data.
- Notional uses continuous front-month prices. MSCI EM/EAFE use ETF-scaled proxies,
  VIX notional uses spot VIX, and SOFR price moves use 100 minus the 13-week bill yield.

# CFTC Positioning Monitor

A weekly cross-asset positioning dashboard built from the CFTC Commitments of
Traders reports: FX, rates, equity indices, commodities and crypto, with
percentiles, USD and DV01 sizing, theme baskets and a washout correlation map.
It adds ICE Futures Europe positioning, a daily trend-follower model and nowcast,
the options layer, Asian foreign equity flows, backtests of positioning extremes
and a written weekly read.

## What it shows

- **Conclusions** (first tab): the weekly written read (headline, ranked points with
  trade expression, rough risk/reward and invalidation) above the computed
  don't-miss signals, moves since Tuesday, trend-follower flip levels, themes and
  what history says about today's extremes.
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
- **Nowcast & CTA**: a generic trend follower (1/3/6/12-month vol-scaled momentum)
  with the price where it flips and the flows a ±2σ week would cause, and an
  estimate of where each group's positioning stands at the latest close.
- **Options**: net options delta by trader group (futures + options minus futures
  only) and upcoming FX option expiries by strike from DTCC public trade reports.
- **Europe & Asia**: ICE Futures Europe COT (Brent, gasoil, Dubai, softs, feed
  wheat), foreign investor flows in Japan (cash and futures, JPX), Taiwan (TWSE)
  and India (NSDL/NSE).
- **Backtest**: forward 4/8/13-week returns after positioning extremes, by market
  and theme, with reversal rates and t-stats.
- **Charts**: per market, net position by trader group, price, net % OI with its
  percentile band, rolling percentile, gross longs and shorts, trader counts,
  open interest and concentration.

## How it works

```
GitHub Actions (weekly) ──> CFTC Socrata API  (TFF, Disaggregated, Legacy; futures and F+O)
                        ├─> ICE Futures Europe COT, DTCC FX options, JPX, TWSE, NSDL/NSE
                        └─> Yahoo Finance / FRED (daily prices and FX)
        │
        ├─ raw/   cached on the `data` branch, fetched incrementally
        └─ site/  index.html + app.js + data/*.json  ──> GitHub Pages / claude.ai artifact
```

- `cftc/config.py` - market universe (CFTC contract codes, contract sizes, price
  tickers, DV01s) and theme definitions. Add a market or theme here.
- `cftc/socrata.py` - CFTC Public Reporting API client.
- `cftc/prices.py` - price fetchers with fallbacks.
- `cftc/extra.py` - non-CFTC sources (ICE, DTCC, JPX, TWSE, NSDL/NSE).
- `cftc/build.py` - fetch into the store, then build the dashboard JSON.
- `web/` - the page (`index.html` is the fragment published to claude.ai; the
  build wraps it into a standalone document), `app.js` (core analytics and tabs)
  and `more.js` (conclusions, nowcast and trend model, options, Europe & Asia,
  backtest).
- `tools/digest.js` - loads the built site headlessly and writes the digest the
  weekly read is written from; `tools/CONCLUSIONS.md` - how to write it.
- `.github/workflows/update.yml` - runs Fridays after the 15:30 ET release, with
  retries Saturday and Monday, and on every push to the pipeline or page.

## Hosting and refresh

- The dashboard is published as a private claude.ai artifact. A scheduled Claude task
  republishes it from the `data` branch on Tuesday and Saturday mornings (SGT) and,
  for each new report, writes `data/conclusions.json` from the digest.
- The `data` branch is refreshed by the workflow's cron, which GitHub only runs from
  the default branch, so the workflow must be on `main`.
- For an optional public copy on GitHub Pages, set Pages to "GitHub Actions" in the
  repo settings and add the repository variable `PAGES_ENABLED=true`.

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
  to JPY, AUD and NZD; foreign equity flows stand in for CNH, KRW, TWD, INR and SGD.
  The Reuters Asian FX poll (no public feed), Korea's KRX (login) and ICE Endex TTF
  (no machine-readable COT) are not included.
- CME publishes no daily open interest by trader group and blocks automated access
  to its daily bulletin, so the nowcast runs on prices and the trend model.
- DTCC FX option data covers US-reportable trades only, caps large tickets and has
  no buyer or seller.
- Notional uses continuous front-month prices. MSCI EM/EAFE use ETF-scaled proxies,
  VIX notional uses spot VIX, and SOFR price moves use 100 minus the 13-week bill yield.

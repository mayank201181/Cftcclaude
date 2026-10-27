# Writing the weekly read

The Conclusions tab shows a written read when `data/conclusions.json` carries the
same `report_date` as `latest` in `data/meta.json`; otherwise it shows the computed
signals alone. A scheduled Claude session writes the file after each CFTC release.

## Inputs

```bash
node tools/digest.js datastore/site datastore/digest.json
```

`digest.json` holds everything the read needs, computed by the page itself
(`window.buildDigest()` in `web/more.js`), for leveraged funds / managed money,
futures only, 3-year percentiles unless stated:

| Field | What it is |
|---|---|
| `report_date`, `prices_to`, `schedule` | positions date (Tuesday on the weekly schedule; Monday or Wednesday once `schedule.kind` is `twice-weekly`), last daily close, release schedule seen in the data |
| `aggregates` | USD vs G10, US equities, UST DV01, commodity sectors: value, 1w and 4w change, percentile |
| `spec`, `asset_managers`, `legacy_noncomm_fx` | per market: net, weekly change, USD notional and flow, % OI, percentiles (1Y/3Y/5Y/10Y/All), z, flow z, driver, price moves (`px_1w` over the latest report week, `px_since_report` from the positions date to the last close) |
| `themes` | score 0-100, 4w and 13w change, status, legs with their scores |
| `signals` | the don't-miss list shown on the tab |
| `nowcast` | estimated percentile now (`pctl_now`) vs at the report (`pctl_report`), with R² |
| `cta` | trend-model position (%), 1w change, flip price, distance in % and weekly σ |
| `options` | options delta by market (futures-equivalents) and its percentile |
| `backtest_now` | for markets beyond the 90th/10th percentile: 13w excess return after past episodes, reversal rate, t, episodes |
| `clusters` | washout map clusters: members with side and percentile, average correlation, crowding |
| `fx_expiries` | DTCC FX option expiries in the next 14 days: largest strikes (expiry, strike, C/P, USD mn, trades, capped) |
| `flows` | Japan and Taiwan foreign equity flows (USD, weekly), India FPI equity (USD mn, monthly) |

## The reader

A macro PM with 20+ years in markets. The book: G10 and Asian FX options (barriers and
digitals too), G3 rates, energy curves, APAC equity derivatives. No primers, no
definitions. The end goal is the trading implication.

## Schema

```json
{
  "report_date": "YYYY-MM-DD",
  "written": "Sat 31 Oct 2026",
  "headline": "Two or three sentences: the answer first.",
  "points": [
    {
      "title": "One line that states the finding",
      "body": "Where the crowd is, what is priced, the pain trade, what history says, and where this read could be wrong.",
      "trade": {"expression": "direction and structure", "risk_reward": "rough, estimates marked", "invalidation": "a level or an event"},
      "markets": ["EUR", "NDX"]
    }
  ],
  "watch": ["shorter items worth a line each"],
  "verify": "what to check before trading"
}
```

`markets` uses the keys in `meta.json` `markets[].key`; each becomes a button that opens
the market's chart.

## Rules

- 4 to 6 points, ranked by what would hurt most to miss. Favour the reader's book.
- Every number comes from the digest. Do not add outside facts. The one exception is
  central bank meeting dates, marked "(verify)".
- Frame each point against consensus and positioning: where the crowd is, what has
  already moved, where the pain trade sits. Commit to a lean and say what would change it.
- Use the backtest honestly. If crowded shorts have kept winning (13w excess negative,
  t ≤ −1.5) or crowded longs have (t ≥ 1.5), do not recommend fading them outright;
  use defined-risk structures and say so.
- Leveraged funds are structurally short in Treasuries, BTC and some equity indices
  (basis and financing trades). High percentiles there mean "least short", not crowded.
- Treat the nowcast as an estimate (quote its R²) and DTCC strikes as where open
  interest sits, not who is long.
- History sits on a weekly grid (the latest report in each week). On the twice-weekly
  schedule a Monday report starts a new week and Friday's (Wednesday positions)
  replaces it, so "weekly change" means against the previous week's last report.
  Say which positions date you are reading.
- Mark every option price or risk/reward figure that is not from the data as an estimate.
- Plain words, short sentences, units on every number. No hype, no filler, no
  "not X but Y" framing. Name what you are unsure of in the verify line.

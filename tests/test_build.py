"""Offline tests: synthetic CFTC data through the build step."""
import json

import numpy as np
import pandas as pd
import pytest

from cftc import build, config, socrata

DATES = pd.date_range("2006-01-03", periods=60, freq="7D")

FIELDS = {
    "tff": ["dealer_positions_long_all", "dealer_positions_short_all", "asset_mgr_positions_long",
            "asset_mgr_positions_short", "lev_money_positions_long", "lev_money_positions_short",
            "other_rept_positions_long", "other_rept_positions_short", "nonrept_positions_long_all",
            "nonrept_positions_short_all", "traders_lev_money_long_all", "traders_lev_money_short_all",
            "traders_asset_mgr_long_all", "traders_asset_mgr_short_all", "conc_gross_le_4_tdr_long",
            "conc_gross_le_4_tdr_short", "conc_gross_le_8_tdr_long", "conc_gross_le_8_tdr_short"],
    "disagg": ["prod_merc_positions_long", "prod_merc_positions_short", "swap_positions_long_all",
               "swap__positions_short_all", "m_money_positions_long_all", "m_money_positions_short_all",
               "other_rept_positions_long", "other_rept_positions_short", "nonrept_positions_long_all",
               "nonrept_positions_short_all", "traders_m_money_long_all", "traders_m_money_short_all",
               "conc_gross_le_4_tdr_long", "conc_gross_le_4_tdr_short"],
    "legacy": ["noncomm_positions_long_all", "noncomm_positions_short_all", "comm_positions_long_all",
               "comm_positions_short_all", "nonrept_positions_long_all", "nonrept_positions_short_all",
               "traders_noncomm_long_all", "traders_noncomm_short_all"],
}


def _report(report, rng):
    rows = []
    codes = build._codes(report)
    for d in DATES:
        for c in codes:
            r = {socrata.DATE: d, socrata.CODE: c, "market_and_exchange_names": f"MKT {c}",
                 "open_interest_all": 100_000 + rng.integers(0, 5_000)}
            for f in FIELDS[report]:
                r[f] = rng.integers(0, 40_000) if "positions" in f else rng.integers(1, 60)
            rows.append(r)
    return pd.DataFrame(rows)


@pytest.fixture()
def store(tmp_path):
    rng = np.random.default_rng(0)
    raw = tmp_path / "raw"
    raw.mkdir()
    status = {"fetched": "2026-01-01T00:00:00+00:00", "cftc": {}, "prices": {}}
    for (report, kind), ds in socrata.DATASETS.items():
        _report(report, rng).to_csv(raw / f"{report}_{kind}.csv.gz", index=False, compression="gzip")
        status["cftc"][f"{report}_{kind}"] = {"dataset": ds, "latest": "2007-02-20", "missing_codes": []}
    days = pd.date_range("2005-12-01", DATES[-1], freq="B")
    px = pd.DataFrame({m.key: np.linspace(1, 2, len(days)) for m in config.MARKETS}, index=days)
    px.to_csv(raw / "prices.csv.gz", compression="gzip")
    (raw / "status.json").write_text(json.dumps(status))
    return tmp_path


def test_wanted_filters_crop_years_and_derived_fields():
    assert socrata.wanted("m_money_positions_long_all")
    assert socrata.wanted("noncomm_postions_spread_all")
    assert socrata.wanted("traders_lev_money_long_all")
    assert not socrata.wanted("m_money_positions_long_old")
    assert not socrata.wanted("pct_of_oi_lev_money_long")
    assert not socrata.wanted("change_in_lev_money_long")


def test_find_accepts_optional_all_suffix():
    cols = ["swap_positions_long_all", "swap__positions_short_all", "lev_money_positions_long"]
    assert build._find(cols, "swap_+positions_short") == "swap__positions_short_all"
    assert build._find(cols, "lev_money_positions_long") == "lev_money_positions_long"
    assert build._find(cols, "comm_positions_long") is None


def test_asof_uses_last_value_on_or_before_and_drops_stale():
    s = pd.Series([1.0, 2.0], index=pd.to_datetime(["2024-01-01", "2024-01-03"]))
    idx = pd.to_datetime(["2023-12-31", "2024-01-02", "2024-01-03", "2024-02-01"])
    out = build.asof(s, idx)
    assert np.isnan(out[0]) and out[1] == 1.0 and out[2] == 2.0 and np.isnan(out[3])


def test_build_writes_consistent_files(store):
    meta = build.build(store, store / "site")
    site = store / "site" / "data"
    fut = json.loads((site / "fut.json").read_text())
    combo = json.loads((site / "combo.json").read_text())
    assert set(fut) == {m.key for m in config.MARKETS} == set(combo)
    n = len(meta["dates"])
    for key, rec in fut.items():
        m = config.BY_KEY[key]
        cats = set(config.CATEGORIES[m.report]) | {"nc", "cm"}
        assert set(rec["L"]) == cats, key
        assert all(len(v) == n - rec["o"] for v in rec["L"].values())
        assert len(rec["oi"]) == n - rec["o"]
    # rates are 10Y-equivalent (DV01-weighted); yen Nikkei converts through JPY
    ten = meta["npc"]["UST10"]["v"][-1]
    assert meta["npc"]["SOFR3"]["v"][-1] == pytest.approx(ten * 25 / 64, rel=1e-4)
    assert meta["npc"]["NKYJ"]["v"][-1] == pytest.approx(2 * 500 * 2, rel=1e-3)
    assert (store / "site" / "index.html").exists()
    assert json.loads((site / "detail" / "EUR.json").read_text())["fut"]["T"]["lev"]

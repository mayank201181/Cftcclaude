"""Market universe, contract specs and positioning themes.

Every market is identified by its CFTC contract market code. Financial futures
(FX, rates, equity indices, VIX, crypto) come from the Traders in Financial
Futures (TFF) report; physical commodities from the Disaggregated report. The
Legacy report is pulled for every market as well (non-commercial / commercial).

Prices convert contracts into USD. Each ``px`` entry is ``TICKER:transform``
(Yahoo Finance symbol) and ``fred`` is a FRED series used as a last resort.
Transforms turn the quote into the contract's own price in USD per unit:
``x`` as quoted, ``inv`` reciprocal (USDJPY -> JPYUSD), ``c`` cents -> dollars.
USD value of one contract = price * ``mult`` (converted from ``ccy`` when the
contract is not USD-denominated), or ``fixed`` for STIR futures.
"""
from dataclasses import dataclass, asdict


@dataclass(frozen=True)
class Market:
    key: str
    name: str
    code: str
    asset: str            # FX | Rates | Equities | Commodities | Crypto
    group: str            # sub-sector shown in tables
    report: str           # "tff" or "disagg"
    mult: float = 1.0     # USD per contract per 1.0 of transformed price
    px: tuple = ()
    fred: str | None = None
    unit: str = ""        # contract size, human readable
    ccy: str | None = None    # non-USD contract currency (key of an FX market)
    fixed: float | None = None  # fixed USD notional per contract
    dv01: float | None = None   # approx. USD per basis point per contract
    disp: str = "x"       # display convention: x | inv (USD-base FX pairs) | cents
    note: str = ""

    def to_dict(self):
        d = asdict(self)
        d["px"] = list(self.px)
        return d


M = Market

MARKETS = [
    # ---------------------------------------------------------------- FX (CME / ICE)
    M("EUR", "Euro", "099741", "FX", "G10", "tff", 125_000, ("6E=F:x", "EURUSD=X:x"), "DEXUSEU:x", "EUR 125k"),
    M("JPY", "Japanese yen", "097741", "FX", "G10", "tff", 12_500_000, ("6J=F:x", "JPY=X:inv"), "DEXJPUS:inv", "JPY 12.5m", disp="inv"),
    M("GBP", "British pound", "096742", "FX", "G10", "tff", 62_500, ("6B=F:x", "GBPUSD=X:x"), "DEXUSUK:x", "GBP 62.5k"),
    M("CHF", "Swiss franc", "092741", "FX", "G10", "tff", 125_000, ("6S=F:x", "CHF=X:inv"), "DEXSZUS:inv", "CHF 125k", disp="inv"),
    M("CAD", "Canadian dollar", "090741", "FX", "G10", "tff", 100_000, ("6C=F:x", "CAD=X:inv"), "DEXCAUS:inv", "CAD 100k", disp="inv"),
    M("AUD", "Australian dollar", "232741", "FX", "G10", "tff", 100_000, ("6A=F:x", "AUDUSD=X:x"), "DEXUSAL:x", "AUD 100k"),
    M("NZD", "New Zealand dollar", "112741", "FX", "G10", "tff", 100_000, ("6N=F:x", "NZDUSD=X:x"), "DEXUSNZ:x", "NZD 100k"),
    M("MXN", "Mexican peso", "095741", "FX", "EM", "tff", 500_000, ("6M=F:x", "MXN=X:inv"), "DEXMXUS:inv", "MXN 500k", disp="inv"),
    M("BRL", "Brazilian real", "102741", "FX", "EM", "tff", 100_000, ("6L=F:x", "BRL=X:inv"), "DEXBZUS:inv", "BRL 100k", disp="inv"),
    M("ZAR", "South African rand", "122741", "FX", "EM", "tff", 500_000, ("ZAR=X:inv",), "DEXSFUS:inv", "ZAR 500k", disp="inv"),
    M("DXY", "US dollar index", "098662", "FX", "USD", "tff", 1_000, ("DX-Y.NYB:x", "DX=F:x"), None, "USD 1k x index",
      note="ICE contract; long = long USD"),
    # ---------------------------------------------------------------- Crypto
    M("BTC", "Bitcoin (CME)", "133741", "Crypto", "Bitcoin", "tff", 5, ("BTC-USD:x", "BTC=F:x"), "CBBTCUSD:x", "5 BTC"),
    M("MBT", "Micro bitcoin (CME)", "133742", "Crypto", "Bitcoin", "tff", 0.1, ("BTC-USD:x", "BTC=F:x"), "CBBTCUSD:x", "0.1 BTC"),
    M("ETH", "Ether (CME)", "146021", "Crypto", "Ether", "tff", 50, ("ETH-USD:x",), "CBETHUSD:x", "50 ETH"),
    M("MET", "Micro ether (CME)", "146022", "Crypto", "Ether", "tff", 0.1, ("ETH-USD:x",), "CBETHUSD:x", "0.1 ETH"),
    # ---------------------------------------------------------------- Rates (CBOT / CME)
    M("UST2", "2Y T-note", "042601", "Rates", "UST futures", "tff", 2_000, ("ZT=F:x",), None, "USD 200k face", dv01=39),
    M("UST5", "5Y T-note", "044601", "Rates", "UST futures", "tff", 1_000, ("ZF=F:x",), None, "USD 100k face", dv01=46),
    M("UST10", "10Y T-note", "043602", "Rates", "UST futures", "tff", 1_000, ("ZN=F:x",), None, "USD 100k face", dv01=64),
    M("ULTRA10", "Ultra 10Y T-note", "043607", "Rates", "UST futures", "tff", 1_000, ("TN=F:x",), None, "USD 100k face", dv01=91),
    M("BOND", "T-bond", "020601", "Rates", "UST futures", "tff", 1_000, ("ZB=F:x",), None, "USD 100k face", dv01=128),
    M("ULTRA", "Ultra T-bond", "020604", "Rates", "UST futures", "tff", 1_000, ("UB=F:x",), None, "USD 100k face", dv01=205),
    M("SOFR3", "3M SOFR", "134741", "Rates", "STIR", "tff", px=("SR3=F:x",), unit="USD 1m", fixed=1_000_000, dv01=25),
    M("FF", "30D fed funds", "045601", "Rates", "STIR", "tff", px=("ZQ=F:x",), unit="USD 5m", fixed=5_000_000, dv01=41.67),
    # ---------------------------------------------------------------- Equity indices
    M("SPX", "S&P 500 (consolidated)", "13874+", "Equities", "US", "tff", 50, ("ES=F:x", "^GSPC:x"), "SP500:x", "E-mini equivalents",
      note="Big + E-mini + Micro, in E-mini equivalents"),
    M("NDX", "Nasdaq-100 (consolidated)", "20974+", "Equities", "US", "tff", 20, ("NQ=F:x", "^NDX:x"), "NASDAQ100:x", "E-mini equivalents"),
    M("DJIA", "Dow (consolidated)", "12460+", "Equities", "US", "tff", 5, ("YM=F:x", "^DJI:x"), "DJIA:x", "E-mini equivalents"),
    M("RTY", "Russell 2000 E-mini", "239742", "Equities", "US", "tff", 50, ("RTY=F:x", "^RUT:x"), None, "USD 50 x index"),
    M("MID", "S&P 400 MidCap E-mini", "33874A", "Equities", "US", "tff", 100, ("EMD=F:x", "^MID:x"), None, "USD 100 x index"),
    M("NKY", "Nikkei 225 (USD)", "240741", "Equities", "Japan", "tff", 5, ("NKD=F:x", "^N225:x"), "NIKKEI225:x", "USD 5 x index"),
    M("NKYJ", "Nikkei 225 (JPY)", "240743", "Equities", "Japan", "tff", 500, ("NIY=F:x", "^N225:x"), "NIKKEI225:x", "JPY 500 x index", ccy="JPY"),
    M("MSEM", "MSCI EM", "244741", "Equities", "Global", "tff", 50, ("MME=F:x",), None, "USD 50 x index"),
    M("MSEAFE", "MSCI EAFE", "244042", "Equities", "Global", "tff", 50, ("MFS=F:x",), None, "USD 50 x index"),
    M("VIX", "VIX futures", "1170E1", "Equities", "Volatility", "tff", 1_000, ("^VIX:x",), "VIXCLS:x", "USD 1k x VIX",
      note="Notional uses spot VIX; futures usually trade above it"),
    # ---------------------------------------------------------------- Energy
    M("WTI", "WTI crude (NYMEX)", "067651", "Commodities", "Energy", "disagg", 1_000, ("CL=F:x",), "DCOILWTICO:x", "1,000 bbl"),
    M("BRENT", "Brent last day (NYMEX)", "06765T", "Commodities", "Energy", "disagg", 1_000, ("BZ=F:x",), "DCOILBRENTEU:x", "1,000 bbl",
      note="NYMEX financial Brent; ICE Brent is not in the CFTC report"),
    M("NATGAS", "Henry Hub nat gas (NYMEX)", "023651", "Commodities", "Energy", "disagg", 10_000, ("NG=F:x",), "DHHNGSP:x", "10,000 MMBtu"),
    M("RBOB", "RBOB gasoline", "111659", "Commodities", "Energy", "disagg", 42_000, ("RB=F:x",), None, "42,000 gal"),
    M("ULSD", "NY Harbor ULSD", "022651", "Commodities", "Energy", "disagg", 42_000, ("HO=F:x",), None, "42,000 gal"),
    # ---------------------------------------------------------------- Metals
    M("GOLD", "Gold", "088691", "Commodities", "Metals", "disagg", 100, ("GC=F:x",), None, "100 oz"),
    M("SILVER", "Silver", "084691", "Commodities", "Metals", "disagg", 5_000, ("SI=F:x",), None, "5,000 oz"),
    M("COPPER", "Copper (COMEX)", "085692", "Commodities", "Metals", "disagg", 25_000, ("HG=F:x",), None, "25,000 lb"),
    M("PLAT", "Platinum", "076651", "Commodities", "Metals", "disagg", 50, ("PL=F:x",), None, "50 oz"),
    M("PALL", "Palladium", "075651", "Commodities", "Metals", "disagg", 100, ("PA=F:x",), None, "100 oz"),
    # ---------------------------------------------------------------- Grains & oilseeds
    M("CORN", "Corn", "002602", "Commodities", "Grains", "disagg", 5_000, ("ZC=F:c",), None, "5,000 bu", disp="cents"),
    M("SOY", "Soybeans", "005602", "Commodities", "Grains", "disagg", 5_000, ("ZS=F:c",), None, "5,000 bu", disp="cents"),
    M("WHEAT", "Wheat (SRW)", "001602", "Commodities", "Grains", "disagg", 5_000, ("ZW=F:c",), None, "5,000 bu", disp="cents"),
    M("KCWHEAT", "Wheat (HRW)", "001612", "Commodities", "Grains", "disagg", 5_000, ("KE=F:c",), None, "5,000 bu", disp="cents"),
    M("SOYMEAL", "Soybean meal", "026603", "Commodities", "Grains", "disagg", 100, ("ZM=F:x",), None, "100 short tons"),
    M("SOYOIL", "Soybean oil", "007601", "Commodities", "Grains", "disagg", 60_000, ("ZL=F:c",), None, "60,000 lb", disp="cents"),
    # ---------------------------------------------------------------- Softs
    M("SUGAR", "Sugar No. 11", "080732", "Commodities", "Softs", "disagg", 112_000, ("SB=F:c",), None, "112,000 lb", disp="cents"),
    M("COFFEE", "Coffee C", "083731", "Commodities", "Softs", "disagg", 37_500, ("KC=F:c",), None, "37,500 lb", disp="cents"),
    M("COCOA", "Cocoa", "073732", "Commodities", "Softs", "disagg", 10, ("CC=F:x",), None, "10 t"),
    M("COTTON", "Cotton No. 2", "033661", "Commodities", "Softs", "disagg", 50_000, ("CT=F:c",), None, "50,000 lb", disp="cents"),
    M("OJ", "Orange juice", "040701", "Commodities", "Softs", "disagg", 15_000, ("OJ=F:c",), None, "15,000 lb", disp="cents"),
    # ---------------------------------------------------------------- Livestock
    M("LCATTLE", "Live cattle", "057642", "Commodities", "Livestock", "disagg", 40_000, ("LE=F:c",), None, "40,000 lb", disp="cents"),
    M("FCATTLE", "Feeder cattle", "061641", "Commodities", "Livestock", "disagg", 50_000, ("GF=F:c",), None, "50,000 lb", disp="cents"),
    M("HOGS", "Lean hogs", "054642", "Commodities", "Livestock", "disagg", 40_000, ("HE=F:c",), None, "40,000 lb", disp="cents"),
]

BY_KEY = {m.key: m for m in MARKETS}

# Trader categories. "nr" (non-reportable) is identical across the three reports.
CATEGORIES = {
    "tff": {
        "dealer": "Dealer / intermediary",
        "am": "Asset manager / institutional",
        "lev": "Leveraged funds",
        "oth": "Other reportables",
        "nr": "Non-reportable",
    },
    "disagg": {
        "pm": "Producer / merchant",
        "sd": "Swap dealers",
        "mm": "Managed money",
        "oth": "Other reportables",
        "nr": "Non-reportable",
    },
    "legacy": {
        "nc": "Non-commercial (legacy)",
        "cm": "Commercial (legacy)",
    },
}

# A theme is a signed basket: +1 means being long that market expresses the
# theme. An optional third element pins the trader category for that leg.
# UST futures legs default to asset managers because leveraged-fund positions
# there are dominated by the cash-futures basis trade.
THEMES = [
    dict(key="riskon", name="Risk-on beta",
         desc="Long equities, commodity/EM FX and copper; short yen and VIX.",
         legs=[("SPX", 1), ("NDX", 1), ("RTY", 1), ("MSEM", 1), ("AUD", 1), ("NZD", 1), ("MXN", 1),
               ("COPPER", 1), ("JPY", -1), ("VIX", -1)]),
    dict(key="havens", name="Safe havens",
         desc="Long yen, franc, gold, Treasuries and VIX.",
         legs=[("JPY", 1), ("CHF", 1), ("GOLD", 1), ("UST10", 1, "am"), ("BOND", 1, "am"), ("VIX", 1)]),
    dict(key="usd", name="USD bull",
         desc="Long DXY, short every IMM currency future.",
         legs=[("DXY", 1), ("EUR", -1), ("JPY", -1), ("GBP", -1), ("CHF", -1), ("CAD", -1), ("AUD", -1),
               ("NZD", -1), ("MXN", -1)]),
    dict(key="carry", name="FX carry",
         desc="Long high-yielders (MXN, BRL, ZAR, AUD, NZD) against JPY and CHF funders.",
         legs=[("MXN", 1), ("BRL", 1), ("ZAR", 1), ("AUD", 1), ("NZD", 1), ("JPY", -1), ("CHF", -1)]),
    dict(key="usexcept", name="US exceptionalism",
         desc="Long US equities and USD against Europe, EM and ex-US equities.",
         legs=[("SPX", 1), ("NDX", 1), ("DXY", 1), ("EUR", -1), ("MSEAFE", -1), ("MSEM", -1)]),
    dict(key="reflation", name="Reflation",
         desc="Long energy, copper and grains; short duration.",
         legs=[("WTI", 1), ("RBOB", 1), ("ULSD", 1), ("COPPER", 1), ("CORN", 1), ("SOY", 1), ("WHEAT", 1),
               ("UST10", -1, "am"), ("ULTRA", -1, "am"), ("BOND", -1, "am")]),
    dict(key="stagflation", name="Stagflation",
         desc="Long gold and crude; short equities and duration.",
         legs=[("GOLD", 1), ("WTI", 1), ("SPX", -1), ("NDX", -1), ("UST10", -1, "am"), ("ULTRA", -1, "am")]),
    dict(key="goldilocks", name="Goldilocks",
         desc="Long equities and duration, short VIX and USD.",
         legs=[("SPX", 1), ("NDX", 1), ("RTY", 1), ("UST5", 1, "am"), ("UST10", 1, "am"), ("VIX", -1), ("DXY", -1)]),
    dict(key="duration", name="Duration long",
         desc="Asset-manager duration across the UST curve plus leveraged-fund SOFR.",
         legs=[("UST2", 1, "am"), ("UST5", 1, "am"), ("UST10", 1, "am"), ("ULTRA10", 1, "am"),
               ("BOND", 1, "am"), ("ULTRA", 1, "am"), ("SOFR3", 1)]),
    dict(key="fedcuts", name="Fed cuts (STIR)",
         desc="Leveraged funds long SOFR, fed funds and 2Y futures.",
         legs=[("SOFR3", 1), ("FF", 1), ("UST2", 1)]),
    dict(key="steepener", name="Curve steepener",
         desc="Leveraged funds long the front end against the long end.",
         legs=[("UST2", 1), ("UST5", 1), ("BOND", -1), ("ULTRA", -1)]),
    dict(key="debasement", name="Debasement",
         desc="Long gold, silver, platinum and bitcoin; short USD.",
         legs=[("GOLD", 1), ("SILVER", 1), ("PLAT", 1), ("BTC", 1), ("DXY", -1)]),
    dict(key="china", name="China / Asia growth",
         desc="Long AUD, NZD, copper, soybeans and EM equities.",
         legs=[("AUD", 1), ("NZD", 1), ("COPPER", 1), ("SOY", 1), ("MSEM", 1)]),
    dict(key="japan", name="Japan reflation",
         desc="Long Nikkei, short yen.",
         legs=[("NKY", 1), ("NKYJ", 1), ("JPY", -1)]),
    dict(key="useq", name="US equity beta",
         desc="Long S&P, Nasdaq, Dow, Russell and MidCap futures.",
         legs=[("SPX", 1), ("NDX", 1), ("DJIA", 1), ("RTY", 1), ("MID", 1)]),
    dict(key="megacap", name="Mega-cap over small-cap",
         desc="Long Nasdaq-100, short Russell 2000.",
         legs=[("NDX", 1), ("RTY", -1)]),
    dict(key="shortvol", name="Short vol / complacency",
         desc="Short VIX futures, long S&P and Nasdaq.",
         legs=[("VIX", -1), ("SPX", 1), ("NDX", 1)]),
    dict(key="energy", name="Energy complex",
         desc="Long crude, products and natural gas.",
         legs=[("WTI", 1), ("BRENT", 1), ("RBOB", 1), ("ULSD", 1), ("NATGAS", 1)]),
    dict(key="precious", name="Precious metals",
         desc="Long gold, silver, platinum and palladium.",
         legs=[("GOLD", 1), ("SILVER", 1), ("PLAT", 1), ("PALL", 1)]),
    dict(key="grains", name="Grains & oilseeds",
         desc="Long corn, soybeans, wheat, meal and oil.",
         legs=[("CORN", 1), ("SOY", 1), ("WHEAT", 1), ("KCWHEAT", 1), ("SOYMEAL", 1), ("SOYOIL", 1)]),
    dict(key="softs", name="Softs",
         desc="Long sugar, coffee, cocoa and cotton.",
         legs=[("SUGAR", 1), ("COFFEE", 1), ("COCOA", 1), ("COTTON", 1)]),
    dict(key="crypto", name="Crypto",
         desc="Long CME bitcoin and ether futures.",
         legs=[("BTC", 1), ("MBT", 1), ("ETH", 1), ("MET", 1)]),
    dict(key="emfx", name="EM FX",
         desc="Long MXN, BRL and ZAR.",
         legs=[("MXN", 1), ("BRL", 1), ("ZAR", 1)]),
]


def themes_json():
    out = []
    for t in THEMES:
        legs = []
        for leg in t["legs"]:
            key, sign, *cat = leg
            assert key in BY_KEY, f"theme {t['key']} references unknown market {key}"
            legs.append({"m": key, "s": sign, **({"c": cat[0]} if cat else {})})
        out.append({"key": t["key"], "name": t["name"], "desc": t["desc"], "legs": legs})
    return out

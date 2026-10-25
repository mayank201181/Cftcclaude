"""Command line: python -m cftc {fetch,build,all} --store DIR [--out DIR] [--full]"""
import argparse
import logging
from pathlib import Path

from . import build


def main():
    ap = argparse.ArgumentParser(prog="python -m cftc")
    ap.add_argument("command", choices=["fetch", "build", "all"])
    ap.add_argument("--store", default="datastore", help="directory holding raw/ and site/")
    ap.add_argument("--out", default=None, help="site output directory (default: STORE/site)")
    ap.add_argument("--full", action="store_true", help="re-download full history")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    out = Path(args.out) if args.out else Path(args.store) / "site"
    if args.command in ("fetch", "all"):
        build.fetch(args.store, full=args.full)
    if args.command in ("build", "all"):
        build.build(args.store, out)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Zigchain 60k-ZIG alert scanner
-------------------------------
1. Parses your bot's docker log export for transfer lines that cross the
   60,000 ZIG threshold (the log already prints every event + its amount,
   so no chain calls are needed for this step).
2. For each qualifying tx hash, queries the LCD for the full tx to recover
   the FULL (untruncated) sender/recipient addresses.
3. Flags any transfer whose sender or recipient matches a known KuCoin or
   Bybit address (fill in EXCHANGE_ADDRESSES below).
4. Writes everything to an Excel file, one row per qualifying transfer.

USAGE:
    python3 scan_alerts.py sept_1_3_alerts.log --start 2026-09-01T00:00:00 --end 2026-09-04T00:00:00

Requires: pip install requests openpyxl --break-system-packages
"""

import re
import sys
import time
import json
import argparse
from datetime import datetime, timezone
import requests
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

LCD_URL = "https://zigchain-mainnet-lcd.zigscan.net"
ZIG_DENOM = "azig"
ZIG_DECIMALS = 18
ZIG_SCALE = 10 ** ZIG_DECIMALS
THRESHOLD_RAW = 60000 * ZIG_SCALE
AMOUNT_MATCH_TOLERANCE_RAW = ZIG_SCALE // 1000  # 0.001 ZIG

# -----------------------------------------------------------------------
# FILL THIS IN once you've confirmed labels on zigscan.org.
# Key = full bech32 address, value = exchange name.
# -----------------------------------------------------------------------
EXCHANGE_ADDRESSES = {
    "zig1455xp0cwksuug8jclrajrt3x0yzf6v08dpx0nf": "KuCoin",
    "zig1tm9hckgnq23f03f8ts00eazwdr2fw6x7yy5elk": "Bybit",
}

TX_HASH_RE = re.compile(r"\[TX RECEIVED\]\s+hash=([0-9A-Fa-f]{10,})")
TRANSFER_RE = re.compile(
    r"\|\s*(?P<ts>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+"
    r"(?P<src>zig1[0-9a-z]+)\.\.\.\s*->\s*(?P<dst>zig1[0-9a-z]+)\.\.\.\s+"
    r"(?P<amount>[\d,]+\.?\d*)\s+ZIG"
)


def zig_to_raw(amount):
    """Convert a non-negative human ZIG string to exact integer azig units."""
    normalized = amount.replace(",", "").strip()
    whole, dot, fraction = normalized.partition(".")
    if not whole.isdigit() or (dot and not fraction.isdigit()):
        raise ValueError(f"Invalid ZIG amount: {amount}")
    if len(fraction) > ZIG_DECIMALS:
        discarded = fraction[ZIG_DECIMALS:]
        if any(digit != "0" for digit in discarded):
            raise ValueError(f"ZIG amount exceeds {ZIG_DECIMALS} decimal places: {amount}")
        fraction = fraction[:ZIG_DECIMALS]
    return int(whole) * ZIG_SCALE + int(fraction.ljust(ZIG_DECIMALS, "0") or "0")


def raw_to_zig(raw_amount):
    """Format integer azig units as an exact human ZIG string."""
    whole, fraction = divmod(raw_amount, ZIG_SCALE)
    fraction_text = str(fraction).zfill(ZIG_DECIMALS).rstrip("0")
    return f"{whole}.{fraction_text}" if fraction_text else str(whole)


def parse_ts(ts_str):
    # Docker log timestamps use nanosecond precision (up to 9 fractional digits);
    # Python's %f only supports microseconds (6 digits), so truncate/pad as needed.
    if "." in ts_str:
        base, frac = ts_str.rstrip("Z").split(".")
        frac = (frac + "000000")[:6]
        ts_str = f"{base}.{frac}Z"
    else:
        ts_str = ts_str.rstrip("Z") + ".000000Z"
    return datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def find_qualifying_events(log_path, start_dt, end_dt):
    """Stream the log, return list of dicts for transfers >= threshold within window."""
    qualifying = []
    current_hash = None
    total_lines = 0
    with open(log_path, "r", errors="replace") as f:
        for line in f:
            total_lines += 1
            hmatch = TX_HASH_RE.search(line)
            if hmatch:
                current_hash = hmatch.group(1).upper()
                continue
            tmatch = TRANSFER_RE.search(line)
            if tmatch and current_hash:
                ts = parse_ts(tmatch.group("ts"))
                if not (start_dt <= ts < end_dt):
                    continue
                amount_raw = zig_to_raw(tmatch.group("amount"))
                if amount_raw >= THRESHOLD_RAW:
                    qualifying.append({
                        "hash": current_hash,
                        "timestamp": ts.isoformat(),
                        "src_trunc": tmatch.group("src"),
                        "dst_trunc": tmatch.group("dst"),
                        "amount_raw": amount_raw,
                        "amount_zig": raw_to_zig(amount_raw),
                    })
    print(f"Scanned {total_lines:,} log lines. Found {len(qualifying)} qualifying transfer(s) "
          f"across {len({q['hash'] for q in qualifying})} unique tx hash(es).")
    return qualifying


def fetch_tx_events(tx_hash, session, max_retries=3):
    """Query LCD for a tx, return list of (sender, recipient, amount_zig) from transfer events."""
    url = f"{LCD_URL}/cosmos/tx/v1beta1/txs/{tx_hash}"
    for attempt in range(max_retries):
        try:
            resp = session.get(url, timeout=15)
            if resp.status_code == 200:
                break
            time.sleep(1.5 * (attempt + 1))
        except requests.RequestException:
            time.sleep(1.5 * (attempt + 1))
    else:
        print(f"  WARNING: failed to fetch tx {tx_hash} after {max_retries} attempts")
        return []

    data = resp.json()
    events = []
    tx_events = data.get("tx_response", {}).get("events", [])
    for ev in tx_events:
        if ev.get("type") != "transfer":
            continue
        attrs = {a["key"]: a["value"] for a in ev.get("attributes", [])}
        sender = attrs.get("sender", "")
        recipient = attrs.get("recipient", "")
        amount_raw = attrs.get("amount", "")  # e.g. "60000000000000000000000azig" or "5000azig,3000uatom"
        for part in amount_raw.split(","):
            m = re.fullmatch(rf"(\d+){re.escape(ZIG_DENOM)}", part.strip())
            if m:
                raw_units = int(m.group(1))
                events.append({
                    "sender": sender,
                    "recipient": recipient,
                    "amount_raw": raw_units,
                    "amount_zig": raw_to_zig(raw_units),
                })
    return events


def match_full_addresses(qualifying, session):
    """For each unique hash, fetch full tx and match back to truncated log entries."""
    by_hash = {}
    for q in qualifying:
        by_hash.setdefault(q["hash"], []).append(q)

    results = []
    for i, (tx_hash, entries) in enumerate(by_hash.items(), 1):
        print(f"[{i}/{len(by_hash)}] Fetching {tx_hash} ...")
        events = fetch_tx_events(tx_hash, session)
        for entry in entries:
            match = None
            for ev in events:
                if (ev["sender"].startswith(entry["src_trunc"]) and
                        ev["recipient"].startswith(entry["dst_trunc"])):
                    match = ev
                    break
            if match is None:
                # fallback: match by closest amount if prefix match failed
                for ev in events:
                    if abs(ev["amount_raw"] - entry["amount_raw"]) < AMOUNT_MATCH_TOLERANCE_RAW:
                        match = ev
                        break
            results.append({
                "hash": tx_hash,
                "timestamp": entry["timestamp"],
                "amount_raw": entry["amount_raw"],
                "amount_zig": entry["amount_zig"],
                "source_full": match["sender"] if match else entry["src_trunc"] + "... (NOT RESOLVED)",
                "dest_full": match["recipient"] if match else entry["dst_trunc"] + "... (NOT RESOLVED)",
            })
        time.sleep(0.15)  # be polite to the LCD
    return results


def classify(addr):
    return EXCHANGE_ADDRESSES.get(addr)


def write_excel(results, out_path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Qualifying Transfers"
    headers = ["Tx Hash", "Timestamp (UTC)", "Amount (ZIG)", "Source Address",
               "Destination Address", "Exchange", "Direction", "Explorer Link"]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)

    highlight = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")

    for r in results:
        src_ex = classify(r["source_full"])
        dst_ex = classify(r["dest_full"])
        exchange = src_ex or dst_ex or ""
        direction = ""
        if dst_ex:
            direction = f"Deposit to {dst_ex}"
        elif src_ex:
            direction = f"Withdrawal from {src_ex}"
        link = f"https://zigscan.org/tx/{r['hash']}"
        # Store the human amount as an exact decimal string; Excel's numeric
        # cells cannot preserve all 18 fractional digits.
        row = [r["hash"], r["timestamp"], r["amount_zig"], r["source_full"],
               r["dest_full"], exchange, direction, link]
        ws.append(row)
        if exchange:
            for cell in ws[ws.max_row]:
                cell.fill = highlight

    for col, width in zip("ABCDEFGH", [68, 22, 14, 46, 46, 12, 24, 45]):
        ws.column_dimensions[col].width = width

    wb.save(out_path)
    print(f"Saved {len(results)} rows to {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log_path")
    ap.add_argument("--start", required=True, help="UTC start, e.g. 2026-09-01T00:00:00")
    ap.add_argument("--end", required=True, help="UTC end, e.g. 2026-09-04T00:00:00")
    ap.add_argument("--out", default="zig_alerts_report.xlsx")
    args = ap.parse_args()

    start_dt = datetime.strptime(args.start, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    end_dt = datetime.strptime(args.end, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)

    qualifying = find_qualifying_events(args.log_path, start_dt, end_dt)
    if not qualifying:
        print("No qualifying transfers found in this window.")
        return

    session = requests.Session()
    results = match_full_addresses(qualifying, session)
    write_excel(results, args.out)


if __name__ == "__main__":
    main()

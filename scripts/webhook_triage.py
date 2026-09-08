#!/usr/bin/env python3
"""Triage a folder of saved Shopify webhook JSON files.

Usage: python3 webhook_triage.py /path/to/webhook/folder [--move-skippable /path/to/parked]

Prints: count per topic, age of oldest/newest file, and how many
orders/updated files are "tracking only" (closed + fulfilled + paid,
updated well after close, no refund after close). Those are safe to
park and process last.
"""
import json
import os
import sys
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

folder = sys.argv[1]
park = None
if "--move-skippable" in sys.argv:
    park = sys.argv[sys.argv.index("--move-skippable") + 1]
    os.makedirs(park, exist_ok=True)


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def guess_topic(d):
    # Common wrapper shapes: {"topic": ..., "payload": ...} or headers saved alongside
    for k in ("topic", "X-Shopify-Topic", "x-shopify-topic", "event"):
        if isinstance(d, dict) and k in d:
            return d[k]
    hdrs = d.get("headers") if isinstance(d, dict) else None
    if isinstance(hdrs, dict):
        for k, v in hdrs.items():
            if k.lower() == "x-shopify-topic":
                return v
    p = d.get("payload", d) if isinstance(d, dict) else {}
    if not isinstance(p, dict):
        return "unknown"
    if "line_items" in p and "order_number" in p:
        return "orders/?"
    if "tracking_number" in p or "tracking_numbers" in p:
        return "fulfillments/?"
    if "inventory_item_id" in p and "available" in p:
        return "inventory_levels/?"
    if "orders_count" in p or ("email" in p and "addresses" in p):
        return "customers/?"
    if "variants" in p and "product_type" in p:
        return "products/?"
    return "unknown"


def tracking_only(p):
    """Heuristic: fulfilled, closed, paid order touched long after close with no later refund."""
    if p.get("fulfillment_status") != "fulfilled":
        return False
    if p.get("financial_status") not in ("paid", "partially_refunded", "refunded"):
        return False
    closed = parse_ts(p.get("closed_at"))
    updated = parse_ts(p.get("updated_at"))
    if not closed or not updated:
        return False
    if updated - closed < timedelta(minutes=5):
        return False
    for r in p.get("refunds") or []:
        rt = parse_ts(r.get("created_at"))
        if rt and rt > closed:
            return False
    return True


topics = Counter()
skippable = Counter()
oldest = defaultdict(lambda: None)
newest = defaultdict(lambda: None)
bad = 0
moved = 0

for name in os.listdir(folder):
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        continue
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception:
        bad += 1
        continue
    topic = guess_topic(d)
    topics[topic] += 1
    mtime = datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc)
    if oldest[topic] is None or mtime < oldest[topic]:
        oldest[topic] = mtime
    if newest[topic] is None or mtime > newest[topic]:
        newest[topic] = mtime
    p = d.get("payload", d) if isinstance(d, dict) else {}
    if topic.startswith("orders") and isinstance(p, dict) and tracking_only(p):
        skippable[topic] += 1
        if park:
            shutil.move(path, os.path.join(park, name))
            moved += 1

total = sum(topics.values())
print(f"\nTotal files: {total}   unreadable: {bad}\n")
print(f"{'topic':28} {'count':>6} {'tracking-only':>14}  oldest (UTC)         newest (UTC)")
for t, c in topics.most_common():
    o = oldest[t].strftime('%m-%d %H:%M') if oldest[t] else '-'
    n = newest[t].strftime('%m-%d %H:%M') if newest[t] else '-'
    print(f"{t:28} {c:6} {skippable.get(t, 0):14}  {o:20} {n}")
if park:
    print(f"\nMoved {moved} tracking-only order files to {park}")

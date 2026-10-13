#!/usr/bin/env python3
"""Markdown summary of an alternating run: per scene, medians of base and head, ratio, spread.

    python3 perf/bench/summarize.py <timing.jsonl> <base-variant> <head-variant> [alloc.jsonl]
"""
import json, statistics as st, sys

rows = [json.loads(l) for l in open(sys.argv[1])]
base, head = sys.argv[2], sys.argv[3]
alloc = {}
if len(sys.argv) > 4:
    for l in open(sys.argv[4]):
        r = json.loads(l)
        alloc[(r["variant"], r["scene"])] = r["allocBytesPerStep"] / r["bodies"]
scenes = list(dict.fromkeys(r["scene"] for r in rows))
print(f"| scene | copy-out {base} → {head} | × | step {base} → {head} | events | whole tick {base} → {head} | × | tick spread {head} | alloc B/body/step ({head}) | checksums |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
for s in scenes:
    b = [r for r in rows if r["scene"] == s and r["variant"] == base]
    h = [r for r in rows if r["scene"] == s and r["variant"] == head]
    m = lambda rs, k: st.median(r[k] for r in rs)
    sums = sorted({r["checksum"] for r in b + h})
    ht = [r["tickNs"] for r in h]
    a = alloc.get((head, s))
    print(
        f"| {s} | {m(b,'poseNs'):.0f} → {m(h,'poseNs'):.0f} | {m(b,'poseNs')/m(h,'poseNs'):.1f}× "
        f"| {m(b,'stepNs'):.0f} → {m(h,'stepNs'):.0f} | {m(b,'eventsNs'):.0f} → {m(h,'eventsNs'):.0f} "
        f"| {m(b,'tickNs'):.0f} → {m(h,'tickNs'):.0f} | **{m(b,'tickNs')/m(h,'tickNs'):.1f}×** "
        f"| {(max(ht)/min(ht)-1)*100:.0f}% | {'' if a is None else f'{a:.1f}'} | {' '.join(sums)}{' (same)' if len(sums)==1 else ' DIFFER'} |"
    )

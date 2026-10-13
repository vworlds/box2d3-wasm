#!/usr/bin/env python3
"""Top allocation sites of a BENCH_HEAP_SAMPLE profile, bytes per measured step.

    python3 perf/bench/heap-sites.py <profile.json> <steps> [depth]
"""
import collections, json, sys

p = json.load(open(sys.argv[1]))
steps = int(sys.argv[2])
depth = int(sys.argv[3]) if len(sys.argv) > 3 else 3
agg = collections.Counter()

def walk(n, stack):
    f = n["callFrame"]
    st = stack + [f"{f['functionName'] or '(anon)'} {f['url'].split('/')[-1]}:{f['lineNumber'] + 1}"]
    if n.get("selfSize", 0):
        agg[" <- ".join(reversed(st[-depth:]))] += n["selfSize"]
    for c in n.get("children", []):
        walk(c, st)

walk(p["head"], [])
total = sum(agg.values())
print(f"total sampled {total / steps:.0f} B/step")
for k, v in agg.most_common(15):
    print(f"{v / total * 100:5.1f}% {v / steps:9.0f} B/step  {k}")

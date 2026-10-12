# QuoxBrain held-out comparative eval

Generated 2026-10-06T18:22:07.937Z. Verdict: **PASS**.

Held-out set: 19 paraphrases kept of 23 loaded (4 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.105 | 0.579 | 0.632 | +0.526 |
| nDCG@10 | 0.089 | 0.510 | 0.461 | +0.372 |
| MRR | 0.069 | 0.487 | 0.404 | +0.335 |
| abstention precision | 0.500 | 1.000 | 1.000 | +0.500 |
| abstention recall | 0.167 | 0.833 | 0.833 | +0.667 |

Retrieval paths seen: hybrid arm {"hybrid":25}, fts arm {"fts":25}, dense arm {"dense":25}.

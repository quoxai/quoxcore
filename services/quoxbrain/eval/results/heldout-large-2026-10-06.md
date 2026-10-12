# QuoxBrain held-out comparative eval

Generated 2026-10-06T22:13:36.136Z. Verdict: **PASS**.

Held-out set: 19 paraphrases kept of 23 loaded (4 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.105 | 0.737 | 0.737 | +0.632 |
| nDCG@10 | 0.089 | 0.633 | 0.553 | +0.464 |
| MRR | 0.069 | 0.596 | 0.493 | +0.424 |
| abstention precision | 0.500 | 1.000 | 1.000 | +0.500 |
| abstention recall | 0.167 | 0.833 | 0.833 | +0.667 |

Retrieval paths seen: hybrid arm {"hybrid":25}, fts arm {"fts":25}, dense arm {"dense":25}.

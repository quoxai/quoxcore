# QuoxBrain held-out comparative eval

Generated 2026-10-06T22:17:02.979Z. Verdict: **PASS**.

Held-out set: 12 paraphrases kept of 16 loaded (4 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.000 | 0.583 | 0.583 | +0.583 |
| nDCG@10 | 0.059 | 0.471 | 0.488 | +0.428 |
| MRR | 0.028 | 0.408 | 0.431 | +0.404 |
| abstention precision | 1.000 | 0.571 | 0.667 | -0.333 |
| abstention recall | 0.167 | 0.667 | 0.667 | +0.500 |

Retrieval paths seen: hybrid arm {"hybrid":18}, fts arm {"fts":18}, dense arm {"dense":18}.

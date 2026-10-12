# QuoxBrain held-out comparative eval

Generated 2026-10-06T19:06:33.854Z. Verdict: **FAIL**.

Held-out set: 12 paraphrases kept of 16 loaded (4 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.000 | 0.333 | 0.417 | +0.417 |
| nDCG@10 | 0.059 | 0.330 | 0.366 | +0.307 |
| MRR | 0.028 | 0.304 | 0.324 | +0.297 |
| abstention precision | 1.000 | 0.750 | 1.000 | +0.000 |
| abstention recall | 0.167 | 0.500 | 0.500 | +0.333 |

Retrieval paths seen: hybrid arm {"hybrid":18}, fts arm {"fts":18}, dense arm {"dense":18}.

Gate failures:
- recall@5 0.417 < 0.5

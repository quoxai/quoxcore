# QuoxBrain held-out comparative eval

Generated 2026-10-06T18:26:23.068Z. Verdict: **FAIL**.

Held-out set: 2 paraphrases kept of 7 loaded (5 rejected for overlap or missing text), 5 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.000 | 0.000 | 0.000 | +0.000 |
| nDCG@10 | 0.000 | 0.000 | 0.000 | +0.000 |
| MRR | 0.000 | 0.000 | 0.000 | +0.000 |
| abstention precision | 1.000 | 1.000 | 1.000 | +0.000 |
| abstention recall | 0.200 | 0.400 | 0.200 | +0.000 |

Retrieval paths seen: hybrid arm {"hybrid":7}, fts arm {"fts":7}, dense arm {"dense":7}.

Gate failures:
- recall@5 0.000 < 0.5
- nDCG@10 0.000 < 0.35
- abstention recall 0.200 < 0.5

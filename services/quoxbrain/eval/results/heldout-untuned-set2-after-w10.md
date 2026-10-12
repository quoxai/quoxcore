# QuoxBrain held-out comparative eval

Generated 2026-10-06T18:22:53.544Z. Verdict: **FAIL**.

Held-out set: 11 paraphrases kept of 13 loaded (2 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.000 | 0.182 | 0.182 | +0.182 |
| nDCG@10 | 0.000 | 0.182 | 0.182 | +0.182 |
| MRR | 0.000 | 0.182 | 0.182 | +0.182 |
| abstention precision | n/a | 1.000 | 1.000 | n/a |
| abstention recall | 0.000 | 0.167 | 0.167 | +0.167 |

Retrieval paths seen: hybrid arm {"hybrid":17}, fts arm {"fts":17}, dense arm {"dense":17}.

Gate failures:
- recall@5 0.182 < 0.5
- nDCG@10 0.182 < 0.35
- abstention recall 0.167 < 0.5

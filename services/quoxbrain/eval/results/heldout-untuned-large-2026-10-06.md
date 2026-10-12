# QuoxBrain held-out comparative eval

Generated 2026-10-06T22:15:07.361Z. Verdict: **FAIL**.

Held-out set: 11 paraphrases kept of 13 loaded (2 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.000 | 0.273 | 0.273 | +0.273 |
| nDCG@10 | 0.000 | 0.238 | 0.226 | +0.226 |
| MRR | 0.000 | 0.197 | 0.182 | +0.182 |
| abstention precision | n/a | n/a | n/a | n/a |
| abstention recall | 0.000 | 0.000 | 0.000 | +0.000 |

Retrieval paths seen: hybrid arm {"hybrid":17}, fts arm {"fts":17}, dense arm {"dense":17}.

Gate failures:
- recall@5 0.273 < 0.5
- nDCG@10 0.226 < 0.35
- abstention precision not measured
- abstention recall 0.000 < 0.5

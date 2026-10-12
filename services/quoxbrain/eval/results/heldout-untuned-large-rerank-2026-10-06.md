# QuoxBrain held-out comparative eval

Generated 2026-10-06T23:33:46.531Z. Verdict: **FAIL**.

Held-out set: 11 paraphrases kept of 13 loaded (2 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.091 | 0.364 | 0.364 | +0.273 |
| nDCG@10 | 0.057 | 0.330 | 0.278 | +0.221 |
| MRR | 0.045 | 0.318 | 0.250 | +0.205 |
| abstention precision | 0.833 | 1.000 | 1.000 | +0.167 |
| abstention recall | 0.833 | 0.667 | 0.500 | -0.333 |

Retrieval paths seen: hybrid arm {"hybrid":17}, fts arm {"fts":17}, dense arm {"dense":17}.

Rerank outcomes, fts arm: llm 17, failed 0, skipped 0, off 0, abstained by reranker 6.

Rerank outcomes, dense arm: llm 16, failed 0, skipped 1, off 0, abstained by reranker 3.

Rerank outcomes, hybrid arm: llm 16, failed 0, skipped 1, off 0, abstained by reranker 2.

Gate failures:
- recall@5 0.364 < 0.5
- nDCG@10 0.278 < 0.35

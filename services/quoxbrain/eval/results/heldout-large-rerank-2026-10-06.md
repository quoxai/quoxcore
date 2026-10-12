# QuoxBrain held-out comparative eval

Generated 2026-10-06T23:36:01.803Z. Verdict: **PASS**.

Held-out set: 19 paraphrases kept of 23 loaded (4 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.211 | 0.789 | 0.737 | +0.526 |
| nDCG@10 | 0.200 | 0.731 | 0.736 | +0.536 |
| MRR | 0.181 | 0.711 | 0.719 | +0.538 |
| abstention precision | 0.500 | 1.000 | 1.000 | +0.500 |
| abstention recall | 0.833 | 1.000 | 1.000 | +0.167 |

Retrieval paths seen: hybrid arm {"hybrid":25}, fts arm {"fts":25}, dense arm {"dense":25}.

Rerank outcomes, fts arm: llm 22, failed 1, skipped 2, off 0, abstained by reranker 8.
WARNING: fts arm: 1 of 23 reranks failed; those queries kept the fused order.

Rerank outcomes, dense arm: llm 20, failed 0, skipped 5, off 0, abstained by reranker 1.

Rerank outcomes, hybrid arm: llm 20, failed 0, skipped 5, off 0, abstained by reranker 1.

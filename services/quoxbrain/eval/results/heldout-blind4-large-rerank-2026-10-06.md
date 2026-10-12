# QuoxBrain held-out comparative eval

Generated 2026-10-06T23:32:19.217Z. Verdict: **PASS**.

Held-out set: 12 paraphrases kept of 16 loaded (4 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 | 0.167 | 0.667 | 0.667 | +0.500 |
| nDCG@10 | 0.167 | 0.572 | 0.616 | +0.449 |
| MRR | 0.167 | 0.542 | 0.600 | +0.433 |
| abstention precision | 0.667 | 0.667 | 0.750 | +0.083 |
| abstention recall | 0.667 | 1.000 | 1.000 | +0.333 |

Retrieval paths seen: hybrid arm {"hybrid":18}, fts arm {"fts":18}, dense arm {"dense":18}.

Rerank outcomes, fts arm: llm 15, failed 2, skipped 1, off 0, abstained by reranker 5.
WARNING: fts arm: 2 of 17 reranks failed; those queries kept the fused order.

Rerank outcomes, dense arm: llm 11, failed 0, skipped 7, off 0, abstained by reranker 2.

Rerank outcomes, hybrid arm: llm 12, failed 0, skipped 6, off 0, abstained by reranker 2.

# QuoxBrain held-out comparative eval

Generated 2026-10-07T00:26:15.236Z. Verdict: **PASS**.

Held-out set: 51 paraphrases kept of 55 loaded (4 rejected for overlap or missing text), 15 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.588 | 0.569 | 0.569 | -0.020 |
| nDCG@10 (strict, noteId only) | 0.514 | 0.502 | 0.544 | +0.030 |
| MRR (strict, noteId only) | 0.490 | 0.469 | 0.518 | +0.028 |
| recall@5 (lenient, noteId or acceptable) | 0.588 | 0.569 | 0.588 | +0.000 |
| MRR (lenient, noteId or acceptable) | 0.506 | 0.475 | 0.535 | +0.030 |
| abstention precision | 0.688 | 0.733 | 0.833 | +0.146 |
| abstention recall | 0.733 | 0.733 | 0.667 | -0.067 |

Retrieval paths seen: hybrid arm {"hybrid":66}, fts arm {"fts":66}, dense arm {"dense":66}.

Rerank outcomes, fts arm: llm 64, failed 1, skipped 1, off 0, abstained by reranker 15.
WARNING: fts arm: 1 of 65 reranks failed; those queries kept the fused order.

Rerank outcomes, dense arm: llm 60, failed 0, skipped 6, off 0, abstained by reranker 9.

Rerank outcomes, hybrid arm: llm 58, failed 2, skipped 6, off 0, abstained by reranker 6.
WARNING: hybrid arm: 2 of 60 reranks failed; those queries kept the fused order.

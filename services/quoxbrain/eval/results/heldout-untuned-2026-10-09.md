# QuoxBrain held-out comparative eval

Generated 2026-10-09T17:36:30.409Z. Verdict: **FAIL**.

Held-out set: 11 paraphrases kept of 13 loaded (2 rejected for overlap or missing text), 6 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.091 | 0.364 | 0.273 | +0.182 |
| nDCG@10 (strict, noteId only) | 0.057 | 0.318 | 0.303 | +0.246 |
| MRR (strict, noteId only) | 0.045 | 0.303 | 0.286 | +0.240 |
| recall@5 (lenient, noteId or acceptable) | 0.091 | 0.364 | 0.273 | +0.182 |
| MRR (lenient, noteId or acceptable) | 0.045 | 0.303 | 0.286 | +0.240 |
| abstention precision | 0.833 | 1.000 | 1.000 | +0.167 |
| abstention recall | 0.833 | 0.500 | 0.667 | -0.167 |

Retrieval paths seen: hybrid arm {"hybrid":17}, fts arm {"fts":17}, dense arm {"dense":17}.

Rerank outcomes, fts arm: llm 17, failed 0, skipped 0, off 0, abstained by reranker 6.

Rerank outcomes, dense arm: llm 17, failed 0, skipped 0, off 0, abstained by reranker 3.

Rerank outcomes, hybrid arm: llm 16, failed 1, skipped 0, off 0, abstained by reranker 4.
WARNING: hybrid arm: 1 of 17 reranks failed; those queries kept the fused order.

Gate failures:
- recall@5 0.273 < 0.5
- nDCG@10 0.303 < 0.35

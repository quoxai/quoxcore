# QuoxBrain held-out comparative eval

Generated 2026-10-09T17:33:15.756Z. Verdict: **PASS**.

Held-out set: 51 paraphrases kept of 55 loaded (4 rejected for overlap or missing text), 15 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.608 | 0.588 | 0.686 | +0.078 |
| nDCG@10 (strict, noteId only) | 0.528 | 0.510 | 0.600 | +0.072 |
| MRR (strict, noteId only) | 0.501 | 0.483 | 0.565 | +0.064 |
| recall@5 (lenient, noteId or acceptable) | 0.608 | 0.608 | 0.686 | +0.078 |
| MRR (lenient, noteId or acceptable) | 0.516 | 0.493 | 0.588 | +0.071 |
| abstention precision | 0.286 | 0.786 | 0.846 | +0.560 |
| abstention recall | 0.133 | 0.733 | 0.733 | +0.600 |

Retrieval paths seen: hybrid arm {"hybrid":66}, fts arm {"fts":66}, dense arm {"dense":66}.

Rerank outcomes, fts arm: llm 48, failed 16, skipped 2, off 0, abstained by reranker 5.
WARNING: fts arm: 16 of 64 reranks failed; those queries kept the fused order.

Rerank outcomes, dense arm: llm 51, failed 7, skipped 8, off 0, abstained by reranker 6.
WARNING: dense arm: 7 of 58 reranks failed; those queries kept the fused order.

Rerank outcomes, hybrid arm: llm 57, failed 1, skipped 8, off 0, abstained by reranker 5.
WARNING: hybrid arm: 1 of 58 reranks failed; those queries kept the fused order.

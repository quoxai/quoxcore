# QuoxBrain held-out comparative eval

Generated 2026-10-11T00:23:38.889Z. Verdict: **FAIL**.

Held-out set: 21 paraphrases kept of 50 loaded (29 rejected for overlap or missing text), 15 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.619 | 0.619 | 0.714 | +0.095 |
| nDCG@10 (strict, noteId only) | 0.514 | 0.584 | 0.638 | +0.124 |
| MRR (strict, noteId only) | 0.476 | 0.571 | 0.611 | +0.135 |
| recall@5 (lenient, noteId or acceptable) | 0.619 | 0.619 | 0.714 | +0.095 |
| MRR (lenient, noteId or acceptable) | 0.476 | 0.571 | 0.611 | +0.135 |
| abstention precision | 0.700 | 0.909 | 1.000 | +0.300 |
| abstention recall | 0.467 | 0.667 | 0.467 | +0.000 |

Retrieval paths seen: hybrid arm {"hybrid":36}, fts arm {"fts":36}, dense arm {"dense":36}.

Rerank outcomes, fts arm: llm 36, failed 0, skipped 0, off 0, abstained by reranker 8.

Rerank outcomes, dense arm: llm 33, failed 0, skipped 3, off 0, abstained by reranker 7.

Rerank outcomes, hybrid arm: llm 34, failed 0, skipped 2, off 0, abstained by reranker 3.

Gate failures:
- abstention recall 0.467 < 0.5

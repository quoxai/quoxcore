# QuoxBrain held-out comparative eval

Generated 2026-10-09T17:35:25.864Z. Verdict: **FAIL**.

Held-out set: 20 paraphrases kept of 50 loaded (30 rejected for overlap or missing text), 15 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.600 | 0.600 | 0.750 | +0.150 |
| nDCG@10 (strict, noteId only) | 0.545 | 0.563 | 0.670 | +0.125 |
| MRR (strict, noteId only) | 0.525 | 0.550 | 0.642 | +0.117 |
| recall@5 (lenient, noteId or acceptable) | 0.600 | 0.600 | 0.750 | +0.150 |
| MRR (lenient, noteId or acceptable) | 0.525 | 0.550 | 0.642 | +0.117 |
| abstention precision | 0.700 | 1.000 | 1.000 | +0.300 |
| abstention recall | 0.467 | 0.533 | 0.400 | -0.067 |

Retrieval paths seen: hybrid arm {"hybrid":35}, fts arm {"fts":35}, dense arm {"dense":35}.

Rerank outcomes, fts arm: llm 35, failed 0, skipped 0, off 0, abstained by reranker 10.

Rerank outcomes, dense arm: llm 31, failed 0, skipped 4, off 0, abstained by reranker 5.

Rerank outcomes, hybrid arm: llm 32, failed 0, skipped 3, off 0, abstained by reranker 3.

Gate failures:
- abstention recall 0.400 < 0.5

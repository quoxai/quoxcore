# QuoxBrain held-out comparative eval

Generated 2026-10-11T04:58:58.614Z. Verdict: **PASS**.

Held-out set: 21 paraphrases kept of 50 loaded (29 rejected for overlap or missing text), 15 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.476 | 0.476 | 0.762 | +0.286 |
| nDCG@10 (strict, noteId only) | 0.350 | 0.433 | 0.664 | +0.315 |
| MRR (strict, noteId only) | 0.294 | 0.404 | 0.631 | +0.337 |
| recall@5 (lenient, noteId or acceptable) | 0.476 | 0.476 | 0.762 | +0.286 |
| MRR (lenient, noteId or acceptable) | 0.294 | 0.404 | 0.631 | +0.337 |
| abstention precision | 1.000 | 1.000 | 1.000 | +0.000 |
| abstention recall | 0.267 | 0.467 | 0.533 | +0.267 |

Retrieval paths seen: hybrid arm {"hybrid":36}, fts arm {"fts":36}, dense arm {"dense":36}.

Rerank outcomes, hybrid arm: llm 34, failed 0, skipped 2, off 0, abstained by reranker 4.

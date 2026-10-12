# QuoxBrain held-out comparative eval

Generated 2026-10-07T00:14:25.124Z. Verdict: **FAIL**.

Held-out set: 51 paraphrases kept of 55 loaded (4 rejected for overlap or missing text), 15 near-miss negatives. Overlap limits: Jaccard <= 0.3, coverage <= 0.5.

Strict counts only the labelled primary noteId; lenient also accepts the fixture `acceptable` notes. Gates use strict.

| Metric | FTS-only | Dense-only | Hybrid | Hybrid minus FTS |
|---|---|---|---|---|
| recall@5 (strict, noteId only) | 0.471 | 0.529 | 0.529 | +0.059 |
| nDCG@10 (strict, noteId only) | 0.425 | 0.446 | 0.473 | +0.048 |
| MRR (strict, noteId only) | 0.386 | 0.406 | 0.435 | +0.049 |
| recall@5 (lenient, noteId or acceptable) | 0.471 | 0.549 | 0.549 | +0.078 |
| MRR (lenient, noteId or acceptable) | 0.402 | 0.413 | 0.458 | +0.055 |
| abstention precision | 1.000 | 0.667 | 0.667 | -0.333 |
| abstention recall | 0.067 | 0.267 | 0.267 | +0.200 |

Retrieval paths seen: hybrid arm {"hybrid":66}, fts arm {"fts":66}, dense arm {"dense":66}.

Gate failures:
- abstention recall 0.267 < 0.5

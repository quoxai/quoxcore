# QuoxBrain retrieval eval harness (P1d)

Regression gate for `searchChunks` (BM25/FTS retrieval) over the real
NodeBrain corpus (`/opt/quoxcore/obsidian/NodeBrain`, 203 ExampleVPN KB notes).
Every later phase (P3 hybrid+rerank, P4 graph) must not regress the numbers
this harness reports — see `docs/STREAM_QUOXBRAIN_P1_CONTRACT.md` §5.

## Running it

```
cd services/quoxbrain
npm run eval
```

This copies the real NodeBrain `.md` tree into a throwaway temp dir (never
mutates the source vault), indexes it into a throwaway temp SQLite DB under
a dedicated eval org, runs all 40 golden queries through `store.searchChunks`,
prints the metrics table, and exits non-zero if `recall@20` falls below the
regression floor (`RECALL_AT_20_FLOOR` near the top of `runNodebrain.mjs`).

## Files

- `golden-nodebrain.json` — the golden query set: `[{ query, relevantRelPaths }]`.
  `relevantRelPaths` are paths relative to the NodeBrain vault root (e.g.
  `docs-public/policies/refund-policy.md`), matching the `relPath` field
  `searchChunks` returns. 1-3 relevant notes per query; a query is a hit at
  rank k if ANY of its relevant paths appears among the top-k results' notes.
- `runNodebrain.mjs` — the runner (recall@5, recall@20, nDCG@10,
  citation-integrity %, zero-hit query list).

## How to regrow the golden set

The corpus lives at `/opt/quoxcore/obsidian/NodeBrain`. To add/refresh
queries:

1. Read a spread of real notes across `docs-public/{faq,support,policies,
   important-pages,reports,social-media}`, `docs-internal/{development,
   devops,support}`, `support/`, `support-channels/`, `technical-support/`.
   Skip `docs-internal` stub pages ("Coming soon") and anything with
   credentials — those aren't things a real user/support agent would ask.
2. For each new query, hand-write it the way a ExampleVPN user or support agent
   actually would phrase it — mix single-term (`"refund policy"`), natural
   multi-word (`"how do I contact support"`), and specific (`"what
   encryption methods do you use"`). Do NOT copy the note's title verbatim
   for every query — that gates nothing (gamed).
3. Note any `rel_path`(s) that genuinely answer it. Duplicate/near-duplicate
   notes across folders (NodeBrain has several — e.g. the "do you keep logs"
   FAQ answered independently under `logging-and-data-retention/`,
   `privacy-and-security/`, and `vpn-information/`) are good multi-path
   queries — keep them, they exercise dedup/coverage realistically.
4. Verify every path exists before committing:
   ```
   node -e "const d=require('./eval/golden-nodebrain.json'); const fs=require('fs');
     for (const q of d) for (const p of q.relevantRelPaths)
       if (!fs.existsSync('/opt/quoxcore/obsidian/NodeBrain/'+p)) console.log('MISSING', p)"
   ```
5. Re-run `npm run eval` and update `RECALL_AT_20_FLOOR` in
   `runNodebrain.mjs` only with an explicit justification in the commit —
   the floor is a regression gate, not a number to chase upward casually.

## The AND -> OR FTS delta (P1d measured fix)

`searchChunks`'s FTS query used to join query tokens with **implicit AND**
(FTS5's default bareword behavior), so a 5+ word natural-language query
needed every token present in a chunk to match at all — a single off-topic
word in the query could zero out results. The fix changes query construction
to **OR-join sanitized, quoted tokens** (BM25 still ranks chunks matching
more terms higher, so OR widens recall without discarding precision
ordering). See the before/after numbers recorded in the P1d handoff report
and the comment above the query-builder in `lib/vaultStore.js`.

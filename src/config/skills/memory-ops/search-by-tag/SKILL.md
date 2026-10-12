---
name: search-by-tag
license: LicenseRef-SkillRights-Reserved-1.0
category: memory/operations
version: 1.0.0
edition: stable
author: quox-core
description: Query the Quox memory store for entries matching a tag set and optional time window, returning ranked hits with content snippets and relevance metadata.
tags: [memory-search, tag-query, fts5, qdrant, ranked-retrieval, time-window, memory-ops]
best_for_agents: [keeper]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Search by Tag

## When to apply

Use this skill when an agent needs to retrieve memories scoped to a specific concept, topic, or classification by matching against stored tags. Typical triggers: a user asks what the system knows about a given subject, a workflow needs prior decisions before proceeding, or an agent is building context before taking a consequential action. Apply before any reasoning step that depends on historical state — retrieving evidence before concluding is always preferable to generating from model weights alone.

## Inputs

- `tags` (string[]) — One or more lowercase hyphenated tags to match. At least one tag is required. The query uses AND logic by default: all supplied tags must be present on a returned row. Pass a single-element array for OR-style broad retrieval.
- `match_mode` (`"all"` | `"any"`, optional) — Controls tag intersection logic. `"all"` requires every tag to be present (default). `"any"` returns rows matching at least one tag.
- `memory_types` (string[], optional) — Restrict results to one or more memory types: `fact`, `preference`, `decision`, `constraint`, `observation`, `entity`, `error/fix`. Default: all types.
- `since` (string, optional) — ISO 8601 UTC timestamp. When set, only rows with `created_at` or `last_accessed_at` after this value are returned. Useful for scoping to a recent incident window.
- `until` (string, optional) — ISO 8601 UTC timestamp upper bound. Combined with `since` to form a closed time window.
- `limit` (number, optional) — Maximum number of ranked hits to return. Default: `20`. Maximum: `100`.
- `org_id` (string) — Organisation identifier. Required for tenant isolation; sourced from the caller's JWT claims.
- `user_id` (string, optional) — Restrict results to a single user's memories within the org. When omitted, returns org-scoped results if the caller has org-read permission.

## Steps

1. Validate inputs: confirm `tags` is a non-empty array, each element is a non-empty lowercase string. Reject with a structured error if any tag contains uppercase characters or spaces — normalise by lowercasing and replacing spaces with hyphens, then log a warning so the caller can correct upstream.
2. Resolve the search tier: attempt SQLite+FTS5 on the memory service (port 3103) first. If FTS5 returns fewer than `limit / 2` hits, fall through to Qdrant vector search (port 6333) using the tag strings as the query embedding input. This two-tier approach maximises recall without paying vector-search latency for well-indexed tags.
3. Construct the FTS5 query from `tags`, `match_mode`, `memory_types`, `since`, and `until`. Bind `org_id` and `user_id` as parameterised values — never interpolate them into the query string directly.
4. Execute the FTS5 query. Collect all matching rows, including the fields: `id`, `type`, `content`, `tags`, `created_at`, `last_accessed_at`, `access_count`, `confidence_score` (if present).
5. If the vector fallback was triggered at step 2, merge the Qdrant results with the FTS5 results, deduplicating by row `id`. Qdrant results that already appear in FTS5 results are discarded to avoid double-counting.
6. Rank the merged result set using a composite score: `0.5 × normalised_recency + 0.3 × normalised_access_frequency + 0.2 × confidence_score`. Recency and access frequency are normalised to the [0, 1] range relative to the result set. Missing `confidence_score` is treated as `0.5`.
7. Truncate to `limit` rows, ordered by composite score descending.
8. For each returned row, generate a `snippet` field: the first 300 characters of `content`, with matched tags highlighted using `**tag**` markdown syntax.
9. Attach an AEE envelope tagging this retrieval to the parent execution context (`quox.skill.search_by_tag`, corr inherited from caller). Emit a VOLT evidence record with `evidence_type: memory_query_snapshot` containing the query parameters (excluding raw content), result count, and composite scores.
10. Return the structured output.

## Outputs

- `hits` (object[]) — Ranked array of matching memory rows. Each entry contains: `id`, `type`, `tags[]`, `snippet`, `created_at`, `last_accessed_at`, `access_count`, `composite_score`.
- `total_matched` (number) — Total rows matching the query before the `limit` was applied. Useful for pagination or awareness of result breadth.
- `search_tiers_used` (string[]) — Which tiers were queried: `["fts5"]`, `["fts5", "qdrant"]`, etc.
- `query_params` (object) — Echo of the normalised query parameters used: `tags`, `match_mode`, `memory_types`, `since`, `until`, `limit`.
- `queried_at` (string) — ISO 8601 UTC timestamp when the query was executed.

## Failure modes

- **No matching rows:** Return `hits: []`, `total_matched: 0`. Do not treat as an error. The calling agent should interpret an empty result as absence of stored knowledge on the topic and proceed accordingly — for example, by querying a broader tag set or prompting the user.
- **Memory service unreachable (port 3103):** Log the connection error and attempt Qdrant-only retrieval. If Qdrant is also unreachable, return a structured error with `code: MEMORY_SERVICE_UNAVAILABLE` and surface to the calling agent. Do not return stale cached results — the caller must know the result set may be incomplete.
- **Tag normalisation warning:** If all supplied tags had to be normalised (uppercased or space-separated), emit a warning in the AEE envelope metadata. The result is still returned, but the caller should fix the tag format at the source to avoid silent mismatches with stored rows.
- **FTS5 query timeout (>2 s):** Log the timeout, skip FTS5, and fall through immediately to Qdrant. Include `"fts5_timeout"` in `search_tiers_used` so the caller knows the full index was not scanned.
- **Qdrant embedding failure:** If the vector service returns an error when generating embeddings for the tag query, skip the vector tier and return FTS5-only results. Set `search_tiers_used: ["fts5"]` and emit a warning in the AEE envelope.

## Notes

Tag matching operates on the `tags` array column in the memory store, not on free-text `content`. For content-level full-text search, use the memory service's `/search` endpoint with a `query` string directly. This skill is intentionally tag-scoped so that the result set is deterministic and reproducible — the same tag set on the same data always returns the same ranked rows, which is important for audit replay. The composite ranking score is deterministic given the same result set and should be included in the VOLT evidence record so that downstream reasoning can be audited against the ordering signal.

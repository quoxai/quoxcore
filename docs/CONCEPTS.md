# QuoxCORE 2 — Concepts Reference

> **Authoritative source: quox.ai/docs/concepts** — the website is the canonical reference for all concept definitions. The entries below are short summaries with links. When the website and this file disagree, the website wins.

## Authoritative concept URLs

| Concept | URL | Summary |
|---------|-----|---------|
| **Concepts index** | https://quox.ai/docs/concepts | Landing page for all five concepts |
| **Crystals** | https://quox.ai/docs/concepts/crystals | Reusable, governed skills formed from executions. Task-time candidates vs post-hoc canonical. Tier gating, promotion lifecycle, vs Skills vs Prompts. |
| **Agents** | https://quox.ai/docs/concepts/agents | Single agent vs agentic loop. Persona-pinned / tool-using / browser modes. Mode discriminator. team:invoke composition. |
| **Workflows** | https://quox.ai/docs/concepts/workflows | Palette, node taxonomy (22 types / 5 groups), live execution overlay, versioning, library. |
| **Tools** | https://quox.ai/docs/concepts/tools | Four install paths (OpenAPI / MCP / Repo / Script), agent-tool matrix, install-time budget, plugin durability. |
| **Governance** | https://quox.ai/docs/concepts/governance | AOCL evidence chain, four-scope budgets (P8.B), approval policies (P8.C), ET-ENFORCE multi-tenant, audit export. |

## Internal dashboard docs (implementation detail)

These docs describe the engineering implementation, not the user-facing concepts:

- `docs/ARCHITECTURE.md` — service topology, ports, Docker layout
- `docs/AGENTS.md` — agent hierarchy, agentRegistry, assistants shim
- `docs/AOCL.md` — AOCL layer internals, shadow observer, cutover status
- `docs/FRONTEND.md` — React component map, view registry
- `docs/MEMORY_SYSTEM.md` — memory tiers, WSM, provenance

# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one repo, one bounded context.

## Before exploring, read these

In order:

1. **This repo's `AGENTS.md` / `CLAUDE.md`** — the canonical per-repo contract: commands,
   conventions, architecture, and the repo's own rules. Read it before anything else.
2. **The workspace `CLAUDE.md`** at `/Users/mjnong/REPOS/CellarNode/CLAUDE.md` — the sibling-repo
   map, shared package inventory, ports, agent-team workflow, and cross-cutting bans.
   CellarNode is a **sibling layout, not a monorepo**: each repo has its own PRs, CI, and
   release cadence.
3. **RepoSkein decisions** — `list_decisions` (see ADRs below).
4. **`CONTEXT.md`** at the repo root, if it exists.

If `CONTEXT.md` doesn't exist, **proceed silently**. Don't flag its absence; don't suggest
creating it upfront. `/domain-modeling` creates it lazily when terms actually get resolved.

## ADRs are RepoSkein decisions, not `docs/adr/*.md`

This workspace records architectural decisions as **graph-anchored RepoSkein ADRs** — JSON records
under `.reposkein/decisions/`, anchored to the nodes and paths they govern. The JSON is the
**system of record**.

- **`list_decisions` before modifying governed code.** This is mandated by every sub-repo's
  `AGENTS.md`, not optional. Decisions also surface automatically inside `get_context_profile`,
  `impact`, and `semantic_find` results.
- **`get_decision <id>`** to read one in full.
- **`record_decision`** for a new significant choice. Agent-authored records land as `proposed`;
  a human ratifies with `set_decision_status`.
- **`reaffirm_decision`** when a decision still holds after the code beneath it moved;
  **`reanchor_decision`** (0.7.0) to mechanically repair anchors after renames or moves.
- **`reindex_file`** after editing. If the response carries `decisions_affected`, `get_decision`
  each one before moving on.
- **`docs/adr/`** is a **read-only exported view**, produced by `reposkein-mcp adr export` and
  rendered as Nygard markdown. Never hand-edit it, and never treat it as authoritative — it can
  be stale. Read it only when the RepoSkein MCP is unavailable.

## Flag ADR conflicts — never silently violate

If your output contradicts an existing decision, surface it explicitly:

> _Contradicts `2026-08-20-session-cookie-is-the-jwe` (accepted), but worth reopening because…_

Then take one of three routes, never a fourth:

- **Conform** — change the approach to match the decision.
- **Supersede** — `record_decision` a replacement that explicitly supersedes the old one.
- **Reaffirm** — `reaffirm_decision` when the decision still holds and only its anchors drifted.

Silently violating a recorded decision is the anti-pattern this system exists to prevent.

## Prefer the graph over grep

For structural questions — "who calls X", "what breaks if I change this", "what moves with this
file" — use RepoSkein rather than grep. It costs roughly 8× fewer context tokens on structural
queries.

`semantic_find` → `get_context_profile` → `impact` → `get_temporal_context` →
edit → `reindex_file` → `write_semantic_summary`.

**Federation caveat:** `federated: true` is a **silent no-op** in this sibling layout — the 17
repos have no common git parent, so there are no `FEDERATES_TO` edges. An `impact` result that
quietly covered one repo looks exactly like a safe green light. For genuine cross-repo blast
radius use `read_cypher`, which sees every repo loaded into the shared Neo4j, filtered by
`n.repo_id`.

## Use the project's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a hypothesis, a
test name — use the term this project actually uses. Established vocabulary, which agents get
wrong by default:

- **Producer-facing surfaces say "product"**, never "beverage" or "variant". Those are the
  backend/admin terms. Admin surfaces are exempt and use the domain terms directly.
- **Classification labels come from `@cellarnode/beverage-utils`**, never raw classification
  slugs rendered as-is.
- **`beverage_classifications` is canonical**; `beverage_categories` is deprecated.
- **Matches are a producer concept** (beverage ↔ tender). The importer surface is about **offers
  received** and notifications — do not describe match counts as an importer metric.

If the concept you need isn't established anywhere yet, that's a signal: either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).

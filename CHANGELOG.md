# Changelog

## 0.5.0 — 2026-10-14

CEL-2537 dependency sweep.

- Consumer-visible: `engines.node` is now `>=22.12.0`. The GitHub Action runs
  on setup-node 22.
- `@google/genai` 2, `commander` 15; the transitive `axios` override is pinned
  at 1.20.0.
- No change to CLI flags or Action inputs.

# Triage Labels

The skills speak in terms of five canonical triage roles. This repo tracks work in **Linear**
(team `CellarNode` / `CEL`), which has two orthogonal axes where GitHub has one: a **workflow
state** and a set of **labels**. So the five roles map onto whichever axis already means the
same thing, and only create a label where no state can express it.

| Role in mattpocock/skills | Linear representation | Meaning |
| --- | --- | --- |
| `needs-triage` | **state** `Backlog` | Maintainer needs to evaluate this issue |
| `needs-info` | **label** `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | **state** `Todo` + **label** `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | **state** `Todo` + **label** `ready-for-human` | Requires human implementation |
| `wontfix` | **state** `Canceled` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), apply the Linear
representation from this table — set the state, the label, or both.

## Rules

- **`Backlog` means untriaged.** An issue sitting in `Backlog` has not been evaluated. Triage
  moves it out: to `Todo` (with the agent/human label), or to `Canceled`.
- **`Todo` always carries exactly one of `ready-for-agent` / `ready-for-human`.** That split is
  the whole point of triage and Linear has no native concept for it. An issue in `Todo` with
  neither label has not finished triage.
- **`needs-info` is a label, not a state.** The issue stays wherever it is; the label marks that
  it is blocked on the reporter. Remove it when the information arrives.
- **`Canceled` is `wontfix`.** Do not create a `wontfix` label — Linear's `Canceled` state already
  carries the meaning and is visible in every Linear view and roll-up.
- **`Duplicate` is a sixth state with no skill equivalent.** Use it when closing a duplicate
  rather than `Canceled`, and link the original with a Linear `duplicate of` relation.

## Applying labels

Labels are set with `save_issue`'s `labels` field, which **replaces the entire set**. Read the
issue's current labels first and pass them back alongside the addition, or you will silently
strip its `Bug` / `Feature` / `role:*` labels.

## Labels that are not triage

These coexist with the triage labels and must be preserved when triaging:

- **Type**: `Bug`, `Feature`, `Improvement`
- **Agent role**: `role:{spec,arch,backend,frontend,reviewer,qa,lib}` — the seven-role team
  contract from `docs/AGENT_TEAM_PLAYBOOK.md` §2. `role:*` answers *who does the work*;
  `ready-for-agent` / `ready-for-human` answers *whether a human must*. They are independent:
  a `role:backend` ticket can be either.

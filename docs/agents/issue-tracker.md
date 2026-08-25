# Issue tracker: Linear

Issues and specs for this repo live in **Linear**, workspace `cellarnode`, team **CellarNode** (`CEL`).
GitHub holds the code and pull requests only — **there are no GitHub issues**; never run `gh issue`.

Team id: `64f9a421-8514-4985-a810-41e6b375d52b`

## Write path: MCP first, GraphQL fallback

Prefer the **Linear MCP server** (`mcp__linear-server__*`) when it is connected. Interactively
authenticated MCP servers are absent in headless and cron runs — in that case fall back to the
`linear` CLI for reads/updates and a node `fetch` script for creates.

| Operation | MCP (preferred) | Fallback |
| --- | --- | --- |
| Create an issue | `save_issue` with no `id` | GraphQL `issueCreate` (see below) |
| Read an issue | `get_issue` + `list_comments` | `linear issue view CEL-XX` |
| List issues | `list_issues` (filter by `team`, `state`, `label`, `assignee`, `project`) | — |
| Comment | `save_comment` | `linear issue update CEL-XX --comment "..."` |
| Change state | `save_issue` with `state` | `linear issue update CEL-XX --state "In Progress"` |
| Apply / remove labels | `save_issue` with `labels` (full replacement set) | — |
| Close | `save_issue` with `state: "Done"` | `linear issue update CEL-XX --state Done` |
| Won't do | `save_issue` with `state: "Canceled"` | `linear issue update CEL-XX --state Canceled` |
| Read/write a doc | `get_document` / `save_document` / `list_documents` | `linear doc find\|view\|update` |

`~/.local/bin/linear` supports **only** `me`, `issue view`, `issue update`, and `doc *`.
**It cannot create issues.**

### GraphQL fallback for creating issues

POST to `https://api.linear.app/graphql` with header `Authorization: $LINEAR_API_KEY`
(no `Bearer` prefix). A pre-tool hook blocks raw `curl` in Bash — use a small **node** script
with `fetch` instead, written to the scratchpad.

`issueCreate` input: `{ teamId, projectId, title, description, priority, labelIds, parentId }`
where priority is `1`=Urgent, `2`=High, `3`=Normal, `4`=Low.

Cached ids (verified 2026-07-11):

- Team `CEL`: `64f9a421-8514-4985-a810-41e6b375d52b`
- Project "Project E-Label": `aadeb0ae-a718-4acd-9ed8-819609793b92`
- Type labels: `Bug` `e5245f9d-7592-4380-9540-9b34217b93e7` · `Improvement` `6acc192a-d100-4b10-bbaf-502228a6d2b2` · `Feature` `e788213e-96cc-4983-913c-0abfd3017ec4`
- Role labels: `role:spec` `18669553-5c7b-42ef-a0f0-5c77e0bb6f19` · `role:arch` `74c771b0-a9dc-4ff4-bd96-3b0086ceb2e3` · `role:backend` `4162f02a-f8d0-4a47-a90d-68422acf2a1d` · `role:frontend` `d81f06b3-b24c-419f-b810-f2ce97e590c3` · `role:reviewer` `a8b5142e-78ba-4527-bfe2-e38196b64a7a` · `role:qa` `c64314a6-48bf-4674-9a2f-e910d7853de2` · `role:lib` `71d70deb-8582-4b4b-9f77-dbe579e64732`
- Triage labels (created 2026-08-25): `ready-for-agent` `36b7fd3d-e560-4183-b26b-00cea666bc56` · `ready-for-human` `b0327c94-f8a2-4959-ac68-7148c29cb33f` · `needs-info` `3d2d958b-126e-4df9-ab9a-ea4ba23873f3`
- States: `Backlog` `f932e6e4-25cd-494b-924e-7f285f05dd90` · `Todo` `489540ae-7f51-4ef5-87de-f9c52313e018` · `In Progress` `b1e18065-034d-4c6b-92f0-c331eb4547b4` · `In Review` `a237c71b-45de-4784-99c7-c732621d6efe` · `Done` `1a384d35-b956-4059-8974-aa0c08fff22f` · `Canceled` `2e16104b-6526-4886-bb6f-54c626573a27` · `Duplicate` `1d2ed4a7-46c0-4ebd-bc0b-9719ad39ce87`

`issue view` does not surface children — query `issue(id){children{nodes{identifier}}}` directly.

## Conventions

- **Identifier** is `CEL-<n>`. Always refer to tickets by identifier, never by UUID, in prose.
- **Workflow states**: `Backlog` → `Todo` → `In Progress` → `In Review` → `Done`,
  plus `Canceled` and `Duplicate`.
- **Labels in use**: `Bug`, `Feature`, `Improvement`, and the seven agent-role labels
  `role:{spec,arch,backend,frontend,reviewer,qa,lib}` (see `AGENT_TEAM_PLAYBOOK.md` §2).
  Setting `labels` on `save_issue` **replaces** the whole set — read the current labels first
  and pass them back alongside any addition.
- **Sub-issues** are the decomposition primitive: set `parentId` to the umbrella issue.
- **Branches** are `marcus/cel-NN-short-slug`. The `cel-NN` fragment is what makes Linear
  auto-link the PR to the ticket. (The playbook's `mjnong/` prefix is stale.)
- **One ticket → one worktree → one branch → one PR.** See `## Worktree-per-ticket lifecycle`
  in the workspace `CLAUDE.md`.
- **Taskwarrior mirror**: tickets spanning ≥3 turns or ≥2 agent sessions are mirrored locally by
  the `task-linear-bridge` skill (`linear_id:CEL-XX` UDA). Mirror to Linear after every local
  transition; annotate *before* the state change so the reasoning survives.

## Pull requests as a request surface

**PRs as a request surface: no.** _(Set to `yes` if this repo starts treating external PRs as
feature requests; `/triage` reads this flag.)_ CellarNode repos are private and every PR
originates from a CEL ticket, so PRs are a review surface, not an intake surface.
PR review runs through `/code-review` (CodeRabbit) plus two independent agent reviewers.

## When a skill says "publish to the issue tracker"

Create a Linear issue on team `CEL`. Set `parentId` when it belongs under an umbrella ticket.

## When a skill says "fetch the relevant ticket"

`get_issue` for `CEL-XX`, then `list_comments` for the discussion. Comments carry the decisions.

## Specs and long-form documents

Long-form specs live in **two** places and must be kept in sync:

- `docs/specs/*.md` in the workspace `docs/` directory — **canonical**.
- A Linear document in the owning project — the team-visible mirror.

Markdown is canonical; when the markdown changes, update the Linear document to match.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a Linear **project**; tickets are issues within it.

- **Map**: a Linear project, or an umbrella issue when the work is smaller than a project.
  Notes / Decisions-so-far / Fog live in the project description or a linked Linear document.
- **Child ticket**: an issue with `parentId` set to the umbrella, or `project` set to the map
  project. Role is carried by a `role:*` label.
- **Blocking**: Linear's **native issue relations** (`blocks` / `blocked by`), which are
  UI-visible and drive Linear's own unblocked view. Never encode blockers as body text.
- **Frontier query**: `list_issues` for the project with state `Todo`, drop anything with an
  open blocker or an assignee; first in project order wins.
- **Claim**: `save_issue` setting `assignee` to self and state to `In Progress`.
- **Resolve**: `save_comment` with the answer, then `save_issue` with state `Done`.

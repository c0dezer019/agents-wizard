# Promote an agent to lead — design

## Context

agent-wizard's team builder gives each team an orchestrator slot. The orchestrator
picker (`assignAgentToSlot` with `rankByRole: true`, in [lib/actions.js](../../../lib/actions.js))
recommends existing agents whose name/description read as lead/manager-shaped, via
`roleContextScore` in [lib/detect.js](../../../lib/detect.js). Most users have few or
no genuinely lead-shaped agents, so that list is often near-empty.

This feature lets a user take a senior/principal **individual-contributor** agent and
spin off a **lead** version of it. A lead's job differs in kind from an IC's — delegation
and coordination instead of hands-on implementation — so this is not an additive tweak
to the original file; it's a fork: **copy the agent to a new file, then run an LLM
rewrite pass on the copy.** The original is never modified. The two files are independent
from that point on — no sync mechanism (out of scope, by decision).

## Scope decisions (locked)

- Triggered **from inside the orchestrator picker only** (not a standalone User-tab action).
- `"principal"` moves out of the lead recommender and into a new seniority tier — IC
  seniority is a distinct axis from people-leadership.
- The "Promote…" option is **always present** in the orchestrator picker.
- Empty seniority pool → the promotion candidate list is simply empty; the user backs out
  and creates a fresh agent instead. No special fallback.
- Rewrite offers the **same 3-way finish choice** as `createFlow` (auto-draft / interactive
  claude session / manual template).
- New agent name defaults to `<original>-lead`, editable.
- One **optional** guidance field is asked before the finish choice.

## Component 1 — seniority scorer (`lib/detect.js`)

Mirrors the existing role recommender, scoring IC-seniority instead of leadership.

- Remove `"principal"` from `LEAD_STEMS` (it is IC seniority, not people-leadership).
- Add `SENIORITY_STEMS = ["senior", "principal", "staff"]` and `SENIORITY_WORDS = ["sr"]`
  (`"sr"` word-boundary matched, like the existing `LEAD_WORDS`, to avoid matching inside
  other words). `"lead"` stays lead-only, not a seniority term.
- Add `seniorityScore(agent)` = count of stem + word hits over `` `${agent.name} ${agent.description}` ``,
  reusing the existing `matchStems`/`matchKeywords` helpers.
- Add `rankSeniorityCandidates(agents)` → agents sorted by `seniorityScore` desc, then name,
  each tagged `{ ...agent, seniorityScore }`. Same shape as `rankOrchestratorCandidates`.
- Export `SENIORITY_STEMS`, `SENIORITY_WORDS`, `seniorityScore`, `rankSeniorityCandidates`.

Effect: `senior-python-dev` scores as a promotion candidate but no longer falsely scores
as a lead in the orchestrator recommender.

## Component 2 — promote flow (`lib/actions.js`)

New `promoteAgentToLead(ctx)` → returns `{ note, created }` (same contract as `createFlow`,
`created = { name, file, scopeKind } | null`). A copy-then-rewrite fork reusing existing
pipeline pieces:

1. **Pick candidate** — `pickOption` over `rankSeniorityCandidates(pool)`, where `pool` is
   user-scope agents (same filter as the orchestrator picker). Descriptions collapsed/truncated
   for display, same as `assignAgentToSlot`. Empty pool → empty list, `null` on back-out.
2. **Name** — `askLine` prefilled with `<original>-lead`; same `^[a-z][a-z0-9-]*$` validation,
   `BUILTIN_NAMES` check, and existing-file collision check as `createFlow`. `BACK`/`null` → cancel.
3. **Guidance** — one optional `askMultiline` ("anything specific about how this lead should
   delegate?"), skippable.
4. **Copy** — write the new file into User scope (`~/.claude/agents/<name>.md`), seeded with
   the original's raw content. This guarantees a file exists even if the LLM step later fails.
5. **Finish choice** — the same 3-way `pickOption` as `createFlow`:
   - **Auto-draft** — `runClaudeGenerate` with the new `promote_to_lead.md` system prompt;
     input = original raw file + guidance + new name; output validated to start with `---`,
     written to the new file. On failure, the plain copy from step 4 remains + a note.
   - **Interactive** — `runClaudeInteractive` with `promote_to_lead.md`; the live session edits
     the new file.
   - **Manual** — leave the copy as-is and open `$EDITOR`.
6. Re-read authoritative identity via `reloadCreatedAgent(target, "user")` after the editor
   closes (the user may edit frontmatter `name`), return `{ note, created }`.

The original agent's file is never opened for write.

## Component 3 — orchestrator picker wiring (`assignAgentToSlot`)

Add a persistent option to the orchestrator picker (`rankByRole` only — member slots never
see it), ordered: `+ Create new agent…` → `★ Promote a senior/principal agent to lead…` →
`Show all…` (when applicable) → candidates.

- Chosen → `const { created } = await promoteAgentToLead(ctx)`.
  - `created` truthy → return its ref; it becomes the orchestrator. The existing `warnOnAssign`
    file-mutation confirm still fires afterward before the roster block is written into the new
    lead's file.
  - `created` null (cancel / empty pool / back-out) → `continue` the picker loop (same pattern
    as `Show all`).

## Component 4 — rewrite contract (`promote_to_lead.md`)

New system-prompt file, sibling to `add_agent.md` / `finish_agent_interactive.md`. Instructs
claude to rewrite the copied agent from IC framing (performs implementation) to lead framing
(delegates, coordinates, reviews), **preserving the domain expertise** of the original. Output
is a full valid agent file (frontmatter + body); the `description` should be rewritten to a
lead-shaped delegation trigger so the result scores on `roleContextScore`. Same output-format
contract as `add_agent.md` (must start with `---`).

## Error handling (mirrors `createFlow`)

- claude unreachable on auto-draft → fall back to the plain copy (already on disk) + a note;
  nothing lost.
- Invalid/duplicate name → rejected before the copy is written.
- Cancel/Esc before the copy → nothing written. After the copy → the copy remains on disk
  (user can delete it), same semantics as `createFlow`.

## Testing

Headless (matching the team-builder verification approach — no test framework in this repo):

- `seniorityScore` / `rankSeniorityCandidates`: senior/principal/staff agents score; the
  `senior`→promotable-but-not-lead separation holds (a `senior-python-dev` scores seniority
  but not `roleContextScore`).
- `roleContextScore` regression: removing `"principal"` from `LEAD_STEMS` doesn't drop
  genuinely lead-shaped agents (phrases still catch "engineering manager", etc.).
- `node --check` on every touched file.

Interactive flow (candidate pick → name → guidance → finish choice → claude spawn) verified by
inspection and a manual `node agent-wizard.js` run — cannot execute here (no TTY; `runClaudeGenerate`
spawns `claude`). Same caveat as the shipped team-builder.

## Files

- New: `promote_to_lead.md` (repo root, sibling to `add_agent.md`).
- Edit: `lib/detect.js` (seniority scorer, move `principal`), `lib/actions.js`
  (`promoteAgentToLead`, picker wiring), and the `agent-wizard.js` require list only if a new
  export needs surfacing (the flow is reached via `assignAgentToSlot`, already internal to
  actions.js, so likely no `agent-wizard.js` change).

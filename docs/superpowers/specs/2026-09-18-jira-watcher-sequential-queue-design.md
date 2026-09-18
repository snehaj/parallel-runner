# Jira watcher: sequential queue + auto-deploy design

## Repos touched

This design spans two separate git repos -- important for whoever writes the
implementation plan, since it's not a single-repo change:

- **`parallel-code-local`** (this repo): the Electron app itself --
  `electron/ipc/jira-watcher.ts`, `electron/ipc/register.ts`,
  `src/components/EditProjectDialog.tsx`, and related store/IPC files. Owns the
  queue, the two persistent windows, and the discovery/refill mechanics.
- **`equitystory-ers`**: `.claude/agents/myl3.md` (status-check fix) and
  `.claude/skills/pipeline-deploy/SKILL.md` (new auto-transition step). Owns
  what actually happens _inside_ each ticket's work, invoked by the app above
  via `sendPrompt(taskId, agentId, "/myl3 ...")` / `"/pipeline-deploy"` --
  neither file lives in or is built by `parallel-code-local`.

## Problem

Today (`electron/ipc/jira-watcher.ts`), every poll tick or "Check Jira now" click
finds all `REG_AUTOMATED`-labeled tickets and immediately spawns one new Parallel
Code task (= one new window/panel) per matching ticket, via
`jiraBridge.createTask(...)` inside a `for` loop with no throttling. With several
tickets labeled at once, this opens several windows simultaneously, which is
disruptive and (per the user) not how the team wants to work.

Separately, no automation exists today that moves a ticket forward once its MR is
in review. `pipeline-deploy` (`equitystory-ers/.claude/skills/pipeline-deploy/`)
already merges an approved+mergeable MR and deploys to staging -- but it only acts
on tickets **already** in `Verified` status, and nothing currently transitions a
ticket `In Review -> Testing -> Verified`. That gap was found live during this
design (see "Live-verified Jira transition graph" below).

## Goals

- Replace "one task window per ticket, unthrottled" with two **persistent, self-
  refilling task windows** per Jira-watched project: an **Implementer** and a
  **Deployer**, each processing one ticket at a time from its own queue.
- Close the `In Review -> Verified` gap for `REG_AUTOMATED` tickets specifically,
  so the Deployer's queue actually has something to act on.
- Reuse existing building blocks (`myl3`, `pipeline-deploy`, `pipeline-merge`,
  `onAgentReady`, `sendPrompt`) rather than duplicating their logic.

## Non-goals

- No change to `qa`/`prod` deploy gating -- this stays staging-only, matching
  `pipeline-deploy`'s existing scope.
- No change to how a _human-driven_ (non-`REG_AUTOMATED`) ticket moves through
  `In Review`/`Testing` -- the auto-transition is scoped to the trigger label only.
- No per-ticket reviewer selection -- reviewers for auto-queued tickets come from
  one configured default list (existing `EditProjectDialog` Jira section gets a
  new field for this).
- No concurrency setting beyond 1 active ticket per stage in this iteration (the
  user asked whether >1 was possible; answer is yes structurally, but out of scope
  for v1 -- ship with `1`, revisit if needed).

## Live-verified Jira transition graph (DEV_IRREG, checked via API during design)

```
Backlog --"Start progress"--> In Progress --"Start review"--> In Review --"In Testing"--> Testing --"Finish Testing"--> Verified
                             \--"On hold"--> Backlog                    \--"Rework"--> In Progress        \--"Rework"--> In Progress
```

Confirmed live against real tickets (DEV_IRREG-2178, DEV_IRREG-1706, DEV_IRREG-2165,
DEV_IRREG-1197), not assumed from `myl3.md`'s existing (stale) comments.

**Prerequisite bug fix (blocks everything else):** `myl3.md` step 0a's "planned
state" check currently looks for `"Zu erledigen" / "To Do"` -- the real status is
`"Backlog"`. Every ticket the new Implementer queue hands to myl3 would be
incorrectly rejected until this string is corrected.

## Architecture

### Implementer window (per project)

- Created automatically the first time "Watch Jira board" is enabled for a
  project (existing toggle in `EditProjectDialog` -- no new toggle for this half).
- Backed by a FIFO queue of ticket keys (`implementQueue: string[]`), held in
  `jira-watcher.ts`'s per-project state alongside the existing `WatchedProject`
  entry.
- **Discovery stays exactly as it is today**: the existing 3-minute poll
  (`runJiraTick` / `pollOneProject`) and the "Check Jira now" button both call
  `queryLabeledTickets(...)` to find `REG_AUTOMATED`-labeled tickets. The only
  change is what happens when a _new_ ticket (one not already queued, not already
  the ticket currently running, and not already an existing task per
  `hasTicketKey`) is found: **append its key to `implementQueue`** instead of
  immediately calling `jiraBridge.createTask(...)`.
- The Implementer task window itself is created once, lazily, the first time the
  queue has a ticket to hand it (not eagerly on toggle-enable with an empty queue --
  avoids an idle window with nothing to do). Uses the existing
  `jiraBridge.createTask(...)` bridge for this one-time creation, same as today,
  but only ever once per project, not once per ticket.
- **Refill mechanism**: register an `onAgentReady(agentId, callback)` for the
  Implementer's agent. When it fires (agent shows its idle prompt) AND
  `implementQueue` is non-empty, dequeue the next ticket key and call
  `sendPrompt(taskId, agentId, "/myl3 <ticketKey> <default-reviewers>")`.
  Re-register the `onAgentReady` callback each time (it's documented as
  one-shot) so the loop continues indefinitely.
- If the queue is empty when the agent goes idle, do nothing -- the next poll
  tick or "Check Jira now" click that finds a new ticket triggers the refill
  (it must check "is the Implementer idle and the queue was empty" and prompt
  immediately in that case, not wait for a future idle event that already
  happened).
- Full visibility for free: this is a normal Parallel Code task, so the user
  can watch it work and see terminal output exactly as before -- only the
  "one task per ticket, all at once" behavior changes.

### Deployer window (per project)

- Created automatically alongside the Implementer (same toggle, per user's
  answer -- no separate "enable auto-deploy" control in v1).
- Does **not** track its own ticket-key queue. Its "queue" is conceptually just
  "is it time to run another pass" -- each cycle, when idle, it re-invokes
  `/pipeline-deploy` (updated, see below), which does its own JQL lookup for
  eligible work and reports "nothing to do" gracefully if there isn't any.
- **Refill mechanism**: same `onAgentReady` pattern as the Implementer. When the
  Deployer's agent goes idle, send `/pipeline-deploy` again. Additionally
  triggered on the same poll cadence as the Implementer (reusing the existing
  3-minute tick) so it doesn't wait indefinitely if it happened to be idle
  before new work became eligible -- deploy readiness depends on human MR
  approval timing, which the app can't accelerate, so re-checking on the
  existing tick interval is enough; no separate timer needed.

### Auto-transition step: `In Review -> Testing -> Verified` (new)

This is the piece that makes the Deployer's queue non-empty in the first place --
without it, `pipeline-deploy` never finds a `Verified` ticket to act on for
`REG_AUTOMATED` work, because nothing moves tickets there today.

Added as a new step at the **start** of `pipeline-deploy`, before its existing
step 1 (which still runs, now against tickets already brought to `Verified` by
this new step, plus any that reached `Verified` some other way):

1. JQL: `project = DEV_IRREG AND labels = "REG_AUTOMATED" AND status = "In Review"
AND assignee = currentUser() ORDER BY updated ASC`. `assignee = currentUser()`
   matches `pipeline-deploy`'s existing step 1 convention -- both run as
   whichever Jira account's credentials are configured for the Deployer's
   Claude Code session (same session that runs myl3's ticket work), so this
   stays consistent with the rest of the pipeline rather than introducing a
   second identity. Scoped to the trigger label specifically -- per the user,
   `Testing` has no human gate _for `REG_AUTOMATED` tickets only_; a
   human-driven ticket in `In Review` must not be touched by this loop.
2. For the oldest matching ticket: resolve its MR (same "find the MR for this
   ticket's branch" logic `pipeline-deploy` step 4 / `pipeline-review-respond`
   step 4 already use).
3. Check approved + mergeable -- reuse `pipeline-merge`'s read-only checks
   (`get_merge_request_approvals`, `get_merge_request`) _without_ invoking a
   merge yet. If not approved/mergeable, this ticket isn't ready; stop this
   step for this ticket (leave it in `In Review`; a later pass will re-check).
4. Transition `In Review -> Testing` (transition name **"In Testing"**, verified
   live above).
5. Transition `Testing -> Verified` is **deferred** -- do not call it here.
   Per the user: "Verified" must only be reached _after_ a successful staging
   deploy, so that a failed deploy leaves the ticket visibly at `Testing`, not
   incorrectly at `Verified`. Continue directly into the existing
   `pipeline-deploy` flow (steps 1-7: find/re-check the ticket, resolve worktree,
   find the MR again -- now already known from step 2 above, no need to re-fetch
   -- merge via `pipeline-merge` skipping its ask per the existing unattended
   exception, find/trigger the pipeline, hand off to `run-pipeline` for
   validation + staging).
6. **Only if** the staging deploy step reports success: transition
   `Testing -> Verified` (transition name **"Finish Testing"**, verified live
   above). This replaces `pipeline-deploy`'s current step 8 behavior of
   deliberately leaving the ticket in `Verified` untouched -- that "leave it,
   a future stage transitions it" design predates this queue and assumed no
   automation existed to do so; now one does, scoped to `REG_AUTOMATED` only.
7. If the staging deploy fails: ticket stays at `Testing` (not rolled back to
   `In Review`) -- accurately reflects "went through review, deploy attempt
   failed" rather than silently reverting review state. Report the failure the
   same way `pipeline-deploy` already does (comment + stop, no auto-retry).

**Scope guard, restated:** every step above filters to `labels = "REG_AUTOMATED"`.
A ticket without that label reaching `In Review` is completely untouched by this
flow -- `pipeline-deploy`'s original `Verified`-only entry point still exists
unchanged for whatever/whoever relies on it today for non-automated tickets.

### Data model (main process, `jira-watcher.ts`)

```ts
interface ProjectQueue {
  implementTaskId: string | null; // created lazily, once per project
  implementAgentId: string | null; // needed to target sendPrompt/onAgentReady
  implementQueue: string[]; // ticket keys waiting, FIFO
  deployTaskId: string | null; // created once per project, alongside Implementer
  deployAgentId: string | null;
  // Deployer has no explicit ticket queue -- see "Deployer window" above.
}
```

Held per-project alongside the existing `watched: Map<string, WatchedProject>`.
Torn down the same way `stopWatchingProject` already clears state today.

### Reviewer configuration (new field)

`EditProjectDialog`'s existing Jira section gets one new field: **default
reviewers** (e.g. `@avnair @spummer`), used verbatim as myl3's `reviewers` input
for every ticket the Implementer queue auto-picks up. Stored the same way
`jiraProjectKey`/`jiraTriggerLabel`/`jiraCompletedLabel` already are (per-project,
in the project record, not memory-only like the Jira email/token credentials).

## Error handling

- **Implementer's current ticket fails** (myl3 aborts/reports a blocker): the
  agent still returns to its idle prompt when myl3 finishes (success or abort),
  so `onAgentReady` fires and the next queued ticket is picked up regardless.
  A stuck/failed ticket does not block the queue. The failed ticket stays in
  whatever state myl3 left it (unchanged from today's per-ticket task behavior).
- **Deployer finds nothing to deploy this cycle**: `/pipeline-deploy` reports "no
  eligible ticket" (existing behavior) or the new step finds no `In Review`
  candidate ready to advance -- not an error, window returns to idle and waits
  for the next cycle.
- **MR not approved/mergeable yet**: ticket simply isn't advanced this cycle
  (see auto-transition step 3); no error, no ticket-state change, tried again
  next cycle.
- **Staging deploy fails**: ticket left at `Testing` (see step 7); reported via
  Jira comment exactly as `pipeline-deploy` already does; no auto-retry within
  the same pass.
- **Both windows are normal Parallel Code tasks**: closing one, or disabling
  "Watch Jira board" for the project, tears down that project's queue state via
  the existing `stopWatchingProject` path, extended to also clear the new
  `ProjectQueue` fields.

## Prerequisite fix bundled with this work

`myl3.md` step 0a: change the "planned state" check from
`"Zu erledigen" / "To Do"` to `"Backlog"` (live-verified above). Without this,
the Implementer queue's every `/myl3` invocation would incorrectly abort.

## Open items deliberately deferred (not blocking this design)

- Configurable per-stage concurrency (>1) -- ship with `1`, revisit if queue
  depth becomes a real bottleneck.
- Any UI surfacing of queue depth/contents (e.g. a "Jira Queue" panel showing
  waiting/running/done per ticket) -- v1 relies on the existing task window's
  own visibility (Implementer/Deployer are real, watchable tasks) plus Jira
  ticket status itself as the source of truth for where each ticket stands.
  Worth a follow-up if queue depth becomes hard to eyeball from Jira alone.

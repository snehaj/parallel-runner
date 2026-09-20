# Jira Implementer/Deployer as self-driving `/loop` tasks

## Problem

`electron/ipc/jira-watcher.ts` (main process) and `src/store/remoteTaskHandler.ts`'s
persistent-task bridge (renderer) implement a poll-and-prompt loop for two long-lived
tasks per project ("Jira Implementer", "Jira Deployer"): a 3-minute main-process timer
polls Jira via a custom REST client (`jira-client.ts`), then round-trips over IPC to the
renderer to create the task, prompt it, and detect when it's idle again
(`ensureImplementerTask`/`ensureDeployerTask`, `promptAgent`, `waitForAgentReady`).

Every bug found and fixed in this project over 2026-09-19/20 traces to that IPC
boundary and the state it requires the main process to cache:

- `jiraFetch` (in `jira-client.ts`) had no request timeout, so a stalled Jira REST call
  hung the per-project `pollingProjectIds` guard indefinitely (fixed: added a 15s
  `AbortController` timeout).
- `promptAgent`'s `callRenderer` round-trip has its own independent 120s timeout, which
  fires under real system load (confirmed live: Microsoft Defender at 72% CPU, load
  average 16-20) before a freshly-spawned CLI finishes booting -- a false failure, not a
  real one.
- Closing a task from the UI left `ProjectQueue.deployTaskId`/`implementTaskId` pointing
  at a task that no longer exists, with no invalidation path (fixed: clear the cache on
  `promptAgent` failure and re-`ensure*Task` next cycle) -- but this whole class of bug
  only exists because the main process keeps a cache of renderer-owned task identity at
  all.
- `handleWaitForAgentReady` used a one-shot `onAgentReady` callback with no polling
  fallback, so an Implementer that finished a ticket and produced no further PTY output
  could sit idle forever, never picking up the next ticket (fixed: delegate to
  `waitUntilAgentReadyForPrompt`, which has the fallback).

Each fix narrowed one failure mode inside the same architecture. The architecture itself
-- infer task lifecycle and readiness from PTY text across an IPC boundary with its own
timeout -- is the recurring source of fragility, not any one bug in it.

## Why not a lighter-weight coordinator sub-agent instead

The `electron/mcp/coordinator.ts` sub-agent pattern was considered and rejected as the
target architecture: it is not actually lighter (same persistent worktree + `claude` CLI
process, same PTY-text-based readiness detection as `jira-watcher.ts`), it just avoids
the renderer-IPC round trip by running entirely in the main process with an explicit
`signal_done` MCP tool call instead of a scraped completion guess. Rebuilding
Implementer/Deployer as coordinator sub-agents would only trade one custom
lifecycle-management system for another. A self-driving `/loop` task needs no external
lifecycle management at all -- once created, nothing outside the task's own Claude Code
session drives it.

## Goals

- Eliminate the IPC-bridge/cache/timeout surface entirely for Implementer and Deployer:
  no `ProjectQueue`, no `promptAgent`/`waitForAgentReady` main<->renderer round trip, no
  custom Jira REST client.
- Each task drives its own ticket-discovery -> action -> reschedule cycle via `/loop`,
  using the Jira MCP tool already available to any interactive Claude Code session in
  this project (the same one `myl3` and `pipeline-deploy` already use) -- no separate
  credential storage.
- Preserve today's operational behavior that's actually load-bearing: one ticket per
  cycle, a failed ticket retries automatically rather than blocking the queue, ~3-minute
  check interval.

## Non-goals

- No change to `myl3` or `pipeline-deploy` themselves -- both are invoked exactly as they
  are today, just from a different caller.
- No change to how manually-created tasks work.
- Multi-ticket-per-cycle throughput, retry backoff/circumvention for a persistently
  failing ticket, and cross-machine/headless hosting (the L4 unattended-agent
  requirements) are explicitly out of scope -- this redesign fixes reliability of the
  existing single-machine, app-must-be-open model, not its L4 shortcomings.

## Architecture

### Before

```
jira-watcher.ts (main, timer)
  --3min poll--> queryLabeledTickets (jira-client.ts REST) --credentials-->
  --IPC--> ensureImplementerTask/ensureDeployerTask (renderer)
  --IPC--> promptAgent (renderer: waitUntilAgentReadyForPrompt + sendPrompt)
  --IPC--> waitForAgentReady (renderer, one-shot then polling)
  <--loops back to poll-->
```

### After

```
"Start Jira Implementer" button (EditProjectDialog)
  --createTask(initialPrompt=IMPLEMENTER_LOOP_PROMPT)--> normal task creation path
                                                          (same as any manual task)

[inside that task's own Claude Code session, entirely self-contained]
  /loop 3m -> query Jira via its own Jira MCP tool -> found ticket?
    yes -> /myl3 <ticket> <reviewers> -> (loop continues regardless of outcome)
    no  -> (loop continues)
```

`jira-watcher.ts`, `jira-client.ts`, and the Jira-specific handlers in
`remoteTaskHandler.ts` are deleted. The only thing the app still owns is: does a
same-named task already exist for this project (to disable the button), and creating one
with the right prompt when clicked.

## Component changes

### Removed entirely

- `electron/ipc/jira-watcher.ts` (652 lines) -- polling timer, `ProjectQueue`,
  `refillImplementerIfIdle`/`refillDeployerIfIdle`, `initJiraWatcherBridge`.
- `electron/ipc/jira-client.ts` (146 lines) -- `jiraFetch`, `queryLabeledTickets`,
  `swapTicketLabel`, credential storage.
- `src/store/jira-watcher.ts` (122 lines) -- renderer-side watch-toggle sync. Also remove
  its call site: `src/App.tsx`'s `startJiraWatcherSubscription()` call and import
  (currently line ~540 and ~92).
- From `src/store/remoteTaskHandler.ts`: `ensurePersistentTask`,
  `handleEnsureImplementerTask`, `handleEnsureDeployerTask`, `handlePromptAgent`,
  `handleWaitForAgentReady`, `handleListTaskNames` (this last one only if nothing else
  uses it -- confirm during implementation), and their IPC channel registrations.
- Jira credentials UI in Settings (email/token fields added in `0c789da`).
- IPC channels: `JiraWatcher_*` (all of them), `SetJiraCredentials`, `StartJiraWatcher`,
  `StopJiraWatcher`, `TriggerJiraCheckNow`, `JiraWatcherStatus`.

### Changed

- **`Project` type** (`src/store/types.ts`): remove `jiraWatchEnabled`,
  `jiraTriggerLabel`, `jiraCompletedLabel`. Keep `jiraProjectKey` and
  `jiraDefaultReviewers` (still needed to fill the prompt templates below). Add nothing
  new -- task existence is derived from the task list, not stored on the project.

- **`EditProjectDialog.tsx`**: replace the "Watch Jira board for labeled tickets"
  checkbox section with two buttons, "Start Jira Implementer" and "Start Jira Deployer".
  Each button:
  - Disabled (or hidden -- implementation detail, functionally equivalent) when a task
    named "Jira Implementer" / "Jira Deployer" already exists for this project (same
    `store.taskOrder`-scan-by-name-and-projectId check `ensurePersistentTask` already
    does today, just run once at dialog-open time and on click rather than on every
    refill).
  - On click: calls `createTask` (the existing renderer function in `src/store/tasks.ts`,
    same one manual "New Task" uses) with `gitIsolation: 'worktree'`,
    `name: 'Jira Implementer'` / `'Jira Deployer'`, and the filled-in prompt template
    below as `initialPrompt`.
  - Both fields (`jiraProjectKey`, `jiraDefaultReviewers`) remain simple text inputs in
    this dialog, unchanged in spirit from today.

### New: prompt templates

Two constants (location: a small new module, e.g. `src/store/jira-loop-prompts.ts`, or
inline in `EditProjectDialog.tsx` if kept short -- implementation detail):

```
IMPLEMENTER_LOOP_PROMPT = (projectKey, reviewers) => `
/loop 3m

Check Jira for ${projectKey} tickets labeled REG_AUTOMATED, assigned to the
current user, with status = Backlog. JQL:

  project = ${projectKey} AND labels = "REG_AUTOMATED" AND assignee = currentUser()
  AND status = Backlog ORDER BY updated ASC

If none found: nothing to do this cycle.

If one or more found: take the OLDEST match only. Run /myl3 <ticket-key> ${reviewers}.
On success, /myl3 handles its own ticket transitions and MR creation -- do not swap
the ticket's label yourself; myl3's own status change (Backlog -> In Progress) is what
keeps this JQL from matching it again next cycle. If /myl3 fails or errors, leave the
ticket exactly as it is (still Backlog, still labeled) -- it will be retried
automatically next cycle. Do not treat a single failed ticket as a reason to stop the
loop.
`

DEPLOYER_LOOP_PROMPT = (projectKey) => `
/loop 3m

Check Jira for ${projectKey} tickets with status = Verified, assigned to the current
user. JQL:

  project = ${projectKey} AND assignee = currentUser() AND status = Verified
  ORDER BY updated ASC

If none found: nothing to do this cycle.

If one or more found: run /pipeline-deploy. It finds and acts on one eligible ticket
itself (same JQL convention) -- you don't need to pass it a specific ticket key. If it
reports failure, leave the ticket's state as /pipeline-deploy left it; it will be
retried automatically next cycle.
`
```

Both take `3m` as the loop interval -- matches today's `TICK_MS`. Not user-configurable
in v1 (YAGNI; today's interval was never configurable either).

`REG_AUTOMATED` stays a real, static Jira label -- what changes is that nothing in this
app ever writes to it anymore (no more swap to `REG_AUTOMATED_SUCC`). A human applies it
once per ticket as today's opt-in gesture; `myl3`'s own status transition is what removes
the ticket from the loop's JQL on the next cycle. The label becomes a permanent marker
("this ticket is in the automated program"), not a workflow state.

`pipeline-deploy`'s own JQL (`status = Verified AND assignee = currentUser()`, no label
filter) is unchanged -- the Deployer loop prompt intentionally does not add a label
condition on top of it, matching `pipeline-deploy`'s existing scope.

## Error handling

- **A single `/myl3` or `/pipeline-deploy` failure**: per the approved design, does not
  stop the loop and does not mark the ticket as handled. The prompt text is the only
  enforcement mechanism for this (there is no code-level retry/backoff) -- rely on
  `/loop`'s own resilience to a sub-task erroring without halting the parent loop.
- **A ticket that fails every single cycle** (bad data, permissions, etc.): retries
  forever with no backoff and no escalation. Explicitly accepted as a known gap (see
  Non-goals) -- a human notices via Jira/MR state, not via an alert from this system.
- **Jira query failure inside the loop** (network blip, auth): handled by whatever the
  Jira MCP tool call's normal error surface is inside a Claude Code turn -- no special
  handling added here; `/loop`'s own next-cycle retry covers a transient failure.
- **App restart**: the task's `claude` CLI process is a real OS process tied to the
  Electron app's lifetime, same as any manual task today -- restarting the app loses the
  loop's in-progress turn (again, same as any manual task today; not a regression this
  redesign introduces or is responsible for fixing).

## Testing

- Unit: the button's disabled/enabled-by-existing-task-name check (pure function over
  `store.taskOrder`/`store.tasks`, same shape as today's `ensurePersistentTask` reuse
  check -- directly portable).
- Unit: prompt-template rendering (given `projectKey` + `reviewers`, produces the exact
  expected string) -- cheap, deterministic, worth covering since a malformed JQL string
  silently breaks the whole loop.
- No unit tests are meaningful for the loop's own runtime behavior (querying Jira,
  calling `/myl3`) -- that logic lives inside a Claude Code session's own turn, not in
  this codebase. Manual verification: click both buttons against a real project, confirm
  each task's terminal shows the expected `/loop` cycle behavior over a couple of
  intervals.
- Deleted-code tests (`jira-watcher.test.ts`, the Jira-specific tests in
  `remoteTaskHandler.test.ts`, `jira-client.test.ts`) are removed alongside their source.

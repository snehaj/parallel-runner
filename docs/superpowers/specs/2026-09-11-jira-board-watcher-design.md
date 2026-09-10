# Per-Project Jira Board Watcher — Design

**Date:** 2026-09-11
**Status:** Approved for planning

## 1. Background

Parallel Code (this fork, `snehaj/parallel-code`) already has an MCP-based `create_task` tool
(`electron/mcp/server.ts`, backed by `createTask` in `electron/ipc/tasks.ts`) that lets a
running coordinator agent spawn sub-tasks programmatically. That flow still requires a human
to start the coordinator task by hand each time.

This feature closes that gap for one specific trigger: a Jira ticket a human has explicitly
flagged for automation. Per project, a background watcher polls for flagged tickets and spawns
a real Parallel Code task for each one — no coordinator, no manual task-creation dialog.

This originated from planning work in `equitystory-ers` (branch `feature/l4-planning-de838c`)
for that repo's Autonomous Agent Quarter (L4) submission, but the feature itself lives entirely
in this repo — it's app functionality, not project-specific configuration.

## 2. Decisions Already Made

| Decision                        | Answer                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira credential source          | Reuse the OAuth session Claude Code's `atlassian` MCP plugin already has — shell out to headless Claude Code (`claude -p ... --output-format json`) rather than have Parallel Code store its own Jira token. Matches the existing precedent in `pr-checks.ts`, which shells out to `gh` rather than managing GitHub credentials itself.                                                           |
| "New ticket" signal             | A human adds Jira's native **Flag** feature to a ticket with reason text `#AUTOMATE_TASK_IR_REG` (exact marker configurable per project). Deliberate opt-in per ticket — not an assignee/status/sprint JQL filter.                                                                                                                                                                                |
| Dedup / already-handled marking | On successful spawn: remove the flag, add label `REG_AUTOMATED` to the ticket. Visible, durable state on the ticket itself — survives app restarts, visible to any human looking at the ticket, no hidden local-only tracking.                                                                                                                                                                    |
| Duplicate-spawn guard           | Before creating a task for a flagged ticket, check whether an existing task's name already contains that ticket key (cheap in-process `listTasks`-equivalent check) and skip if so. Closes the gap where flag-removal fails right after a successful spawn, which would otherwise leave the ticket flagged and re-triggerable next tick.                                                          |
| UI placement                    | Per-project (not global) — matches how `Project` already carries per-project settings (`branchPrefix`, `defaultBaseBranch`, etc.), and avoids needing new ticket→project routing logic that a global watcher would require. Toggle + flag-text field in the existing project settings/edit dialog, **plus** a visible badge/indicator on the project's card in the main view (not settings-only). |
| Architecture pattern            | Mirror `electron/ipc/pr-checks.ts` structurally: a `Map` of watched projects, one shared `setInterval` tick, paused when the window is hidden/minimized (not merely unfocused — same reasoning as PR-checks: the point of background notification is catching something while the user is elsewhere).                                                                                             |
| Task spawn mechanism            | Call `createTask` from `electron/ipc/tasks.ts` **directly, in-process** — not via the MCP HTTP API (`POST /api/tasks`), which exists for out-of-process coordinator sub-agents and would be an unnecessary hop here since the watcher already runs inside the main Electron process.                                                                                                              |

## 3. Architecture

```
                 ┌─────────────────────────────┐
                 │  electron/ipc/jira-watcher.ts │
                 │                               │
   Project A ───▶│  Map<projectId, WatchEntry>   │
   Project B ───▶│  shared setInterval tick      │
                 │                               │
                 └──────────────┬────────────────┘
                                 │ per due project, per tick
                                 ▼
                 ┌─────────────────────────────┐
                 │ 1. query flagged tickets      │  via headless `claude -p`
                 │    (atlassian MCP, JSON out)  │  reusing existing OAuth session
                 └──────────────┬────────────────┘
                                 ▼
                 ┌─────────────────────────────┐
                 │ 2. for each flagged ticket:    │
                 │    - listTasks(), skip if      │  in-process, no HTTP hop
                 │      ticket key already in     │
                 │      an existing task's name   │
                 │    - else createTask({         │
                 │        projectId,              │
                 │        name: "<KEY>: <summary>"│
                 │        prompt: "...",          │
                 │      })                        │
                 └──────────────┬────────────────┘
                                 ▼
                 ┌─────────────────────────────┐
                 │ 3. on successful create:      │  via headless `claude -p`
                 │    remove flag, add label      │  same atlassian MCP session
                 │    REG_AUTOMATED               │
                 └───────────────────────────────┘
```

### New/changed files

- **New**: `electron/ipc/jira-watcher.ts` — the watcher module itself, structurally mirroring
  `pr-checks.ts` (window-lifecycle wiring, `ensureInterval`/`clearTickInterval`,
  `runTick`/`refreshOne`-equivalent per-project poll, disabled/disabledReason state).
- **New**: a small headless-Claude-Code wrapper (likely `electron/ipc/jira-watcher-cli.ts` or
  inlined if small enough) — builds the `claude -p` invocation for (a) querying flagged
  tickets and (b) removing a flag + adding a label. Two thin functions, not a general Jira
  client — this only ever needs those two operations.
- **Changed**: `src/store/types.ts` — `Project` interface gains optional fields:
  `jiraWatchEnabled?: boolean`, `jiraFlagText?: string` (default marker if unset — exact
  default value TBD at implementation time, e.g. `AUTOMATE_TASK_IR_REG`), `jiraCompletedLabel?:
string` (default `REG_AUTOMATED` if unset).
- **Changed**: project settings/edit dialog — new toggle + flag-text field, plus a status line
  (mirroring PR-checks' disabled-reason surfacing: "Watching · last checked Xm ago" /
  "Disabled: Claude Code not authenticated to Jira").
- **Changed**: project card component (wherever projects render in the main sidebar/list) —
  small badge/icon reflecting watch state (lit when watching + authenticated, greyed when off
  or disabled).
- **Changed**: `electron/ipc/register.ts` (or wherever `initPrChecks`-equivalent wiring lives)
  — wire `initJiraWatcher(mainWindow)` the same way.

## 4. Data Flow

Per project with `jiraWatchEnabled: true`, each tick (interval TBD at implementation time —
`pr-checks.ts` uses 30s, but Jira polling has no reason to be that aggressive; something like
2-5 minutes is more appropriate and avoids hammering the Jira API or spinning up headless
Claude Code processes too often):

1. Shell out to headless Claude Code, asking it to use the `atlassian` MCP plugin's JQL search
   to find tickets in this project's Jira project key that carry a flag whose reason text
   matches `jiraFlagText`. Parse structured JSON output (ticket key + summary) — **exact JQL/
   query mechanics for matching on flag reason text are unconfirmed and need verification
   during implementation** (whether flag reason text is directly JQL-queryable or requires
   fetching flagged tickets and filtering client-side).
2. For each ticket found: call `listTasks()`, check if any existing task's `name` field
   contains that ticket key as a substring. If yes, skip (already spawned, flag-removal likely
   just hasn't landed yet or previously failed).
3. If not already spawned: call `createTask({ projectId, name: "<TICKET-KEY>: <summary>",
prompt: "<generated prompt>" })`. Prompt content generation is an implementation detail —
   likely something referencing the ticket key and instructing the spawned agent to use
   existing `myl3`/`pipeline-implement` conventions if the target project has them, or a
   simpler generic prompt otherwise (this watcher is being built as an app-level feature, not
   specific to any one project's conventions).
4. On successful `createTask`: shell out again to headless Claude Code to remove the flag and
   add the `jiraCompletedLabel`. On failure here: log a warning; ticket remains flagged, caught
   by the dedup check in step 2 on the next tick (no duplicate task, but the ticket will look
   perpetually flagged until someone notices and investigates manually).

## 5. Error Handling

- **Headless Claude Code binary missing, or not authenticated to the `atlassian` MCP plugin**:
  disable the watcher (mirroring `pr-checks.ts`'s `disabled` / `disabledReason: 'missing' |
'auth'`), surface this in both the settings status line and the project-card badge. Does not
  crash the app or block other projects' watchers.
- **A single project's poll fails transiently** (network blip, Jira API hiccup): log, leave
  state as-is, retry next tick — same `Promise.all(...).catch(...)` isolation pattern as
  `pr-checks.ts`'s `runTick`, so one project's failure never blocks siblings.
- **`createTask` throws for one ticket**: log, continue to the next flagged ticket in the same
  batch — do not let one bad ticket (e.g. a stale/deleted repo path) abort the whole tick.
- **Flag-removal/label-add fails after a successful spawn**: see step 4 above — degrades to
  "ticket stays flagged, dedup check prevents a second task" rather than silent data loss or
  duplicate spawns.
- **Window hidden/minimized**: polling pauses entirely (same as PR-checks) — resumes on
  `show`/`restore`, with an immediate tick rather than waiting for the next interval.

## 6. Testing / Validation Plan

1. **Unit**: dedup logic (ticket-key-in-existing-task-name check) and disabled-state transitions
   are pure enough to unit test without a real Electron/Jira environment, following whatever
   test harness `pr-checks.test.ts` (if one exists) already uses for its own tick/dedup logic.
2. **Manual, end-to-end**: on a real or throwaway Jira ticket in `DEV_IRREG` — flag it with the
   configured marker text, enable the watcher on the corresponding project, wait for a tick (or
   trigger one manually if the implementation exposes a "check now" action), confirm: a new
   Parallel Code task is created named after the ticket, the flag is removed, the
   `REG_AUTOMATED` label appears on the ticket.
3. **Manual, dedup check**: with a task already spawned for a ticket, manually re-add the same
   flag to that ticket (simulating a flag-removal failure) and confirm the next tick does NOT
   spawn a second task.
4. **Manual, disabled state**: temporarily break Claude Code's `atlassian` auth (or point at a
   binary that doesn't exist) and confirm the watcher disables itself with a visible reason,
   without crashing anything else in the app.

## 7. Known Limitations / Deferred

- **Not real-time.** This is polling-based, same trade-off `pr-checks.ts` already accepts —
  there will always be up to one poll-interval's delay between a ticket being flagged and a
  task appearing.
- **No cross-machine coordination.** If the same fork is running on two machines watching the
  same project, both could poll and both could pass the dedup check before either's `createTask`
  lands, race-condition-spawning two tasks. Out of scope for this design — matches this app's
  existing single-machine-per-developer usage model; not solved here.
- **Prompt content generation is deliberately underspecified in this design** — it's an
  implementation-time detail (what exactly gets put in the spawned task's initial prompt),
  not an architectural decision this spec needs to lock down.
- **Exact poll interval, default flag-text constant, and the flag-reason-text JQL query
  mechanics are implementation details flagged above, not resolved here** — each is a small,
  independently-verifiable choice that doesn't change this design's shape.

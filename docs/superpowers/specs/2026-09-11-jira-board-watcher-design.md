# Per-Project Jira Board Watcher — Design

**Date:** 2026-09-11
**Status:** Approved for planning

## 1. Background

Parallel Code (this fork, `snehaj/parallel-code`) already has an MCP-based `create_task` tool
(`electron/mcp/server.ts`, backed by `createTask` in `electron/ipc/tasks.ts`) that lets a
running coordinator agent spawn sub-tasks programmatically. That flow still requires a human
to start the coordinator task by hand each time.

This feature closes that gap for one specific trigger: a Jira ticket a human has explicitly
labeled for automation. Per project, a background watcher polls for labeled tickets and spawns
a real Parallel Code task for each one — no coordinator, no manual task-creation dialog.

This originated from planning work in `equitystory-ers` (branch `feature/l4-planning-de838c`)
for that repo's Autonomous Agent Quarter (L4) submission, but the feature itself lives entirely
in this repo — it's app functionality, not project-specific configuration.

## 2. Decisions Already Made

| Decision                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jira credential source           | Reuse the OAuth session Claude Code's `atlassian` MCP plugin already has — shell out to headless Claude Code (`claude -p ... --output-format json`) rather than have Parallel Code store its own Jira token. Matches the existing precedent in `pr-checks.ts`, which shells out to `gh` rather than managing GitHub credentials itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| "New ticket" signal              | A human adds Jira label `REG_AUTOMATED` to a ticket (exact label name configurable per project; superseded 2026-09-11 — originally a **Flag** with reason text `#AUTOMATE_TASK_IR_REG`, changed to a label because label membership is directly JQL-queryable, `labels = REG_AUTOMATED`, unlike flag reason text). Deliberate opt-in per ticket — not an assignee/status/sprint JQL filter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Dedup / already-handled marking  | On successful spawn: **remove** `REG_AUTOMATED`, **add** `REG_AUTOMATED_SUCC` to the ticket. Visible, durable state on the ticket itself — survives app restarts, visible to any human looking at the ticket, no hidden local-only tracking. Removing the trigger label (rather than leaving both) keeps the dedup check in the next row a simple presence check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Duplicate-spawn guard            | Before creating a task for a labeled ticket, check whether an existing task's name already contains that ticket key (via the `Remote_ListTaskNamesRequest` round-trip — see "Duplicate-spawn lookup mechanism" below) and skip if so. Closes the gap where label-swap fails right after a successful spawn, which would otherwise leave the ticket labeled `REG_AUTOMATED` and re-triggerable next tick.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI placement                     | Per-project (not global) — matches how `Project` already carries per-project settings (`branchPrefix`, `defaultBaseBranch`, etc.), and avoids needing new ticket→project routing logic that a global watcher would require. Toggle + trigger-label field in the existing project settings/edit dialog, **plus** a visible badge/indicator on the project's card in the main view (not settings-only).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Architecture pattern             | Mirror `electron/ipc/pr-checks.ts` structurally: a `Map` of watched projects, one shared `setInterval` tick, paused when the window is hidden/minimized (not merely unfocused — same reasoning as PR-checks: the point of background notification is catching something while the user is elsewhere).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Task spawn mechanism             | **Corrected 2026-09-11** (see §3 below) — reuse the existing "mobile task-creation bridge" (`register.ts`'s `callRenderer` + `IPC.Remote_CreateTaskRequest`/`Remote_RendererReply`, handled in `remoteTaskHandler.ts`), which asks the renderer to run its real `createTask` (`src/store/tasks.ts`) and reports the resulting `taskId` back. Registered unconditionally in `registerAllHandlers` — independent of whether the separate "Remote Access" HTTP server is running, so using it adds no coupling to that unrelated feature. Supersedes the original "call createTask directly, in-process" decision, which named the wrong function (`electron/ipc/tasks.ts`'s `createTask` only creates a git worktree, not a real task with an agent/store entry — the real logic is renderer-process code, unreachable in-process from the main-process watcher). |
| Duplicate-spawn lookup mechanism | A new, narrow round-trip mirroring the same bridge: `IPC.Remote_ListTaskNamesRequest` (main→renderer via `callRenderer`), handled by a new function in `remoteTaskHandler.ts` returning existing task names for a project. Deliberately narrow (names only, not full task objects) — the duplicate-spawn guard needs nothing more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 3. Architecture

**Correction, 2026-09-11**: the diagram below fixes an architectural error in the original
version of this spec. Step 2 originally said the watcher calls `createTask` "directly,
in-process." That named the wrong function — `electron/ipc/tasks.ts`'s `createTask` only
creates a git worktree (no task record, no agent spawn, no store entry); the _real_
task-creation logic (`src/store/tasks.ts`'s `createTask`) is renderer-process SolidJS-store
code, reachable from the main process only through IPC, never in-process. The corrected
mechanism reuses an existing, already-working main→renderer bridge built for exactly this
kind of need — see the "Task spawn mechanism" and "Duplicate-spawn lookup mechanism" rows in
§2 for why this bridge (not the MCP HTTP API, not a brand-new channel) is the right fit.

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
                 │ 1. query labeled tickets       │  via headless `claude -p`
                 │    (atlassian MCP, JQL:        │  reusing existing OAuth session
                 │    labels = REG_AUTOMATED)      │  directly JQL-queryable
                 └──────────────┬────────────────┘
                                 ▼
                 ┌──────────────────────────────────┐
                 │ 2. for each labeled ticket:        │
                 │    - callRenderer(                 │  main→renderer round-trip,
                 │        Remote_ListTaskNamesRequest, │  reusing the mobile
                 │        { projectId })               │  task-creation bridge
                 │    - skip if ticket key already     │
                 │      in a returned name             │
                 │    - else callRenderer(             │  same bridge; renderer runs
                 │        Remote_CreateTaskRequest,    │  its real createTask and
                 │        { projectId,                 │  replies with the taskId
                 │          name: "<KEY>: <summary>",  │
                 │          prompt: "..." })           │
                 └──────────────┬───────────────────────┘
                                 ▼
                 ┌─────────────────────────────┐
                 │ 3. on successful create:      │  via headless `claude -p`
                 │    remove REG_AUTOMATED,       │  same atlassian MCP session
                 │    add REG_AUTOMATED_SUCC       │
                 └───────────────────────────────┘
```

### New/changed files

- **New**: `electron/ipc/jira-watcher.ts` — the watcher module itself, structurally mirroring
  `pr-checks.ts` (window-lifecycle wiring, `ensureInterval`/`clearTickInterval`,
  `runTick`/`refreshOne`-equivalent per-project poll, disabled/disabledReason state).
- **New**: a small headless-Claude-Code wrapper (likely `electron/ipc/jira-watcher-cli.ts` or
  inlined if small enough) — builds the `claude -p` invocation for (a) querying labeled
  tickets via JQL and (b) swapping the trigger label for the success label. Two thin
  functions, not a general Jira client — this only ever needs those two operations.
- **Changed**: `src/store/types.ts` — `Project` interface gains optional fields:
  `jiraWatchEnabled?: boolean`, `jiraTriggerLabel?: string` (default `REG_AUTOMATED` if
  unset), `jiraCompletedLabel?: string` (default `REG_AUTOMATED_SUCC` if unset).
- **Changed**: project settings/edit dialog — new toggle + trigger-label field, plus a status line
  (mirroring PR-checks' disabled-reason surfacing: "Watching · last checked Xm ago" /
  "Disabled: Claude Code not authenticated to Jira").
- **Changed**: project card component (wherever projects render in the main sidebar/list) —
  small badge/icon reflecting watch state (lit when watching + authenticated, greyed when off
  or disabled).
- **Changed**: `electron/ipc/register.ts` (or wherever `initPrChecks`-equivalent wiring lives)
  — wire `initJiraWatcher(mainWindow)` the same way. Also export (or otherwise expose to
  `jira-watcher.ts`) the existing `callRenderer` helper from the "Mobile task-creation bridge"
  section, and add the new `IPC.Remote_ListTaskNamesRequest` channel alongside the existing
  `Remote_CreateTaskRequest`/`Remote_RendererReply` entries — same request/reply shape, just
  one more request type the bridge answers.
- **Changed**: `electron/ipc/channels.ts` (or its manifest, e.g. `channel-manifest.json`) —
  add the `Remote_ListTaskNamesRequest` channel entry, matching the naming convention already
  used for `Remote_CreateTaskRequest` etc.
- **Changed**: `src/store/remoteTaskHandler.ts` — add a `handleListTaskNames` function
  alongside the existing `handleCreateTask`/`handleGetNotes`, returning
  `store.taskOrder.map(id => store.tasks[id].name)` filtered to the requested `projectId`, and
  subscribe to `IPC.Remote_ListTaskNamesRequest` in `startRemoteTaskHandlers`'s listener setup
  the same way the existing four requests are wired.

## 4. Data Flow

Per project with `jiraWatchEnabled: true`, each tick (interval TBD at implementation time —
`pr-checks.ts` uses 30s, but Jira polling has no reason to be that aggressive; something like
2-5 minutes is more appropriate and avoids hammering the Jira API or spinning up headless
Claude Code processes too often):

1. Shell out to headless Claude Code, asking it to use the `atlassian` MCP plugin's JQL search
   to find tickets in this project's Jira project key matching
   `labels = <jiraTriggerLabel>` (e.g. `project = DEV_IRREG AND labels = REG_AUTOMATED`) —
   directly queryable, no client-side filtering needed. Parse structured JSON output (ticket
   key + summary).
2. For each ticket found: call `callRenderer<string[]>(IPC.Remote_ListTaskNamesRequest,
{ projectId })` — a main→renderer round-trip via the existing mobile-task-creation bridge
   (see §2/§3's corrected "Task spawn mechanism" — this is NOT an in-process call; the
   renderer owns the real task list). Check if any returned name contains that ticket key as
   a substring. If yes, skip (already spawned, the label swap in step 4 likely just hasn't
   landed yet or previously failed).
3. If not already spawned: call `callRenderer<{ taskId: string }>(IPC.Remote_CreateTaskRequest,
{ projectId, name: "<TICKET-KEY>: <summary>", prompt: "<generated prompt>" })` — same
   bridge; the renderer runs its real `createTask` (`src/store/tasks.ts`) and replies with the
   new task's id. Prompt content generation is an implementation detail — likely something
   referencing the ticket key and instructing the spawned agent to use existing
   `myl3`/`pipeline-implement` conventions if the target project has them, or a simpler
   generic prompt otherwise (this watcher is being built as an app-level feature, not
   specific to any one project's conventions).
4. On successful `callRenderer` reply: shell out again to headless Claude Code to remove
   `jiraTriggerLabel` (`REG_AUTOMATED`) and add `jiraCompletedLabel` (`REG_AUTOMATED_SUCC`) on
   the ticket. On failure here: log a warning; the ticket keeps `REG_AUTOMATED`, caught by the
   dedup check in step 2 on the next tick (no duplicate task, but the ticket will look
   perpetually pending until someone notices and investigates manually).

## 5. Error Handling

- **Headless Claude Code binary missing, or not authenticated to the `atlassian` MCP plugin**:
  disable the watcher (mirroring `pr-checks.ts`'s `disabled` / `disabledReason: 'missing' |
'auth'`), surface this in both the settings status line and the project-card badge. Does not
  crash the app or block other projects' watchers.
- **A single project's poll fails transiently** (network blip, Jira API hiccup): log, leave
  state as-is, retry next tick — same `Promise.all(...).catch(...)` isolation pattern as
  `pr-checks.ts`'s `runTick`, so one project's failure never blocks siblings.
- **`callRenderer(Remote_CreateTaskRequest, ...)` throws or rejects for one ticket** (renderer
  reports an error, e.g. project folder missing — same failure `handleCreateTask` already
  reports for the mobile bridge; or the request times out per `callRenderer`'s existing
  120-second timeout, built for exactly this kind of slow worktree-creation call): log,
  continue to the next labeled ticket in the same batch — do not let one bad ticket (e.g. a
  stale/deleted repo path) abort the whole tick.
- **Renderer/window unavailable** (`win.isDestroyed()`): `callRenderer` rejects immediately
  (existing behavior, unchanged) — the whole tick's remaining tickets are skipped for this
  pass rather than each hitting its own 120s timeout; retried next tick once the window is
  back.
- **Label swap fails after a successful spawn**: see step 4 above — degrades to "ticket keeps
  `REG_AUTOMATED`, dedup check prevents a second task" rather than silent data loss or
  duplicate spawns.
- **Window hidden/minimized**: polling pauses entirely (same as PR-checks) — resumes on
  `show`/`restore`, with an immediate tick rather than waiting for the next interval.

## 6. Testing / Validation Plan

1. **Unit**: dedup logic (ticket-key-in-existing-task-name check) and disabled-state transitions
   are pure enough to unit test without a real Electron/Jira environment, following whatever
   test harness `pr-checks.test.ts` (if one exists) already uses for its own tick/dedup logic.
2. **Manual, end-to-end**: on a real or throwaway Jira ticket in `DEV_IRREG` — add the
   `REG_AUTOMATED` label, enable the watcher on the corresponding project, wait for a tick (or
   trigger one manually if the implementation exposes a "check now" action), confirm: a new
   Parallel Code task is created named after the ticket, `REG_AUTOMATED` is removed, and
   `REG_AUTOMATED_SUCC` appears on the ticket.
3. **Manual, dedup check**: with a task already spawned for a ticket, manually re-add the
   `REG_AUTOMATED` label to that ticket (simulating a label-swap failure) and confirm the next
   tick does NOT spawn a second task.
4. **Manual, disabled state**: temporarily break Claude Code's `atlassian` auth (or point at a
   binary that doesn't exist) and confirm the watcher disables itself with a visible reason,
   without crashing anything else in the app.

## 7. Known Limitations / Deferred

- **Not real-time.** This is polling-based, same trade-off `pr-checks.ts` already accepts —
  there will always be up to one poll-interval's delay between a ticket being labeled and a
  task appearing.
- **No cross-machine coordination.** If the same fork is running on two machines watching the
  same project, both could poll and both could pass the dedup check before either's `createTask`
  lands, race-condition-spawning two tasks. Out of scope for this design — matches this app's
  existing single-machine-per-developer usage model; not solved here.
- **Prompt content generation is deliberately underspecified in this design** — it's an
  implementation-time detail (what exactly gets put in the spawned task's initial prompt),
  not an architectural decision this spec needs to lock down.
- **Exact poll interval is an implementation detail flagged above, not resolved here** — a
  small, independently-verifiable choice that doesn't change this design's shape. (The
  flag-reason-text JQL query mechanics this bullet previously flagged as unconfirmed no
  longer apply — labels replaced flags specifically because `labels = X` is directly
  JQL-queryable, closing that open question rather than deferring it.)

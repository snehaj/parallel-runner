# Jira Implementer/Deployer as self-driving `/loop` tasks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `jira-watcher.ts`'s poll-and-prompt-over-IPC architecture with two
plain buttons ("Start Jira Implementer", "Start Jira Deployer") that each create a
normal task whose own Claude Code session drives itself entirely via `/loop` — no IPC
bridge, no main-process cache of renderer-owned task identity, no custom Jira REST
client.

**Architecture:** Delete `electron/ipc/jira-watcher.ts`, `electron/ipc/jira-client.ts`,
`src/store/jira-watcher.ts`, the Jira credentials UI, and the Jira-specific bridge
handlers in `src/store/remoteTaskHandler.ts`. Add two buttons to `EditProjectDialog.tsx`
that call the existing renderer `createTask` function (same path "New Task" already
uses) with a filled-in `/loop` prompt template as `initialPrompt`.

**Tech Stack:** TypeScript, SolidJS (renderer), Electron main process, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-jira-loop-buttons-design.md`

## Global Constraints

- The `REG_AUTOMATED` Jira label is never written to by this app after this change —
  only read. A human applies it once per ticket; nothing here swaps or clears it.
- Loop interval is fixed at `3m` in the prompt text, matching today's `TICK_MS`. Not
  user-configurable in v1.
- `pipeline-deploy`'s own JQL (`status = Verified AND assignee = currentUser()`) is
  unchanged — the Deployer loop prompt adds no label filter on top of it.
- One ticket per loop cycle; a failed `/myl3` or `/pipeline-deploy` call does not stop
  the loop and does not mark the ticket as handled — it retries automatically next
  cycle.
- Every task in this plan must leave `npx tsc --noEmit` and
  `npx eslint <changed files>` clean. Run tests with Node 22
  (`source ~/.nvm/nvm.sh && nvm use 22.13.1`) — the default Node 16 cannot run this
  project's Vite/Electron tooling.

---

### Task 1: Remove the Jira board watcher (main process)

**Files:**
- Delete: `electron/ipc/jira-watcher.ts`
- Delete: `electron/ipc/jira-watcher.test.ts`
- Modify: `electron/ipc/register.ts`
- Modify: `electron/ipc/channel-manifest.json`
- Modify: `electron/preload.cjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing — this task only removes code. Task 4 depends on this task having
  removed the `JiraWatcher_*`/`StartJiraWatcher`/`StopJiraWatcher`/
  `TriggerJiraCheckNow` channels from the manifest so Task 4's own removals in
  `remoteTaskHandler.ts` don't reference dangling channel names.

- [ ] **Step 1: Delete the watcher module and its test file**

```bash
rm electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
```

- [ ] **Step 2: Remove the watcher's imports and wiring from `register.ts`**

In `electron/ipc/register.ts`, remove this import block (currently lines 40-45):

```typescript
import {
  initJiraWatcher,
  startWatchingProject,
  stopWatchingProject,
  triggerJiraCheckNow,
} from './jira-watcher.js';
import { setJiraCredentials } from './jira-client.js';
```

Remove this line (currently lines 855-856, inside the function that registers all
handlers):

```typescript
  // --- Jira board watcher ---
  initJiraWatcher(win);
```

Remove this whole block (currently lines 896-922):

```typescript
  // --- Jira board watcher (per-project start/stop) ---
  ipcMain.handle(IPC.StartJiraWatcher, (_e, args) => {
    assertString(args.projectId, 'projectId');
    startWatchingProject({
      id: args.projectId,
      jiraProjectKey: typeof args.jiraProjectKey === 'string' ? args.jiraProjectKey : undefined,
      jiraTriggerLabel:
        typeof args.jiraTriggerLabel === 'string' ? args.jiraTriggerLabel : undefined,
      jiraCompletedLabel:
        typeof args.jiraCompletedLabel === 'string' ? args.jiraCompletedLabel : undefined,
      jiraDefaultReviewers:
        typeof args.jiraDefaultReviewers === 'string' ? args.jiraDefaultReviewers : undefined,
    });
  });
  ipcMain.handle(IPC.StopJiraWatcher, (_e, args) => {
    assertString(args.projectId, 'projectId');
    stopWatchingProject(args.projectId);
  });
  ipcMain.handle(IPC.TriggerJiraCheckNow, (_e, args) => {
    assertString(args.projectId, 'projectId');
    return triggerJiraCheckNow(args.projectId);
  });
  ipcMain.handle(IPC.SetJiraCredentials, (_e, args) => {
    assertString(args.email, 'email');
    assertString(args.token, 'token');
    setJiraCredentials(args.email, args.token);
  });
```

- [ ] **Step 3: Remove the retired channels from the manifest**

In `electron/ipc/channel-manifest.json`, remove these five entries (the ones only
`jira-watcher.ts`/this dialog used). The four `JiraWatcher_*` sub-agent-bridge entries
are removed later, in Task 4, once `remoteTaskHandler.ts`'s handlers for them are gone
too — leave them in the manifest for now:

```json
  "SetJiraCredentials": "set_jira_credentials",
  "StartJiraWatcher": "start_jira_watcher",
  "StopJiraWatcher": "stop_jira_watcher",
  "JiraWatcherStatus": "jira_watcher_status",
  "TriggerJiraCheckNow": "trigger_jira_check_now"
```

Leave `JiraWatcher_CreateTaskRequest`, `JiraWatcher_ListTaskNamesRequest`,
`JiraWatcher_RendererReply`, `JiraWatcher_EnsureImplementerTaskRequest`,
`JiraWatcher_EnsureDeployerTaskRequest`, `JiraWatcher_PromptAgentRequest`,
`JiraWatcher_WaitForAgentReadyRequest` in place for now — Task 4 removes those (they're
consumed by `remoteTaskHandler.ts`, not this file).

- [ ] **Step 4: Remove the matching entries from `preload.cjs`**

In `electron/preload.cjs`'s `ALLOWED_CHANNELS` Set literal, remove these five string
entries (matching Step 3's removals — leave the `jira_watcher_*` sub-agent-bridge ones
for Task 4):

```
'set_jira_credentials',
'start_jira_watcher',
'stop_jira_watcher',
'jira_watcher_status',
'trigger_jira_check_now',
```

- [ ] **Step 5: Verify the project still compiles**

```bash
source ~/.nvm/nvm.sh && nvm use 22.13.1
cd /Users/sneha/Projects/parallel-runner
npx tsc --noEmit
```

Expected: FAILS with errors in `remoteTaskHandler.ts` (still imports/uses the
`JiraWatcher_*` channels this task didn't touch) and `EditProjectDialog.tsx`/
`SettingsDialog.tsx` (still reference removed channels/functions). This is expected —
Task 4 and Task 6 fix those. Confirm the errors are ONLY in those files, not in
`register.ts` or `channel-manifest.json`'s own consumers — if `register.ts` itself has
an error, fix it before moving on (it should not, since Step 2 removed every use).

- [ ] **Step 6: Commit**

```bash
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts \
        electron/ipc/register.ts electron/ipc/channel-manifest.json electron/preload.cjs
git commit -m "$(cat <<'EOF'
remove jira-watcher.ts and its main-process wiring

First step of retiring the poll-and-prompt-over-IPC architecture (see
docs/superpowers/specs/2026-09-20-jira-loop-buttons-design.md) in favor
of two plain buttons that create self-driving /loop tasks. This step
only removes the main-process watcher and its now-dead IPC channels
(StartJiraWatcher, StopJiraWatcher, TriggerJiraCheckNow,
JiraWatcherStatus, SetJiraCredentials); the renderer-side bridge
handlers and UI follow in later commits.

Leaves the project non-compiling until those follow -- expected,
tracked in the plan.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Remove the Jira REST client

**Files:**
- Delete: `electron/ipc/jira-client.ts`
- Delete: `electron/ipc/jira-client.test.ts`

**Interfaces:**
- Consumes: Task 1 must be complete (no remaining import of `jira-client.js` in
  `register.ts`).
- Produces: nothing — pure removal.

- [ ] **Step 1: Confirm nothing else imports it**

```bash
grep -rln "jira-client" electron src --include="*.ts" --include="*.tsx" | grep -v test
```

Expected: no output (Task 1 already removed `register.ts`'s import).

- [ ] **Step 2: Delete the files**

```bash
rm electron/ipc/jira-client.ts electron/ipc/jira-client.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add electron/ipc/jira-client.ts electron/ipc/jira-client.test.ts
git commit -m "$(cat <<'EOF'
remove jira-client.ts REST client

No longer needed: each loop task now queries Jira via the Jira MCP tool
already available to its own Claude Code session (the same one myl3 and
pipeline-deploy use), not a custom fetch()-based client with its own
credential storage and timeout handling.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Remove the renderer-side watch-toggle sync (`src/store/jira-watcher.ts`)

**Files:**
- Delete: `src/store/jira-watcher.ts`
- Delete: `src/store/jira-watcher.test.ts`
- Delete: `src/store/jira-watcher.client.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: nothing from other tasks — this file's own `StartJiraWatcher`/
  `StopJiraWatcher`/`JiraWatcherStatus` channel usages are already gone from the
  manifest/preload after Task 1, so deleting this file doesn't leave any channel
  dangling on the main-process side.
- Produces: nothing — pure removal. `EditProjectDialog.tsx` (Task 6) must stop
  importing `jiraWatcherStatus`/`jiraWatcherStatusLabel` from this file — confirmed
  handled in Task 6's own edits.

- [ ] **Step 1: Delete the module and its two test files**

```bash
rm src/store/jira-watcher.ts src/store/jira-watcher.test.ts src/store/jira-watcher.client.test.tsx
```

- [ ] **Step 2: Remove its call site from `App.tsx`**

Remove the import (currently line 92):

```typescript
import { startJiraWatcherSubscription } from './store/jira-watcher';
```

Remove the subscription start (currently line 540, inside the effect that starts all
the other subscriptions):

```typescript
    const stopJiraWatcherSubscription = startJiraWatcherSubscription();
```

Remove the matching cleanup call (currently line 740, inside that effect's cleanup
function):

```typescript
      stopJiraWatcherSubscription();
```

- [ ] **Step 3: Confirm nothing else references the deleted module**

```bash
grep -rln "store/jira-watcher'" src --include="*.ts" --include="*.tsx" | grep -v test
```

Expected: no output. (`EditProjectDialog.tsx` still has this import until Task 6 runs
— that's expected and fixed there, not here.)

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git rm src/store/jira-watcher.ts src/store/jira-watcher.test.ts src/store/jira-watcher.client.test.tsx
git commit -m "$(cat <<'EOF'
remove renderer-side Jira watch-toggle sync

src/store/jira-watcher.ts kept store.projects' jiraWatchEnabled flags in
sync with the main-process watcher (now removed in an earlier commit)
and exposed its disabled/disabledReason status to the UI. No longer
needed -- EditProjectDialog.tsx's next commit replaces the toggle it
served with two plain buttons.

Leaves EditProjectDialog.tsx non-compiling until that commit lands --
expected, tracked in the plan.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Remove the Jira-specific bridge handlers from `remoteTaskHandler.ts`

**Files:**
- Modify: `src/store/remoteTaskHandler.ts`
- Modify: `src/store/remoteTaskHandler.test.ts`
- Modify: `electron/ipc/channel-manifest.json`
- Modify: `electron/preload.cjs`

**Interfaces:**
- Consumes: Task 1 (the four `JiraWatcher_Ensure*`/`PromptAgent`/`WaitForAgentReady`
  channels this task removes are otherwise-unused after Task 1).
- Produces: `isKnownTask(tasks: Record<string, unknown>, taskId: string): boolean` and
  `startRemoteTaskHandlers(): () => void` remain exported with unchanged signatures —
  Task 6 (the new buttons) does not call either of these, but other, unrelated
  callers of `isKnownTask` (`handleGetNotes`/`handleSetNotes`, both kept) must keep
  working identically.

- [ ] **Step 1: Remove the Jira-specific interfaces, constants, and functions from `remoteTaskHandler.ts`**

Remove these interfaces (currently lines 50-66):

```typescript
interface ListTaskNamesRequest extends RendererRequest {
  projectId: string;
}

interface EnsureTaskRequest extends RendererRequest {
  projectId: string;
}

interface PromptAgentRequest extends RendererRequest {
  taskId: string;
  agentId: string;
  text: string;
}

interface WaitForAgentReadyRequest extends RendererRequest {
  agentId: string;
}
```

Remove the readiness-wait constant and helper (currently lines 20-29):

```typescript
const AGENT_READY_WAIT_OPTS = {
  stabilityChecks: 2,
  recheckDelayMs: 1_500,
  maxStabilityFailures: 3,
  pollIntervalMs: 500,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Remove `handleJiraCreateTask` (currently lines 148-151):

```typescript
/** Jira board watcher bridge: replies on `JiraWatcher_RendererReply`, which is
 *  where `initJiraWatcherBridge` awaits its pending create-task requests. */
function handleJiraCreateTask(req: CreateTaskRequest): Promise<void> {
  return createTaskForRequest(req, IPC.JiraWatcher_RendererReply);
}
```

Remove `handleListTaskNames` (currently lines 183-189):

```typescript
function handleListTaskNames(req: ListTaskNamesRequest): void {
  const names = store.taskOrder
    .map((id) => store.tasks[id])
    .filter((task) => task?.projectId === req.projectId)
    .map((task) => task.name);
  reply(req.reqId, true, { names }, undefined, IPC.JiraWatcher_RendererReply);
}
```

Remove `ensurePersistentTask`, `handleEnsureImplementerTask`, and
`handleEnsureDeployerTask` (currently lines 189-276 — the whole block between
`handleListTaskNames` and `handlePromptAgent`):

```typescript
/** Shared by EnsureImplementerTask/EnsureDeployerTask -- creates one
 *  persistent, un-prompted task (no initialPrompt) for the given project and
 *  replies with {taskId, agentId}. `name` distinguishes the Implementer's
 *  window from the Deployer's in the task list. */
async function ensurePersistentTask(req: EnsureTaskRequest, name: string): Promise<void> {
  try {
    const project = store.projects.find((p) => p.id === req.projectId);
    if (!project) throw new Error('Project not found');

    // Reuse an existing same-name task for this project if one already
    // exists in the renderer's own task list. The main process's own
    // implementTaskId/deployTaskId cache (jira-watcher.ts's ProjectQueue) is
    // the only other thing that would normally prevent a duplicate, but it
    // resets to empty on every app/dev-server restart while this task list
    // survives -- without this check, the very first refill after any
    // restart always mints a second "Jira Implementer"/"Jira Deployer"
    // window alongside the still-live original.
    const existing = store.taskOrder
      .map((id) => store.tasks[id])
      .find((task) => task?.projectId === req.projectId && task?.name === name);
    if (existing) {
      const existingAgentId = existing.agentIds[0];
      if (existingAgentId) {
        reply(
          req.reqId,
          true,
          { taskId: existing.id, agentId: existingAgentId },
          undefined,
          IPC.JiraWatcher_RendererReply,
        );
        return;
      }
      // Falls through to create a fresh task if the existing record somehow
      // has no agent -- an unexpected but non-fatal state, not worth failing
      // the whole ensure over.
    }

    const agentDef =
      store.availableAgents.find((a) => a.id === store.lastAgentId) ?? store.availableAgents[0];
    if (!agentDef) throw new Error('No agent configured');

    const isGit = project.isGitRepo !== false;
    let baseBranch = '';
    let symlinkDirs: string[] = [];
    if (isGit) {
      baseBranch =
        project.defaultBaseBranch ??
        (await invoke<string>(IPC.GetMainBranch, { projectRoot: project.path }));
      const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
        projectRoot: project.path,
      });
      symlinkDirs = ignoredEntries.filter((entry) => entry.isDefault).map((entry) => entry.name);
    }

    const taskId = await createTask({
      name,
      agentDef,
      projectId: req.projectId,
      gitIsolation: isGit ? 'worktree' : 'none',
      baseBranch,
      symlinkDirs,
      // No initialPrompt -- this task starts idle. The first ticket is
      // delivered via a separate PromptAgent request once this one replies.
    });
    const agentId = store.tasks[taskId]?.agentIds[0];
    if (!agentId) throw new Error('Created task has no agent');

    reply(req.reqId, true, { taskId, agentId }, undefined, IPC.JiraWatcher_RendererReply);
  } catch (err) {
    reply(
      req.reqId,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      IPC.JiraWatcher_RendererReply,
    );
  }
}

function handleEnsureImplementerTask(req: EnsureTaskRequest): Promise<void> {
  return ensurePersistentTask(req, 'Jira Implementer');
}

function handleEnsureDeployerTask(req: EnsureTaskRequest): Promise<void> {
  return ensurePersistentTask(req, 'Jira Deployer');
}
```

Remove `handlePromptAgent` and `handleWaitForAgentReady` in full (currently lines
278-340 through the end of that function):

```typescript
async function handlePromptAgent(req: PromptAgentRequest): Promise<void> {
  try {
    // Reject fast if this task was deleted from the UI since the Jira
    // watcher's main-process cache (jira-watcher.ts's ProjectQueue) last
    // saw it -- that cache has no way to learn a task is gone. Without this
    // check, waitUntilAgentReadyForPrompt below would wait on a dead
    // agentId with no real PTY behind it: readiness can never become true,
    // so the call would hang until the main process's own 120s
    // callRenderer timeout finally gave up, instead of failing in
    // milliseconds so the caller's stale-cache cleanup runs promptly.
    if (!isKnownTask(store.tasks, req.taskId)) {
      throw new Error('Task not found');
    }
    // Wait for the CLI to actually be ready for input before writing anything.
    // Without this, promptAgent can write into a freshly-spawned terminal
    // while Claude Code is still printing its startup banner: the keystrokes
    // land on the banner and are silently dropped, and the ticket never
    // actually starts even though the task window opens. This mirrors the
    // readiness gate PromptInput.tsx's autofire already applies to
    // manually-created tasks.
    await waitUntilAgentReadyForPrompt(
      req.agentId,
      getAgentOutputTail,
      onAgentReady,
      sleep,
      AGENT_READY_WAIT_OPTS,
    );
    await sendPrompt(req.taskId, req.agentId, req.text);
    reply(req.reqId, true, undefined, undefined, IPC.JiraWatcher_RendererReply);
  } catch (err) {
    reply(
      req.reqId,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      IPC.JiraWatcher_RendererReply,
    );
  }
}

async function handleWaitForAgentReady(req: WaitForAgentReadyRequest): Promise<void> {
  // Delegate to waitUntilAgentReadyForPrompt rather than a raw onAgentReady
  // callback -- onAgentReady is one-shot and only fires on NEW PTY output.
  // jira-watcher.ts calls this after a ticket finishes to detect "safe to
  // send the next one"; if the agent settles at its idle prompt and
  // produces no FURTHER output after that point, a raw onAgentReady
  // callback never fires again and the Implementer/Deployer would sit idle
  // forever, never picking up its next ticket -- reproduced live after
  // myl3 completed a ticket. waitUntilAgentReadyForPrompt already has a
  // polling fallback for exactly this (added in 420c22e for promptAgent's
  // own readiness wait, the other caller of this same pattern); reuse it
  // instead of keeping a second copy that lacks it.
  await waitUntilAgentReadyForPrompt(
    req.agentId,
    getAgentOutputTail,
    onAgentReady,
    sleep,
    AGENT_READY_WAIT_OPTS,
  );
  reply(req.reqId, true, undefined, undefined, IPC.JiraWatcher_RendererReply);
}
```

Remove these now-unused imports (currently lines 9-10):

```typescript
import { onAgentReady, getAgentOutputTail } from './taskStatus';
import { waitUntilAgentReadyForPrompt } from './agent-send-readiness';
```

In `startRemoteTaskHandlers`, remove these five listener registrations:

```typescript
  const offListTaskNames = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_ListTaskNamesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleListTaskNames(data as ListTaskNamesRequest);
    },
  );
  const offJiraCreate = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_CreateTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleJiraCreateTask(data as CreateTaskRequest);
    },
  );
  const offEnsureImplementer = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_EnsureImplementerTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleEnsureImplementerTask(data as EnsureTaskRequest);
    },
  );
  const offEnsureDeployer = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_EnsureDeployerTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleEnsureDeployerTask(data as EnsureTaskRequest);
    },
  );
  const offPromptAgent = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_PromptAgentRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handlePromptAgent(data as PromptAgentRequest);
    },
  );
  const offWaitForAgentReady = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_WaitForAgentReadyRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleWaitForAgentReady(data as WaitForAgentReadyRequest);
    },
  );
```

And their corresponding six unsubscribe calls in the returned cleanup function:

```typescript
    offListTaskNames();
    offJiraCreate();
    offEnsureImplementer();
    offEnsureDeployer();
    offPromptAgent();
    offWaitForAgentReady();
```

(Keep `offProjects`, `offCreate`, `offGetNotes`, `offSetNotes` and their registrations —
those are the general-purpose mobile-remote handlers, unrelated to Jira.)

- [ ] **Step 2: Rewrite `remoteTaskHandler.test.ts` to keep only the `isKnownTask` tests**

Replace the entire file content with:

```typescript
/* eslint-disable solid/reactivity -- these tests read the store proxy synchronously to exercise isKnownTask; no reactive tracking is involved. */
import { describe, it, expect } from 'vitest';
import { createStore } from 'solid-js/store';
import { isKnownTask } from './remoteTaskHandler';

// Guards the prototype-pollution fix: a mobile HTTP request supplies the task
// id, and Solid's store proxy resolves inherited keys to prototype objects.
// isKnownTask must accept only real own task entries so that a later
// updateTaskNotes -> setStore('tasks', id, 'notes', …) can never target
// Object.prototype / Function.prototype via an inherited key.
describe('isKnownTask', () => {
  const [store] = createStore<{ tasks: Record<string, { notes: string }> }>({
    tasks: { 'task-1': { notes: '' }, 'task-2': { notes: 'x' } },
  });

  it('accepts real own task ids', () => {
    expect(isKnownTask(store.tasks, 'task-1')).toBe(true);
    expect(isKnownTask(store.tasks, 'task-2')).toBe(true);
  });

  it('rejects missing ids', () => {
    expect(isKnownTask(store.tasks, 'nope')).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects the inherited/dangerous key %s',
    (key) => {
      expect(isKnownTask(store.tasks, key)).toBe(false);
    },
  );

  it('would be fooled by a truthiness guard on the same proxy (documents why hasOwn is needed)', () => {
    // These inherited keys read back truthy through the store proxy, which is
    // exactly the trap the old `if (!store.tasks[id])` guard fell into.
    const proxied = store.tasks as Record<string, unknown>;
    expect(Boolean(proxied['constructor'])).toBe(true);
    expect(Boolean(proxied['toString'])).toBe(true);
    // …yet isKnownTask correctly rejects them.
    expect(isKnownTask(store.tasks, 'constructor')).toBe(false);
    expect(isKnownTask(store.tasks, 'toString')).toBe(false);
  });
});
```

This drops the `handleListTaskNames`, `handleJiraCreateTask`, and "Jira watcher
persistent-task bridge handlers" `describe` blocks (previously lines 85-602) along
with the mock scaffolding (`vi.hoisted`, three `vi.mock` calls, `mockOn`/
`listenerFor`) that only those blocks used — none of it is needed to test the pure
`isKnownTask` function.

- [ ] **Step 3: Remove the now-fully-retired Jira channels from the manifest**

In `electron/ipc/channel-manifest.json`, remove:

```json
  "JiraWatcher_CreateTaskRequest": "jira_watcher_create_task_request",
  "JiraWatcher_ListTaskNamesRequest": "jira_watcher_list_task_names_request",
  "JiraWatcher_RendererReply": "jira_watcher_renderer_reply",
  "JiraWatcher_EnsureImplementerTaskRequest": "jira_watcher_ensure_implementer_task_request",
  "JiraWatcher_EnsureDeployerTaskRequest": "jira_watcher_ensure_deployer_task_request",
  "JiraWatcher_PromptAgentRequest": "jira_watcher_prompt_agent_request",
  "JiraWatcher_WaitForAgentReadyRequest": "jira_watcher_wait_for_agent_ready_request",
```

After this step, `grep -c Jira electron/ipc/channel-manifest.json` must return `0`.

- [ ] **Step 4: Remove the matching entries from `preload.cjs`**

In `electron/preload.cjs`'s `ALLOWED_CHANNELS` Set literal, remove:

```
'jira_watcher_create_task_request',
'jira_watcher_list_task_names_request',
'jira_watcher_renderer_reply',
'jira_watcher_ensure_implementer_task_request',
'jira_watcher_ensure_deployer_task_request',
'jira_watcher_prompt_agent_request',
'jira_watcher_wait_for_agent_ready_request',
```

After this step, `grep -c jira_watcher electron/preload.cjs` must return `0`.

- [ ] **Step 5: Run the test file to confirm it passes**

```bash
source ~/.nvm/nvm.sh && nvm use 22.13.1
cd /Users/sneha/Projects/parallel-runner
npx vitest run src/store/remoteTaskHandler.test.ts
```

Expected: PASS, all `isKnownTask` tests green (this file no longer contains any other
tests).

- [ ] **Step 6: Check for remaining type errors**

```bash
npx tsc --noEmit
```

Expected: remaining errors should now be ONLY in `EditProjectDialog.tsx`,
`SettingsDialog.tsx`, `src/store/ui.ts`, `src/store/store.ts`, `src/store/types.ts`,
`src/ipc/types.ts`, `electron/ipc/shared-types.ts`, and their test files — everything
this task and Task 1 didn't yet touch. If `remoteTaskHandler.ts` itself has an error,
fix it before proceeding.

- [ ] **Step 7: Commit**

```bash
git add src/store/remoteTaskHandler.ts src/store/remoteTaskHandler.test.ts \
        electron/ipc/channel-manifest.json electron/preload.cjs
git commit -m "$(cat <<'EOF'
remove Jira-specific bridge handlers from remoteTaskHandler.ts

Removes ensurePersistentTask, handleEnsureImplementerTask,
handleEnsureDeployerTask, handlePromptAgent, handleWaitForAgentReady,
handleListTaskNames, and handleJiraCreateTask -- the renderer-side half
of jira-watcher.ts's IPC bridge, now unreachable after its main-process
half was removed. isKnownTask and the general-purpose mobile-remote
handlers (handleGetNotes/handleSetNotes/handleCreateTask/
handleGetProjects) are untouched -- they have real, non-Jira callers.

All JiraWatcher_* IPC channels are now fully retired from the manifest
and preload allowlist.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Remove Jira credentials from Settings and the `Project` type

**Files:**
- Modify: `src/components/SettingsDialog.tsx`
- Modify: `src/components/SettingsDialog.client.test.tsx` (delete)
- Modify: `src/store/ui.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/types.ts`
- Modify: `src/ipc/types.ts`
- Modify: `electron/ipc/shared-types.ts`
- Modify: `src/store/projects.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (independent of Tasks 1-4's files).
- Produces: `Project` type (in `src/store/types.ts`) retains `jiraProjectKey?: string`
  and `jiraDefaultReviewers?: string` — Task 6 reads both fields by name.

- [ ] **Step 1: Remove the Jira fields section from `SettingsDialog.tsx`**

Remove the `setJiraEmail, setJiraToken` entries from the import block near the top of
the file (added alongside `setMinimaxApiKey`).

Remove the whole Jira section `<div>` (the block titled `Jira` containing the Email and
API token `<label>`/`<input>` pairs, immediately after the MiniMax API key section).

- [ ] **Step 2: Delete the Settings Jira test file**

```bash
rm src/components/SettingsDialog.client.test.tsx
```

- [ ] **Step 3: Remove `setJiraEmail`/`setJiraToken` from `ui.ts`**

Remove:

```typescript
// Local buffers so either Jira field's onInput can send both values together
// -- the main process always expects {email, token} as a pair (there's no
// separate "set just the email" IPC call). Memory-only, same as the values
// they forward to jira-client.ts's own memory-only storage.
let jiraEmailBuffer = '';
let jiraTokenBuffer = '';

export function setJiraEmail(email: string): void {
  jiraEmailBuffer = email.trim();
  invoke(IPC.SetJiraCredentials, { email: jiraEmailBuffer, token: jiraTokenBuffer }).catch((e) =>
    console.warn('Failed to set Jira credentials:', e),
  );
}

export function setJiraToken(token: string): void {
  jiraTokenBuffer = token.trim();
  invoke(IPC.SetJiraCredentials, { email: jiraEmailBuffer, token: jiraTokenBuffer }).catch((e) =>
    console.warn('Failed to set Jira credentials:', e),
  );
}
```

- [ ] **Step 4: Remove the re-export from `store.ts`**

Remove the `setJiraEmail,` and `setJiraToken,` lines from the barrel re-export list.

- [ ] **Step 5: Remove the retired Jira fields from the `Project` type**

In `src/store/types.ts`, replace:

```typescript
  /** Enables the per-project Jira board watcher (polls for labeled tickets
   *  and spawns a task for each). Default false/unset — opt-in per project. */
  jiraWatchEnabled?: boolean;
  /** Jira label that marks a ticket for automatic pickup. Default
   *  'REG_AUTOMATED' if unset — see jira-watcher.ts's DEFAULT_TRIGGER_LABEL. */
  jiraTriggerLabel?: string;
  /** Jira label applied (replacing jiraTriggerLabel) once a task has been
   *  spawned for a ticket. Default 'REG_AUTOMATED_SUCC' if unset — see
   *  jira-watcher.ts's DEFAULT_COMPLETED_LABEL. */
  jiraCompletedLabel?: string;
  /** Jira project key (e.g. 'DEV_IRREG') this project's watcher queries.
   *  Required for the watcher to do anything useful — unset means the
   *  watcher has nothing to query and effectively does nothing even if
   *  jiraWatchEnabled is true. */
  jiraProjectKey?: string;
  /** Default reviewers string (e.g. '@avnair @spummer') passed verbatim as
   *  myl3's `reviewers` argument for every ticket the Implementer queue
   *  auto-picks up. Unset means myl3 runs without named reviewers. */
  jiraDefaultReviewers?: string;
```

with:

```typescript
  /** Jira project key (e.g. 'DEV_IRREG') used to fill in the Implementer/Deployer
   *  loop-task prompt templates in EditProjectDialog. Required for either
   *  "Start Jira Implementer"/"Start Jira Deployer" button to produce a working
   *  prompt — unset means the button is disabled. */
  jiraProjectKey?: string;
  /** Default reviewers string (e.g. '@avnair @spummer') baked into the
   *  Implementer loop-task's prompt as myl3's `reviewers` argument for every
   *  ticket it picks up. Unset means myl3 runs without named reviewers. */
  jiraDefaultReviewers?: string;
```

- [ ] **Step 6: Remove `JiraWatcherStatusPayload` from the shared type files**

In `electron/ipc/shared-types.ts`, remove:

```typescript
/*  watcher's availability changes, plus once when a project starts being
 *  watched so the renderer has an initial state. 'no-credentials' = no Jira
 *  email/token configured in Settings, 'auth' = Jira rejected the
 *  credentials (401/403). */
export interface JiraWatcherStatusPayload {
  disabled: boolean;
  disabledReason: 'no-credentials' | 'auth' | null;
}
```

(Check the line immediately above this block — it is the tail end of a longer doc
comment for a different, still-needed export; remove only the
`JiraWatcherStatusPayload`-specific lines shown above, not the comment lines that
belong to the preceding export.)

In `src/ipc/types.ts`, remove the `JiraWatcherStatusPayload,` line from its re-export
list.

- [ ] **Step 7: Update `projects.test.ts`**

Remove the entire `describe('updateProject — Jira watch fields', ...)` block:

```typescript
describe('updateProject — Jira watch fields', () => {
  beforeEach(() => {
    setStore('projects', []);
  });

  it('persists jiraWatchEnabled, jiraTriggerLabel, and jiraCompletedLabel', () => {
    const id = addProject('Test Project', '/tmp/test-project');
    updateProject(id, {
      jiraWatchEnabled: true,
      jiraTriggerLabel: 'REG_AUTOMATED',
      jiraCompletedLabel: 'REG_AUTOMATED_SUCC',
    });
    const project = getProject(id);
    expect(project?.jiraWatchEnabled).toBe(true);
    expect(project?.jiraTriggerLabel).toBe('REG_AUTOMATED');
    expect(project?.jiraCompletedLabel).toBe('REG_AUTOMATED_SUCC');
  });

  it('can clear jiraWatchEnabled back to false', () => {
    const id = addProject('Test Project', '/tmp/test-project');
    updateProject(id, { jiraWatchEnabled: true });
    updateProject(id, { jiraWatchEnabled: false });
    expect(getProject(id)?.jiraWatchEnabled).toBe(false);
  });
});
```

- [ ] **Step 8: Run the affected test suites**

```bash
source ~/.nvm/nvm.sh && nvm use 22.13.1
cd /Users/sneha/Projects/parallel-runner
npx vitest run src/store/projects.test.ts
```

Expected: PASS (no Jira-watch-field tests remain to fail).

- [ ] **Step 9: Commit**

```bash
git add src/components/SettingsDialog.tsx src/store/ui.ts src/store/store.ts \
        src/store/types.ts src/ipc/types.ts electron/ipc/shared-types.ts \
        src/store/projects.test.ts
git rm src/components/SettingsDialog.client.test.tsx
git commit -m "$(cat <<'EOF'
remove Jira credentials UI and retired Project fields

Jira credentials are no longer needed: each loop task queries Jira via
its own Claude Code session's Jira MCP tool, not a stored email/token
pair. Removes jiraWatchEnabled/jiraTriggerLabel/jiraCompletedLabel from
the Project type -- jiraProjectKey and jiraDefaultReviewers stay, still
needed to fill the loop-task prompt templates (added in the next
commit).

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add the two loop-task buttons to `EditProjectDialog.tsx`

**Files:**
- Create: `src/store/jira-loop-prompts.ts`
- Create: `src/store/jira-loop-prompts.test.ts`
- Modify: `src/components/EditProjectDialog.tsx`

**Interfaces:**
- Consumes: `createTask` from `src/store/tasks.ts` (signature:
  `createTask(opts: CreateTaskOptions): Promise<string>`, already defined, unchanged
  by this plan); `store` from `src/store/core.ts` (`store.taskOrder: string[]`,
  `store.tasks: Record<string, Task>` where each `Task` has `.projectId: string` and
  `.name: string`); `Project.jiraProjectKey`/`Project.jiraDefaultReviewers` (Task 5).
- Produces: `IMPLEMENTER_LOOP_PROMPT(projectKey: string, reviewers: string): string`
  and `DEPLOYER_LOOP_PROMPT(projectKey: string): string`, both exported from
  `src/store/jira-loop-prompts.ts`. `hasTaskNamed(taskOrder: string[], tasks:
  Record<string, { projectId: string; name: string }>, projectId: string, name:
  string): boolean`, exported from the same file — a same-project reuse check with the
  same shape as `ensurePersistentTask`'s reuse check, but as a small standalone
  function this task can unit test directly.

- [ ] **Step 1: Write the failing test for the prompt templates and the reuse check**

Create `src/store/jira-loop-prompts.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { IMPLEMENTER_LOOP_PROMPT, DEPLOYER_LOOP_PROMPT, hasTaskNamed } from './jira-loop-prompts';

describe('IMPLEMENTER_LOOP_PROMPT', () => {
  it('embeds the project key in the JQL and the reviewers in the /myl3 call', () => {
    const prompt = IMPLEMENTER_LOOP_PROMPT('DEV_IRREG', '@nkhan');
    expect(prompt).toContain('/loop 3m');
    expect(prompt).toContain(
      'project = DEV_IRREG AND labels = "REG_AUTOMATED" AND assignee = currentUser()',
    );
    expect(prompt).toContain('AND status = Backlog ORDER BY updated ASC');
    expect(prompt).toContain('Run /myl3 <ticket-key> @nkhan.');
    expect(prompt).toContain('do not swap the ticket\'s label yourself');
  });

  it('works with an empty reviewers string', () => {
    const prompt = IMPLEMENTER_LOOP_PROMPT('DEV_IRREG', '');
    expect(prompt).toContain('Run /myl3 <ticket-key> .');
  });
});

describe('DEPLOYER_LOOP_PROMPT', () => {
  it('embeds the project key in the JQL and defers to /pipeline-deploy', () => {
    const prompt = DEPLOYER_LOOP_PROMPT('DEV_IRREG');
    expect(prompt).toContain('/loop 3m');
    expect(prompt).toContain('project = DEV_IRREG AND assignee = currentUser() AND status = Verified');
    expect(prompt).not.toContain('REG_AUTOMATED');
    expect(prompt).toContain('run /pipeline-deploy');
  });
});

describe('hasTaskNamed', () => {
  const tasks = {
    't1': { projectId: 'proj-1', name: 'Jira Implementer' },
    't2': { projectId: 'proj-2', name: 'Jira Implementer' },
    't3': { projectId: 'proj-1', name: 'Some other task' },
  };
  const taskOrder = ['t1', 't2', 't3'];

  it('finds a matching task by project and name', () => {
    expect(hasTaskNamed(taskOrder, tasks, 'proj-1', 'Jira Implementer')).toBe(true);
  });

  it('does not match a same-named task in a different project', () => {
    expect(hasTaskNamed(taskOrder, tasks, 'proj-3', 'Jira Implementer')).toBe(false);
  });

  it('does not match a different-named task in the same project', () => {
    expect(hasTaskNamed(taskOrder, tasks, 'proj-1', 'Jira Deployer')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
source ~/.nvm/nvm.sh && nvm use 22.13.1
cd /Users/sneha/Projects/parallel-runner
npx vitest run src/store/jira-loop-prompts.test.ts
```

Expected: FAIL — `src/store/jira-loop-prompts.ts` does not exist yet.

- [ ] **Step 3: Write `src/store/jira-loop-prompts.ts`**

```typescript
// Prompt templates and task-reuse check for the Jira Implementer/Deployer
// loop-task buttons in EditProjectDialog.tsx. See
// docs/superpowers/specs/2026-09-20-jira-loop-buttons-design.md.
//
// Each button creates one normal task (same createTask path "New Task"
// uses) whose initialPrompt is one of these templates. From that point on,
// the task's own Claude Code session drives itself entirely via /loop --
// nothing in this app ever prompts it again.

export function IMPLEMENTER_LOOP_PROMPT(projectKey: string, reviewers: string): string {
  return `/loop 3m

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
loop.`;
}

export function DEPLOYER_LOOP_PROMPT(projectKey: string): string {
  return `/loop 3m

Check Jira for ${projectKey} tickets with status = Verified, assigned to the current
user. JQL:

  project = ${projectKey} AND assignee = currentUser() AND status = Verified
  ORDER BY updated ASC

If none found: nothing to do this cycle.

If one or more found: run /pipeline-deploy. It finds and acts on one eligible ticket
itself (same JQL convention) -- you don't need to pass it a specific ticket key. If it
reports failure, leave the ticket's state as /pipeline-deploy left it; it will be
retried automatically next cycle.`;
}

/** True when a task named `name`, belonging to `projectId`, already exists in
 *  `tasks` (per `taskOrder`). Same reuse check `ensurePersistentTask` used to
 *  do inline before it was removed -- used here to disable a loop-task
 *  button once its task already exists, so a second click can't spawn a
 *  duplicate loop racing the first on the same tickets. */
export function hasTaskNamed(
  taskOrder: string[],
  tasks: Record<string, { projectId: string; name: string } | undefined>,
  projectId: string,
  name: string,
): boolean {
  return taskOrder.some((id) => {
    const task = tasks[id];
    return task?.projectId === projectId && task?.name === name;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/store/jira-loop-prompts.test.ts
```

Expected: PASS, all tests green.

- [ ] **Step 5: Commit the new module**

```bash
git add src/store/jira-loop-prompts.ts src/store/jira-loop-prompts.test.ts
git commit -m "$(cat <<'EOF'
add Jira Implementer/Deployer loop-task prompt templates

Pure functions: IMPLEMENTER_LOOP_PROMPT/DEPLOYER_LOOP_PROMPT render the
approved /loop prompt text for a given project key (+ reviewers for the
Implementer); hasTaskNamed is the same task-list reuse check
ensurePersistentTask used to do inline, extracted so EditProjectDialog's
buttons can disable themselves without duplicating the logic.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Replace the "Watch Jira board" section in `EditProjectDialog.tsx` with two buttons**

Remove these five signals (no longer backed by any `Project` field):

```typescript
  const [jiraWatchEnabled, setJiraWatchEnabled] = createSignal(false);
  const [checkingNow, setCheckingNow] = createSignal(false);
  const [checkNowResult, setCheckNowResult] = createSignal<string | null>(null);
  const [checkNowError, setCheckNowError] = createSignal<string | null>(null);
```

(Keep `jiraProjectKey`/`jiraTriggerLabel`/`jiraCompletedLabel`/`jiraDefaultReviewers`
signals for now — the next sub-step removes `jiraTriggerLabel`/`jiraCompletedLabel`
specifically since those fields no longer exist on `Project`.)

Remove `setJiraTriggerLabel`/`setJiraCompletedLabel` and their signals:

```typescript
  const [jiraTriggerLabel, setJiraTriggerLabel] = createSignal('');
  const [jiraCompletedLabel, setJiraCompletedLabel] = createSignal('');
```

In the `createEffect` that syncs signals from `props.project`, remove:

```typescript
    setJiraWatchEnabled(p.jiraWatchEnabled ?? false);
```
```typescript
    setJiraTriggerLabel(p.jiraTriggerLabel ?? '');
    setJiraCompletedLabel(p.jiraCompletedLabel ?? '');
```
```typescript
    setCheckNowResult(null);
    setCheckNowError(null);
```

Remove the `handleTriggerNow` function entirely:

```typescript
  async function handleTriggerNow() {
    if (!props.project) return;
    setCheckingNow(true);
    setCheckNowError(null);
    setCheckNowResult(null);
    try {
      await invoke(IPC.TriggerJiraCheckNow, { projectId: props.project.id });
      setCheckNowResult('Checked Jira just now.');
    } catch (err) {
      setCheckNowError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingNow(false);
    }
  }
```

Add two new handler functions in its place (same location — right after the signal
declarations, before `handleSave`):

```typescript
  const [starting, setStarting] = createSignal<'implementer' | 'deployer' | null>(null);
  const [startError, setStartError] = createSignal<string | null>(null);

  function implementerRunning(): boolean {
    const p = props.project;
    if (!p) return false;
    return hasTaskNamed(store.taskOrder, store.tasks, p.id, 'Jira Implementer');
  }

  function deployerRunning(): boolean {
    const p = props.project;
    if (!p) return false;
    return hasTaskNamed(store.taskOrder, store.tasks, p.id, 'Jira Deployer');
  }

  async function startImplementer() {
    const p = props.project;
    if (!p || !p.jiraProjectKey?.trim()) return;
    setStartError(null);
    setStarting('implementer');
    try {
      const agentDef = store.availableAgents.find((a) => a.id === store.lastAgentId) ??
        store.availableAgents[0];
      if (!agentDef) throw new Error('No agent configured');
      const isGit = p.isGitRepo !== false;
      let baseBranch = '';
      let symlinkDirs: string[] = [];
      if (isGit) {
        baseBranch =
          p.defaultBaseBranch ?? (await invoke<string>(IPC.GetMainBranch, { projectRoot: p.path }));
        const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
          projectRoot: p.path,
        });
        symlinkDirs = ignoredEntries.filter((entry) => entry.isDefault).map((entry) => entry.name);
      }
      await createTask({
        name: 'Jira Implementer',
        agentDef,
        projectId: p.id,
        gitIsolation: isGit ? 'worktree' : 'none',
        baseBranch,
        symlinkDirs,
        initialPrompt: IMPLEMENTER_LOOP_PROMPT(p.jiraProjectKey.trim(), jiraDefaultReviewers().trim()),
      });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(null);
    }
  }

  async function startDeployer() {
    const p = props.project;
    if (!p || !p.jiraProjectKey?.trim()) return;
    setStartError(null);
    setStarting('deployer');
    try {
      const agentDef = store.availableAgents.find((a) => a.id === store.lastAgentId) ??
        store.availableAgents[0];
      if (!agentDef) throw new Error('No agent configured');
      const isGit = p.isGitRepo !== false;
      let baseBranch = '';
      let symlinkDirs: string[] = [];
      if (isGit) {
        baseBranch =
          p.defaultBaseBranch ?? (await invoke<string>(IPC.GetMainBranch, { projectRoot: p.path }));
        const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
          projectRoot: p.path,
        });
        symlinkDirs = ignoredEntries.filter((entry) => entry.isDefault).map((entry) => entry.name);
      }
      await createTask({
        name: 'Jira Deployer',
        agentDef,
        projectId: p.id,
        gitIsolation: isGit ? 'worktree' : 'none',
        baseBranch,
        symlinkDirs,
        initialPrompt: DEPLOYER_LOOP_PROMPT(p.jiraProjectKey.trim()),
      });
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(null);
    }
  }
```

Add the required imports at the top of the file:

```typescript
import { createTask } from '../store/tasks';
import { store } from '../store/core';
import { IMPLEMENTER_LOOP_PROMPT, DEPLOYER_LOOP_PROMPT, hasTaskNamed } from '../store/jira-loop-prompts';
import type { GitIgnoredEntry } from '../ipc/types';
```

Remove the now-unused import (this dialog no longer references
`jiraWatcherStatus`/`jiraWatcherStatusLabel`):

```typescript
import { jiraWatcherStatus, jiraWatcherStatusLabel } from '../store/jira-watcher';
```

Replace the whole `{/* Jira board watcher */}` section (the `<div>` containing the
checkbox, `Show when={jiraWatchEnabled()}`, "Check Jira now" button, and the trigger
label/completed label/default reviewers inputs) with:

```tsx
            {/* Jira Implementer / Deployer loop tasks */}
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
              <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>
                Jira automation
              </div>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <label style={sectionLabelStyle}>Jira project key</label>
                <input
                  class="input-field"
                  type="text"
                  value={jiraProjectKey()}
                  onInput={(e) => setJiraProjectKey(e.currentTarget.value)}
                  placeholder="DEV_IRREG"
                  style={{
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    padding: '10px 14px',
                    color: theme.fg,
                    'font-size': '14px',
                    'font-family': "'JetBrains Mono', monospace",
                    outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <label style={sectionLabelStyle}>
                  Default reviewers{' '}
                  <span style={{ opacity: '0.5', 'text-transform': 'none' }}>
                    (e.g. @avnair @spummer)
                  </span>
                </label>
                <input
                  class="input-field"
                  type="text"
                  value={jiraDefaultReviewers()}
                  onInput={(e) => setJiraDefaultReviewers(e.currentTarget.value)}
                  placeholder="@avnair @spummer"
                  style={{
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    padding: '10px 14px',
                    color: theme.fg,
                    'font-size': '14px',
                    'font-family': "'JetBrains Mono', monospace",
                    outline: 'none',
                  }}
                />
                <div style={{ 'font-size': '12px', color: theme.fgSubtle, padding: '2px 2px 0' }}>
                  Baked into the Implementer's /loop prompt as myl3's reviewers argument.
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  disabled={!jiraProjectKey().trim() || implementerRunning() || starting() !== null}
                  onClick={startImplementer}
                  style={{
                    padding: '6px 14px',
                    background: theme.accent,
                    border: 'none',
                    'border-radius': '8px',
                    color: theme.accentText,
                    cursor:
                      !jiraProjectKey().trim() || implementerRunning() || starting() !== null
                        ? 'not-allowed'
                        : 'pointer',
                    'font-size': '13px',
                    'font-weight': '600',
                    opacity:
                      !jiraProjectKey().trim() || implementerRunning() || starting() !== null
                        ? '0.5'
                        : '1',
                  }}
                >
                  {implementerRunning()
                    ? 'Implementer running'
                    : starting() === 'implementer'
                      ? 'Starting…'
                      : 'Start Jira Implementer'}
                </button>
                <button
                  type="button"
                  disabled={!jiraProjectKey().trim() || deployerRunning() || starting() !== null}
                  onClick={startDeployer}
                  style={{
                    padding: '6px 14px',
                    background: theme.accent,
                    border: 'none',
                    'border-radius': '8px',
                    color: theme.accentText,
                    cursor:
                      !jiraProjectKey().trim() || deployerRunning() || starting() !== null
                        ? 'not-allowed'
                        : 'pointer',
                    'font-size': '13px',
                    'font-weight': '600',
                    opacity:
                      !jiraProjectKey().trim() || deployerRunning() || starting() !== null
                        ? '0.5'
                        : '1',
                  }}
                >
                  {deployerRunning()
                    ? 'Deployer running'
                    : starting() === 'deployer'
                      ? 'Starting…'
                      : 'Start Jira Deployer'}
                </button>
              </div>
              <Show when={startError()}>
                <div style={{ 'font-size': '12px', color: theme.warning }}>{startError()}</div>
              </Show>
            </div>
```

- [ ] **Step 7: Remove the retired fields from `handleSave`'s `updateProject` call**

In `handleSave`, remove:

```typescript
      jiraWatchEnabled: jiraWatchEnabled(),
      jiraTriggerLabel: jiraTriggerLabel().trim() || undefined,
      jiraCompletedLabel: jiraCompletedLabel().trim() || undefined,
```

Keep `jiraProjectKey: jiraProjectKey().trim() || undefined,` and
`jiraDefaultReviewers: jiraDefaultReviewers().trim() || undefined,` — both fields
still exist on `Project` and still need saving.

- [ ] **Step 8: Typecheck and lint**

```bash
source ~/.nvm/nvm.sh && nvm use 22.13.1
cd /Users/sneha/Projects/parallel-runner
npx tsc --noEmit
npx eslint src/components/EditProjectDialog.tsx src/store/jira-loop-prompts.ts \
  src/store/jira-loop-prompts.test.ts
```

Expected: both clean. If `tsc --noEmit` reports errors anywhere outside
`EditProjectDialog.tsx`, stop and investigate — every other file should already be
clean after Tasks 1-4.

- [ ] **Step 9: Run the full test suite**

```bash
npx vitest run
```

Expected: no failures beyond the 4 pre-existing, unrelated `claude-usage.test.ts`
failures already confirmed present on `main` before this plan started (network-mock
assertions unrelated to Jira). If any other file fails, stop and fix before
committing.

- [ ] **Step 10: Commit**

```bash
git add src/components/EditProjectDialog.tsx
git commit -m "$(cat <<'EOF'
add Start Jira Implementer / Start Jira Deployer buttons

Replaces the "Watch Jira board for labeled tickets" checkbox and its
Check-Jira-now/trigger-label/completed-label fields with two buttons.
Each creates one normal task (same createTask path "New Task" already
uses) with a /loop-based initialPrompt (jira-loop-prompts.ts) -- the
task's own Claude Code session then drives its own Jira polling and
/myl3 or /pipeline-deploy dispatch, with no further involvement from
this app. Buttons disable once a same-named task exists for the
project (hasTaskNamed), preventing a duplicate loop.

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Manual end-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the fully-merged result of Tasks 1-5.
- Produces: nothing — this task is a checklist, not code.

- [ ] **Step 1: Restart the dev app**

From a terminal OTHER than any one currently hosting a Claude Code session inside this
app (restarting the app would kill a session running inside it):

```bash
cd /Users/sneha/Projects/parallel-runner
npm run dev
```

- [ ] **Step 2: Open a project's settings and confirm the new UI**

Open Edit Project for a project with a real `jiraProjectKey` already set. Confirm:
- The "Watch Jira board" checkbox and "Check Jira now" button are gone.
- "Jira project key" and "Default reviewers" fields are present, pre-filled from the
  project's existing values.
- "Start Jira Implementer" and "Start Jira Deployer" buttons are present and enabled
  (assuming no task named either already exists for this project).

- [ ] **Step 3: Click "Start Jira Implementer"**

Confirm: a new task named "Jira Implementer" appears in the task list, with a real
worktree/branch. Open its terminal — confirm the initial prompt sent was the `/loop 3m`
text from `IMPLEMENTER_LOOP_PROMPT`, and that `/loop` itself accepted it (no "unknown
command" error). Confirm the "Start Jira Implementer" button in Edit Project is now
disabled/shows "Implementer running".

- [ ] **Step 4: Click "Start Jira Deployer"**

Same check as Step 3, for "Jira Deployer" and `/pipeline-deploy`.

- [ ] **Step 5: Label one real ticket and wait one loop cycle (~3 minutes)**

In Jira, label a `Backlog` ticket assigned to the current user with `REG_AUTOMATED`.
Wait for the Implementer's next `/loop` cycle. Confirm it runs `/myl3 <that-ticket>
<reviewers>` — check the terminal output and/or that the ticket's status changes.

- [ ] **Step 6: Confirm no regression in manually-created tasks**

Create a normal task via "New Task" unrelated to Jira. Confirm it still works exactly
as before (this plan touched `EditProjectDialog.tsx` and `remoteTaskHandler.ts`, both
also used by non-Jira flows — `handleGetNotes`/`handleSetNotes`/`handleCreateTask`/
`handleGetProjects` must be unaffected).

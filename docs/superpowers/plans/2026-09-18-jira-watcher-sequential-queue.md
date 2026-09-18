# Jira Watcher Sequential Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "one task window per matching ticket, unthrottled" with two persistent, self-refilling task windows per Jira-watched project — an Implementer looping over Backlog tickets via `/myl3`, and a Deployer looping over In-Review tickets ready to merge+deploy via `/pipeline-deploy` — plus the auto-transition step that feeds the Deployer.

**Architecture:** Main process (`jira-watcher.ts`) keeps owning ticket discovery and per-project queue state (a `implementQueue: string[]` FIFO array). It drives two persistent Parallel Code tasks via three new bridge methods added to the existing main↔renderer request/reply pattern: `ensureImplementerTask`/`ensureDeployerTask` (create-once, get `{taskId, agentId}`), `promptAgent` (wraps the renderer's real `sendPrompt`), and `waitForAgentReady` (wraps `onAgentReady`, resolves once). Renderer-side handlers live in `remoteTaskHandler.ts` alongside the existing Jira bridge handlers.

**Tech Stack:** TypeScript, Electron main process, SolidJS renderer store, Vitest with `vi.mock('electron', ...)` (main) and `vi.mock('../lib/ipc', ...)` (renderer) mocking patterns already used in this codebase.

**Spec:** `docs/superpowers/specs/2026-09-18-jira-watcher-sequential-queue-design.md`

## Global Constraints

- Repos touched: `parallel-code-local` (Tasks 1-8, the Electron app) and `equitystory-ers` (Tasks 9-10, `myl3.md` + `pipeline-deploy/SKILL.md`) — two separate git repos, two separate commit histories.
- Concurrency is exactly 1 active ticket per stage (Implementer, Deployer) — no configurable limit in this iteration.
- Auto-transition (`In Review -> Testing -> Verified`) only ever touches tickets labeled `REG_AUTOMATED` — never a human-driven ticket.
- Live-verified Jira transition names (do not guess different ones): `Backlog --"Start progress"--> In Progress`, `In Progress --"Start review"--> In Review`, `In Review --"In Testing"--> Testing`, `Testing --"Finish Testing"--> Verified`.
- `myl3.md`'s "planned" status check must say `"Backlog"`, not `"Zu erledigen" / "To Do"` (live-verified bug).
- Deployer's `Testing -> Verified` transition only fires after the staging deploy step reports success — never before.
- No new "enable auto-deploy" toggle — both windows are created together, driven by the existing "Watch Jira board" toggle.

---

### Task 1: Extend the IPC channel manifest for the new bridge methods

**Files:**

- Modify: `electron/ipc/channel-manifest.json`
- Modify: `electron/preload.cjs`
- Test: `electron/preload-allowlist.test.ts` (existing test, no changes needed — it validates the manifest/enum/preload-literal stay in sync automatically)

**Interfaces:**

- Consumes: nothing (leaf infra task).
- Produces: `IPC.JiraWatcher_EnsureImplementerTaskRequest`, `IPC.JiraWatcher_EnsureDeployerTaskRequest`, `IPC.JiraWatcher_PromptAgentRequest`, `IPC.JiraWatcher_WaitForAgentReadyRequest` — main→renderer request channels. All four reuse the existing `IPC.JiraWatcher_RendererReply` reply channel (same pattern as `JiraWatcher_CreateTaskRequest`/`JiraWatcher_ListTaskNamesRequest` already do — one reply channel, many request channels, correlated by `reqId`). Task 2 imports these four new enum values.

- [ ] **Step 1: Add the four new channels to the manifest**

In `electron/ipc/channel-manifest.json`, after the line `"JiraWatcherStatus": "jira_watcher_status",` (and before `"TriggerJiraCheckNow": "trigger_jira_check_now"`), insert:

```json
  "JiraWatcher_EnsureImplementerTaskRequest": "jira_watcher_ensure_implementer_task_request",
  "JiraWatcher_EnsureDeployerTaskRequest": "jira_watcher_ensure_deployer_task_request",
  "JiraWatcher_PromptAgentRequest": "jira_watcher_prompt_agent_request",
  "JiraWatcher_WaitForAgentReadyRequest": "jira_watcher_wait_for_agent_ready_request",
```

(Keep `"TriggerJiraCheckNow": "trigger_jira_check_now"` as the last entry, unchanged — it's already last in the file.)

- [ ] **Step 2: Add the same four channels to preload's inline allowlist**

In `electron/preload.cjs`, find the line `'trigger_jira_check_now',` inside the `ALLOWED_CHANNELS` array (near the end) and add the four new snake_case values immediately before it:

```javascript
  'jira_watcher_ensure_implementer_task_request',
  'jira_watcher_ensure_deployer_task_request',
  'jira_watcher_prompt_agent_request',
  'jira_watcher_wait_for_agent_ready_request',
  'trigger_jira_check_now',
```

- [ ] **Step 3: Run the existing sync-check test**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/preload-allowlist.test.ts
```

Expected: PASS (3/3) — this test asserts the manifest, the `IPC` enum derived from it, and preload's literal array all contain exactly the same set of values. If it fails, the snake_case string in preload.cjs doesn't exactly match the manifest value — compare them character-for-character.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/channel-manifest.json electron/preload.cjs
git commit -m "feat(jira-watcher): add IPC channels for persistent-task bridge

Four new main->renderer request channels (EnsureImplementerTask,
EnsureDeployerTask, PromptAgent, WaitForAgentReady), all replying on
the existing JiraWatcher_RendererReply channel -- same
request/reply-by-reqId pattern the create-task/list-task-names bridge
already uses. No behavior change yet; wiring lands in later tasks.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Extend `initJiraWatcherBridge` with the three new bridge methods

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Test: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: `IPC.JiraWatcher_EnsureImplementerTaskRequest`, `IPC.JiraWatcher_EnsureDeployerTaskRequest`, `IPC.JiraWatcher_PromptAgentRequest`, `IPC.JiraWatcher_WaitForAgentReadyRequest`, `IPC.JiraWatcher_RendererReply` (Task 1).
- Produces: `initJiraWatcherBridge(win)` now also returns:
  - `ensureImplementerTask(projectId: string): Promise<{taskId: string; agentId: string}>`
  - `ensureDeployerTask(projectId: string): Promise<{taskId: string; agentId: string}>`
  - `promptAgent(taskId: string, agentId: string, text: string): Promise<void>`
  - `waitForAgentReady(agentId: string): Promise<void>`

  Task 5 (queue logic) and Task 6 (renderer handlers) consume these exact names and signatures.

- [ ] **Step 1: Write the failing tests**

Add to `electron/ipc/jira-watcher.test.ts`, inside a new `describe('initJiraWatcherBridge — persistent task methods', ...)` block placed after the existing `describe('initJiraWatcherBridge', ...)` block:

```typescript
describe('initJiraWatcherBridge — persistent task methods', () => {
  it('ensureImplementerTask sends a request and resolves with {taskId, agentId}', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    const bridge = initJiraWatcherBridge(win);

    const promise = bridge.ensureImplementerTask('proj-1');
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.JiraWatcher_EnsureImplementerTaskRequest);
    const reqId = (sent[0].payload as { reqId: string }).reqId;

    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, { reqId, ok: true, data: { taskId: 'task-1', agentId: 'agent-1' } });

    await expect(promise).resolves.toEqual({ taskId: 'task-1', agentId: 'agent-1' });
  });

  it('ensureDeployerTask sends its own distinct request channel', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    const bridge = initJiraWatcherBridge(win);

    const promise = bridge.ensureDeployerTask('proj-1');
    expect(sent[0].channel).toBe(IPC.JiraWatcher_EnsureDeployerTaskRequest);
    const reqId = (sent[0].payload as { reqId: string }).reqId;

    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, { reqId, ok: true, data: { taskId: 'task-2', agentId: 'agent-2' } });

    await expect(promise).resolves.toEqual({ taskId: 'task-2', agentId: 'agent-2' });
  });

  it('promptAgent sends taskId/agentId/text and resolves on an ok reply', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    const bridge = initJiraWatcherBridge(win);

    const promise = bridge.promptAgent('task-1', 'agent-1', '/myl3 DEV_IRREG-1 @a');
    expect(sent[0].channel).toBe(IPC.JiraWatcher_PromptAgentRequest);
    expect(sent[0].payload).toMatchObject({
      taskId: 'task-1',
      agentId: 'agent-1',
      text: '/myl3 DEV_IRREG-1 @a',
    });
    const reqId = (sent[0].payload as { reqId: string }).reqId;

    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, { reqId, ok: true, data: undefined });

    await expect(promise).resolves.toBeUndefined();
  });

  it('waitForAgentReady sends agentId and resolves once, with no fixed timeout applied', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    const bridge = initJiraWatcherBridge(win);

    const promise = bridge.waitForAgentReady('agent-1');
    expect(sent[0].channel).toBe(IPC.JiraWatcher_WaitForAgentReadyRequest);
    expect(sent[0].payload).toMatchObject({ agentId: 'agent-1' });
    const reqId = (sent[0].payload as { reqId: string }).reqId;

    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, { reqId, ok: true, data: undefined });

    await expect(promise).resolves.toBeUndefined();
  });

  it('promptAgent rejects immediately if the window is destroyed', async () => {
    const win = { isDestroyed: () => true } as unknown as import('electron').BrowserWindow;
    const bridge = initJiraWatcherBridge(win);
    await expect(bridge.promptAgent('t', 'a', 'text')).rejects.toThrow(
      'Desktop app is not available',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: FAIL — `bridge.ensureImplementerTask is not a function` (and similarly for the other three). Also expect `IPC.JiraWatcher_EnsureImplementerTaskRequest` etc. to be `undefined` (TypeScript would catch this at compile time too, but vitest runs on the transpiled output so it surfaces as a runtime `undefined` channel value — that's fine, still confirms nothing is wired yet).

- [ ] **Step 3: Implement the four new bridge methods**

In `electron/ipc/jira-watcher.ts`, modify the return type and return statement of `initJiraWatcherBridge`:

```typescript
export function initJiraWatcherBridge(win: BrowserWindow): {
  createTask: (opts: { projectId: string; name: string; prompt: string }) => Promise<{
    taskId: string;
  }>;
  listTaskNames: (projectId: string) => Promise<string[]>;
  ensureImplementerTask: (projectId: string) => Promise<{ taskId: string; agentId: string }>;
  ensureDeployerTask: (projectId: string) => Promise<{ taskId: string; agentId: string }>;
  promptAgent: (taskId: string, agentId: string, text: string) => Promise<void>;
  waitForAgentReady: (agentId: string) => Promise<void>;
} {
  const pending = new Map<string, PendingRequest>();

  function callRenderer<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (win.isDestroyed()) {
        reject(new Error('Desktop app is not available'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('Desktop app did not respond'));
      }, 120_000);
      pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      win.webContents.send(channel, { reqId, ...payload });
    });
  }

  ipcMain.handle(
    IPC.JiraWatcher_RendererReply,
    (_e, args: { reqId: string; ok: boolean; data?: unknown; error?: string }) => {
      const entry = pending.get(args.reqId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(args.reqId);
      if (args.ok) entry.resolve(args.data);
      else entry.reject(new Error(args.error ?? 'Request failed'));
    },
  );

  return {
    createTask: (opts) => callRenderer<{ taskId: string }>(IPC.JiraWatcher_CreateTaskRequest, opts),
    listTaskNames: (projectId) =>
      callRenderer<{ names: string[] }>(IPC.JiraWatcher_ListTaskNamesRequest, {
        projectId,
      }).then((r) => r.names),
    ensureImplementerTask: (projectId) =>
      callRenderer<{ taskId: string; agentId: string }>(
        IPC.JiraWatcher_EnsureImplementerTaskRequest,
        { projectId },
      ),
    ensureDeployerTask: (projectId) =>
      callRenderer<{ taskId: string; agentId: string }>(IPC.JiraWatcher_EnsureDeployerTaskRequest, {
        projectId,
      }),
    promptAgent: (taskId, agentId, text) =>
      callRenderer<void>(IPC.JiraWatcher_PromptAgentRequest, { taskId, agentId, text }),
    waitForAgentReady: (agentId) =>
      callRenderer<void>(IPC.JiraWatcher_WaitForAgentReadyRequest, { agentId }),
  };
}
```

Note: `waitForAgentReady` deliberately reuses `callRenderer`'s existing 120s timeout mechanism _as a safety net only_ — the renderer side (Task 6) resolves the reply the moment `onAgentReady` fires, which for a real ticket may take much longer than 120s. Task 6's handler must NOT reply within 120s of nothing happening; instead it registers the `onAgentReady` callback and only replies when it actually fires (potentially minutes/hours later). To avoid the 120s cap firing spuriously on a slow ticket, Task 3 will extend `callRenderer` with a per-call timeout override — see Task 3, Step 1.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: PASS (all tests, including the 5 new ones and all pre-existing ones).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "feat(jira-watcher): add persistent-task bridge methods

ensureImplementerTask/ensureDeployerTask/promptAgent/waitForAgentReady,
same request/reply-by-reqId pattern as the existing createTask/
listTaskNames methods. Nothing calls these yet -- renderer-side
handlers and queue logic land in later tasks.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Remove the fixed 120s timeout for `waitForAgentReady` specifically

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Test: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: `callRenderer` (Task 2, internal to `jira-watcher.ts`).
- Produces: `callRenderer` gains an optional third parameter `timeoutMs?: number`; `waitForAgentReady` passes `0` (meaning "no timeout" — see implementation) while every other call site is unchanged (still defaults to 120_000).

- [ ] **Step 1: Write the failing test**

Add to the `describe('initJiraWatcherBridge — persistent task methods', ...)` block from Task 2:

```typescript
it('waitForAgentReady does not time out even after the default 120s window (uses no timeout)', async () => {
  vi.useFakeTimers();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = fakeWindow(sent);
  const bridge = initJiraWatcherBridge(win);

  const promise = bridge.waitForAgentReady('agent-1');
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );

  vi.advanceTimersByTime(200_000); // well past the normal 120s callRenderer timeout
  await Promise.resolve();
  expect(settled).toBe(false); // still pending -- no spurious timeout rejection

  const reqId = (sent[0].payload as { reqId: string }).reqId;
  const replyHandler = (
    ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
  ).__handlers.get(IPC.JiraWatcher_RendererReply);
  replyHandler?.(null, { reqId, ok: true, data: undefined });

  await expect(promise).resolves.toBeUndefined();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts -t "does not time out"
```

Expected: FAIL — `settled` is `true` after 200s (the promise rejected with "Desktop app did not respond" at the 120s mark), not `false` as asserted.

- [ ] **Step 3: Make `callRenderer` accept an optional timeout override**

In `electron/ipc/jira-watcher.ts`, modify `callRenderer`'s signature and body:

```typescript
function callRenderer<T>(
  channel: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<T> {
  const reqId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    if (win.isDestroyed()) {
      reject(new Error('Desktop app is not available'));
      return;
    }
    pending.set(reqId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      // 0 disables the timeout entirely -- waitForAgentReady can legitimately
      // stay pending for as long as the ticket's own work takes (minutes to
      // hours), unlike every other bridge call here which is a quick
      // request/reply round-trip.
      timer:
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(reqId);
              reject(new Error('Desktop app did not respond'));
            }, timeoutMs)
          : (undefined as unknown as NodeJS.Timeout),
    });
    win.webContents.send(channel, { reqId, ...payload });
  });
}
```

And update `PendingRequest`'s `timer` field to allow `undefined`:

```typescript
interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
}
```

And in the `JiraWatcher_RendererReply` handler, guard the `clearTimeout` call:

```typescript
ipcMain.handle(
  IPC.JiraWatcher_RendererReply,
  (_e, args: { reqId: string; ok: boolean; data?: unknown; error?: string }) => {
    const entry = pending.get(args.reqId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(args.reqId);
    if (args.ok) entry.resolve(args.data);
    else entry.reject(new Error(args.error ?? 'Request failed'));
  },
);
```

Finally, update `waitForAgentReady`'s call site to pass `0`:

```typescript
    waitForAgentReady: (agentId) =>
      callRenderer<void>(IPC.JiraWatcher_WaitForAgentReadyRequest, { agentId }, 0),
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: PASS (all tests, including the "does not time out" test and every pre-existing test — `createTask`/`listTaskNames`/`ensureImplementerTask`/etc. all still default to the 120s timeout since they omit the third argument).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "fix(jira-watcher): waitForAgentReady must not use the 120s bridge timeout

Every other bridge call is a quick request/reply round-trip, so the
existing 120s timeout is a reasonable safety net for them. A ticket's
real work can run far longer than that, so waitForAgentReady now opts
out of the timeout entirely via a new optional callRenderer parameter
-- every other call site is unchanged (still defaults to 120s).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Add `ProjectQueue` state and teardown to `jira-watcher.ts`

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Test: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: an internal `Map<string, ProjectQueue>` (not exported) plus an exported test seam `getProjectQueueStateForTests(projectId: string): { implementQueue: string[] } | undefined`. Task 5 (queue-refill logic) reads/writes this map; `stopWatchingProject` now also deletes a project's entry.

- [ ] **Step 1: Write the failing test**

Add to `electron/ipc/jira-watcher.test.ts`, in a new top-level `describe('ProjectQueue lifecycle', ...)` block:

```typescript
describe('ProjectQueue lifecycle', () => {
  beforeEach(() => {
    __resetJiraWatcherForTests();
  });

  it('has no queue entry for a project that was never started', () => {
    expect(getProjectQueueStateForTests('proj-1')).toBeUndefined();
  });

  it('creates an empty implementQueue when a project starts watching', () => {
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    expect(getProjectQueueStateForTests('proj-1')).toEqual({ implementQueue: [] });
    stopWatchingProject('proj-1');
  });

  it('clears the queue entry when the project stops watching', () => {
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    stopWatchingProject('proj-1');
    expect(getProjectQueueStateForTests('proj-1')).toBeUndefined();
  });
});
```

Also add the new import to the top of the test file's existing import block from `./jira-watcher.js`:

```typescript
  getProjectQueueStateForTests,
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts -t "ProjectQueue lifecycle"
```

Expected: FAIL — `getProjectQueueStateForTests is not a function` / import error.

- [ ] **Step 3: Implement the queue state**

In `electron/ipc/jira-watcher.ts`, add near the top (after the `WatchedProject` interface):

```typescript
interface ProjectQueue {
  /** Ticket keys waiting for the Implementer window, FIFO. Does not include
   *  the ticket currently being worked -- that one has already been dequeued
   *  and handed to myl3 via promptAgent; this array is only "not yet started". */
  implementQueue: string[];
  /** Set once ensureImplementerTask's create-task round-trip resolves. Reused
   *  on every subsequent refill so the window is created at most once per
   *  project. */
  implementTaskId: string | null;
  implementAgentId: string | null;
  /** Set once ensureDeployerTask's create-task round-trip resolves. The
   *  Deployer has no explicit ticket queue -- see jira-watcher-sequential-
   *  queue-design.md's "Deployer window" section. */
  deployTaskId: string | null;
  deployAgentId: string | null;
}

function emptyProjectQueue(): ProjectQueue {
  return {
    implementQueue: [],
    implementTaskId: null,
    implementAgentId: null,
    deployTaskId: null,
    deployAgentId: null,
  };
}
```

Add a module-level map alongside `watched`:

```typescript
let projectQueues = new Map<string, ProjectQueue>();
```

In `startWatchingProject`, after the existing `watched.set(...)` call, add:

```typescript
if (!projectQueues.has(project.id)) {
  projectQueues.set(project.id, emptyProjectQueue());
}
```

In `stopWatchingProject`, add a line to clear the queue entry:

```typescript
export function stopWatchingProject(projectId: string): void {
  watched.delete(projectId);
  projectQueues.delete(projectId);
  if (watched.size === 0) clearJiraTickInterval();
}
```

In `__resetJiraWatcherForTests`, add:

```typescript
projectQueues = new Map();
```

Add the new test seam near the other `--- Test seams ---` exports:

```typescript
export function getProjectQueueStateForTests(
  projectId: string,
): { implementQueue: string[] } | undefined {
  const q = projectQueues.get(projectId);
  return q ? { implementQueue: [...q.implementQueue] } : undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "feat(jira-watcher): add per-project ProjectQueue state

Empty implementQueue + task/agent id slots, created on
startWatchingProject and torn down on stopWatchingProject -- mirrors
the existing WatchedProject lifecycle. Nothing populates the queue
yet; that's Task 5.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Change ticket discovery to enqueue instead of immediately creating a task

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Test: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: `ProjectQueue` (Task 4), `ensureImplementerTask`/`promptAgent`/`waitForAgentReady` (Task 2/3), `jiraBridge.listTaskNames` (existing).
- Produces: `pollOneProject`'s ticket-found branch now enqueues + triggers a refill instead of calling `jiraBridge.createTask` directly. A new internal `refillImplementerIfIdle(projectId)` function (not exported — Task 6/7 don't need to call it directly, only the poll path does) is added. Default reviewers are threaded through from `WatchedProject` (extended with a new field).

- [ ] **Step 1: Write the failing tests**

Replace the existing test `'spawns a task for a newly labeled ticket, then swaps its label'` in `electron/ipc/jira-watcher.test.ts` (inside `describe('watcher tick', ...)`) — this test currently asserts the OLD immediate-create behavior, which Step 3 will change. Update it to assert the new enqueue + ensure-task + prompt flow instead:

```typescript
it('enqueues a newly labeled ticket, creates the Implementer task once, then prompts it with /myl3', async () => {
  vi.mocked(queryLabeledTickets).mockResolvedValue([
    { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
  ]);

  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = fakeWindow(sent);
  initJiraWatcher(win);
  startWatchingProject({
    id: 'proj-1',
    jiraProjectKey: 'DEV_IRREG',
    jiraTriggerLabel: 'REG_AUTOMATED',
    jiraCompletedLabel: 'REG_AUTOMATED_SUCC',
    jiraDefaultReviewers: '@avnair @spummer',
  });

  await flushPromises();
  replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
  await flushPromises();

  // No task was created yet for the ticket directly -- the Implementer
  // task is created once, generically, not per-ticket.
  expect(sent.some((s) => s.channel === IPC.JiraWatcher_CreateTaskRequest)).toBe(false);

  const ensureReq = sent
    .filter((s) => s.channel === IPC.JiraWatcher_EnsureImplementerTaskRequest)
    .pop();
  expect(ensureReq).toBeDefined();
  replyToLatest(sent, IPC.JiraWatcher_EnsureImplementerTaskRequest, {
    taskId: 'impl-task-1',
    agentId: 'impl-agent-1',
  });
  await flushPromises();

  const promptReq = sent.filter((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest).pop();
  expect(promptReq).toBeDefined();
  expect(promptReq?.payload).toMatchObject({
    taskId: 'impl-task-1',
    agentId: 'impl-agent-1',
    text: '/myl3 DEV_IRREG-1234 @avnair @spummer',
  });
  replyToLatest(sent, IPC.JiraWatcher_PromptAgentRequest, undefined);
  await flushPromises();

  stopWatchingProject('proj-1');
});
```

Add a second new test for the "already busy, don't double-prompt" case:

```typescript
it('leaves a ticket queued (does not prompt again) while the Implementer is already busy with a prior ticket', async () => {
  vi.mocked(queryLabeledTickets).mockResolvedValueOnce([{ key: 'DEV_IRREG-1', summary: 'First' }]);

  const sent: Array<{ channel: string; payload: unknown }> = [];
  const win = fakeWindow(sent);
  initJiraWatcher(win);
  startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
  await flushPromises();
  replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
  await flushPromises();
  replyToLatest(sent, IPC.JiraWatcher_EnsureImplementerTaskRequest, {
    taskId: 'impl-task-1',
    agentId: 'impl-agent-1',
  });
  await flushPromises();
  // First ticket's prompt is in flight (promptAgent request sent, not yet replied) --
  // this represents "Implementer busy."
  expect(sent.filter((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest)).toHaveLength(1);

  sent.length = 0;
  vi.mocked(queryLabeledTickets).mockResolvedValueOnce([
    { key: 'DEV_IRREG-1', summary: 'First' },
    { key: 'DEV_IRREG-2', summary: 'Second' },
  ]);
  await __runJiraTickForTests();
  await flushPromises();
  replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
  await flushPromises();

  // DEV_IRREG-2 is new and gets queued, but no second promptAgent fires --
  // the Implementer is still busy with DEV_IRREG-1's in-flight prompt.
  expect(getProjectQueueStateForTests('proj-1')?.implementQueue).toEqual(['DEV_IRREG-2']);
  expect(sent.some((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest)).toBe(false);

  stopWatchingProject('proj-1');
});
```

Add the two new imports needed (`getProjectQueueStateForTests` already added in Task 4).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: FAIL — the first replaced test fails because `pollOneProject` still calls `jiraBridge.createTask` directly (old behavior); `sent.some(s => s.channel === IPC.JiraWatcher_CreateTaskRequest)` is `true`, not `false`. The second test fails because `getProjectQueueStateForTests('proj-1')?.implementQueue` is `[]`, not `['DEV_IRREG-2']` (nothing enqueues yet).

- [ ] **Step 3: Implement enqueue + refill logic**

In `electron/ipc/jira-watcher.ts`, extend `WatchedProject`:

```typescript
interface WatchedProject {
  id: string;
  jiraProjectKey: string;
  triggerLabel: string;
  completedLabel: string;
  /** Default reviewers string (e.g. "@avnair @spummer") passed verbatim as
   *  myl3's `reviewers` argument for every auto-queued ticket. Empty string
   *  if unset -- myl3 still runs but without named reviewers on the MR. */
  defaultReviewers: string;
}
```

Update `startWatchingProject`'s signature and body to accept/store it:

```typescript
export function startWatchingProject(project: {
  id: string;
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
  jiraDefaultReviewers?: string;
}): void {
  if (jiraDisabled) return;
  watched.set(project.id, {
    id: project.id,
    jiraProjectKey: project.jiraProjectKey ?? '',
    triggerLabel: project.jiraTriggerLabel ?? DEFAULT_TRIGGER_LABEL,
    completedLabel: project.jiraCompletedLabel ?? DEFAULT_COMPLETED_LABEL,
    defaultReviewers: project.jiraDefaultReviewers ?? '',
  });
  if (!projectQueues.has(project.id)) {
    projectQueues.set(project.id, emptyProjectQueue());
  }
  sendJiraStatus();
  ensureJiraInterval();
  pollOneProject(project.id).catch(handleJiraError);
}
```

Replace the ticket-processing loop inside `pollOneProject` (the `for (const ticket of tickets) { ... }` block) with:

```typescript
for (const ticket of tickets) {
  let existingNames: string[];
  try {
    existingNames = await jiraBridge.listTaskNames(projectId);
  } catch (err) {
    console.warn('[jira-watcher] listTaskNames failed:', err);
    continue;
  }
  if (hasTicketKey(existingNames, ticket.key)) continue;

  const queue = projectQueues.get(projectId);
  if (!queue) continue; // project stopped watching mid-poll
  if (queue.implementQueue.includes(ticket.key)) continue; // already queued

  queue.implementQueue.push(ticket.key);

  try {
    await swapTicketLabel(ticket.key, entry.triggerLabel, entry.completedLabel);
  } catch (err) {
    console.warn('[jira-watcher] label swap failed for', ticket.key, err);
  }
}

await refillImplementerIfIdle(projectId);
```

Add the new `refillImplementerIfIdle` function (not exported):

```typescript
/** Per-project re-entrancy guard so two overlapping refill attempts (e.g. a
 *  poll tick firing while a previous refill's ensureImplementerTask call is
 *  still in flight) never both dequeue+prompt. */
const implementerBusy = new Set<string>();

async function refillImplementerIfIdle(projectId: string): Promise<void> {
  const queue = projectQueues.get(projectId);
  if (!queue || !jiraBridge) return;
  if (queue.implementQueue.length === 0) return;
  if (implementerBusy.has(projectId)) return;
  implementerBusy.add(projectId);

  try {
    if (!queue.implementTaskId || !queue.implementAgentId) {
      const created = await jiraBridge.ensureImplementerTask(projectId);
      queue.implementTaskId = created.taskId;
      queue.implementAgentId = created.agentId;
    }
    const ticketKey = queue.implementQueue.shift();
    if (!ticketKey) return; // queue drained by another path between the checks above and here

    const watchedEntry = watched.get(projectId);
    const reviewers = watchedEntry?.defaultReviewers ?? '';
    const promptText = reviewers ? `/myl3 ${ticketKey} ${reviewers}` : `/myl3 ${ticketKey}`;

    await jiraBridge.promptAgent(queue.implementTaskId, queue.implementAgentId, promptText);

    // Re-arm for the NEXT ticket once this one finishes. Deliberately not
    // awaited inline here -- waitForAgentReady can stay pending for the
    // ticket's entire run, and refillImplementerIfIdle must return promptly
    // so the poll tick that called it isn't blocked for that whole duration.
    void jiraBridge
      .waitForAgentReady(queue.implementAgentId)
      .then(() => {
        implementerBusy.delete(projectId);
        return refillImplementerIfIdle(projectId);
      })
      .catch((err) => {
        implementerBusy.delete(projectId);
        console.warn('[jira-watcher] waitForAgentReady failed for', projectId, err);
      });
  } catch (err) {
    implementerBusy.delete(projectId);
    console.warn('[jira-watcher] refillImplementerIfIdle failed for', projectId, err);
  }
}
```

Note the `finally`-shaped cleanup is deliberately NOT used here: `implementerBusy` must stay `true` for the _entire_ duration the prompted ticket is running (that's the whole point of the guard), only clearing once `waitForAgentReady` resolves — so the `.then()`/`.catch()` chain owns clearing it, not a synchronous `try/finally` around the whole function.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: PASS (all tests). If the "already busy" test still fails, check that `implementerBusy.add(projectId)` happens synchronously before the first `await` inside `refillImplementerIfIdle` — a race there would let two calls both pass the `if (implementerBusy.has(projectId)) return;` check.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "feat(jira-watcher): enqueue discovered tickets instead of spawning a task each

pollOneProject now pushes newly-found ticket keys onto the project's
implementQueue and calls a new refillImplementerIfIdle helper, instead
of calling jiraBridge.createTask once per ticket. refillImplementerIfIdle
creates the Implementer task at most once per project (via
ensureImplementerTask), then prompts it with '/myl3 <key> <reviewers>'
and re-arms itself via waitForAgentReady once that ticket's work
finishes -- this is the sequential, one-at-a-time queue the design
calls for, replacing the old unthrottled per-ticket task spawn.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Renderer-side handlers for the four new bridge requests

**Files:**

- Modify: `src/store/remoteTaskHandler.ts`
- Test: `src/store/remoteTaskHandler.test.ts`

**Interfaces:**

- Consumes: `createTask` (existing, `src/store/tasks.ts`), `sendPrompt` (existing, `src/store/tasks.ts`), `onAgentReady` (existing, `src/store/taskStatus.ts`), `store` (existing, `src/store/core.ts`), `IPC.JiraWatcher_EnsureImplementerTaskRequest`/`EnsureDeployerTaskRequest`/`PromptAgentRequest`/`WaitForAgentReadyRequest` (Task 1).
- Produces: `startRemoteTaskHandlers` now also subscribes to the four new channels; each replies on `IPC.JiraWatcher_RendererReply`. No new exports beyond what's already exported (`isKnownTask`, `startRemoteTaskHandlers`).

- [ ] **Step 1: Write the failing tests**

Add to `src/store/remoteTaskHandler.test.ts`. First, extend the hoisted mocks at the top of the file to include `sendPrompt` and `onAgentReady`:

```typescript
const { mockInvoke, mockCreateTask, mockUpdateTaskNotes, mockSendPrompt, mockOnAgentReady } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn(),
    mockCreateTask: vi.fn(),
    mockUpdateTaskNotes: vi.fn(),
    mockSendPrompt: vi.fn(),
    mockOnAgentReady: vi.fn(),
  }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('./tasks', () => ({
  createTask: mockCreateTask,
  updateTaskNotes: mockUpdateTaskNotes,
  sendPrompt: mockSendPrompt,
}));
vi.mock('./taskStatus', () => ({
  onAgentReady: mockOnAgentReady,
}));
```

Then add a new `describe` block (after the existing ones, before or after `isKnownTask`'s block — placement among existing describes doesn't matter):

```typescript
describe('Jira watcher persistent-task bridge handlers', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockCreateTask.mockReset();
    mockSendPrompt.mockReset();
    mockOnAgentReady.mockReset();
    mockOn.mockClear();
    setStore('projects', [{ id: 'proj-1', name: 'P', path: '/p', color: 'red', isGitRepo: true }]);
    setStore('availableAgents', [{ id: 'claude', command: 'claude', args: [] }]);
    setStore('tasks', {});
    startRemoteTaskHandlers();
  });

  it('EnsureImplementerTask creates a task once and replies with {taskId, agentId}', async () => {
    mockInvoke.mockResolvedValue('main'); // GetMainBranch / GetGitignoredDirs stub
    mockCreateTask.mockResolvedValue('new-task-1');
    setStore('tasks', 'new-task-1', {
      id: 'new-task-1',
      agentIds: ['new-agent-1'],
      projectId: 'proj-1',
    } as never);

    const listener = listenerFor(IPC.JiraWatcher_EnsureImplementerTaskRequest);
    listener?.({ reqId: 'r1', projectId: 'proj-1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({
        reqId: 'r1',
        ok: true,
        data: { taskId: 'new-task-1', agentId: 'new-agent-1' },
      }),
    );
  });

  it('EnsureDeployerTask is independent of EnsureImplementerTask -- calling both creates two tasks', async () => {
    mockInvoke.mockResolvedValue('main');
    mockCreateTask.mockResolvedValueOnce('impl-task').mockResolvedValueOnce('deploy-task');
    setStore('tasks', 'impl-task', {
      id: 'impl-task',
      agentIds: ['impl-agent'],
      projectId: 'proj-1',
    } as never);
    setStore('tasks', 'deploy-task', {
      id: 'deploy-task',
      agentIds: ['deploy-agent'],
      projectId: 'proj-1',
    } as never);

    listenerFor(IPC.JiraWatcher_EnsureImplementerTaskRequest)?.({
      reqId: 'r1',
      projectId: 'proj-1',
    });
    await Promise.resolve();
    await Promise.resolve();
    listenerFor(IPC.JiraWatcher_EnsureDeployerTaskRequest)?.({
      reqId: 'r2',
      projectId: 'proj-1',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({
        reqId: 'r1',
        data: { taskId: 'impl-task', agentId: 'impl-agent' },
      }),
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({
        reqId: 'r2',
        data: { taskId: 'deploy-task', agentId: 'deploy-agent' },
      }),
    );
  });

  it('PromptAgent calls sendPrompt with the given taskId/agentId/text and replies ok', async () => {
    mockSendPrompt.mockResolvedValue(undefined);
    listenerFor(IPC.JiraWatcher_PromptAgentRequest)?.({
      reqId: 'r3',
      taskId: 't1',
      agentId: 'a1',
      text: '/myl3 DEV_IRREG-1 @a',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendPrompt).toHaveBeenCalledWith('t1', 'a1', '/myl3 DEV_IRREG-1 @a');
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({ reqId: 'r3', ok: true }),
    );
  });

  it('PromptAgent replies with ok:false when sendPrompt rejects', async () => {
    mockSendPrompt.mockRejectedValue(new Error('agent not found'));
    listenerFor(IPC.JiraWatcher_PromptAgentRequest)?.({
      reqId: 'r4',
      taskId: 't1',
      agentId: 'a1',
      text: 'hi',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({ reqId: 'r4', ok: false, error: 'agent not found' }),
    );
  });

  it('WaitForAgentReady registers onAgentReady and replies ok once it fires', () => {
    listenerFor(IPC.JiraWatcher_WaitForAgentReadyRequest)?.({ reqId: 'r5', agentId: 'a1' });

    expect(mockOnAgentReady).toHaveBeenCalledWith('a1', expect.any(Function));
    expect(mockInvoke).not.toHaveBeenCalled(); // not replied yet -- still waiting

    const registeredCallback = mockOnAgentReady.mock.calls[0][1] as () => void;
    registeredCallback();

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({ reqId: 'r5', ok: true }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Projects/parallel-code-local && npx vitest run src/store/remoteTaskHandler.test.ts
```

Expected: FAIL — `listenerFor(IPC.JiraWatcher_EnsureImplementerTaskRequest)` returns `undefined` (channel never subscribed), so calling `?.()` on it is a no-op and every assertion after it fails.

- [ ] **Step 3: Implement the four handlers**

In `src/store/remoteTaskHandler.ts`, add new imports:

```typescript
import { createTask, sendPrompt, updateTaskNotes } from './tasks';
import { onAgentReady } from './taskStatus';
```

(Adjust the existing `import { createTask, updateTaskNotes } from './tasks';` line to include `sendPrompt`.)

Add new request interfaces near the existing ones:

```typescript
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

Add a helper that creates a persistent named task, reusing the same `createTaskForRequest` machinery's project/agent-lookup logic but for a fixed name rather than a per-ticket one:

```typescript
/** Shared by EnsureImplementerTask/EnsureDeployerTask -- creates one
 *  persistent, un-prompted task (no initialPrompt) for the given project and
 *  replies with {taskId, agentId}. `name` distinguishes the Implementer's
 *  window from the Deployer's in the task list. */
async function ensurePersistentTask(req: EnsureTaskRequest, name: string): Promise<void> {
  try {
    const project = store.projects.find((p) => p.id === req.projectId);
    if (!project) throw new Error('Project not found');

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

async function handlePromptAgent(req: PromptAgentRequest): Promise<void> {
  try {
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

function handleWaitForAgentReady(req: WaitForAgentReadyRequest): void {
  onAgentReady(req.agentId, () => {
    reply(req.reqId, true, undefined, undefined, IPC.JiraWatcher_RendererReply);
  });
}
```

Subscribe to the four channels inside `startRemoteTaskHandlers`, alongside the existing `offJiraCreate`:

```typescript
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
    if (data && typeof data === 'object') void handleEnsureDeployerTask(data as EnsureTaskRequest);
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
    if (data && typeof data === 'object') handleWaitForAgentReady(data as WaitForAgentReadyRequest);
  },
);
```

And add the four new `off*` calls to the returned cleanup function:

```typescript
return () => {
  offProjects();
  offCreate();
  offGetNotes();
  offSetNotes();
  offListTaskNames();
  offJiraCreate();
  offEnsureImplementer();
  offEnsureDeployer();
  offPromptAgent();
  offWaitForAgentReady();
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run src/store/remoteTaskHandler.test.ts
```

Expected: PASS (all tests, new and pre-existing).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add src/store/remoteTaskHandler.ts src/store/remoteTaskHandler.test.ts
git commit -m "feat(jira-watcher): renderer handlers for the persistent-task bridge

EnsureImplementerTask/EnsureDeployerTask create one un-prompted
persistent task each (named 'Jira Implementer'/'Jira Deployer') and
reply with {taskId, agentId}; PromptAgent wraps sendPrompt;
WaitForAgentReady wraps onAgentReady and replies once it fires. These
are what jira-watcher.ts's main-process bridge (Task 2) calls into.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Add `jiraDefaultReviewers` project field + Settings UI

**Files:**

- Modify: `src/store/types.ts`
- Modify: `src/components/EditProjectDialog.tsx`
- Modify: `src/store/jira-watcher.ts` (renderer-side subscription, threads the new field through to `StartJiraWatcher`)
- Modify: `electron/ipc/register.ts` (main-process `StartJiraWatcher` handler — must read `jiraDefaultReviewers` out of the IPC payload and forward it; currently drops it silently)
- Test: `src/store/jira-watcher.client.test.tsx` (new test, added below)
- Test: `src/store/jira-watcher.test.ts` — **note this is a DIFFERENT file from `jira-watcher.client.test.tsx` above**, both exist in this codebase already. Its existing test `'sends StartJiraWatcher for each project with jiraWatchEnabled true'` asserts an exact payload object with no `jiraDefaultReviewers` key — this task's change to `sync()` breaks that exact-match assertion, so it needs updating (Step 3a below).

**Interfaces:**

- Consumes: nothing new.
- Produces: `Project.jiraDefaultReviewers?: string` (new optional field). `startWatchingProject`'s renderer-side caller (`startJiraWatcherSubscription`) now includes it in the `StartJiraWatcher` payload; `register.ts`'s `StartJiraWatcher` handler now reads it out and forwards it to the main-process `startWatchingProject` (Task 5's function, which already expects `jiraDefaultReviewers` — Task 5's own tests call `startWatchingProject` directly and so never caught that `register.ts` itself was dropping the field).

- [ ] **Step 1: Write the failing test**

Add to `src/store/jira-watcher.client.test.tsx`, inside the existing `describe('startJiraWatcherSubscription settings changes', ...)` block:

```typescript
it('re-sends StartJiraWatcher when jiraDefaultReviewers changes on an already-enabled project', () => {
  setStore('projects', [
    {
      id: 'p1',
      name: 'A',
      path: '/a',
      color: 'red',
      jiraWatchEnabled: true,
      jiraProjectKey: 'DEV_IRREG',
      jiraDefaultReviewers: '@old',
    },
  ]);
  withSubscription(() => {
    mockFireAndForget.mockClear();
    setStore('projects', 0, 'jiraDefaultReviewers', '@new');
    expect(mockFireAndForget).toHaveBeenCalledWith(
      IPC.StartJiraWatcher,
      expect.objectContaining({ projectId: 'p1', jiraDefaultReviewers: '@new' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/parallel-code-local && npx vitest run --config vitest.client.config.ts src/store/jira-watcher.client.test.tsx -t "jiraDefaultReviewers"
```

Expected: FAIL — TypeScript will actually reject the `setStore('projects', 0, 'jiraDefaultReviewers', ...)` call at compile time since `Project` doesn't have that field yet; running vitest surfaces this as a transform/type error, or (if the type error doesn't block transpilation) the assertion fails because the field is silently dropped and `mockFireAndForget` was never called with it. Either failure mode confirms the field doesn't exist yet.

- [ ] **Step 3: Add the field and thread it through**

In `src/store/types.ts`, add after the existing `jiraProjectKey?: string;` field (inside the `Project` interface):

```typescript
  /** Default reviewers string (e.g. '@avnair @spummer') passed verbatim as
   *  myl3's `reviewers` argument for every ticket the Implementer queue
   *  auto-picks up. Unset means myl3 runs without named reviewers. */
  jiraDefaultReviewers?: string;
```

In `src/store/jira-watcher.ts`, extend `WatchedSettings` and the `sync` function's `next` object:

```typescript
interface WatchedSettings {
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
  jiraDefaultReviewers?: string;
}
```

```typescript
const next: WatchedSettings = {
  jiraProjectKey: project.jiraProjectKey,
  jiraTriggerLabel: project.jiraTriggerLabel,
  jiraCompletedLabel: project.jiraCompletedLabel,
  jiraDefaultReviewers: project.jiraDefaultReviewers,
};
const prev = active.get(project.id);
if (
  prev &&
  prev.jiraProjectKey === next.jiraProjectKey &&
  prev.jiraTriggerLabel === next.jiraTriggerLabel &&
  prev.jiraCompletedLabel === next.jiraCompletedLabel &&
  prev.jiraDefaultReviewers === next.jiraDefaultReviewers
) {
  continue;
}
```

- [ ] **Step 3a: Fix the now-broken exact-payload test in `src/store/jira-watcher.test.ts`**

This is a **different file** from `jira-watcher.client.test.tsx` (Step 1 above) — both exist in this codebase. Its existing test asserts an exact `StartJiraWatcher` payload object with no `jiraDefaultReviewers` key; Step 3's `sync()` change now always includes that key, so the exact-match `toHaveBeenCalledWith` assertion below will fail once Step 3 lands. Update it:

```typescript
expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartJiraWatcher, {
  projectId: 'p1',
  jiraProjectKey: 'DEV_IRREG',
  jiraTriggerLabel: undefined,
  jiraCompletedLabel: undefined,
  jiraDefaultReviewers: undefined,
});
```

(This is the only occurrence of this exact object literal in the file — `grep -n "jiraTriggerLabel: undefined" src/store/jira-watcher.test.ts` to confirm before editing if unsure.)

- [ ] **Step 3b: Forward `jiraDefaultReviewers` through `register.ts`'s `StartJiraWatcher` handler**

In `electron/ipc/register.ts`, the existing `IPC.StartJiraWatcher` handler currently reads `jiraProjectKey`/`jiraTriggerLabel`/`jiraCompletedLabel` off `args` but silently drops any other field — `jiraDefaultReviewers` would be lost here even after Steps 1-3 above wire it up on the renderer-sending side, since nothing on the receiving side reads it back out. Find:

```typescript
ipcMain.handle(IPC.StartJiraWatcher, (_e, args) => {
  assertString(args.projectId, 'projectId');
  startWatchingProject({
    id: args.projectId,
    jiraProjectKey: typeof args.jiraProjectKey === 'string' ? args.jiraProjectKey : undefined,
    jiraTriggerLabel: typeof args.jiraTriggerLabel === 'string' ? args.jiraTriggerLabel : undefined,
    jiraCompletedLabel:
      typeof args.jiraCompletedLabel === 'string' ? args.jiraCompletedLabel : undefined,
  });
});
```

Replace with:

```typescript
ipcMain.handle(IPC.StartJiraWatcher, (_e, args) => {
  assertString(args.projectId, 'projectId');
  startWatchingProject({
    id: args.projectId,
    jiraProjectKey: typeof args.jiraProjectKey === 'string' ? args.jiraProjectKey : undefined,
    jiraTriggerLabel: typeof args.jiraTriggerLabel === 'string' ? args.jiraTriggerLabel : undefined,
    jiraCompletedLabel:
      typeof args.jiraCompletedLabel === 'string' ? args.jiraCompletedLabel : undefined,
    jiraDefaultReviewers:
      typeof args.jiraDefaultReviewers === 'string' ? args.jiraDefaultReviewers : undefined,
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run --config vitest.client.config.ts src/store/jira-watcher.client.test.tsx
cd ~/Projects/parallel-code-local && npx vitest run src/store/jira-watcher.test.ts
```

Expected: PASS for both files (new tests and the fixed pre-existing exact-payload test).

- [ ] **Step 5: Add the Settings UI field**

In `src/components/EditProjectDialog.tsx`, add a new signal alongside the other Jira signals (near line 36):

```typescript
const [jiraDefaultReviewers, setJiraDefaultReviewers] = createSignal('');
```

In the effect that syncs signals from the project record (near line 60), add:

```typescript
setJiraDefaultReviewers(p.jiraDefaultReviewers ?? '');
```

In the save handler (near line 116), add:

```typescript
      jiraDefaultReviewers: jiraDefaultReviewers().trim() || undefined,
```

In the JSX, add a new field immediately after the "Completed label" field's closing `</div>` (the block ending around line 583, right before the Jira section's own closing `</Show>`):

```tsx
<div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
  <label style={sectionLabelStyle}>
    Default reviewers{' '}
    <span style={{ opacity: '0.5', 'text-transform': 'none' }}>(e.g. @avnair @spummer)</span>
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
  <div
    style={{
      'font-size': '12px',
      color: theme.fgSubtle,
      padding: '2px 2px 0',
    }}
  >
    Used as the reviewers argument for every ticket the Implementer queue picks up automatically
    (e.g. passed to <code>/myl3</code>).
  </div>
</div>
```

- [ ] **Step 6: Manual verification (no automated test for JSX layout in this codebase's existing pattern)**

Run the app (`npm run dev`), open Edit Project for a Jira-watched project, confirm the new "Default reviewers" field appears under "Completed label", persists a typed value across close/reopen (same pattern as the earlier `getJiraEmail`/`isJiraTokenSet` fix — this field IS backed by the project store record, unlike the memory-only credentials, so it should persist correctly via the existing save-on-submit flow without needing a signal-survives-unmount fix).

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/parallel-code-local
git add src/store/types.ts src/store/jira-watcher.ts src/store/jira-watcher.test.ts src/store/jira-watcher.client.test.tsx src/components/EditProjectDialog.tsx electron/ipc/register.ts
git commit -m "feat(jira-watcher): add jiraDefaultReviewers project field + Settings UI

New optional Project field, threaded through startJiraWatcherSubscription's
StartJiraWatcher payload and register.ts's StartJiraWatcher handler
(which was previously dropping any field it didn't explicitly list) to
main-process startWatchingProject (which already expects it per Task
5), and exposed as an EditProjectDialog input field under the existing
Jira section. Used as myl3's reviewers argument for every auto-queued
ticket.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Deployer window — periodic `/pipeline-deploy` refill

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Test: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: `ensureDeployerTask`/`promptAgent`/`waitForAgentReady` (Task 2/3), `ProjectQueue` (Task 4, extended here).
- Produces: a new `refillDeployerIfIdle(projectId)` function (not exported), called from the same places `refillImplementerIfIdle` is called (end of `pollOneProject`, i.e. every poll tick and every "Check Jira now").

- [ ] **Step 1: Write the failing test**

Add to `electron/ipc/jira-watcher.test.ts`, in a new `describe('Deployer refill', ...)` block:

```typescript
describe('Deployer refill', () => {
  beforeEach(() => {
    __resetJiraWatcherForTests();
    vi.mocked(queryLabeledTickets).mockReset();
    vi.mocked(queryLabeledTickets).mockResolvedValue([]); // no new tickets to discover this test
  });

  it('creates the Deployer task once and prompts it with /pipeline-deploy on each idle poll', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });

    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
    await flushPromises();

    const ensureReq = sent
      .filter((s) => s.channel === IPC.JiraWatcher_EnsureDeployerTaskRequest)
      .pop();
    expect(ensureReq).toBeDefined();
    replyToLatest(sent, IPC.JiraWatcher_EnsureDeployerTaskRequest, {
      taskId: 'deploy-task-1',
      agentId: 'deploy-agent-1',
    });
    await flushPromises();

    const promptReq = sent.filter((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest).pop();
    expect(promptReq?.payload).toMatchObject({
      taskId: 'deploy-task-1',
      agentId: 'deploy-agent-1',
      text: '/pipeline-deploy',
    });

    stopWatchingProject('proj-1');
  });

  it('does not send a second /pipeline-deploy prompt while the Deployer is still busy', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_EnsureDeployerTaskRequest, {
      taskId: 'deploy-task-1',
      agentId: 'deploy-agent-1',
    });
    await flushPromises();
    expect(sent.filter((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest)).toHaveLength(1);
    // Deliberately not replying to the PromptAgentRequest -- represents
    // "Deployer still running this pass."

    sent.length = 0;
    await __runJiraTickForTests();
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
    await flushPromises();

    expect(sent.some((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest)).toBe(false);
    stopWatchingProject('proj-1');
  });

  it('sends the next /pipeline-deploy prompt once the previous pass goes idle again', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_EnsureDeployerTaskRequest, {
      taskId: 'deploy-task-1',
      agentId: 'deploy-agent-1',
    });
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_PromptAgentRequest, undefined);
    await flushPromises();

    // waitForAgentReady's request was sent as part of arming the next refill --
    // replying to it simulates the agent going idle again.
    replyToLatest(sent, IPC.JiraWatcher_WaitForAgentReadyRequest, undefined);
    await flushPromises();

    sent.length = 0;
    await __runJiraTickForTests();
    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });
    await flushPromises();

    const promptReq = sent.filter((s) => s.channel === IPC.JiraWatcher_PromptAgentRequest).pop();
    expect(promptReq?.payload).toMatchObject({ text: '/pipeline-deploy' });
    stopWatchingProject('proj-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts -t "Deployer refill"
```

Expected: FAIL — no `IPC.JiraWatcher_EnsureDeployerTaskRequest` or `IPC.JiraWatcher_PromptAgentRequest` traffic occurs at all (nothing calls `refillDeployerIfIdle` yet), so `ensureReq`/`promptReq` are `undefined`.

- [ ] **Step 3: Implement `refillDeployerIfIdle`**

In `electron/ipc/jira-watcher.ts`, add a `deployerBusy` guard alongside `implementerBusy`:

```typescript
const deployerBusy = new Set<string>();

async function refillDeployerIfIdle(projectId: string): Promise<void> {
  const queue = projectQueues.get(projectId);
  if (!queue || !jiraBridge) return;
  if (deployerBusy.has(projectId)) return;
  deployerBusy.add(projectId);

  try {
    if (!queue.deployTaskId || !queue.deployAgentId) {
      const created = await jiraBridge.ensureDeployerTask(projectId);
      queue.deployTaskId = created.taskId;
      queue.deployAgentId = created.agentId;
    }

    await jiraBridge.promptAgent(queue.deployTaskId, queue.deployAgentId, '/pipeline-deploy');

    // Same "don't await inline" reasoning as refillImplementerIfIdle: a
    // deploy pass can run long, and this function must return promptly so
    // the calling poll tick isn't blocked.
    void jiraBridge
      .waitForAgentReady(queue.deployAgentId)
      .then(() => {
        deployerBusy.delete(projectId);
        // No unconditional re-arm here -- unlike the Implementer (which has
        // an explicit queue to drain), the Deployer's next prompt is sent by
        // the NEXT poll tick / Check-Jira-Now call reaching this function
        // again, not by this callback re-triggering itself. This matches the
        // design's "same cadence as the Implementer's poll" refill rule.
      })
      .catch((err) => {
        deployerBusy.delete(projectId);
        console.warn('[jira-watcher] Deployer waitForAgentReady failed for', projectId, err);
      });
  } catch (err) {
    deployerBusy.delete(projectId);
    console.warn('[jira-watcher] refillDeployerIfIdle failed for', projectId, err);
  }
}
```

At the end of `pollOneProject`, after the existing `await refillImplementerIfIdle(projectId);` line, add:

```typescript
await refillDeployerIfIdle(projectId);
```

Reset `deployerBusy` in `__resetJiraWatcherForTests`:

```typescript
deployerBusy.clear();
```

(Also add `implementerBusy.clear();` there if Task 5 didn't already — check before adding to avoid a duplicate statement.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts
```

Expected: PASS (all tests, full file).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "feat(jira-watcher): Deployer window prompts /pipeline-deploy each idle poll

refillDeployerIfIdle mirrors refillImplementerIfIdle's ensure-task-once
+ promptAgent + waitForAgentReady shape, but has no explicit ticket
queue -- pipeline-deploy does its own JQL lookup for eligible work each
pass. Called at the end of pollOneProject, so it runs on the same
poll-tick / Check-Jira-Now cadence as ticket discovery.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: Fix `myl3.md`'s stale "planned" status check (equitystory-ers repo)

**Files:**

- Modify: `equitystory-ers/.claude/agents/myl3.md`

**Interfaces:**

- Consumes: nothing (prose-only agent-definition file, no code interfaces).
- Produces: nothing consumed by later tasks in this plan — this is the live-verified bug fix noted as a prerequisite in the design spec, needed before Task 5's `/myl3 <key> <reviewers>` prompts can succeed against real Backlog tickets.

- [ ] **Step 1: Make the fix**

In `equitystory-ers/.claude/agents/myl3.md`, find this line (in step "0a. Read the ticket"):

```
**Check ticket status.** Only proceed if the ticket is in a "planned" state (e.g. "Zu erledigen" / "To Do"). If the ticket is In Progress, In Review, Done, or any other state — stop and report: "Ticket <ticketId> is in status '<status>' — only planned tickets should be implemented by this agent."
```

Replace it with:

```
**Check ticket status.** Only proceed if the ticket is in status "Backlog" (live-verified against the real DEV_IRREG workflow — this is NOT "Zu erledigen" / "To Do", which do not exist as statuses in this project). If the ticket is In Progress, In Review, Testing, Verified, Done, or any other state — stop and report: "Ticket <ticketId> is in status '<status>' — only Backlog tickets should be implemented by this agent."
```

- [ ] **Step 2: Verify the change is scoped correctly**

```bash
cd ~/Projects/equitystory-ers && grep -n "Zu erledigen\|To Do" .claude/agents/myl3.md
```

Expected: no output — confirms every occurrence of the stale status string was replaced (there is exactly one, in step 0a; the fix above should be the only place it appeared).

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/equitystory-ers
git add .claude/agents/myl3.md
git commit -m "fix(myl3): status check must say Backlog, not Zu erledigen/To Do

Live-verified via the Jira API against real DEV_IRREG tickets
(DEV_IRREG-2178, -2177, -2176, -2164, -1706): the actual pre-work
status is 'Backlog'. 'Zu erledigen'/'To Do' do not exist as statuses
in this project's workflow, so myl3's step 0a check would reject
every legitimately-planned ticket handed to it -- this blocks the new
jira-watcher Implementer queue (parallel-code-local) from working at
all, since every ticket it dequeues is in Backlog.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: Add the `In Review -> Testing -> Verified` auto-transition step to `pipeline-deploy` (equitystory-ers repo)

**Files:**

- Modify: `equitystory-ers/.claude/skills/pipeline-deploy/SKILL.md`

**Interfaces:**

- Consumes: `pipeline-merge` skill (existing, unchanged — its "Called from an unattended context" exception is invoked here exactly as `pipeline-deploy`'s existing step 5 already does).
- Produces: nothing consumed by later tasks — this is the last content task in the plan. Task 8's Deployer window prompts `/pipeline-deploy`, which after this task's change will actually have `REG_AUTOMATED` tickets to find (once one reaches `In Review` with an approved MR).

- [ ] **Step 1: Insert the new step before the existing "1. Find the next ticket" step**

In `equitystory-ers/.claude/skills/pipeline-deploy/SKILL.md`, insert the following new section immediately after the `## Steps` heading and before the existing `### 1. Find the next ticket` heading:

```markdown
### 0. Advance eligible In-Review tickets to Verified (REG_AUTOMATED only)

Before looking for a `Verified` ticket to deploy (step 1), check whether any `REG_AUTOMATED`-labeled ticket sitting in `In Review` is ready to advance -- nothing else in the pipeline moves a ticket through `In Review -> Testing -> Verified`, so without this step the Implementer queue's completed tickets would sit in `In Review` forever.

**Scope guard:** every check below filters to `labels = "REG_AUTOMATED"`. A ticket without that label reaching `In Review` is a human-driven ticket -- this step must never touch it. `Testing` has no separate human gate _for `REG_AUTOMATED` tickets specifically_ (an automation team decision, not a general rule); everything else in this pipeline stays exactly as designed.

1. JQL via `mcp__atlassian__searchJiraIssuesUsingJql` (cloudId `ac99ec2c-4be5-4e97-a8f6-cf12bf3e46ce`):
```

project = DEV_IRREG AND labels = "REG_AUTOMATED" AND status = "In Review" AND assignee = currentUser() ORDER BY updated ASC

```

Fields: `["summary", "status"]`, `maxResults: 1`. No results: skip straight to step 1 below (nothing to advance this pass, not an error).

2. **Resolve its worktree and MR** -- same lookup as steps 3-4 below (`pipeline-worktree.pl resolve <TICKET-KEY>`, then `list_merge_requests` with `sourceBranch` = the branch's name, `state: "opened"`). If this fails the same way step 3/4 would (no branch, zero/multiple MRs), report and stop -- do not guess.

3. **Check approved + mergeable, read-only.** Call `mcp__plugin_gitlab-mcp_gitlab__get_merge_request_approvals` (require `approved: true`, `approvals_left: 0`) and `mcp__plugin_gitlab-mcp_gitlab__get_merge_request` (check `merge_status`/`has_conflicts`). **Do not merge yet** -- this is only the readiness check. If either check fails, this ticket isn't ready: leave it in `In Review` and skip to step 1 below (a later pass re-checks; not an error).

4. **Transition `In Review -> Testing`.** Fetch transitions (`mcp__atlassian__getTransitionsForJiraIssue`) and apply the transition named **"In Testing"** (live-verified; do not guess a different name).

5. **Continue directly into steps 1-7 below for this same ticket** -- do not re-run step 1's JQL; you already have the ticket key, its worktree, and its MR from steps 1-2 above. Steps 3-4 below (worktree/MR resolution) are redundant for this ticket specifically -- reuse what step 2 above already found rather than re-fetching.

6. **Defer the `Testing -> Verified` transition.** Do NOT transition to `Verified` here. Continue into step 5 below (merge via `pipeline-merge`) and step 7 below (staging deploy) as normal.

7. **Only after step 7 below reports the staging deploy succeeded**, transition `Testing -> Verified` (transition named **"Finish Testing"**, live-verified). If the staging deploy failed, leave the ticket at `Testing` -- do not roll back to `In Review`, and do not transition to `Verified`. This makes step 8's existing "leave it in Verified" language below apply only to tickets that were *already* `Verified` some other way; a `REG_AUTOMATED` ticket advanced by this new step 0 now correctly reaches `Verified` only on deploy success.
```

- [ ] **Step 2: Update step 8's "Do not transition" language to reflect the new step 0 case**

Find the existing text in step 8:

```
**Do not transition the ticket.** It stays in `Verified` regardless of outcome -- per this
stage's design, only a future Prod-deploy stage moves it to `Done`. Report this to the user
explicitly so it's clear the lack of transition is intentional, not an oversight.
```

Replace it with:

```
**Do not transition the ticket to `Done`.** Whether this pass advanced the ticket itself
(step 0, `REG_AUTOMATED` only -- transitions to `Verified` on deploy success, stays at
`Testing` on failure) or found it already `Verified`, this stage never moves anything to
`Done` -- that's reserved for a future Prod-deploy stage that does not exist yet. Report
this explicitly so it's clear the lack of a `Done` transition is intentional, not an
oversight.
```

- [ ] **Step 3: Verify the file is well-formed markdown**

```bash
cd ~/Projects/equitystory-ers && grep -c "^### " .claude/skills/pipeline-deploy/SKILL.md
```

Expected: `9` (the original 8 numbered steps, now step "0" through step "8" — confirm the count matches; if it doesn't, check for a heading-level typo introduced by the edit).

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/equitystory-ers
git add .claude/skills/pipeline-deploy/SKILL.md
git commit -m "feat(pipeline-deploy): auto-advance REG_AUTOMATED tickets In Review -> Verified

New step 0, scoped strictly to labels = REG_AUTOMATED: finds an
In-Review ticket whose MR is approved+mergeable, transitions it to
Testing (live-verified transition name 'In Testing'), then continues
into the existing merge+deploy flow. Verified is only reached after
step 7's staging deploy actually succeeds (live-verified transition
name 'Finish Testing') -- a failed deploy leaves the ticket at
Testing, not silently at Verified. Without this, nothing moves a
REG_AUTOMATED ticket past In Review, so the new jira-watcher Deployer
window (parallel-code-local) would never find eligible work.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Post-implementation manual verification (not a task — do after Task 10)

1. In the Parallel Code app, open Edit Project for the `equitystory-ers` project, confirm "Watch Jira board" is on, set "Default reviewers" (Task 7), save.
2. Click "Check Jira now" (or wait for the 3-minute tick). Confirm exactly ONE new task window appears, named "Jira Implementer" — not one per ticket.
3. Confirm a "Jira Deployer" task window also appears around the same time.
4. Watch the Implementer window: it should run `/myl3 DEV_IRREG-2176 ...` (or whichever of the three relabeled tickets sorts first), and once that finishes, automatically pick up the next one without any new window opening.
5. Once a ticket reaches `In Review` with an approved MR, watch the Deployer window run `/pipeline-deploy` and confirm the ticket advances through `Testing` and (on successful staging deploy) `Verified`.

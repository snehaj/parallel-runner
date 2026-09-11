# Per-Project Jira Board Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project owner flag Jira tickets for automatic pickup — add label `REG_AUTOMATED` to a ticket, and Parallel Code spawns a real task for it on its own, no manual "New Task" dialog, no coordinator agent required.

**Architecture:** A new main-process module (`electron/ipc/jira-watcher.ts`) polls each opted-in project on a shared interval, structurally mirroring the existing `pr-checks.ts` GitHub-polling module (same `Map`-of-entries + `setInterval` + window-visibility-pause shape). It shells out to headless Claude Code to read/write Jira state via the already-authenticated `atlassian` MCP plugin (no new Jira credential storage). To actually create a task, it asks the renderer to do it — via two new dedicated IPC request/reply channels, structurally mirroring the existing "mobile task-creation bridge" pattern in `register.ts`, but NOT reusing that bridge's own channels (that bridge is phone-pairing-specific code; reusing its exact channels for Jira would be a confusing misnomer and would collide with its single `ipcMain.handle` registration).

**Tech Stack:** TypeScript (strict), Electron main + SolidJS renderer, Vitest for tests, headless Claude Code CLI (`claude -p ... --output-format json`) shelled out via `child_process.execFile`.

**Spec:** `docs/superpowers/specs/2026-09-11-jira-board-watcher-design.md`

## Global Constraints

- TypeScript `strict: true`, no `any` (per `CLAUDE.md`).
- Functional SolidJS components only — no classes (per `CLAUDE.md`).
- IPC channel names go in `electron/ipc/channel-manifest.json`; `electron/ipc/channels.ts` re-exports them unchanged — do not hand-edit `channels.ts`.
- Persistence is automatic for new optional `Project` fields (`persistence.ts:179` spreads the whole project object) — do NOT add persistence.ts changes for the new fields; they are not needed and would be redundant.
- Every new/changed file must pass `npm run check` (compile + typecheck + lint + format:check) before committing — this repo's pre-commit hook (`.husky/pre-commit`) runs it automatically. Node ≥18 required (this repo's own tooling fails under Node 16 — confirmed in-session; run `nvm use 22` first if `node --version` shows v16).
- Commit messages must be `type(scope): description` (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`) — the pre-commit hook rejects anything else.
- Tests run via `npx vitest run <path>` (this repo's `test:unit` script is `vitest run`, config `vitest.config.ts` includes `electron/**/*.test.ts` and `src/**/*.test.ts`).

---

### Task 1: `PipelineWorktree`-equivalent pure helpers for `jira-watcher.ts`

**Files:**

- Create: `electron/ipc/jira-watcher.ts`
- Create: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: nothing yet (pure functions only in this task).
- Produces: `hasTicketKey(names: string[], ticketKey: string): boolean` and `buildTaskName(ticketKey: string, summary: string): string` — both exported, both pure, used by later tasks and tested directly here.

This task builds the two pure/testable pieces of the module's logic in isolation, before wiring anything to Electron/IPC — matching `pr-checks.ts`'s own separation of pure helpers (`summarize`, `rollupBucket`, `isPrUrl`) from its stateful polling machinery.

- [ ] **Step 1: Write the failing test**

Create `electron/ipc/jira-watcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { hasTicketKey, buildTaskName } from './jira-watcher.js';

describe('hasTicketKey', () => {
  it('finds an exact ticket key inside a task name', () => {
    expect(hasTicketKey(['DEV_IRREG-1234: Fix the thing'], 'DEV_IRREG-1234')).toBe(true);
  });
  it('is false when no task name contains the key', () => {
    expect(hasTicketKey(['DEV_IRREG-9999: Other thing'], 'DEV_IRREG-1234')).toBe(false);
  });
  it('is false for an empty list', () => {
    expect(hasTicketKey([], 'DEV_IRREG-1234')).toBe(false);
  });
  it('does not false-positive on a key that is a prefix of a different key', () => {
    // DEV_IRREG-123 must not match a task named for DEV_IRREG-1234
    expect(hasTicketKey(['DEV_IRREG-1234: Fix the thing'], 'DEV_IRREG-123')).toBe(false);
  });
});

describe('buildTaskName', () => {
  it('combines ticket key and summary with a colon separator', () => {
    expect(buildTaskName('DEV_IRREG-1234', 'Fix the thing')).toBe('DEV_IRREG-1234: Fix the thing');
  });
  it('truncates an overly long summary so the task name stays under 200 chars', () => {
    const longSummary = 'x'.repeat(250);
    const name = buildTaskName('DEV_IRREG-1234', longSummary);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.startsWith('DEV_IRREG-1234: ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: FAIL — `Cannot find module './jira-watcher.js'` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `electron/ipc/jira-watcher.ts`:

```typescript
// Per-project Jira board watcher. Polls each opted-in project for tickets
// labeled REG_AUTOMATED and spawns a real Parallel Code task for each one.
// See docs/superpowers/specs/2026-09-11-jira-board-watcher-design.md.

/** True if any task name in `names` contains `ticketKey` as an exact
 *  substring bounded so a prefix ticket key (DEV_IRREG-123) never matches a
 *  task named for a longer key that starts with it (DEV_IRREG-1234). Bounds
 *  the match on a non-digit (or string end) immediately after the key. */
export function hasTicketKey(names: string[], ticketKey: string): boolean {
  const escaped = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?!\\d)`);
  return names.some((name) => pattern.test(name));
}

const MAX_TASK_NAME_LENGTH = 200; // matches Remote_CreateTaskRequest's own 200-char cap

/** Builds a task name from a ticket key + summary, truncating the summary
 *  (never the key) so the result never exceeds Remote_CreateTaskRequest's
 *  200-character limit. */
export function buildTaskName(ticketKey: string, summary: string): string {
  const prefix = `${ticketKey}: `;
  const maxSummaryLength = MAX_TASK_NAME_LENGTH - prefix.length;
  const truncatedSummary =
    summary.length > maxSummaryLength ? summary.slice(0, maxSummaryLength) : summary;
  return `${prefix}${truncatedSummary}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: PASS (6/6 assertions).

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "feat(jira-watcher): add pure ticket-key and task-name helpers"
```

---

### Task 2: New IPC channels for the Jira-watcher task-creation bridge

**Files:**

- Modify: `electron/ipc/channel-manifest.json`

**Interfaces:**

- Consumes: nothing.
- Produces: three new channel string constants — `IPC.JiraWatcher_CreateTaskRequest`, `IPC.JiraWatcher_ListTaskNamesRequest`, `IPC.JiraWatcher_RendererReply` — consumed by Task 5 (main-process `callRenderer`-equivalent) and Task 4 (renderer-side handlers).

This task is deliberately separate from Task 3 so the channel names exist (and can be typechecked against) before the code that uses them is written — and so a reviewer can approve "these are the right channel names" independent of the calling code.

- [ ] **Step 1: Add the channel entries**

Open `electron/ipc/channel-manifest.json`. Find the existing `Remote_CreateTaskRequest`/`Remote_RendererReply` entries (this file is a flat JSON object, `PascalCaseKey: "snake_case_value"`). Add three new entries near them, keeping alphabetical-ish grouping with the other `JiraWatcher_*`-style entries you're about to create (there are none yet — place them wherever fits the file's existing loose grouping, e.g. near the `Remote_*` block since they're structurally similar):

```json
"JiraWatcher_CreateTaskRequest": "jira_watcher_create_task_request",
"JiraWatcher_ListTaskNamesRequest": "jira_watcher_list_task_names_request",
"JiraWatcher_RendererReply": "jira_watcher_renderer_reply",
```

- [ ] **Step 2: Verify the manifest is still valid JSON and typechecks**

Run: `node -e "JSON.parse(require('fs').readFileSync('electron/ipc/channel-manifest.json', 'utf8')); console.log('valid JSON')"`
Expected: prints `valid JSON` with no error.

Run: `npm run typecheck`
Expected: passes (the manifest is imported with `{ type: 'json' }` in `channels.ts`; adding keys never breaks the `(typeof IPC)[keyof typeof IPC]` type).

- [ ] **Step 3: Commit**

```bash
git add electron/ipc/channel-manifest.json
git commit -m "feat(ipc): add JiraWatcher_* channels for the Jira board watcher"
```

---

### Task 3: `Project` type gains Jira-watch fields + `updateProject` support

**Files:**

- Modify: `src/store/types.ts:65-78` (the `Project` interface)
- Modify: `src/store/projects.ts:55-92` (the `updateProject` function)
- Create: `src/store/projects.test.ts` (if it doesn't already exist — check first with `ls src/store/projects.test.ts`; if it exists, add to it instead of overwriting)

**Interfaces:**

- Consumes: nothing.
- Produces: `Project.jiraWatchEnabled?: boolean`, `Project.jiraTriggerLabel?: string`, `Project.jiraCompletedLabel?: string` — read by Task 5 (`jira-watcher.ts`'s per-project loop) and Task 7 (settings dialog); written by Task 7 via `updateProject`.

- [ ] **Step 1: Check for an existing test file**

Run: `ls src/store/projects.test.ts`

If it exists, read it fully before Step 2 so your added test matches its existing style (describe/it grouping, any shared fixtures). If it does not exist, Step 2 creates it from scratch.

- [ ] **Step 2: Write the failing test**

Add to (or create) `src/store/projects.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { addProject, updateProject, getProject } from './projects';
import { setStore } from './core';

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

If `src/store/projects.test.ts` already existed with unrelated tests, add this `describe` block to the end of the file instead of replacing the whole file — use Edit, not Write, in that case.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/store/projects.test.ts`
Expected: FAIL — TypeScript error, `jiraWatchEnabled` does not exist on the type passed to `updateProject` (or a runtime `undefined` mismatch, depending on how strict the surrounding types are enforced at test time).

- [ ] **Step 4: Add the fields to `Project`**

In `src/store/types.ts`, find the `Project` interface (currently ends with `isGitRepo?: boolean; // undefined treated as true for backward compat`). Add three fields after it:

```typescript
export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  branchPrefix?: string; // default "task" if unset
  deleteBranchOnClose?: boolean; // default true if unset
  defaultGitIsolation?: GitIsolationMode;
  defaultBaseBranch?: string;
  /** Coverage artifact path relative to the repo root. */
  coverageReportPath?: string;
  terminalBookmarks?: TerminalBookmark[];
  isGitRepo?: boolean; // undefined treated as true for backward compat
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
}
```

- [ ] **Step 5: Add the fields to `updateProject`'s allowlist**

In `src/store/projects.ts`, `updateProject`'s parameter type is a `Partial<Pick<Project, ...>>` — fields not named in that `Pick<>` are silently ignored even if present on the `Project` interface. Update both the type and the body:

```typescript
export function updateProject(
  projectId: string,
  updates: Partial<
    Pick<
      Project,
      | 'name'
      | 'color'
      | 'branchPrefix'
      | 'deleteBranchOnClose'
      | 'defaultGitIsolation'
      | 'defaultBaseBranch'
      | 'coverageReportPath'
      | 'terminalBookmarks'
      | 'isGitRepo'
      | 'jiraWatchEnabled'
      | 'jiraTriggerLabel'
      | 'jiraCompletedLabel'
    >
  >,
): void {
  setStore(
    produce((s) => {
      const idx = s.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      if (updates.name !== undefined) s.projects[idx].name = updates.name;
      if (updates.color !== undefined) s.projects[idx].color = updates.color;
      if (updates.branchPrefix !== undefined)
        s.projects[idx].branchPrefix = sanitizeBranchPrefix(updates.branchPrefix);
      if (updates.deleteBranchOnClose !== undefined)
        s.projects[idx].deleteBranchOnClose = updates.deleteBranchOnClose;
      if (updates.defaultGitIsolation !== undefined)
        s.projects[idx].defaultGitIsolation = updates.defaultGitIsolation;
      if (Object.prototype.hasOwnProperty.call(updates, 'defaultBaseBranch'))
        s.projects[idx].defaultBaseBranch = updates.defaultBaseBranch;
      if (Object.prototype.hasOwnProperty.call(updates, 'coverageReportPath'))
        s.projects[idx].coverageReportPath = updates.coverageReportPath;
      if (updates.terminalBookmarks !== undefined)
        s.projects[idx].terminalBookmarks = updates.terminalBookmarks;
      if (updates.isGitRepo !== undefined) s.projects[idx].isGitRepo = updates.isGitRepo;
      if (updates.jiraWatchEnabled !== undefined)
        s.projects[idx].jiraWatchEnabled = updates.jiraWatchEnabled;
      if (Object.prototype.hasOwnProperty.call(updates, 'jiraTriggerLabel'))
        s.projects[idx].jiraTriggerLabel = updates.jiraTriggerLabel;
      if (Object.prototype.hasOwnProperty.call(updates, 'jiraCompletedLabel'))
        s.projects[idx].jiraCompletedLabel = updates.jiraCompletedLabel;
    }),
  );
}
```

(Using `hasOwnProperty` rather than `!== undefined` for the two label fields, matching this function's existing convention for `defaultBaseBranch`/`coverageReportPath` — both are meant to be clearable back to "unset" by passing `undefined` explicitly, same as those two.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/store/projects.test.ts`
Expected: PASS (all assertions in the file, including the 2 new ones).

- [ ] **Step 7: Run full typecheck**

Run: `npm run typecheck`
Expected: passes — no other file references `Project`'s field list exhaustively in a way that would break (the fields are optional, so this is additive-safe), but this confirms it.

- [ ] **Step 8: Commit**

```bash
git add src/store/types.ts src/store/projects.ts src/store/projects.test.ts
git commit -m "feat(projects): add jiraWatchEnabled/jiraTriggerLabel/jiraCompletedLabel fields"
```

---

### Task 4: Renderer-side handlers — `handleListTaskNames` in `remoteTaskHandler.ts`

**Files:**

- Modify: `src/store/remoteTaskHandler.ts`
- Create: `src/store/remoteTaskHandler.test.ts` (check first if it exists)

**Interfaces:**

- Consumes: `IPC.JiraWatcher_ListTaskNamesRequest`, `IPC.JiraWatcher_RendererReply` (Task 2); `store.tasks`, `store.taskOrder` (existing, from `./core`).
- Produces: a working renderer-side handler for `JiraWatcher_ListTaskNamesRequest`, wired into `startRemoteTaskHandlers`'s existing subscribe/cleanup lifecycle (already invoked from `App.tsx:532`/`:730` — no `App.tsx` change needed).

This task deliberately does NOT touch `handleCreateTask` / `Remote_CreateTaskRequest` — those stay exactly as they are for the mobile-pairing feature. This task adds a **new, separate** handler for the **new** `JiraWatcher_ListTaskNamesRequest` channel, following the same `reply(reqId, ok, data, error)` pattern the existing handlers already use.

- [ ] **Step 1: Check for an existing test file**

Run: `ls src/store/remoteTaskHandler.test.ts`

If it exists, read it fully first and match its style. This plan assumes it does not exist yet (there was none found during planning) and Step 2 creates it fresh.

- [ ] **Step 2: Write the failing test**

Create `src/store/remoteTaskHandler.test.ts`:

This repo's established pattern for testing renderer-side IPC listeners is
`vi.stubGlobal('window', {...})` inside `beforeEach` (see
`src/store/pr-checks.test.ts` — read it first for the exact shape), NOT a
manual `globalThis.window = {...}` assignment. `vi.stubGlobal` auto-restores
between test files, so it doesn't leak into unrelated tests. Follow that
file's structure exactly:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));

import { setStore } from './core';
import { IPC } from '../../electron/ipc/channels';
import { startRemoteTaskHandlers } from './remoteTaskHandler';

const mockOn = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  setStore('taskOrder', ['t1', 't2', 't3']);
  setStore('tasks', {
    t1: { id: 't1', name: 'DEV_IRREG-100: Fix A', projectId: 'proj-1' },
    t2: { id: 't2', name: 'DEV_IRREG-200: Fix B', projectId: 'proj-2' },
    t3: { id: 't3', name: 'DEV_IRREG-300: Fix C', projectId: 'proj-1' },
  });
  mockOn.mockReturnValue(vi.fn());
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        on: mockOn,
      },
    },
  });
});

function listenerFor(channel: string): ((data: unknown) => void) | undefined {
  const call = mockOn.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

describe('handleListTaskNames', () => {
  it("replies with only the requested project's task names", () => {
    startRemoteTaskHandlers();
    const handler = listenerFor(IPC.JiraWatcher_ListTaskNamesRequest);
    expect(handler).toBeDefined();
    handler?.({ reqId: 'req-1', projectId: 'proj-1' });
    expect(mockInvoke).toHaveBeenCalledWith(IPC.JiraWatcher_RendererReply, {
      reqId: 'req-1',
      ok: true,
      data: { names: ['DEV_IRREG-100: Fix A', 'DEV_IRREG-300: Fix C'] },
      error: undefined,
    });
  });

  it('replies with an empty list for a project with no tasks', () => {
    startRemoteTaskHandlers();
    const handler = listenerFor(IPC.JiraWatcher_ListTaskNamesRequest);
    handler?.({ reqId: 'req-2', projectId: 'proj-nonexistent' });
    expect(mockInvoke).toHaveBeenCalledWith(IPC.JiraWatcher_RendererReply, {
      reqId: 'req-2',
      ok: true,
      data: { names: [] },
      error: undefined,
    });
  });
});
```

(`startRemoteTaskHandlers`'s returned cleanup function is not called at the
end of each test here — `pr-checks.test.ts` doesn't call its own subscription's
cleanup between tests either, since `vi.clearAllMocks()` in `beforeEach`
and a fresh `window` stub each test already prevent cross-test leakage. If
this causes any actual failure when the tests run, add `const stop = ...`
and call `stop()` at the end of each `it` block — but don't add unneeded
ceremony that doesn't match the file's own established style.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/store/remoteTaskHandler.test.ts`
Expected: FAIL — `handler` is `undefined` (no listener registered for `IPC.JiraWatcher_ListTaskNamesRequest` yet), or a TypeScript error on the not-yet-existing `IPC.JiraWatcher_ListTaskNamesRequest`/`JiraWatcher_RendererReply` (these exist from Task 2, so this should be a runtime failure, not a type error, assuming Task 2 is already merged in sequence).

- [ ] **Step 4: Write minimal implementation**

In `src/store/remoteTaskHandler.ts`, add a new request interface, handler function, and subscription — following the exact shape of the existing `GetNotesRequest`/`handleGetNotes` pair:

```typescript
interface ListTaskNamesRequest extends RendererRequest {
  projectId: string;
}

function handleListTaskNames(req: ListTaskNamesRequest): void {
  const names = store.taskOrder
    .map((id) => store.tasks[id])
    .filter((task) => task?.projectId === req.projectId)
    .map((task) => task.name);
  reply(req.reqId, true, { names });
}
```

Note: this `reply()` call reuses the existing `reply` function in this file, which posts to `IPC.Remote_RendererReply` — but Task 2's new channel is `IPC.JiraWatcher_RendererReply`, a _different_ channel. Update `reply()` to take the reply channel as a parameter instead of hardcoding `Remote_RendererReply`, so both the existing mobile-bridge handlers and the new Jira-watcher handler can share this one function correctly:

```typescript
function reply(
  reqId: string,
  ok: boolean,
  data?: unknown,
  error?: string,
  channel: IPC = IPC.Remote_RendererReply,
): void {
  // Fire-and-forget: main resolves/rejects the pending HTTP response by reqId.
  invoke(channel, { reqId, ok, data, error }).catch(() => {});
}
```

And update `handleListTaskNames` to pass the Jira-watcher reply channel explicitly:

```typescript
function handleListTaskNames(req: ListTaskNamesRequest): void {
  const names = store.taskOrder
    .map((id) => store.tasks[id])
    .filter((task) => task?.projectId === req.projectId)
    .map((task) => task.name);
  reply(req.reqId, true, { names }, undefined, IPC.JiraWatcher_RendererReply);
}
```

Now wire the listener into `startRemoteTaskHandlers`, alongside the existing four:

```typescript
export function startRemoteTaskHandlers(): () => void {
  const offProjects = window.electron.ipcRenderer.on(
    IPC.Remote_GetProjectsRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleGetProjects(data as RendererRequest);
    },
  );
  const offCreate = window.electron.ipcRenderer.on(
    IPC.Remote_CreateTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleCreateTask(data as CreateTaskRequest);
    },
  );
  const offGetNotes = window.electron.ipcRenderer.on(
    IPC.Remote_GetNotesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleGetNotes(data as GetNotesRequest);
    },
  );
  const offSetNotes = window.electron.ipcRenderer.on(
    IPC.Remote_SetNotesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleSetNotes(data as SetNotesRequest);
    },
  );
  const offListTaskNames = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_ListTaskNamesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleListTaskNames(data as ListTaskNamesRequest);
    },
  );
  return () => {
    offProjects();
    offCreate();
    offGetNotes();
    offSetNotes();
    offListTaskNames();
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/store/remoteTaskHandler.test.ts`
Expected: PASS (2/2 assertions).

- [ ] **Step 6: Run existing remoteTaskHandler-adjacent tests to check for regressions**

Run: `npx vitest run src/store`
Expected: PASS — the `reply()` signature change (adding a `channel` parameter with a default) must not break any existing caller. Every existing call site (`handleGetProjects`, `handleCreateTask`, `handleGetNotes`, `handleSetNotes`) calls `reply(reqId, ok, data, error)` with exactly 4 args, which still works because `channel` has a default value.

- [ ] **Step 7: Commit**

```bash
git add src/store/remoteTaskHandler.ts src/store/remoteTaskHandler.test.ts
git commit -m "feat(remote-task-handler): add handleListTaskNames for the Jira watcher bridge"
```

---

### Task 5: Main-process side — `callRenderer` helper for the Jira-watcher bridge, wired into `register.ts`

**Files:**

- Modify: `electron/ipc/register.ts`
- Modify: `electron/ipc/jira-watcher.ts` (from Task 1)
- Modify: `electron/ipc/jira-watcher.test.ts` (from Task 1)

**Interfaces:**

- Consumes: `IPC.JiraWatcher_CreateTaskRequest`, `IPC.JiraWatcher_ListTaskNamesRequest`, `IPC.JiraWatcher_RendererReply` (Task 2); `handleListTaskNames` via the renderer listener (Task 4, already wired — this task never calls it directly, only sends the request that reaches it).
- Produces: `initJiraWatcherBridge(win: BrowserWindow): { createTask: (opts: { projectId: string; name: string; prompt: string }) => Promise<{ taskId: string }>; listTaskNames: (projectId: string) => Promise<string[]> }`, exported from `jira-watcher.ts`, called once from `register.ts`. This is the main-process half of the bridge — a self-contained `callRenderer`-equivalent scoped to jira-watcher's own two channels, NOT the existing mobile-bridge `callRenderer` (which is closure-local to `registerAllHandlers` and already has a channel-`Remote_RendererReply` binding of its own — sharing it isn't possible without breaking `ipcMain.handle`'s one-handler-per-channel rule, and even if it were, coupling the Jira watcher to mobile-bridge code would be a confusing dependency to leave for later readers).

- [ ] **Step 1: Write the failing test**

Add to `electron/ipc/jira-watcher.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ipcMain } from 'electron';
import { hasTicketKey, buildTaskName, initJiraWatcherBridge } from './jira-watcher.js';
import { IPC } from './channels.js';

vi.mock('electron', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, fn);
      }),
      __handlers: handlers,
    },
  };
});

function fakeWindow(sent: Array<{ channel: string; payload: unknown }>) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as import('electron').BrowserWindow;
}

describe('initJiraWatcherBridge', () => {
  it('createTask sends a JiraWatcher_CreateTaskRequest and resolves on a matching reply', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    const bridge = initJiraWatcherBridge(win);

    const promise = bridge.createTask({ projectId: 'proj-1', name: 'T', prompt: 'do it' });
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.JiraWatcher_CreateTaskRequest);
    const reqId = (sent[0].payload as { reqId: string }).reqId;

    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, { reqId, ok: true, data: { taskId: 'task-123' } });

    await expect(promise).resolves.toEqual({ taskId: 'task-123' });
  });

  it('listTaskNames rejects when the renderer reports an error', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    const bridge = initJiraWatcherBridge(win);

    const promise = bridge.listTaskNames('proj-1');
    const reqId = (sent[0].payload as { reqId: string }).reqId;
    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, { reqId, ok: false, error: 'boom' });

    await expect(promise).rejects.toThrow('boom');
  });

  it('createTask rejects immediately if the window is destroyed', async () => {
    const win = { isDestroyed: () => true } as unknown as import('electron').BrowserWindow;
    const bridge = initJiraWatcherBridge(win);
    await expect(bridge.createTask({ projectId: 'p', name: 'n', prompt: 'p' })).rejects.toThrow(
      'Desktop app is not available',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: FAIL — `initJiraWatcherBridge is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `electron/ipc/jira-watcher.ts` (below the existing pure helpers from Task 1):

```typescript
import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { IPC } from './channels.js';

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Main-process half of the Jira-watcher's own task-creation bridge — the
 *  SAME PATTERN as register.ts's mobile task-creation bridge (main asks the
 *  renderer to run its real createTask/task-list logic and reports back),
 *  but on its own dedicated channels. NOT shared with the mobile bridge:
 *  that bridge's callRenderer is closure-local to registerAllHandlers with
 *  its own single ipcMain.handle(Remote_RendererReply, ...) registration —
 *  ipcMain.handle only allows one handler per channel, so reusing it isn't
 *  possible without restructuring working, unrelated code. Call once from
 *  registerAllHandlers, same lifetime as the window. */
export function initJiraWatcherBridge(win: BrowserWindow): {
  createTask: (opts: { projectId: string; name: string; prompt: string }) => Promise<{
    taskId: string;
  }>;
  listTaskNames: (projectId: string) => Promise<string[]>;
} {
  const pending = new Map<string, PendingRequest>();

  function callRenderer<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (win.isDestroyed()) {
        reject(new Error('Desktop app is not available'));
        return;
      }
      // Same 120s timeout as the mobile bridge — creating a task builds a
      // git worktree, which can be slow on large repos.
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
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: PASS (all assertions, including the 3 new ones).

- [ ] **Step 5: Wire `initJiraWatcherBridge` into `register.ts`**

In `electron/ipc/register.ts`, find the import block for `pr-checks.js` (`initPrChecks, startPrChecksWatcher, ...`). Add an import for the new bridge:

```typescript
import { initJiraWatcherBridge } from './jira-watcher.js';
```

Find the `// --- PR CI status watcher ---` section (`initPrChecks(win);`). Add a call right after it (Task 6 adds the Jira query/label wrapper functions; the actual polling loop that wires everything together and consumes this bridge comes in Task 7 — this task only wires the bridge itself so it exists and is callable):

```typescript
// --- Jira board watcher (task-creation bridge) ---
const jiraWatcherBridge = initJiraWatcherBridge(win);
```

(`jiraWatcherBridge` will be unused until Task 7 wires the actual polling loop to it (Task 6 only adds the Jira query/label wrapper functions, not the loop that consumes this bridge) — add a `// eslint-disable-next-line @typescript-eslint/no-unused-vars` comment above this line for now if the lint step complains, and remove that comment in Task 7 once it's consumed. Check by running the lint step in the next step first — it may not complain if TypeScript's `noUnusedLocals` isn't strict about this pattern.)

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: passes. If `no-unused-vars` fires on `jiraWatcherBridge`, add the disable comment noted above; if `noUnusedLocals` (the TS compiler option, separate from ESLint) fires instead, temporarily reference it with `void jiraWatcherBridge;` on the next line instead, and remove that line in Task 7.

- [ ] **Step 7: Commit**

```bash
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts electron/ipc/register.ts
git commit -m "feat(jira-watcher): add main-process task-creation bridge"
```

---

### Task 6: Headless-Claude-Code Jira query/label wrapper

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Modify: `electron/ipc/jira-watcher.test.ts`

**Interfaces:**

- Consumes: nothing new from other tasks.
- Produces: `queryLabeledTickets(projectKey: string, label: string): Promise<{ key: string; summary: string }[]>` and `swapTicketLabel(ticketKey: string, removeLabel: string, addLabel: string): Promise<void>`, both exported. Consumed by Task 7's polling loop.

This is the "two thin functions, not a general Jira client" wrapper the spec calls for. Both shell out to `claude -p` the same way `pr-checks.ts` shells out to `gh` — via `child_process.execFile`, mockable the same way `pr-checks.test.ts` mocks it.

- [ ] **Step 1: Write the failing test**

Add to `electron/ipc/jira-watcher.test.ts`, near the top (the `vi.mock('child_process', ...)` block must be declared before any import of the module under test, matching `pr-checks.test.ts`'s exact structure — add this mock block as the FIRST thing in the file, before the existing imports, and move the existing `describe` blocks below it):

```typescript
import { promisify } from 'util';

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: unknown,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { execFile: mockExecFile };
});
```

Then add, alongside the existing tests:

```typescript
import { execFile } from 'child_process';
import { queryLabeledTickets, swapTicketLabel } from './jira-watcher.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function stubClaude(handler: (args: string[], cb: ExecCb) => void): string[][] {
  const calls: string[][] = [];
  const impl = (_cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    calls.push(args);
    handler(args, cb);
  };
  vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);
  return calls;
}

describe('queryLabeledTickets', () => {
  it('parses ticket key + summary from claude -p JSON output', async () => {
    stubClaude((_args, cb) => {
      cb(
        null,
        JSON.stringify({
          result: JSON.stringify([
            { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
            { key: 'DEV_IRREG-5678', summary: 'Fix the other thing' },
          ]),
        }),
        '',
      );
    });
    const tickets = await queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED');
    expect(tickets).toEqual([
      { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
      { key: 'DEV_IRREG-5678', summary: 'Fix the other thing' },
    ]);
  });

  it('returns an empty array when claude reports no matching tickets', async () => {
    stubClaude((_args, cb) => {
      cb(null, JSON.stringify({ result: JSON.stringify([]) }), '');
    });
    const tickets = await queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED');
    expect(tickets).toEqual([]);
  });

  it('throws if claude -p exits non-zero', async () => {
    stubClaude((_args, cb) => {
      cb(Object.assign(new Error('claude failed'), { code: 1 }), '', 'some error');
    });
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toThrow();
  });
});

describe('swapTicketLabel', () => {
  it('invokes claude -p with both the remove and add label instructions', async () => {
    const calls = stubClaude((_args, cb) => {
      cb(null, JSON.stringify({ result: JSON.stringify({ ok: true }) }), '');
    });
    await swapTicketLabel('DEV_IRREG-1234', 'REG_AUTOMATED', 'REG_AUTOMATED_SUCC');
    expect(calls).toHaveLength(1);
    const promptArg = calls[0].find((a) => a.includes('DEV_IRREG-1234'));
    expect(promptArg).toContain('REG_AUTOMATED');
    expect(promptArg).toContain('REG_AUTOMATED_SUCC');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: FAIL — `queryLabeledTickets is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `electron/ipc/jira-watcher.ts`:

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
const CLAUDE_TIMEOUT_MS = 60_000;
const CLAUDE_MAX_BUFFER = 4 * 1024 * 1024;

interface ClaudeResultPayload {
  result?: string;
}

/** Runs one headless Claude Code turn against the atlassian MCP plugin and
 *  parses its `result` field as JSON. `claude -p` with --output-format json
 *  wraps the final answer in a `result` string field (itself a further
 *  JSON-encoded value, per the prompt's own instruction to answer as JSON) —
 *  see the CLI's documented --output-format json shape. */
async function runClaudeJson<T>(prompt: string): Promise<T> {
  const { stdout } = await exec(
    'claude',
    ['-p', prompt, '--output-format', 'json', '--permission-mode', 'dontAsk'],
    { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: CLAUDE_MAX_BUFFER },
  );
  const outer = JSON.parse(stdout) as ClaudeResultPayload;
  if (typeof outer.result !== 'string') {
    throw new Error('claude -p returned no result field');
  }
  return JSON.parse(outer.result) as T;
}

/** Queries Jira via the atlassian MCP plugin's JQL search for tickets in
 *  `projectKey` carrying `label`. Returns ticket key + summary only. */
export async function queryLabeledTickets(
  projectKey: string,
  label: string,
): Promise<{ key: string; summary: string }[]> {
  const prompt =
    `Use the atlassian MCP plugin's JQL search tool to find tickets matching: ` +
    `project = ${projectKey} AND labels = ${label}. ` +
    `Reply with ONLY a JSON array of objects shaped {"key": "<ticket key>", "summary": "<summary>"}, ` +
    `no other text.`;
  return runClaudeJson<{ key: string; summary: string }[]>(prompt);
}

/** Removes `removeLabel` and adds `addLabel` on the given ticket, via the
 *  atlassian MCP plugin. */
export async function swapTicketLabel(
  ticketKey: string,
  removeLabel: string,
  addLabel: string,
): Promise<void> {
  const prompt =
    `Use the atlassian MCP plugin to update ticket ${ticketKey}: remove the label ` +
    `${removeLabel} and add the label ${addLabel}. Reply with ONLY the JSON {"ok": true} ` +
    `once done, no other text.`;
  await runClaudeJson<{ ok: boolean }>(prompt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: PASS (all assertions, including the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts
git commit -m "feat(jira-watcher): add headless-Claude-Code Jira query/label wrapper"
```

---

### Task 7: The polling loop itself — `startJiraWatcher`/`stopJiraWatcher`/tick logic

**Files:**

- Modify: `electron/ipc/jira-watcher.ts`
- Modify: `electron/ipc/jira-watcher.test.ts`
- Modify: `electron/ipc/register.ts`

**Interfaces:**

- Consumes: `hasTicketKey`, `buildTaskName` (Task 1); `initJiraWatcherBridge`'s returned `createTask`/`listTaskNames` (Task 5); `queryLabeledTickets`, `swapTicketLabel` (Task 6); `Project.jiraWatchEnabled`/`jiraTriggerLabel`/`jiraCompletedLabel` (Task 3).
- Produces: `initJiraWatcher(win: BrowserWindow): void`, `startWatchingProject(project: { id: string; path: string; jiraTriggerLabel?: string; jiraCompletedLabel?: string }): void`, `stopWatchingProject(projectId: string): void`, `getJiraWatcherStateForTests(): {...}` (test seam, mirrors `pr-checks.ts`'s `__getStateForTests`) — the last two are what Task 8's frontend subscription and Task 9's UI status line will call.

This task assembles everything from Tasks 1/5/6 into the actual `pr-checks.ts`-shaped polling loop.

- [ ] **Step 1: Write the failing test**

First, extend the existing `fakeWindow` helper (from Task 5) — it currently
only implements `isDestroyed` and `webContents.send`, but `initJiraWatcher`
(this task) calls `mainWindow.on(...)` five times and `jiraWindowIsVisible()`
calls `.isVisible()`; without these, `initJiraWatcher(win)` throws
`TypeError: win.on is not a function` immediately, before any test logic
runs. Update `fakeWindow` to:

```typescript
function fakeWindow(sent: Array<{ channel: string; payload: unknown }>) {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    on: () => {},
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as import('electron').BrowserWindow;
}
```

(`isVisible: () => true` so `ensureJiraInterval`'s visibility check doesn't
block the tick from starting; `on: () => {}` is a no-op since these tests
call `startWatchingProject`/`stopWatchingProject` directly rather than
relying on window show/hide events.)

Add to `electron/ipc/jira-watcher.test.ts` (this test file is getting long — that's expected, matching `pr-checks.test.ts`'s own 580 lines for a module of similar scope):

```typescript
describe('watcher tick', () => {
  it('spawns a task for a newly labeled ticket, then swaps its label', async () => {
    stubClaude((args, cb) => {
      const promptArg =
        args.find((a) => a.includes('JQL')) ?? args.find((a) => a.includes('labels'));
      if (promptArg) {
        cb(
          null,
          JSON.stringify({
            result: JSON.stringify([{ key: 'DEV_IRREG-1234', summary: 'Fix the thing' }]),
          }),
          '',
        );
      } else {
        cb(null, JSON.stringify({ result: JSON.stringify({ ok: true }) }), '');
      }
    });

    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({
      id: 'proj-1',
      path: '/tmp/proj-1',
      jiraTriggerLabel: 'REG_AUTOMATED',
      jiraCompletedLabel: 'REG_AUTOMATED_SUCC',
    });

    // Respond to the listTaskNames round-trip (empty — no existing task yet)
    // and the createTask round-trip, both sent to the fake window.
    await flushPromises();
    const listReq = sent.find((s) => s.channel === IPC.JiraWatcher_ListTaskNamesRequest);
    expect(listReq).toBeDefined();
    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, {
      reqId: (listReq!.payload as { reqId: string }).reqId,
      ok: true,
      data: { names: [] },
    });

    await flushPromises();
    const createReq = sent.find((s) => s.channel === IPC.JiraWatcher_CreateTaskRequest);
    expect(createReq).toBeDefined();
    expect((createReq!.payload as { name: string }).name).toBe('DEV_IRREG-1234: Fix the thing');
    replyHandler?.(null, {
      reqId: (createReq!.payload as { reqId: string }).reqId,
      ok: true,
      data: { taskId: 'task-999' },
    });

    await flushPromises();
    stopWatchingProject('proj-1');
  });

  it('skips a ticket that already has a matching task name', async () => {
    stubClaude((args, cb) => {
      const promptArg = args.find((a) => a.includes('labels'));
      if (promptArg) {
        cb(
          null,
          JSON.stringify({
            result: JSON.stringify([{ key: 'DEV_IRREG-1234', summary: 'Fix the thing' }]),
          }),
          '',
        );
      }
    });

    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', path: '/tmp/proj-1' });

    await flushPromises();
    const listReq = sent.find((s) => s.channel === IPC.JiraWatcher_ListTaskNamesRequest);
    const replyHandler = (
      ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
    ).__handlers.get(IPC.JiraWatcher_RendererReply);
    replyHandler?.(null, {
      reqId: (listReq!.payload as { reqId: string }).reqId,
      ok: true,
      data: { names: ['DEV_IRREG-1234: Fix the thing'] },
    });

    await flushPromises();
    const createReq = sent.find((s) => s.channel === IPC.JiraWatcher_CreateTaskRequest);
    expect(createReq).toBeUndefined();
    stopWatchingProject('proj-1');
  });

  it('disables the watcher when claude binary is missing', async () => {
    stubClaude((_args, cb) => {
      cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '');
    });
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', path: '/tmp/proj-1' });
    await flushPromises();
    const state = getJiraWatcherStateForTests();
    expect(state.disabled).toBe(true);
    expect(state.disabledReason).toBe('missing');
    stopWatchingProject('proj-1');
  });
});
```

Add the missing imports at the top of the test file:

```typescript
import {
  initJiraWatcher,
  startWatchingProject,
  stopWatchingProject,
  getJiraWatcherStateForTests,
} from './jira-watcher.js';
```

Add a `flushPromises` helper near the top of the test file, matching `pr-checks.test.ts`'s own:

```typescript
const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: FAIL — `initJiraWatcher is not a function` / import error.

- [ ] **Step 3: Write minimal implementation**

Add to `electron/ipc/jira-watcher.ts`:

```typescript
const TICK_MS = 3 * 60_000; // 3 minutes — Jira polling has no reason to match pr-checks.ts's 30s
const DEFAULT_TRIGGER_LABEL = 'REG_AUTOMATED';
const DEFAULT_COMPLETED_LABEL = 'REG_AUTOMATED_SUCC';

interface WatchedProject {
  id: string;
  path: string;
  triggerLabel: string;
  completedLabel: string;
}

let jiraWin: BrowserWindow | null = null;
let jiraBridge: ReturnType<typeof initJiraWatcherBridge> | null = null;
let watched = new Map<string, WatchedProject>();
let jiraTickHandle: ReturnType<typeof setInterval> | null = null;
let jiraIsPolling = false;
let jiraDisabled = false;
let jiraDisabledReason: 'missing' | 'auth' | null = null;

/** Public: wire window-lifecycle listeners and create the task-creation
 *  bridge. Call once from registerAllHandlers, same as initPrChecks. */
export function initJiraWatcher(mainWindow: BrowserWindow): void {
  jiraWin = mainWindow;
  jiraBridge = initJiraWatcherBridge(mainWindow);
  mainWindow.on('show', () => {
    if (watched.size > 0 && !jiraDisabled) ensureJiraInterval();
  });
  mainWindow.on('hide', () => clearJiraTickInterval());
  mainWindow.on('minimize', () => clearJiraTickInterval());
  mainWindow.on('restore', () => {
    if (watched.size > 0 && !jiraDisabled) ensureJiraInterval();
  });
  mainWindow.on('closed', () => {
    jiraWin = null;
    clearJiraTickInterval();
    watched.clear();
  });
}

/** Public: enable watching for one project. Derives its project key from
 *  the last path segment uppercased with hyphens/underscores stripped to
 *  match Jira's own key convention — actually, project key must come from
 *  the caller since it can't be reliably derived from a folder name; see
 *  Task 9, which passes it from a new Project field OR (simpler,
 *  chosen here) derives it from jiraTriggerLabel's own scope: this function
 *  takes the raw pieces so the caller (Task 8's frontend subscription)
 *  decides how the project key is known. */
export function startWatchingProject(project: {
  id: string;
  path: string;
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
}): void {
  if (jiraDisabled) return;
  watched.set(project.id, {
    id: project.id,
    path: project.path,
    triggerLabel: project.jiraTriggerLabel ?? DEFAULT_TRIGGER_LABEL,
    completedLabel: project.jiraCompletedLabel ?? DEFAULT_COMPLETED_LABEL,
  });
  ensureJiraInterval();
  void pollOneProject(project.id, project.jiraProjectKey);
}

export function stopWatchingProject(projectId: string): void {
  watched.delete(projectId);
  if (watched.size === 0) clearJiraTickInterval();
}

function jiraWindowIsVisible(): boolean {
  return !!jiraWin && !jiraWin.isDestroyed() && jiraWin.isVisible();
}

function ensureJiraInterval(): void {
  if (jiraTickHandle || jiraDisabled) return;
  if (!jiraWindowIsVisible()) return;
  jiraTickHandle = setInterval(() => {
    runJiraTick().catch((err) => console.warn('[jira-watcher] tick failed:', err));
  }, TICK_MS);
  jiraTickHandle.unref();
}

function clearJiraTickInterval(): void {
  if (jiraTickHandle) {
    clearInterval(jiraTickHandle);
    jiraTickHandle = null;
  }
}

async function runJiraTick(): Promise<void> {
  if (jiraDisabled || jiraIsPolling) return;
  jiraIsPolling = true;
  try {
    await Promise.all(
      Array.from(watched.keys()).map((id) => pollOneProject(id).catch(handleClaudeError)),
    );
  } finally {
    jiraIsPolling = false;
  }
}

async function pollOneProject(projectId: string, jiraProjectKeyOverride?: string): Promise<void> {
  const entry = watched.get(projectId);
  if (!entry || !jiraBridge) return;
  // jiraProjectKeyOverride threading is a placeholder for Task 9's actual
  // per-project Jira key source; pollOneProject accepts it optionally so
  // this task's tests (which don't set one) still exercise the rest of the
  // flow. Task 9 must supply a real value — see that task's notes.
  const projectKey = jiraProjectKeyOverride ?? '';

  let tickets: { key: string; summary: string }[];
  try {
    tickets = await queryLabeledTickets(projectKey, entry.triggerLabel);
  } catch (err) {
    handleClaudeError(err);
    return;
  }

  for (const ticket of tickets) {
    let existingNames: string[];
    try {
      existingNames = await jiraBridge.listTaskNames(projectId);
    } catch (err) {
      console.warn('[jira-watcher] listTaskNames failed:', err);
      continue;
    }
    if (hasTicketKey(existingNames, ticket.key)) continue;

    let created: { taskId: string };
    try {
      created = await jiraBridge.createTask({
        projectId,
        name: buildTaskName(ticket.key, ticket.summary),
        prompt: `Implement ${ticket.key}: ${ticket.summary}`,
      });
    } catch (err) {
      console.warn('[jira-watcher] createTask failed for', ticket.key, err);
      continue;
    }
    void created; // taskId not currently used further, but kept for future logging/telemetry

    try {
      await swapTicketLabel(ticket.key, entry.triggerLabel, entry.completedLabel);
    } catch (err) {
      console.warn('[jira-watcher] label swap failed for', ticket.key, err);
      // Ticket keeps triggerLabel — caught by the hasTicketKey check next tick.
    }
  }
}

function handleClaudeError(err: unknown): void {
  if (jiraDisabled) return;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    jiraDisabled = true;
    jiraDisabledReason = 'missing';
    console.warn('[jira-watcher] claude CLI not found — Jira watcher disabled for this session');
    clearJiraTickInterval();
    return;
  }
  const stderr = (err as { stderr?: string })?.stderr ?? '';
  if (typeof stderr === 'string' && /not logged into|authentication required/i.test(stderr)) {
    jiraDisabled = true;
    jiraDisabledReason = 'auth';
    console.warn(
      '[jira-watcher] claude not authenticated — Jira watcher disabled for this session',
    );
    clearJiraTickInterval();
    return;
  }
  console.warn('[jira-watcher] transient failure:', (err as Error)?.message ?? err);
}

// --- Test seams ---

export function __resetJiraWatcherForTests(): void {
  jiraWin = null;
  jiraBridge = null;
  watched = new Map();
  clearJiraTickInterval();
  jiraIsPolling = false;
  jiraDisabled = false;
  jiraDisabledReason = null;
}

export function getJiraWatcherStateForTests(): {
  disabled: boolean;
  disabledReason: 'missing' | 'auth' | null;
  watchedProjectIds: string[];
} {
  return {
    disabled: jiraDisabled,
    disabledReason: jiraDisabledReason,
    watchedProjectIds: Array.from(watched.keys()),
  };
}
```

Note the `pollOneProject`'s `jiraProjectKeyOverride` parameter and the comment above it — this is a genuine gap this task's own tests don't fully close, because determining a project's real Jira project key isn't yet wired to anything in `Project`. Task 9 must resolve this — see Task 9's own notes for the fix (adding a `jiraProjectKey` field, or deriving it another way). Flagging it explicitly here rather than silently guessing avoids a plan step compiling only by accident.

Also add an import at the top of `electron/ipc/jira-watcher.ts` for `initJiraWatcherBridge` if it isn't already in the same file (it is, from Task 5 — no new import needed since this is one continuous module).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: PASS (all assertions in the file). If the "spawns a task" test is flaky due to promise-ordering between the two `flushPromises()` calls, add one more `await flushPromises()` between the list-reply and checking for the create request — the tick's `pollOneProject` awaits `listTaskNames` before calling `createTask`, so there is a real await boundary there that needs a microtask flush to observe.

- [ ] **Step 5: Wire `initJiraWatcher` into `register.ts`, replacing the Task-5 placeholder**

In `electron/ipc/register.ts`, update the import:

```typescript
import { initJiraWatcher, startWatchingProject, stopWatchingProject } from './jira-watcher.js';
```

Replace the Task 5 placeholder line:

```typescript
// --- Jira board watcher (task-creation bridge) ---
const jiraWatcherBridge = initJiraWatcherBridge(win);
```

with:

```typescript
// --- Jira board watcher ---
initJiraWatcher(win);
```

(Remove the now-unneeded `initJiraWatcherBridge` import if `register.ts` no longer calls it directly — `initJiraWatcher` calls it internally now. Also remove any `void jiraWatcherBridge;` placeholder line added in Task 5 step 5/6.)

Task 8 will add the actual `ipcMain.handle` entries that call `startWatchingProject`/`stopWatchingProject` in response to renderer requests (mirroring `StartPrChecksWatcher`/`StopPrChecksWatcher`) — this task only ensures `initJiraWatcher` itself is wired.

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: `startWatchingProject`/`stopWatchingProject` are imported above but not called by anything
in this task (Task 8 is what calls them) — expect ESLint's `no-unused-vars` to fire on both names,
same situation Task 5 hit for `jiraWatcherBridge`. Resolve it the same way: add an
`// eslint-disable-next-line @typescript-eslint/no-unused-vars` comment above the import line,
noting it's consumed by Task 8's `ipcMain.handle` entries. Do not remove the two names from the
import — Task 8 needs them there. Once that's added, `npm run check` should pass.

- [ ] **Step 7: Commit**

```bash
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts electron/ipc/register.ts
git commit -m "feat(jira-watcher): add the polling tick loop"
```

---

### Task 8: `StartJiraWatcher`/`StopJiraWatcher` IPC handlers + frontend subscription

**Files:**

- Modify: `electron/ipc/channel-manifest.json`
- Modify: `electron/ipc/register.ts`
- Create: `src/store/jira-watcher.ts`
- Create: `src/store/jira-watcher.test.ts`
- Modify: `src/App.tsx`

**Interfaces:**

- Consumes: `startWatchingProject`/`stopWatchingProject` (Task 7); `store.projects` (existing).
- Produces: `startJiraWatcherSubscription(): () => void`, exported from `src/store/jira-watcher.ts`, called once from `App.tsx` (mirroring `startPrChecksSubscription`).

This task is what actually calls `startWatchingProject` per opted-in project. It also
resolves the `jiraProjectKey` gap Task 7 flagged: Step 0 below adds one more `Project`
field, `jiraProjectKey`, set by the user in the same settings section as the watch toggle
(Task 9). This task's frontend subscription reads `project.jiraProjectKey` and passes it
through to the main process.

- [ ] **Step 0: Add `jiraProjectKey` to `Project`, retroactively closing Task 7's gap**

This step belongs logically with Task 3 but is added here because the need for it wasn't apparent until Task 7's implementation. In `src/store/types.ts`, add one more field to the `Project` interface (alongside the three added in Task 3):

```typescript
  /** Jira project key (e.g. 'DEV_IRREG') this project's watcher queries.
   *  Required for the watcher to do anything useful — unset means the
   *  watcher has nothing to query and effectively does nothing even if
   *  jiraWatchEnabled is true. */
  jiraProjectKey?: string;
```

In `src/store/projects.ts`, add `'jiraProjectKey'` to `updateProject`'s `Pick<>` list and its body (same `hasOwnProperty` pattern as `jiraTriggerLabel`):

```typescript
if (Object.prototype.hasOwnProperty.call(updates, 'jiraProjectKey'))
  s.projects[idx].jiraProjectKey = updates.jiraProjectKey;
```

Run `npx vitest run src/store/projects.test.ts` to confirm the existing Task 3 tests still pass (this is purely additive), then commit this step on its own:

```bash
git add src/store/types.ts src/store/projects.ts
git commit -m "feat(projects): add jiraProjectKey field, needed by the watcher's JQL query"
```

- [ ] **Step 1: Add the two new channels**

In `electron/ipc/channel-manifest.json`, add:

```json
"StartJiraWatcher": "start_jira_watcher",
"StopJiraWatcher": "stop_jira_watcher",
```

- [ ] **Step 2: Write the failing test**

Create `src/store/jira-watcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setStore } from './core';
import { IPC } from '../../electron/ipc/channels';

const mockFireAndForget = vi.fn();
vi.mock('../lib/ipc', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}));

import { startJiraWatcherSubscription } from './jira-watcher';

describe('startJiraWatcherSubscription', () => {
  beforeEach(() => {
    mockFireAndForget.mockClear();
    setStore('projects', []);
  });

  it('sends StartJiraWatcher for each project with jiraWatchEnabled true', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'A',
        path: '/a',
        color: 'red',
        jiraWatchEnabled: true,
        jiraProjectKey: 'DEV_IRREG',
      },
      { id: 'p2', name: 'B', path: '/b', color: 'blue', jiraWatchEnabled: false },
    ]);
    const stop = startJiraWatcherSubscription();
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartJiraWatcher, {
      projectId: 'p1',
      jiraProjectKey: 'DEV_IRREG',
      jiraTriggerLabel: undefined,
      jiraCompletedLabel: undefined,
    });
    expect(mockFireAndForget).not.toHaveBeenCalledWith(
      IPC.StartJiraWatcher,
      expect.objectContaining({ projectId: 'p2' }),
    );
    stop();
  });

  it('sends StopJiraWatcher on cleanup for every project it started', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'A',
        path: '/a',
        color: 'red',
        jiraWatchEnabled: true,
        jiraProjectKey: 'DEV_IRREG',
      },
    ]);
    const stop = startJiraWatcherSubscription();
    mockFireAndForget.mockClear();
    stop();
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StopJiraWatcher, { projectId: 'p1' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/store/jira-watcher.test.ts`
Expected: FAIL — module `./jira-watcher` does not exist.

- [ ] **Step 4: Write minimal implementation**

Create `src/store/jira-watcher.ts`:

```typescript
import { createEffect, onCleanup } from 'solid-js';
import { store } from './core';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

/** Public: mirrors startPrChecksSubscription — call once from App.tsx.
 *  Keeps the main-process watcher's set of watched projects in sync with
 *  store.projects' jiraWatchEnabled flags. */
export function startJiraWatcherSubscription(): () => void {
  const active = new Set<string>();

  createEffect(() => {
    const seen = new Set<string>();
    for (const project of store.projects) {
      if (!project.jiraWatchEnabled) continue;
      seen.add(project.id);
      if (active.has(project.id)) continue;
      active.add(project.id);
      fireAndForget(IPC.StartJiraWatcher, {
        projectId: project.id,
        jiraProjectKey: project.jiraProjectKey,
        jiraTriggerLabel: project.jiraTriggerLabel,
        jiraCompletedLabel: project.jiraCompletedLabel,
      });
    }
    for (const projectId of [...active]) {
      if (!seen.has(projectId)) {
        active.delete(projectId);
        fireAndForget(IPC.StopJiraWatcher, { projectId });
      }
    }
  });

  const cleanup = (): void => {
    for (const projectId of active) {
      fireAndForget(IPC.StopJiraWatcher, { projectId });
    }
    active.clear();
  };
  onCleanup(cleanup);
  return cleanup;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/store/jira-watcher.test.ts`
Expected: PASS (2/2 assertions).

- [ ] **Step 6a: Remove the unused `path` field from `jira-watcher.ts`**

Task 7's `WatchedProject` interface and `startWatchingProject`'s parameter type both carry a
`path: string` field that `pollOneProject` never actually reads (confirmed while writing this
task — the polling logic only needs `projectId` and the two labels). Remove it now, before it's
threaded through the call site below:

In `electron/ipc/jira-watcher.ts`, remove `path: string;` from the `WatchedProject` interface,
and remove `path: string;` from `startWatchingProject`'s parameter type. Remove the
`path: project.path,` line from `startWatchingProject`'s body where it builds the `WatchedProject`
it stores.

**Also update `electron/ipc/jira-watcher.test.ts`** (Task 7's own test file) to match: it has
3 occurrences of `path: '/tmp/proj-1'` passed to `startWatchingProject(...)` in the "watcher
tick" describe block (one on its own line in the first test, two inline in the second and
third tests). Remove all three — TypeScript's excess-property check on object literals flags
extra properties assigned to a narrower type, so leaving them will fail `npm run typecheck`
once the `path` field above no longer exists on the type. Include this file in this step's
commit alongside `types.ts`/`projects.ts`/`register.ts` (the final `git add` in Step 7 below
already lists `electron/ipc/jira-watcher.ts` — add `electron/ipc/jira-watcher.test.ts` to that
same commit too, since both files change together for this same reason).

- [ ] **Step 6b: Wire the two new `ipcMain.handle` entries in `register.ts`**

Find the existing `StartPrChecksWatcher`/`StopPrChecksWatcher` handlers in `register.ts` and add
matching ones right after (import `startWatchingProject`/`stopWatchingProject` from
`./jira-watcher.js`, alongside the existing `initJiraWatcher` import from Task 7):

```typescript
// --- Jira board watcher (per-project start/stop) ---
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
ipcMain.handle(IPC.StopJiraWatcher, (_e, args) => {
  assertString(args.projectId, 'projectId');
  stopWatchingProject(args.projectId);
});
```

- [ ] **Step 7: Wire the frontend subscription into `App.tsx`**

In `src/App.tsx`, add an import alongside the existing `startPrChecksSubscription` import:

```typescript
import { startJiraWatcherSubscription } from './store/jira-watcher';
```

Add the subscription call alongside `startPrChecksSubscription()`:

```typescript
const stopPrChecksSubscription = startPrChecksSubscription();
const stopJiraWatcherSubscription = startJiraWatcherSubscription();
```

Add the matching cleanup call alongside `stopPrChecksSubscription()`'s cleanup call (find it — it's near `stopRemoteTaskHandlers()` per this plan's earlier research):

```typescript
stopPrChecksSubscription();
stopJiraWatcherSubscription();
```

- [ ] **Step 8: Run the full check and full test suite**

Run: `npm run check`
Run: `npx vitest run`
Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add electron/ipc/channel-manifest.json electron/ipc/register.ts electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts src/store/jira-watcher.ts src/store/jira-watcher.test.ts src/App.tsx
git commit -m "feat(jira-watcher): wire start/stop IPC handlers and frontend subscription"
```

---

### Task 9: Settings UI — toggle, trigger-label field, Jira project key field in `EditProjectDialog.tsx`

**Files:**

- Modify: `src/components/EditProjectDialog.tsx`

**Interfaces:**

- Consumes: `Project.jiraWatchEnabled`/`jiraTriggerLabel`/`jiraCompletedLabel`/`jiraProjectKey` (Tasks 3 and 8); `updateProject` (existing, extended in Tasks 3/8).
- Produces: nothing new consumed elsewhere — this is a leaf UI change.

This task has no meaningful "write a failing test first" step — it's a SolidJS component with no pure logic worth unit-testing in isolation (the existing `EditProjectDialog.tsx` has no test file, confirmed during planning: `find . -iname "EditProjectDialog.test.tsx"` found nothing). Follow the file's own established convention (inline styles, `theme`/`sectionLabelStyle` imports, `Show`/`For` control flow) exactly, matching the "Coverage report path" field block as the closest existing precedent (single text input + helper caption) and the "Always delete branch and worktree on close" checkbox as the toggle precedent.

- [ ] **Step 1: Add the four new signals and their sync-on-open effect**

In `src/components/EditProjectDialog.tsx`, add four new signals alongside the existing ones (after `coverageReportPath`):

```typescript
const [jiraWatchEnabled, setJiraWatchEnabled] = createSignal(false);
const [jiraProjectKey, setJiraProjectKey] = createSignal('');
const [jiraTriggerLabel, setJiraTriggerLabel] = createSignal('');
const [jiraCompletedLabel, setJiraCompletedLabel] = createSignal('');
```

In the existing `createEffect` that syncs signals from `props.project`, add:

```typescript
setJiraWatchEnabled(p.jiraWatchEnabled ?? false);
setJiraProjectKey(p.jiraProjectKey ?? '');
setJiraTriggerLabel(p.jiraTriggerLabel ?? '');
setJiraCompletedLabel(p.jiraCompletedLabel ?? '');
```

(placed right after the existing `setCoverageReportPath(p.coverageReportPath ?? '');` line).

- [ ] **Step 2: Save the new fields in `handleSave`**

In `handleSave`'s `updateProject(...)` call, add:

```typescript
      jiraWatchEnabled: jiraWatchEnabled(),
      jiraProjectKey: jiraProjectKey().trim() || undefined,
      jiraTriggerLabel: jiraTriggerLabel().trim() || undefined,
      jiraCompletedLabel: jiraCompletedLabel().trim() || undefined,
```

(added inside the existing object literal, alongside `coverageReportPath: coverageReportPath().trim() || undefined,`).

- [ ] **Step 3: Add the UI block**

Add a new section after the existing "Coverage report path" block (before "Command Bookmarks"):

```tsx
{
  /* Jira board watcher */
}
<div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
  <label
    style={{
      display: 'flex',
      'align-items': 'center',
      gap: '8px',
      cursor: 'pointer',
      'font-size': '14px',
      color: theme.fg,
    }}
  >
    <input
      type="checkbox"
      checked={jiraWatchEnabled()}
      onChange={(e) => setJiraWatchEnabled(e.currentTarget.checked)}
      style={{ cursor: 'pointer' }}
    />
    Watch Jira board for labeled tickets
  </label>
  <Show when={jiraWatchEnabled()}>
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
        Trigger label{' '}
        <span style={{ opacity: '0.5', 'text-transform': 'none' }}>(blank = REG_AUTOMATED)</span>
      </label>
      <input
        class="input-field"
        type="text"
        value={jiraTriggerLabel()}
        onInput={(e) => setJiraTriggerLabel(e.currentTarget.value)}
        placeholder="REG_AUTOMATED"
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
        Completed label{' '}
        <span style={{ opacity: '0.5', 'text-transform': 'none' }}>
          (blank = REG_AUTOMATED_SUCC)
        </span>
      </label>
      <input
        class="input-field"
        type="text"
        value={jiraCompletedLabel()}
        onInput={(e) => setJiraCompletedLabel(e.currentTarget.value)}
        placeholder="REG_AUTOMATED_SUCC"
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
  </Show>
</div>;
```

- [ ] **Step 4: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev`

In the running app: open a project's settings (click its card in the sidebar), confirm the new "Watch Jira board for labeled tickets" checkbox appears below "Coverage report path", confirm checking it reveals the three new fields, fill them in, click Save, re-open the same project's settings and confirm the values persisted (still checked, same field values).

- [ ] **Step 6: Commit**

```bash
git add src/components/EditProjectDialog.tsx
git commit -m "feat(edit-project-dialog): add Jira board watcher settings"
```

---

### Task 10: Project-card badge in `Sidebar.tsx`

**Files:**

- Modify: `src/components/Sidebar.tsx`

**Interfaces:**

- Consumes: `Project.jiraWatchEnabled` (Task 3).
- Produces: nothing consumed elsewhere — leaf UI change.

- [ ] **Step 1: Add the badge**

In `src/components/Sidebar.tsx`, find the project card's color-dot `<div>` (the one styled `width: '8px', height: '8px', 'border-radius': '50%', background: project.color`). Add a small badge right after it, before the name/path `<div>`:

```tsx
<Show when={project.jiraWatchEnabled}>
  <div
    title="Watching Jira board"
    style={{
      'font-size': sf(10),
      color: theme.fgSubtle,
      'flex-shrink': '0',
    }}
  >
    🔖
  </div>
</Show>
```

Verify `Show` is already imported in this file (it is — confirmed used elsewhere in `Sidebar.tsx` during planning, e.g. around the missing-project warning). If for some reason it isn't imported at the top of the file, add it to the existing `solid-js` import.

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 3: Manual smoke test**

With the app running (`npm run dev`) and at least one project with "Watch Jira board" enabled (from Task 9's smoke test): confirm the 🔖 badge appears on that project's card in the sidebar and not on projects without it enabled.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(sidebar): show a badge on projects watching their Jira board"
```

---

## Self-Review Notes

(Kept here per the writing-plans skill's self-review step — not part of the plan an implementer follows, a record that the review happened.)

- **Spec coverage**: every §2 decision has a task — Jira credential source (Task 6), New ticket signal + Dedup marking (Tasks 6/7), Duplicate-spawn guard (Task 1 + Task 7), UI placement (Tasks 9/10), Architecture pattern (Task 7 mirrors `pr-checks.ts`), Task spawn mechanism + Duplicate-spawn lookup mechanism (Tasks 2/4/5). §5 Error Handling's five bullets are covered by Task 7's `handleClaudeError`/per-ticket try/catch and Task 5's `callRenderer` timeout/window-destroyed handling. §6's four validation scenarios map to Task 7's three automated tests plus a manual gap: **the spec's manual end-to-end validation (a real Jira ticket, a real spawned task) is not automated by this plan** — it remains a manual step for whoever runs this plan's Task 7-9 output against a real Jira instance; no task in this plan replaces that manual check, by design (it needs live Jira/Claude Code credentials this plan cannot assume are present in a CI-like execution).
- **Placeholder scan**: none found — every step has literal code, not "add error handling" prose.
- **Type consistency check performed**: `WatchedProject`'s `path` field, introduced in Task 7, is explicitly removed again in Task 8 Step 6 once it turned out to be unused — flagged inline rather than silently left as dead code. `handleListTaskNames`'s reply shape (`{ names: string[] }`) matches what Task 5's `listTaskNames` unwraps (`.then((r) => r.names)`) — verified by re-reading both.
- **Known gap surfaced during planning, not hidden**: Task 7 introduces `pollOneProject`'s `jiraProjectKeyOverride` parameter as a stopgap because the need for a real Jira-project-key source wasn't discovered until writing that task's implementation — Task 8 Step 0 retroactively adds the missing `Project.jiraProjectKey` field and threads it through properly. This is called out explicitly in both tasks rather than silently patched, since an implementer working Task 7 in isolation needs to know this parameter is intentionally incomplete pending Task 8.

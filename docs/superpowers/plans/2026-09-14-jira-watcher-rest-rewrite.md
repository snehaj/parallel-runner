# Jira Watcher REST Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Jira board watcher's broken `claude -p` + MCP call with direct Jira REST API calls, so it can actually find and label tickets.

**Architecture:** A new `electron/ipc/jira-client.ts` module holds memory-only Jira credentials and two `fetch`-based functions (`queryLabeledTickets`, `swapTicketLabel`) with the exact signatures the existing watcher already calls. `jira-watcher.ts`'s polling loop is otherwise untouched — it imports from the new module instead of defining `runClaudeJson` itself. A new "Jira" section in `SettingsDialog.tsx` (mirroring the existing MiniMax API key field) is the only new UI.

**Tech Stack:** TypeScript, Electron main process, global `fetch` (Node 22+, no new dependency), Vitest with `vi.stubGlobal('fetch', ...)`, SolidJS for the Settings UI.

**Spec:** `docs/superpowers/specs/2026-09-14-jira-watcher-rest-rewrite-design.md`

## Global Constraints

- Jira base URL: `https://eqsgroupcloud.atlassian.net` (spec §Precedent). No cloudId/Bearer branch — the credential here is a personal API token (`ATATT...` prefix), so only HTTP Basic auth (`email:token`, base64) is implemented (spec §Precedent, last paragraph).
- Credentials are **memory-only**: a module-level variable in the main process, set via one IPC call, never written to `state.json`, never sent back to the renderer (spec §Scope, mirroring `electron/ipc/ask-code-minimax.ts`'s `storedApiKey` exactly).
- One shared credential for the whole app — not per-project. `EditProjectDialog`'s existing three Jira fields (`jiraProjectKey`, trigger/completed label) are unchanged (spec §Scope).
- `queryLabeledTickets(projectKey: string, label: string): Promise<{key: string; summary: string}[]>` and `swapTicketLabel(ticketKey: string, removeLabel: string, addLabel: string): Promise<void>` keep these exact signatures — `jira-watcher.ts`'s call sites do not change (spec §Architecture).
- No coordinator-mode integration, no manual "check now" trigger, no Keychain persistence — all explicitly out of scope (spec §Scope).

---

### Task 1: Jira REST client module

**Files:**
- Create: `electron/ipc/jira-client.ts`
- Create: `electron/ipc/jira-client.test.ts`

**Interfaces:**
- Produces: `setJiraCredentials(email: string, token: string): void`, `hasJiraCredentials(): boolean`, `class JiraApiError extends Error { status: number }`, `queryLabeledTickets(projectKey: string, label: string): Promise<{key: string; summary: string}[]>`, `swapTicketLabel(ticketKey: string, removeLabel: string, addLabel: string): Promise<void>`. Task 2 imports all five from this file. Task 3 imports `setJiraCredentials`.

- [ ] **Step 1: Write the failing tests**

Create `electron/ipc/jira-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setJiraCredentials,
  hasJiraCredentials,
  JiraApiError,
  queryLabeledTickets,
  swapTicketLabel,
} from './jira-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('hasJiraCredentials', () => {
  it('is false before any credentials are set', () => {
    setJiraCredentials('', '');
    expect(hasJiraCredentials()).toBe(false);
  });

  it('is true once both email and token are set', () => {
    setJiraCredentials('me@example.com', 'tok123');
    expect(hasJiraCredentials()).toBe(true);
  });

  it('trims whitespace, so an accidental trailing newline does not count as set', () => {
    setJiraCredentials('  ', '  ');
    expect(hasJiraCredentials()).toBe(false);
  });
});

describe('queryLabeledTickets', () => {
  beforeEach(() => {
    setJiraCredentials('me@example.com', 'tok123');
  });

  it('maps issues to {key, summary}, sending Basic auth and the right JQL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        issues: [
          { key: 'DEV_IRREG-1234', fields: { summary: 'Fix the thing' } },
          { key: 'DEV_IRREG-5678', fields: { summary: 'Fix the other thing' } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tickets = await queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED');

    expect(tickets).toEqual([
      { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
      { key: 'DEV_IRREG-5678', summary: 'Fix the other thing' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eqsgroupcloud.atlassian.net/rest/api/3/search/jql');
    expect(init.method).toBe('POST');
    const expectedAuth =
      'Basic ' + Buffer.from('me@example.com:tok123').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    const body = JSON.parse(init.body as string) as { jql: string };
    expect(body.jql).toBe('project = DEV_IRREG AND labels = "REG_AUTOMATED"');
  });

  it('returns an empty array when Jira reports no matching tickets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ issues: [] })));
    const tickets = await queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED');
    expect(tickets).toEqual([]);
  });

  it('throws JiraApiError with status 401 on an auth failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })),
    );
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('throws JiraApiError with status 0 when credentials are not set', async () => {
    setJiraCredentials('', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toMatchObject({
      status: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a network failure as a plain error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toThrow('ECONNRESET');
  });
});

describe('swapTicketLabel', () => {
  beforeEach(() => {
    setJiraCredentials('me@example.com', 'tok123');
  });

  it('reads the current labels, then PUTs with removeLabel replaced by addLabel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ fields: { labels: ['REG_AUTOMATED', 'other-label'] } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await swapTicketLabel('DEV_IRREG-1234', 'REG_AUTOMATED', 'REG_AUTOMATED_SUCC');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(
      'https://eqsgroupcloud.atlassian.net/rest/api/3/issue/DEV_IRREG-1234?fields=labels',
    );
    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('https://eqsgroupcloud.atlassian.net/rest/api/3/issue/DEV_IRREG-1234');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body as string) as { fields: { labels: string[] } };
    expect(body.fields.labels.sort()).toEqual(['REG_AUTOMATED_SUCC', 'other-label']);
  });

  it('de-duplicates when addLabel is already present on the ticket', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ fields: { labels: ['REG_AUTOMATED', 'REG_AUTOMATED_SUCC'] } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await swapTicketLabel('DEV_IRREG-1234', 'REG_AUTOMATED', 'REG_AUTOMATED_SUCC');

    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(putInit.body as string) as { fields: { labels: string[] } };
    expect(body.fields.labels).toEqual(['REG_AUTOMATED_SUCC']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-client.test.ts`
Expected: FAIL — `Cannot find module './jira-client.js'` (the file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `electron/ipc/jira-client.ts`:

```typescript
// Direct Jira REST API client for the Jira board watcher. Replaces an
// earlier design that asked a headless `claude -p` call to proxy Jira
// access through an MCP tool -- that never worked: the atlassian MCP
// plugin needs interactive OAuth (unusable headlessly), and the jira-mcp
// fallback's tool call is denied under --permission-mode dontAsk, so
// Claude replied in prose and JSON.parse threw on it every time. This
// follows gitlab.eqs.tools/ai/foundry's own working pattern instead:
// plain HTTP with token auth, no LLM in the loop.
// See docs/superpowers/specs/2026-09-14-jira-watcher-rest-rewrite-design.md.

const JIRA_BASE_URL = 'https://eqsgroupcloud.atlassian.net';

/** Main-process storage for Jira credentials. Never sent back to the
 *  renderer, never persisted -- same pattern as ask-code-minimax.ts's
 *  storedApiKey. */
let jiraEmail = '';
let jiraToken = '';

export function setJiraCredentials(email: string, token: string): void {
  jiraEmail = email.trim();
  jiraToken = token.trim();
}

export function hasJiraCredentials(): boolean {
  return jiraEmail.length > 0 && jiraToken.length > 0;
}

/** Thrown for any non-2xx Jira response, and (status 0) when no
 *  credentials are configured. Callers switch on `.status` to classify
 *  auth failures (401/403) vs. everything else. */
export class JiraApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'JiraApiError';
    this.status = status;
  }
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
}

async function jiraFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!hasJiraCredentials()) {
    throw new JiraApiError(0, 'Jira credentials are not set');
  }
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new JiraApiError(res.status, `Jira API ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Queries the Jira REST API for tickets in `projectKey` carrying `label`.
 *  Returns ticket key + summary only. */
export async function queryLabeledTickets(
  projectKey: string,
  label: string,
): Promise<{ key: string; summary: string }[]> {
  const jql = `project = ${projectKey} AND labels = "${label}"`;
  const body = await jiraFetch('/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, maxResults: 50, fields: ['summary'] }),
  });
  const issues = (body as { issues?: unknown[] })?.issues ?? [];
  return issues.map((issue) => {
    const i = issue as { key: string; fields: { summary: string } };
    return { key: i.key, summary: i.fields.summary };
  });
}

/** Removes `removeLabel` and adds `addLabel` on the given ticket. Jira's
 *  PUT replaces the whole labels array -- there is no add/remove-one op --
 *  so the current list is read first. */
export async function swapTicketLabel(
  ticketKey: string,
  removeLabel: string,
  addLabel: string,
): Promise<void> {
  const current = (await jiraFetch(`/rest/api/3/issue/${ticketKey}?fields=labels`)) as {
    fields: { labels: string[] };
  };
  const next = current.fields.labels
    .filter((l) => l !== removeLabel)
    .concat(addLabel)
    .filter((l, i, arr) => arr.indexOf(l) === i);

  await jiraFetch(`/rest/api/3/issue/${ticketKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { labels: next } }),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-client.test.ts`
Expected: PASS (13/13).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-client.ts electron/ipc/jira-client.test.ts
git commit -m "feat(jira-client): add direct Jira REST API client

Replaces the LLM-proxied MCP call with plain fetch + Basic auth,
following ai/foundry's own working pattern (docs/superpowers/specs/
2026-09-14-jira-watcher-rest-rewrite-design.md). Credentials are
memory-only, set via setJiraCredentials -- Task 3 wires this to a new
Settings UI field.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Wire jira-watcher.ts to the new client, remove the LLM path

**Files:**
- Modify: `electron/ipc/jira-watcher.ts` (whole file rewritten below)
- Modify: `electron/ipc/jira-watcher.test.ts` (whole file rewritten below)
- Modify: `electron/ipc/shared-types.ts:142-150`
- Modify: `src/store/jira-watcher.ts:13,26-31,86-91`

**Interfaces:**
- Consumes: `setJiraCredentials`, `hasJiraCredentials`, `JiraApiError`, `queryLabeledTickets`, `swapTicketLabel` from `./jira-client.js` (Task 1).
- Produces: `jira-watcher.ts`'s existing exports (`hasTicketKey`, `buildTaskName`, `initJiraWatcherBridge`, `initJiraWatcher`, `startWatchingProject`, `stopWatchingProject`, `getJiraWatcherStateForTests`, `__resetJiraWatcherForTests`, `__runJiraTickForTests`) are unchanged in name and signature -- only `queryLabeledTickets`/`swapTicketLabel` are no longer *defined* here, they are re-exported from `./jira-client.js` for any external caller (there is none today, but the design's "same signatures" guarantee extends to not breaking an import path silently).

This task also updates the shared `disabledReason` type from `'missing' | 'auth'` to `'no-credentials' | 'auth'` everywhere it appears: `electron/ipc/shared-types.ts` (the IPC payload type), `src/store/jira-watcher.ts` (the renderer-side type and label function). `electron/ipc/pr-checks.ts` and `BranchPrDetectionResult` are a **separate, unrelated type** that happens to share the same literal shape (spec §Architecture, "no reachable binary") -- do not touch `pr-checks.ts` or `BranchPrDetectionResult` in this task.

- [ ] **Step 1: Update the shared IPC payload type**

In `electron/ipc/shared-types.ts`, replace lines 142-150:

```typescript
/** Pushed main→renderer on IPC.JiraWatcherStatus whenever the Jira board
 *  watcher's availability changes, plus once when a project starts being
 *  watched so the renderer has an initial state. 'no-credentials' = no Jira
 *  email/token configured in Settings, 'auth' = Jira rejected the
 *  credentials (401/403). */
export interface JiraWatcherStatusPayload {
  disabled: boolean;
  disabledReason: 'no-credentials' | 'auth' | null;
}
```

- [ ] **Step 2: Update the renderer-side status type and label**

In `src/store/jira-watcher.ts`, replace line 13:

```typescript
export type JiraWatcherDisabledReason = 'no-credentials' | 'auth';
```

Replace lines 26-31 (the `jiraWatcherStatusLabel` function body):

```typescript
export function jiraWatcherStatusLabel(): string {
  const status = jiraWatcherStatus();
  if (!status.disabled) return 'Watching';
  if (status.disabledReason === 'auth') return 'Disabled: Jira rejected the credentials';
  if (status.disabledReason === 'no-credentials') return 'Disabled: Jira credentials not set';
  return 'Disabled';
}
```

Replace lines 86-91 (inside the `IPC.JiraWatcherStatus` handler):

```typescript
      disabledReason:
        msg.disabledReason === 'no-credentials' || msg.disabledReason === 'auth'
          ? msg.disabledReason
          : null,
```

- [ ] **Step 3: Write the failing tests for jira-watcher.ts**

Replace `electron/ipc/jira-watcher.test.ts` in full:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('./jira-client.js', () => ({
  setJiraCredentials: vi.fn(),
  hasJiraCredentials: vi.fn(() => true),
  JiraApiError: class JiraApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'JiraApiError';
      this.status = status;
    }
  },
  queryLabeledTickets: vi.fn(),
  swapTicketLabel: vi.fn(),
}));

import { ipcMain } from 'electron';
import { queryLabeledTickets, swapTicketLabel, JiraApiError } from './jira-client.js';
import {
  hasTicketKey,
  buildTaskName,
  initJiraWatcherBridge,
  initJiraWatcher,
  startWatchingProject,
  stopWatchingProject,
  getJiraWatcherStateForTests,
  __resetJiraWatcherForTests,
  __runJiraTickForTests,
} from './jira-watcher.js';
import { IPC } from './channels.js';

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeWindow(
  sent: Array<{ channel: string; payload: unknown }>,
  windowEvents?: Map<string, () => void>,
) {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    on: (event: string, fn: () => void) => {
      windowEvents?.set(event, fn);
    },
    webContents: {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  } as unknown as import('electron').BrowserWindow;
}

function replyToLatest(
  sent: Array<{ channel: string; payload: unknown }>,
  channel: string,
  data: unknown,
): void {
  const req = sent.filter((s) => s.channel === channel).pop();
  if (!req) throw new Error(`no request sent on ${channel}`);
  const replyHandler = (
    ipcMain as unknown as { __handlers: Map<string, (e: unknown, a: unknown) => unknown> }
  ).__handlers.get(IPC.JiraWatcher_RendererReply);
  replyHandler?.(null, {
    reqId: (req.payload as { reqId: string }).reqId,
    ok: true,
    data,
  });
}

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

describe('watcher tick', () => {
  beforeEach(() => {
    __resetJiraWatcherForTests();
    vi.mocked(queryLabeledTickets).mockReset();
    vi.mocked(swapTicketLabel).mockReset();
  });

  it('spawns a task for a newly labeled ticket, then swaps its label', async () => {
    vi.mocked(queryLabeledTickets).mockResolvedValue([
      { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
    ]);
    vi.mocked(swapTicketLabel).mockResolvedValue(undefined);

    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({
      id: 'proj-1',
      jiraProjectKey: 'DEV_IRREG',
      jiraTriggerLabel: 'REG_AUTOMATED',
      jiraCompletedLabel: 'REG_AUTOMATED_SUCC',
    });

    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, { names: [] });

    await flushPromises();
    const createReq = sent.filter((s) => s.channel === IPC.JiraWatcher_CreateTaskRequest).pop();
    expect(createReq).toBeDefined();
    expect((createReq!.payload as { name: string }).name).toBe('DEV_IRREG-1234: Fix the thing');
    replyToLatest(sent, IPC.JiraWatcher_CreateTaskRequest, { taskId: 'task-999' });

    await flushPromises();
    expect(swapTicketLabel).toHaveBeenCalledWith(
      'DEV_IRREG-1234',
      'REG_AUTOMATED',
      'REG_AUTOMATED_SUCC',
    );
    stopWatchingProject('proj-1');
  });

  it('skips a ticket that already has a matching task name', async () => {
    vi.mocked(queryLabeledTickets).mockResolvedValue([
      { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
    ]);

    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });

    await flushPromises();
    replyToLatest(sent, IPC.JiraWatcher_ListTaskNamesRequest, {
      names: ['DEV_IRREG-1234: Fix the thing'],
    });

    await flushPromises();
    expect(sent.some((s) => s.channel === IPC.JiraWatcher_CreateTaskRequest)).toBe(false);
    stopWatchingProject('proj-1');
  });

  it('disables the watcher with reason no-credentials on a status-0 JiraApiError', async () => {
    vi.mocked(queryLabeledTickets).mockRejectedValue(
      new JiraApiError(0, 'Jira credentials are not set'),
    );
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    const state = getJiraWatcherStateForTests();
    expect(state.disabled).toBe(true);
    expect(state.disabledReason).toBe('no-credentials');
    stopWatchingProject('proj-1');
  });

  it('disables the watcher with reason auth on a 401 JiraApiError', async () => {
    vi.mocked(queryLabeledTickets).mockRejectedValue(new JiraApiError(401, 'Unauthorized'));
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    const state = getJiraWatcherStateForTests();
    expect(state.disabled).toBe(true);
    expect(state.disabledReason).toBe('auth');
    stopWatchingProject('proj-1');
  });

  it('disables the watcher with reason auth on a 403 JiraApiError', async () => {
    vi.mocked(queryLabeledTickets).mockRejectedValue(new JiraApiError(403, 'Forbidden'));
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    expect(getJiraWatcherStateForTests().disabledReason).toBe('auth');
    stopWatchingProject('proj-1');
  });

  it('logs and stays enabled on any other error (transient)', async () => {
    vi.mocked(queryLabeledTickets).mockRejectedValueOnce(new Error('ETIMEDOUT'));
    vi.mocked(queryLabeledTickets).mockResolvedValueOnce([]);
    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    expect(getJiraWatcherStateForTests().disabled).toBe(false);

    await __runJiraTickForTests();
    expect(queryLabeledTickets).toHaveBeenCalledTimes(2);
    stopWatchingProject('proj-1');
  });

  it('pushes JiraWatcherStatus on start and again when the watcher becomes disabled', async () => {
    vi.mocked(queryLabeledTickets).mockRejectedValue(new JiraApiError(401, 'Unauthorized'));
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const win = fakeWindow(sent);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });

    const initial = sent.filter((s) => s.channel === IPC.JiraWatcherStatus);
    expect(initial).toHaveLength(1);
    expect(initial[0].payload).toEqual({ disabled: false, disabledReason: null });

    await flushPromises();
    const statuses = sent.filter((s) => s.channel === IPC.JiraWatcherStatus);
    expect(statuses[statuses.length - 1]?.payload).toEqual({
      disabled: true,
      disabledReason: 'auth',
    });
    stopWatchingProject('proj-1');
  });

  // Regression: the project key used to be threaded as a per-call argument
  // that only the one-shot poll in startWatchingProject supplied, so every
  // scheduled tick queried with an empty key.
  it('queries with the configured jiraProjectKey on a SECOND (scheduled) tick', async () => {
    vi.mocked(queryLabeledTickets).mockResolvedValue([]);

    const win = fakeWindow([]);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    expect(queryLabeledTickets).toHaveBeenCalledTimes(1);
    expect(queryLabeledTickets).toHaveBeenLastCalledWith('DEV_IRREG', 'REG_AUTOMATED');

    await __runJiraTickForTests();
    expect(queryLabeledTickets).toHaveBeenCalledTimes(2);
    expect(queryLabeledTickets).toHaveBeenLastCalledWith('DEV_IRREG', 'REG_AUTOMATED');
    stopWatchingProject('proj-1');
  });

  it('fires an immediate tick on window show and restore, not just on the interval', async () => {
    vi.mocked(queryLabeledTickets).mockResolvedValue([]);

    const windowEvents = new Map<string, () => void>();
    const win = fakeWindow([], windowEvents);
    initJiraWatcher(win);
    startWatchingProject({ id: 'proj-1', jiraProjectKey: 'DEV_IRREG' });
    await flushPromises();
    expect(queryLabeledTickets).toHaveBeenCalledTimes(1);

    windowEvents.get('show')?.();
    await flushPromises();
    expect(queryLabeledTickets).toHaveBeenCalledTimes(2);

    windowEvents.get('restore')?.();
    await flushPromises();
    expect(queryLabeledTickets).toHaveBeenCalledTimes(3);
    stopWatchingProject('proj-1');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts`
Expected: FAIL — `jira-watcher.ts` still imports `execFile`/defines `runClaudeJson` and does not import from `./jira-client.js`, so `queryLabeledTickets`/`swapTicketLabel` are not the mocked versions the test expects, and `disabledReason` values like `'no-credentials'` don't exist yet. (The mock for `./jira-client.js` will also cause a "vi.mock path not used by the module under test" style mismatch until Step 5 makes `jira-watcher.ts` actually import from it.)

- [ ] **Step 5: Rewrite jira-watcher.ts**

Replace `electron/ipc/jira-watcher.ts` in full:

```typescript
// Per-project Jira board watcher. Polls each opted-in project for tickets
// labeled REG_AUTOMATED and spawns a real Parallel Code task for each one.
// See docs/superpowers/specs/2026-09-11-jira-board-watcher-design.md and
// docs/superpowers/specs/2026-09-14-jira-watcher-rest-rewrite-design.md.

import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { IPC } from './channels.js';
import { queryLabeledTickets, swapTicketLabel, JiraApiError } from './jira-client.js';
import type { JiraWatcherStatusPayload } from './shared-types.js';

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

const TICK_MS = 3 * 60_000; // 3 minutes — Jira polling has no reason to match pr-checks.ts's 30s
const DEFAULT_TRIGGER_LABEL = 'REG_AUTOMATED';
const DEFAULT_COMPLETED_LABEL = 'REG_AUTOMATED_SUCC';

interface WatchedProject {
  id: string;
  /** The Jira project key this project's JQL query runs against. Stored on the
   *  entry (not passed per call) so every recurring tick has it, not just the
   *  one-shot poll `startWatchingProject` fires. */
  jiraProjectKey: string;
  triggerLabel: string;
  completedLabel: string;
}

let jiraWin: BrowserWindow | null = null;
let jiraBridge: ReturnType<typeof initJiraWatcherBridge> | null = null;
let watched = new Map<string, WatchedProject>();
let jiraTickHandle: ReturnType<typeof setInterval> | null = null;
let jiraIsPolling = false;
let jiraDisabled = false;
let jiraDisabledReason: 'no-credentials' | 'auth' | null = null;

/** Public: wire window-lifecycle listeners and create the task-creation
 *  bridge. Call once from registerAllHandlers, same as initPrChecks. */
export function initJiraWatcher(mainWindow: BrowserWindow): void {
  jiraWin = mainWindow;
  jiraBridge = initJiraWatcherBridge(mainWindow);
  mainWindow.on('show', () => {
    if (watched.size > 0 && !jiraDisabled) {
      ensureJiraInterval();
      runJiraTick().catch((err) => console.warn('[jira-watcher] show tick failed:', err));
    }
  });
  mainWindow.on('hide', () => clearJiraTickInterval());
  mainWindow.on('minimize', () => clearJiraTickInterval());
  mainWindow.on('restore', () => {
    if (watched.size > 0 && !jiraDisabled) {
      ensureJiraInterval();
      runJiraTick().catch((err) => console.warn('[jira-watcher] restore tick failed:', err));
    }
  });
  mainWindow.on('closed', () => {
    jiraWin = null;
    clearJiraTickInterval();
    watched.clear();
  });
}

/** Public: enable watching for one project. The Jira project key cannot be
 *  reliably derived from a folder name, so it comes from the caller — the
 *  renderer subscription passes the project's own `jiraProjectKey` field. */
export function startWatchingProject(project: {
  id: string;
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
}): void {
  if (jiraDisabled) return;
  watched.set(project.id, {
    id: project.id,
    jiraProjectKey: project.jiraProjectKey ?? '',
    triggerLabel: project.jiraTriggerLabel ?? DEFAULT_TRIGGER_LABEL,
    completedLabel: project.jiraCompletedLabel ?? DEFAULT_COMPLETED_LABEL,
  });
  // Give the renderer an initial state so its badge/settings line isn't blank
  // until the first failure changes something.
  sendJiraStatus();
  ensureJiraInterval();
  void pollOneProject(project.id);
}

/** Pushes the watcher's current availability to the renderer. One-way, no
 *  reply — same shape as pr-checks.ts's PrChecksUpdate push. */
function sendJiraStatus(): void {
  if (!jiraWin || jiraWin.isDestroyed()) return;
  const payload: JiraWatcherStatusPayload = {
    disabled: jiraDisabled,
    disabledReason: jiraDisabledReason,
  };
  jiraWin.webContents.send(IPC.JiraWatcherStatus, payload);
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
      Array.from(watched.keys()).map((id) => pollOneProject(id).catch(handleJiraError)),
    );
  } finally {
    jiraIsPolling = false;
  }
}

async function pollOneProject(projectId: string): Promise<void> {
  const entry = watched.get(projectId);
  if (!entry || !jiraBridge) return;

  let tickets: { key: string; summary: string }[];
  try {
    tickets = await queryLabeledTickets(entry.jiraProjectKey, entry.triggerLabel);
  } catch (err) {
    handleJiraError(err);
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

function handleJiraError(err: unknown): void {
  if (jiraDisabled) return;
  if (err instanceof JiraApiError) {
    if (err.status === 0) {
      jiraDisabled = true;
      jiraDisabledReason = 'no-credentials';
      console.warn('[jira-watcher] no Jira credentials configured — watcher disabled for this session');
      clearJiraTickInterval();
      sendJiraStatus();
      return;
    }
    if (err.status === 401 || err.status === 403) {
      jiraDisabled = true;
      jiraDisabledReason = 'auth';
      console.warn('[jira-watcher] Jira rejected the credentials — watcher disabled for this session');
      clearJiraTickInterval();
      sendJiraStatus();
      return;
    }
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

/** Runs one scheduled tick synchronously, the way the interval callback would.
 *  Mirrors pr-checks.ts's __runTickForTests — the interval path is otherwise
 *  unreachable from tests. */
export function __runJiraTickForTests(): Promise<void> {
  return runJiraTick();
}

export function getJiraWatcherStateForTests(): {
  disabled: boolean;
  disabledReason: 'no-credentials' | 'auth' | null;
  watchedProjectIds: string[];
} {
  return {
    disabled: jiraDisabled,
    disabledReason: jiraDisabledReason,
    watchedProjectIds: Array.from(watched.keys()),
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Projects/parallel-code-local && npx vitest run electron/ipc/jira-watcher.test.ts electron/ipc/jira-client.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 7: Typecheck**

Run: `cd ~/Projects/parallel-code-local && npm run typecheck`
Expected: no errors. This is the step that catches any remaining `'missing'` reference in `shared-types.ts`/`jira-watcher.ts`/`src/store/jira-watcher.ts` that Steps 1-2 or 5 missed — `tsc` will flag an assignment of `'no-credentials'` against a type that still says `'missing' | 'auth'` anywhere it wasn't updated.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/jira-watcher.ts electron/ipc/jira-watcher.test.ts \
  electron/ipc/shared-types.ts src/store/jira-watcher.ts
git commit -m "fix(jira-watcher): call Jira REST directly instead of claude -p + MCP

pollOneProject() now imports queryLabeledTickets/swapTicketLabel from
the new jira-client.ts (Task 1) instead of defining them via a
headless claude -p call. handleClaudeError -> handleJiraError
classifies by JiraApiError.status (0 = no credentials, 401/403 =
auth) instead of an ENOENT/stderr-regex guess against a subprocess
that no longer exists. disabledReason's 'missing' value is replaced
by 'no-credentials' throughout (shared-types.ts, src/store/jira-watcher.ts)
-- pr-checks.ts's own, unrelated 'missing'/'auth' taxonomy is untouched.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Jira credentials field in Settings

**Files:**
- Modify: `electron/ipc/channel-manifest.json:100` (insert after)
- Modify: `electron/preload.cjs:101` (insert after)
- Modify: `electron/ipc/register.ts` (imports near line 40, handler near line 908)
- Modify: `src/store/ui.ts:244-248` (insert after)
- Modify: `src/components/SettingsDialog.tsx` (insert after the "Ask about Code" section, ~line 648)
- Create: `electron/ipc/register.test.ts` addition, OR verify existing coverage — see Step 5

**Interfaces:**
- Consumes: `setJiraCredentials` from `./jira-client.js` (Task 1).
- Produces: nothing further downstream — this is the leaf UI/IPC wiring task.

- [ ] **Step 1: Add the IPC channel**

In `electron/ipc/channel-manifest.json`, after line 100 (`"SetMinimaxApiKey": "set_minimax_api_key",`), insert:

```json
  "SetJiraCredentials": "set_jira_credentials",
```

- [ ] **Step 2: Allow the channel in preload**

In `electron/preload.cjs`, after the `'set_minimax_api_key',` line (line 101), insert:

```javascript
  'set_jira_credentials',
```

- [ ] **Step 3: Register the IPC handler**

In `electron/ipc/register.ts`, add the import near the other Jira import (line 40):

```typescript
import { setJiraCredentials } from './jira-client.js';
```

Then, immediately after the existing `StopJiraWatcher` handler (after line 904, before the `// --- Local ESLint quality findings ---` comment), add:

```typescript
  ipcMain.handle(IPC.SetJiraCredentials, (_e, args) => {
    assertString(args.email, 'email');
    assertString(args.token, 'token');
    setJiraCredentials(args.email, args.token);
  });
```

`assertString` is already imported in this file (used by every neighboring handler, e.g. `StartJiraWatcher`) — no new import needed for it.

- [ ] **Step 4: Add the renderer-side setter**

In `src/store/ui.ts`, after `setMinimaxApiKey` (after line 248), add:

```typescript
export function setJiraEmail(email: string): void {
  invoke(IPC.SetJiraCredentials, { email: email.trim(), token: jiraTokenBuffer }).catch((e) =>
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

This needs two small module-level buffers so either field's `onInput` can send both values together (the main-process handler always expects `{email, token}` as a pair, matching `setJiraCredentials(email, token)`'s two-argument shape from Task 1 — there's no separate "set just the email" IPC call). Add these two lines near the top of `src/store/ui.ts`, above `setMinimaxApiKey`'s own definition, next to any other local module state in that file (if the file has no local `let` state yet, add them directly above the two new functions):

```typescript
let jiraEmailBuffer = '';
let jiraTokenBuffer = '';
```

And update `setJiraEmail` to also update the buffer before sending:

```typescript
export function setJiraEmail(email: string): void {
  jiraEmailBuffer = email.trim();
  invoke(IPC.SetJiraCredentials, { email: jiraEmailBuffer, token: jiraTokenBuffer }).catch((e) =>
    console.warn('Failed to set Jira credentials:', e),
  );
}
```

- [ ] **Step 5: Add the Settings UI section**

In `src/components/SettingsDialog.tsx`, add `setJiraEmail, setJiraToken` to the existing `import { ... } from '../store/store';` block (alongside `setMinimaxApiKey` on line 33). Then insert this new section immediately after the closing `</div>` of the "Ask about Code" section (the block ending at line 648, right before the `<Show when={store.dockerAvailable}>` on line 650):

```tsx
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div
              style={{
                ...sectionLabelStyle,
                'font-weight': '600',
              }}
            >
              Jira
            </div>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                padding: '8px 12px',
                'border-radius': '8px',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
              }}
            >
              <label
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '10px',
                }}
              >
                <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                  Email
                </span>
                <input
                  type="text"
                  onInput={(e) => setJiraEmail(e.currentTarget.value)}
                  placeholder="you@company.com"
                  style={{
                    flex: '1',
                    background: theme.taskPanelBg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '6px 10px',
                    color: theme.fg,
                    'font-size': '13px',
                    'font-family': "'JetBrains Mono', monospace",
                    outline: 'none',
                  }}
                />
              </label>
              <label
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '10px',
                }}
              >
                <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                  API token
                </span>
                <input
                  type="password"
                  onInput={(e) => setJiraToken(e.currentTarget.value)}
                  placeholder="Enter your Jira API token (stored in memory only)"
                  style={{
                    flex: '1',
                    background: theme.taskPanelBg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '6px 10px',
                    color: theme.fg,
                    'font-size': '13px',
                    'font-family': "'JetBrains Mono', monospace",
                    outline: 'none',
                  }}
                />
              </label>
            </div>
            <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>
              Used by the Jira board watcher (enabled per-project in Edit Project) to poll for
              labeled tickets. Create a token at{' '}
              <code style={{ 'font-family': "'JetBrains Mono', monospace", 'font-size': '11px' }}>
                id.atlassian.com/manage-profile/security/api-tokens
              </code>
              .
            </span>
          </div>
```

- [ ] **Step 6: Manual check — the field renders and the IPC channel is wired**

Run: `cd ~/Projects/parallel-code-local && npm run typecheck`
Expected: no errors — this alone catches most wiring mistakes (a channel name typo, a missing import) since `IPC.SetJiraCredentials` and `setJiraEmail`/`setJiraToken` are both statically typed.

Then run the app (`npm run compile && npm run build:mcp`, then vite + electron as in previous manual verification of this repo) and open Settings — confirm the new "Jira" section appears after "Ask about Code" with the two fields, and that typing in either does not throw in the console (check via `check_docker_available`-style DEBUG log entries in the terminal running `npm run dev`, same pattern used to verify `start_jira_watcher` earlier in this project).

- [ ] **Step 7: Verify preload allowlist syntax**

Run: `cd ~/Projects/parallel-code-local && node -e "require('./electron/preload.cjs')" 2>&1 | head -5`
Expected: either no output (module loaded — some Electron-only globals may be undefined but a syntax error would throw immediately) or an Electron-API-related error, NOT a `SyntaxError` — confirms Step 2's inserted line has valid JS syntax (a missing comma is the most common mistake here).

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/parallel-code-local
git add electron/ipc/channel-manifest.json electron/preload.cjs electron/ipc/register.ts \
  src/store/ui.ts src/components/SettingsDialog.tsx
git commit -m "feat(settings): add Jira email/token fields

Mirrors the existing MiniMax API key field exactly: memory-only,
never persisted to state.json, sent to the main process via a new
SetJiraCredentials IPC channel that calls jira-client.ts's
setJiraCredentials (Task 1). This is the only place credentials are
entered -- EditProjectDialog's existing per-project Jira fields
(project key, trigger/completed label) are unchanged.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Full-suite verification and manual end-to-end check

**Files:** none created or modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the full unit test suite**

Run: `cd ~/Projects/parallel-code-local && export PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH" && npm run test:unit`
Expected: all tests pass except the pre-existing, unrelated failures already documented on this branch's earlier commit (4 failures in `electron/ipc/claude-usage.test.ts`, confirmed present on unmodified `main` in a throwaway worktree — see the `chore(branding)` commit's message on this branch for the verification method). If `electron/ipc/git-adoption.integration.test.ts` times out under full-suite load, re-run it alone (`npx vitest run electron/ipc/git-adoption.integration.test.ts`) — this was confirmed flaky (passes 6/6 in isolation) on 2026-09-13, not a real regression.

If any *other* test fails, stop and investigate before continuing — do not attribute a new failure to "probably flaky" without the same isolation-run verification.

- [ ] **Step 2: Typecheck and lint the whole repo**

Run: `cd ~/Projects/parallel-code-local && npm run compile && npm run typecheck && npm run lint`
Expected: all three pass clean.

- [ ] **Step 3: Manual end-to-end verification against the real DEV_IRREG-2139 ticket**

This ticket already exists, labeled `REG_AUTOMATED`, per the design spec's Manual Verification section — it's the same one that has never successfully been picked up since the watcher was first built on 2026-09-11.

1. Get a real Jira API token: visit `id.atlassian.com/manage-profile/security/api-tokens`, create one, copy it.
2. Launch the app (`npm run compile && npm run build:mcp`, then the vite+electron dev launch — use an alternate port if another instance already holds 1421, as established earlier in this project).
3. Open Settings, enter your real Jira email and the token from step 1 into the new "Jira" section.
4. Open the `equitystory-ers` project's Edit Project dialog, confirm "Watch Jira board for labeled tickets" is checked and "Jira project key" contains `DEV_IRREG` (both already set from earlier testing in this project — re-enter if either reads blank).
5. Watch the terminal running `npm run dev` for `[jira-watcher]` log lines. Within a few seconds (the watcher polls immediately on enable), expect either:
   - **Success**: no `[jira-watcher] transient failure` line, and within the next poll or two, a new task named `DEV_IRREG-2139: <summary>` appears in the sidebar under the `equitystory-ers` project.
   - **A real, informative failure**: if something is still wrong, the log line will now name an HTTP status or a specific fetch error, not "is not valid JSON" — use that to diagnose, rather than assuming this task's code is broken.
6. If a task was created, confirm in Jira that `DEV_IRREG-2139`'s label changed from `REG_AUTOMATED` to `REG_AUTOMATED_SUCC`.
7. Shut down the test instance the same careful way used throughout this project (kill only the PIDs launched for this verification, confirm via `pgrep` that no other `parallel-code`/`parallel-code-local` instance was touched).

- [ ] **Step 4: Report the outcome**

No commit for this task — it is verification only. If Step 3 succeeds, the plan is complete. If it doesn't, the specific failure (HTTP status, error message) is the next thing to fix, and should NOT be folded back into this plan silently — surface it and decide next steps explicitly, since a real Jira-side surprise (e.g. the token's account lacking permission on the DEV_IRREG project) is a new finding, not a bug in this plan's code.

---

## Self-Review Notes

- **Spec coverage**: every "In scope" bullet from the design spec maps to a task — REST client (Task 1), watcher rewiring + error taxonomy (Task 2), Settings UI (Task 3), test coverage (folded into Tasks 1-2 per-task, not a separate task, since each new/changed file gets its tests in the same task that changes it). "Out of scope" items are not present in any task.
- **Type consistency checked**: `queryLabeledTickets`/`swapTicketLabel` signatures identical across Task 1 (definition) and Task 2 (import/call sites) and the spec. `disabledReason`'s value set (`'no-credentials' | 'auth' | null`) is identical across `shared-types.ts`, `src/store/jira-watcher.ts`, and `jira-watcher.ts`'s internal `let` declaration and `getJiraWatcherStateForTests` return type — all four updated together in Task 2.
- **`pr-checks.ts` isolation double-checked**: grepped for every reference to `'missing'` in the codebase before writing Task 2; confirmed `BranchPrDetectionResult`/`pr-checks.ts` are a separate type family that is explicitly NOT touched by this plan.

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
    expect((createReq?.payload as { name: string }).name).toBe('DEV_IRREG-1234: Fix the thing');
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

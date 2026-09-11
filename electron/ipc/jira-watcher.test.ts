import { describe, it, expect, vi } from 'vitest';
import { promisify } from 'util';

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

import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import {
  hasTicketKey,
  buildTaskName,
  initJiraWatcherBridge,
  queryLabeledTickets,
  swapTicketLabel,
  initJiraWatcher,
  startWatchingProject,
  stopWatchingProject,
  getJiraWatcherStateForTests,
} from './jira-watcher.js';
import { IPC } from './channels.js';

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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
      reqId: ((listReq as { payload: unknown }).payload as { reqId: string }).reqId,
      ok: true,
      data: { names: [] },
    });

    await flushPromises();
    const createReq = sent.find((s) => s.channel === IPC.JiraWatcher_CreateTaskRequest);
    expect(createReq).toBeDefined();
    expect(((createReq as { payload: unknown }).payload as { name: string }).name).toBe(
      'DEV_IRREG-1234: Fix the thing',
    );
    replyHandler?.(null, {
      reqId: ((createReq as { payload: unknown }).payload as { reqId: string }).reqId,
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
      reqId: ((listReq as { payload: unknown }).payload as { reqId: string }).reqId,
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

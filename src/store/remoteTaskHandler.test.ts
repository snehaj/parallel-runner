/* eslint-disable solid/reactivity -- these tests read the store proxy synchronously to exercise isKnownTask; no reactive tracking is involved. */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createStore } from 'solid-js/store';

const { mockInvoke, mockCreateTask, mockUpdateTaskNotes } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockCreateTask: vi.fn(),
  mockUpdateTaskNotes: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('./tasks', () => ({
  createTask: mockCreateTask,
  updateTaskNotes: mockUpdateTaskNotes,
}));

import { setStore } from './core';
import { IPC } from '../../electron/ipc/channels';
import { isKnownTask, startRemoteTaskHandlers } from './remoteTaskHandler';

const mockOn = vi.fn();

function listenerFor(channel: string): ((data: unknown) => void) | undefined {
  const call = mockOn.mock.calls.find((c) => c[0] === channel);
  return call?.[1];
}

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

describe('handleListTaskNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reply() fire-and-forgets a .catch() onto invoke()'s return value, so the
    // mock needs a resolved promise by default (bare vi.fn() returns undefined).
    mockInvoke.mockResolvedValue(undefined);
    setStore('taskOrder', ['t1', 't2', 't3']);
    setStore('tasks', {
      t1: {
        id: 't1',
        name: 'DEV_IRREG-100: Fix A',
        projectId: 'proj-1',
        branchName: 'task/t1',
        worktreePath: '/repo/.worktrees/t1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
      t2: {
        id: 't2',
        name: 'DEV_IRREG-200: Fix B',
        projectId: 'proj-2',
        branchName: 'task/t2',
        worktreePath: '/repo/.worktrees/t2',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
      t3: {
        id: 't3',
        name: 'DEV_IRREG-300: Fix C',
        projectId: 'proj-1',
        branchName: 'task/t3',
        worktreePath: '/repo/.worktrees/t3',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
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

// The Jira watcher's main-side bridge awaits its create-task reply on
// JiraWatcher_RendererReply. If nothing subscribes to
// JiraWatcher_CreateTaskRequest, or if the handler replies on the mobile
// bridge's default channel, the round-trip never completes and every spawn
// hits the bridge's 120s timeout.
describe('handleJiraCreateTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
    mockCreateTask.mockResolvedValue('task-new');
    setStore('taskOrder', []);
    setStore('tasks', {});
    setStore('projects', [
      {
        id: 'proj-1',
        name: 'A',
        path: '/a',
        color: 'red',
        // Non-git so the handler skips the GetMainBranch/GetGitignoredDirs
        // round-trips; the reply-channel wiring is what this test covers.
        isGitRepo: false,
      },
    ]);
    setStore('availableAgents', [
      {
        id: 'claude',
        name: 'Claude',
        command: 'claude',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
    ]);
    setStore('lastAgentId', 'claude');
    mockOn.mockReturnValue(vi.fn());
    vi.stubGlobal('window', { electron: { ipcRenderer: { on: mockOn } } });
  });

  it('subscribes to JiraWatcher_CreateTaskRequest', () => {
    startRemoteTaskHandlers();
    expect(listenerFor(IPC.JiraWatcher_CreateTaskRequest)).toBeDefined();
  });

  it('creates the task and replies on JiraWatcher_RendererReply', async () => {
    startRemoteTaskHandlers();
    const handler = listenerFor(IPC.JiraWatcher_CreateTaskRequest);
    handler?.({
      reqId: 'jira-req-1',
      projectId: 'proj-1',
      name: 'DEV_IRREG-1234: Fix the thing',
      prompt: 'Implement DEV_IRREG-1234: Fix the thing',
    });
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(IPC.JiraWatcher_RendererReply, {
        reqId: 'jira-req-1',
        ok: true,
        data: { taskId: 'task-new' },
        error: undefined,
      });
    });
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'DEV_IRREG-1234: Fix the thing',
        projectId: 'proj-1',
        initialPrompt: 'Implement DEV_IRREG-1234: Fix the thing',
      }),
    );
    // Must NOT leak onto the mobile bridge's channel.
    expect(mockInvoke).not.toHaveBeenCalledWith(
      IPC.Remote_RendererReply,
      expect.objectContaining({ reqId: 'jira-req-1' }),
    );
  });

  it('reports failures on JiraWatcher_RendererReply too', async () => {
    startRemoteTaskHandlers();
    const handler = listenerFor(IPC.JiraWatcher_CreateTaskRequest);
    handler?.({ reqId: 'jira-req-2', projectId: 'nope', name: 'X', prompt: 'y' });
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(IPC.JiraWatcher_RendererReply, {
        reqId: 'jira-req-2',
        ok: false,
        data: undefined,
        error: 'Project not found',
      });
    });
  });

  it('still replies on Remote_RendererReply for the mobile bridge', async () => {
    startRemoteTaskHandlers();
    const handler = listenerFor(IPC.Remote_CreateTaskRequest);
    expect(handler).toBeDefined();
    handler?.({ reqId: 'mobile-req-1', projectId: 'proj-1', name: 'M', prompt: 'p' });
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(IPC.Remote_RendererReply, {
        reqId: 'mobile-req-1',
        ok: true,
        data: { taskId: 'task-new' },
        error: undefined,
      });
    });
  });
});

/* eslint-disable solid/reactivity -- these tests read the store proxy synchronously to exercise isKnownTask; no reactive tracking is involved. */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createStore } from 'solid-js/store';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));

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

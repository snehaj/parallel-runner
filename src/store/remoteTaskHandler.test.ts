/* eslint-disable solid/reactivity -- these tests read the store proxy synchronously to exercise isKnownTask; no reactive tracking is involved. */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createStore } from 'solid-js/store';

const {
  mockInvoke,
  mockCreateTask,
  mockUpdateTaskNotes,
  mockSendPrompt,
  mockOnAgentReady,
  mockGetAgentOutputTail,
  mockWaitUntilAgentReadyForPrompt,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockCreateTask: vi.fn(),
  mockUpdateTaskNotes: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockOnAgentReady: vi.fn(),
  mockGetAgentOutputTail: vi.fn(),
  mockWaitUntilAgentReadyForPrompt: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('./tasks', () => ({
  createTask: mockCreateTask,
  updateTaskNotes: mockUpdateTaskNotes,
  sendPrompt: mockSendPrompt,
}));
vi.mock('./taskStatus', () => ({
  onAgentReady: mockOnAgentReady,
  getAgentOutputTail: mockGetAgentOutputTail,
}));
vi.mock('./agent-send-readiness', () => ({
  waitUntilAgentReadyForPrompt: mockWaitUntilAgentReadyForPrompt,
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

describe('Jira watcher persistent-task bridge handlers', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockCreateTask.mockReset();
    mockSendPrompt.mockReset();
    mockOnAgentReady.mockReset();
    mockGetAgentOutputTail.mockReset();
    mockWaitUntilAgentReadyForPrompt.mockReset();
    mockOn.mockClear();
    // reply() fire-and-forgets a .catch() onto invoke()'s return value, so the
    // mock needs a resolved promise by default (bare vi.fn() returns undefined).
    mockInvoke.mockResolvedValue(undefined);
    mockGetAgentOutputTail.mockReturnValue('');
    mockWaitUntilAgentReadyForPrompt.mockResolvedValue(undefined);
    setStore('projects', [{ id: 'proj-1', name: 'P', path: '/p', color: 'red', isGitRepo: true }]);
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
    setStore('tasks', {});
    setStore('taskOrder', []);
    startRemoteTaskHandlers();
  });

  it('EnsureImplementerTask creates a task once and replies with {taskId, agentId}', async () => {
    // GetMainBranch resolves to a branch name; GetGitignoredDirs resolves to a
    // list the handler .filter()s -- distinguish by channel so neither call
    // gets the other's shape.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.GetMainBranch) return Promise.resolve('main');
      if (channel === IPC.GetGitignoredDirs) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    mockCreateTask.mockResolvedValue('new-task-1');
    setStore('tasks', 'new-task-1', {
      id: 'new-task-1',
      agentIds: ['new-agent-1'],
      projectId: 'proj-1',
    } as never);

    const listener = listenerFor(IPC.JiraWatcher_EnsureImplementerTaskRequest);
    listener?.({ reqId: 'r1', projectId: 'proj-1' });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        IPC.JiraWatcher_RendererReply,
        expect.objectContaining({
          reqId: 'r1',
          ok: true,
          data: { taskId: 'new-task-1', agentId: 'new-agent-1' },
        }),
      );
    });
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it('EnsureDeployerTask is independent of EnsureImplementerTask -- calling both creates two tasks', async () => {
    // GetMainBranch resolves to a branch name; GetGitignoredDirs resolves to a
    // list the handler .filter()s -- distinguish by channel so neither call
    // gets the other's shape.
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.GetMainBranch) return Promise.resolve('main');
      if (channel === IPC.GetGitignoredDirs) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
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
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        IPC.JiraWatcher_RendererReply,
        expect.objectContaining({
          reqId: 'r1',
          data: { taskId: 'impl-task', agentId: 'impl-agent' },
        }),
      );
    });
    listenerFor(IPC.JiraWatcher_EnsureDeployerTaskRequest)?.({
      reqId: 'r2',
      projectId: 'proj-1',
    });
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        IPC.JiraWatcher_RendererReply,
        expect.objectContaining({
          reqId: 'r2',
          data: { taskId: 'deploy-task', agentId: 'deploy-agent' },
        }),
      );
    });

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
  });

  it('EnsureDeployerTask reuses an existing "Jira Deployer" task instead of creating a duplicate', async () => {
    // Regression test: the main process's queue.deployTaskId/implementTaskId
    // cache (electron/ipc/jira-watcher.ts) is the ONLY thing that previously
    // prevented a duplicate task -- and it resets to empty on every app/dev-
    // server restart, while the renderer's task list (and this exact task)
    // survives. Restarting the app therefore always minted a second "Jira
    // Deployer"/"Jira Implementer" window. ensurePersistentTask must check
    // the renderer's own task list for a same-name, same-project task before
    // ever calling createTask.
    setStore('taskOrder', ['existing-deploy-task']);
    setStore('tasks', 'existing-deploy-task', {
      id: 'existing-deploy-task',
      name: 'Jira Deployer',
      projectId: 'proj-1',
      agentIds: ['existing-deploy-agent'],
    } as never);

    listenerFor(IPC.JiraWatcher_EnsureDeployerTaskRequest)?.({
      reqId: 'r-reuse',
      projectId: 'proj-1',
    });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        IPC.JiraWatcher_RendererReply,
        expect.objectContaining({
          reqId: 'r-reuse',
          ok: true,
          data: { taskId: 'existing-deploy-task', agentId: 'existing-deploy-agent' },
        }),
      );
    });
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('EnsureImplementerTask does not reuse a same-named task from a DIFFERENT project', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.GetMainBranch) return Promise.resolve('main');
      if (channel === IPC.GetGitignoredDirs) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    mockCreateTask.mockResolvedValue('new-task-for-proj-1');
    setStore('taskOrder', ['other-project-implementer']);
    setStore('tasks', 'other-project-implementer', {
      id: 'other-project-implementer',
      name: 'Jira Implementer',
      projectId: 'proj-OTHER',
      agentIds: ['other-agent'],
    } as never);
    setStore('tasks', 'new-task-for-proj-1', {
      id: 'new-task-for-proj-1',
      agentIds: ['new-agent-for-proj-1'],
      projectId: 'proj-1',
    } as never);

    listenerFor(IPC.JiraWatcher_EnsureImplementerTaskRequest)?.({
      reqId: 'r-diff-project',
      projectId: 'proj-1',
    });

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        IPC.JiraWatcher_RendererReply,
        expect.objectContaining({
          reqId: 'r-diff-project',
          ok: true,
          data: { taskId: 'new-task-for-proj-1', agentId: 'new-agent-for-proj-1' },
        }),
      );
    });
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it('PromptAgent calls sendPrompt with the given taskId/agentId/text and replies ok', async () => {
    setStore('taskOrder', ['t1']);
    setStore('tasks', 't1', { id: 't1', projectId: 'proj-1', agentIds: ['a1'] } as never);
    mockSendPrompt.mockResolvedValue(undefined);
    listenerFor(IPC.JiraWatcher_PromptAgentRequest)?.({
      reqId: 'r3',
      taskId: 't1',
      agentId: 'a1',
      text: '/myl3 DEV_IRREG-1 @a',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendPrompt).toHaveBeenCalledWith('t1', 'a1', '/myl3 DEV_IRREG-1 @a');
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({ reqId: 'r3', ok: true }),
    );
  });

  it('PromptAgent waits for the agent to actually be ready before sending', async () => {
    // Regression test for the bug where /myl3 <ticket> was written into a
    // freshly-spawned CLI before it finished booting: the keystrokes landed
    // on the startup banner and were silently dropped. promptAgent must wait
    // for readiness (the same gate manually-created tasks already get via
    // PromptInput.tsx's autofire) before ever calling sendPrompt.
    setStore('taskOrder', ['t1']);
    setStore('tasks', 't1', { id: 't1', projectId: 'proj-1', agentIds: ['a1'] } as never);
    const callOrder: string[] = [];
    mockWaitUntilAgentReadyForPrompt.mockImplementation(async () => {
      callOrder.push('wait');
    });
    mockSendPrompt.mockImplementation(async () => {
      callOrder.push('send');
    });

    listenerFor(IPC.JiraWatcher_PromptAgentRequest)?.({
      reqId: 'r3b',
      taskId: 't1',
      agentId: 'a1',
      text: '/myl3 DEV_IRREG-1 @a',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockWaitUntilAgentReadyForPrompt).toHaveBeenCalledWith(
      'a1',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
    );
    expect(callOrder).toEqual(['wait', 'send']);
  });

  it('PromptAgent replies with ok:false when sendPrompt rejects', async () => {
    setStore('taskOrder', ['t1']);
    setStore('tasks', 't1', { id: 't1', projectId: 'proj-1', agentIds: ['a1'] } as never);
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

  it('PromptAgent replies with ok:false immediately, without waiting on readiness, when the taskId no longer exists', async () => {
    // Regression test: the Jira watcher's own queue.deployTaskId/
    // implementTaskId cache (electron/ipc/jira-watcher.ts) has no way to
    // learn a task was deleted from the UI. Before this fix, promptAgent
    // would call waitUntilAgentReadyForPrompt for a dead agentId with no
    // real PTY behind it -- readiness could never become true, so the call
    // hung until the main process's own 120s callRenderer timeout finally
    // gave up. Rejecting fast here means jira-watcher.ts's catch (which
    // clears the stale cache) fires in milliseconds, not two minutes.
    setStore('taskOrder', []);
    setStore('tasks', {});
    listenerFor(IPC.JiraWatcher_PromptAgentRequest)?.({
      reqId: 'r-deleted',
      taskId: 'deleted-task',
      agentId: 'deleted-agent',
      text: '/pipeline-deploy',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockWaitUntilAgentReadyForPrompt).not.toHaveBeenCalled();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.JiraWatcher_RendererReply,
      expect.objectContaining({ reqId: 'r-deleted', ok: false, error: 'Task not found' }),
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

import { createRoot } from 'solid-js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setStore } from './core';
import { IPC } from '../../electron/ipc/channels';

const mockFireAndForget = vi.fn();
const mockShowNotification = vi.fn();
vi.mock('../lib/ipc', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}));
vi.mock('./notification', () => ({
  showNotification: (...args: unknown[]) => mockShowNotification(...args),
}));

import {
  startJiraWatcherSubscription,
  jiraWatcherStatus,
  jiraWatcherStatusLabel,
  __resetJiraWatcherStatusForTests,
} from './jira-watcher';

const mockOn = vi.fn();

function statusListener(): ((data: unknown) => void) | undefined {
  return mockOn.mock.calls.find(([channel]) => channel === IPC.JiraWatcherStatus)?.[1] as
    | ((data: unknown) => void)
    | undefined;
}

describe('startJiraWatcherSubscription', () => {
  beforeEach(() => {
    mockFireAndForget.mockClear();
    mockShowNotification.mockClear();
    mockOn.mockClear();
    mockOn.mockReturnValue(vi.fn());
    vi.stubGlobal('window', { electron: { ipcRenderer: { on: mockOn } } });
    __resetJiraWatcherStatusForTests();
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
    let disposeRoot: (() => void) | undefined;
    let stop: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      stop = startJiraWatcherSubscription();
    });
    expect(mockFireAndForget).toHaveBeenCalledWith(
      IPC.StartJiraWatcher,
      {
        projectId: 'p1',
        jiraProjectKey: 'DEV_IRREG',
        jiraTriggerLabel: undefined,
        jiraCompletedLabel: undefined,
        jiraDefaultReviewers: undefined,
      },
      expect.any(Function),
    );
    expect(mockFireAndForget).not.toHaveBeenCalledWith(
      IPC.StartJiraWatcher,
      expect.objectContaining({ projectId: 'p2' }),
    );
    stop?.();
    disposeRoot?.();
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
    let disposeRoot: (() => void) | undefined;
    let stop: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      stop = startJiraWatcherSubscription();
    });
    mockFireAndForget.mockClear();
    stop?.();
    expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StopJiraWatcher, { projectId: 'p1' });
    disposeRoot?.();
  });

  it('surfaces a notification when StartJiraWatcher rejects (e.g. no jiraProjectKey set)', () => {
    // Regression test: startWatchingProject now throws when a project has no
    // Jira project key configured (see jira-watcher.ts), but until this fix
    // fireAndForget had no onError callback -- the rejection was logged to
    // the console and nothing else. A watcher toggle that silently does
    // nothing (no Implementer window, no visible error) is exactly the
    // failure mode that stranded equitystory-ers's watching for days.
    mockFireAndForget.mockImplementation(
      (_cmd: unknown, _args: unknown, onError?: (err: unknown) => void) => {
        onError?.(new Error('Cannot watch project p1: no Jira project key configured.'));
      },
    );
    setStore('projects', [
      { id: 'p1', name: 'A', path: '/a', color: 'red', jiraWatchEnabled: true },
    ]);
    let disposeRoot: (() => void) | undefined;
    let stop: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      stop = startJiraWatcherSubscription();
    });

    expect(mockShowNotification).toHaveBeenCalledWith(
      expect.stringContaining('no Jira project key configured'),
    );
    stop?.();
    disposeRoot?.();
  });
});

describe('jiraWatcherStatus', () => {
  beforeEach(() => {
    mockFireAndForget.mockClear();
    mockOn.mockClear();
    mockOn.mockReturnValue(vi.fn());
    vi.stubGlobal('window', { electron: { ipcRenderer: { on: mockOn } } });
    __resetJiraWatcherStatusForTests();
    setStore('projects', []);
  });

  it('defaults to enabled with no reason', () => {
    expect(jiraWatcherStatus()).toEqual({ disabled: false, disabledReason: null });
    expect(jiraWatcherStatusLabel()).toBe('Watching');
  });

  it('subscribes to JiraWatcherStatus and mirrors a disabled push', () => {
    let disposeRoot: (() => void) | undefined;
    let stop: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      stop = startJiraWatcherSubscription();
    });
    const listener = statusListener();
    expect(listener).toBeDefined();

    listener?.({ disabled: true, disabledReason: 'auth' });
    expect(jiraWatcherStatus()).toEqual({ disabled: true, disabledReason: 'auth' });
    expect(jiraWatcherStatusLabel()).toBe('Disabled: Jira rejected the credentials');

    listener?.({ disabled: true, disabledReason: 'no-credentials' });
    expect(jiraWatcherStatusLabel()).toBe('Disabled: Jira credentials not set');

    listener?.({ disabled: false, disabledReason: null });
    expect(jiraWatcherStatus()).toEqual({ disabled: false, disabledReason: null });
    stop?.();
    disposeRoot?.();
  });

  it('ignores malformed pushes', () => {
    let disposeRoot: (() => void) | undefined;
    let stop: (() => void) | undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      stop = startJiraWatcherSubscription();
    });
    const listener = statusListener();
    listener?.(null);
    listener?.({});
    listener?.({ disabled: 'yes' });
    expect(jiraWatcherStatus()).toEqual({ disabled: false, disabledReason: null });

    // An unknown reason string degrades to a bare "Disabled", not a crash.
    listener?.({ disabled: true, disabledReason: 'weird' });
    expect(jiraWatcherStatus()).toEqual({ disabled: true, disabledReason: null });
    expect(jiraWatcherStatusLabel()).toBe('Disabled');
    stop?.();
    disposeRoot?.();
  });
});

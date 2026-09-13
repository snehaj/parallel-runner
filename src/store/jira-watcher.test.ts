import { createRoot } from 'solid-js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setStore } from './core';
import { IPC } from '../../electron/ipc/channels';

const mockFireAndForget = vi.fn();
vi.mock('../lib/ipc', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
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
    ((data: unknown) => void) | undefined;
}

describe('startJiraWatcherSubscription', () => {
  beforeEach(() => {
    mockFireAndForget.mockClear();
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

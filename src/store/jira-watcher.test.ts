import { createRoot } from 'solid-js';
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

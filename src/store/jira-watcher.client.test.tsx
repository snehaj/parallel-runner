// Lives in the client (happy-dom, ssr:false) vitest config on purpose:
// createEffect is a no-op under the default node/SSR config, so the reactive
// re-sync these tests exercise only happens here.
import { createRoot } from 'solid-js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setStore } from './core';
import { IPC } from '../../electron/ipc/channels';

const mockFireAndForget = vi.fn();
vi.mock('../lib/ipc', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}));

import { startJiraWatcherSubscription } from './jira-watcher';

function withSubscription(body: () => void): void {
  let disposeRoot: (() => void) | undefined;
  let stop: (() => void) | undefined;
  createRoot((dispose) => {
    disposeRoot = dispose;
    stop = startJiraWatcherSubscription();
  });
  try {
    body();
  } finally {
    stop?.();
    disposeRoot?.();
  }
}

describe('startJiraWatcherSubscription settings changes', () => {
  beforeEach(() => {
    mockFireAndForget.mockClear();
    // happy-dom supplies a real `window`, but not the preload-injected
    // `electron` bridge the status subscription reads.
    vi.stubGlobal('window', {
      ...globalThis.window,
      electron: { ipcRenderer: { on: vi.fn().mockReturnValue(vi.fn()) } },
    });
    setStore('projects', []);
  });

  // Regression: `active` used to be a Set of project ids, so an edit to the
  // project key or either label after the project was first enabled never
  // reached the main-process watcher — it kept polling the stale values.
  it('re-sends StartJiraWatcher when jiraProjectKey changes on an already-enabled project', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'A',
        path: '/a',
        color: 'red',
        jiraWatchEnabled: true,
        jiraProjectKey: 'OLD_KEY',
      },
    ]);
    withSubscription(() => {
      mockFireAndForget.mockClear();
      setStore('projects', 0, 'jiraProjectKey', 'NEW_KEY');
      expect(mockFireAndForget).toHaveBeenCalledWith(IPC.StartJiraWatcher, {
        projectId: 'p1',
        jiraProjectKey: 'NEW_KEY',
        jiraTriggerLabel: undefined,
        jiraCompletedLabel: undefined,
      });
    });
  });

  it('re-sends StartJiraWatcher when either label changes', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'A',
        path: '/a',
        color: 'red',
        jiraWatchEnabled: true,
        jiraProjectKey: 'DEV_IRREG',
        jiraTriggerLabel: 'OLD_TRIGGER',
      },
    ]);
    withSubscription(() => {
      mockFireAndForget.mockClear();
      setStore('projects', 0, 'jiraTriggerLabel', 'NEW_TRIGGER');
      expect(mockFireAndForget).toHaveBeenCalledWith(
        IPC.StartJiraWatcher,
        expect.objectContaining({ projectId: 'p1', jiraTriggerLabel: 'NEW_TRIGGER' }),
      );

      mockFireAndForget.mockClear();
      setStore('projects', 0, 'jiraCompletedLabel', 'NEW_DONE');
      expect(mockFireAndForget).toHaveBeenCalledWith(
        IPC.StartJiraWatcher,
        expect.objectContaining({ projectId: 'p1', jiraCompletedLabel: 'NEW_DONE' }),
      );
    });
  });

  it('does not re-send StartJiraWatcher when no tracked field changed', () => {
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
    withSubscription(() => {
      mockFireAndForget.mockClear();
      // An unrelated field change must not re-register the watcher.
      setStore('projects', 0, 'name', 'A renamed');
      expect(
        mockFireAndForget.mock.calls.filter(([channel]) => channel === IPC.StartJiraWatcher),
      ).toHaveLength(0);
    });
  });
});

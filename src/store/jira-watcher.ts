import { createEffect, onCleanup } from 'solid-js';
import { store } from './core';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

/** Public: mirrors startPrChecksSubscription — call once from App.tsx.
 *  Keeps the main-process watcher's set of watched projects in sync with
 *  store.projects' jiraWatchEnabled flags. */
export function startJiraWatcherSubscription(): () => void {
  const active = new Set<string>();

  const sync = (): void => {
    const seen = new Set<string>();
    for (const project of store.projects) {
      if (!project.jiraWatchEnabled) continue;
      seen.add(project.id);
      if (active.has(project.id)) continue;
      active.add(project.id);
      fireAndForget(IPC.StartJiraWatcher, {
        projectId: project.id,
        jiraProjectKey: project.jiraProjectKey,
        jiraTriggerLabel: project.jiraTriggerLabel,
        jiraCompletedLabel: project.jiraCompletedLabel,
      });
    }
    for (const projectId of [...active]) {
      if (!seen.has(projectId)) {
        active.delete(projectId);
        fireAndForget(IPC.StopJiraWatcher, { projectId });
      }
    }
  };

  createEffect(sync);
  sync();

  const cleanup = (): void => {
    for (const projectId of active) {
      fireAndForget(IPC.StopJiraWatcher, { projectId });
    }
    active.clear();
  };
  onCleanup(cleanup);
  return cleanup;
}

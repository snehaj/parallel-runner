import { createEffect, createSignal, onCleanup } from 'solid-js';
import { store } from './core';
import { fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { JiraWatcherStatusPayload } from '../ipc/types';

interface WatchedSettings {
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
}

export type JiraWatcherDisabledReason = 'missing' | 'auth';

const [jiraWatcherStatus, setJiraWatcherStatus] = createSignal<{
  disabled: boolean;
  disabledReason: JiraWatcherDisabledReason | null;
}>({ disabled: false, disabledReason: null });

/** Reactive accessor for the main-process watcher's availability. `disabled`
 *  stays false until the main process reports otherwise, so a project with the
 *  toggle on reads as watching by default. */
export { jiraWatcherStatus };

/** Human-readable status line for the project settings dialog. */
export function jiraWatcherStatusLabel(): string {
  const status = jiraWatcherStatus();
  if (!status.disabled) return 'Watching';
  if (status.disabledReason === 'auth') return 'Disabled: Claude Code not authenticated';
  if (status.disabledReason === 'missing') return 'Disabled: claude CLI not found';
  return 'Disabled';
}

/** Exposed for tests only — resets the module-level status signal. */
export function __resetJiraWatcherStatusForTests(): void {
  setJiraWatcherStatus({ disabled: false, disabledReason: null });
}

/** Public: mirrors startPrChecksSubscription — call once from App.tsx.
 *  Keeps the main-process watcher's set of watched projects in sync with
 *  store.projects' jiraWatchEnabled flags, and mirrors the watcher's
 *  disabled state into `jiraWatcherStatus`. */
export function startJiraWatcherSubscription(): () => void {
  // Tracks the settings we last sent per project, not just its id: the main
  // process stores the project key and both label names on its watch entry, so
  // an edit to any of them has to be re-sent or the watcher keeps polling with
  // the stale values. Mirrors pr-checks.ts's activeByTaskId, which tracks
  // prUrl + taskName for the same reason.
  const active = new Map<string, WatchedSettings>();

  const sync = (): void => {
    const seen = new Set<string>();
    for (const project of store.projects) {
      if (!project.jiraWatchEnabled) continue;
      seen.add(project.id);
      const next: WatchedSettings = {
        jiraProjectKey: project.jiraProjectKey,
        jiraTriggerLabel: project.jiraTriggerLabel,
        jiraCompletedLabel: project.jiraCompletedLabel,
      };
      const prev = active.get(project.id);
      if (
        prev &&
        prev.jiraProjectKey === next.jiraProjectKey &&
        prev.jiraTriggerLabel === next.jiraTriggerLabel &&
        prev.jiraCompletedLabel === next.jiraCompletedLabel
      ) {
        continue;
      }
      active.set(project.id, next);
      fireAndForget(IPC.StartJiraWatcher, { projectId: project.id, ...next });
    }
    for (const projectId of [...active.keys()]) {
      if (!seen.has(projectId)) {
        active.delete(projectId);
        fireAndForget(IPC.StopJiraWatcher, { projectId });
      }
    }
  };

  const offStatus = window.electron.ipcRenderer.on(IPC.JiraWatcherStatus, (data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const msg = data as Partial<JiraWatcherStatusPayload>;
    if (typeof msg.disabled !== 'boolean') return;
    setJiraWatcherStatus({
      disabled: msg.disabled,
      disabledReason:
        msg.disabledReason === 'missing' || msg.disabledReason === 'auth'
          ? msg.disabledReason
          : null,
    });
  });

  createEffect(sync);
  sync();

  const cleanup = (): void => {
    offStatus();
    for (const projectId of active.keys()) {
      fireAndForget(IPC.StopJiraWatcher, { projectId });
    }
    active.clear();
  };
  onCleanup(cleanup);
  return cleanup;
}

import { createEffect, createSignal, onCleanup } from 'solid-js';
import { store } from './core';
import { fireAndForget } from '../lib/ipc';
import { showNotification } from './notification';
import { IPC } from '../../electron/ipc/channels';
import type { JiraWatcherStatusPayload } from '../ipc/types';

interface WatchedSettings {
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
  jiraDefaultReviewers?: string;
}

export type JiraWatcherDisabledReason = 'no-credentials' | 'auth';

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
  if (status.disabledReason === 'auth') return 'Disabled: Jira rejected the credentials';
  if (status.disabledReason === 'no-credentials') return 'Disabled: Jira credentials not set';
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
        jiraDefaultReviewers: project.jiraDefaultReviewers,
      };
      const prev = active.get(project.id);
      if (
        prev &&
        prev.jiraProjectKey === next.jiraProjectKey &&
        prev.jiraTriggerLabel === next.jiraTriggerLabel &&
        prev.jiraCompletedLabel === next.jiraCompletedLabel &&
        prev.jiraDefaultReviewers === next.jiraDefaultReviewers
      ) {
        continue;
      }
      // Set BEFORE the call (not after it succeeds) so a rejection doesn't
      // leave this project looking "unsent": the next reactive sync() run
      // would otherwise see no prev entry, treat the settings as newly
      // changed, and refire StartJiraWatcher every tick -- spamming the
      // notification below instead of surfacing it once per real change.
      active.set(project.id, next);
      fireAndForget(IPC.StartJiraWatcher, { projectId: project.id, ...next }, (err) => {
        // startWatchingProject throws when jiraProjectKey is missing/blank
        // (see jira-watcher.ts's own comment) rather than silently watching
        // with malformed JQL. Without this callback that rejection was only
        // ever console.error'd -- the toggle looked like it worked (no error
        // in the UI) while nothing was ever actually watched.
        showNotification(err instanceof Error ? err.message : String(err));
      });
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
        msg.disabledReason === 'no-credentials' || msg.disabledReason === 'auth'
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

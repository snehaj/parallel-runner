// Per-project Jira board watcher. Polls each opted-in project for tickets
// labeled REG_AUTOMATED and spawns a real Parallel Code task for each one.
// See docs/superpowers/specs/2026-09-11-jira-board-watcher-design.md and
// docs/superpowers/specs/2026-09-14-jira-watcher-rest-rewrite-design.md.

import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { IPC } from './channels.js';
import { queryLabeledTickets, swapTicketLabel, JiraApiError } from './jira-client.js';
import type { JiraWatcherStatusPayload } from './shared-types.js';

/** True if any task name in `names` contains `ticketKey` as an exact
 *  substring bounded so a prefix ticket key (DEV_IRREG-123) never matches a
 *  task named for a longer key that starts with it (DEV_IRREG-1234). Bounds
 *  the match on a non-digit (or string end) immediately after the key. */
export function hasTicketKey(names: string[], ticketKey: string): boolean {
  const escaped = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?!\\d)`);
  return names.some((name) => pattern.test(name));
}

const MAX_TASK_NAME_LENGTH = 200; // matches Remote_CreateTaskRequest's own 200-char cap

/** Builds a task name from a ticket key + summary, truncating the summary
 *  (never the key) so the result never exceeds Remote_CreateTaskRequest's
 *  200-character limit. */
export function buildTaskName(ticketKey: string, summary: string): string {
  const prefix = `${ticketKey}: `;
  const maxSummaryLength = MAX_TASK_NAME_LENGTH - prefix.length;
  const truncatedSummary =
    summary.length > maxSummaryLength ? summary.slice(0, maxSummaryLength) : summary;
  return `${prefix}${truncatedSummary}`;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Main-process half of the Jira-watcher's own task-creation bridge — the
 *  SAME PATTERN as register.ts's mobile task-creation bridge (main asks the
 *  renderer to run its real createTask/task-list logic and reports back),
 *  but on its own dedicated channels. NOT shared with the mobile bridge:
 *  that bridge's callRenderer is closure-local to registerAllHandlers with
 *  its own single ipcMain.handle(Remote_RendererReply, ...) registration —
 *  ipcMain.handle only allows one handler per channel, so reusing it isn't
 *  possible without restructuring working, unrelated code. Call once from
 *  registerAllHandlers, same lifetime as the window. */
export function initJiraWatcherBridge(win: BrowserWindow): {
  createTask: (opts: { projectId: string; name: string; prompt: string }) => Promise<{
    taskId: string;
  }>;
  listTaskNames: (projectId: string) => Promise<string[]>;
  ensureImplementerTask: (projectId: string) => Promise<{ taskId: string; agentId: string }>;
  ensureDeployerTask: (projectId: string) => Promise<{ taskId: string; agentId: string }>;
  promptAgent: (taskId: string, agentId: string, text: string) => Promise<void>;
  waitForAgentReady: (agentId: string) => Promise<void>;
} {
  const pending = new Map<string, PendingRequest>();

  function callRenderer<T>(channel: string, payload: Record<string, unknown>): Promise<T> {
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (win.isDestroyed()) {
        reject(new Error('Desktop app is not available'));
        return;
      }
      // Same 120s timeout as the mobile bridge — creating a task builds a
      // git worktree, which can be slow on large repos.
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('Desktop app did not respond'));
      }, 120_000);
      pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      win.webContents.send(channel, { reqId, ...payload });
    });
  }

  ipcMain.handle(
    IPC.JiraWatcher_RendererReply,
    (_e, args: { reqId: string; ok: boolean; data?: unknown; error?: string }) => {
      const entry = pending.get(args.reqId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(args.reqId);
      if (args.ok) entry.resolve(args.data);
      else entry.reject(new Error(args.error ?? 'Request failed'));
    },
  );

  return {
    createTask: (opts) => callRenderer<{ taskId: string }>(IPC.JiraWatcher_CreateTaskRequest, opts),
    listTaskNames: (projectId) =>
      callRenderer<{ names: string[] }>(IPC.JiraWatcher_ListTaskNamesRequest, {
        projectId,
      }).then((r) => r.names),
    ensureImplementerTask: (projectId) =>
      callRenderer<{ taskId: string; agentId: string }>(
        IPC.JiraWatcher_EnsureImplementerTaskRequest,
        { projectId },
      ),
    ensureDeployerTask: (projectId) =>
      callRenderer<{ taskId: string; agentId: string }>(IPC.JiraWatcher_EnsureDeployerTaskRequest, {
        projectId,
      }),
    promptAgent: (taskId, agentId, text) =>
      callRenderer<undefined>(IPC.JiraWatcher_PromptAgentRequest, { taskId, agentId, text }),
    waitForAgentReady: (agentId) =>
      callRenderer<undefined>(IPC.JiraWatcher_WaitForAgentReadyRequest, { agentId }),
  };
}

const TICK_MS = 3 * 60_000; // 3 minutes — Jira polling has no reason to match pr-checks.ts's 30s
const DEFAULT_TRIGGER_LABEL = 'REG_AUTOMATED';
const DEFAULT_COMPLETED_LABEL = 'REG_AUTOMATED_SUCC';

interface WatchedProject {
  id: string;
  /** The Jira project key this project's JQL query runs against. Stored on the
   *  entry (not passed per call) so every recurring tick has it, not just the
   *  one-shot poll `startWatchingProject` fires. */
  jiraProjectKey: string;
  triggerLabel: string;
  completedLabel: string;
}

let jiraWin: BrowserWindow | null = null;
let jiraBridge: ReturnType<typeof initJiraWatcherBridge> | null = null;
let watched = new Map<string, WatchedProject>();
let jiraTickHandle: ReturnType<typeof setInterval> | null = null;
let jiraIsPolling = false;
let jiraDisabled = false;
let jiraDisabledReason: 'no-credentials' | 'auth' | null = null;
/** Per-project re-entrancy guard: protects both the scheduled tick and the
 *  manual "check now" trigger from overlapping polls of the same project. */
const pollingProjectIds = new Set<string>();

/** Public: wire window-lifecycle listeners and create the task-creation
 *  bridge. Call once from registerAllHandlers, same as initPrChecks. */
export function initJiraWatcher(mainWindow: BrowserWindow): void {
  jiraWin = mainWindow;
  jiraBridge = initJiraWatcherBridge(mainWindow);
  mainWindow.on('show', () => {
    if (watched.size > 0 && !jiraDisabled) {
      ensureJiraInterval();
      runJiraTick().catch((err) => console.warn('[jira-watcher] show tick failed:', err));
    }
  });
  mainWindow.on('hide', () => clearJiraTickInterval());
  mainWindow.on('minimize', () => clearJiraTickInterval());
  mainWindow.on('restore', () => {
    if (watched.size > 0 && !jiraDisabled) {
      ensureJiraInterval();
      runJiraTick().catch((err) => console.warn('[jira-watcher] restore tick failed:', err));
    }
  });
  mainWindow.on('closed', () => {
    jiraWin = null;
    clearJiraTickInterval();
    watched.clear();
  });
}

/** Public: enable watching for one project. The Jira project key cannot be
 *  reliably derived from a folder name, so it comes from the caller — the
 *  renderer subscription passes the project's own `jiraProjectKey` field. */
export function startWatchingProject(project: {
  id: string;
  jiraProjectKey?: string;
  jiraTriggerLabel?: string;
  jiraCompletedLabel?: string;
}): void {
  if (jiraDisabled) return;
  watched.set(project.id, {
    id: project.id,
    jiraProjectKey: project.jiraProjectKey ?? '',
    triggerLabel: project.jiraTriggerLabel ?? DEFAULT_TRIGGER_LABEL,
    completedLabel: project.jiraCompletedLabel ?? DEFAULT_COMPLETED_LABEL,
  });
  // Give the renderer an initial state so its badge/settings line isn't blank
  // until the first failure changes something.
  sendJiraStatus();
  ensureJiraInterval();
  pollOneProject(project.id).catch(handleJiraError);
}

/** Pushes the watcher's current availability to the renderer. One-way, no
 *  reply — same shape as pr-checks.ts's PrChecksUpdate push. */
function sendJiraStatus(): void {
  if (!jiraWin || jiraWin.isDestroyed()) return;
  const payload: JiraWatcherStatusPayload = {
    disabled: jiraDisabled,
    disabledReason: jiraDisabledReason,
  };
  jiraWin.webContents.send(IPC.JiraWatcherStatus, payload);
}

export function stopWatchingProject(projectId: string): void {
  watched.delete(projectId);
  if (watched.size === 0) clearJiraTickInterval();
}

function jiraWindowIsVisible(): boolean {
  return !!jiraWin && !jiraWin.isDestroyed() && jiraWin.isVisible();
}

function ensureJiraInterval(): void {
  if (jiraTickHandle || jiraDisabled) return;
  if (!jiraWindowIsVisible()) return;
  jiraTickHandle = setInterval(() => {
    runJiraTick().catch((err) => console.warn('[jira-watcher] tick failed:', err));
  }, TICK_MS);
  jiraTickHandle.unref();
}

function clearJiraTickInterval(): void {
  if (jiraTickHandle) {
    clearInterval(jiraTickHandle);
    jiraTickHandle = null;
  }
}

async function runJiraTick(): Promise<void> {
  if (jiraDisabled || jiraIsPolling) return;
  jiraIsPolling = true;
  try {
    await Promise.all(
      Array.from(watched.keys()).map((id) => pollOneProject(id).catch(handleJiraError)),
    );
  } finally {
    jiraIsPolling = false;
  }
}

async function pollOneProject(projectId: string): Promise<void> {
  const entry = watched.get(projectId);
  if (!entry || !jiraBridge) return;
  if (pollingProjectIds.has(projectId)) return;
  pollingProjectIds.add(projectId);

  try {
    // Let the caller decide how to route a failure here: runJiraTick's call
    // sites swallow via .catch(handleJiraError), while triggerJiraCheckNow
    // needs the rejection to surface a specific error in the UI.
    const tickets = await queryLabeledTickets(entry.jiraProjectKey, entry.triggerLabel);

    for (const ticket of tickets) {
      let existingNames: string[];
      try {
        existingNames = await jiraBridge.listTaskNames(projectId);
      } catch (err) {
        console.warn('[jira-watcher] listTaskNames failed:', err);
        continue;
      }
      if (hasTicketKey(existingNames, ticket.key)) continue;

      let created: { taskId: string };
      try {
        created = await jiraBridge.createTask({
          projectId,
          name: buildTaskName(ticket.key, ticket.summary),
          prompt: `Implement ${ticket.key}: ${ticket.summary}`,
        });
      } catch (err) {
        console.warn('[jira-watcher] createTask failed for', ticket.key, err);
        continue;
      }
      void created; // taskId not currently used further, but kept for future logging/telemetry

      try {
        await swapTicketLabel(ticket.key, entry.triggerLabel, entry.completedLabel);
      } catch (err) {
        console.warn('[jira-watcher] label swap failed for', ticket.key, err);
        // Ticket keeps triggerLabel — caught by the hasTicketKey check next tick.
      }
    }
  } finally {
    pollingProjectIds.delete(projectId);
  }
}

/** Public: manually trigger a single-project poll outside the scheduled tick.
 *  Unlike runJiraTick's call sites (which swallow via .catch(handleJiraError)),
 *  this rethrows after handleJiraError so the UI can surface the failure. */
export async function triggerJiraCheckNow(projectId: string): Promise<void> {
  try {
    await pollOneProject(projectId);
  } catch (err) {
    handleJiraError(err);
    throw err;
  }
}

function handleJiraError(err: unknown): void {
  if (jiraDisabled) return;
  if (err instanceof JiraApiError) {
    if (err.status === 0) {
      jiraDisabled = true;
      jiraDisabledReason = 'no-credentials';
      console.warn(
        '[jira-watcher] no Jira credentials configured — watcher disabled for this session',
      );
      clearJiraTickInterval();
      sendJiraStatus();
      return;
    }
    if (err.status === 401 || err.status === 403) {
      jiraDisabled = true;
      jiraDisabledReason = 'auth';
      console.warn(
        '[jira-watcher] Jira rejected the credentials — watcher disabled for this session',
      );
      clearJiraTickInterval();
      sendJiraStatus();
      return;
    }
  }
  console.warn('[jira-watcher] transient failure:', (err as Error)?.message ?? err);
}

// --- Test seams ---

export function __resetJiraWatcherForTests(): void {
  jiraWin = null;
  jiraBridge = null;
  watched = new Map();
  clearJiraTickInterval();
  jiraIsPolling = false;
  jiraDisabled = false;
  jiraDisabledReason = null;
}

/** Runs one scheduled tick synchronously, the way the interval callback would.
 *  Mirrors pr-checks.ts's __runTickForTests — the interval path is otherwise
 *  unreachable from tests. */
export function __runJiraTickForTests(): Promise<void> {
  return runJiraTick();
}

export function getJiraWatcherStateForTests(): {
  disabled: boolean;
  disabledReason: 'no-credentials' | 'auth' | null;
  watchedProjectIds: string[];
} {
  return {
    disabled: jiraDisabled,
    disabledReason: jiraDisabledReason,
    watchedProjectIds: Array.from(watched.keys()),
  };
}

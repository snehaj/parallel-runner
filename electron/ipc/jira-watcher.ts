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
  timer: NodeJS.Timeout | undefined;
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

  function callRenderer<T>(
    channel: string,
    payload: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<T> {
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (win.isDestroyed()) {
        reject(new Error('Desktop app is not available'));
        return;
      }
      pending.set(reqId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        // 0 disables the timeout entirely -- waitForAgentReady can legitimately
        // stay pending for as long as the ticket's own work takes (minutes to
        // hours), unlike every other bridge call here which is a quick
        // request/reply round-trip.
        timer:
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(reqId);
                reject(new Error('Desktop app did not respond'));
              }, timeoutMs)
            : undefined,
      });
      win.webContents.send(channel, { reqId, ...payload });
    });
  }

  ipcMain.handle(
    IPC.JiraWatcher_RendererReply,
    (_e, args: { reqId: string; ok: boolean; data?: unknown; error?: string }) => {
      const entry = pending.get(args.reqId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
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
      callRenderer<undefined>(IPC.JiraWatcher_WaitForAgentReadyRequest, { agentId }, 0),
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
  /** Default reviewers string (e.g. "@avnair @spummer") passed verbatim as
   *  myl3's `reviewers` argument for every auto-queued ticket. Empty string
   *  if unset -- myl3 still runs but without named reviewers on the MR. */
  defaultReviewers: string;
}

interface ProjectQueue {
  /** Ticket keys waiting for the Implementer window, FIFO. Does not include
   *  the ticket currently being worked -- that one has already been dequeued
   *  and handed to myl3 via promptAgent; this array is only "not yet started". */
  implementQueue: string[];
  /** Ticket key currently dequeued and being worked (via promptAgent), if any.
   *  Distinct from implementQueue (not-yet-started tickets) -- prevents
   *  rediscovering this ticket from re-enqueuing it. */
  implementCurrentTicket: string | null;
  /** Set once ensureImplementerTask's create-task round-trip resolves. Reused
   *  on every subsequent refill so the window is created at most once per
   *  project. */
  implementTaskId: string | null;
  implementAgentId: string | null;
  /** Set once ensureDeployerTask's create-task round-trip resolves. The
   *  Deployer has no explicit ticket queue -- see jira-watcher-sequential-
   *  queue-design.md's "Deployer window" section. */
  deployTaskId: string | null;
  deployAgentId: string | null;
}

function emptyProjectQueue(): ProjectQueue {
  return {
    implementQueue: [],
    implementCurrentTicket: null,
    implementTaskId: null,
    implementAgentId: null,
    deployTaskId: null,
    deployAgentId: null,
  };
}

let jiraWin: BrowserWindow | null = null;
let jiraBridge: ReturnType<typeof initJiraWatcherBridge> | null = null;
let watched = new Map<string, WatchedProject>();
let projectQueues = new Map<string, ProjectQueue>();
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
  jiraDefaultReviewers?: string;
}): void {
  // A blank/missing key used to be silently coerced to '', producing
  // malformed JQL ("project =  AND labels = ...") that Jira either rejects
  // or returns zero results for -- forever, with no visible error: the
  // project *looks* watched (queue entry created, no thrown error surfaced
  // anywhere) while the Implementer queue never receives a single ticket.
  // Reject up front instead so the caller (the IPC handler) can surface a
  // real error to the user.
  if (!project.jiraProjectKey?.trim()) {
    throw new Error(
      `Cannot watch project ${project.id}: no Jira project key configured. ` +
        'Set one in the project settings before enabling the Jira board watcher.',
    );
  }
  if (jiraDisabled) return;
  watched.set(project.id, {
    id: project.id,
    jiraProjectKey: project.jiraProjectKey,
    triggerLabel: project.jiraTriggerLabel ?? DEFAULT_TRIGGER_LABEL,
    completedLabel: project.jiraCompletedLabel ?? DEFAULT_COMPLETED_LABEL,
    defaultReviewers: project.jiraDefaultReviewers ?? '',
  });
  if (!projectQueues.has(project.id)) {
    projectQueues.set(project.id, emptyProjectQueue());
  }
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
  // Deliberately do NOT delete the ProjectQueue entry here -- it caches
  // implementTaskId/implementAgentId/deployTaskId/deployAgentId, which must
  // survive a stop/restart cycle (e.g. toggling "Watch Jira board" off then
  // on) so the next refill reuses the existing "Jira Implementer"/"Jira
  // Deployer" task instead of minting a duplicate. Only clear the
  // in-flight-work state that shouldn't carry over: not-yet-started tickets
  // and the "currently in progress" marker (a ticket the Implementer was
  // mid-way through when watching stopped is no longer being tracked as
  // in-progress by this project, since polling itself has stopped).
  const queue = projectQueues.get(projectId);
  if (queue) {
    queue.implementQueue = [];
    queue.implementCurrentTicket = null;
  }
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
      const queue = projectQueues.get(projectId);
      if (!queue) continue; // project stopped watching mid-poll
      if (queue.implementCurrentTicket === ticket.key) continue; // already in progress
      if (queue.implementQueue.includes(ticket.key)) continue; // already queued

      let existingNames: string[];
      try {
        existingNames = await jiraBridge.listTaskNames(projectId);
      } catch (err) {
        console.warn('[jira-watcher] listTaskNames failed:', err);
        continue;
      }
      // Legacy check: catches a pre-migration per-ticket task name (e.g.
      // "DEV_IRREG-1234: ..."), which the new architecture never creates
      // (tasks are always named "Jira Implementer"/"Jira Deployer" now).
      // Kept as a safety net for tickets whose old-style task predates this
      // branch; remove once no such tasks remain in the field.
      if (hasTicketKey(existingNames, ticket.key)) continue;

      queue.implementQueue.push(ticket.key);
      // Label swap deliberately deferred to refillImplementerIfIdle, right
      // after promptAgent confirms delivery -- NOT here on enqueue. Swapping
      // here would strip triggerLabel before the ticket is actually handed
      // to the Implementer; if promptAgent's request/reply round-trip never
      // completes (e.g. the CLI was still booting -- see
      // agent-send-readiness.ts and the incident that motivated this), the
      // ticket permanently loses triggerLabel despite never being
      // implemented, silently falling out of the watcher with no automatic
      // way back in.
    }

    await refillImplementerIfIdle(projectId);
    void refillDeployerIfIdle(projectId);
  } finally {
    pollingProjectIds.delete(projectId);
  }
}

/** Per-project re-entrancy guard so two overlapping refill attempts (e.g. a
 *  poll tick firing while a previous refill's ensureImplementerTask call is
 *  still in flight) never both dequeue+prompt. */
const implementerBusy = new Set<string>();

async function refillImplementerIfIdle(projectId: string): Promise<void> {
  const queue = projectQueues.get(projectId);
  if (!queue || !jiraBridge) return;
  if (queue.implementQueue.length === 0) return;
  if (implementerBusy.has(projectId)) return;
  implementerBusy.add(projectId);

  try {
    if (!queue.implementTaskId || !queue.implementAgentId) {
      const created = await jiraBridge.ensureImplementerTask(projectId);
      queue.implementTaskId = created.taskId;
      queue.implementAgentId = created.agentId;
    }
    const ticketKey = queue.implementQueue.shift();
    if (!ticketKey) return; // queue drained by another path between the checks above and here
    queue.implementCurrentTicket = ticketKey;

    const watchedEntry = watched.get(projectId);
    const reviewers = watchedEntry?.defaultReviewers ?? '';
    const promptText = reviewers ? `/myl3 ${ticketKey} ${reviewers}` : `/myl3 ${ticketKey}`;

    await jiraBridge.promptAgent(queue.implementTaskId, queue.implementAgentId, promptText);

    // Swap the trigger label for the completed label only now that
    // promptAgent has confirmed the ticket was actually handed to the
    // Implementer -- see the discovery loop's comment in pollOneProject for
    // why this must not happen any earlier.
    if (watchedEntry) {
      try {
        await swapTicketLabel(ticketKey, watchedEntry.triggerLabel, watchedEntry.completedLabel);
      } catch (err) {
        console.warn('[jira-watcher] label swap failed for', ticketKey, err);
        // Ticket keeps triggerLabel -- caught by the implementCurrentTicket
        // check in pollOneProject's discovery loop on the next tick (not
        // hasTicketKey, which only matches pre-migration per-ticket task names).
      }
    }

    // Re-arm for the NEXT ticket once this one finishes. Deliberately not
    // awaited inline here -- waitForAgentReady can stay pending for the
    // ticket's entire run, and refillImplementerIfIdle must return promptly
    // so the poll tick that called it isn't blocked for that whole duration.
    void jiraBridge
      .waitForAgentReady(queue.implementAgentId)
      .then(() => {
        implementerBusy.delete(projectId);
        queue.implementCurrentTicket = null;
        return refillImplementerIfIdle(projectId);
      })
      .catch((err) => {
        implementerBusy.delete(projectId);
        queue.implementCurrentTicket = null;
        console.warn('[jira-watcher] waitForAgentReady failed for', projectId, err);
      });
  } catch (err) {
    implementerBusy.delete(projectId);
    queue.implementCurrentTicket = null;
    console.warn('[jira-watcher] refillImplementerIfIdle failed for', projectId, err);
  }
}

/** Per-project re-entrancy guard: protects deployer bootstrap+prompt from
 *  overlapping across concurrent refill attempts, same rationale as
 *  implementerBusy above. */
const deployerBusy = new Set<string>();

async function refillDeployerIfIdle(projectId: string): Promise<void> {
  const queue = projectQueues.get(projectId);
  if (!queue || !jiraBridge) return;
  if (deployerBusy.has(projectId)) return;
  deployerBusy.add(projectId);

  try {
    if (!queue.deployTaskId || !queue.deployAgentId) {
      const created = await jiraBridge.ensureDeployerTask(projectId);
      queue.deployTaskId = created.taskId;
      queue.deployAgentId = created.agentId;
    }

    await jiraBridge.promptAgent(queue.deployTaskId, queue.deployAgentId, '/pipeline-deploy');

    // Same "don't await inline" reasoning as refillImplementerIfIdle: a
    // deploy pass can run long, and this function must return promptly so
    // the calling poll tick isn't blocked.
    void jiraBridge
      .waitForAgentReady(queue.deployAgentId)
      .then(() => {
        deployerBusy.delete(projectId);
        // No unconditional re-arm here -- unlike the Implementer (which has
        // an explicit queue to drain), the Deployer's next prompt is sent by
        // the NEXT poll tick / Check-Jira-Now call reaching this function
        // again, not by this callback re-triggering itself. This matches the
        // design's "same cadence as the Implementer's poll" refill rule.
      })
      .catch((err) => {
        deployerBusy.delete(projectId);
        console.warn('[jira-watcher] Deployer waitForAgentReady failed for', projectId, err);
      });
  } catch (err) {
    deployerBusy.delete(projectId);
    console.warn('[jira-watcher] refillDeployerIfIdle failed for', projectId, err);
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
  projectQueues = new Map();
  clearJiraTickInterval();
  jiraIsPolling = false;
  jiraDisabled = false;
  jiraDisabledReason = null;
  pollingProjectIds.clear();
  implementerBusy.clear();
  deployerBusy.clear();
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

export function getProjectQueueStateForTests(
  projectId: string,
):
  | { implementQueue: string[]; implementTaskId: string | null; deployTaskId: string | null }
  | undefined {
  const q = projectQueues.get(projectId);
  return q
    ? {
        implementQueue: [...q.implementQueue],
        implementTaskId: q.implementTaskId,
        deployTaskId: q.deployTaskId,
      }
    : undefined;
}

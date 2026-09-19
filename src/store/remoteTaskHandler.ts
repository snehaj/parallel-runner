// Handles task-creation requests from paired phones. The remote HTTP server
// (main process) forwards them here so we can run the renderer's normal
// createTask orchestration — the same path the desktop "New Task" dialog uses —
// and reply with the resulting task id. See electron/ipc/register.ts for the
// main-side bridge.

import { store } from './core';
import { createTask, sendPrompt, updateTaskNotes } from './tasks';
import { onAgentReady, getAgentOutputTail } from './taskStatus';
import { waitUntilAgentReadyForPrompt } from './agent-send-readiness';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { GitIgnoredEntry } from '../ipc/types';

/** Same stability-check tuning PromptInput.tsx's autofire path uses for
 *  manually-created tasks (PROMPT_STABILITY_CHECKS / PROMPT_RECHECK_DELAY_MS /
 *  STABILITY_MAX_FAILURES / QUIESCENCE_POLL_MS) -- kept in sync deliberately
 *  rather than imported, since PromptInput.tsx's constants are private to
 *  its own auto-send effect. */
const AGENT_READY_WAIT_OPTS = {
  stabilityChecks: 2,
  recheckDelayMs: 1_500,
  maxStabilityFailures: 3,
  pollIntervalMs: 500,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RendererRequest {
  reqId: string;
}

interface CreateTaskRequest extends RendererRequest {
  projectId: string;
  name: string;
  prompt: string;
}

interface GetNotesRequest extends RendererRequest {
  taskId: string;
}

interface SetNotesRequest extends RendererRequest {
  taskId: string;
  notes: string;
}

interface ListTaskNamesRequest extends RendererRequest {
  projectId: string;
}

interface EnsureTaskRequest extends RendererRequest {
  projectId: string;
}

interface PromptAgentRequest extends RendererRequest {
  taskId: string;
  agentId: string;
  text: string;
}

interface WaitForAgentReadyRequest extends RendererRequest {
  agentId: string;
}

function reply(
  reqId: string,
  ok: boolean,
  data?: unknown,
  error?: string,
  channel: IPC = IPC.Remote_RendererReply,
): void {
  // Fire-and-forget: main resolves/rejects the pending HTTP response by reqId.
  invoke(channel, { reqId, ok, data, error }).catch(() => {});
}

function handleGetProjects(req: RendererRequest): void {
  reply(
    req.reqId,
    true,
    store.projects.map((p) => ({ id: p.id, name: p.name })),
  );
}

/** Shared core for both callers of the create-task round-trip: the mobile
 *  pairing bridge (`Remote_CreateTaskRequest`) and the Jira board watcher
 *  (`JiraWatcher_CreateTaskRequest`). The request shape is identical; only the
 *  reply channel differs, because main registers one `ipcMain.handle` per
 *  reply channel and each bridge owns its own pending-request map. */
async function createTaskForRequest(req: CreateTaskRequest, replyChannel: IPC): Promise<void> {
  try {
    const project = store.projects.find((p) => p.id === req.projectId);
    if (!project) throw new Error('Project not found');

    // Default agent: the last one used, else the first available (mirrors the
    // New Task dialog's initial selection).
    const agentDef =
      store.availableAgents.find((a) => a.id === store.lastAgentId) ?? store.availableAgents[0];
    if (!agentDef) throw new Error('No agent configured');

    // Non-git projects can't use worktree isolation; fall back to working
    // directly in the project folder.
    const isGit = project.isGitRepo !== false;
    let baseBranch = '';
    let symlinkDirs: string[] = [];
    if (isGit) {
      baseBranch =
        project.defaultBaseBranch ??
        (await invoke<string>(IPC.GetMainBranch, { projectRoot: project.path }));
      // Match the desktop New Task default without opting remote users into
      // newly discovered entries that have no confirmation UI.
      const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
        projectRoot: project.path,
      });
      symlinkDirs = ignoredEntries.filter((entry) => entry.isDefault).map((entry) => entry.name);
    }

    const taskId = await createTask({
      name: req.name,
      agentDef,
      projectId: req.projectId,
      gitIsolation: isGit ? 'worktree' : 'none',
      baseBranch,
      symlinkDirs,
      initialPrompt: req.prompt,
    });
    reply(req.reqId, true, { taskId }, undefined, replyChannel);
  } catch (err) {
    reply(
      req.reqId,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      replyChannel,
    );
  }
}

/** Mobile pairing bridge: replies on `Remote_RendererReply`. */
function handleCreateTask(req: CreateTaskRequest): Promise<void> {
  return createTaskForRequest(req, IPC.Remote_RendererReply);
}

/** Jira board watcher bridge: replies on `JiraWatcher_RendererReply`, which is
 *  where `initJiraWatcherBridge` awaits its pending create-task requests. */
function handleJiraCreateTask(req: CreateTaskRequest): Promise<void> {
  return createTaskForRequest(req, IPC.JiraWatcher_RendererReply);
}

/**
 * True only when `taskId` is a real, own entry of the tasks record.
 *
 * Uses Object.hasOwn, NOT truthiness: `taskId` arrives from a mobile HTTP
 * request, and Solid's store proxy resolves inherited keys (`__proto__`,
 * `constructor`, `toString`, …) to prototype objects, which are truthy but are
 * not tasks. A truthiness guard would let updateTaskNotes → setStore('tasks',
 * '__proto__', 'notes', …) pollute Object.prototype. hasOwn reports only own
 * properties, so it rejects every inherited/dangerous/missing key.
 */
export function isKnownTask(tasks: Record<string, unknown>, taskId: string): boolean {
  return Object.hasOwn(tasks, taskId);
}

function handleGetNotes(req: GetNotesRequest): void {
  if (!isKnownTask(store.tasks, req.taskId)) {
    reply(req.reqId, false, undefined, 'Task not found');
    return;
  }
  reply(req.reqId, true, { notes: store.tasks[req.taskId].notes ?? '' });
}

function handleSetNotes(req: SetNotesRequest): void {
  if (!isKnownTask(store.tasks, req.taskId)) {
    reply(req.reqId, false, undefined, 'Task not found');
    return;
  }
  updateTaskNotes(req.taskId, req.notes);
  reply(req.reqId, true, { ok: true });
}

function handleListTaskNames(req: ListTaskNamesRequest): void {
  const names = store.taskOrder
    .map((id) => store.tasks[id])
    .filter((task) => task?.projectId === req.projectId)
    .map((task) => task.name);
  reply(req.reqId, true, { names }, undefined, IPC.JiraWatcher_RendererReply);
}

/** Shared by EnsureImplementerTask/EnsureDeployerTask -- creates one
 *  persistent, un-prompted task (no initialPrompt) for the given project and
 *  replies with {taskId, agentId}. `name` distinguishes the Implementer's
 *  window from the Deployer's in the task list. */
async function ensurePersistentTask(req: EnsureTaskRequest, name: string): Promise<void> {
  try {
    const project = store.projects.find((p) => p.id === req.projectId);
    if (!project) throw new Error('Project not found');

    // Reuse an existing same-name task for this project if one already
    // exists in the renderer's own task list. The main process's own
    // implementTaskId/deployTaskId cache (jira-watcher.ts's ProjectQueue) is
    // the only other thing that would normally prevent a duplicate, but it
    // resets to empty on every app/dev-server restart while this task list
    // survives -- without this check, the very first refill after any
    // restart always mints a second "Jira Implementer"/"Jira Deployer"
    // window alongside the still-live original.
    const existing = store.taskOrder
      .map((id) => store.tasks[id])
      .find((task) => task?.projectId === req.projectId && task?.name === name);
    if (existing) {
      const existingAgentId = existing.agentIds[0];
      if (existingAgentId) {
        reply(
          req.reqId,
          true,
          { taskId: existing.id, agentId: existingAgentId },
          undefined,
          IPC.JiraWatcher_RendererReply,
        );
        return;
      }
      // Falls through to create a fresh task if the existing record somehow
      // has no agent -- an unexpected but non-fatal state, not worth failing
      // the whole ensure over.
    }

    const agentDef =
      store.availableAgents.find((a) => a.id === store.lastAgentId) ?? store.availableAgents[0];
    if (!agentDef) throw new Error('No agent configured');

    const isGit = project.isGitRepo !== false;
    let baseBranch = '';
    let symlinkDirs: string[] = [];
    if (isGit) {
      baseBranch =
        project.defaultBaseBranch ??
        (await invoke<string>(IPC.GetMainBranch, { projectRoot: project.path }));
      const ignoredEntries = await invoke<GitIgnoredEntry[]>(IPC.GetGitignoredDirs, {
        projectRoot: project.path,
      });
      symlinkDirs = ignoredEntries.filter((entry) => entry.isDefault).map((entry) => entry.name);
    }

    const taskId = await createTask({
      name,
      agentDef,
      projectId: req.projectId,
      gitIsolation: isGit ? 'worktree' : 'none',
      baseBranch,
      symlinkDirs,
      // No initialPrompt -- this task starts idle. The first ticket is
      // delivered via a separate PromptAgent request once this one replies.
    });
    const agentId = store.tasks[taskId]?.agentIds[0];
    if (!agentId) throw new Error('Created task has no agent');

    reply(req.reqId, true, { taskId, agentId }, undefined, IPC.JiraWatcher_RendererReply);
  } catch (err) {
    reply(
      req.reqId,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      IPC.JiraWatcher_RendererReply,
    );
  }
}

function handleEnsureImplementerTask(req: EnsureTaskRequest): Promise<void> {
  return ensurePersistentTask(req, 'Jira Implementer');
}

function handleEnsureDeployerTask(req: EnsureTaskRequest): Promise<void> {
  return ensurePersistentTask(req, 'Jira Deployer');
}

async function handlePromptAgent(req: PromptAgentRequest): Promise<void> {
  try {
    // Reject fast if this task was deleted from the UI since the Jira
    // watcher's main-process cache (jira-watcher.ts's ProjectQueue) last
    // saw it -- that cache has no way to learn a task is gone. Without this
    // check, waitUntilAgentReadyForPrompt below would wait on a dead
    // agentId with no real PTY behind it: readiness can never become true,
    // so the call would hang until the main process's own 120s
    // callRenderer timeout finally gave up, instead of failing in
    // milliseconds so the caller's stale-cache cleanup runs promptly.
    if (!isKnownTask(store.tasks, req.taskId)) {
      throw new Error('Task not found');
    }
    // Wait for the CLI to actually be ready for input before writing anything.
    // Without this, promptAgent can write into a freshly-spawned terminal
    // while Claude Code is still printing its startup banner: the keystrokes
    // land on the banner and are silently dropped, and the ticket never
    // actually starts even though the task window opens. This mirrors the
    // readiness gate PromptInput.tsx's autofire already applies to
    // manually-created tasks.
    await waitUntilAgentReadyForPrompt(
      req.agentId,
      getAgentOutputTail,
      onAgentReady,
      sleep,
      AGENT_READY_WAIT_OPTS,
    );
    await sendPrompt(req.taskId, req.agentId, req.text);
    reply(req.reqId, true, undefined, undefined, IPC.JiraWatcher_RendererReply);
  } catch (err) {
    reply(
      req.reqId,
      false,
      undefined,
      err instanceof Error ? err.message : String(err),
      IPC.JiraWatcher_RendererReply,
    );
  }
}

async function handleWaitForAgentReady(req: WaitForAgentReadyRequest): Promise<void> {
  // Delegate to waitUntilAgentReadyForPrompt rather than a raw onAgentReady
  // callback -- onAgentReady is one-shot and only fires on NEW PTY output.
  // jira-watcher.ts calls this after a ticket finishes to detect "safe to
  // send the next one"; if the agent settles at its idle prompt and
  // produces no FURTHER output after that point, a raw onAgentReady
  // callback never fires again and the Implementer/Deployer would sit idle
  // forever, never picking up its next ticket -- reproduced live after
  // myl3 completed a ticket. waitUntilAgentReadyForPrompt already has a
  // polling fallback for exactly this (added in 420c22e for promptAgent's
  // own readiness wait, the other caller of this same pattern); reuse it
  // instead of keeping a second copy that lacks it.
  await waitUntilAgentReadyForPrompt(
    req.agentId,
    getAgentOutputTail,
    onAgentReady,
    sleep,
    AGENT_READY_WAIT_OPTS,
  );
  reply(req.reqId, true, undefined, undefined, IPC.JiraWatcher_RendererReply);
}

/** Subscribe to mobile task-creation requests and the Jira board watcher's own
 *  create-task / list-task-names round-trips. Returns an unsubscribe fn. */
export function startRemoteTaskHandlers(): () => void {
  const offProjects = window.electron.ipcRenderer.on(
    IPC.Remote_GetProjectsRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleGetProjects(data as RendererRequest);
    },
  );
  const offCreate = window.electron.ipcRenderer.on(
    IPC.Remote_CreateTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleCreateTask(data as CreateTaskRequest);
    },
  );
  const offGetNotes = window.electron.ipcRenderer.on(
    IPC.Remote_GetNotesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleGetNotes(data as GetNotesRequest);
    },
  );
  const offSetNotes = window.electron.ipcRenderer.on(
    IPC.Remote_SetNotesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleSetNotes(data as SetNotesRequest);
    },
  );
  const offListTaskNames = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_ListTaskNamesRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') handleListTaskNames(data as ListTaskNamesRequest);
    },
  );
  const offJiraCreate = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_CreateTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handleJiraCreateTask(data as CreateTaskRequest);
    },
  );
  const offEnsureImplementer = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_EnsureImplementerTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleEnsureImplementerTask(data as EnsureTaskRequest);
    },
  );
  const offEnsureDeployer = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_EnsureDeployerTaskRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleEnsureDeployerTask(data as EnsureTaskRequest);
    },
  );
  const offPromptAgent = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_PromptAgentRequest,
    (data: unknown) => {
      if (data && typeof data === 'object') void handlePromptAgent(data as PromptAgentRequest);
    },
  );
  const offWaitForAgentReady = window.electron.ipcRenderer.on(
    IPC.JiraWatcher_WaitForAgentReadyRequest,
    (data: unknown) => {
      if (data && typeof data === 'object')
        void handleWaitForAgentReady(data as WaitForAgentReadyRequest);
    },
  );
  return () => {
    offProjects();
    offCreate();
    offGetNotes();
    offSetNotes();
    offListTaskNames();
    offJiraCreate();
    offEnsureImplementer();
    offEnsureDeployer();
    offPromptAgent();
    offWaitForAgentReady();
  };
}

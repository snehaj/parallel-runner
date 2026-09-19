import { chunkContainsAgentPrompt, stripAnsi } from '../../electron/shared/prompt-detect.js';
import { normalizeForComparison } from './taskStatus';
import { isStartupBlockingAutoSend } from '../components/prompt-autosend-readiness';

export interface AgentSendReadinessOptions {
  /** Consecutive polls (recheckDelayMs apart) that must show unchanged,
   *  prompt-showing output before the agent is considered ready. */
  stabilityChecks: number;
  /** Delay between rechecks once a prompt marker is visible. */
  recheckDelayMs: number;
  /** After this many rechecks where the prompt is visible but content is
   *  still changing (e.g. a spinner), stop requiring stability and resolve
   *  anyway -- the agent is showing its prompt, which is good enough. */
  maxStabilityFailures: number;
  /** How often to re-check readiness even with no new PTY output at all.
   *  Required because onReady/registerOnReady is a one-shot callback that
   *  only fires on NEW data -- if the agent reaches its idle prompt and then
   *  produces no further output before this function starts watching, the
   *  callback never fires again and the wait would hang forever without
   *  this fallback. Mirrors PromptInput.tsx's own "SLOW PATH: quiescence
   *  fallback" polling timer, which exists for the identical reason. */
  pollIntervalMs: number;
}

/**
 * Waits for a freshly spawned agent to actually be ready to receive a prompt,
 * mirroring the readiness gate PromptInput.tsx's autofire path already uses
 * for manually-created tasks (onReady fast path + stability rechecks).
 *
 * Callers that write into a PTY without this wait (e.g. the Jira watcher's
 * promptAgent bridge before this fix) can race the CLI's own startup banner:
 * the prompt text + Enter land while Claude Code is still booting and are
 * silently dropped, while waitForAgentReady's own prompt-detection then
 * fires on that same boot-complete prompt and is mistaken for "done".
 */
export async function waitUntilAgentReadyForPrompt(
  agentId: string,
  getTail: (agentId: string) => string,
  registerOnReady: (agentId: string, cb: () => void) => void,
  sleep: (ms: number) => Promise<void>,
  opts: AgentSendReadinessOptions,
): Promise<void> {
  await waitForPromptMarker(agentId, getTail, registerOnReady, sleep, opts.pollIntervalMs);
  await waitForStableOutput(agentId, getTail, sleep, opts);
}

function waitForPromptMarker(
  agentId: string,
  getTail: (agentId: string) => string,
  registerOnReady: (agentId: string, cb: () => void) => void,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    function settle() {
      if (settled) return;
      settled = true;
      resolve();
    }

    function check() {
      if (settled) return;
      const tail = getTail(agentId);
      const stripped = stripAnsi(tail);
      if (isStartupBlockingAutoSend(tail) || !chunkContainsAgentPrompt(stripped)) {
        registerOnReady(agentId, () => {
          void sleep(0).then(check);
        });
        return;
      }
      settle();
    }

    // Polling fallback: registerOnReady's callback is one-shot and only
    // fires on NEW PTY data. If the agent is already at its idle prompt by
    // the time this function starts watching -- or reaches it without any
    // further output arriving afterward -- no onReady callback ever fires
    // again, and the fast path alone would hang forever. Poll independently
    // so readiness is still detected with zero new output.
    void (async function poll() {
      while (!settled) {
        await sleep(pollIntervalMs);
        if (settled) return;
        const tail = getTail(agentId);
        const stripped = stripAnsi(tail);
        if (!isStartupBlockingAutoSend(tail) && chunkContainsAgentPrompt(stripped)) {
          settle();
          return;
        }
      }
    })();

    check();
  });
}

async function waitForStableOutput(
  agentId: string,
  getTail: (agentId: string) => string,
  sleep: (ms: number) => Promise<void>,
  opts: AgentSendReadinessOptions,
): Promise<void> {
  let checksRemaining = opts.stabilityChecks;
  let stabilityCheckFailures = 0;

  while (checksRemaining > 0) {
    // Snapshot freshly right before each sleep (not once before the loop) --
    // mirrors PromptInput.tsx's scheduleCheck, so a failed check's re-wait
    // compares against the output at the START of its own window, not a
    // stale snapshot from before an earlier failure.
    const snapshot = normalizeForComparison(getTail(agentId));
    await sleep(opts.recheckDelayMs);
    const tail = getTail(agentId);
    const stripped = stripAnsi(tail);
    const normalized = normalizeForComparison(tail);
    const hasPrompt = chunkContainsAgentPrompt(stripped);
    const isStable = normalized === snapshot;

    if (!hasPrompt || (!isStable && stabilityCheckFailures < opts.maxStabilityFailures)) {
      if (hasPrompt && !isStable) stabilityCheckFailures++;
      checksRemaining = opts.stabilityChecks;
      continue;
    }
    checksRemaining--;
  }
}

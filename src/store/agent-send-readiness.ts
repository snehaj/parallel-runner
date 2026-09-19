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
/** DEBUG: log each readiness state transition with the given agentId and a
 *  timestamp. Added while investigating a report that the Jira Deployer's
 *  prompt appeared to only get through after the Jira Implementer window
 *  was closed -- these logs, read alongside jira-watcher.ts's
 *  refillImplementerIfIdle/refillDeployerIfIdle [debug] logs, are meant to
 *  show which of the two phases (waiting for the marker vs. waiting for
 *  stable output) an agent is stuck in, and when/whether it actually
 *  advances. Remove once resolved. */
function debugLog(agentId: string, message: string, extra?: Record<string, unknown>): void {
  console.warn(
    '[agent-send-readiness][debug]',
    new Date().toISOString(),
    agentId,
    message,
    extra ?? {},
  );
}

export async function waitUntilAgentReadyForPrompt(
  agentId: string,
  getTail: (agentId: string) => string,
  registerOnReady: (agentId: string, cb: () => void) => void,
  sleep: (ms: number) => Promise<void>,
  opts: AgentSendReadinessOptions,
): Promise<void> {
  debugLog(agentId, 'start');
  await waitForPromptMarker(agentId, getTail, registerOnReady, sleep, opts.pollIntervalMs);
  debugLog(agentId, 'prompt marker found -- entering stability phase');
  await waitForStableOutput(agentId, getTail, sleep, opts);
  debugLog(agentId, 'ready -- resolving');
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
      const blocked = isStartupBlockingAutoSend(tail);
      const hasPrompt = chunkContainsAgentPrompt(stripped);
      if (blocked || !hasPrompt) {
        debugLog(agentId, 'check (onReady path): not ready, registering onReady', {
          blocked,
          hasPrompt,
          tailLength: tail.length,
        });
        registerOnReady(agentId, () => {
          debugLog(agentId, 'onReady callback fired -- new PTY output arrived');
          void sleep(0).then(check);
        });
        return;
      }
      debugLog(agentId, 'check (onReady path): ready');
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
        const blocked = isStartupBlockingAutoSend(tail);
        const hasPrompt = chunkContainsAgentPrompt(stripped);
        debugLog(agentId, 'poll fallback tick', { blocked, hasPrompt, tailLength: tail.length });
        if (!blocked && hasPrompt) {
          debugLog(agentId, 'poll fallback: ready');
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

    debugLog(agentId, 'stability check', {
      hasPrompt,
      isStable,
      stabilityCheckFailures,
      checksRemaining,
    });

    if (!hasPrompt || (!isStable && stabilityCheckFailures < opts.maxStabilityFailures)) {
      if (hasPrompt && !isStable) stabilityCheckFailures++;
      checksRemaining = opts.stabilityChecks;
      continue;
    }
    checksRemaining--;
  }
}

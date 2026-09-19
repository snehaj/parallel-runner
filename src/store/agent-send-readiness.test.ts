import { describe, expect, it, vi } from 'vitest';
import { waitUntilAgentReadyForPrompt } from './agent-send-readiness';

/** Test double for taskStatus's onAgentReady/offAgentReady: stores the latest
 *  registered callback per agent so a test can fire it manually, mirroring
 *  how markAgentOutput fires the real one-shot callback on new PTY data. */
function makeReadyRegistry() {
  const callbacks = new Map<string, () => void>();
  return {
    registerOnReady: (agentId: string, cb: () => void) => {
      callbacks.set(agentId, cb);
    },
    fire: (agentId: string) => {
      const cb = callbacks.get(agentId);
      callbacks.delete(agentId);
      cb?.();
    },
    pending: (agentId: string) => callbacks.has(agentId),
  };
}

function fakeSleep() {
  // Real setTimeout so `await sleep(ms)` resolves under vi.useFakeTimers()
  // once the test advances fake time past ms.
  return (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('waitUntilAgentReadyForPrompt', () => {
  it('resolves once the prompt is visible and stable across the required rechecks', async () => {
    vi.useFakeTimers();
    const registry = makeReadyRegistry();
    const tail = '❯ ';
    const getTail = () => tail;

    const promise = waitUntilAgentReadyForPrompt(
      'agent-1',
      getTail,
      registry.registerOnReady,
      fakeSleep(),
      {
        stabilityChecks: 2,
        recheckDelayMs: 1_000,
        maxStabilityFailures: 3,
        pollIntervalMs: 200,
      },
    );

    // Fast path: tail already shows a prompt marker, so no onReady wait needed.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('waits for the onReady callback while startup text is still showing', async () => {
    vi.useFakeTimers();
    const registry = makeReadyRegistry();
    let tail = 'Booting MCP server: parallel-code\n❯ ';
    const getTail = () => tail;

    const promise = waitUntilAgentReadyForPrompt(
      'agent-1',
      getTail,
      registry.registerOnReady,
      fakeSleep(),
      {
        stabilityChecks: 1,
        recheckDelayMs: 500,
        maxStabilityFailures: 3,
        pollIntervalMs: 10_000, // long enough that only the onReady fast path fires in this test
      },
    );

    // Give the async function a tick to reach its first registerOnReady call.
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.pending('agent-1')).toBe(true);

    // Boot finishes; simulate the PTY emitting fresh output.
    tail = '❯ ';
    registry.fire('agent-1');

    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('resolves via polling even when the agent never fires onReady again (regression)', async () => {
    // Regression test for the live incident: a "Jira Implementer" CLI
    // finished booting to its idle prompt, but by the time
    // waitUntilAgentReadyForPrompt started watching it, the CLI had already
    // stopped producing any further PTY output -- there was nothing left to
    // emit. The fast path (onReady, which only fires on NEW PTY data) then
    // never fires again, and the wait hung forever: promptAgent's /myl3
    // prompt was never sent, the process sat idle at 0% CPU indefinitely.
    // PromptInput.tsx's real autofire has exactly this fallback (its
    // "SLOW PATH: quiescence fallback" comment) for the same reason.
    vi.useFakeTimers();
    const registry = makeReadyRegistry();
    // Tail already shows the startup banner blocker on the FIRST read, then
    // (as if the CLI finished booting between reads, with no PTY event to
    // notify us) shows the ready prompt on every subsequent read. onReady is
    // registered but deliberately never fired -- there is no more output.
    let callCount = 0;
    const getTail = () => {
      callCount++;
      return callCount === 1 ? 'Booting MCP server: parallel-code\n❯ ' : '❯ ';
    };

    const promise = waitUntilAgentReadyForPrompt(
      'agent-1',
      getTail,
      registry.registerOnReady,
      fakeSleep(),
      {
        stabilityChecks: 1,
        recheckDelayMs: 500,
        maxStabilityFailures: 3,
        pollIntervalMs: 500,
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(registry.pending('agent-1')).toBe(true); // onReady registered...

    // ...but never fired. Only a polling fallback can rescue this.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('does not resolve until output stops changing across stabilityChecks consecutive polls', async () => {
    // Real timers with tiny delays -- fake-timer/microtask boundary timing
    // around consecutive awaited sleeps is too fragile to align by hand;
    // this still exercises the real instability-resets-the-count behavior.
    const registry = makeReadyRegistry();
    // Every response has a bare ❯ on its own line (matches the real
    // ready-marker regex), but the surrounding status text keeps changing
    // for the first few polls before settling -- normalizeForComparison
    // includes that whole tail, so the changing prefix keeps isStable false.
    const responses = [
      'loading a\n❯',
      'loading b\n❯',
      'loading c\n❯',
      'loading d\n❯',
      'idle\n❯',
      'idle\n❯',
      'idle\n❯',
      'idle\n❯',
    ];
    let callCount = 0;
    const getTail = () => responses[Math.min(callCount++, responses.length - 1)];

    let resolved = false;
    const promise = waitUntilAgentReadyForPrompt(
      'agent-1',
      getTail,
      registry.registerOnReady,
      (ms) => new Promise((r) => setTimeout(r, ms)),
      { stabilityChecks: 2, recheckDelayMs: 5, maxStabilityFailures: 10, pollIntervalMs: 10_000 },
    ).then(() => {
      resolved = true;
    });

    // While content is still changing, it must not resolve.
    await new Promise((r) => setTimeout(r, 15));
    expect(resolved).toBe(false);
    expect(callCount).toBeLessThan(responses.length);

    await promise;
    expect(resolved).toBe(true);
  });

  it('gives up requiring stability after maxStabilityFailures and resolves anyway', async () => {
    const registry = makeReadyRegistry();
    let n = 0;
    // Tail keeps changing every call (e.g. a spinner) -- never truly "stable",
    // but a bare ❯ prompt marker is always visible on its own line.
    const getTail = () => `working ${n++}\n❯`;

    await waitUntilAgentReadyForPrompt(
      'agent-1',
      getTail,
      registry.registerOnReady,
      (ms) => new Promise((r) => setTimeout(r, ms)),
      { stabilityChecks: 2, recheckDelayMs: 5, maxStabilityFailures: 2, pollIntervalMs: 10_000 },
    );

    // Resolving at all (rather than hanging forever on perpetually-unstable
    // output) proves the maxStabilityFailures escape hatch fired.
    expect(true).toBe(true);
  });
});

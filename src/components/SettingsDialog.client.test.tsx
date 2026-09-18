import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';

const disposers: Array<() => void> = [];

beforeEach(() => {
  // happy-dom supplies a real `window`, but not the preload-injected
  // `electron` bridge that setJiraEmail/setJiraToken (via lib/ipc's invoke)
  // and fetchAvailableTerminalFonts read.
  vi.stubGlobal('window', {
    ...globalThis.window,
    electron: {
      ipcRenderer: {
        invoke: vi.fn().mockResolvedValue(undefined),
        on: vi.fn().mockReturnValue(vi.fn()),
        removeAllListeners: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('SettingsDialog Jira fields', () => {
  it('keeps the typed email across a close and reopen of the dialog', () => {
    // Dialog renders via <Portal>, so its content lands in document.body,
    // not in the container passed to render().
    const host = document.createElement('div');
    document.body.append(host);
    const onClose = () => undefined;
    disposers.push(render(() => <SettingsDialog open={true} onClose={onClose} />, host));

    const emailInput = () =>
      Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find(
        (input) => input.placeholder === 'you@company.com',
      );

    const input = emailInput();
    if (!input) throw new Error('Jira email input did not render');
    input.value = 'sneha.jose@eqs.com';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(emailInput()?.value).toBe('sneha.jose@eqs.com');

    // Simulate closing (unmounts via <Show when={props.open}>) and reopening.
    disposers.pop()?.();
    document.body.replaceChildren();
    document.body.append(host);
    disposers.push(render(() => <SettingsDialog open={true} onClose={onClose} />, host));

    expect(emailInput()?.value).toBe('sneha.jose@eqs.com');
  });

  it('shows a non-secret "token set" indicator that survives a close and reopen', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const onClose = () => undefined;
    disposers.push(render(() => <SettingsDialog open={true} onClose={onClose} />, host));

    const tokenInput = () =>
      Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find(
        (input) => input.placeholder === 'Enter your Jira API token (stored in memory only)',
      );
    const indicator = () =>
      Array.from(document.body.querySelectorAll('span')).find((span) =>
        span.textContent?.includes('API token set'),
      );

    expect(indicator()).toBeUndefined();

    const input = tokenInput();
    if (!input) throw new Error('Jira API token input did not render');
    input.value = 'ATATT-secret-value';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(indicator()).not.toBeUndefined();
    // Never echo the secret itself into the DOM.
    expect(document.body.textContent).not.toContain('ATATT-secret-value');

    // Simulate closing (unmounts via <Show when={props.open}>) and reopening.
    disposers.pop()?.();
    document.body.replaceChildren();
    document.body.append(host);
    disposers.push(render(() => <SettingsDialog open={true} onClose={onClose} />, host));

    expect(indicator()).not.toBeUndefined();
    expect(tokenInput()?.value).toBe('');
  });
});

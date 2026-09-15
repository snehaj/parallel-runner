# Jira Watcher REST Rewrite — Design

## Problem

The Jira board watcher (`electron/ipc/jira-watcher.ts`, shipped in
`docs/superpowers/specs/2026-09-11-jira-board-watcher-design.md`) has never
successfully found or labeled a ticket. Its `runClaudeJson()` helper spawns
`claude -p <prompt> --output-format json --permission-mode dontAsk` and asks
Claude to use an MCP tool, then parses the `result` field as JSON. Every
attempt fails, confirmed live on 2026-09-12/13 via `claude mcp list` and
direct reproduction of the exact `claude -p` call:

1. The `atlassian` MCP plugin requires interactive browser OAuth
   (`claude mcp list` shows `! Needs authentication`) — impossible from a
   headless `claude -p` invocation; there is no `/mcp` panel in `-p` mode.
2. The fallback `jira-mcp` plugin is token-authenticated and does connect,
   but its tool call is denied under `--permission-mode dontAsk`
   (`permission_denials` in the `-p --output-format json` response names
   `mcp__plugin_jira-mcp_jira__search_issues`).
3. Denied, Claude replies in prose ("I wasn't able to run the JQL
   search...") instead of JSON, and `JSON.parse(outer.result)` throws —
   logged as `[jira-watcher] transient failure: Unexpected token 'I' ...`.

The desktop-app plumbing around this call is sound and already verified
working: config persists (`jiraWatchEnabled`, `jiraProjectKey`), the
renderer→main `StartJiraWatcher` IPC fires correctly, and a poll is attempted
immediately on enable and every `TICK_MS` (3 min) after. Only the Jira call
itself is broken.

## Precedent: how EQS's own Foundry does this

`gitlab.eqs.tools/ai/foundry` (`scripts/foundry-implement.sh`) runs an
equivalent unattended "poll Jira for a trigger label, act on it" loop in
GitLab CI, and does **not** use an MCP plugin or an LLM turn for it. It
talks to the Jira REST API directly with `curl`+`jq`:

- `POST /rest/api/3/search/jql` — JQL search, body
  `{"jql": "...", "maxResults": N, "fields": [...]}`
- `GET`/`POST /rest/api/3/issue/<KEY>/transitions` — read/apply transitions
- `PUT /rest/api/3/issue/<KEY>` — field updates (assignee, labels)
- Auth: a scoped service token (`ATSTT*`/`ATOA*` prefix) uses
  `Authorization: Bearer` against
  `https://api.atlassian.com/ex/jira/<cloudId>/...`; a personal API token
  uses HTTP Basic (`email:token`) against
  `https://eqsgroupcloud.atlassian.net` directly. `jira-mcp` IS installed in
  Foundry's CI image, but only so the _implementation_ agent can use it
  mid-task — the deterministic polling/labelling is plain HTTP, never an LLM
  turn.

This design ports that pattern into the desktop watcher: replace the one
LLM-mediated call with two deterministic REST calls.

**Correction (2026-09-15), verified against the real server:** the original
version of this section assumed a personal Atlassian API token (`ATATT...`
prefix) and Basic auth only. That assumption was wrong.
`eqsgroupcloud.atlassian.net` rejects HTTP Basic auth outright — confirmed via
`curl -v` with two independently-generated `ATATT...` tokens and the correct
account email, both returning 401 with
`www-authenticate: OAuth realm="https%3A%2F%2Feqsgroupcloud.atlassian.net"`.
This is a site-level policy, not a credential mistake. The implementation
therefore includes BOTH of Foundry's branches after all: Basic auth (kept for
any Jira site that does accept it) and Bearer auth against
`https://api.atlassian.com/ex/jira/ac99ec2c-4be5-4e97-a8f6-cf12bf3e46ce/...`
for a token prefixed `ATSTT`/`ATOA` — which is the one that actually works
against this site. An `ATSTT`/`ATOA` token is not obtainable from the
self-service "Create API token" page; it must come from whoever provisions
Jira service-account credentials at EQS (see project memory
`foundry_headless_jira_pattern` for the full finding).

## Scope

**In scope:**

- Replace `runClaudeJson()`/`queryLabeledTickets()`/`swapTicketLabel()`'s
  implementation with direct `fetch` calls to the Jira REST API, in a new
  `electron/ipc/jira-client.ts` module. Same exported signatures and return
  types as today — nothing above the client (the polling loop, the task
  bridge) changes shape.
- A place to enter the Jira email + API token: a new "Jira" section in
  `SettingsDialog.tsx`, mirroring the existing MiniMax API key field exactly
  (memory-only, never persisted, "stored in memory only" note, `password`
  input for the token).
- A new `disabledReason: 'no-credentials'` so the watcher can tell "never
  configured" apart from "configured but Jira rejected it" apart from "a
  transient/network hiccup," surfaced through the existing
  `jiraWatcherStatusLabel()` in the UI.
- Test coverage ported from the current `child_process`-mocking tests to
  `fetch`-mocking, same test _cases_ (ticket found, none found, request
  failure) plus new cases for the credential and auth-failure paths.

**Out of scope (explicitly considered and rejected):**

- **Coordinator mode.** It orchestrates _other_ Claude Code tasks via MCP
  tools once a task exists — it has no bearing on _finding_ a ticket, and
  routing the Jira call through it would still be an LLM proxying an MCP
  call, i.e. the same failure mode this design removes. The watcher's
  existing `jiraBridge.createTask()` call (spawns a normal task per found
  ticket) is unchanged.
- **A manual "check now" trigger.** The existing automatic loop
  (`ensureJiraInterval`, `TICK_MS = 3 min`, plus an immediate poll on
  enable/show/restore) already covers this; nothing here asked for a
  faster or user-initiated poll.
- **Keychain-backed persistence.** Considered and rejected in favor of
  matching the already-shipped MiniMax-key pattern (memory-only); revisit
  only if re-entering the token every launch becomes a real annoyance.
- **Per-project credentials.** One Jira account/token for the whole app,
  entered once in Settings — not per-project in Edit Project.
- Any change to `EditProjectDialog`'s existing three Jira fields (project
  key, trigger label, completed label) — unaffected by this rewrite.

## Architecture

```
SettingsDialog.tsx (renderer)
  Jira email / token inputs
        │ IPC: SetJiraCredentials
        ▼
register.ts → jira-client.ts
  setJiraCredentials(email, token)   — module-level vars, memory-only
        │
        ▼
jira-client.ts                        [NEW]
  queryLabeledTickets(projectKey, label) -> {key, summary}[]
  swapTicketLabel(key, removeLabel, addLabel) -> void
  (both: fetch + Basic auth against eqsgroupcloud.atlassian.net;
   throw a typed error carrying an HTTP status when Jira responds)
        │ imported by
        ▼
jira-watcher.ts                       [MODIFIED — polling loop unchanged]
  pollOneProject() calls queryLabeledTickets/swapTicketLabel from
  jira-client.ts instead of defining them itself
  handleClaudeError() -> handleJiraError(): classify by HTTP status /
  no-credentials, not by ENOENT/stderr-regex
        │ pushes JiraWatcherStatus (existing channel, new reason value)
        ▼
jira-watcher.ts (renderer half, src/store/jira-watcher.ts)
  jiraWatcherStatusLabel() gains a 'no-credentials' case — unchanged otherwise
```

### `jira-client.ts` — the new module

```ts
// electron/ipc/jira-client.ts
const JIRA_BASE_URL = 'https://eqsgroupcloud.atlassian.net';

let jiraEmail = '';
let jiraToken = '';

/** Main-process storage for Jira credentials. Never sent back to the
 *  renderer, never persisted — same pattern as ask-code-minimax.ts's
 *  storedApiKey. */
export function setJiraCredentials(email: string, token: string): void {
  jiraEmail = email.trim();
  jiraToken = token.trim();
}

export function hasJiraCredentials(): boolean {
  return jiraEmail.length > 0 && jiraToken.length > 0;
}

/** Thrown for any non-2xx Jira response; callers switch on `.status` to
 *  classify auth failures (401/403) vs. everything else. */
export class JiraApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
}

async function jiraFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!hasJiraCredentials()) {
    throw new JiraApiError(0, 'Jira credentials are not set');
  }
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new JiraApiError(res.status, `Jira API ${res.status}: ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function queryLabeledTickets(
  projectKey: string,
  label: string,
): Promise<{ key: string; summary: string }[]> {
  const jql = `project = ${projectKey} AND labels = "${label}"`;
  const body = await jiraFetch('/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, maxResults: 50, fields: ['summary'] }),
  });
  const issues = (body as { issues?: unknown[] })?.issues ?? [];
  return issues.map((issue) => {
    const i = issue as { key: string; fields: { summary: string } };
    return { key: i.key, summary: i.fields.summary };
  });
}

export async function swapTicketLabel(
  ticketKey: string,
  removeLabel: string,
  addLabel: string,
): Promise<void> {
  // PUT replaces the whole labels array — Jira has no add/remove-one op —
  // so the current list has to be read first.
  const current = (await jiraFetch(`/rest/api/3/issue/${ticketKey}?fields=labels`)) as {
    fields: { labels: string[] };
  };
  const next = current.fields.labels
    .filter((l) => l !== removeLabel)
    .concat(addLabel)
    .filter((l, i, arr) => arr.indexOf(l) === i); // de-dup if addLabel was already present

  await jiraFetch(`/rest/api/3/issue/${ticketKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { labels: next } }),
  });
}
```

`queryLabeledTickets`/`swapTicketLabel` keep their exact existing
signatures — `jira-watcher.ts`'s `pollOneProject()` changes only its
`import` line, not its call sites.

### `jira-watcher.ts` changes

- Delete `runClaudeJson`, the `exec`/`execFile`/`promisify` imports, and the
  `ClaudeResultPayload` interface — nothing in this file spawns a process
  anymore.
- `import { queryLabeledTickets, swapTicketLabel, JiraApiError } from './jira-client.js';`
- `pollOneProject()`'s existing try/catch around `queryLabeledTickets` is
  unchanged in shape — it already calls its error handler (renamed
  `handleClaudeError` → `handleJiraError`) on any thrown error. No new
  credentials pre-check is needed there: `jiraFetch` (part of `jira-client.ts`,
  above) checks `hasJiraCredentials()` synchronously before it does anything
  network-related and throws `JiraApiError(0, ...)` immediately, so the "no
  credentials" case reaches `handleJiraError` the same way any other Jira
  error does, with no wasted fetch.
- Replace `handleClaudeError` with `handleJiraError`:
  ```ts
  function handleJiraError(err: unknown): void {
    if (jiraDisabled) return;
    if (err instanceof JiraApiError) {
      if (err.status === 0) {
        jiraDisabled = true;
        jiraDisabledReason = 'no-credentials';
        clearJiraTickInterval();
        sendJiraStatus();
        return;
      }
      if (err.status === 401 || err.status === 403) {
        jiraDisabled = true;
        jiraDisabledReason = 'auth';
        clearJiraTickInterval();
        sendJiraStatus();
        return;
      }
    }
    console.warn('[jira-watcher] transient failure:', (err as Error)?.message ?? err);
  }
  ```
  The `ENOENT`/`claude`-CLI-missing branch is deleted along with it — there
  is no subprocess left that can be missing.
- `JiraWatcherDisabledReason` (currently `'missing' | 'auth'`, defined in
  `src/store/jira-watcher.ts`) becomes `'no-credentials' | 'auth'`; `'missing'`
  is removed (no longer reachable — nothing checks for a missing binary).
  Mirror the same change in `electron/ipc/shared-types.ts`'s
  `JiraWatcherStatusPayload.disabledReason` and drop that type's doc-comment
  claim of mirroring `pr-checks.ts`'s taxonomy — `pr-checks.ts`'s own
  `BranchPrDetectionResult.unavailable` and `disabledReason` fields are a
  separate, unrelated type that keeps `'missing' | 'auth'` unchanged; only
  jira-watcher's reason set changes here.

### `SettingsDialog.tsx` changes

New section, placed after "Ask about Code" (same visual pattern: a
`sectionLabelStyle` heading, one `bgInput`-bordered box, one `<label>` row
per field, a small `fgSubtle` note below):

```tsx
<div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
  <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Jira</div>
  <div
    style={{
      display: 'flex',
      'flex-direction': 'column',
      gap: '6px',
      padding: '8px 12px',
      'border-radius': '8px',
      background: theme.bgInput,
      border: `1px solid ${theme.border}`,
    }}
  >
    <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
      <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>Email</span>
      <input
        type="text"
        value={jiraEmail()}
        onInput={(e) => setJiraEmail(e.currentTarget.value)}
        placeholder="you@company.com"
        style={{ flex: '1' /* same input style as editorCommand */ }}
      />
    </label>
    <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
      <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
        API token
      </span>
      <input
        type="password"
        onInput={(e) => setJiraToken(e.currentTarget.value)}
        placeholder="Enter your Jira API token (stored in memory only)"
        style={{ flex: '1' /* same input style */ }}
      />
    </label>
  </div>
  <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>
    Used by the Jira board watcher (per-project setting in Edit Project) to poll for labeled
    tickets. Create a token at id.atlassian.com/manage-profile/security/api-tokens.
  </span>
</div>
```

Both fields call `invoke(IPC.SetJiraCredentials, { email, token })` — email
kept as local UI state so it round-trips visibly on typing (unlike the
password field, which is intentionally write-only, matching MiniMax's own
key field), but neither is read back from or written to `store`/`state.json`.
A small local signal or a single combined `setJiraCredentials(email, token)`
call on each keystroke is an implementation-plan-level detail, not a design
one — either satisfies "memory-only, mirrors MiniMax."

### New IPC channel

`channel-manifest.json`: `"SetJiraCredentials": "set_jira_credentials"`,
alongside the existing `SetMinimaxApiKey` entry.

`register.ts`:

```ts
ipcMain.handle(IPC.SetJiraCredentials, (_e, args) => {
  assertString(args.email, 'email');
  assertString(args.token, 'token');
  setJiraCredentials(args.email, args.token);
});
```

No `preload.cjs` allowlist change needed beyond adding the new channel
string, same as every existing one-shot `invoke` channel.

## Error handling

| Condition                                          | `disabledReason`         | Retried automatically?                                                                                                                           |
| -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credentials never entered                          | `'no-credentials'`       | No — watcher disables itself until re-enabled (matches today's `'missing'`/`'auth'` behavior: a disabled watcher stays disabled for the session) |
| Jira returns 401/403                               | `'auth'`                 | No — same disable-until-restart behavior as today                                                                                                |
| Jira returns any other error, or a network failure | _(none — stays enabled)_ | Yes — next tick, logged as `[jira-watcher] transient failure: ...`, matching today's handling of anything that isn't ENOENT/auth                 |

This is a strict improvement on today's classification (an `ENOENT`
string-match and a stderr regex) without changing the _shape_ of the
disabled-state contract the renderer already consumes.

## Testing

`electron/ipc/jira-watcher.test.ts`'s `vi.mock('child_process', ...)` block
is deleted. A new `electron/ipc/jira-client.test.ts` gets `vi.stubGlobal('fetch', vi.fn())`
and covers: a successful search mapping issues to `{key, summary}`, an empty
result, a 401/403 raising `JiraApiError` with the right `.status`, a network
failure (fetch rejecting) propagating as a plain `Error`, and `swapTicketLabel`'s
read-then-write sequence (asserting the PUT body's `labels` array is correct
after removing one label and adding another, including the case where
`addLabel` was already present).

`jira-watcher.test.ts` keeps its existing `queryLabeledTickets`/
`swapTicketLabel` describe blocks but mocks `./jira-client.js` instead of
`child_process`, and gains a case for the `'no-credentials'` path (poll
attempted with `hasJiraCredentials()` stubbed false — asserts no fetch call
happens at all, `disabledReason` becomes `'no-credentials'`).

## Manual verification

Same DEV_IRREG ticket already in place (`DEV_IRREG-2139`, labeled
`REG_AUTOMATED`) is the live end-to-end check: enter real credentials in
Settings, enable watching on `equitystory-ers` with project key `DEV_IRREG`,
confirm a task named after the ticket appears in the sidebar and the ticket's
label flips to `REG_AUTOMATED_SUCC` in Jira — the same manual check the
2026-09-11 design's own spec called for and that has never yet succeeded.

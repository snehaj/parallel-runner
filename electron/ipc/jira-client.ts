// Direct Jira REST API client for the Jira board watcher. Replaces an
// earlier design that asked a headless `claude -p` call to proxy Jira
// access through an MCP tool -- that never worked: the atlassian MCP
// plugin needs interactive OAuth (unusable headlessly), and the jira-mcp
// fallback's tool call is denied under --permission-mode dontAsk, so
// Claude replied in prose and JSON.parse threw on it every time. This
// follows gitlab.eqs.tools/ai/foundry's own working pattern instead:
// plain HTTP with token auth, no LLM in the loop.
// See docs/superpowers/specs/2026-09-14-jira-watcher-rest-rewrite-design.md.

const JIRA_BASE_URL = 'https://eqsgroupcloud.atlassian.net';

/** Main-process storage for Jira credentials. Never sent back to the
 *  renderer, never persisted -- same pattern as ask-code-minimax.ts's
 *  storedApiKey. */
let jiraEmail = '';
let jiraToken = '';

export function setJiraCredentials(email: string, token: string): void {
  jiraEmail = email.trim();
  jiraToken = token.trim();
}

export function hasJiraCredentials(): boolean {
  return jiraEmail.length > 0 && jiraToken.length > 0;
}

/** Thrown for any non-2xx Jira response, and (status 0) when no
 *  credentials are configured. Callers switch on `.status` to classify
 *  auth failures (401/403) vs. everything else. */
export class JiraApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'JiraApiError';
    this.status = status;
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

/** Queries the Jira REST API for tickets in `projectKey` carrying `label`.
 *  Returns ticket key + summary only. */
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

/** Removes `removeLabel` and adds `addLabel` on the given ticket. Jira's
 *  PUT replaces the whole labels array -- there is no add/remove-one op --
 *  so the current list is read first. */
export async function swapTicketLabel(
  ticketKey: string,
  removeLabel: string,
  addLabel: string,
): Promise<void> {
  const current = (await jiraFetch(`/rest/api/3/issue/${ticketKey}?fields=labels`)) as {
    fields: { labels: string[] };
  };
  const next = current.fields.labels
    .filter((l) => l !== removeLabel)
    .concat(addLabel)
    .filter((l, i, arr) => arr.indexOf(l) === i);

  await jiraFetch(`/rest/api/3/issue/${ticketKey}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: { labels: next } }),
  });
}

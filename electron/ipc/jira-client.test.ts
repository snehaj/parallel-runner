import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setJiraCredentials,
  hasJiraCredentials,
  queryLabeledTickets,
  swapTicketLabel,
} from './jira-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('hasJiraCredentials', () => {
  it('is false before any credentials are set', () => {
    setJiraCredentials('', '');
    expect(hasJiraCredentials()).toBe(false);
  });

  it('is true once both email and token are set', () => {
    setJiraCredentials('me@example.com', 'tok123');
    expect(hasJiraCredentials()).toBe(true);
  });

  it('trims whitespace, so an accidental trailing newline does not count as set', () => {
    setJiraCredentials('  ', '  ');
    expect(hasJiraCredentials()).toBe(false);
  });
});

describe('queryLabeledTickets', () => {
  beforeEach(() => {
    setJiraCredentials('me@example.com', 'tok123');
  });

  it('maps issues to {key, summary}, sending Basic auth and the right JQL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        issues: [
          { key: 'DEV_IRREG-1234', fields: { summary: 'Fix the thing' } },
          { key: 'DEV_IRREG-5678', fields: { summary: 'Fix the other thing' } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tickets = await queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED');

    expect(tickets).toEqual([
      { key: 'DEV_IRREG-1234', summary: 'Fix the thing' },
      { key: 'DEV_IRREG-5678', summary: 'Fix the other thing' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eqsgroupcloud.atlassian.net/rest/api/3/search/jql');
    expect(init.method).toBe('POST');
    const expectedAuth = 'Basic ' + Buffer.from('me@example.com:tok123').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    const body = JSON.parse(init.body as string) as { jql: string };
    expect(body.jql).toBe('project = DEV_IRREG AND labels = "REG_AUTOMATED"');
  });

  it('returns an empty array when Jira reports no matching tickets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ issues: [] })));
    const tickets = await queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED');
    expect(tickets).toEqual([]);
  });

  it('throws JiraApiError with status 401 on an auth failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })),
    );
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('throws JiraApiError with status 0 when credentials are not set', async () => {
    setJiraCredentials('', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toMatchObject({
      status: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a network failure as a plain error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    await expect(queryLabeledTickets('DEV_IRREG', 'REG_AUTOMATED')).rejects.toThrow('ECONNRESET');
  });
});

describe('swapTicketLabel', () => {
  beforeEach(() => {
    setJiraCredentials('me@example.com', 'tok123');
  });

  it('reads the current labels, then PUTs with removeLabel replaced by addLabel', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ fields: { labels: ['REG_AUTOMATED', 'other-label'] } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await swapTicketLabel('DEV_IRREG-1234', 'REG_AUTOMATED', 'REG_AUTOMATED_SUCC');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(
      'https://eqsgroupcloud.atlassian.net/rest/api/3/issue/DEV_IRREG-1234?fields=labels',
    );
    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('https://eqsgroupcloud.atlassian.net/rest/api/3/issue/DEV_IRREG-1234');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body as string) as { fields: { labels: string[] } };
    expect(body.fields.labels.sort()).toEqual(['REG_AUTOMATED_SUCC', 'other-label']);
  });

  it('de-duplicates when addLabel is already present on the ticket', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ fields: { labels: ['REG_AUTOMATED', 'REG_AUTOMATED_SUCC'] } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await swapTicketLabel('DEV_IRREG-1234', 'REG_AUTOMATED', 'REG_AUTOMATED_SUCC');

    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(putInit.body as string) as { fields: { labels: string[] } };
    expect(body.fields.labels).toEqual(['REG_AUTOMATED_SUCC']);
  });
});

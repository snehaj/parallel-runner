import { describe, it, expect } from 'vitest';
import { hasTicketKey, buildTaskName } from './jira-watcher.js';

describe('hasTicketKey', () => {
  it('finds an exact ticket key inside a task name', () => {
    expect(hasTicketKey(['DEV_IRREG-1234: Fix the thing'], 'DEV_IRREG-1234')).toBe(true);
  });
  it('is false when no task name contains the key', () => {
    expect(hasTicketKey(['DEV_IRREG-9999: Other thing'], 'DEV_IRREG-1234')).toBe(false);
  });
  it('is false for an empty list', () => {
    expect(hasTicketKey([], 'DEV_IRREG-1234')).toBe(false);
  });
  it('does not false-positive on a key that is a prefix of a different key', () => {
    // DEV_IRREG-123 must not match a task named for DEV_IRREG-1234
    expect(hasTicketKey(['DEV_IRREG-1234: Fix the thing'], 'DEV_IRREG-123')).toBe(false);
  });
});

describe('buildTaskName', () => {
  it('combines ticket key and summary with a colon separator', () => {
    expect(buildTaskName('DEV_IRREG-1234', 'Fix the thing')).toBe('DEV_IRREG-1234: Fix the thing');
  });
  it('truncates an overly long summary so the task name stays under 200 chars', () => {
    const longSummary = 'x'.repeat(250);
    const name = buildTaskName('DEV_IRREG-1234', longSummary);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.startsWith('DEV_IRREG-1234: ')).toBe(true);
  });
});

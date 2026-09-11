import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/dialog', () => ({
  confirm: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

vi.mock('./tasks', () => ({
  closeTask: vi.fn(),
}));

import { setStore, store } from './core';
import { addProject, getProject, updateProject } from './projects';

describe('updateProject', () => {
  afterEach(() => {
    setStore('projects', []);
  });

  it('clears the configured coverage report path when undefined is provided', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'Project',
        path: '/repo',
        color: 'hsl(0, 70%, 75%)',
        coverageReportPath: 'coverage/lcov.info',
      },
    ]);

    updateProject('p1', { coverageReportPath: undefined });

    expect(store.projects[0]?.coverageReportPath).toBeUndefined();
  });

  it('clears the default base branch when undefined is provided', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'Project',
        path: '/repo',
        color: 'hsl(0, 70%, 75%)',
        defaultBaseBranch: 'main',
      },
    ]);

    updateProject('p1', { defaultBaseBranch: undefined });

    expect(store.projects[0]?.defaultBaseBranch).toBeUndefined();
  });
});

describe('updateProject — Jira watch fields', () => {
  beforeEach(() => {
    setStore('projects', []);
  });

  it('persists jiraWatchEnabled, jiraTriggerLabel, and jiraCompletedLabel', () => {
    const id = addProject('Test Project', '/tmp/test-project');
    updateProject(id, {
      jiraWatchEnabled: true,
      jiraTriggerLabel: 'REG_AUTOMATED',
      jiraCompletedLabel: 'REG_AUTOMATED_SUCC',
    });
    const project = getProject(id);
    expect(project?.jiraWatchEnabled).toBe(true);
    expect(project?.jiraTriggerLabel).toBe('REG_AUTOMATED');
    expect(project?.jiraCompletedLabel).toBe('REG_AUTOMATED_SUCC');
  });

  it('can clear jiraWatchEnabled back to false', () => {
    const id = addProject('Test Project', '/tmp/test-project');
    updateProject(id, { jiraWatchEnabled: true });
    updateProject(id, { jiraWatchEnabled: false });
    expect(getProject(id)?.jiraWatchEnabled).toBe(false);
  });
});

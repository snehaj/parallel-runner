import { describe, it, expect } from 'vitest';
import { IMPLEMENTER_LOOP_PROMPT, DEPLOYER_LOOP_PROMPT, hasTaskNamed } from './jira-loop-prompts';

describe('IMPLEMENTER_LOOP_PROMPT', () => {
  it('embeds the project key in the JQL and the reviewers in the /myl3 call', () => {
    const prompt = IMPLEMENTER_LOOP_PROMPT('DEV_IRREG', '@nkhan');
    expect(prompt).toContain('/loop 3m');
    expect(prompt).toContain(
      'project = DEV_IRREG AND labels = "REG_AUTOMATED" AND assignee = currentUser()',
    );
    expect(prompt).toContain('AND status = Backlog ORDER BY updated ASC');
    expect(prompt).toContain('Run /myl3 <ticket-key> @nkhan.');
    expect(prompt).toContain("do not swap the ticket's label yourself");
  });

  it('works with an empty reviewers string', () => {
    const prompt = IMPLEMENTER_LOOP_PROMPT('DEV_IRREG', '');
    expect(prompt).toContain('Run /myl3 <ticket-key> .');
  });
});

describe('DEPLOYER_LOOP_PROMPT', () => {
  it('embeds the project key in the JQL and defers to /pipeline-deploy', () => {
    const prompt = DEPLOYER_LOOP_PROMPT('DEV_IRREG');
    expect(prompt).toContain('/loop 3m');
    expect(prompt).toContain(
      'project = DEV_IRREG AND assignee = currentUser() AND status = Verified',
    );
    expect(prompt).not.toContain('REG_AUTOMATED');
    expect(prompt).toContain('run /pipeline-deploy');
  });
});

describe('hasTaskNamed', () => {
  const tasks = {
    t1: { projectId: 'proj-1', name: 'Jira Implementer' },
    t2: { projectId: 'proj-2', name: 'Jira Implementer' },
    t3: { projectId: 'proj-1', name: 'Some other task' },
  };
  const taskOrder = ['t1', 't2', 't3'];

  it('finds a matching task by project and name', () => {
    expect(hasTaskNamed(taskOrder, tasks, 'proj-1', 'Jira Implementer')).toBe(true);
  });

  it('does not match a same-named task in a different project', () => {
    expect(hasTaskNamed(taskOrder, tasks, 'proj-3', 'Jira Implementer')).toBe(false);
  });

  it('does not match a different-named task in the same project', () => {
    expect(hasTaskNamed(taskOrder, tasks, 'proj-1', 'Jira Deployer')).toBe(false);
  });
});

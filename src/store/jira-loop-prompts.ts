// Prompt templates and task-reuse check for the Jira Implementer/Deployer
// loop-task buttons in EditProjectDialog.tsx. See
// docs/superpowers/specs/2026-09-20-jira-loop-buttons-design.md.
//
// Each button creates one normal task (same createTask path "New Task"
// uses) whose initialPrompt is one of these templates. From that point on,
// the task's own Claude Code session drives itself entirely via /loop --
// nothing in this app ever prompts it again.

export function IMPLEMENTER_LOOP_PROMPT(projectKey: string, reviewers: string): string {
  return `/loop 3m

Check Jira for ${projectKey} tickets labeled REG_AUTOMATED, assigned to the
current user, with status = Backlog. JQL:

  project = ${projectKey} AND labels = "REG_AUTOMATED" AND assignee = currentUser()
  AND status = Backlog ORDER BY updated ASC

If none found: nothing to do this cycle.

If one or more found: take the OLDEST match only. Run /myl3 <ticket-key> ${reviewers}.
On success, /myl3 handles its own ticket transitions and MR creation --
do not swap the ticket's label yourself; myl3's own status change
(Backlog -> In Progress) is what keeps this JQL from matching it again next cycle.
If /myl3 fails or errors, leave the ticket exactly as it is (still Backlog, still
labeled) -- it will be retried automatically next cycle. Do not treat a single
failed ticket as a reason to stop the loop.`;
}

export function DEPLOYER_LOOP_PROMPT(projectKey: string): string {
  return `/loop 3m

Check Jira for ${projectKey} tickets with status = Verified, assigned to the current
user. JQL:

  project = ${projectKey} AND assignee = currentUser() AND status = Verified
  ORDER BY updated ASC

If none found: nothing to do this cycle.

If one or more found: run /pipeline-deploy. It finds and acts on one eligible ticket
itself (same JQL convention) -- you don't need to pass it a specific ticket key. If it
reports failure, leave the ticket's state as /pipeline-deploy left it; it will be
retried automatically next cycle.`;
}

export function REVIEW_RESPONDER_LOOP_PROMPT(projectKey: string): string {
  return `/loop 3m

Check Jira for ${projectKey} tickets with status = "In Review", labeled REG_AUTOMATED_SUCC,
assigned to the current user. JQL:

  project = ${projectKey} AND assignee = currentUser() AND status = "In Review"
  AND labels = "REG_AUTOMATED_SUCC" ORDER BY updated ASC

If none found: nothing to do this cycle.

If one or more found: run /pipeline-review-respond. It finds and acts on one eligible ticket
itself (same JQL convention) -- you don't need to pass it a specific ticket key. If it reports
failure or leaves the ticket blocked (unresolved threads / not yet approved), leave the
ticket's state as /pipeline-review-respond left it; it will be retried automatically next
cycle.`;
}

/** True when a task named `name`, belonging to `projectId`, already exists in
 *  `tasks` (per `taskOrder`). Same reuse check `ensurePersistentTask` used to
 *  do inline before it was removed -- used here to disable a loop-task
 *  button once its task already exists, so a second click can't spawn a
 *  duplicate loop racing the first on the same tickets. */
export function hasTaskNamed(
  taskOrder: string[],
  tasks: Record<string, { projectId: string; name: string } | undefined>,
  projectId: string,
  name: string,
): boolean {
  return taskOrder.some((id) => {
    const task = tasks[id];
    return task?.projectId === projectId && task?.name === name;
  });
}

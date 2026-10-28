import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunLog } from "./run-task.js";
import { transition } from "./transition.js";
import type { Task } from "./types.js";
import * as worktree from "./worktree.js";

export class TaskNotFoundError extends Error {
  override readonly name = "TaskNotFoundError";

  constructor(readonly taskId: string) {
    super(`No run found for task ${taskId}`);
  }
}

export class MergeConflictError extends Error {
  override readonly name = "MergeConflictError";

  constructor(
    readonly taskId: string,
    readonly files: readonly string[],
  ) {
    super(`Merging task ${taskId} conflicts on ${files.join(", ")}`);
  }
}

/** loop-engineering's runs/ directory: one folder per task with its spec and run logs. */
export const DEFAULT_RUNS_DIR = fileURLToPath(new URL("../../../runs/", import.meta.url));

export function runLogPath(runsDir: string, taskId: string, runId: string): string {
  return join(taskDir(runsDir, taskId), `${runId}.json`);
}

export function specFilePath(runsDir: string, taskId: string): string {
  return join(taskDir(runsDir, taskId), "spec.md");
}

/** Every run log of the task, oldest first. */
export async function listRuns(taskId: string, runsDir: string = DEFAULT_RUNS_DIR): Promise<RunLog[]> {
  const dir = taskDir(runsDir, taskId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => JSON.parse(await readFile(join(dir, entry), "utf8")) as RunLog),
  );
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
}

/** The task as left by its latest run, or null when it never ran. */
export async function latestTask(taskId: string, runsDir: string = DEFAULT_RUNS_DIR): Promise<Task | null> {
  return (await listRuns(taskId, runsDir)).at(-1)?.task ?? null;
}

/**
 * Merges an awaiting_merge task into main (human approval of a non-low-risk task) and records the
 * transition in its latest run log. On conflict the merge is aborted and the task stays awaiting_merge.
 */
export async function mergeTask(taskId: string, runsDir: string = DEFAULT_RUNS_DIR): Promise<Task> {
  const run = (await listRuns(taskId, runsDir)).at(-1);
  if (run === undefined) throw new TaskNotFoundError(taskId);
  const { projectPath } = run;

  // Throws unless the task is awaiting_merge, before git is touched.
  const next = transition(run.task, "merge", run.config.budgets);
  const merge = await worktree.merge(projectPath, taskId, run.config.mainBranch);
  if (merge.status === "conflict") throw new MergeConflictError(taskId, merge.files);

  run.transitions.push({ at: new Date().toISOString(), from: run.task.state, event: "merge", to: next.state });
  run.task = next;
  await writeFile(runLogPath(runsDir, taskId, run.runId), `${JSON.stringify(run, null, 2)}\n`);
  await worktree.remove(projectPath, taskId);
  return next;
}

/**
 * Cancels a task that is not terminal: deletes its worktree and its branch if they exist, then records the
 * transition in its latest run log. Throws InvalidTransitionError for a merged, rejected or cancelled task.
 */
export async function cancelTask(taskId: string, runsDir: string = DEFAULT_RUNS_DIR): Promise<Task> {
  const run = (await listRuns(taskId, runsDir)).at(-1);
  if (run === undefined) throw new TaskNotFoundError(taskId);

  // Throws for a terminal task, before git is touched.
  const next = transition(run.task, "cancel", run.config.budgets);
  await worktree.discard(run.projectPath, taskId);

  run.transitions.push({ at: new Date().toISOString(), from: run.task.state, event: "cancel", to: next.state });
  run.task = next;
  await writeFile(runLogPath(runsDir, taskId, run.runId), `${JSON.stringify(run, null, 2)}\n`);
  return next;
}

function taskDir(runsDir: string, taskId: string): string {
  if (!worktree.TASK_ID_PATTERN.test(taskId)) throw new worktree.InvalidTaskIdError(taskId);
  return join(runsDir, taskId);
}

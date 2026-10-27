import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export function runLogPath(projectPath: string, taskId: string, runId: string): string {
  return join(runsDir(projectPath, taskId), `${runId}.json`);
}

/** Every run log of the task, oldest first. */
export async function listRuns(projectPath: string, taskId: string): Promise<RunLog[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir(projectPath, taskId));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => JSON.parse(await readFile(join(runsDir(projectPath, taskId), entry), "utf8")) as RunLog),
  );
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId));
}

/** The task as left by its latest run, or null when it never ran. */
export async function latestTask(projectPath: string, taskId: string): Promise<Task | null> {
  return (await listRuns(projectPath, taskId)).at(-1)?.task ?? null;
}

/**
 * Merges an awaiting_merge task into main (human approval of a non-low-risk task) and records the
 * transition in its latest run log. On conflict the merge is aborted and the task stays awaiting_merge.
 */
export async function mergeTask(projectPath: string, taskId: string): Promise<Task> {
  const run = (await listRuns(projectPath, taskId)).at(-1);
  if (run === undefined) throw new TaskNotFoundError(taskId);

  // Throws unless the task is awaiting_merge, before git is touched.
  const next = transition(run.task, "merge");
  const merge = await worktree.merge(projectPath, taskId);
  if (merge.status === "conflict") throw new MergeConflictError(taskId, merge.files);

  run.transitions.push({ at: new Date().toISOString(), from: run.task.state, event: "merge", to: next.state });
  run.task = next;
  await writeFile(runLogPath(projectPath, taskId, run.runId), `${JSON.stringify(run, null, 2)}\n`);
  await worktree.remove(projectPath, taskId);
  return next;
}

function runsDir(projectPath: string, taskId: string): string {
  if (!worktree.TASK_ID_PATTERN.test(taskId)) throw new worktree.InvalidTaskIdError(taskId);
  return join(projectPath, ".loop", "runs", taskId);
}

import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Letters, digits, "-" and "_": safe in a branch name and a path segment, never an option.
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class InvalidTaskIdError extends Error {
  override readonly name = "InvalidTaskIdError";

  constructor(readonly taskId: string) {
    super(`Invalid task id: ${JSON.stringify(taskId)}`);
  }
}

export class GitError extends Error {
  override readonly name = "GitError";

  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`, options);
  }
}

export class MergePreconditionError extends Error {
  override readonly name = "MergePreconditionError";
}

export type MergeResult =
  | { readonly status: "merged"; readonly commit: string }
  | { readonly status: "conflict"; readonly files: readonly string[] };

export function branchName(taskId: string): string {
  return `loop/${taskId}`;
}

/** Worktrees live outside the project so its tooling (lint, tests, tsc) never scans them. */
export function worktreePath(projectPath: string, taskId: string): string {
  const project = resolve(projectPath);
  return join(dirname(project), ".loop-worktrees", basename(project), taskId);
}

export async function create(projectPath: string, taskId: string, mainBranch: string): Promise<string> {
  assertTaskId(taskId);
  const path = worktreePath(projectPath, taskId);
  await git(projectPath, ["worktree", "add", "-q", "-b", branchName(taskId), path, mainBranch]);
  return path;
}

export async function diff(projectPath: string, taskId: string, mainBranch: string): Promise<string> {
  assertTaskId(taskId);
  return git(projectPath, ["diff", "--no-color", "--no-ext-diff", `${mainBranch}...${branchName(taskId)}`]);
}

export async function changedFiles(projectPath: string, taskId: string, mainBranch: string): Promise<string[]> {
  assertTaskId(taskId);
  const output = await git(projectPath, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    `${mainBranch}...${branchName(taskId)}`,
  ]);
  return splitNul(output);
}

export async function merge(projectPath: string, taskId: string, mainBranch: string): Promise<MergeResult> {
  assertTaskId(taskId);
  const head = await git(projectPath, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  if (head.trim() !== mainBranch) {
    throw new MergePreconditionError(`Project must be on ${mainBranch} to merge (currently: ${head.trim() || "detached"})`);
  }
  if ((await git(projectPath, ["status", "--porcelain", "--untracked-files=no"])) !== "") {
    throw new MergePreconditionError("Project has uncommitted changes");
  }

  try {
    await git(projectPath, ["merge", "--no-ff", "--no-edit", branchName(taskId)]);
  } catch (error) {
    if (!(await isMerging(projectPath))) throw error;
    const files = splitNul(await git(projectPath, ["diff", "--name-only", "--diff-filter=U", "-z"]));
    await git(projectPath, ["merge", "--abort"]);
    return { status: "conflict", files };
  }

  const commit = (await git(projectPath, ["rev-parse", "HEAD"])).trim();
  return { status: "merged", commit };
}

/**
 * Commits every change of the worktree on the task branch. Returns false when there was nothing to commit.
 * Hooks are skipped: the orchestrator runs the project checks itself.
 */
export async function commitAll(projectPath: string, taskId: string, message: string): Promise<boolean> {
  assertTaskId(taskId);
  const path = worktreePath(projectPath, taskId);
  await git(path, ["add", "-A"]);
  if ((await git(path, ["status", "--porcelain"])) === "") return false;
  await git(path, ["commit", "-q", "--no-verify", "-m", message]);
  return true;
}

/** Discards the worktree, uncommitted changes included, and deletes the task branch. */
export async function remove(projectPath: string, taskId: string): Promise<void> {
  assertTaskId(taskId);
  await git(projectPath, ["worktree", "remove", "--force", worktreePath(projectPath, taskId)]);
  await git(projectPath, ["branch", "-D", "-q", branchName(taskId)]);
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new InvalidTaskIdError(taskId);
  }
}

async function isMerging(projectPath: string): Promise<boolean> {
  try {
    await git(projectPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    const stderr = typeof cause === "object" && cause !== null && "stderr" in cause ? String(cause.stderr) : "";
    throw new GitError(args, stderr, { cause });
  }
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

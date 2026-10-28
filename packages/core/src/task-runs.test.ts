import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTask } from "./run-task.js";
import { cancelTask, latestTask, listRuns, MergeConflictError, mergeTask, TaskNotFoundError } from "./task-runs.js";
import {
  approveStep,
  badImplementerStep,
  cleanupFixtures,
  FIXTURE_TASK_ID,
  git,
  goodImplementerStep,
  implementerStep,
  isolateGitEnv,
  makeFixtureProject,
  plannerStep,
  scriptedClaude,
  writeFile,
} from "./testing.js";
import { InvalidTransitionError } from "./transition.js";
import { branchName, worktreePath } from "./worktree.js";

beforeAll(isolateGitEnv);
afterAll(cleanupFixtures);

const HIGH_RISK_CONFIG = { risk: { high: ["src/auth/**"] } };

async function awaitingMergeProject(): Promise<{ project: string; runsDir: string }> {
  const { project, taskFile, runsDir } = makeFixtureProject(HIGH_RISK_CONFIG);
  const claude = scriptedClaude([
    plannerStep(),
    implementerStep({ "feature.txt": "good\n", "src/auth/session.ts": "export {};\n" }),
    approveStep,
  ]);
  const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });
  expect(result.task.state).toBe("awaiting_merge");
  return { project, runsDir };
}

describe("listRuns / latestTask", () => {
  it("returns nothing for a task that never ran", async () => {
    const { runsDir } = makeFixtureProject();

    expect(await listRuns(FIXTURE_TASK_ID, runsDir)).toEqual([]);
    expect(await latestTask(FIXTURE_TASK_ID, runsDir)).toBeNull();
  });

  it("lists runs oldest first and exposes the task of the latest one", async () => {
    const { project, taskFile, runsDir } = makeFixtureProject();
    const failed = await runTask(project, taskFile, {
      runClaude: scriptedClaude([{ role: "planner", output: "no plan" }]).runClaude,
      runsDir,
    });
    const succeeded = await runTask(project, taskFile, {
      runClaude: scriptedClaude([plannerStep(), goodImplementerStep, approveStep]).runClaude,
      runsDir,
    });

    const runs = await listRuns(FIXTURE_TASK_ID, runsDir);

    expect(runs.map((run) => run.runId)).toEqual([failed.runId, succeeded.runId]);
    expect(await latestTask(FIXTURE_TASK_ID, runsDir)).toEqual(succeeded.task);
  });
});

describe("mergeTask", () => {
  it("merges an awaiting_merge task into main and records the transition", async () => {
    const { project, runsDir } = await awaitingMergeProject();
    const mainBefore = git(project, "rev-parse", "main");

    const task = await mergeTask(FIXTURE_TASK_ID, runsDir);

    expect(task.state).toBe("merged");
    expect(git(project, "rev-parse", "main^1")).toBe(mainBefore);
    expect(readFileSync(join(project, "src", "auth", "session.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(worktreePath(project, FIXTURE_TASK_ID))).toBe(false);
    const [run] = await listRuns(FIXTURE_TASK_ID, runsDir);
    expect(run?.task.state).toBe("merged");
    expect(run?.transitions.at(-1)).toMatchObject({ from: "awaiting_merge", event: "merge", to: "merged" });
  });

  it("refuses a task that is not awaiting merge, without touching git", async () => {
    const { project, taskFile, runsDir } = makeFixtureProject();
    await runTask(project, taskFile, {
      runClaude: scriptedClaude([plannerStep(), goodImplementerStep, approveStep]).runClaude,
      runsDir,
    });
    const mainBefore = git(project, "rev-parse", "main");

    await expect(mergeTask(FIXTURE_TASK_ID, runsDir)).rejects.toThrow(InvalidTransitionError);
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
  });

  it("reports conflicts and leaves the task awaiting merge", async () => {
    const { project, runsDir } = await awaitingMergeProject();
    writeFile(project, "feature.txt", "changed on main\n");
    git(project, "commit", "-q", "-am", "conflicting change");
    const mainBefore = git(project, "rev-parse", "main");

    const error = await mergeTask(FIXTURE_TASK_ID, runsDir).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeConflictError);
    expect(error).toMatchObject({ files: ["feature.txt"] });
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    expect((await latestTask(FIXTURE_TASK_ID, runsDir))?.state).toBe("awaiting_merge");
    expect(existsSync(worktreePath(project, FIXTURE_TASK_ID))).toBe(true);
  });

  it("rejects an unknown task", async () => {
    const { runsDir } = makeFixtureProject();

    await expect(mergeTask(FIXTURE_TASK_ID, runsDir)).rejects.toThrow(TaskNotFoundError);
  });
});

function hasBranch(project: string): boolean {
  return git(project, "branch", "--list", branchName(FIXTURE_TASK_ID)).trim() !== "";
}

describe("cancelTask", () => {
  it("cancels an awaiting_merge task, deletes its worktree and branch, and records the transition", async () => {
    const { project, runsDir } = await awaitingMergeProject();
    const mainBefore = git(project, "rev-parse", "main");

    const task = await cancelTask(FIXTURE_TASK_ID, runsDir);

    expect(task.state).toBe("cancelled");
    expect(existsSync(worktreePath(project, FIXTURE_TASK_ID))).toBe(false);
    expect(hasBranch(project)).toBe(false);
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    const run = (await listRuns(FIXTURE_TASK_ID, runsDir)).at(-1);
    expect(run?.task.state).toBe("cancelled");
    expect(run?.transitions.at(-1)).toMatchObject({ from: "awaiting_merge", event: "cancel", to: "cancelled" });
  });

  it("cancels an escalated task", async () => {
    const { project, taskFile, runsDir } = makeFixtureProject();
    const bad = badImplementerStep;
    await runTask(project, taskFile, { runClaude: scriptedClaude([plannerStep(), bad, bad, bad, bad]).runClaude, runsDir });

    expect((await cancelTask(FIXTURE_TASK_ID, runsDir)).state).toBe("cancelled");
    expect(hasBranch(project)).toBe(false);
  });

  it("cancels a task whose run failed before its branch was created", async () => {
    const { project, taskFile, runsDir } = makeFixtureProject();
    await runTask(project, taskFile, { runClaude: scriptedClaude([{ role: "planner", output: "no plan" }]).runClaude, runsDir });

    expect((await cancelTask(FIXTURE_TASK_ID, runsDir)).state).toBe("cancelled");
  });

  it("deletes the branch of a worktree whose directory was removed by hand", async () => {
    const { project, runsDir } = await awaitingMergeProject();
    rmSync(worktreePath(project, FIXTURE_TASK_ID), { recursive: true, force: true });

    await cancelTask(FIXTURE_TASK_ID, runsDir);

    expect(hasBranch(project)).toBe(false);
  });

  it("refuses a merged task", async () => {
    const { runsDir } = await awaitingMergeProject();
    await mergeTask(FIXTURE_TASK_ID, runsDir);

    await expect(cancelTask(FIXTURE_TASK_ID, runsDir)).rejects.toThrow(InvalidTransitionError);
    expect((await latestTask(FIXTURE_TASK_ID, runsDir))?.state).toBe("merged");
  });

  it("rejects an unknown task", async () => {
    const { runsDir } = makeFixtureProject();

    await expect(cancelTask("nope", runsDir)).rejects.toThrow(TaskNotFoundError);
  });
});

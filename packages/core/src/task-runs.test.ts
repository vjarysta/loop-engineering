import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTask } from "./run-task.js";
import { latestTask, listRuns, MergeConflictError, mergeTask, TaskNotFoundError } from "./task-runs.js";
import {
  approveStep,
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
import { worktreePath } from "./worktree.js";

beforeAll(isolateGitEnv);
afterAll(cleanupFixtures);

const HIGH_RISK_CONFIG = { risk: { paths: [{ pattern: "src/auth/**", class: "high" }] } };

async function awaitingMergeProject(): Promise<string> {
  const { project, taskFile } = makeFixtureProject(HIGH_RISK_CONFIG);
  const claude = scriptedClaude([
    plannerStep(),
    implementerStep({ "feature.txt": "good\n", "src/auth/session.ts": "export {};\n" }),
    approveStep,
  ]);
  const result = await runTask(project, taskFile, { runClaude: claude.runClaude });
  expect(result.task.state).toBe("awaiting_merge");
  return project;
}

describe("listRuns / latestTask", () => {
  it("returns nothing for a task that never ran", async () => {
    const { project } = makeFixtureProject();

    expect(await listRuns(project, FIXTURE_TASK_ID)).toEqual([]);
    expect(await latestTask(project, FIXTURE_TASK_ID)).toBeNull();
  });

  it("lists runs oldest first and exposes the task of the latest one", async () => {
    const { project, taskFile } = makeFixtureProject();
    const failed = await runTask(project, taskFile, {
      runClaude: scriptedClaude([{ role: "planner", output: "no plan" }]).runClaude,
    });
    const succeeded = await runTask(project, taskFile, {
      runClaude: scriptedClaude([plannerStep(), goodImplementerStep, approveStep]).runClaude,
    });

    const runs = await listRuns(project, FIXTURE_TASK_ID);

    expect(runs.map((run) => run.runId)).toEqual([failed.runId, succeeded.runId]);
    expect(await latestTask(project, FIXTURE_TASK_ID)).toEqual(succeeded.task);
  });
});

describe("mergeTask", () => {
  it("merges an awaiting_merge task into main and records the transition", async () => {
    const project = await awaitingMergeProject();
    const mainBefore = git(project, "rev-parse", "main");

    const task = await mergeTask(project, FIXTURE_TASK_ID);

    expect(task.state).toBe("merged");
    expect(git(project, "rev-parse", "main^1")).toBe(mainBefore);
    expect(readFileSync(join(project, "src", "auth", "session.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(worktreePath(project, FIXTURE_TASK_ID))).toBe(false);
    const [run] = await listRuns(project, FIXTURE_TASK_ID);
    expect(run?.task.state).toBe("merged");
    expect(run?.transitions.at(-1)).toMatchObject({ from: "awaiting_merge", event: "merge", to: "merged" });
  });

  it("refuses a task that is not awaiting merge, without touching git", async () => {
    const { project, taskFile } = makeFixtureProject();
    await runTask(project, taskFile, {
      runClaude: scriptedClaude([plannerStep(), goodImplementerStep, approveStep]).runClaude,
    });
    const mainBefore = git(project, "rev-parse", "main");

    await expect(mergeTask(project, FIXTURE_TASK_ID)).rejects.toThrow(InvalidTransitionError);
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
  });

  it("reports conflicts and leaves the task awaiting merge", async () => {
    const project = await awaitingMergeProject();
    writeFile(project, "feature.txt", "changed on main\n");
    git(project, "commit", "-q", "-am", "conflicting change");
    const mainBefore = git(project, "rev-parse", "main");

    const error = await mergeTask(project, FIXTURE_TASK_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeConflictError);
    expect(error).toMatchObject({ files: ["feature.txt"] });
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    expect((await latestTask(project, FIXTURE_TASK_ID))?.state).toBe("awaiting_merge");
    expect(existsSync(worktreePath(project, FIXTURE_TASK_ID))).toBe(true);
  });

  it("rejects an unknown task", async () => {
    const { project } = makeFixtureProject();

    await expect(mergeTask(project, FIXTURE_TASK_ID)).rejects.toThrow(TaskNotFoundError);
  });
});

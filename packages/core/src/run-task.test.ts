import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRole } from "./project-config.js";
import { type RunLog, runTask } from "./run-task.js";
import {
  approveStep as approve,
  badImplementerStep as bad,
  changesStep as changes,
  cleanupFixtures,
  FIXTURE_CHECK as CHECK,
  FIXTURE_SPEC_PATH as SPEC_PATH,
  FIXTURE_TASK_ID as TASK_ID,
  git,
  goodImplementerStep as good,
  implementerStep as implementer,
  isolateGitEnv,
  makeFixtureProject as makeProject,
  plannerStep as planner,
  type ScriptedCall as Call,
  scriptedClaude,
} from "./testing.js";
import { worktreePath } from "./worktree.js";

beforeAll(isolateGitEnv);
afterAll(cleanupFixtures);

function readLog(logPath: string): RunLog {
  return JSON.parse(readFileSync(logPath, "utf8")) as RunLog;
}

function systemPrompts(calls: readonly Call[], role: AgentRole): string[] {
  return calls.filter((call) => call.role === role).map((call) => call.options.appendSystemPrompt ?? "");
}

// ---- Tests ---------------------------------------------------------------------------------------------------

describe("runTask", () => {
  it("plans, implements, checks, reviews and merges a low-risk task", async () => {
    const { project, taskFile } = makeProject();
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.error).toBeNull();
    expect(result.task).toMatchObject({
      id: TASK_ID,
      state: "merged",
      riskClass: "low",
      specPath: SPEC_PATH,
      checkIterations: 0,
      reviewIterations: 0,
    });
    expect(readFileSync(join(project, "feature.txt"), "utf8")).toBe("good\n");
    expect(git(project, "rev-parse", "main^1")).toBe(mainBefore);
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(false);
    expect(result.logPath).toBe(join(project, ".loop", "runs", TASK_ID, `${result.runId}.json`));
  });

  it("gives each agent its prompt, its project context and its inputs", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    await runTask(project, taskFile, { runClaude: claude.runClaude });

    const [plannerCall, implementerCall, reviewerCall] = claude.calls;
    expect(plannerCall?.options.cwd).toBe(project);
    expect(plannerCall?.options.systemPromptFile).toMatch(/agents\/planner\.md$/);
    expect(plannerCall?.options.appendSystemPrompt).toContain("Project instructions for the planner:");
    expect(plannerCall?.options.prompt).toContain("Implement docs/PRD.md#feature.");

    expect(implementerCall?.options).toMatchObject({ cwd: worktreePath(project, TASK_ID), model: "sonnet" });
    expect(implementerCall?.options.prompt).toMatch(/^\/goal /);
    expect(implementerCall?.options.prompt).toContain(CHECK);
    expect(implementerCall?.options.appendSystemPrompt).toContain("Cites docs/PRD.md#feature.");

    const reviewerPrompt = reviewerCall?.options.prompt ?? "";
    expect(reviewerCall?.options.appendSystemPrompt).toContain("Project instructions for the reviewer:");
    expect(reviewerPrompt).toContain("Cites docs/PRD.md#feature.");
    expect(reviewerPrompt).toContain("-todo\n+good");
    expect(reviewerPrompt).toContain("## Feature\nfeature.txt says good.");
    expect(reviewerPrompt).not.toContain("Unrelated requirement.");
  });

  it("logs every step and every transition", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    const log = readLog(result.logPath);
    expect(log).toMatchObject({ runId: result.runId, taskId: TASK_ID, status: "completed", error: null });
    expect(log.steps.map((step) => step.role)).toEqual(["planner", "implementer", "check", "reviewer"]);
    expect(log.steps[1]).toMatchObject({
      role: "implementer",
      model: "sonnet",
      usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
      costUsd: 0.01,
      durationMs: 100,
      output: "Done.",
    });
    expect(log.steps[2]).toMatchObject({ role: "check", model: null, usage: null, costUsd: null, passed: true });
    expect(log.transitions.map(({ from, event, to }) => `${from} -${event}-> ${to}`)).toEqual([
      "approved -plan-> planned",
      "planned -start-> in_progress",
      "in_progress -run_checks-> checks",
      "checks -checks_passed-> in_review",
      "in_review -approve-> merged",
    ]);
  });

  it("sends the failing check output back to the implementer, then succeeds", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([planner(), bad, good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "merged", checkIterations: 1 });
    const [first, second] = systemPrompts(claude.calls, "implementer");
    expect(first).not.toContain("feature.txt must contain good");
    expect(second).toContain("feature.txt must contain good");
    expect(readLog(result.logPath).steps.filter((step) => step.role === "check").map((step) => step.passed)).toEqual([
      false,
      true,
    ]);
  });

  it("fails the check when a protected path is modified, even if the check command passes", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([
      planner(),
      implementer({ "feature.txt": "good\n", "secrets/key.txt": "leak\n" }),
      implementer({ "secrets/key.txt": null }),
      approve,
    ]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "merged", checkIterations: 1 });
    const firstCheck = readLog(result.logPath).steps.find((step) => step.role === "check");
    expect(firstCheck?.passed).toBe(false);
    expect(firstCheck?.output).toContain("Protected path modified: secrets/key.txt");
    expect(systemPrompts(claude.calls, "implementer")[1]).toContain("Protected path modified: secrets/key.txt");
    expect(existsSync(join(project, "secrets", "key.txt"))).toBe(false);
  });

  it("sends review issues back to the implementer, then merges on approval", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([planner(), good, changes, implementer({ "feature.txt": "GOOD good\n" }), approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "merged", reviewIterations: 1, checkIterations: 0 });
    expect(systemPrompts(claude.calls, "implementer")[1]).toContain("feature.txt:1 [major] Say it louder");
    expect(readFileSync(join(project, "feature.txt"), "utf8")).toBe("GOOD good\n");
  });

  it("treats an invalid reviewer output as a run error, not a verdict", async () => {
    const { project, taskFile } = makeProject();
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([planner(), good, { role: "reviewer", output: "LGTM!" }]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.error).toMatch(/reviewer/);
    expect(result.task).toMatchObject({ state: "in_review", reviewIterations: 0 });
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(true);
    const log = readLog(result.logPath);
    expect(log).toMatchObject({ status: "error", error: result.error });
    expect(log.steps.at(-1)).toMatchObject({ role: "reviewer", output: "LGTM!" });
  });

  it("treats an invalid planner output as a run error before creating the worktree", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([{ role: "planner", output: "I could not plan." }]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.error).toMatch(/planner/);
    expect(result.task.state).toBe("approved");
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(false);
  });

  it("escalates when the check budget is exhausted", async () => {
    const { project, taskFile } = makeProject();
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([planner(), bad, bad, bad, bad]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.error).toBeNull();
    expect(result.task).toMatchObject({ state: "escalated", checkIterations: 3 });
    expect(claude.calls.map((call) => call.role)).toEqual(["planner", "implementer", "implementer", "implementer", "implementer"]);
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
  });

  it("escalates when the review budget is exhausted", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([planner(), good, changes, good, changes, good, changes]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "escalated", reviewIterations: 2 });
  });

  it("waits for a human merge when changed files raise the risk class", async () => {
    const { project, taskFile } = makeProject({ risk: { paths: [{ pattern: "src/auth/**", class: "high" }] } });
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([
      planner("low"),
      implementer({ "feature.txt": "good\n", "src/auth/session.ts": "export {};\n" }),
      approve,
    ]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "high" });
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(true);
  });

  it("waits for a human merge when the diff size raises the risk class", async () => {
    const { project, taskFile } = makeProject({ risk: { diffLines: { medium: 20 } } });
    const claude = scriptedClaude([
      planner("low"),
      implementer({ "feature.txt": "good\n", "big.txt": "line\n".repeat(30) }),
      approve,
    ]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "medium" });
  });

  it("keeps the planner risk class when it is higher than the computed one", async () => {
    const { project, taskFile } = makeProject();
    const claude = scriptedClaude([planner("medium"), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "medium" });
  });
});

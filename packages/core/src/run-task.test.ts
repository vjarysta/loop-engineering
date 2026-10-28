import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  FIXTURE_SPEC as SPEC,
  FIXTURE_TASK_ID as TASK_ID,
  git,
  goodImplementerStep as good,
  implementerStep as implementer,
  isolateGitEnv,
  makeFixtureProject as makeProject,
  plannerStep as planner,
  type ScriptedCall as Call,
  type ScriptStep,
  scriptedClaude,
  snapshotTree,
  specPathFromPrompt,
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
    const { project, taskFile, runsDir } = makeProject();
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toBeNull();
    expect(result.task).toMatchObject({
      id: TASK_ID,
      state: "merged",
      riskClass: "low",
      specPath: join(runsDir, TASK_ID, "spec.md"),
      checkIterations: 0,
      reviewIterations: 0,
    });
    expect(readFileSync(join(project, "feature.txt"), "utf8")).toBe("good\n");
    expect(git(project, "rev-parse", "main^1")).toBe(mainBefore);
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(false);
    expect(result.logPath).toBe(join(runsDir, TASK_ID, `${result.runId}.json`));
  });

  it("keeps the spec in runs/<taskId>/spec.md, outside the target repository", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(readFileSync(join(runsDir, TASK_ID, "spec.md"), "utf8")).toBe(SPEC);
    expect(git(project, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(project, "ls-tree", "-r", "--name-only", "main")).not.toContain("spec.md");
    expect(result.error).toBeNull();
  });

  it("gives each agent its prompt, its project context and its inputs", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    const specPath = join(runsDir, TASK_ID, "spec.md");
    const specDir = join(runsDir, TASK_ID);
    const [plannerCall, implementerCall, reviewerCall] = claude.calls;
    expect(plannerCall?.options.cwd).toBe(project);
    expect(plannerCall?.options.systemPromptFile).toMatch(/agents\/planner\.md$/);
    expect(plannerCall?.options.appendSystemPrompt).toContain("Project instructions for the planner:");
    expect(plannerCall?.options.prompt).toContain("Implement docs/PRD.md#feature.");
    expect(plannerCall && specPathFromPrompt(plannerCall.options)).toBe(specPath);
    expect(plannerCall?.options.addDirs).toEqual([specDir]);

    expect(implementerCall?.options).toMatchObject({ cwd: worktreePath(project, TASK_ID), model: "sonnet" });
    expect(implementerCall?.options.prompt).toMatch(/^\/goal /);
    expect(implementerCall?.options.prompt).toContain(CHECK);
    expect(implementerCall?.options.prompt).toContain(specPath);
    expect(implementerCall?.options.appendSystemPrompt).toContain(`Spec path: ${specPath}`);
    expect(implementerCall?.options.appendSystemPrompt).not.toContain("Cites docs/PRD.md#feature.");
    expect(implementerCall?.options.addDirs).toEqual([specDir]);

    const reviewerPrompt = reviewerCall?.options.prompt ?? "";
    expect(reviewerCall?.options.appendSystemPrompt).toContain("Project instructions for the reviewer:");
    expect(reviewerCall?.options.addDirs).toEqual([specDir]);
    expect(reviewerPrompt).toContain(`Spec path: ${specPath}`);
    expect(reviewerPrompt).not.toContain("Cites docs/PRD.md#feature.");
    expect(reviewerPrompt).toContain("-todo\n+good");
    expect(reviewerPrompt).toContain("## Feature\nfeature.txt says good.");
    expect(reviewerPrompt).not.toContain("Unrelated requirement.");
  });

  it("restricts each role to its tools and pre-approves exactly those", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    const tools = Object.fromEntries(claude.calls.map(({ role, options }) => [role, [options.tools, options.allowedTools]]));
    const readOnly = ["Read", "Glob", "Grep"];
    expect(tools).toEqual({
      planner: [
        [...readOnly, "Write"],
        [...readOnly, "Write"],
      ],
      implementer: [
        [...readOnly, "Edit", "Write", "Bash"],
        [...readOnly, "Edit", "Write", "Bash"],
      ],
      reviewer: [readOnly, readOnly],
    });
  });

  it("commits each iteration with the task title and the planner notes", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner("low", "Interpreted §2 in ms."), good, approve]);

    await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(git(project, "log", "-1", "--format=%B", "main^2").trim()).toBe(
      `${TASK_ID} — Say good\n\nImplementer iteration 1.\n\nPlanner notes:\nInterpreted §2 in ms.`,
    );
  });

  it("leaves the planner notes out of the commit message when there are none", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(git(project, "log", "-1", "--format=%B", "main^2").trim()).toBe(`${TASK_ID} — Say good\n\nImplementer iteration 1.`);
  });

  it("fails the run when the planner writes into the project checkout", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const intruder: ScriptStep = {
      ...planner(),
      act: (cwd, options) => {
        planner().act?.(cwd, options);
        writeFileSync(join(cwd, "spec.md"), "misplaced");
      },
    };
    const claude = scriptedClaude([intruder]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toMatch(/Planner modified .+; it may only write the spec/);
    expect(result.task.state).toBe("approved");
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(false);
  });

  it("tolerates changes already present in the project checkout before planning", async () => {
    const { project, taskFile, runsDir } = makeProject();
    writeFileSync(join(project, "notes.txt"), "local draft\n");
    const claude = scriptedClaude([planner("high"), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toBeNull();
    expect(result.task.state).toBe("awaiting_merge");
  });

  it("logs every step and every transition", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    const log = readLog(result.logPath);
    expect(log).toMatchObject({ runId: result.runId, taskId: TASK_ID, status: "completed", error: null });
    expect(log.steps.map((step) => step.role)).toEqual(["planner", "implementer", "check", "reviewer"]);
    expect(log.steps[1]).toMatchObject({
      role: "implementer",
      model: "sonnet",
      usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "session-2",
      numTurns: 2,
      permissionDenials: 0,
      output: "Done.",
    });
    expect(log.steps[2]).toMatchObject({
      role: "check",
      model: null,
      usage: null,
      costUsd: null,
      sessionId: null,
      passed: true,
    });
    expect(log.transitions.map(({ from, event, to }) => `${from} -${event}-> ${to}`)).toEqual([
      "approved -plan-> planned",
      "planned -start-> in_progress",
      "in_progress -run_checks-> checks",
      "checks -checks_passed-> in_review",
      "in_review -approve-> merged",
    ]);
  });

  it("sends the failing check output back to the implementer, then succeeds", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), bad, good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

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
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([
      planner(),
      implementer({ "feature.txt": "good\n", "secrets/key.txt": "leak\n" }),
      implementer({ "secrets/key.txt": null }),
      approve,
    ]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "merged", checkIterations: 1 });
    const firstCheck = readLog(result.logPath).steps.find((step) => step.role === "check");
    expect(firstCheck?.passed).toBe(false);
    expect(firstCheck?.output).toContain("Protected path modified: secrets/key.txt");
    expect(systemPrompts(claude.calls, "implementer")[1]).toContain("Protected path modified: secrets/key.txt");
    expect(existsSync(join(project, "secrets", "key.txt"))).toBe(false);
  });

  it("sends review issues back to the implementer, then merges on approval", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, changes, implementer({ "feature.txt": "GOOD good\n" }), approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "merged", reviewIterations: 1, checkIterations: 0 });
    expect(systemPrompts(claude.calls, "implementer")[1]).toContain("feature.txt:1 [major] Say it louder");
    expect(readFileSync(join(project, "feature.txt"), "utf8")).toBe("GOOD good\n");
  });

  it("treats an invalid reviewer output as a run error, not a verdict", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([planner(), good, { role: "reviewer", output: "LGTM!" }]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toMatch(/reviewer/);
    expect(result.task).toMatchObject({ state: "in_review", reviewIterations: 0 });
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(true);
    const log = readLog(result.logPath);
    expect(log).toMatchObject({ status: "error", error: result.error });
    expect(log.steps.at(-1)).toMatchObject({ role: "reviewer", output: "LGTM!" });
  });

  it("treats an invalid planner output as a run error before creating the worktree", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([{ role: "planner", output: "I could not plan." }]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toMatch(/planner/);
    expect(result.task.state).toBe("approved");
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(false);
  });

  it("escalates when the check budget is exhausted", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([planner(), bad, bad, bad, bad]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toBeNull();
    expect(result.task).toMatchObject({ state: "escalated", checkIterations: 3 });
    expect(claude.calls.map((call) => call.role)).toEqual(["planner", "implementer", "implementer", "implementer", "implementer"]);
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
  });

  it("escalates when the review budget is exhausted", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, changes, good, changes, good, changes]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "escalated", reviewIterations: 2 });
  });

  it("waits for a human merge when changed files raise the risk class", async () => {
    const { project, taskFile, runsDir } = makeProject({ risk: { high: ["src/auth/**"] } });
    const mainBefore = git(project, "rev-parse", "main");
    const claude = scriptedClaude([
      planner("low"),
      implementer({ "feature.txt": "good\n", "src/auth/session.ts": "export {};\n" }),
      approve,
    ]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "high" });
    expect(git(project, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(worktreePath(project, TASK_ID))).toBe(true);
  });

  it("waits for a human merge when the diff size raises the risk class", async () => {
    const { project, taskFile, runsDir } = makeProject({ risk: { maxLowRiskDiffLines: 20 } });
    const claude = scriptedClaude([
      planner("low"),
      implementer({ "feature.txt": "good\n", "big.txt": "line\n".repeat(30) }),
      approve,
    ]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "medium" });
  });

  it("keeps the planner risk class when it is higher than the computed one", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner("medium"), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "medium" });
  });
  it("runs each role with the model the config assigns to it", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const claude = scriptedClaude([planner(), good, approve]);

    await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(claude.calls.map(({ role, options }) => `${role}:${options.model ?? "-"}`)).toEqual([
      "planner:opus",
      "implementer:sonnet",
      "reviewer:haiku",
    ]);
  });

  it("escalates according to the check budget of the config", async () => {
    const { project, taskFile, runsDir } = makeProject({ budgets: { checkIterations: 1 } });
    const claude = scriptedClaude([planner(), bad, bad]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "escalated", checkIterations: 1 });
  });

  it("escalates according to the review budget of the config", async () => {
    const { project, taskFile, runsDir } = makeProject({ budgets: { reviewIterations: 1 } });
    const claude = scriptedClaude([planner(), good, changes, good, changes]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "escalated", reviewIterations: 1 });
  });

  it("branches from, diffs against and merges into the configured main branch", async () => {
    const { project, taskFile, runsDir } = makeProject({ mainBranch: "trunk" });
    const trunkBefore = git(project, "rev-parse", "trunk");
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task.state).toBe("merged");
    expect(git(project, "rev-parse", "trunk^1")).toBe(trunkBefore);
    expect(claude.calls[2]?.options.prompt).toContain("## Diff against trunk");
  });

  it("raises the risk to medium for a changed file that matches no risk list", async () => {
    const { project, taskFile, runsDir } = makeProject({ risk: { low: ["docs/**"] } });
    const claude = scriptedClaude([planner(), good, approve]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.task).toMatchObject({ state: "awaiting_merge", riskClass: "medium" });
  });

  it("rejects a spec written anywhere else than the given path", async () => {
    const { project, taskFile, runsDir } = makeProject();
    const elsewhere: ScriptStep = {
      role: "planner",
      output: "```json\n" + JSON.stringify({ specPath: "/tmp/spec.md", riskClass: "low", impactedFiles: [], notes: "" }) + "\n```",
    };
    const claude = scriptedClaude([elsewhere]);

    const result = await runTask(project, taskFile, { runClaude: claude.runClaude, runsDir });

    expect(result.error).toContain("/tmp/spec.md");
    expect(result.task.state).toBe("approved");
  });

  describe("never creates or modifies a file under the project's .loop/", () => {
    const highRisk = { risk: { high: ["src/auth/**"] } };
    const scenarios: [string, Record<string, unknown>, () => ScriptStep[]][] = [
      ["merged", {}, () => [planner(), good, approve]],
      ["awaiting_merge", highRisk, () => [planner(), implementer({ "feature.txt": "good\n", "src/auth/a.ts": "x\n" }), approve]],
      ["checks then review rework", {}, () => [planner(), bad, good, changes, good, approve]],
      ["escalated", {}, () => [planner(), bad, bad, bad, bad]],
      ["reviewer error", {}, () => [planner(), good, { role: "reviewer", output: "LGTM!" }]],
      ["planner error", {}, () => [{ role: "planner", output: "no plan" }]],
    ];

    it.each(scenarios)("%s", async (_label, config, script) => {
      const { project, taskFile, runsDir } = makeProject(config);
      const before = snapshotTree(join(project, ".loop"));

      await runTask(project, taskFile, { runClaude: scriptedClaude(script()).runClaude, runsDir });

      expect(snapshotTree(join(project, ".loop"))).toEqual(before);
      expect(Object.keys(before)).toEqual(["config.json"]);
    });
  });
});

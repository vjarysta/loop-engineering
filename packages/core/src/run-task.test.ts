import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRole } from "./project-config.js";
import type { RunClaudeOptions, RunClaudeResult } from "./run-claude.js";
import { type RunLog, runTask } from "./run-task.js";
import { worktreePath } from "./worktree.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  // Isolate from the developer's git config (signing, hooks, default branch…).
  const configDir = mkdtempSync(join(tmpdir(), "git-config-"));
  tmpDirs.push(configDir);
  const globalConfig = join(configDir, "gitconfig");
  writeFileSync(globalConfig, "");
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["GIT_AUTHOR_NAME"] = "Test";
  process.env["GIT_AUTHOR_EMAIL"] = "test@example.com";
  process.env["GIT_COMMITTER_NAME"] = "Test";
  process.env["GIT_COMMITTER_EMAIL"] = "test@example.com";
});

const TASK_ID = "task-1";
const SPEC_PATH = `.loop/specs/${TASK_ID}.md`;
const CHECK = "grep -q good feature.txt || { echo 'feature.txt must contain good'; exit 1; }";
const PRD = "# PRD\n## Feature\nfeature.txt says good.\n## Other\nUnrelated requirement.\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

interface Fixture {
  readonly project: string;
  readonly taskFile: string;
}

function makeProject(config: Record<string, unknown> = {}): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "run-task-")));
  tmpDirs.push(parent);
  const project = join(parent, "project");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  writeFile(
    project,
    ".loop/config.json",
    JSON.stringify({
      check: CHECK,
      protectedPaths: ["secrets/**"],
      sourcesOfTruth: [{ path: "docs/PRD.md", description: "Product requirements" }],
      agents: { implementer: { model: "sonnet" } },
      ...config,
    }),
  );
  writeFile(project, "docs/PRD.md", PRD);
  writeFile(project, "feature.txt", "todo\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "initial");

  const taskFile = join(parent, "task.json");
  writeFileSync(
    taskFile,
    JSON.stringify({ id: TASK_ID, title: "Say good", description: "Implement docs/PRD.md#feature." }),
  );
  return { project, taskFile };
}

// ---- Scripted runClaude --------------------------------------------------------------------------------------

interface Step {
  readonly role: AgentRole;
  /** Side effect in the agent's cwd (writing the spec, editing files…). */
  readonly act?: (cwd: string) => void;
  readonly output: string;
}

interface Call {
  readonly role: AgentRole;
  readonly options: RunClaudeOptions;
}

function scriptedClaude(steps: readonly Step[]): {
  readonly runClaude: (options: RunClaudeOptions, role: AgentRole) => Promise<RunClaudeResult>;
  readonly calls: Call[];
} {
  const queue = [...steps];
  const calls: Call[] = [];
  return {
    calls,
    runClaude: (options, role) => {
      calls.push({ role, options });
      const step = queue.shift();
      if (step?.role !== role) {
        return Promise.reject(new Error(`unexpected ${role} call, script expected ${step?.role ?? "nothing"}`));
      }
      step.act?.(options.cwd);
      return Promise.resolve({
        resultText: step.output,
        usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
        costUsd: 0.01,
        durationMs: 100,
        raw: { result: step.output },
      });
    },
  };
}

const planner = (riskClass = "low"): Step => ({
  role: "planner",
  act: (cwd) => {
    writeFile(cwd, SPEC_PATH, "# Spec\nCites docs/PRD.md#feature.\n## Test plan\n- check: feature.txt contains good\n");
  },
  output:
    "Spec written.\n```json\n" +
    JSON.stringify({ specPath: SPEC_PATH, riskClass, impactedFiles: ["feature.txt"], notes: "" }) +
    "\n```",
});

const implementer = (files: Readonly<Record<string, string | null>>): Step => ({
  role: "implementer",
  act: (cwd) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) rmSync(join(cwd, path));
      else writeFile(cwd, path, content);
    }
  },
  output: "Done.",
});

const good = implementer({ "feature.txt": "good\n" });
const bad = implementer({ "feature.txt": "bad\n" });
const approve: Step = { role: "reviewer", output: JSON.stringify({ verdict: "approve", issues: [] }) };
const changes: Step = {
  role: "reviewer",
  output: JSON.stringify({
    verdict: "changes",
    issues: [{ file: "feature.txt", line: 1, severity: "major", message: "Say it louder" }],
  }),
};

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

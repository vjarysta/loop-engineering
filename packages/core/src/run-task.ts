import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlannerOutput, parseReviewerOutput, type ReviewVerdict } from "./agent-output.js";
import { runProcess } from "./process.js";
import { type AgentRole, buildProjectContext, loadProjectConfig, type ProjectConfig } from "./project-config.js";
import { computeRiskClass, countChangedLines, matchesAny, maxRiskClass } from "./risk.js";
import { type ClaudeUsage, runClaude, type RunClaudeOptions, type RunClaudeResult } from "./run-claude.js";
import { extractCitedSources, formatCitedSources } from "./sources.js";
import { loadTaskFile, type TaskFile } from "./task-file.js";
import { transition } from "./transition.js";
import type { Task, TaskEvent, TaskState } from "./types.js";
import * as worktree from "./worktree.js";

const DEFAULT_AGENTS_DIR = fileURLToPath(new URL("../../../agents/", import.meta.url));

const DEFAULT_AGENT_SETTINGS: Readonly<Record<AgentRole, { allowedTools: readonly string[]; timeoutMs: number }>> = {
  planner: { allowedTools: ["Read", "Glob", "Grep", "Write"], timeoutMs: 15 * 60_000 },
  implementer: { allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"], timeoutMs: 60 * 60_000 },
  reviewer: { allowedTools: ["Read", "Glob", "Grep"], timeoutMs: 15 * 60_000 },
};
const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60_000;
/** The agent must never touch its own configuration, specs or run logs. */
const ALWAYS_PROTECTED = [".loop/**"];
/** Tail of the check output sent back to the implementer. */
const MAX_FEEDBACK_CHARS = 20_000;

export interface RunTaskOptions {
  /** Replaces the real `claude` invocation, e.g. in tests. */
  readonly runClaude?: (options: RunClaudeOptions, role: AgentRole) => Promise<RunClaudeResult>;
  /** Directory holding planner.md, implementer.md and reviewer.md. */
  readonly agentsDir?: string;
}

export interface RunStep {
  readonly role: AgentRole | "check";
  readonly iteration: number;
  readonly startedAt: string;
  readonly model: string | null;
  readonly usage: ClaudeUsage | null;
  readonly costUsd: number | null;
  readonly durationMs: number;
  readonly output: string;
  /** Check steps only. */
  readonly passed: boolean | null;
  readonly error: string | null;
}

export interface TransitionLogEntry {
  readonly at: string;
  readonly from: TaskState;
  readonly event: TaskEvent;
  readonly to: TaskState;
}

export interface RunLog {
  readonly runId: string;
  readonly taskId: string;
  readonly taskFile: string;
  readonly projectPath: string;
  readonly startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "error";
  error: string | null;
  task: Task;
  readonly steps: RunStep[];
  readonly transitions: TransitionLogEntry[];
}

export interface RunTaskResult {
  /** Final task: merged, awaiting_merge or escalated when completed; the state reached on error. */
  readonly task: Task;
  readonly runId: string;
  readonly logPath: string;
  /** Set when the run failed (agent failure, invalid agent output, merge conflict…); the task is left as is. */
  readonly error: string | null;
}

export class RunTaskError extends Error {
  override readonly name = "RunTaskError";
}

/**
 * Runs an approved task through planner → implementer → checks → reviewer until it is merged, awaits a
 * human merge, or is escalated. Every state change goes through the task state machine.
 */
export async function runTask(projectPath: string, taskFile: string, options: RunTaskOptions = {}): Promise<RunTaskResult> {
  const config = await loadProjectConfig(projectPath);
  const taskDef = await loadTaskFile(taskFile);
  const runId = randomUUID();
  const logPath = join(projectPath, ".loop", "runs", taskDef.id, `${runId}.json`);
  const run = new TaskRun(projectPath, config, taskDef, runId, logPath, taskFile, options);
  return run.execute();
}

class TaskRun {
  private task: Task;
  private readonly log: RunLog;
  private readonly agentsDir: string;
  private readonly callClaude: (options: RunClaudeOptions, role: AgentRole) => Promise<RunClaudeResult>;

  constructor(
    private readonly projectPath: string,
    private readonly config: ProjectConfig,
    private readonly taskDef: TaskFile,
    private readonly runId: string,
    private readonly logPath: string,
    taskFile: string,
    options: RunTaskOptions,
  ) {
    this.agentsDir = options.agentsDir ?? DEFAULT_AGENTS_DIR;
    this.callClaude = options.runClaude ?? ((claudeOptions) => runClaude(claudeOptions));
    this.task = {
      id: taskDef.id,
      projectPath,
      title: taskDef.title,
      specPath: "",
      // Unknown until planned: assume the worst.
      riskClass: "high",
      state: "approved",
      checkIterations: 0,
      reviewIterations: 0,
    };
    this.log = {
      runId,
      taskId: taskDef.id,
      taskFile,
      projectPath,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      error: null,
      task: this.task,
      steps: [],
      transitions: [],
    };
  }

  async execute(): Promise<RunTaskResult> {
    await this.save();
    try {
      await this.pipeline();
      return await this.finish(null);
    } catch (error) {
      return await this.finish(error instanceof Error ? error.message : String(error));
    }
  }

  private async pipeline(): Promise<void> {
    const spec = await this.plan();
    const worktreeDir = await worktree.create(this.projectPath, this.task.id);
    await this.apply("start");

    let feedback: string | null = null;
    for (let iteration = 1; ; iteration++) {
      await this.implement(worktreeDir, spec, feedback, iteration);
      await worktree.commitAll(this.projectPath, this.task.id, `${this.task.id}: implementer iteration ${String(iteration)}`);

      await this.apply("run_checks");
      const check = await this.check(worktreeDir, iteration);
      if (!check.passed) {
        await this.apply("checks_failed");
        if (this.task.state === "escalated") return;
        feedback = `## Rework: checks failed\n\n${tail(check.output)}`;
        continue;
      }
      await this.apply("checks_passed");

      const diff = await worktree.diff(this.projectPath, this.task.id);
      const verdict = await this.review(worktreeDir, spec, diff, check.output, iteration);
      if (verdict.verdict === "changes") {
        await this.apply("request_changes");
        if (this.task.state === "escalated") return;
        feedback = `## Rework: review requested changes\n\n${formatIssues(verdict)}`;
        continue;
      }

      await this.approve(diff);
      return;
    }
  }

  private async plan(): Promise<string> {
    const expectedSpecPath = join(".loop", "specs", `${this.task.id}.md`);
    const result = await this.agent("planner", 1, {
      cwd: this.projectPath,
      prompt: [
        `Task id: ${this.taskDef.id}`,
        `Title: ${this.taskDef.title}`,
        "",
        this.taskDef.description,
        "",
        `Write the spec to ${expectedSpecPath}.`,
      ].join("\n"),
      appendSystemPrompt: buildProjectContext(this.config, "planner"),
    });

    const plan = parsePlannerOutput(result.resultText);
    if (normalize(plan.specPath) !== expectedSpecPath) {
      throw new RunTaskError(`Planner wrote ${plan.specPath} instead of ${expectedSpecPath}`);
    }
    const spec = await readFile(join(this.projectPath, expectedSpecPath), "utf8").catch((cause: unknown) => {
      throw new RunTaskError(`Planner did not write ${expectedSpecPath}`, { cause });
    });

    this.task = { ...this.task, specPath: plan.specPath, riskClass: plan.riskClass };
    await this.apply("plan");
    return spec;
  }

  private async implement(cwd: string, spec: string, feedback: string | null, iteration: number): Promise<void> {
    const goal =
      `/goal The project check command \`${this.config.check}\` passes in this worktree, ` +
      "every test listed in the spec exists and passes, and no protected path is modified.";
    await this.agent("implementer", iteration, {
      cwd,
      prompt: goal,
      appendSystemPrompt: [
        buildProjectContext(this.config, "implementer"),
        `## Spec (${this.task.specPath})\n\n${spec}`,
        ...(feedback === null ? [] : [feedback]),
      ].join("\n\n"),
    });
  }

  private async check(cwd: string, iteration: number): Promise<{ passed: boolean; output: string }> {
    const startedAt = new Date();
    const changed = await worktree.changedFiles(this.projectPath, this.task.id);
    const violations = changed.filter((file) => matchesAny(file, [...this.config.protectedPaths, ...ALWAYS_PROTECTED]));

    let passed: boolean;
    let output: string;
    if (violations.length > 0) {
      passed = false;
      output = [...violations.map((file) => `Protected path modified: ${file}`), "Revert these changes."].join("\n");
    } else {
      const timeoutMs = this.config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      // `exec 2>&1` merges stderr into stdout for the whole command, keeping the output in order.
      const result = await runProcess({ command: "sh", args: ["-c", `exec 2>&1\n${this.config.check}`], cwd, timeoutMs });
      passed = result.exitCode === 0 && !result.timedOut;
      output = result.timedOut ? `${result.stdout}\nCheck timed out after ${String(timeoutMs)}ms.` : result.stdout;
    }

    await this.addStep({
      role: "check",
      iteration,
      startedAt: startedAt.toISOString(),
      model: null,
      usage: null,
      costUsd: null,
      durationMs: Date.now() - startedAt.getTime(),
      output,
      passed,
      error: null,
    });
    return { passed, output };
  }

  private async review(
    cwd: string,
    spec: string,
    diff: string,
    checkOutput: string,
    iteration: number,
  ): Promise<ReviewVerdict> {
    const cited = await extractCitedSources(spec, this.config.sourcesOfTruth, this.projectPath);
    const result = await this.agent("reviewer", iteration, {
      cwd,
      prompt: [
        `## Spec (${this.task.specPath})\n\n${spec}`,
        `## Diff against main\n\n${diff}`,
        `## Check output\n\n${checkOutput === "" ? "(no output, exit code 0)" : checkOutput}`,
        `## Cited sources of truth\n\n${formatCitedSources(cited)}`,
      ].join("\n\n"),
      appendSystemPrompt: buildProjectContext(this.config, "reviewer"),
    });
    return parseReviewerOutput(result.resultText);
  }

  private async approve(diff: string): Promise<void> {
    const changed = await worktree.changedFiles(this.projectPath, this.task.id);
    const computed = computeRiskClass(this.config.risk, changed, countChangedLines(diff));
    this.task = { ...this.task, riskClass: maxRiskClass(this.task.riskClass, computed) };

    // Ask the state machine first: merge only if approval leads to merged.
    if (transition(this.task, "approve").state === "merged") {
      const merge = await worktree.merge(this.projectPath, this.task.id);
      if (merge.status === "conflict") {
        throw new RunTaskError(`Merge conflict on ${merge.files.join(", ")}; task left in review`);
      }
    }
    await this.apply("approve");
    if (this.task.state === "merged") {
      await worktree.remove(this.projectPath, this.task.id);
    }
  }

  private async agent(
    role: AgentRole,
    iteration: number,
    options: Pick<RunClaudeOptions, "cwd" | "prompt" | "appendSystemPrompt">,
  ): Promise<RunClaudeResult> {
    const settings = this.config.agents[role];
    const model = settings?.model ?? null;
    const startedAt = new Date();
    const claudeOptions: RunClaudeOptions = {
      ...options,
      systemPromptFile: join(this.agentsDir, `${role}.md`),
      allowedTools: settings?.allowedTools ?? DEFAULT_AGENT_SETTINGS[role].allowedTools,
      timeoutMs: settings?.timeoutMs ?? DEFAULT_AGENT_SETTINGS[role].timeoutMs,
      ...(model !== null && { model }),
    };

    let result: RunClaudeResult;
    try {
      result = await this.callClaude(claudeOptions, role);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.addStep({
        role,
        iteration,
        startedAt: startedAt.toISOString(),
        model,
        usage: null,
        costUsd: null,
        durationMs: Date.now() - startedAt.getTime(),
        output: "",
        passed: null,
        error: message,
      });
      throw new RunTaskError(`${role} failed: ${message}`, { cause: error });
    }

    await this.addStep({
      role,
      iteration,
      startedAt: startedAt.toISOString(),
      model,
      usage: result.usage,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      output: result.resultText,
      passed: null,
      error: null,
    });
    return result;
  }

  private async apply(event: TaskEvent): Promise<void> {
    const next = transition(this.task, event);
    this.log.transitions.push({ at: new Date().toISOString(), from: this.task.state, event, to: next.state });
    this.task = next;
    await this.save();
  }

  private async addStep(step: RunStep): Promise<void> {
    this.log.steps.push(step);
    await this.save();
  }

  private async finish(error: string | null): Promise<RunTaskResult> {
    this.log.status = error === null ? "completed" : "error";
    this.log.error = error;
    this.log.finishedAt = new Date().toISOString();
    await this.save();
    return { task: this.task, runId: this.runId, logPath: this.logPath, error };
  }

  private async save(): Promise<void> {
    this.log.task = this.task;
    await mkdir(dirname(this.logPath), { recursive: true });
    await writeFile(this.logPath, `${JSON.stringify(this.log, null, 2)}\n`);
  }
}

function formatIssues({ issues }: ReviewVerdict): string {
  return issues
    .map(({ file, line, severity, message }) => `- ${line === null ? file : `${file}:${String(line)}`} [${severity}] ${message}`)
    .join("\n");
}

function tail(text: string): string {
  return text.length <= MAX_FEEDBACK_CHARS ? text : `[…truncated]\n${text.slice(-MAX_FEEDBACK_CHARS)}`;
}

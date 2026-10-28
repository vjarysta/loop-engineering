import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  AGENT_ROLES,
  buildProjectContext,
  cancelTask,
  CONFIG_PATH,
  DEFAULT_RUNS_DIR,
  InvalidTransitionError,
  listRuns,
  loadProjectConfig,
  loadTaskFile,
  mergeTask,
  type RunLog,
  runTask,
  type RunTaskOptions,
  TaskNotFoundError,
  worktree,
} from "@loop-engineering/core";
import { formatCost, formatDuration, formatTable } from "./format.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CliDeps {
  readonly runClaude?: RunTaskOptions["runClaude"];
}

const USAGE = `Usage:
  loop validate <projectPath>         Validate .loop/config.json and print each role's PROJECT_CONTEXT
  loop run <projectPath> <taskFile>   Run a task through planner, implementer, checks and reviewer
                                      (taskFile: markdown, relative to projectPath)
  loop status <taskId>                Show the state of a task
  loop merge <taskId>                 Merge a task awaiting a human merge into main
  loop cancel <taskId>                Cancel a task and delete its worktree and its loop/<taskId> branch
  loop runs <taskId>                  Show tokens, cost and duration per step of each run

Specs and run logs live in $LOOP_RUNS_DIR/<taskId>/ (loop-engineering's runs/ by default),
never in the target project.
`;

class UsageError extends Error {}

/** Runs the CLI and returns its exit code. */
export async function main(argv: readonly string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (error) {
    return usage(io, error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    io.stdout(USAGE);
    return 0;
  }

  const [command, ...args] = parsed.positionals;
  const runsDir = resolve(io.env["LOOP_RUNS_DIR"] ?? DEFAULT_RUNS_DIR);
  try {
    switch (command) {
      case "validate":
        return await validate(io, single(args, "validate"));
      case "run":
        return await run(io, deps, runsDir, pair(args, "run"));
      case "status":
        return await status(io, runsDir, single(args, "status"));
      case "merge":
        return await merge(io, runsDir, single(args, "merge"));
      case "cancel":
        return await cancel(io, runsDir, single(args, "cancel"));
      case "runs":
        return await runs(io, runsDir, single(args, "runs"));
      default:
        return usage(io, command === undefined ? "missing command" : `unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usage(io, error.message);
    if (error instanceof TaskNotFoundError) {
      io.stderr(`Error: no run found for task ${error.taskId} in ${runsDir}.\n`);
      return 1;
    }
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function validate(io: CliIo, projectArg: string): Promise<number> {
  const projectPath = resolve(projectArg);
  const config = await loadProjectConfig(projectPath);
  const { models, budgets, risk } = config;
  io.stdout(
    [
      `${join(projectPath, CONFIG_PATH)} is valid.`,
      `Check command: ${config.check}`,
      `Main branch:   ${config.mainBranch}`,
      `Models:        planner ${models.planner}, implementer ${models.implementer}, reviewer ${models.reviewer}` +
        (models.pm === undefined ? "" : `, pm ${models.pm} (no pm agent yet)`),
      `Budgets:       ${String(budgets.checkIterations)} check, ${String(budgets.reviewIterations)} review iterations`,
      `Risk:          high ${String(risk.high.length)}, medium ${String(risk.medium.length)}, low ${String(risk.low.length)} globs; ` +
        `low risk up to ${String(risk.maxLowRiskDiffLines)} changed lines`,
      `Signals:       ${config.signals?.map(({ id }) => id).join(", ") ?? "none"} (not used yet)`,
      "",
    ].join("\n"),
  );
  for (const role of AGENT_ROLES) {
    io.stdout(`\n=== ${role} ===\n${buildProjectContext(config, role)}\n`);
  }
  return 0;
}

async function run(
  io: CliIo,
  deps: CliDeps,
  runsDir: string,
  [projectArg, taskFile]: readonly [string, string],
): Promise<number> {
  const projectPath = resolve(projectArg);
  const taskPath = resolve(projectPath, taskFile);
  const { id } = await loadTaskFile(taskPath);
  io.stdout(`Running task ${id} in ${projectPath}…\n`);

  const result = await runTask(projectPath, taskPath, {
    runsDir,
    ...(deps.runClaude !== undefined && { runClaude: deps.runClaude }),
  });
  const { task } = result;
  io.stdout(`Task ${task.id}: ${task.state}${result.error === null ? "" : " (run failed)"}\nRun log: ${result.logPath}\n`);
  if (result.error !== null) {
    io.stderr(`Error: ${result.error}\n`);
    return 1;
  }
  switch (task.state) {
    case "merged":
      return 0;
    case "awaiting_merge":
      io.stdout(
        `Risk class ${task.riskClass}: review ${worktree.worktreePath(projectPath, task.id)}, then run \`loop merge ${task.id}\`.\n`,
      );
      return 0;
    default:
      io.stdout(`Iteration budget exhausted; the task needs a human. Worktree: ${worktree.worktreePath(projectPath, task.id)}\n`);
      return 1;
  }
}

async function status(io: CliIo, runsDir: string, taskId: string): Promise<number> {
  const all = await listRuns(taskId, runsDir);
  const last = all.at(-1);
  if (last === undefined) throw new TaskNotFoundError(taskId);

  const { task, projectPath } = last;
  const worktreeDir = worktree.worktreePath(projectPath, taskId);
  const rows: [string, string][] = [
    ["Task", `${task.id}: ${task.title}`],
    ["Project", projectPath],
    ["State", task.state],
    ["Risk class", task.riskClass],
    [
      "Iterations",
      `checks ${String(task.checkIterations)}/${String(last.config.budgets.checkIterations)}, ` +
        `review ${String(task.reviewIterations)}/${String(last.config.budgets.reviewIterations)}`,
    ],
    ["Spec", task.specPath === "" ? "-" : task.specPath],
    ["Run logs", join(runsDir, taskId)],
    ["Worktree", existsSync(worktreeDir) ? worktreeDir : "-"],
    ["Last run", `${last.runId} (${last.status}, started ${last.startedAt})`],
    ["Runs", String(all.length)],
  ];
  if (last.error !== null) rows.push(["Error", last.error]);
  io.stdout(`${rows.map(([label, value]) => `${`${label}:`.padEnd(12)}${value}`).join("\n")}\n`);
  return 0;
}

async function merge(io: CliIo, runsDir: string, taskId: string): Promise<number> {
  try {
    await mergeTask(taskId, runsDir);
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      io.stderr(`Error: task ${taskId} is ${error.state}, not awaiting_merge.\n`);
      return 1;
    }
    throw error;
  }
  io.stdout(`Task ${taskId} merged into main.\n`);
  return 0;
}

async function cancel(io: CliIo, runsDir: string, taskId: string): Promise<number> {
  let task;
  try {
    task = await cancelTask(taskId, runsDir);
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      io.stderr(`Error: task ${taskId} is ${error.state}, it cannot be cancelled.\n`);
      return 1;
    }
    throw error;
  }
  io.stdout(
    `Task ${taskId} cancelled. Removed worktree ${worktree.worktreePath(task.projectPath, taskId)} ` +
      `and branch ${worktree.branchName(taskId)} if they existed.\n`,
  );
  return 0;
}

async function runs(io: CliIo, runsDir: string, taskId: string): Promise<number> {
  const all = await listRuns(taskId, runsDir);
  if (all.length === 0) throw new TaskNotFoundError(taskId);

  io.stdout(`${all.map(formatRun).join("\n\n")}\n`);
  if (all.length > 1) {
    const cost = all.flatMap((r) => r.steps).reduce((sum, step) => sum + (step.costUsd ?? 0), 0);
    io.stdout(`\nAll ${String(all.length)} runs: ${formatCost(cost)}\n`);
  }
  return 0;
}

function formatRun(run: RunLog): string {
  const dash = (value: number | null, format: (n: number) => string = String): string =>
    value === null ? "-" : format(value);
  const rows = run.steps.map((step, index) => [
    String(index + 1),
    step.role,
    String(step.iteration),
    step.model ?? "-",
    dash(step.usage?.inputTokens ?? null),
    dash(step.usage?.outputTokens ?? null),
    dash(step.usage?.cacheReadInputTokens ?? null),
    dash(step.usage?.cacheCreationInputTokens ?? null),
    dash(step.costUsd, formatCost),
    formatDuration(step.durationMs),
  ]);
  const sum = (pick: (step: RunLog["steps"][number]) => number | null | undefined): number =>
    run.steps.reduce((total, step) => total + (pick(step) ?? 0), 0);
  const footer = [
    "Total",
    "",
    "",
    "",
    String(sum((step) => step.usage?.inputTokens)),
    String(sum((step) => step.usage?.outputTokens)),
    String(sum((step) => step.usage?.cacheReadInputTokens)),
    String(sum((step) => step.usage?.cacheCreationInputTokens)),
    formatCost(sum((step) => step.costUsd)),
    formatDuration(sum((step) => step.durationMs)),
  ];

  const header = `Run ${run.runId}  started ${run.startedAt}  ${run.status}  task ${run.task.state}`;
  const table = formatTable(
    ["Step", "Role", "Iter", "Model", "In", "Out", "Cache R", "Cache W", "Cost", "Duration"],
    rows,
    { rightAlign: [4, 5, 6, 7, 8, 9], footer },
  );
  return [header, ...(run.error === null ? [] : [`Error: ${run.error}`]), table].join("\n");
}

function single(args: readonly string[], command: string): string {
  const [first] = args;
  if (args.length !== 1 || first === undefined) throw new UsageError(`${command} takes exactly one argument`);
  return first;
}

function pair(args: readonly string[], command: string): readonly [string, string] {
  const [first, second] = args;
  if (args.length !== 2 || first === undefined || second === undefined) {
    throw new UsageError(`${command} takes exactly two arguments`);
  }
  return [first, second];
}

function usage(io: CliIo, problem: string): number {
  io.stderr(`loop: ${problem}\n\n${USAGE}`);
  return 1;
}

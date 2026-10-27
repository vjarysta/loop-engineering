import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type AgentRole,
  buildProjectContext,
  CONFIG_PATH,
  InvalidTransitionError,
  listRuns,
  loadProjectConfig,
  loadTaskFile,
  MAX_CHECK_ITERATIONS,
  MAX_REVIEW_ITERATIONS,
  mergeTask,
  type RunLog,
  runTask,
  type RunTaskOptions,
  TaskNotFoundError,
  worktree,
} from "@loop-engineering/core";
import { formatCost, formatDuration, formatTable } from "./format.js";
import { type Env, lookupTask, registerTask } from "./registry.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Env;
}

export interface CliDeps {
  readonly runClaude?: RunTaskOptions["runClaude"];
}

const USAGE = `Usage:
  loop validate <projectPath>             Validate .loop/config.json and print each role's PROJECT_CONTEXT
  loop run <projectPath> <taskFile>       Run a task through planner, implementer, checks and reviewer
  loop status <taskId> [--project <p>]    Show the state of a task
  loop merge <taskId> [--project <p>]     Merge a task awaiting a human merge into main
  loop runs <taskId> [--project <p>]      Show tokens, cost and duration per step of each run

Commands taking a task id find its project from \`loop run\`, or from --project.
`;

const ROLES: readonly AgentRole[] = ["planner", "implementer", "reviewer"];

class UsageError extends Error {}

/** Runs the CLI and returns its exit code. */
export async function main(argv: readonly string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { project: { type: "string" }, help: { type: "boolean", short: "h" } },
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
  const project = parsed.values.project;
  try {
    switch (command) {
      case "validate":
        return await validate(io, single(args, "validate"));
      case "run":
        return await run(io, deps, pair(args, "run"));
      case "status":
        return await status(io, single(args, "status"), project);
      case "merge":
        return await merge(io, single(args, "merge"), project);
      case "runs":
        return await runs(io, single(args, "runs"), project);
      default:
        return usage(io, command === undefined ? "missing command" : `unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) return usage(io, error.message);
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function validate(io: CliIo, projectArg: string): Promise<number> {
  const projectPath = resolve(projectArg);
  const config = await loadProjectConfig(projectPath);
  io.stdout(`${join(projectPath, CONFIG_PATH)} is valid.\nCheck command: ${config.check}\n`);
  for (const role of ROLES) {
    io.stdout(`\n=== ${role} ===\n${buildProjectContext(config, role)}\n`);
  }
  return 0;
}

async function run(io: CliIo, deps: CliDeps, [projectArg, taskFile]: readonly [string, string]): Promise<number> {
  const projectPath = resolve(projectArg);
  const { id } = await loadTaskFile(taskFile);
  await registerTask(io.env, id, projectPath);
  io.stdout(`Running task ${id} in ${projectPath}…\n`);

  const result = await runTask(projectPath, taskFile, deps.runClaude === undefined ? {} : { runClaude: deps.runClaude });
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

async function status(io: CliIo, taskId: string, projectOption: string | undefined): Promise<number> {
  const projectPath = await resolveProject(io, taskId, projectOption);
  const all = await listRuns(projectPath, taskId);
  const last = all.at(-1);
  if (last === undefined) throw new TaskNotFoundError(taskId);

  const { task } = last;
  const worktreeDir = worktree.worktreePath(projectPath, taskId);
  const rows: [string, string][] = [
    ["Task", `${task.id}: ${task.title}`],
    ["Project", projectPath],
    ["State", task.state],
    ["Risk class", task.riskClass],
    [
      "Iterations",
      `checks ${String(task.checkIterations)}/${String(MAX_CHECK_ITERATIONS)}, ` +
        `review ${String(task.reviewIterations)}/${String(MAX_REVIEW_ITERATIONS)}`,
    ],
    ["Spec", task.specPath === "" ? "-" : task.specPath],
    ["Worktree", existsSync(worktreeDir) ? worktreeDir : "-"],
    ["Last run", `${last.runId} (${last.status}, started ${last.startedAt})`],
    ["Runs", String(all.length)],
  ];
  if (last.error !== null) rows.push(["Error", last.error]);
  io.stdout(`${rows.map(([label, value]) => `${`${label}:`.padEnd(12)}${value}`).join("\n")}\n`);
  return 0;
}

async function merge(io: CliIo, taskId: string, projectOption: string | undefined): Promise<number> {
  const projectPath = await resolveProject(io, taskId, projectOption);
  try {
    await mergeTask(projectPath, taskId);
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

async function runs(io: CliIo, taskId: string, projectOption: string | undefined): Promise<number> {
  const projectPath = await resolveProject(io, taskId, projectOption);
  const all = await listRuns(projectPath, taskId);
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

async function resolveProject(io: CliIo, taskId: string, projectOption: string | undefined): Promise<string> {
  if (projectOption !== undefined) return resolve(projectOption);
  const registered = await lookupTask(io.env, taskId);
  if (registered === null) {
    throw new Error(`unknown task ${taskId}: run it with \`loop run\` first, or pass --project <projectPath>.`);
  }
  return registered;
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

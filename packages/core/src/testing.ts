// Test fixtures shared by core and cli tests: a throwaway git project and a scripted runClaude.
// Exposed as `@loop-engineering/core/testing`; never used at runtime.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { AgentRole } from "./project-config.js";
import type { RunClaudeOptions, RunClaudeResult } from "./run-claude.js";

export const FIXTURE_TASK_ID = "task-1";
export const FIXTURE_CHECK = "grep -q good feature.txt || { echo 'feature.txt must contain good'; exit 1; }";
const PRD = "# PRD\n## Feature\nfeature.txt says good.\n## Other\nUnrelated requirement.\n";

/**
 * Fixture .loop/config.json in the reference format. Every file is low risk (`low: ["**"]`) so a task
 * merges unless a test raises the risk through `risk.high`, `risk.medium` or `risk.maxLowRiskDiffLines`.
 */
export const FIXTURE_CONFIG = {
  check: FIXTURE_CHECK,
  mainBranch: "main",
  models: { planner: "opus", implementer: "sonnet", reviewer: "haiku" },
  budgets: { checkIterations: 3, reviewIterations: 2 },
  risk: { high: [], medium: [], low: ["**"], maxLowRiskDiffLines: 1000 },
  agents: {
    sourcesOfTruth: ["docs/PRD.md"],
    protectedPaths: ["secrets/**"],
    extraInstructions: {},
  },
} as const;

type Json = Readonly<Record<string, unknown>>;

/** `override` merged into `base`, plain objects recursively; arrays and other values replace. */
function deepMerge(base: Json, override: Json): Json {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

/** Removes every directory created by these fixtures. Call it from afterAll. */
export function cleanupFixtures(): void {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Isolates git from the developer's config (signing, hooks, default branch…). Call it from beforeAll. */
export function isolateGitEnv(): void {
  const globalConfig = join(makeTmpDir("git-config-"), "gitconfig");
  writeFileSync(globalConfig, "");
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
  process.env["GIT_AUTHOR_NAME"] = "Test";
  process.env["GIT_AUTHOR_EMAIL"] = "test@example.com";
  process.env["GIT_COMMITTER_NAME"] = "Test";
  process.env["GIT_COMMITTER_EMAIL"] = "test@example.com";
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function writeFile(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export interface FixtureProject {
  readonly project: string;
  readonly taskFile: string;
  /** Empty runs directory, standing in for loop-engineering's runs/. */
  readonly runsDir: string;
}

/**
 * A git project on main with `.loop/config.json`, `docs/PRD.md` and `feature.txt` ("todo"), a task file
 * for FIXTURE_TASK_ID and an empty runs directory. The check passes once feature.txt contains "good".
 */
export function makeFixtureProject(config: Readonly<Record<string, unknown>> = {}): FixtureProject {
  const parent = makeTmpDir("loop-fixture-");
  const project = join(parent, "project");
  mkdirSync(project);
  const merged = deepMerge(FIXTURE_CONFIG, config);
  git(project, "init", "-q", "-b", typeof merged["mainBranch"] === "string" ? merged["mainBranch"] : "main");
  writeFile(project, ".loop/config.json", JSON.stringify(merged));
  writeFile(project, "docs/PRD.md", PRD);
  writeFile(project, "feature.txt", "todo\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "initial");

  const taskFile = join(parent, "task.md");
  writeFileSync(taskFile, `# ${FIXTURE_TASK_ID} — Say good\n\n## Objectif\nImplement docs/PRD.md#feature.\n`);
  const runsDir = join(parent, "runs");
  mkdirSync(runsDir);
  return { project, taskFile, runsDir };
}

/** Every file under `dir` mapped to its mtime and content; empty when `dir` does not exist. */
export function snapshotTree(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const snapshot: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else snapshot[relative(dir, path)] = `${String(statSync(path).mtimeMs)}:${readFileSync(path, "utf8")}`;
    }
  };
  walk(dir);
  return snapshot;
}

export interface ScriptStep {
  readonly role: AgentRole;
  /** Side effect of the agent (writing the spec, editing files in its cwd…). */
  readonly act?: (cwd: string, options: RunClaudeOptions) => void;
  readonly output: string | ((options: RunClaudeOptions) => string);
}

export interface ScriptedCall {
  readonly role: AgentRole;
  readonly options: RunClaudeOptions;
}

export interface ScriptedClaude {
  readonly runClaude: (options: RunClaudeOptions, role: AgentRole) => Promise<RunClaudeResult>;
  readonly calls: ScriptedCall[];
}

/** A runClaude replacement that plays `steps` in order and rejects any call out of script. */
export function scriptedClaude(steps: readonly ScriptStep[]): ScriptedClaude {
  const queue = [...steps];
  const calls: ScriptedCall[] = [];
  return {
    calls,
    runClaude: (options, role) => {
      calls.push({ role, options });
      const step = queue.shift();
      if (step?.role !== role) {
        return Promise.reject(new Error(`unexpected ${role} call, script expected ${step?.role ?? "nothing"}`));
      }
      step.act?.(options.cwd, options);
      const output = typeof step.output === "string" ? step.output : step.output(options);
      return Promise.resolve({
        resultText: output,
        usage: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 },
        costUsd: 0.01,
        durationMs: 100,
        sessionId: `session-${String(calls.length)}`,
        numTurns: 2,
        permissionDenials: 0,
        raw: { result: output },
      });
    },
  };
}

export const FIXTURE_SPEC = "# Spec\nCites docs/PRD.md#feature.\n## Test plan\n- check: feature.txt contains good\n";

/** The absolute spec path the orchestrator gives the planner in its prompt. */
export function specPathFromPrompt(options: RunClaudeOptions): string {
  const match = /^Spec path: (.+)$/m.exec(options.prompt);
  if (match?.[1] === undefined) throw new Error("planner prompt has no 'Spec path:' line");
  return match[1];
}

/** Writes FIXTURE_SPEC where it is told to and reports it with `riskClass` and `notes`. */
export function plannerStep(riskClass = "low", notes = ""): ScriptStep {
  return {
    role: "planner",
    act: (_cwd, options) => {
      const specPath = specPathFromPrompt(options);
      mkdirSync(dirname(specPath), { recursive: true });
      writeFileSync(specPath, FIXTURE_SPEC);
    },
    output: (options) =>
      "Spec written.\n```json\n" +
      JSON.stringify({ specPath: specPathFromPrompt(options), riskClass, impactedFiles: ["feature.txt"], notes }) +
      "\n```",
  };
}

/** Writes each file (null deletes it) in the worktree. */
export function implementerStep(files: Readonly<Record<string, string | null>>): ScriptStep {
  return {
    role: "implementer",
    act: (cwd) => {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) rmSync(join(cwd, path));
        else writeFile(cwd, path, content);
      }
    },
    output: "Done.",
  };
}

export const goodImplementerStep = implementerStep({ "feature.txt": "good\n" });
export const badImplementerStep = implementerStep({ "feature.txt": "bad\n" });
export const approveStep: ScriptStep = { role: "reviewer", output: JSON.stringify({ verdict: "approve", issues: [] }) };
export const changesStep: ScriptStep = {
  role: "reviewer",
  output: JSON.stringify({
    verdict: "changes",
    issues: [{ file: "feature.txt", line: 1, severity: "major", message: "Say it louder" }],
  }),
};

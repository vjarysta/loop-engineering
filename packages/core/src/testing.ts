// Test fixtures shared by core and cli tests: a throwaway git project and a scripted runClaude.
// Exposed as `@loop-engineering/core/testing`; never used at runtime.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRole } from "./project-config.js";
import type { RunClaudeOptions, RunClaudeResult } from "./run-claude.js";

export const FIXTURE_TASK_ID = "task-1";
export const FIXTURE_SPEC_PATH = `.loop/specs/${FIXTURE_TASK_ID}.md`;
export const FIXTURE_CHECK = "grep -q good feature.txt || { echo 'feature.txt must contain good'; exit 1; }";
const PRD = "# PRD\n## Feature\nfeature.txt says good.\n## Other\nUnrelated requirement.\n";

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
}

/**
 * A git project on main with `.loop/config.json`, `docs/PRD.md` and `feature.txt` ("todo"), plus a task
 * file for FIXTURE_TASK_ID. The check passes once feature.txt contains "good".
 */
export function makeFixtureProject(config: Readonly<Record<string, unknown>> = {}): FixtureProject {
  const parent = makeTmpDir("loop-fixture-");
  const project = join(parent, "project");
  mkdirSync(project);
  git(project, "init", "-q", "-b", "main");
  writeFile(
    project,
    ".loop/config.json",
    JSON.stringify({
      check: FIXTURE_CHECK,
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
    JSON.stringify({ id: FIXTURE_TASK_ID, title: "Say good", description: "Implement docs/PRD.md#feature." }),
  );
  return { project, taskFile };
}

export interface ScriptStep {
  readonly role: AgentRole;
  /** Side effect in the agent's cwd (writing the spec, editing files…). */
  readonly act?: (cwd: string) => void;
  readonly output: string;
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

export function plannerStep(riskClass = "low"): ScriptStep {
  return {
    role: "planner",
    act: (cwd) => {
      writeFile(cwd, FIXTURE_SPEC_PATH, "# Spec\nCites docs/PRD.md#feature.\n## Test plan\n- check: feature.txt contains good\n");
    },
    output:
      "Spec written.\n```json\n" +
      JSON.stringify({ specPath: FIXTURE_SPEC_PATH, riskClass, impactedFiles: ["feature.txt"], notes: "" }) +
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

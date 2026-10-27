import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type ScriptStep,
  scriptedClaude,
  writeFile,
} from "@loop-engineering/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "./cli.js";

beforeAll(isolateGitEnv);

const loopHomes: string[] = [];

afterAll(() => {
  cleanupFixtures();
  for (const dir of loopHomes) rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A CLI with its own LOOP_HOME, so the task registry never leaks between tests. */
function makeCli(): { readonly loopHome: string; readonly run: (argv: string[], script?: ScriptStep[]) => Promise<Outcome> } {
  const loopHome = mkdtempSync(join(tmpdir(), "loop-home-"));
  loopHomes.push(loopHome);
  return {
    loopHome,
    run: async (argv, script = []) => {
      let stdout = "";
      let stderr = "";
      const code = await main(
        argv,
        { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text), env: { LOOP_HOME: loopHome } },
        { runClaude: scriptedClaude(script).runClaude },
      );
      return { code, stdout, stderr };
    },
  };
}

const HAPPY_PATH = [plannerStep(), goodImplementerStep, approveStep];
const HIGH_RISK_PATH = [
  plannerStep(),
  implementerStep({ "feature.txt": "good\n", "src/auth/session.ts": "export {};\n" }),
  approveStep,
];
const HIGH_RISK_CONFIG = { risk: { paths: [{ pattern: "src/auth/**", class: "high" }] } };

describe("loop validate", () => {
  it("prints the PROJECT_CONTEXT of every role for a valid config", async () => {
    const { project } = makeFixtureProject({ agents: { reviewer: { extraInstructions: "Be strict." } } });

    const { code, stdout } = await makeCli().run(["validate", project]);

    expect(code).toBe(0);
    expect(stdout).toContain(`${join(project, ".loop", "config.json")} is valid`);
    expect(stdout).toContain("=== planner ===\n<PROJECT_CONTEXT>");
    expect(stdout).toContain("=== implementer ===\n<PROJECT_CONTEXT>");
    expect(stdout).toContain("=== reviewer ===\n<PROJECT_CONTEXT>");
    expect(stdout).toContain("Project instructions for the reviewer:\nBe strict.");
  });

  it("fails on an invalid config, naming the offending field", async () => {
    const { project } = makeFixtureProject({ protectedPaths: [42] });

    const { code, stderr } = await makeCli().run(["validate", project]);

    expect(code).toBe(1);
    expect(stderr).toContain("protectedPaths");
  });
});

describe("loop run", () => {
  it("runs the task, registers it and exits 0 once merged", async () => {
    const { project, taskFile } = makeFixtureProject();
    const cli = makeCli();

    const { code, stdout } = await cli.run(["run", project, taskFile], HAPPY_PATH);

    expect(code).toBe(0);
    expect(stdout).toContain(`Task ${FIXTURE_TASK_ID}: merged`);
    expect(stdout).toMatch(new RegExp(`Run log: ${join(project, ".loop", "runs", FIXTURE_TASK_ID)}/.+\\.json`));
    expect(JSON.parse(readFileSync(join(cli.loopHome, "tasks.json"), "utf8"))).toEqual({ [FIXTURE_TASK_ID]: project });
  });

  it("exits 0 and points to loop merge when the task awaits a human merge", async () => {
    const { project, taskFile } = makeFixtureProject(HIGH_RISK_CONFIG);

    const { code, stdout } = await makeCli().run(["run", project, taskFile], HIGH_RISK_PATH);

    expect(code).toBe(0);
    expect(stdout).toContain(`Task ${FIXTURE_TASK_ID}: awaiting_merge`);
    expect(stdout).toContain(`loop merge ${FIXTURE_TASK_ID}`);
  });

  it("exits 1 when the task is escalated", async () => {
    const { project, taskFile } = makeFixtureProject();
    const script = [plannerStep(), badImplementerStep, badImplementerStep, badImplementerStep, badImplementerStep];

    const { code, stdout } = await makeCli().run(["run", project, taskFile], script);

    expect(code).toBe(1);
    expect(stdout).toContain(`Task ${FIXTURE_TASK_ID}: escalated`);
  });

  it("exits 1 and prints the error when the run fails", async () => {
    const { project, taskFile } = makeFixtureProject();

    const { code, stderr } = await makeCli().run(["run", project, taskFile], [{ role: "planner", output: "nope" }]);

    expect(code).toBe(1);
    expect(stderr).toContain("Invalid planner output");
  });
});

describe("loop status", () => {
  it("shows the state of a registered task", async () => {
    const { project, taskFile } = makeFixtureProject(HIGH_RISK_CONFIG);
    const cli = makeCli();
    await cli.run(["run", project, taskFile], HIGH_RISK_PATH);

    const { code, stdout } = await cli.run(["status", FIXTURE_TASK_ID]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/State:\s+awaiting_merge/);
    expect(stdout).toMatch(/Risk class:\s+high/);
    expect(stdout).toMatch(/Iterations:\s+checks 0\/3, review 0\/2/);
    expect(stdout).toMatch(new RegExp(`Project:\\s+${project}`));
  });

  it("finds the task with --project when it is not registered", async () => {
    const { project, taskFile } = makeFixtureProject();
    await makeCli().run(["run", project, taskFile], HAPPY_PATH);

    const { code, stdout } = await makeCli().run(["status", FIXTURE_TASK_ID, "--project", project]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/State:\s+merged/);
  });

  it("fails with a hint for an unknown task", async () => {
    const { code, stderr } = await makeCli().run(["status", "nope"]);

    expect(code).toBe(1);
    expect(stderr).toContain("--project");
  });
});

describe("loop merge", () => {
  it("merges an awaiting_merge task", async () => {
    const { project, taskFile } = makeFixtureProject(HIGH_RISK_CONFIG);
    const cli = makeCli();
    await cli.run(["run", project, taskFile], HIGH_RISK_PATH);

    const { code, stdout } = await cli.run(["merge", FIXTURE_TASK_ID]);

    expect(code).toBe(0);
    expect(stdout).toContain(`Task ${FIXTURE_TASK_ID} merged into main`);
    expect(readFileSync(join(project, "src", "auth", "session.ts"), "utf8")).toBe("export {};\n");
    expect((await cli.run(["status", FIXTURE_TASK_ID])).stdout).toMatch(/State:\s+merged/);
  });

  it("refuses a task that is not awaiting merge", async () => {
    const { project, taskFile } = makeFixtureProject();
    const cli = makeCli();
    await cli.run(["run", project, taskFile], HAPPY_PATH);

    const { code, stderr } = await cli.run(["merge", FIXTURE_TASK_ID]);

    expect(code).toBe(1);
    expect(stderr).toContain("merged");
  });

  it("reports conflicting files", async () => {
    const { project, taskFile } = makeFixtureProject(HIGH_RISK_CONFIG);
    const cli = makeCli();
    await cli.run(["run", project, taskFile], HIGH_RISK_PATH);
    writeFile(project, "feature.txt", "changed on main\n");
    git(project, "commit", "-q", "-am", "conflicting change");

    const { code, stderr } = await cli.run(["merge", FIXTURE_TASK_ID]);

    expect(code).toBe(1);
    expect(stderr).toContain("feature.txt");
  });
});

describe("loop runs", () => {
  it("prints tokens, cost and duration per step with totals", async () => {
    const { project, taskFile } = makeFixtureProject();
    const cli = makeCli();
    await cli.run(["run", project, taskFile], HAPPY_PATH);

    const { code, stdout } = await cli.run(["runs", FIXTURE_TASK_ID]);

    expect(code).toBe(0);
    const lines = stdout.split("\n");
    expect(lines.find((line) => line.startsWith("Step"))?.split(/\s{2,}/)).toEqual([
      "Step",
      "Role",
      "Iter",
      "Model",
      "In",
      "Out",
      "Cache R",
      "Cache W",
      "Cost",
      "Duration",
    ]);
    expect(lines.find((line) => line.startsWith("2 "))?.split(/\s{2,}/)).toEqual([
      "2",
      "implementer",
      "1",
      "sonnet",
      "10",
      "20",
      "40",
      "30",
      "$0.0100",
      "100ms",
    ]);
    expect(lines.find((line) => line.startsWith("3 "))?.split(/\s{2,}/).slice(0, 9)).toEqual([
      "3",
      "check",
      "1",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]);
    expect(lines.find((line) => line.startsWith("Total"))?.split(/\s{2,}/).slice(0, 7)).toEqual([
      "Total",
      "30",
      "60",
      "120",
      "90",
      "$0.0300",
      expect.stringMatching(/ms|s$/),
    ]);
  });

  it("fails for a task without runs", async () => {
    const { project } = makeFixtureProject();

    const { code, stderr } = await makeCli().run(["runs", FIXTURE_TASK_ID, "--project", project]);

    expect(code).toBe(1);
    expect(stderr).toContain(FIXTURE_TASK_ID);
  });
});

describe("usage", () => {
  it("prints usage and exits 0 on --help", async () => {
    const { code, stdout } = await makeCli().run(["--help"]);

    expect(code).toBe(0);
    expect(stdout).toContain("loop run <projectPath> <taskFile>");
  });

  it.each([[[]], [["frobnicate"]], [["run", "only-one-arg"]], [["status", "t", "--bogus"]]])(
    "prints usage and exits 1 for %j",
    async (argv) => {
      const { code, stderr } = await makeCli().run(argv);

      expect(code).toBe(1);
      expect(stderr).toContain("Usage:");
    },
  );
});

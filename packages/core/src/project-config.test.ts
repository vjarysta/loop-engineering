import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildProjectContext,
  loadProjectConfig,
  parseProjectConfig,
  ProjectConfigError,
  type ProjectConfig,
} from "./project-config.js";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "project-config-"));
  tmpDirs.push(dir);
  if (config !== undefined) {
    mkdirSync(join(dir, ".loop"));
    writeFileSync(join(dir, ".loop", "config.json"), config);
  }
  return dir;
}

/** The reference format of .loop/config.json. */
const FULL_CONFIG = {
  check: "pnpm check",
  mainBranch: "trunk",
  models: { planner: "opus", implementer: "sonnet", reviewer: "opus", pm: "haiku" },
  budgets: { checkIterations: 3, reviewIterations: 2 },
  risk: {
    high: ["src/engine/save/**", "docs/PRD.md", ".loop/**"],
    medium: ["src/engine/**"],
    low: ["src/ui/**", "docs/**"],
    maxLowRiskDiffLines: 400,
  },
  agents: {
    sourcesOfTruth: ["docs/PRD.md", "docs/API.md"],
    protectedPaths: ["docs/PRD.md", ".loop/**"],
    extraInstructions: {
      planner: "Prefer small tasks.",
      implementer: "Constants go to src/engine/balance.ts.",
      reviewer: "Recompute one PRD example.",
      pm: "Group tasks by milestone.",
    },
  },
  signals: [{ id: "tests", label: "Unit tests", command: "pnpm test" }],
};

type Json = Record<string, unknown>;

/** FULL_CONFIG with `path` (dot-separated) replaced by `value`, or removed when value is undefined. */
function withField(path: string, value: unknown): Json {
  const copy = structuredClone(FULL_CONFIG) as Json;
  const keys = path.split(".");
  const last = keys.pop() ?? "";
  let target = copy;
  for (const key of keys) target = target[key] as Json;
  if (value === undefined) Reflect.deleteProperty(target, last);
  else target[last] = value;
  return copy;
}

describe("parseProjectConfig", () => {
  it("accepts the reference format", () => {
    expect(parseProjectConfig(FULL_CONFIG)).toEqual(FULL_CONFIG);
  });

  it("defaults mainBranch to main and leaves pm, extra instructions and signals optional", () => {
    const minimal = {
      ...withField("mainBranch", undefined),
      models: { planner: "opus", implementer: "opus", reviewer: "opus" },
      agents: { sourcesOfTruth: [], protectedPaths: [], extraInstructions: {} },
    };
    Reflect.deleteProperty(minimal, "signals");

    expect(parseProjectConfig(minimal)).toEqual({ ...minimal, mainBranch: "main" });
  });

  it.each([
    ["check", "a missing check command", undefined],
    ["check", "an empty check command", ""],
    ["mainBranch", "an empty main branch", ""],
    ["models", "missing models", undefined],
    ["models.reviewer", "a missing reviewer model", undefined],
    ["models.planner", "an unknown model", "gpt-4"],
    ["models.pm", "an unknown pm model", "fable"],
    ["budgets", "missing budgets", undefined],
    ["budgets.checkIterations", "a zero check budget", 0],
    ["budgets.reviewIterations", "a non-integer review budget", 1.5],
    ["risk.high", "a missing high list", undefined],
    ["risk.low", "an absolute glob", ["/src/**"]],
    ["risk.medium", "a glob escaping the project", ["../other/**"]],
    ["risk.maxLowRiskDiffLines", "a negative diff limit", -1],
    ["risk.maxLowRiskDiffLines", "a missing diff limit", undefined],
    ["agents.sourcesOfTruth", "a non-string source of truth", [{ path: "docs/PRD.md" }]],
    ["agents.protectedPaths", "an empty protected path", [""]],
    ["agents.extraInstructions", "missing extra instructions", undefined],
    ["agents.extraInstructions.tester", "instructions for an unknown role", "x"],
    ["agents.model", "an unknown key under agents", "opus"],
    ["signals", "a signal without command", [{ id: "tests", label: "Tests" }]],
    ["signals", "duplicate signal ids", [
      { id: "tests", label: "A", command: "a" },
      { id: "tests", label: "B", command: "b" },
    ]],
    ["sourcesOfTruth", "the former top-level sourcesOfTruth", ["docs/PRD.md"]],
  ])("rejects %s: %s", (path, _label, value) => {
    expect(() => parseProjectConfig(withField(path, value))).toThrow(ProjectConfigError);
  });

  it("names the offending field in the error", () => {
    expect(() => parseProjectConfig(withField("models.planner", "gpt-4"))).toThrow(/models\.planner/);
    expect(() => parseProjectConfig(withField("budgets.checkIterations", 0))).toThrow(/budgets\.checkIterations/);
  });

  it("rejects a non-object config", () => {
    expect(() => parseProjectConfig([])).toThrow(ProjectConfigError);
  });
});

describe("loadProjectConfig", () => {
  it("reads and validates .loop/config.json", async () => {
    const project = makeProject(JSON.stringify(FULL_CONFIG));

    expect(await loadProjectConfig(project)).toEqual(FULL_CONFIG);
  });

  it("rejects a missing config file", async () => {
    await expect(loadProjectConfig(makeProject())).rejects.toThrow(ProjectConfigError);
  });

  it("rejects invalid JSON", async () => {
    await expect(loadProjectConfig(makeProject("{ not json"))).rejects.toThrow(ProjectConfigError);
  });

  it("rejects a config that fails validation, naming the offending field", async () => {
    const project = makeProject(JSON.stringify(withField("agents.protectedPaths", [42])));

    await expect(loadProjectConfig(project)).rejects.toThrow(/agents\.protectedPaths/);
  });
});

describe("buildProjectContext", () => {
  const config: ProjectConfig = parseProjectConfig(FULL_CONFIG);

  it("builds the planner context with its own instructions only", () => {
    expect(buildProjectContext(config, "planner")).toBe(
      [
        "<PROJECT_CONTEXT>",
        "Sources of truth (read only the sections the task cites):",
        "- docs/PRD.md",
        "- docs/API.md",
        "",
        "Protected paths (never modify):",
        "- docs/PRD.md",
        "- .loop/**",
        "",
        "Project instructions for the planner:",
        "Prefer small tasks.",
        "</PROJECT_CONTEXT>",
      ].join("\n"),
    );
  });

  it("builds the reviewer context with the reviewer instructions", () => {
    const context = buildProjectContext(config, "reviewer");

    expect(context).toContain("Project instructions for the reviewer:\nRecompute one PRD example.");
    expect(context).not.toContain("Prefer small tasks.");
  });

  it("says none for empty sections instead of omitting them", () => {
    const empty = parseProjectConfig(
      withField("agents", { sourcesOfTruth: [], protectedPaths: [], extraInstructions: {} }),
    );

    expect(buildProjectContext(empty, "implementer")).toBe(
      [
        "<PROJECT_CONTEXT>",
        "Sources of truth (read only the sections the task cites):",
        "- none",
        "",
        "Protected paths (never modify):",
        "- none",
        "",
        "Project instructions for the implementer:",
        "- none",
        "</PROJECT_CONTEXT>",
      ].join("\n"),
    );
  });
});

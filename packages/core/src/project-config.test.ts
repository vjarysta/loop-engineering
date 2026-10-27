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

const FULL_CONFIG = {
  check: "pnpm test && pnpm lint",
  checkTimeoutMs: 600_000,
  risk: {
    paths: [{ pattern: "src/auth/**", class: "high" }],
    diffLines: { medium: 200, high: 800 },
  },
  sourcesOfTruth: [{ path: "docs/PRD.md", description: "Product requirements" }, { path: "docs/API.md" }],
  protectedPaths: ["migrations/**", ".github/workflows/**"],
  agents: {
    planner: { model: "opus", extraInstructions: "Prefer small tasks." },
    implementer: { model: "sonnet", allowedTools: ["Read", "Edit", "Bash(pnpm *)"], timeoutMs: 1_800_000 },
    reviewer: { extraInstructions: "Reject any new dependency." },
  },
};

describe("parseProjectConfig", () => {
  it("accepts a full config", () => {
    expect(parseProjectConfig(FULL_CONFIG)).toEqual(FULL_CONFIG);
  });

  it("accepts a single diff threshold", () => {
    expect(parseProjectConfig({ check: "make check", risk: { diffLines: { high: 100 } } }).risk).toEqual({
      paths: [],
      diffLines: { high: 100 },
    });
  });

  it("defaults every optional section of a minimal config", () => {
    expect(parseProjectConfig({ check: "make check" })).toEqual({
      check: "make check",
      risk: { paths: [] },
      sourcesOfTruth: [],
      protectedPaths: [],
      agents: {},
    });
  });

  it.each([
    ["a missing check command", { check: undefined }],
    ["an empty check command", { check: "" }],
    ["a non-positive check timeout", { checkTimeoutMs: 0 }],
    ["an unknown top-level key", { sourceOfTruth: [] }],
    ["an unknown agent role", { agents: { tester: {} } }],
    ["an unknown agent key", { agents: { planner: { prompt: "x" } } }],
    ["an absolute source of truth path", { sourcesOfTruth: [{ path: "/etc/PRD.md" }] }],
    ["a source of truth escaping the project", { sourcesOfTruth: [{ path: "../PRD.md" }] }],
    ["an empty protected path", { protectedPaths: [""] }],
    ["an absolute protected path", { protectedPaths: ["/src"] }],
    ["a non-positive timeout", { agents: { implementer: { timeoutMs: 0 } } }],
    ["a non-integer timeout", { agents: { implementer: { timeoutMs: 1.5 } } }],
    ["an unknown risk class", { risk: { paths: [{ pattern: "src/**", class: "critical" }] } }],
    ["a high diff threshold below the medium one", { risk: { diffLines: { medium: 500, high: 100 } } }],
  ])("rejects %s", (_label, input) => {
    expect(() => parseProjectConfig({ check: "make check", ...input })).toThrow(ProjectConfigError);
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
    const project = makeProject(JSON.stringify({ protectedPaths: [42] }));

    await expect(loadProjectConfig(project)).rejects.toThrow(/protectedPaths/);
  });
});

describe("buildProjectContext", () => {
  const config: ProjectConfig = parseProjectConfig(FULL_CONFIG);

  it("builds the planner context with its own instructions only", () => {
    expect(buildProjectContext(config, "planner")).toBe(
      [
        "<PROJECT_CONTEXT>",
        "Sources of truth (read only the sections the task cites):",
        "- docs/PRD.md: Product requirements",
        "- docs/API.md",
        "",
        "Protected paths (never modify):",
        "- migrations/**",
        "- .github/workflows/**",
        "",
        "Project instructions for the planner:",
        "Prefer small tasks.",
        "</PROJECT_CONTEXT>",
      ].join("\n"),
    );
  });

  it("builds the reviewer context with the reviewer instructions", () => {
    const context = buildProjectContext(config, "reviewer");

    expect(context).toContain("Project instructions for the reviewer:\nReject any new dependency.");
    expect(context).not.toContain("Prefer small tasks.");
  });

  it("says none for empty sections instead of omitting them", () => {
    expect(buildProjectContext(parseProjectConfig({ check: "make check" }), "implementer")).toBe(
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

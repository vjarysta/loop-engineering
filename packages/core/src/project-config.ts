import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const CONFIG_PATH = join(".loop", "config.json");

const projectRelativePath = z
  .string()
  .min(1)
  .refine((path) => !isAbsolute(path), "must be relative to the project root")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must stay inside the project");

const AgentConfigSchema = z.strictObject({
  model: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  timeoutMs: z.int().positive().optional(),
  extraInstructions: z.string().optional(),
});

const RiskClassSchema = z.enum(["low", "medium", "high"]);

const RiskRulesSchema = z.strictObject({
  /** A changed file matching `pattern` raises the risk class to at least `class`. */
  paths: z.array(z.strictObject({ pattern: projectRelativePath, class: RiskClassSchema })).default([]),
  /** A diff with at least this many added + removed lines raises the risk class to the given level. */
  diffLines: z
    .strictObject({ medium: z.int().positive().optional(), high: z.int().positive().optional() })
    .refine(
      ({ medium, high }) => medium === undefined || high === undefined || medium <= high,
      "medium threshold must not exceed high threshold",
    )
    .optional(),
});

export const ProjectConfigSchema = z.strictObject({
  /** Shell command run by the orchestrator in the worktree; exit code 0 means the checks pass. */
  check: z.string().min(1),
  checkTimeoutMs: z.int().positive().optional(),
  risk: RiskRulesSchema.default({ paths: [] }),
  sourcesOfTruth: z
    .array(z.strictObject({ path: projectRelativePath, description: z.string().optional() }))
    .default([]),
  protectedPaths: z.array(projectRelativePath).default([]),
  agents: z
    .strictObject({
      planner: AgentConfigSchema.optional(),
      implementer: AgentConfigSchema.optional(),
      reviewer: AgentConfigSchema.optional(),
    })
    .default({}),
});

export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
export type AgentConfig = z.output<typeof AgentConfigSchema>;
export type RiskRules = z.output<typeof RiskRulesSchema>;
export type AgentRole = keyof ProjectConfig["agents"];

export class ProjectConfigError extends Error {
  override readonly name = "ProjectConfigError";
}

export function parseProjectConfig(input: unknown): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ProjectConfigError(`Invalid project config:\n${z.prettifyError(result.error)}`, {
      cause: result.error,
    });
  }
  return result.data;
}

export async function loadProjectConfig(projectPath: string): Promise<ProjectConfig> {
  const path = join(projectPath, CONFIG_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ProjectConfigError(`Cannot read ${path}`, { cause });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ProjectConfigError(`${path} is not valid JSON`, { cause });
  }
  return parseProjectConfig(json);
}

/** The PROJECT_CONTEXT block given to an agent: shared project rules plus that role's instructions. */
export function buildProjectContext(config: ProjectConfig, role: AgentRole): string {
  const sources = config.sourcesOfTruth.map(({ path, description }) =>
    description === undefined ? `- ${path}` : `- ${path}: ${description}`,
  );
  const protectedPaths = config.protectedPaths.map((path) => `- ${path}`);
  const instructions = config.agents[role]?.extraInstructions?.trim() ?? "";

  return [
    "<PROJECT_CONTEXT>",
    "Sources of truth (read only the sections the task cites):",
    ...orNone(sources),
    "",
    "Protected paths (never modify):",
    ...orNone(protectedPaths),
    "",
    `Project instructions for the ${role}:`,
    instructions === "" ? "- none" : instructions,
    "</PROJECT_CONTEXT>",
  ].join("\n");
}

function orNone(lines: readonly string[]): readonly string[] {
  return lines.length > 0 ? lines : ["- none"];
}

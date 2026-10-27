import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const CONFIG_PATH = join(".loop", "config.json");

const projectRelativePath = z
  .string()
  .min(1, "must not be empty")
  .refine((path) => !isAbsolute(path), "must be relative to the project root")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must stay inside the project");

/** A glob relative to the project root, matched with path.matchesGlob. */
const glob = projectRelativePath;

const ModelSchema = z.enum(["opus", "sonnet", "haiku"], { error: 'must be "opus", "sonnet" or "haiku"' });

const budget = z.int("must be an integer").min(1, "must be at least 1");

const RiskRulesSchema = z.strictObject({
  /** A changed file matching one of these makes the change high risk. */
  high: z.array(glob),
  /** …medium risk, unless it also matches a high glob. */
  medium: z.array(glob),
  /** …low risk, unless it also matches a medium or high glob. A file matching no list counts as medium. */
  low: z.array(glob),
  /** A low-risk change with more added + removed lines than this counts as medium. */
  maxLowRiskDiffLines: z.int("must be an integer").min(0, "must be at least 0"),
});

export const AGENT_ROLES = ["planner", "implementer", "reviewer"] as const;

export const ProjectConfigSchema = z.strictObject({
  /** Shell command run by the orchestrator in the worktree; exit code 0 means the checks pass. */
  check: z.string().min(1, "must be a non-empty shell command"),
  mainBranch: z
    .string()
    .regex(/^[^-\s][^\s]*$/, "must be a branch name (no spaces, not starting with -)")
    .default("main"),
  models: z.strictObject({
    planner: ModelSchema,
    implementer: ModelSchema,
    reviewer: ModelSchema,
    pm: ModelSchema.optional(),
  }),
  budgets: z.strictObject({ checkIterations: budget, reviewIterations: budget }),
  risk: RiskRulesSchema,
  agents: z.strictObject({
    sourcesOfTruth: z.array(projectRelativePath),
    protectedPaths: z.array(glob),
    extraInstructions: z.strictObject({
      planner: z.string().optional(),
      implementer: z.string().optional(),
      reviewer: z.string().optional(),
      pm: z.string().optional(),
    }),
  }),
  signals: z
    .array(
      z.strictObject({
        id: z.string().min(1, "must not be empty"),
        label: z.string().min(1, "must not be empty"),
        command: z.string().min(1, "must be a non-empty shell command"),
      }),
    )
    .refine((signals) => new Set(signals.map(({ id }) => id)).size === signals.length, "signal ids must be unique")
    .optional(),
});

export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
export type RiskRules = z.output<typeof RiskRulesSchema>;
export type Budgets = ProjectConfig["budgets"];
/** The roles run by the orchestrator. `pm` is accepted in the config but has no agent yet. */
export type AgentRole = (typeof AGENT_ROLES)[number];

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
  const sources = config.agents.sourcesOfTruth.map((path) => `- ${path}`);
  const protectedPaths = config.agents.protectedPaths.map((path) => `- ${path}`);
  const instructions = config.agents.extraInstructions[role]?.trim() ?? "";

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

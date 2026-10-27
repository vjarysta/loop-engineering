import { z } from "zod";

export class AgentOutputError extends Error {
  override readonly name = "AgentOutputError";

  constructor(
    readonly role: "planner" | "reviewer",
    message: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid ${role} output: ${message}`, options);
  }
}

export const PlannerOutputSchema = z.strictObject({
  specPath: z.string().min(1),
  riskClass: z.enum(["low", "medium", "high"]),
  impactedFiles: z.array(z.string().min(1)),
  notes: z.string(),
});

export type PlannerOutput = z.output<typeof PlannerOutputSchema>;

const ReviewIssueSchema = z.strictObject({
  file: z.string().min(1),
  line: z.int().positive().nullable(),
  severity: z.enum(["blocker", "major", "minor"]),
  message: z.string().min(1),
});

export const ReviewVerdictSchema = z
  .strictObject({
    verdict: z.enum(["approve", "changes"]),
    issues: z.array(ReviewIssueSchema),
  })
  .refine(
    ({ verdict, issues }) => (verdict === "changes") === issues.some((issue) => issue.severity !== "minor"),
    "verdict must be changes if and only if there is a blocker or major issue",
  );

export type ReviewIssue = z.output<typeof ReviewIssueSchema>;
export type ReviewVerdict = z.output<typeof ReviewVerdictSchema>;

const JSON_FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g;

/** The planner ends its answer with a fenced JSON block; the last one wins. */
export function parsePlannerOutput(text: string): PlannerOutput {
  const blocks = [...text.matchAll(JSON_FENCE)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    throw new AgentOutputError("planner", "no ```json block found");
  }
  return validate("planner", PlannerOutputSchema, parseJson("planner", last));
}

/** The reviewer answers with the JSON verdict only; a single surrounding ```json fence is tolerated. */
export function parseReviewerOutput(text: string): ReviewVerdict {
  const trimmed = text.trim();
  const fenced = /^```json\s*\n([\s\S]*?)\n\s*```$/.exec(trimmed);
  return validate("reviewer", ReviewVerdictSchema, parseJson("reviewer", fenced?.[1] ?? trimmed));
}

function parseJson(role: AgentOutputError["role"], text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AgentOutputError(role, "not valid JSON", { cause });
  }
}

function validate<T>(role: AgentOutputError["role"], schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AgentOutputError(role, z.prettifyError(result.error), { cause: result.error });
  }
  return result.data;
}

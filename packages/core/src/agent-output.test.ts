import { describe, expect, it } from "vitest";
import { AgentOutputError, parsePlannerOutput, parseReviewerOutput } from "./agent-output.js";

const PLAN = {
  specPath: ".loop/specs/task-1.md",
  riskClass: "low",
  impactedFiles: ["src/a.ts"],
  notes: "",
};

const fenced = (value: unknown): string => "```json\n" + JSON.stringify(value, null, 2) + "\n```";

describe("parsePlannerOutput", () => {
  it("parses the final JSON block after prose", () => {
    expect(parsePlannerOutput(`Spec written.\n\n${fenced(PLAN)}\n`)).toEqual(PLAN);
  });

  it("takes the last JSON block when there are several", () => {
    const text = `Example: ${fenced({ ...PLAN, riskClass: "high" })}\nFinal:\n${fenced(PLAN)}`;

    expect(parsePlannerOutput(text)).toEqual(PLAN);
  });

  it.each([
    ["no JSON block", "Spec written."],
    ["invalid JSON", "```json\n{ specPath: nope }\n```"],
    ["an unknown risk class", fenced({ ...PLAN, riskClass: "critical" })],
    ["a missing field", fenced({ specPath: PLAN.specPath, riskClass: "low", impactedFiles: [] })],
    ["an unknown field", fenced({ ...PLAN, extra: true })],
  ])("rejects %s", (_label, text) => {
    expect(() => parsePlannerOutput(text)).toThrow(AgentOutputError);
  });
});

describe("parseReviewerOutput", () => {
  const approve = { verdict: "approve", issues: [] };
  const changes = {
    verdict: "changes",
    issues: [{ file: "src/a.ts", line: 3, severity: "major", message: "Missing test for criterion 2" }],
  };

  it("parses a bare JSON verdict", () => {
    expect(parseReviewerOutput(`  ${JSON.stringify(changes)}\n`)).toEqual(changes);
  });

  it("accepts a verdict wrapped in a single JSON fence", () => {
    expect(parseReviewerOutput(fenced(approve))).toEqual(approve);
  });

  it("accepts a null line and minor issues on approve", () => {
    const verdict = {
      verdict: "approve",
      issues: [{ file: "README.md", line: null, severity: "minor", message: "Typo" }],
    };

    expect(parseReviewerOutput(JSON.stringify(verdict))).toEqual(verdict);
  });

  it.each([
    ["prose around the JSON", `Looks good.\n${JSON.stringify(approve)}`],
    ["invalid JSON", "{ verdict: approve }"],
    ["an empty output", ""],
    ["an unknown verdict", JSON.stringify({ verdict: "reject", issues: [] })],
    ["an unknown severity", JSON.stringify({ verdict: "changes", issues: [{ ...changes.issues[0], severity: "critical" }] })],
    ["a non-positive line", JSON.stringify({ verdict: "changes", issues: [{ ...changes.issues[0], line: 0 }] })],
    ["approve with a major issue", JSON.stringify({ ...changes, verdict: "approve" })],
    ["changes without blocker or major issue", JSON.stringify({ verdict: "changes", issues: [] })],
  ])("rejects %s", (_label, text) => {
    expect(() => parseReviewerOutput(text)).toThrow(AgentOutputError);
  });
});

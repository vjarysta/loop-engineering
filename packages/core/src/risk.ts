import { posix } from "node:path";
import type { RiskRules } from "./project-config.js";
import type { RiskClass } from "./types.js";

const RISK_ORDER: readonly RiskClass[] = ["low", "medium", "high"];

export function maxRiskClass(...classes: readonly RiskClass[]): RiskClass {
  return classes.reduce((max, current) => (RISK_ORDER.indexOf(current) > RISK_ORDER.indexOf(max) ? current : max), "low");
}

/** `file` is a path relative to the project root, with forward slashes. */
export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => posix.matchesGlob(file, pattern));
}

/** Added + removed lines of a unified diff, file headers excluded. */
export function countChangedLines(diff: string): number {
  return diff
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .length;
}

export function computeRiskClass(rules: RiskRules, changedFiles: readonly string[], changedLines: number): RiskClass {
  const fromPaths = rules.paths
    .filter((rule) => changedFiles.some((file) => posix.matchesGlob(file, rule.pattern)))
    .map((rule) => rule.class);
  const { medium, high } = rules.diffLines ?? {};
  const fromSize: RiskClass =
    high !== undefined && changedLines >= high
      ? "high"
      : medium !== undefined && changedLines >= medium
        ? "medium"
        : "low";
  return maxRiskClass(...fromPaths, fromSize);
}

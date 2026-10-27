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

/**
 * Each changed file takes the class of the highest list it matches (high, then medium, then low); a file
 * matching none counts as medium. A low-risk change larger than maxLowRiskDiffLines counts as medium.
 */
export function computeRiskClass(rules: RiskRules, changedFiles: readonly string[], changedLines: number): RiskClass {
  const fromFiles = changedFiles.map((file): RiskClass => {
    if (matchesAny(file, rules.high)) return "high";
    if (matchesAny(file, rules.medium)) return "medium";
    if (matchesAny(file, rules.low)) return "low";
    return "medium";
  });
  const fromSize: RiskClass = changedLines > rules.maxLowRiskDiffLines ? "medium" : "low";
  return maxRiskClass(...fromFiles, fromSize);
}

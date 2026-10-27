import { describe, expect, it } from "vitest";
import type { RiskRules } from "./project-config.js";
import { computeRiskClass, countChangedLines, matchesAny, maxRiskClass } from "./risk.js";

describe("maxRiskClass", () => {
  it.each([
    [["low", "low"], "low"],
    [["low", "medium"], "medium"],
    [["medium", "low"], "medium"],
    [["high", "medium"], "high"],
    [["low", "high", "medium"], "high"],
  ] as const)("max of %j is %s", (classes, expected) => {
    expect(maxRiskClass(...classes)).toBe(expected);
  });
});

describe("matchesAny", () => {
  it.each([
    ["src/auth/login.ts", ["src/auth/**"], true],
    ["src/auth/deep/nested.ts", ["src/auth/**"], true],
    ["src/authz/login.ts", ["src/auth/**"], false],
    ["README.md", ["*.md"], true],
    ["docs/guide.md", ["*.md"], false],
    ["docs/guide.md", ["**/*.md"], true],
    [".github/workflows/ci.yml", ["src/**", ".github/**"], true],
    ["package.json", ["package.json"], true],
    ["package.json", [], false],
  ] as const)("%s against %j is %s", (file, patterns, expected) => {
    expect(matchesAny(file, patterns)).toBe(expected);
  });
});

describe("countChangedLines", () => {
  it("counts added and removed lines, not file headers", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+new",
      "diff --git a/b.txt b/b.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/b.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "",
    ].join("\n");

    expect(countChangedLines(diff)).toBe(4);
  });

  it("returns 0 for an empty diff", () => {
    expect(countChangedLines("")).toBe(0);
  });
});

describe("computeRiskClass", () => {
  it("is low without rules", () => {
    expect(computeRiskClass({ paths: [] }, ["src/a.ts"], 10_000)).toBe("low");
  });

  it("takes the highest class among the matching path rules", () => {
    const rules: RiskRules = {
      paths: [
        { pattern: "src/**", class: "medium" },
        { pattern: "src/auth/**", class: "high" },
        { pattern: "docs/**", class: "low" },
      ],
    };

    expect(computeRiskClass(rules, ["docs/a.md"], 0)).toBe("low");
    expect(computeRiskClass(rules, ["docs/a.md", "src/a.ts"], 0)).toBe("medium");
    expect(computeRiskClass(rules, ["src/a.ts", "src/auth/b.ts"], 0)).toBe("high");
  });

  it.each([
    [4, "low"],
    [5, "medium"],
    [9, "medium"],
    [10, "high"],
  ] as const)("a diff of %i changed lines with thresholds 5/10 is %s", (lines, expected) => {
    expect(computeRiskClass({ paths: [], diffLines: { medium: 5, high: 10 } }, [], lines)).toBe(expected);
  });

  it("applies a lone high threshold", () => {
    expect(computeRiskClass({ paths: [], diffLines: { high: 10 } }, [], 9)).toBe("low");
    expect(computeRiskClass({ paths: [], diffLines: { high: 10 } }, [], 10)).toBe("high");
  });

  it("combines path rules and diff size", () => {
    const rules: RiskRules = { paths: [{ pattern: "src/**", class: "medium" }], diffLines: { high: 10 } };

    expect(computeRiskClass(rules, ["src/a.ts"], 10)).toBe("high");
  });
});

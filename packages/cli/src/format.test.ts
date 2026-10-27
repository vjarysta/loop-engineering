import { describe, expect, it } from "vitest";
import { formatCost, formatDuration, formatTable } from "./format.js";

describe("formatTable", () => {
  it("pads every column to its widest cell and right-aligns the requested ones", () => {
    expect(
      formatTable(
        ["Role", "Tokens"],
        [
          ["planner", "10"],
          ["implementer", "2500"],
        ],
        { rightAlign: [1] },
      ),
    ).toBe(["Role         Tokens", "-----------  ------", "planner          10", "implementer    2500"].join("\n"));
  });

  it("separates a footer row", () => {
    expect(formatTable(["A", "B"], [["x", "1"]], { footer: ["Total", "1"] })).toBe(
      ["A      B", "-----  -", "x      1", "-----  -", "Total  1"].join("\n"),
    );
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [12_345, "12.3s"],
    [60_000, "1m 00s"],
    [185_000, "3m 05s"],
    [3_725_000, "1h 02m"],
  ])("%i ms → %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("formatCost", () => {
  it.each([
    [0, "$0.0000"],
    [0.01, "$0.0100"],
    [1.23456, "$1.2346"],
  ])("%f → %s", (usd, expected) => {
    expect(formatCost(usd)).toBe(expected);
  });
});

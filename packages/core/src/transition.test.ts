import { describe, expect, it } from "vitest";
import { InvalidTransitionError, transition } from "./transition.js";
import type { Task, TaskEvent, TaskState } from "./types.js";

const STATES: readonly TaskState[] = [
  "proposed",
  "approved",
  "rejected",
  "planned",
  "in_progress",
  "checks",
  "in_review",
  "awaiting_merge",
  "merged",
  "escalated",
  "cancelled",
];

const EVENTS: readonly TaskEvent[] = [
  "approve",
  "reject",
  "plan",
  "start",
  "run_checks",
  "checks_passed",
  "checks_failed",
  "request_changes",
  "merge",
  "cancel",
];

function makeTask(overrides: Partial<Task> = {}): Task {
  return Object.freeze({
    id: "task-1",
    projectPath: "/repos/demo",
    title: "Demo task",
    specPath: "specs/demo.md",
    riskClass: "low",
    state: "proposed",
    checkIterations: 0,
    reviewIterations: 0,
    ...overrides,
  });
}

interface ValidCase {
  readonly name: string;
  readonly from: Partial<Task> & { readonly state: TaskState };
  readonly event: TaskEvent;
  readonly to: Partial<Task> & { readonly state: TaskState };
}

const VALID: readonly ValidCase[] = [
  { name: "proposal approved", from: { state: "proposed" }, event: "approve", to: { state: "approved" } },
  { name: "proposal rejected", from: { state: "proposed" }, event: "reject", to: { state: "rejected" } },
  { name: "approved task planned", from: { state: "approved" }, event: "plan", to: { state: "planned" } },
  { name: "planned task started", from: { state: "planned" }, event: "start", to: { state: "in_progress" } },
  { name: "work sent to checks", from: { state: "in_progress" }, event: "run_checks", to: { state: "checks" } },
  { name: "checks pass", from: { state: "checks" }, event: "checks_passed", to: { state: "in_review" } },
  {
    name: "1st checks failure retries",
    from: { state: "checks", checkIterations: 0 },
    event: "checks_failed",
    to: { state: "in_progress", checkIterations: 1 },
  },
  {
    name: "3rd checks failure still retries",
    from: { state: "checks", checkIterations: 2 },
    event: "checks_failed",
    to: { state: "in_progress", checkIterations: 3 },
  },
  {
    name: "4th checks failure escalates",
    from: { state: "checks", checkIterations: 3 },
    event: "checks_failed",
    to: { state: "escalated", checkIterations: 3 },
  },
  {
    name: "1st review changes request retries",
    from: { state: "in_review", reviewIterations: 0 },
    event: "request_changes",
    to: { state: "in_progress", reviewIterations: 1 },
  },
  {
    name: "2nd review changes request still retries",
    from: { state: "in_review", reviewIterations: 1 },
    event: "request_changes",
    to: { state: "in_progress", reviewIterations: 2 },
  },
  {
    name: "3rd review changes request escalates",
    from: { state: "in_review", reviewIterations: 2 },
    event: "request_changes",
    to: { state: "escalated", reviewIterations: 2 },
  },
  {
    name: "low-risk review approval merges directly",
    from: { state: "in_review", riskClass: "low" },
    event: "approve",
    to: { state: "merged", riskClass: "low" },
  },
  {
    name: "medium-risk review approval awaits merge",
    from: { state: "in_review", riskClass: "medium" },
    event: "approve",
    to: { state: "awaiting_merge", riskClass: "medium" },
  },
  {
    name: "high-risk review approval awaits merge",
    from: { state: "in_review", riskClass: "high" },
    event: "approve",
    to: { state: "awaiting_merge", riskClass: "high" },
  },
  { name: "awaiting task merged", from: { state: "awaiting_merge" }, event: "merge", to: { state: "merged" } },
  { name: "cancel proposed", from: { state: "proposed" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel approved", from: { state: "approved" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel planned", from: { state: "planned" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel in_progress", from: { state: "in_progress" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel checks", from: { state: "checks" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel in_review", from: { state: "in_review" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel awaiting_merge", from: { state: "awaiting_merge" }, event: "cancel", to: { state: "cancelled" } },
  { name: "cancel escalated", from: { state: "escalated" }, event: "cancel", to: { state: "cancelled" } },
];

describe("transition — valid transitions", () => {
  it.each(VALID)("$name: $from.state --$event--> $to.state", ({ from, event, to }) => {
    const task = makeTask(from);

    expect(transition(task, event)).toEqual({ ...task, ...to });
  });

  it("keeps the counters untouched outside of retry loops", () => {
    const task = makeTask({ state: "checks", checkIterations: 2, reviewIterations: 1 });

    expect(transition(task, "checks_passed")).toEqual({ ...task, state: "in_review" });
  });

  it("does not mutate the input task", () => {
    const task = makeTask({ state: "checks", checkIterations: 1 });

    const next = transition(task, "checks_failed");

    expect(next).not.toBe(task);
    expect(task).toEqual(makeTask({ state: "checks", checkIterations: 1 }));
  });
});

describe("transition — invalid transitions", () => {
  const validPairs = new Set(VALID.map(({ from, event }) => `${from.state}:${event}`));
  const invalid = STATES.flatMap((state) =>
    EVENTS.filter((event) => !validPairs.has(`${state}:${event}`)).map((event) => ({ state, event })),
  );

  it("covers every state × event pair", () => {
    expect(validPairs.size + invalid.length).toBe(STATES.length * EVENTS.length);
  });

  it.each(invalid)("$state --$event--> throws", ({ state, event }) => {
    expect(() => transition(makeTask({ state }), event)).toThrow(InvalidTransitionError);
  });

  it.each(["merged", "rejected", "cancelled"] as const)("terminal state %s accepts no event", (state) => {
    for (const event of EVENTS) {
      expect(() => transition(makeTask({ state }), event)).toThrow(InvalidTransitionError);
    }
  });

  it("reports the offending state and event on the error", () => {
    let error: unknown;
    try {
      transition(makeTask({ state: "merged" }), "start");
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error).toMatchObject({ state: "merged", event: "start" });
  });
});
